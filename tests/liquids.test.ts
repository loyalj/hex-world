import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { HexMap } from '../src/map/HexMap.js';
import { createLayout } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';
import { resolveLiquidMaterials, DEFAULT_LIQUID_DESCRIPTORS } from '../src/geometry/LiquidTypes.js';
import { buildWaterGeometry, buildRiverGeometry, computeRiverOwnership } from '../src/geometry/WaterChunk.js';

const layout = createLayout(POINTY_TOP, 1);
const EDGE_DIRS = POINTY_TOP.edgeDirections;
const WATER = 5;

describe('descriptor-driven appearance', () => {
  it('resolves appearance fields into shader uniforms on all four materials', () => {
    const mats = resolveLiquidMaterials({
      id: 'test', name: 'Test',
      shallowColor: 0x112233, opacity: 0.95, flowSpeed: 0.3,
      emissiveColor: 0xff0000, emissiveStrength: 0.5, waveScale: 0.7, foamIntensity: 2,
    });
    for (const mat of [mats.surface, mats.shore, mats.estuary, mats.river]) {
      const u = (mat as THREE.ShaderMaterial).uniforms;
      expect(u.uOpacity.value).toBe(0.95);
      expect(u.uFlowSpeed.value).toBe(0.3);
      expect(u.uEmissiveStrength.value).toBe(0.5);
      expect(u.uWaveScale.value).toBe(0.7);
      expect(u.uFoamIntensity.value).toBe(2);
      expect((u.uEmissive.value as THREE.Color).r).toBeCloseTo(1);
    }
  });

  it('keeps water at defaults and gives lava opacity 1 with emissive glow', () => {
    const water = resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0]);
    const lava  = resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[1]);
    expect((water.surface as THREE.ShaderMaterial).uniforms.uOpacity.value).toBe(0.82);
    expect((water.river   as THREE.ShaderMaterial).uniforms.uOpacity.value).toBe(0.78);
    expect((lava.surface  as THREE.ShaderMaterial).uniforms.uOpacity.value).toBe(1.0);
    expect((lava.surface  as THREE.ShaderMaterial).uniforms.uEmissiveStrength.value).toBeGreaterThan(0);
  });
});

describe('depth gradient (shore distance)', () => {
  it('deepens with distance from shore in a wide basin', () => {
    // 24×24 water basin with a land ring border.
    const m = new HexMap({ width: 24, height: 24 });
    m.forEach((c, r) => {
      const border = c === 0 || r === 0 || c === 23 || r === 23;
      if (!border) { m.setTerrain(c, r, WATER); m.setElevation(c, r, -1); }
    });
    m.computeWaterSurfaces();

    expect(m.getShoreDistance(1, 1)).toBe(0);       // touches the land ring
    expect(m.getShoreDistance(12, 12)).toBeGreaterThan(5); // open water

    const geo = buildWaterGeometry(m, layout, { colStart: 0, colEnd: 24, rowStart: 0, rowEnd: 24 })!;
    const depth = geo.getAttribute('depth').array as Float32Array;
    const min = Math.min(...depth), max = Math.max(...depth);
    expect(min).toBeLessThan(0.2);   // shore cells shallow
    expect(max).toBe(1);             // center cells fully deep
  });
});

describe('indexed water surface geometry', () => {
  it('emits 7 vertices and 18 indices per water cell', () => {
    const m = new HexMap({ width: 8, height: 8 });
    m.setTerrain(3, 3, WATER); m.setElevation(3, 3, -1);
    m.setTerrain(4, 3, WATER); m.setElevation(4, 3, -1);
    m.computeWaterSurfaces();
    const geo = buildWaterGeometry(m, layout, { colStart: 0, colEnd: 8, rowStart: 0, rowEnd: 8 })!;
    expect(geo.getAttribute('position').count).toBe(2 * 7);
    expect(geo.getIndex()!.count).toBe(2 * 18);
  });
});

describe('incremental computeWaterSurfaces', () => {
  it('matches a full recompute after localized edits', () => {
    const m = new HexMap({ width: 48, height: 48 });
    // Two separate lakes + an ocean strip.
    for (let r = 0; r < 48; r++) for (let c = 0; c < 4; c++) { m.setTerrain(c, r, WATER); m.setElevation(c, r, -1); }
    for (let r = 10; r < 14; r++) for (let c = 20; c < 24; c++) { m.setTerrain(c, r, WATER); m.setElevation(c, r, 3); }
    for (let r = 30; r < 34; r++) for (let c = 30; c < 34; c++) { m.setTerrain(c, r, WATER); m.setElevation(c, r, 1); }
    m.computeWaterSurfaces();

    // Edit: raise part of the first lake's floor and extend the second lake.
    m.setElevation(21, 11, 5);
    m.setTerrain(34, 31, WATER); m.setElevation(34, 31, 1);

    // Incremental with a region covering the edits (+1 cell)
    m.computeWaterSurfaces(undefined, [
      { colStart: 19, colEnd: 26, rowStart: 9, rowEnd: 16 },
      { colStart: 29, colEnd: 36, rowStart: 29, rowEnd: 36 },
    ]);
    const incrementalSurfaces = m.waterSurfaces.slice();
    const incrementalShore    = m.shoreDistances.slice();

    // Full recompute must agree everywhere.
    m.computeWaterSurfaces();
    expect(incrementalSurfaces).toEqual(m.waterSurfaces);
    expect(incrementalShore).toEqual(m.shoreDistances);
    expect(m.getWaterSurface(21, 11)).toBe(6); // raised floor lifted the lake surface
  });
});

