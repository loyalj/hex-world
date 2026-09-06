import { describe, it, expect } from 'vitest';
import { FlowField, computeFlowField } from '../src/pathfinding/FlowField.js';
import { findPath } from '../src/pathfinding/Pathfinding.js';
import { offsetToHex, hexToOffset, hexEquals, HEX_DIRECTIONS, type HexCoord } from '../src/math/HexCoord.js';
import { createLayout } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';

const map10 = { width: 10, height: 10 };
const uniform = () => 1;

const pathCost = (p: HexCoord[], cost: (a: HexCoord, b: HexCoord) => number): number =>
  p.slice(1).reduce((s, h, i) => s + cost(p[i], h), 0);

describe('FlowField.compute', () => {
  it('gives every reachable cell the cost of the cheapest route to the goal', () => {
    const field = computeFlowField(offsetToHex(5, 5), uniform, map10);
    expect(field.costAt(5, 5)).toBe(0);
    expect(field.reachedCount).toBe(100);

    // With uniform cost the field is exactly the hex distance to the goal.
    for (let row = 0; row < 10; row++) {
      for (let col = 0; col < 10; col++) {
        const astar = findPath(offsetToHex(col, row), offsetToHex(5, 5), uniform, map10)!;
        expect(field.costAt(col, row)).toBe(astar.length - 1);
      }
    }
  });

  it('matches A* path cost from every cell, on a non-uniform map', () => {
    // A ridge that costs 5 to enter, with one cheap gap at row 4.
    const cost = (_from: HexCoord, to: HexCoord) => {
      const { col, row } = hexToOffset(to);
      if (col === 5 && row !== 4) return 5;
      return 1;
    };
    const goal  = offsetToHex(9, 9);
    const field = computeFlowField(goal, cost, map10);

    for (let row = 0; row < 10; row++) {
      for (let col = 0; col < 10; col++) {
        const from  = offsetToHex(col, row);
        const astar = findPath(from, goal, cost, map10)!;
        expect(field.costAt(col, row)).toBeCloseTo(pathCost(astar, cost), 9);
      }
    }
  });

  it('flows to the nearest of several goals', () => {
    const field = computeFlowField([offsetToHex(0, 0), offsetToHex(9, 9)], uniform, map10);
    expect(field.costAt(0, 0)).toBe(0);
    expect(field.costAt(9, 9)).toBe(0);
    expect(field.direction(offsetToHex(0, 0))).toBe(-1);

    // A cell in the top-left corner walks to the top-left goal.
    const p = field.path(offsetToHex(1, 1))!;
    expect(hexEquals(p[p.length - 1], offsetToHex(0, 0))).toBe(true);
    // ...and one in the bottom-right walks to the other.
    const q = field.path(offsetToHex(8, 8))!;
    expect(hexEquals(q[q.length - 1], offsetToHex(9, 9))).toBe(true);
  });

  it('reports unreachable cells as Infinity with no direction', () => {
    // A wall down column 5 splits the map in two, impassable both ways.
    const cost = (from: HexCoord, to: HexCoord) =>
      hexToOffset(to).col === 5 || hexToOffset(from).col === 5 ? Infinity : 1;
    const field = computeFlowField(offsetToHex(0, 5), cost, map10);

    expect(field.isReachableAt(1, 5)).toBe(true);
    expect(field.costAt(5, 5)).toBe(Infinity);
    expect(field.costAt(9, 5)).toBe(Infinity);
    expect(field.directionAt(9, 5)).toBe(-1);
    expect(field.path(offsetToHex(9, 5))).toBeNull();
    expect(field.flowVector(createLayout(POINTY_TOP, 1), offsetToHex(9, 5))).toBeNull();
  });

  it('gives a cell that can be left but not entered an escape route', () => {
    // Column 5 is impassable to *enter*. A unit already standing there — pushed
    // onto a wall, spawned in a wall — can still walk off it, and the field
    // says so, because the cost it asks about is the move out.
    const cost = (_from: HexCoord, to: HexCoord) =>
      hexToOffset(to).col === 5 ? Infinity : 1;
    const field = computeFlowField(offsetToHex(0, 5), cost, map10);

    expect(field.costAt(5, 5)).toBe(5);
    expect(hexToOffset(field.next(offsetToHex(5, 5))!).col).toBe(4);
    // Nothing crosses it, though — the far side stays cut off.
    expect(field.costAt(6, 5)).toBe(Infinity);
    expect(field.costAt(9, 5)).toBe(Infinity);
  });

  it('ignores out-of-bounds goals, and reaches nothing when none are in bounds', () => {
    const field = computeFlowField([offsetToHex(-4, -4), offsetToHex(3, 3)], uniform, map10);
    expect(field.goals.length).toBe(1);
    expect(field.reachedCount).toBe(100);

    const empty = computeFlowField(offsetToHex(-4, -4), uniform, map10);
    expect(empty.goals.length).toBe(0);
    expect(empty.reachedCount).toBe(0);
    expect(empty.costAt(3, 3)).toBe(Infinity);
  });

  it('stops expanding at maxCost', () => {
    const field = computeFlowField(offsetToHex(5, 5), uniform, map10, { maxCost: 2 });
    // Hex disc of radius 2 = 1 + 3·2·3 = 19 cells, all inside a 10×10 map.
    expect(field.reachedCount).toBe(19);
    expect(field.costAt(5, 5)).toBe(0);
    expect(field.costAt(5, 3)).toBe(2);
    expect(field.costAt(5, 1)).toBe(Infinity);
    expect(field.maxCost).toBe(2);
  });
});

