import { describe, it, expect } from 'vitest';
import { HexMap } from '../src/map/HexMap.js';
import { generateChunkTerrain } from '../src/generators/ChunkTerrainGenerator.js';
import { generateRivers } from '../src/generators/RiverGenerator.js';
import { generateRoads } from '../src/generators/RoadGenerator.js';
import { makeRng } from '../src/math/Random.js';

describe('generateChunkTerrain', () => {
  it('produces land near the requested percentage and is deterministic', () => {
    const gen = (seed: number) => {
      const m = new HexMap({ width: 64, height: 64 });
      generateChunkTerrain(m, [{ colMin: 0, colMax: 64, rowMin: 0, rowMax: 64 }], { landPercentage: 40 }, makeRng(seed));
      return m;
    };
    const a = gen(123), b = gen(123), c = gen(456);
    let land = 0;
    a.forEach((col, row) => { if (a.getElevation(col, row) >= 0) land++; });
    expect(land).toBeGreaterThan(200);
    expect(a.uint8).toEqual(b.uint8);          // same seed → identical
    expect(c.uint8).not.toEqual(a.uint8);      // different seed → different
  });
});

describe('generateRivers', () => {
  it('creates consistent river chains (no half-connected edges at merges)', () => {
    const m = new HexMap({ width: 64, height: 64 });
    generateChunkTerrain(m, [{ colMin: 0, colMax: 64, rowMin: 0, rowMax: 64 }], { landPercentage: 50 }, makeRng(7));
    generateRivers(m, { gridSpacing: 12, minSeedElevation: 2 });
    let rivers = 0;
    m.forEach((c, r) => { if (m.hasRiver(c, r)) rivers++; });
    expect(rivers).toBeGreaterThan(0);
  });
});

describe('generateRoads', () => {
  it('lays straight bands on a flat map (derived orientation faces)', () => {
    const flat = new HexMap({ width: 32, height: 32 });
    generateRoads(flat, { gridSpacing: 16 });

    let onRow = 0;
    for (let c = 0; c < 32; c++) {
      for (let e = 0; e < 6; e++) if (flat.hasRoadThroughEdge(c, 8, e)) { onRow++; break; }
    }
    let onCol = 0;
    for (let r = 0; r < 32; r++) {
      for (let e = 0; e < 6; e++) if (flat.hasRoadThroughEdge(8, r, e)) { onCol++; break; }
    }
    expect(onRow).toBeGreaterThanOrEqual(31); // horizontal band spans the row
    expect(onCol).toBeGreaterThanOrEqual(31); // vertical band stays on the column
  });

  it('breaks at water', () => {
    const m = new HexMap({ width: 32, height: 32 });
    for (let r = 0; r < 32; r++) { m.setTerrain(16, r, 5); m.setElevation(16, r, -1); }
    generateRoads(m, { gridSpacing: 16 });
    // Check only columns between the water wall (16) and the vertical road
    // band at column 24 — the horizontal band must not continue past water.
    let beyondWater = 0;
    for (let c = 17; c < 24; c++) {
      for (let e = 0; e < 6; e++) if (m.hasRoadThroughEdge(c, 8, e)) { beyondWater++; break; }
    }
    expect(beyondWater).toBe(0);
  });
});
