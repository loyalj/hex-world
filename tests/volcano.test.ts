import { describe, it, expect } from 'vitest';
import { HexMap } from '../src/map/HexMap.js';
import { TerrainType } from '../src/map/HexCell.js';
import { makeRng } from '../src/math/Random.js';
import { offsetToHex, hexToOffset, hexDistance, hexRange } from '../src/math/HexCoord.js';
import { applyVolcanoes, VOLCANIC_ASH_TERRAIN_DESCRIPTOR } from '../src/generators/VolcanoPass.js';
import { generateMap } from '../src/generators/MapGenerator.js';
import { generateClimateRivers } from '../src/generators/RiverGenerator.js';

const LAVA = 7;
const ASH  = VOLCANIC_ASH_TERRAIN_DESCRIPTOR.index;

/** A 30×30 grassland plain at elevation 2 with three feature layers. */
function plain(): HexMap {
  const map = new HexMap({ width: 30, height: 30, featureLayerCount: 3 });
  map.forEach((c, r) => {
    map.setTerrain(c, r, TerrainType.Grassland);
    map.setElevation(c, r, 2);
    map.setFeatureLevel(c, r, 0, 2);
  });
  return map;
}

function cells(map: HexMap, pred: (c: number, r: number) => boolean): { col: number; row: number }[] {
  const out: { col: number; row: number }[] = [];
  map.forEach((c, r) => { if (pred(c, r)) out.push({ col: c, row: r }); });
  return out;
}

describe('applyVolcanoes', () => {
  it('is a no-op that consumes no randomness when off', () => {
    const map = plain();
    const before = Array.from(map.uint8);
    const rand = makeRng(1);
    applyVolcanoes(map, {}, rand);
    expect(Array.from(map.uint8)).toEqual(before);
    expect(rand()).toBe(makeRng(1)());
  });

  it('digs a contained caldera under a rim two steps above the pool surface', () => {
    const map = plain();
    applyVolcanoes(map, { volcanoes: 1, volcanoRadius: 4, volcanoHeight: 5, volcanoLavaTerrain: LAVA, volcanoAshTerrain: ASH }, makeRng(3));

    const pool = cells(map, (c, r) => map.getTerrain(c, r) === LAVA);
    expect(pool.length).toBeGreaterThan(0);
    const floor = map.getElevation(pool[0].col, pool[0].row);
    for (const p of pool) expect(map.getElevation(p.col, p.row)).toBe(floor);

    // Every cell touching the pool is rim, and the rim clears the surface
    // (floor + 1) — the containment rule computeWaterSurfaces relies on.
    map.computeWaterSurfaces(t => t === LAVA);
    const surface = map.getWaterSurface(pool[0].col, pool[0].row);
    expect(surface).toBe(floor + 1);
    for (const p of pool) {
      for (const h of hexRange(offsetToHex(p.col, p.row), 1)) {
        const o = hexToOffset(h);
        if (!map.inBounds(o.col, o.row) || map.getTerrain(o.col, o.row) === LAVA) continue;
        expect(map.getTerrain(o.col, o.row)).toBe(ASH);
        expect(map.getElevation(o.col, o.row)).toBeGreaterThanOrEqual(surface + 1);
      }
    }
    // Rim = base 2 + height 5 = 7; pool floor two under it.
    expect(floor).toBe(5);
  });

  it('never lowers the ground outside the caldera and clears the trees it buries', () => {
    const map = plain();
    // A pre-existing ridge the cone will be built over.
    for (let c = 0; c < 30; c++) map.setElevation(c, 15, 6);
    applyVolcanoes(map, { volcanoes: 1, volcanoRadius: 5, volcanoHeight: 4, volcanoLavaTerrain: LAVA, volcanoAshTerrain: ASH }, makeRng(11));
    const pool = cells(map, (c, r) => map.getTerrain(c, r) === LAVA);
    // The pool is a radius-1 hex (7 cells); its centre is the one whose
    // neighbours are all pool.
    const centre = offsetToHex(pool[3].col, pool[3].row);
    map.forEach((c, r) => {
      if (map.getTerrain(c, r) === LAVA) return; // the caldera is the one dig
      expect(map.getElevation(c, r)).toBeGreaterThanOrEqual(r === 15 ? 6 : 2);
      if (map.getTerrain(c, r) === ASH) expect(map.getFeatureLevel(c, r, 0)).toBe(0);
      else expect(map.getFeatureLevel(c, r, 0)).toBe(2);
    });
    // Ash covers the cone (bar what the map edge clips) and reaches past it, but not the whole map.
    const ash = cells(map, (c, r) => map.getTerrain(c, r) === ASH);
    expect(ash.length).toBeGreaterThan(hexRange(centre, 4).length);
    expect(ash.length).toBeLessThan(hexRange(centre, 10).length);
  });

  it('writes smoke density only into the layer it is given', () => {
    const map = plain();
    applyVolcanoes(map, { volcanoes: 1, volcanoRadius: 4, volcanoHeight: 5, volcanoLavaTerrain: LAVA, volcanoSmokeLayer: 2 }, makeRng(5));
    const smoke = cells(map, (c, r) => map.getFeatureLevel(c, r, 2) > 0);
    expect(smoke.length).toBeGreaterThan(0);
    // Only the rim ring smokes, at the middle density; nothing on the pool itself.
    for (const s of smoke) expect(map.getTerrain(s.col, s.row)).not.toBe(LAVA);
    expect(smoke.every(s => map.getFeatureLevel(s.col, s.row, 2) === 2)).toBe(true);
    // Default ash terrain is rock.
    expect(map.getTerrain(smoke[0].col, smoke[0].row)).toBe(TerrainType.Rock);
  });

  it('keeps cones apart and off the sea', () => {
    const map = plain();
    for (let r = 0; r < 30; r++) for (let c = 20; c < 30; c++) { map.setTerrain(c, r, TerrainType.Water); map.setElevation(c, r, -1); }
    applyVolcanoes(map, { volcanoes: 3, volcanoRadius: 3, volcanoHeight: 4, volcanoLavaTerrain: LAVA, volcanoAshTerrain: ASH }, makeRng(8));
    map.forEach((c, r) => {
      if (c >= 20 && map.getTerrain(c, r) !== LAVA) {
        expect(map.getTerrain(c, r)).toBe(TerrainType.Water);
        expect(map.getElevation(c, r)).toBe(-1);
      }
    });
  });

  it('is deterministic for a seed', () => {
    const a = plain(), b = plain();
    const opts = { volcanoes: 2, volcanoRadius: 4, volcanoHeight: 5, volcanoLavaTerrain: LAVA, volcanoAshTerrain: ASH, volcanoSmokeLayer: 1 };
    applyVolcanoes(a, opts, makeRng(42));
    applyVolcanoes(b, opts, makeRng(42));
    expect(Array.from(a.uint8)).toEqual(Array.from(b.uint8));
    expect(Array.from(a.featureData!)).toEqual(Array.from(b.featureData!));
  });
});

