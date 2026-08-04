import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { HexMap } from '../src/map/HexMap.js';
import { createLayout, hexToWorld } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';
import { ELEVATION_SCALE, RIVER_SURFACE_ELEVATION_OFFSET } from '../src/map/HexCell.js';
import {
  ChunkManager,
  RENDER_ORDER_WATERFALL_FOAM, RENDER_ORDER_WATERFALL_SPRAY,
} from '../src/geometry/ChunkManager.js';
import { resolveLiquidMaterials, DEFAULT_LIQUID_DESCRIPTORS } from '../src/geometry/LiquidTypes.js';
import { createWaterfallSprayMaterial } from '../src/geometry/WaterfallMaterial.js';
import { computeRiverElevations, computeRiverFlow } from '../src/geometry/WaterChunk.js';
import {
  findWaterfalls, buildWaterfallFoamGeometry, buildWaterfallSprayGeometry,
  type WaterfallSite,
} from '../src/geometry/Waterfalls.js';

const layout    = createLayout(POINTY_TOP, 1);
const EDGE_DIRS = POINTY_TOP.edgeDirections;
const eastEdge  = EDGE_DIRS.findIndex(d => d === 0); // HEX_DIRECTIONS[0] = {q:1, r:0}
const WATER     = 5;
const bounds    = { colStart: 0, colEnd: 16, rowStart: 0, rowEnd: 16 };

/** West→east river through `row`, cols [c0, c1]. */
function paintEastRiver(m: HexMap, row: number, c0: number, c1: number): void {
  for (let c = c0; c < c1; c++) {
    m.setRiverOutgoing(c, row, eastEdge);
    m.setRiverIncoming(c + 1, row, (eastEdge + 3) % 6);
  }
}

/** A river along row 8 whose cols 4..8 sit at the given elevations. */
function riverAtElevations(elevs: number[], row = 8): HexMap {
  const m = new HexMap({ width: 16, height: 16 });
  elevs.forEach((e, i) => m.setElevation(4 + i, row, e));
  paintEastRiver(m, row, 4, 4 + elevs.length - 1);
  m.computeWaterSurfaces();
  return m;
}

