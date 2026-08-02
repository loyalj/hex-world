import { describe, it, expect } from 'vitest';
import { HexMap } from '../src/map/HexMap.js';
import { LiquidShowcasePlugin } from '../src/generators/LiquidShowcasePlugin.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';
import { offsetNeighbor } from '../src/math/HexCoord.js';

const EDGE_DIRS = POINTY_TOP.edgeDirections;
const WATER = 5, LAVA = 6, ACID = 7, ACID_DEEP = 8;
const isLiquid = (t: number) => t === WATER || t === LAVA || t === ACID || t === ACID_DEEP;

function followRiver(map: HexMap, c: number, r: number): { end: string; terrain?: number } {
  const seen = new Set<number>();
  for (let step = 0; step < 500; step++) {
    const key = r * map.width + c;
    if (seen.has(key)) return { end: 'loop' };
    seen.add(key);
    const out = map.getOutgoingRiverDir(c, r);
    if (out === -1) return { end: 'dead' };
    const nb = offsetNeighbor(c, r, EDGE_DIRS[out]);
    if (!map.inBounds(nb.col, nb.row)) return { end: 'dead' };
    const t = map.getTerrain(nb.col, nb.row);
    if (isLiquid(t)) return { end: 'liquid', terrain: t };
    c = nb.col; r = nb.row;
  }
  return { end: 'loop' };
}

// The showcase map is the liquids review fixture: it must exercise every
// rendering case the liquid system supports, on every seed.
describe.each([1, 42, 1337, 99999, 20260719])('LiquidShowcasePlugin seed %i', (seed) => {
  const map = new HexMap({ width: 200, height: 100, featureLayerCount: 2 });
  LiquidShowcasePlugin.generate(map, LiquidShowcasePlugin.defaultConfig, seed);

  const counts = { adjWL: 0, adjWA: 0, adjLA: 0, deepAcid: 0, wlakeCells: 0 };
  const surfaces: Record<string, number | null> = { ocean: null, caldera: null, wlake: null, acid: null };
  let outgoingFromWater = 0, incomingToLava = 0, incomingToAcid = 0, incomingToWlake = 0;
  let deadEndRivers = 0, riversToWater = 0, mismatchedChains = 0;

  map.forEach((c, r) => {
    const t = map.getTerrain(c, r);
    const e = map.getElevation(c, r);
    if (t === ACID_DEEP) counts.deepAcid++;
    if (isLiquid(t)) {
      for (let i = 0; i < 6; i++) {
        const nb = offsetNeighbor(c, r, EDGE_DIRS[i]);
        if (!map.inBounds(nb.col, nb.row)) continue;
        const nt = map.getTerrain(nb.col, nb.row);
        if (t === WATER && nt === LAVA) counts.adjWL++;
        if (t === WATER && (nt === ACID || nt === ACID_DEEP)) counts.adjWA++;
        if (t === LAVA && (nt === ACID || nt === ACID_DEEP)) counts.adjLA++;
      }
    }
    if (t === WATER && e < 0) surfaces.ocean = map.getWaterSurface(c, r);
    if (t === LAVA && e >= 0) surfaces.caldera = map.getWaterSurface(c, r);
    if ((t === ACID || t === ACID_DEEP) && e >= 0) surfaces.acid = map.getWaterSurface(c, r);
    if (t === WATER && e >= 0) { surfaces.wlake = map.getWaterSurface(c, r); counts.wlakeCells++; }

    if (t === WATER && map.getOutgoingRiverDir(c, r) !== -1) outgoingFromWater++;
    if (t === LAVA && map.hasIncomingRiver(c, r)) incomingToLava++;
    if ((t === ACID || t === ACID_DEEP) && map.hasIncomingRiver(c, r)) incomingToAcid++;
    if (t === WATER && e >= 0 && map.hasIncomingRiver(c, r)) incomingToWlake++;

    if (!isLiquid(t) && map.hasRiver(c, r)) {
      const out = map.getOutgoingRiverDir(c, r);
      if (out !== -1) {
        const nb = offsetNeighbor(c, r, EDGE_DIRS[out]);
        if (map.inBounds(nb.col, nb.row)) {
          // Mask-aware: with confluences our edge need not be the primary incoming.
          if (!map.hasRiverIncomingThroughEdge(nb.col, nb.row, (out + 3) % 6)) mismatchedChains++;
        }
      }
      if (!map.hasIncomingRiver(c, r)) {
        const res = followRiver(map, c, r);
        if (res.end === 'dead') deadEndRivers++;
        if (res.end === 'liquid' && res.terrain === WATER) riversToWater++;
      }
    }
  });

  it('has all three liquid-liquid boundary pairs', () => {
    expect(counts.adjWL).toBeGreaterThan(0);
    expect(counts.adjWA).toBeGreaterThan(0);
    expect(counts.adjLA).toBeGreaterThan(0);
  });

  it('has a multi-index liquid (deep acid) and an elevated water lake', () => {
    expect(counts.deepAcid).toBeGreaterThan(0);
    expect(counts.wlakeCells).toBeGreaterThan(0);
  });

  it('computes correct per-body surfaces', () => {
    expect(surfaces.ocean).toBe(0);
    expect(surfaces.caldera).toBe(7);
    expect(surfaces.acid).toBe(1);
    expect(surfaces.wlake).toBe(4);
  });

  it('exercises every river/estuary case', () => {
    expect(outgoingFromWater).toBeGreaterThan(0); // lake outlet (outgoing estuary)
    expect(incomingToLava).toBeGreaterThan(0);
    expect(incomingToAcid).toBeGreaterThan(0);
    expect(incomingToWlake).toBeGreaterThan(0);   // elevated-lake inlet
    expect(deadEndRivers).toBeGreaterThan(0);     // unclassified river
    expect(riversToWater).toBeGreaterThan(0);
  });

  it('has no mismatched river chains', () => {
    expect(mismatchedChains).toBe(0);
  });
});