describe('volcanoes in the pipeline', () => {
  it('survives the biome pass and stops rivers at the pool', () => {
    const map = new HexMap({ width: 48, height: 32, featureLayerCount: 4 });
    generateMap(map, {
      landPercentage: 75, mountainRanges: 1,
      volcanoes: 1, volcanoRadius: 5, volcanoHeight: 6, volcanoLavaTerrain: LAVA, volcanoAshTerrain: ASH,
      rivers: { riverPercentage: 20 },
    }, 20260906);
    const pool = cells(map, (c, r) => map.getTerrain(c, r) === LAVA);
    expect(pool.length).toBeGreaterThan(0);
    expect(cells(map, (c, r) => map.getTerrain(c, r) === ASH).length).toBeGreaterThan(pool.length);
    // A river may end in the pool (an estuary) but never leaves it.
    for (const p of pool) expect(map.hasOutgoingRiver(p.col, p.row)).toBe(false);
  });

  it('leaves a seed\'s map unchanged when no volcano is requested', () => {
    const a = new HexMap({ width: 24, height: 16 });
    const b = new HexMap({ width: 24, height: 16 });
    generateMap(a, { landPercentage: 60 }, 5);
    generateMap(b, { landPercentage: 60, volcanoes: 0 }, 5);
    expect(Array.from(a.uint8)).toEqual(Array.from(b.uint8));
  });
});

describe('river stop terrains', () => {
  it('ends a river on reaching a stop terrain instead of carving through it', () => {
    // A slope down to a lava pool at the bottom; the river must stop at it.
    const map = new HexMap({ width: 8, height: 12 });
    map.forEach((c, r) => { map.setTerrain(c, r, TerrainType.Grassland); map.setElevation(c, r, 11 - r); });
    for (let c = 0; c < 8; c++) { map.setTerrain(c, 10, LAVA); map.setTerrain(c, 11, LAVA); }
    const moisture = new Float32Array(8 * 12).fill(1);
    generateClimateRivers(map, moisture, { riverPercentage: 20, extraLakeProbability: 0, stopTerrains: [LAVA] }, makeRng(2));
    let rivers = 0;
    map.forEach((c, r) => {
      if (map.hasRiver(c, r)) rivers++;
      if (map.getTerrain(c, r) === LAVA) expect(map.hasOutgoingRiver(c, r)).toBe(false);
    });
    expect(rivers).toBeGreaterThan(0);
  });
});
