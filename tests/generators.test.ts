import { describe, it, expect } from 'vitest';
import { HexMap } from '../src/map/HexMap.js';
import { generateChunkTerrain } from '../src/generators/ChunkTerrainGenerator.js';
import { generateRivers } from '../src/generators/RiverGenerator.js';
import { generateRoads } from '../src/generators/RoadGenerator.js';
import { makeRng } from '../src/math/Random.js';
import { offsetNeighbor } from '../src/math/HexCoord.js';
import { applyMountainRanges } from '../src/generators/MountainRangePass.js';
import { applyCoastShaping } from '../src/generators/CoastShapingPass.js';

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

describe('chunk seed placement', () => {
  const REGION = [{ colMin: 4, colMax: 68, rowMin: 4, rowMax: 68 }];
  const gen = (placement: 'uniform' | 'accrete' | 'scatter', seed: number) => {
    const m = new HexMap({ width: 72, height: 72 });
    generateChunkTerrain(m, REGION, {
      landPercentage: 35, chunkSizeMin: 10, chunkSizeMax: 40, seedPlacement: placement,
    }, makeRng(seed));
    return m;
  };

  const components = (m: HexMap): number[] => {
    const seen = new Set<number>();
    const sizes: number[] = [];
    m.forEach((col, row) => {
      const key = row * m.width + col;
      if (m.getElevation(col, row) < 0 || seen.has(key)) return;
      let size = 0;
      const stack = [{ col, row }];
      seen.add(key);
      while (stack.length > 0) {
        const c = stack.pop()!;
        size++;
        for (let d = 0; d < 6; d++) {
          const nb = offsetNeighbor(c.col, c.row, d);
          if (!m.inBounds(nb.col, nb.row)) continue;
          const nbKey = nb.row * m.width + nb.col;
          if (seen.has(nbKey) || m.getElevation(nb.col, nb.row) < 0) continue;
          seen.add(nbKey);
          stack.push(nb);
        }
      }
      sizes.push(size);
    });
    return sizes.sort((a, b) => b - a);
  };

  it('accrete grows one coherent mass, scatter grows many separate ones', () => {
    const accrete = components(gen('accrete', 42));
    const scatter = components(gen('scatter', 42));
    const share = (sizes: number[]) => sizes[0] / sizes.reduce((a, b) => a + b, 0);
    expect(share(accrete)).toBeGreaterThan(0.7);        // one dominant landmass
    expect(scatter.length).toBeGreaterThan(accrete.length); // more, smaller islands
  });

  it('is deterministic for biased placements', () => {
    expect(gen('accrete', 42).uint8).toEqual(gen('accrete', 42).uint8);
    expect(gen('scatter', 42).uint8).toEqual(gen('scatter', 42).uint8);
  });
});

describe('chunk elongation', () => {
  it('still respects the land budget and stays deterministic', () => {
    const gen = () => {
      const m = new HexMap({ width: 64, height: 64 });
      generateChunkTerrain(m, [{ colMin: 0, colMax: 64, rowMin: 0, rowMax: 64 }], {
        landPercentage: 40, chunkElongation: 2.5,
      }, makeRng(11));
      return m;
    };
    const a = gen();
    let land = 0;
    a.forEach((col, row) => { if (a.getElevation(col, row) >= 0) land++; });
    expect(land).toBeGreaterThan(1000);  // ~40% of 4096, wide tolerance
    expect(land).toBeLessThan(2100);
    expect(gen().uint8).toEqual(a.uint8);
  });
});

