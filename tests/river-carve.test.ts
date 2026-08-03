import { describe, it, expect } from 'vitest';
import { HexMap } from '../src/map/HexMap.js';
import { createLayout, hexToWorld } from '../src/math/HexLayout.js';
import { offsetToHex } from '../src/math/HexCoord.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';
import { STREAM_BED_ELEVATION_OFFSET, RIVER_SURFACE_ELEVATION_OFFSET } from '../src/map/HexCell.js';
import { buildRiverGeometry, computeRiverElevations } from '../src/geometry/WaterChunk.js';
import { buildChunkGeometry } from '../src/geometry/HexChunk.js';
import { DEFAULT_RIVERBED_TERRAIN_INDEX } from '../src/geometry/TerrainTypes.js';

const layout = createLayout(POINTY_TOP, 1);
const EDGE_DIRS = POINTY_TOP.edgeDirections;
const eastEdge = EDGE_DIRS.findIndex(d => d === 0);
const bounds = { colStart: 0, colEnd: 16, rowStart: 0, rowEnd: 16 };

/** West→east river through row `row`, cols [c0, c1]. */
function paintEastRiver(m: HexMap, row: number, c0: number, c1: number): void {
  for (let c = c0; c < c1; c++) {
    m.setRiverOutgoing(c, row, eastEdge);
    m.setRiverIncoming(c + 1, row, (eastEdge + 3) % 6);
  }
}

describe('computeRiverElevations (uphill carve)', () => {
  it('is the identity on a descending river', () => {
    const m = new HexMap({ width: 16, height: 16 });
    for (let c = 4; c <= 8; c++) m.setElevation(c, 8, 8 - c);
    paintEastRiver(m, 8, 4, 8);
    const eff = computeRiverElevations(m, EDGE_DIRS);
    for (let c = 4; c <= 8; c++) {
      expect(eff.get(8 * 16 + c)).toBe(m.getElevation(c, 8));
    }
  });

  it('carries the running minimum through an uphill stretch', () => {
    const m = new HexMap({ width: 16, height: 16 });
    const elevs = [3, 1, 4, 5, 2]; // cols 4..8: down, then uphill, then below
    elevs.forEach((e, i) => m.setElevation(4 + i, 8, e));
    paintEastRiver(m, 8, 4, 8);
    const eff = computeRiverElevations(m, EDGE_DIRS);
    expect(eff.get(8 * 16 + 4)).toBe(3);
    expect(eff.get(8 * 16 + 5)).toBe(1);
    expect(eff.get(8 * 16 + 6)).toBe(1); // carved through the rise
    expect(eff.get(8 * 16 + 7)).toBe(1);
    expect(eff.get(8 * 16 + 8)).toBe(1); // terrain (2) still above carried min
  });

  it('takes the minimum across confluence inflows', () => {
    const m = new HexMap({ width: 16, height: 16 });
    m.setElevation(6, 8, 5);
    m.setElevation(7, 8, 6); // junction, higher than both inflows
    m.setElevation(8, 8, 6);
    paintEastRiver(m, 8, 6, 8);
    // Tributary from (7,7) into (7,8).
    for (let e = 0; e < 6; e++) {
      const n = m.roadEdgeNeighbor(7, 7, e, POINTY_TOP);
      if (n && n.col === 7 && n.row === 8) {
        m.setElevation(7, 7, 2);
        m.setRiverOutgoing(7, 7, e);
        m.setRiverIncoming(7, 8, n.edge);
        break;
      }
    }
    const eff = computeRiverElevations(m, EDGE_DIRS);
    expect(eff.get(8 * 16 + 7)).toBe(2); // min(6, 5, 2)
  });

  it('renders a level water surface and a deepened bed through the rise', () => {
    const m = new HexMap({ width: 16, height: 16 });
    m.setElevation(6, 8, 2);
    m.setElevation(7, 8, 5); // uphill cell
    m.setElevation(8, 8, 2);
    paintEastRiver(m, 8, 6, 8);
    const eff  = computeRiverElevations(m, EDGE_DIRS);
    const opts = { terrainPerturbStrength: 0, terrainElevPerturbStrength: 0 };

    const withCarve = buildRiverGeometry(m, layout, bounds, { ...opts, riverElevations: eff })!;
    const surfaceY  = (2 + RIVER_SURFACE_ELEVATION_OFFSET) * 0.5;
    const pos = withCarve.getAttribute('position');
    let maxY = -Infinity;
    for (let v = 0; v < pos.count; v++) maxY = Math.max(maxY, pos.getY(v));
    expect(maxY).toBeCloseTo(surfaceY, 5); // never climbs the hill

    // Without the carve the old floating slide reached the high cell's level.
    const without = buildRiverGeometry(m, layout, bounds, opts)!;
    const posW = without.getAttribute('position');
    let maxYW = -Infinity;
    for (let v = 0; v < posW.count; v++) maxYW = Math.max(maxYW, posW.getY(v));
    expect(maxYW).toBeCloseTo((5 + RIVER_SURFACE_ELEVATION_OFFSET) * 0.5, 5);

    // Terrain: the uphill cell's bed is carved to the carried level — a
    // bed-depth vertex exists near ITS center, far below its own surface.
    const terrain = buildChunkGeometry(m, layout, bounds, {
      perturbStrength: 0, elevPerturbStrength: 0, riverElevations: eff,
    }).terrain;
    const bedY   = (2 + STREAM_BED_ELEVATION_OFFSET) * 0.5;
    const center = hexToWorld(layout, offsetToHex(7, 8));
    const tPos   = terrain.getAttribute('position');
    let carved = false;
    for (let v = 0; v < tPos.count && !carved; v++) {
      if (Math.abs(tPos.getY(v) - bedY) > 1e-5) continue;
      if (Math.hypot(tPos.getX(v) - center.x, tPos.getZ(v) - center.z) < 0.9) carved = true;
    }
    expect(carved).toBe(true);
  });
});