describe('findWaterfalls', () => {
  it('finds nothing on a river that steps down gently', () => {
    const m = riverAtElevations([6, 5, 4, 3, 2]);
    expect(findWaterfalls(m, layout, bounds)).toEqual([]);
  });

  it('finds one fall where the river drops a full cliff', () => {
    const m = riverAtElevations([6, 6, 2, 2, 2]); // 4-level drop between cols 5 and 6
    const falls = findWaterfalls(m, layout, bounds);
    expect(falls).toHaveLength(1);
    expect(falls[0].col).toBe(5);
    expect(falls[0].row).toBe(8);
    expect(falls[0].edge).toBe(eastEdge);
    expect(falls[0].cellIndex).toBe(8 * 16 + 5);
    expect(falls[0].baseCellIndex).toBe(8 * 16 + 6);
  });

  it('honours a raised cliffThreshold', () => {
    const m = riverAtElevations([6, 6, 4, 4, 4]); // exactly a 2-level drop
    expect(findWaterfalls(m, layout, bounds)).toHaveLength(1);
    expect(findWaterfalls(m, layout, bounds, { cliffThreshold: 3 })).toEqual([]);
  });

  it('reports the drop and lands the sheet between the two cells', () => {
    const m = riverAtElevations([6, 6, 2, 2, 2]);
    const [f] = findWaterfalls(m, layout, bounds);

    expect(f.drop).toBeCloseTo(4 * ELEVATION_SCALE);
    expect(f.topY).toBeCloseTo((6 + RIVER_SURFACE_ELEVATION_OFFSET) * ELEVATION_SCALE);
    expect(f.baseY).toBeCloseTo((2 + RIVER_SURFACE_ELEVATION_OFFSET) * ELEVATION_SCALE);
    expect(f.width).toBeGreaterThan(0);
    expect(Math.hypot(f.dirX, f.dirZ)).toBeCloseTo(1);

    // The river runs west→east, so the sheet falls eastward and lands past the
    // lip cell's center but short of the receiving cell's. (Not exactly +X:
    // both ends carry the terrain's vertex perturbation.)
    expect(f.dirX).toBeGreaterThan(0.7);
    const lip  = hexToWorld(layout, { q: 5 - (8 - (8 & 1)) / 2, r: 8 });
    const land = hexToWorld(layout, { q: 6 - (8 - (8 & 1)) / 2, r: 8 });
    expect(f.baseX).toBeGreaterThan(lip.x);
    expect(f.baseX).toBeLessThan(land.x);
  });

  it('skips a drop into standing water — that is an estuary, not a fall', () => {
    const m = riverAtElevations([6, 6, 2, 2, 2]);
    m.setTerrain(6, 8, WATER);
    m.setElevation(6, 8, 1);
    m.computeWaterSurfaces();
    expect(findWaterfalls(m, layout, bounds)).toEqual([]);
  });

  it('skips a cell whose channel this liquid does not own', () => {
    const m = riverAtElevations([6, 6, 2, 2, 2]);
    const opts = {
      waterTerrains: new Set([WATER]),
      allLiquidTerrains: new Set([WATER]),
      riverCells: new Set<number>(), // owns nothing
    };
    expect(findWaterfalls(m, layout, bounds, opts)).toEqual([]);
    expect(findWaterfalls(m, layout, bounds, {
      ...opts, riverCells: new Set([8 * 16 + 5]),
    })).toHaveLength(1);
  });

  it('measures the fall from the carved river level, not raw terrain', () => {
    // Cols 4..8 = 6, 6, 8, 8, 2: the river is routed UPHILL through cols 6–7,
    // where computeRiverElevations holds it at 6 and the terrain carves a
    // gorge. The fall therefore belongs at the exit of col 7, not col 5.
    const m = riverAtElevations([6, 6, 8, 8, 2]);
    const riverElevations = computeRiverElevations(m, EDGE_DIRS);

    const raw = findWaterfalls(m, layout, bounds);
    expect(raw.map(f => f.col)).toEqual([7]); // raw terrain: 8 → 2

    const carved = findWaterfalls(m, layout, bounds, { riverElevations });
    expect(carved).toHaveLength(1);
    expect(carved[0].col).toBe(7);
    expect(carved[0].drop).toBeCloseTo(4 * ELEVATION_SCALE); // carried 6 → 2, not 8 → 2
  });

  it('widens the sheet with accumulated flow', () => {
    const slim = riverAtElevations([6, 6, 2, 2, 2]);
    const [narrow] = findWaterfalls(slim, layout, bounds, {
      riverFlow: computeRiverFlow(slim, EDGE_DIRS),
    });

    // Same map plus a tributary joining just above the lip.
    const fat = riverAtElevations([6, 6, 2, 2, 2]);
    for (let e = 0; e < 6; e++) {
      const n = fat.roadEdgeNeighbor(5, 7, e, POINTY_TOP);
      if (n && n.col === 5 && n.row === 8) {
        fat.setElevation(5, 7, 6);
        fat.setRiverOutgoing(5, 7, e);
        fat.setRiverIncoming(5, 8, n.edge);
        break;
      }
    }
    const [wide] = findWaterfalls(fat, layout, bounds, {
      riverFlow: computeRiverFlow(fat, EDGE_DIRS),
    });
    expect(wide.width).toBeGreaterThan(narrow.width);
  });
});

