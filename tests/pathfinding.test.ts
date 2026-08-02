import { describe, it, expect } from 'vitest';
import {
  findPath, getMovementRange, getVisibleCells, hasLineOfSight,
} from '../src/pathfinding/Pathfinding.js';
import { offsetToHex, hexToOffset, type HexCoord } from '../src/math/HexCoord.js';
import { cellSurfaceY } from '../src/map/CellSurface.js';
import { HexMap } from '../src/map/HexMap.js';
import { createLayout } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';

const map10 = { width: 10, height: 10 };

describe('findPath', () => {
  it('finds a straight path on uniform cost', () => {
    const p = findPath(offsetToHex(0, 5), offsetToHex(5, 5), () => 1, map10);
    expect(p).not.toBeNull();
    expect(p!.length).toBe(6);
  });

  it('returns null when the goal is unreachable', () => {
    const p = findPath(offsetToHex(0, 0), offsetToHex(9, 9), () => Infinity, map10);
    expect(p).toBeNull();
  });

  it('finds cheap sub-1-cost detours when minMoveCost is supplied', () => {
    // Row 0 is a cheap road (0.5); everything else costs 2.
    const cost = (_from: HexCoord, to: HexCoord) => {
      const { row } = hexToOffset(to);
      return row === 0 ? 0.5 : 2;
    };
    const from = offsetToHex(0, 2), to = offsetToHex(9, 2);
    const pathCost = (p: HexCoord[]) => p.slice(1).reduce((s, h, i) => s + cost(p[i], h), 0);
    const naive = findPath(from, to, cost, map10)!;
    const tuned = findPath(from, to, cost, map10, { minMoveCost: 0.5 })!;
    expect(pathCost(tuned)).toBeLessThanOrEqual(pathCost(naive));
    // The optimal route detours via the road row.
    expect(tuned.some(h => hexToOffset(h).row === 0)).toBe(true);
  });
});

describe('getMovementRange / getVisibleCells', () => {
  it('covers the full hex disc when budget allows', () => {
    // Hex disc of radius 2 = 1 + 3·2·(2+1) = 19 cells
    expect(getMovementRange(offsetToHex(5, 5), 2, () => 1, map10).length).toBe(19);
    expect(getVisibleCells(offsetToHex(5, 5), 2, map10).length).toBe(19);
  });

  it('clips to map bounds', () => {
    const vis = getVisibleCells(offsetToHex(0, 0), 2, map10);
    expect(vis.length).toBeLessThan(19);
    expect(vis.length).toBeGreaterThan(0);
  });
});

describe('hasLineOfSight', () => {
  const emap = {
    width: 10, height: 10,
    getElevation: (c: number, r: number) => (c === 5 && r === 5 ? 10 : 0),
  };
  const a = offsetToHex(3, 5), b = offsetToHex(7, 5);

  it('is blocked by an intervening ridge', () => {
    expect(hasLineOfSight(a, b, emap, 1.5)).toBe(false);
  });

  it('respects a custom elevation scale', () => {
    expect(hasLineOfSight(a, b, emap, 1.5, 0.01)).toBe(true);
  });
});

describe('cellSurfaceY', () => {
  const layout = createLayout(POINTY_TOP, 1);

  it('stays within perturbation range of the elevation plane', () => {
    const m = new HexMap({ width: 8, height: 8 });
    m.setElevation(3, 3, 4);
    const y = cellSurfaceY(m, layout, 3, 3);
    expect(Math.abs(y - 4 * 0.5)).toBeLessThanOrEqual(0.2 + 1e-9);
  });

  it('returns the water surface for liquid cells when isWater is provided', () => {
    const m = new HexMap({ width: 8, height: 8 });
    m.setTerrain(4, 4, 5); m.setElevation(4, 4, -1);
    m.computeWaterSurfaces();
    const wy = cellSurfaceY(m, layout, 4, 4, { isWater: t => t === 5 });
    expect(wy).toBeCloseTo(0.02, 9);
  });
});