describe('river ownership cache', () => {
  function riverMap(): HexMap {
    const m = new HexMap({ width: 32, height: 32 });
    // Lake at east, lava pond (index 6) at west.
    m.setTerrain(20, 10, WATER); m.setElevation(20, 10, -1);
    m.setTerrain(4, 10, 6);      m.setElevation(4, 10, -1);
    // River A: (17,10) → east into water. Same-row east = edge with axial (1,0).
    const eastEdge = EDGE_DIRS.findIndex(d => d === 0); // HEX_DIRECTIONS[0] = {q:1,r:0}
    for (let c = 17; c < 20; c++) {
      m.setElevation(c, 10, 19 - c);
      m.setRiverOutgoing(c, 10, eastEdge);
      m.setRiverIncoming(c + 1, 10, (eastEdge + 3) % 6);
    }
    // River B: (7,10) → west into lava.
    const westEdge = EDGE_DIRS.findIndex(d => d === 3); // HEX_DIRECTIONS[3] = {q:-1,r:0}
    for (let c = 7; c > 4; c--) {
      m.setElevation(c, 10, c);
      m.setRiverOutgoing(c, 10, westEdge);
      m.setRiverIncoming(c - 1, 10, (westEdge + 3) % 6);
    }
    // River C: dead end on land.
    m.setRiverOutgoing(12, 20, eastEdge);
    m.setRiverIncoming(13, 20, (eastEdge + 3) % 6);
    m.computeWaterSurfaces(t => t === WATER || t === 6);
    return m;
  }

  it('classifies chains by their terminal liquid, null for dead ends', () => {
    const m = riverMap();
    const liquidIdByTerrain = new Map([[WATER, 'water'], [6, 'lava']]);
    const own = computeRiverOwnership(m, EDGE_DIRS, liquidIdByTerrain);
    expect(own.get(10 * 32 + 17)).toBe('water');
    expect(own.get(10 * 32 + 19)).toBe('water');
    expect(own.get(10 * 32 + 7)).toBe('lava');
    expect(own.get(20 * 32 + 12)).toBe(null);
  });

  it('riverCells fast path produces the same geometry as fallback tracing', () => {
    const m = riverMap();
    const bounds = { colStart: 0, colEnd: 32, rowStart: 0, rowEnd: 32 };
    const waterSet = new Set([WATER]);
    const allSet   = new Set([WATER, 6]);
    const own = computeRiverOwnership(m, EDGE_DIRS, new Map([[WATER, 'water'], [6, 'lava']]));
    const waterCells = new Set<number>();
    for (const [cell, o] of own) if (o === 'water' || o === null) waterCells.add(cell); // water is default liquid

    const viaTrace = buildRiverGeometry(m, layout, bounds, {
      waterTerrains: waterSet, allLiquidTerrains: allSet, ownsUnclassifiedRivers: true,
    })!;
    const viaCache = buildRiverGeometry(m, layout, bounds, {
      waterTerrains: waterSet, allLiquidTerrains: allSet, riverCells: waterCells,
    })!;
    expect(viaCache.getAttribute('position').count).toBe(viaTrace.getAttribute('position').count);
  });
});

describe('waterfall geometry', () => {
  it('emits extra triangles when a river crosses a cliff', () => {
    const build = (dropTo: number) => {
      const m = new HexMap({ width: 16, height: 16 });
      m.setTerrain(10, 8, WATER); m.setElevation(10, 8, -1);
      const eastEdge = EDGE_DIRS.findIndex(d => d === 0);
      m.setElevation(7, 8, 6);
      m.setElevation(8, 8, 6);
      m.setElevation(9, 8, dropTo);
      m.setRiverOutgoing(7, 8, eastEdge); m.setRiverIncoming(8, 8, (eastEdge + 3) % 6);
      m.setRiverOutgoing(8, 8, eastEdge); m.setRiverIncoming(9, 8, (eastEdge + 3) % 6);
      m.setRiverOutgoing(9, 8, eastEdge); m.setRiverIncoming(10, 8, (eastEdge + 3) % 6);
      m.computeWaterSurfaces();
      return buildRiverGeometry(m, layout, { colStart: 0, colEnd: 16, rowStart: 0, rowEnd: 16 }, {})!;
    };
    const flat  = build(6); // no cliff between (8,8)→(9,8)
    const cliff = build(1); // 5-step drop → waterfall lip+fall quads
    expect(cliff.getAttribute('position').count).toBeGreaterThan(flat.getAttribute('position').count);
  });
});