describe('waterfall foam geometry', () => {
  const sites = (): WaterfallSite[] => findWaterfalls(riverAtElevations([6, 6, 2, 2, 2]), layout, bounds);

  it('returns null when there is nothing to pool', () => {
    expect(buildWaterfallFoamGeometry([])).toBeNull();
  });

  it('lays a flat disc just above the receiving water surface', () => {
    const [f]  = sites();
    const geo  = buildWaterfallFoamGeometry(sites(), { lift: 0.04, segments: 12 })!;
    const pos  = geo.getAttribute('position').array as Float32Array;
    const uv   = geo.getAttribute('uv').array as Float32Array;
    const cell = geo.getAttribute('cellIndex').array as Float32Array;

    expect(geo.getAttribute('position').count).toBe(1 + 12 * 2);
    for (let i = 1; i < pos.length; i += 3) expect(pos[i]).toBeCloseTo(f.baseY + 0.04);
    // Fog samples the cell the pool is actually drawn in.
    for (const c of cell) expect(c).toBe(f.baseCellIndex);
    // v is the normalised radius: center, then the mid and rim rings.
    expect(uv[1]).toBe(0);
    expect(Math.max(...Array.from(uv).filter((_, i) => i % 2 === 1))).toBe(1);
  });

  it('stays inside a disc scaled by the sheet width', () => {
    const [f] = sites();
    const geo = buildWaterfallFoamGeometry([f], { widthScale: 0.8, lengthScale: 1.2, offset: 0.45 })!;
    const pos = geo.getAttribute('position').array as Float32Array;
    const reach = 1.2 * f.width + 0.45 * f.width;
    for (let i = 0; i < pos.length; i += 3) {
      expect(Math.hypot(pos[i] - f.baseX, pos[i + 2] - f.baseZ)).toBeLessThanOrEqual(reach + 1e-4);
    }
  });
});

describe('waterfall spray geometry', () => {
  const sites = (): WaterfallSite[] => findWaterfalls(riverAtElevations([6, 6, 2, 2, 2]), layout, bounds);

  it('emits nothing for an empty site list or zero intensity', () => {
    expect(buildWaterfallSprayGeometry([])).toBeNull();
    expect(buildWaterfallSprayGeometry(sites(), { intensity: 0 })).toBeNull();
  });

  it('emits particles carrying their fall parameters', () => {
    const [f] = sites();
    const geo = buildWaterfallSprayGeometry([f])!;
    const n   = geo.getAttribute('position').count;
    expect(n).toBeGreaterThan(0);

    const pos    = geo.getAttribute('position').array as Float32Array;
    const params = geo.getAttribute('aSite').array as Float32Array;
    const seeds  = geo.getAttribute('aSeed').array as Float32Array;
    for (let i = 0; i < n; i++) {
      expect(pos[i * 3]).toBeCloseTo(f.baseX);
      expect(pos[i * 3 + 1]).toBeCloseTo(f.baseY);
      expect(Math.hypot(params[i * 4], params[i * 4 + 1])).toBeCloseTo(1);
      expect(params[i * 4 + 2]).toBeCloseTo(f.width * 0.5);
      expect(params[i * 4 + 3]).toBeCloseTo(f.drop);
      expect(seeds[i]).toBeGreaterThanOrEqual(0);
      expect(seeds[i]).toBeLessThan(1);
    }
  });

  it('scales the particle budget with intensity and caps it', () => {
    const s = sites();
    const count = (o?: { intensity?: number; maxPerSite?: number }) =>
      buildWaterfallSprayGeometry(s, o)!.getAttribute('position').count;
    expect(count({ intensity: 2 })).toBeGreaterThan(count({ intensity: 0.5 }));
    expect(count({ intensity: 10, maxPerSite: 12 })).toBe(12);
  });

  it('re-emits an identical cloud when a chunk is rebuilt', () => {
    const a = buildWaterfallSprayGeometry(sites())!.getAttribute('aSeed').array as Float32Array;
    const b = buildWaterfallSprayGeometry(sites())!.getAttribute('aSeed').array as Float32Array;
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(new Set(a).size).toBeGreaterThan(1); // seeds vary within the fall
  });

  it('inflates the bounding sphere to cover the shader-driven mist', () => {
    const [f]  = sites();
    const geo  = buildWaterfallSprayGeometry([f])!;
    // Every position is the same point, so an un-inflated sphere would be a dot.
    expect(geo.boundingSphere!.radius).toBeGreaterThan(f.drop);
  });
});