describe('FlowField cost direction', () => {
  // Expansion runs outward from the goal, but the cost function must be asked
  // about the direction of travel — inward. A cost function that is cheap one
  // way and expensive the other is the only way to tell those apart.
  const goal = offsetToHex(5, 5);

  // Moving toward a *lower* row is cheap, toward a higher row is expensive.
  const oneWay = (from: HexCoord, to: HexCoord) =>
    hexToOffset(to).row < hexToOffset(from).row ? 1 : 20;

  it('asks costFn in the direction of travel', () => {
    const field = computeFlowField(goal, oneWay, map10);
    // (5, 7) reaches the goal by walking up two rows: 2 cheap steps.
    expect(field.costAt(5, 7)).toBe(2);
    // (5, 3) has to walk *down* two rows into the expensive direction.
    expect(field.costAt(5, 3)).toBe(40);
  });

  it('agrees with A* under an asymmetric cost function', () => {
    const field = computeFlowField(goal, oneWay, map10);
    for (let row = 0; row < 10; row++) {
      for (let col = 0; col < 10; col++) {
        const astar = findPath(offsetToHex(col, row), goal, oneWay, map10)!;
        expect(field.costAt(col, row)).toBeCloseTo(pathCost(astar, oneWay), 9);
      }
    }
  });
});

describe('FlowField.path / next', () => {
  it('returns a findPath-shaped path — start first, goal last', () => {
    const goal  = offsetToHex(8, 2);
    const field = computeFlowField(goal, uniform, map10);
    const p     = field.path(offsetToHex(1, 7))!;

    expect(hexEquals(p[0], offsetToHex(1, 7))).toBe(true);
    expect(hexEquals(p[p.length - 1], goal)).toBe(true);
    expect(p.length).toBe(findPath(offsetToHex(1, 7), goal, uniform, map10)!.length);

    // Every step is a real neighbour move.
    for (let i = 1; i < p.length; i++) {
      const ok = HEX_DIRECTIONS.some(d => p[i - 1].q + d.q === p[i].q && p[i - 1].r + d.r === p[i].r);
      expect(ok).toBe(true);
    }
  });

  it('returns just the start when the start is a goal', () => {
    const field = computeFlowField(offsetToHex(4, 4), uniform, map10);
    const p = field.path(offsetToHex(4, 4))!;
    expect(p.length).toBe(1);
    expect(field.next(offsetToHex(4, 4))).toBeNull();
  });

  it('steps strictly downhill in cost', () => {
    const cost = (_from: HexCoord, to: HexCoord) => (hexToOffset(to).col === 4 ? 6 : 1);
    const field = computeFlowField(offsetToHex(9, 9), cost, map10);
    for (let row = 0; row < 10; row++) {
      for (let col = 0; col < 10; col++) {
        const here = offsetToHex(col, row);
        const nxt  = field.next(here);
        if (!nxt) continue;
        expect(field.cost(nxt)).toBeLessThan(field.cost(here));
      }
    }
  });
});