describe('riverbed terrain blending', () => {
  it('routes bed vertices to the riverbed type slot in splat mode', () => {
    const m = new HexMap({ width: 16, height: 16 });
    paintEastRiver(m, 8, 4, 10);
    const geo = buildChunkGeometry(m, layout, bounds, {
      colorMode: 'splat', riverbedTerrain: DEFAULT_RIVERBED_TERRAIN_INDEX,
    }).terrain;
    const types = geo.getAttribute('terrainType');
    const cols  = geo.getAttribute('color');
    // Some vertex must put full (boosted — see riverbedBlend) splat weight on
    // a slot holding the bed type; the shader normalizes by the weight sum.
    let found = false;
    for (let v = 0; v < types.count && !found; v++) {
      const slots = [types.getX(v), types.getY(v), types.getZ(v)];
      const wts   = [cols.getX(v), cols.getY(v), cols.getZ(v)];
      for (let s = 0; s < 3; s++) {
        if (slots[s] === DEFAULT_RIVERBED_TERRAIN_INDEX && wts[s] >= 1) { found = true; break; }
      }
    }
    expect(found).toBe(true);
  });

  it('emits no riverbed slot when the option is unset', () => {
    const m = new HexMap({ width: 16, height: 16 });
    paintEastRiver(m, 8, 4, 10);
    const geo = buildChunkGeometry(m, layout, bounds, { colorMode: 'splat' }).terrain;
    const types = geo.getAttribute('terrainType');
    for (let v = 0; v < types.count; v++) {
      expect(types.getX(v)).not.toBe(DEFAULT_RIVERBED_TERRAIN_INDEX);
      expect(types.getY(v)).not.toBe(DEFAULT_RIVERBED_TERRAIN_INDEX);
      expect(types.getZ(v)).not.toBe(DEFAULT_RIVERBED_TERRAIN_INDEX);
    }
  });
});