describe('waterfall materials', () => {
  it('are part of every resolved liquid material set', () => {
    const mats = resolveLiquidMaterials({
      id: 'test', name: 'Test', foamColor: 0xff0000, flowSpeed: 0.4, foamIntensity: 2,
    });
    for (const mat of [mats.waterfallFoam, mats.waterfallSpray]) {
      const u = (mat as THREE.ShaderMaterial).uniforms;
      expect(u.uTime.value).toBe(0);
      expect(u.uFlowSpeed.value).toBe(0.4);
      expect((u.uFoamColor.value as THREE.Color).r).toBeCloseTo(1);
    }
    expect((mats.waterfallFoam as THREE.ShaderMaterial).uniforms.uFoamIntensity.value).toBe(2);
  });

  it('keeps per-particle alpha well under the liquid’s own opacity', () => {
    // Particles overlap heavily near the fall; anything near the liquid's own
    // opacity composites into a solid ball.
    const lava = resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[1]); // opacity 1.0
    expect((lava.surface as THREE.ShaderMaterial).uniforms.uOpacity.value).toBe(1);
    expect((lava.waterfallSpray as THREE.ShaderMaterial).uniforms.uOpacity.value).toBeLessThan(0.75);

    const water = resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0]);
    expect((water.waterfallSpray as THREE.ShaderMaterial).uniforms.uOpacity.value).toBeLessThan(0.4);
  });
});

