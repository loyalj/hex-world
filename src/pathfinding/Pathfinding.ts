import { type HexCoord, hexDistance, hexNeighbors, hexEquals, hexToOffset } from '../math/HexCoord.js';

/**
 * Cost function supplied by the game. Called for each candidate move.
 * Return `Infinity` (or any non-finite value) to mark a cell as impassable.
 * Costs must be non-negative.
 *
 * @example
 * const cost: MoveCostFn = (from, to) => {
 *   const terrain = map.getTerrain(col, row); // close over your HexMap
 *   if (terrain === TerrainType.Water) return Infinity;
 *   if (terrain === TerrainType.Rock)  return 3;
 *   return 1;
 * };
 */
export type MoveCostFn = (from: HexCoord, to: HexCoord) => number;

// ---------------------------------------------------------------------------
// Internal min-heap
// ---------------------------------------------------------------------------

class MinHeap<T> {
  private readonly data: T[] = [];
  constructor(private readonly priority: (item: T) => number) {}

  get size(): number { return this.data.length; }
  isEmpty(): boolean { return this.data.length === 0; }

  push(item: T): void {
    this.data.push(item);
    this._siftUp(this.data.length - 1);
  }

  pop(): T | undefined {
    if (this.data.length === 0) return undefined;
    const top  = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) { this.data[0] = last; this._siftDown(0); }
    return top;
  }

  private _siftUp(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.priority(this.data[p]) <= this.priority(this.data[i])) break;
      [this.data[p], this.data[i]] = [this.data[i], this.data[p]];
      i = p;
    }
  }

  private _siftDown(i: number): void {
    const n = this.data.length;
    for (;;) {
      let s = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this.priority(this.data[l]) < this.priority(this.data[s])) s = l;
      if (r < n && this.priority(this.data[r]) < this.priority(this.data[s])) s = r;
      if (s === i) break;
      [this.data[s], this.data[i]] = [this.data[i], this.data[s]];
      i = s;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function key(h: HexCoord): string { return `${h.q},${h.r}`; }

function inBounds(h: HexCoord, map: { width: number; height: number }): boolean {
  const { col, row } = hexToOffset(h);
  return col >= 0 && col < map.width && row >= 0 && row < map.height;
}

// ---------------------------------------------------------------------------
// A* pathfinding
// ---------------------------------------------------------------------------

/**
 * Finds the lowest-cost path between two hex cells using A*.
 *
 * Returns an array of `HexCoord` from `from` to `to` (both inclusive),
 * or `null` if no path exists.
 *
 * The `costFn` is called for every candidate step. Return `Infinity` to mark
 * a transition as impassable. Close over your `HexMap` inside the function —
 * the library does not read terrain data directly.
 *
 * @example
 * const path = findPath(
 *   offsetToHex(startCol, startRow),
 *   offsetToHex(goalCol,  goalRow),
 *   (from, to) => {
 *     const { col, row } = hexToOffset(to);
 *     return map.getTerrain(col, row) === TerrainType.Water ? Infinity : 1;
 *   },
 *   map,
 * );
 */
export function findPath(
  from: HexCoord,
  to: HexCoord,
  costFn: MoveCostFn,
  map: { width: number; height: number },
): HexCoord[] | null {
  if (hexEquals(from, to)) return [from];

  type Entry = { node: HexCoord; f: number };
  const open     = new MinHeap<Entry>(e => e.f);
  const closed   = new Set<string>();
  const gScore   = new Map<string, number>();
  const cameFrom = new Map<string, HexCoord>();

  gScore.set(key(from), 0);
  open.push({ node: from, f: hexDistance(from, to) });

  while (!open.isEmpty()) {
    const { node } = open.pop()!;
    const nk = key(node);

    if (closed.has(nk)) continue;
    closed.add(nk);

    if (hexEquals(node, to)) {
      const path: HexCoord[] = [];
      let c: HexCoord | undefined = node;
      while (c) { path.unshift(c); c = cameFrom.get(key(c)); }
      return path;
    }

    const g = gScore.get(nk)!;

    for (const nb of hexNeighbors(node)) {
      if (!inBounds(nb, map)) continue;
      const nbk = key(nb);
      if (closed.has(nbk)) continue;

      const cost = costFn(node, nb);
      if (!isFinite(cost) || cost < 0) continue;

      const tentativeG = g + cost;
      if (tentativeG < (gScore.get(nbk) ?? Infinity)) {
        cameFrom.set(nbk, node);
        gScore.set(nbk, tentativeG);
        open.push({ node: nb, f: tentativeG + hexDistance(nb, to) });
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Movement range (flood-fill Dijkstra)
// ---------------------------------------------------------------------------

/**
 * Returns all cells reachable from `center` within a movement `budget`.
 *
 * Uses Dijkstra's algorithm — each reachable cell is visited once at its
 * minimum cost. The center cell is always included (at cost 0).
 *
 * The returned array includes the `center` itself. Order is not guaranteed.
 *
 * @example
 * const reachable = getMovementRange(
 *   offsetToHex(unitCol, unitRow),
 *   3,
 *   (from, to) => {
 *     const { col, row } = hexToOffset(to);
 *     if (map.getTerrain(col, row) === TerrainType.Water) return Infinity;
 *     return map.getElevation(col, row) > 4 ? 2 : 1;
 *   },
 *   map,
 * );
 */
export function getMovementRange(
  center: HexCoord,
  budget: number,
  costFn: MoveCostFn,
  map: { width: number; height: number },
): HexCoord[] {
  type Entry = { node: HexCoord; cost: number };
  const open      = new MinHeap<Entry>(e => e.cost);
  const bestCost  = new Map<string, number>();
  const reachable: HexCoord[] = [];

  bestCost.set(key(center), 0);
  open.push({ node: center, cost: 0 });

  while (!open.isEmpty()) {
    const { node, cost } = open.pop()!;
    const nk = key(node);

    if (cost > (bestCost.get(nk) ?? Infinity)) continue; // stale entry

    reachable.push(node);

    for (const nb of hexNeighbors(node)) {
      if (!inBounds(nb, map)) continue;

      const moveCost = costFn(node, nb);
      if (!isFinite(moveCost) || moveCost < 0) continue;

      const newCost = cost + moveCost;
      if (newCost > budget) continue;

      const nbk = key(nb);
      if (newCost < (bestCost.get(nbk) ?? Infinity)) {
        bestCost.set(nbk, newCost);
        open.push({ node: nb, cost: newCost });
      }
    }
  }

  return reachable;
}