describe('FlowField.flowVector', () => {
  const layout = createLayout(POINTY_TOP, 1);

  it('points toward the goal, blending across the axes between them', () => {
    const field = computeFlowField(offsetToHex(9, 5), uniform, map10);
    const v = field.flowVector(layout, offsetToHex(1, 5))!;
    // The goal is due +X of the start on a pointy-top layout.
    expect(v.x).toBeCloseTo(1, 6);
    expect(Math.abs(v.z)).toBeLessThan(1e-6);
    expect(Math.hypot(v.x, v.z)).toBeCloseTo(1, 9);
  });

  it('is null at a goal', () => {
    const field = computeFlowField(offsetToHex(5, 5), uniform, map10);
    expect(field.flowVector(layout, offsetToHex(5, 5))).toBeNull();
  });

  it('never steers across an edge the cost function rejects', () => {
    // Column 4 is reachable (from above and below) but can only be *entered*
    // from row 0 — a cliff whose only ramp is elsewhere. A naive
    // cost-gradient blend would still lean into it from column 3.
    const cost = (from: HexCoord, to: HexCoord) => {
      const t = hexToOffset(to), f = hexToOffset(from);
      if (t.col === 4 && f.col !== 4 && f.row !== 0) return Infinity;
      return 1;
    };
    const goal  = offsetToHex(4, 9);
    const field = computeFlowField(goal, cost, map10);
    const here  = offsetToHex(3, 5);

    expect(isFinite(field.cost(here))).toBe(true);
    // The cheaper neighbour across the cliff is excluded, so the blend agrees
    // with the discrete step the field actually settled on.
    const v    = field.flowVector(layout, here)!;
    const nxt  = field.next(here)!;
    const noff = hexToOffset(nxt);
    expect(noff.col).not.toBe(4);
    // Same half-plane as the discrete step.
    const d = HEX_DIRECTIONS[field.direction(here)];
    const dx = layout.orientation.f0 * d.q + layout.orientation.f1 * d.r;
    const dz = layout.orientation.f2 * d.q + layout.orientation.f3 * d.r;
    const len = Math.hypot(dx, dz);
    expect(v.x * (dx / len) + v.z * (dz / len)).toBeGreaterThan(0);
  });
});

describe('FlowField.compute reuse', () => {
  it('re-targets in place without leaking the previous field', () => {
    const field = new FlowField(map10);

    field.compute(offsetToHex(0, 0), uniform);
    expect(field.costAt(0, 0)).toBe(0);
    expect(field.costAt(9, 9)).toBe(computeFlowField(offsetToHex(0, 0), uniform, map10).costAt(9, 9));

    // A wall this time: the cells that were reachable a moment ago must not be.
    const walled = (_f: HexCoord, to: HexCoord) => (hexToOffset(to).col === 5 ? Infinity : 1);
    field.compute(offsetToHex(9, 9), walled);
    expect(field.costAt(9, 9)).toBe(0);
    expect(field.costAt(0, 0)).toBe(Infinity);
    expect(field.directionAt(0, 0)).toBe(-1);
  });

  it('forEachReached visits exactly the reached cells', () => {
    const field = computeFlowField(offsetToHex(5, 5), uniform, map10, { maxCost: 1 });
    const seen: string[] = [];
    field.forEachReached((col, row, cost) => { seen.push(`${col},${row}:${cost}`); });
    expect(seen.length).toBe(7); // centre + 6 neighbours
    expect(seen).toContain('5,5:0');
    expect(field.reachedCount).toBe(7);
  });
});