describe('per-liquid waterfall tuning', () => {
  const sprayUniforms = (d: Parameters<typeof resolveLiquidMaterials>[0]) =>
    (resolveLiquidMaterials(d).waterfallSpray as THREE.ShaderMaterial).uniforms;

  it('inherits the foam look when a liquid tunes nothing', () => {
    const u = sprayUniforms({ id: 'plain', name: 'Plain', foamColor: 0x00ff00 });
    expect((u.uFoamColor.value as THREE.Color).g).toBeCloseTo(1);
    expect((u.uFoamColor.value as THREE.Color).r).toBeCloseTo(0);
    expect(u.uRise.value).toBe(0.75);
    expect(u.uDrift.value).toBe(0.55);
    expect(u.uSize.value).toBe(4.5);
  });

  it('takes descriptor overrides for mist color, energy, drift, and size', () => {
    const u = sprayUniforms({
      id: 'custom', name: 'Custom', foamColor: 0x00ff00,
      sprayColor: 0xff0000, sprayRise: 0.3, sprayDrift: 0.9, spraySize: 12,
    });
    expect((u.uFoamColor.value as THREE.Color).r).toBeCloseTo(1); // spray, not foam
    expect((u.uFoamColor.value as THREE.Color).g).toBeCloseTo(0);
    expect(u.uRise.value).toBe(0.3);
    expect(u.uDrift.value).toBe(0.9);
    expect(u.uSize.value).toBe(12);
  });

  it('defaults to rising mist, with no gravity uniform to tune', () => {
    const mat = createWaterfallSprayMaterial();
    expect(mat.uniforms.uArc.value).toBe(0);
    // Gravity is implicit in the arc term (k·life·(1−life)), so it scales with
    // rise instead of needing — and drifting out of sync with — its own knob.
    expect(mat.uniforms.uGravity).toBeUndefined();
    expect(mat.vertexShader).not.toContain('uGravity');
  });

  it('exposes turbulent wander for the material factory', () => {
    expect(createWaterfallSprayMaterial().uniforms.uSway.value).toBe(0.13);
    expect(createWaterfallSprayMaterial({ sway: 0.4 }).uniforms.uSway.value).toBe(0.4);
  });

  it('switches to thrown spatter via sprayArc, and clamps it to 0–1', () => {
    expect(sprayUniforms({ id: 'l', name: 'L', sprayArc: 1 }).uArc.value).toBe(1);
    expect(sprayUniforms({ id: 'm', name: 'M', sprayArc: 0.4 }).uArc.value).toBe(0.4);
    expect(sprayUniforms({ id: 'n', name: 'N', sprayArc: 5 }).uArc.value).toBe(1);
    expect(sprayUniforms({ id: 'o', name: 'O', sprayArc: -2 }).uArc.value).toBe(0);
  });

  it('lets thrown droplets carry more alpha than stacking mist', () => {
    // Mist piles up at one point and saturates; spatter separates as it flies.
    const mist   = sprayUniforms({ id: 'p', name: 'P' }).uOpacity.value as number;
    const thrown = sprayUniforms({ id: 'q', name: 'Q', sprayArc: 1 }).uOpacity.value as number;
    expect(thrown).toBeGreaterThan(mist);
    expect(thrown).toBeLessThan(1);
  });

  it('scales the plunge-pool footprint with poolScale', () => {
    const [f]    = findWaterfalls(riverAtElevations([6, 6, 2, 2, 2]), layout, bounds);
    const reach  = (scale?: number) => {
      const pos = buildWaterfallFoamGeometry([f], { scale })!.getAttribute('position').array as Float32Array;
      let max = 0;
      for (let i = 0; i < pos.length; i += 3) {
        max = Math.max(max, Math.hypot(pos[i] - f.baseX, pos[i + 2] - f.baseZ));
      }
      return max;
    };
    expect(reach(0.5)).toBeLessThan(reach());
    expect(reach(2)).toBeGreaterThan(reach());
    expect(reach(2)).toBeCloseTo(reach(1) * 2, 5); // uniform, including the downstream offset
  });

  it('ships tuned falls for the built-in lava and acid', () => {
    const [, lava, acid] = DEFAULT_LIQUID_DESCRIPTORS;
    // Thick and heavy vs. thin and volatile — the knobs move in opposite
    // directions, so the built-ins actually exercise the tuning surface.
    expect(lava.sprayRise!).toBeLessThan(acid.sprayRise!);
    expect(lava.sprayDrift!).toBeLessThan(acid.sprayDrift!);
    expect(lava.spraySize!).toBeGreaterThan(acid.spraySize!);
    expect(lava.poolScale!).toBeLessThan(acid.poolScale!);
    expect(lava.sprayIntensity!).toBeLessThan(acid.sprayIntensity!);
    // Molten rock is thrown; acid vapor rises.
    expect(lava.sprayArc).toBe(1);
    expect(acid.sprayArc ?? 0).toBe(0);

    // Lava's ash is not its foam color, and its emissive still lights it.
    const u = (resolveLiquidMaterials(lava).waterfallSpray as THREE.ShaderMaterial).uniforms;
    expect((u.uFoamColor.value as THREE.Color).getHex()).toBe(lava.sprayColor);
    expect(u.uEmissiveStrength.value).toBe(lava.emissiveStrength);
  });

  it('tightens the rendered pool for a liquid with a small poolScale', () => {
    const map = riverAtElevations([6, 6, 2, 2, 2]);
    const spanFor = (poolScale?: number) => {
      const scene = new THREE.Scene();
      const d = { ...DEFAULT_LIQUID_DESCRIPTORS[0], poolScale };
      const cm = new ChunkManager({
        map, layout, scene,
        material: new THREE.MeshBasicMaterial(),
        liquidDescriptors: [d],
        liquidMaterials: new Map([[d.id, resolveLiquidMaterials(d)]]),
        chunkSize: 16,
      });
      cm.loadAll();
      const pool = scene.children.find(o => o.renderOrder === RENDER_ORDER_WATERFALL_FOAM) as THREE.Mesh;
      pool.geometry.computeBoundingSphere();
      return pool.geometry.boundingSphere!.radius;
    };
    expect(spanFor(0.4)).toBeLessThan(spanFor(1));
  });
});