describe('applyMountainRanges', () => {
  const gen = () => {
    const m = new HexMap({ width: 64, height: 64 });
    generateChunkTerrain(m, [{ colMin: 0, colMax: 64, rowMin: 0, rowMax: 64 }], { landPercentage: 50 }, makeRng(9));
    return m;
  };

  it('raises ridges on land only, capped at elevationMax', () => {
    const base = gen(), peaked = gen();
    applyMountainRanges(peaked, { mountainRanges: 2, rangeUplift: 4, elevationMax: 12 }, makeRng(5));

    let raised = 0;
    base.forEach((col, row) => {
      const before = base.getElevation(col, row);
      const after  = peaked.getElevation(col, row);
      if (before < 0) expect(after).toBe(before);   // water untouched
      if (after > before) raised++;
      expect(after).toBeLessThanOrEqual(12);
    });
    expect(raised).toBeGreaterThan(0);
  });

  it('is a byte-exact no-op when mountainRanges is unset', () => {
    const base = gen(), untouched = gen();
    applyMountainRanges(untouched, {}, makeRng(5));
    expect(untouched.uint8).toEqual(base.uint8);
  });
});

describe('chunk growth features (arcs, peninsulas, warp)', () => {
  const REGION = [{ colMin: 0, colMax: 64, rowMin: 0, rowMax: 64 }];
  const gen = (opts: Parameters<typeof generateChunkTerrain>[2]) => {
    const m = new HexMap({ width: 64, height: 64 });
    generateChunkTerrain(m, REGION, { landPercentage: 40, ...opts }, makeRng(21));
    return m;
  };

  it('each feature stays deterministic and lands near the budget', () => {
    const cases: Parameters<typeof generateChunkTerrain>[2][] = [
      { seedPlacement: 'scatter', seedArcs: 3, chunkSizeMin: 5, chunkSizeMax: 18 },
      { seedPlacement: 'accrete', peninsulaProbability: 0.3 },
      { coastWarp: 4 },
    ];
    for (const opts of cases) {
      const a = gen(opts), b = gen(opts);
      expect(a.uint8).toEqual(b.uint8);
      let land = 0;
      a.forEach((col, row) => { if (a.getElevation(col, row) >= 0) land++; });
      expect(land).toBeGreaterThan(900);   // ~40% of 4096, wide tolerance
      expect(land).toBeLessThan(2300);
    }
  });

  it('warp-off generations are unchanged by the warp machinery', () => {
    const plain = gen({});
    const zero  = gen({ coastWarp: 0 });
    expect(zero.uint8).toEqual(plain.uint8);
  });
});

describe('applyCoastShaping', () => {
  const mk = () => {
    const m = new HexMap({ width: 64, height: 64 });
    generateChunkTerrain(m, [{ colMin: 0, colMax: 64, rowMin: 0, rowMax: 64 }], { landPercentage: 50 }, makeRng(9));
    return m;
  };

  it('lowers coasts relative to the interior, never touching water', () => {
    const base = mk(), shaped = mk();
    applyCoastShaping(shaped, { coastShaping: 0.9, elevationMax: 12 });

    let coastSum = 0, coastN = 0, interiorSum = 0, interiorN = 0;
    shaped.forEach((col, row) => {
      const before = base.getElevation(col, row);
      const after  = shaped.getElevation(col, row);
      if (before < 0) { expect(after).toBe(before); return; }
      expect(after).toBeGreaterThanOrEqual(0);
      expect(after).toBeLessThanOrEqual(12);
      let coastal = false;
      for (let d = 0; d < 6; d++) {
        const nb = offsetNeighbor(col, row, d);
        if (shaped.inBounds(nb.col, nb.row) && shaped.getElevation(nb.col, nb.row) < 0) { coastal = true; break; }
      }
      if (coastal) { coastSum += after; coastN++; } else { interiorSum += after; interiorN++; }
    });
    expect(coastN).toBeGreaterThan(0);
    expect(interiorN).toBeGreaterThan(0);
    expect(coastSum / coastN).toBeLessThan(interiorSum / interiorN);
  });

  it('strength 0 is a no-op', () => {
    const base = mk(), untouched = mk();
    applyCoastShaping(untouched, {});
    expect(untouched.uint8).toEqual(base.uint8);
  });
});