describe('ChunkManager waterfall layers', () => {
  const makeManager = (map: HexMap, descriptor = DEFAULT_LIQUID_DESCRIPTORS[0]) => {
    const scene = new THREE.Scene();
    const cm = new ChunkManager({
      map, layout, scene,
      material: new THREE.MeshBasicMaterial(),
      liquidDescriptors: [descriptor],
      liquidMaterials: new Map([[descriptor.id, resolveLiquidMaterials(descriptor)]]),
      chunkSize: 16,
    });
    return { scene, cm };
  };

  const countAt = (scene: THREE.Scene, order: number) =>
    scene.children.filter(o => o.renderOrder === order).length;

  it('adds a plunge pool and a spray system for a cliff-edge river', () => {
    const { scene, cm } = makeManager(riverAtElevations([6, 6, 2, 2, 2]));
    cm.loadAll();
    expect(cm.loadedWaterfallFoamChunkCount).toBe(1);
    expect(cm.loadedWaterfallSprayChunkCount).toBe(1);
    expect(countAt(scene, RENDER_ORDER_WATERFALL_FOAM)).toBe(1);
    expect(countAt(scene, RENDER_ORDER_WATERFALL_SPRAY)).toBe(1);
    expect(scene.children.some(o => o instanceof THREE.Points)).toBe(true);
  });

  it('adds nothing for a river without a cliff', () => {
    const { cm } = makeManager(riverAtElevations([6, 5, 4, 3, 2]));
    cm.loadAll();
    expect(cm.loadedWaterfallFoamChunkCount).toBe(0);
    expect(cm.loadedWaterfallSprayChunkCount).toBe(0);
  });

  it('appears and disappears as the terrain is edited', () => {
    const map = riverAtElevations([6, 5, 4, 3, 2]);
    const { scene, cm } = makeManager(map);
    cm.loadAll();
    expect(cm.loadedWaterfallFoamChunkCount).toBe(0);

    // Drop the whole downstream reach — a cliff below col 5, gentle after it.
    map.setElevation(6, 8, 0);
    map.setElevation(7, 8, 0);
    map.setElevation(8, 8, 0);
    cm.markDirtyCells([{ col: 6, row: 8 }, { col: 7, row: 8 }, { col: 8, row: 8 }]);
    cm.update(new THREE.PerspectiveCamera());
    expect(cm.loadedWaterfallFoamChunkCount).toBe(1);
    expect(cm.loadedWaterfallSprayChunkCount).toBe(1);

    // Fill it back to the original staircase — no cliff anywhere.
    map.setElevation(6, 8, 4);
    map.setElevation(7, 8, 3);
    map.setElevation(8, 8, 2);
    cm.markDirtyCells([{ col: 6, row: 8 }, { col: 7, row: 8 }, { col: 8, row: 8 }]);
    cm.update(new THREE.PerspectiveCamera());
    expect(cm.loadedWaterfallFoamChunkCount).toBe(0);
    expect(countAt(scene, RENDER_ORDER_WATERFALL_SPRAY)).toBe(0);
  });

  it('leaves the pool but drops the mist at sprayIntensity 0', () => {
    const { cm } = makeManager(riverAtElevations([6, 6, 2, 2, 2]), {
      ...DEFAULT_LIQUID_DESCRIPTORS[0], sprayIntensity: 0,
    });
    cm.loadAll();
    expect(cm.loadedWaterfallFoamChunkCount).toBe(1);
    expect(cm.loadedWaterfallSprayChunkCount).toBe(0);
  });

  it('removes both layers when the chunk unloads', () => {
    const { scene, cm } = makeManager(riverAtElevations([6, 6, 2, 2, 2]));
    cm.loadAll();
    cm.dispose();
    expect(cm.loadedWaterfallFoamChunkCount).toBe(0);
    expect(cm.loadedWaterfallSprayChunkCount).toBe(0);
    expect(countAt(scene, RENDER_ORDER_WATERFALL_FOAM)).toBe(0);
    expect(countAt(scene, RENDER_ORDER_WATERFALL_SPRAY)).toBe(0);
  });
});
