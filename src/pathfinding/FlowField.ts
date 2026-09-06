import { type HexCoord, HEX_DIRECTIONS, hexToOffset, offsetToHex } from '../math/HexCoord.js';
import type { HexLayout } from '../math/HexLayout.js';
import type { MoveCostFn } from './Pathfinding.js';

/** Options for {@link FlowField.compute} / {@link computeFlowField}. */
export interface FlowFieldOptions {
  /**
   * Stop expanding once the accumulated cost to a cell exceeds this. Cells
   * beyond it report `Infinity` and no direction, exactly as if unreachable.
   *
   * Use it when only units within a known distance will ever consult the
   * field — a capped field over a continent-sized map costs a fraction of a
   * full one. Default `Infinity` (cover everything reachable).
   */
  maxCost?: number;
}

// The 6 direction indices, paired with their opposites. `HEX_DIRECTIONS[d]`
// and `HEX_DIRECTIONS[(d + 3) % 6]` are negatives of each other.
const OPPOSITE = [3, 4, 5, 0, 1, 2];

/**
 * A single-source-set Dijkstra field: the cheapest cost from *every* cell to
 * the nearest goal, plus the neighbour to step to next.
 *
 * This is the many-units-one-destination counterpart to {@link findPath}. A*
 * costs one search **per unit**; a flow field costs one search **per
 * destination**, after which every unit reads its next step in O(1) no matter
 * how many of them there are or how far away they stand. For an army converging
 * on a rally point, or a horde chasing one target, that is the difference
 * between hundreds of searches a turn and one.
 *
 * ### The cost function runs backwards
 *
 * The field is built by expanding *outward from the goals*, so when the search
 * reaches cell `X` from an already-settled cell `Y`, the move a unit will
 * actually make is `X → Y`. `costFn` is therefore called as `costFn(X, Y)` —
 * the direction of travel, not the direction of expansion. Symmetric cost
 * functions (the common case) can ignore this entirely; asymmetric ones (uphill
 * costs more than downhill, one-way fords) get the right answer without doing
 * anything special.
 *
 * ### Several goals
 *
 * Pass an array and every cell flows to whichever goal is *cheapest* from it,
 * with the watershed between them falling out of the search. One field can
 * serve "retreat to the nearest fort".
 *
 * ### Cells you can leave but not enter
 *
 * Because the cost asked about is always the move *out* of a cell, a cell your
 * cost function refuses to admit anyone into still gets a direction if it has a
 * passable way out — a unit spawned or shoved onto a wall is given a route off
 * it rather than being told it is stranded. Nothing routes *through* such a
 * cell, since the step into it is still rejected.
 *
 * ### Memory
 *
 * Dense typed arrays — 13 bytes per map cell, allocated once. {@link compute}
 * reuses them, so re-targeting the field every frame allocates nothing.
 *
 * @example
 * const field = computeFlowField(offsetToHex(rallyCol, rallyRow), moveCost, map);
 * for (const unit of army) {
 *   const path = field.path(offsetToHex(unit.col, unit.row));
 *   if (path) unit.travel(path);
 * }
 *
 * @example
 * // Re-target each turn without reallocating.
 * const field = new FlowField(map);
 * field.compute(goals, moveCost, { maxCost: 40 });
 */
export class FlowField {
  readonly width: number;
  readonly height: number;

  private readonly _cost:  Float64Array;
  private readonly _dir:   Int8Array;
  private readonly _stamp: Int32Array;

  private _heapIdx:  Int32Array;
  private _heapCost: Float64Array;
  private _heapSize = 0;

  private _pass    = 0;
  private _reached = 0;
  private _maxCost = Infinity;
  private _goals: HexCoord[] = [];
  private _costFn: MoveCostFn = () => 1;

  constructor(map: { width: number; height: number }) {
    this.width  = map.width;
    this.height = map.height;

    const n = this.width * this.height;
    this._cost  = new Float64Array(n);
    this._dir   = new Int8Array(n);
    this._stamp = new Int32Array(n);

    const cap = Math.max(16, Math.min(n, 1024));
    this._heapIdx  = new Int32Array(cap);
    this._heapCost = new Float64Array(cap);
  }

  /** Number of cells the last {@link compute} reached, goals included. */
  get reachedCount(): number { return this._reached; }

  /** The goals the last {@link compute} ran from, clipped to those in bounds. */
  get goals(): readonly HexCoord[] { return this._goals; }

  /** The `maxCost` the last {@link compute} ran with. */
  get maxCost(): number { return this._maxCost; }

  /**
   * Rebuilds the field for a new goal set, reusing the existing buffers.
   *
   * Cost is one Dijkstra sweep over the reachable area — the same work
   * {@link getMovementRange} does for one unit, shared by all of them.
   *
   * @param goals  - One `HexCoord` or several. Out-of-bounds goals are ignored;
   *                 with none left in bounds every cell reports unreachable.
   * @param costFn - Movement cost, called as `costFn(from, to)` in the
   *                 direction of travel. Return `Infinity` for impassable.
   */
  compute(
    goals: HexCoord | readonly HexCoord[],
    costFn: MoveCostFn,
    opts: FlowFieldOptions = {},
  ): this {
    const list = Array.isArray(goals) ? (goals as readonly HexCoord[]) : [goals as HexCoord];
    const { width, height, _cost, _dir, _stamp } = this;

    // Stamping beats clearing: a pass counter that only ever grows lets a
    // 500k-cell field be invalidated in one assignment instead of a memset.
    if (this._pass >= 0x7fffffff) { _stamp.fill(0); this._pass = 0; }
    const pass = ++this._pass;

    this._maxCost  = opts.maxCost ?? Infinity;
    this._costFn   = costFn;
    this._reached  = 0;
    this._heapSize = 0;
    this._goals    = [];

    const maxCost = this._maxCost;

    for (const g of list) {
      const { col, row } = hexToOffset(g);
      if (col < 0 || col >= width || row < 0 || row >= height) continue;
      const i = row * width + col;
      if (_stamp[i] === pass) continue; // duplicate goal
      _stamp[i] = pass;
      _cost[i]  = 0;
      _dir[i]   = -1;
      this._reached++;
      this._goals.push(g);
      this._push(i, 0);
    }

    while (this._heapSize > 0) {
      const i = this._heapIdx[0];
      const c = this._heapCost[0];
      this._pop();
      if (_stamp[i] !== pass || c > _cost[i]) continue; // stale heap entry

      const col = i % width;
      const row = (i - col) / width;
      const here = offsetToHex(col, row);

      for (let d = 0; d < 6; d++) {
        const dir = HEX_DIRECTIONS[d];
        const nb  = { q: here.q + dir.q, r: here.r + dir.r };
        const off = hexToOffset(nb);
        if (off.col < 0 || off.col >= width || off.row < 0 || off.row >= height) continue;

        // The expansion runs goal-outward; the move runs neighbour-inward.
        const step = costFn(nb, here);
        if (!isFinite(step) || step < 0) continue;

        const nc = c + step;
        if (nc > maxCost) continue;

        const ni = off.row * width + off.col;
        const seen = _stamp[ni] === pass;
        if (seen && nc >= _cost[ni]) continue;

        if (!seen) { _stamp[ni] = pass; this._reached++; }
        _cost[ni] = nc;
        _dir[ni]  = OPPOSITE[d];
        this._push(ni, nc);
      }
    }

    return this;
  }

  // -------------------------------------------------------------------------
  // Reading the field
  // -------------------------------------------------------------------------

  /** Cost from `(col, row)` to the nearest goal, or `Infinity` if unreachable. */
  costAt(col: number, row: number): number {
    if (col < 0 || col >= this.width || row < 0 || row >= this.height) return Infinity;
    const i = row * this.width + col;
    return this._stamp[i] === this._pass ? this._cost[i] : Infinity;
  }

  /** Cost from `hex` to the nearest goal, or `Infinity` if unreachable. */
  cost(hex: HexCoord): number {
    const { col, row } = hexToOffset(hex);
    return this.costAt(col, row);
  }

  /** `true` if a path from `(col, row)` to some goal exists within `maxCost`. */
  isReachableAt(col: number, row: number): boolean {
    return isFinite(this.costAt(col, row));
  }

  /** `true` if a path from `hex` to some goal exists within `maxCost`. */
  isReachable(hex: HexCoord): boolean {
    return isFinite(this.cost(hex));
  }

  /**
   * The direction index (0–5, indexing {@link HEX_DIRECTIONS}) of the next step
   * from `(col, row)`. Returns `-1` at a goal and for unreachable cells — call
   * {@link costAt} to tell those two apart.
   */
  directionAt(col: number, row: number): number {
    if (col < 0 || col >= this.width || row < 0 || row >= this.height) return -1;
    const i = row * this.width + col;
    return this._stamp[i] === this._pass ? this._dir[i] : -1;
  }

  /** The direction index (0–5) of the next step from `hex`, or `-1`. */
  direction(hex: HexCoord): number {
    const { col, row } = hexToOffset(hex);
    return this.directionAt(col, row);
  }

  /**
   * The cell a unit standing on `hex` should move to next, or `null` at a goal
   * or on an unreachable cell. O(1) — this is the per-unit read the whole
   * structure exists for.
   */
  next(hex: HexCoord): HexCoord | null {
    const d = this.direction(hex);
    if (d < 0) return null;
    return { q: hex.q + HEX_DIRECTIONS[d].q, r: hex.r + HEX_DIRECTIONS[d].r };
  }

  /**
   * Walks the field from `from` to the goal it flows to, returning the same
   * shape {@link findPath} does — `from` first, goal last, both inclusive — so
   * it can be handed straight to `HexUnit.travel()`.
   *
   * Returns `null` if `from` is unreachable, and `[from]` if it is already a
   * goal. Following the field is O(path length): no search runs here.
   */
  path(from: HexCoord): HexCoord[] | null {
    if (!isFinite(this.cost(from))) return null;
    const out: HexCoord[] = [from];
    // Cost strictly decreases along the field, so this cannot loop; the bound
    // is a backstop against a caller mutating the field mid-walk.
    const limit = this.width * this.height;
    let cur = from;
    for (let i = 0; i < limit; i++) {
      const nxt = this.next(cur);
      if (!nxt) return out;
      out.push(nxt);
      cur = nxt;
    }
    return out;
  }

  /**
   * A normalised world-space `(x, z)` direction to steer toward, or `null` at a
   * goal or on an unreachable cell.
   *
   * This is **not** just {@link next} converted to world space. It blends the
   * directions of every neighbour the field descends into, weighted by how much
   * cost each one saves, which is what makes a crowd read as a crowd: units
   * crossing open ground aim at the true bearing rather than snapping to one of
   * six axes, and a column meeting an obstacle splits around both sides instead
   * of filing through a single hex. Edges the cost function rejects are
   * excluded, so a cell whose cheap-looking neighbour sits across an
   * impassable cliff edge does not steer into it.
   *
   * Costs ≤6 `costFn` calls — per unit per frame, not per cell.
   *
   * @example
   * const v = field.flowVector(layout, offsetToHex(unit.col, unit.row));
   * if (v) { unit.worldX += v.x * speed * dt; unit.worldZ += v.z * speed * dt; }
   */
  flowVector(layout: HexLayout, hex: HexCoord): { x: number; z: number } | null {
    const c = this.cost(hex);
    if (!isFinite(c)) return null;

    const { f0, f1, f2, f3 } = layout.orientation;
    let x = 0, z = 0;

    for (let d = 0; d < 6; d++) {
      const dir = HEX_DIRECTIONS[d];
      const nb  = { q: hex.q + dir.q, r: hex.r + dir.r };
      const nc  = this.cost(nb);
      if (!isFinite(nc)) continue;
      const drop = c - nc;
      if (drop <= 0) continue;

      const step = this._costFn(hex, nb);
      if (!isFinite(step) || step < 0) continue;

      // The layout transform is linear, so a direction vector maps without the
      // origin term. Scale cancels in the normalisation below.
      const dx = f0 * dir.q + f1 * dir.r;
      const dz = f2 * dir.q + f3 * dir.r;
      const len = Math.hypot(dx, dz) || 1;
      x += (dx / len) * drop;
      z += (dz / len) * drop;
    }

    const len = Math.hypot(x, z);
    if (len === 0) return null;
    return { x: x / len, z: z / len };
  }

  /**
   * Visits every cell the field reached, in row-major order. Scans the whole
   * grid — O(width × height) — so it belongs in debug overlays and field
   * visualisations, not in a per-unit hot path.
   */
  forEachReached(fn: (col: number, row: number, cost: number, direction: number) => void): void {
    const { width, height, _cost, _dir, _stamp } = this;
    const pass = this._pass;
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const i = row * width + col;
        if (_stamp[i] !== pass) continue;
        fn(col, row, _cost[i], _dir[i]);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Index min-heap over parallel arrays — no per-node objects, which is most of
  // why this is cheaper than running A* per unit.
  // -------------------------------------------------------------------------

  private _push(idx: number, cost: number): void {
    if (this._heapSize === this._heapIdx.length) this._growHeap();
    let i = this._heapSize++;
    this._heapIdx[i]  = idx;
    this._heapCost[i] = cost;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._heapCost[p] <= this._heapCost[i]) break;
      this._swap(p, i);
      i = p;
    }
  }

  private _pop(): void {
    const n = --this._heapSize;
    if (n <= 0) return;
    this._heapIdx[0]  = this._heapIdx[n];
    this._heapCost[0] = this._heapCost[n];
    let i = 0;
    for (;;) {
      let s = i;
      const l = 2 * i + 1, r = l + 1;
      if (l < n && this._heapCost[l] < this._heapCost[s]) s = l;
      if (r < n && this._heapCost[r] < this._heapCost[s]) s = r;
      if (s === i) break;
      this._swap(s, i);
      i = s;
    }
  }

  private _swap(a: number, b: number): void {
    const ti = this._heapIdx[a];  this._heapIdx[a]  = this._heapIdx[b];  this._heapIdx[b]  = ti;
    const tc = this._heapCost[a]; this._heapCost[a] = this._heapCost[b]; this._heapCost[b] = tc;
  }

  private _growHeap(): void {
    const idx  = new Int32Array(this._heapIdx.length * 2);
    const cost = new Float64Array(idx.length);
    idx.set(this._heapIdx);
    cost.set(this._heapCost);
    this._heapIdx  = idx;
    this._heapCost = cost;
  }
}

/**
 * Builds a {@link FlowField} over `map` in one call.
 *
 * Convenience for one-off fields. When the destination changes every turn or
 * every frame, construct a `FlowField` once and call
 * {@link FlowField.compute} on it instead — that path reuses its buffers.
 *
 * @example
 * const field = computeFlowField(offsetToHex(goalCol, goalRow), moveCost, map);
 * for (const unit of army) {
 *   const path = field.path(offsetToHex(unit.col, unit.row));
 *   if (path && path.length > 1) unit.travel(path);
 * }
 */
export function computeFlowField(
  goals: HexCoord | readonly HexCoord[],
  costFn: MoveCostFn,
  map: { width: number; height: number },
  opts: FlowFieldOptions = {},
): FlowField {
  return new FlowField(map).compute(goals, costFn, opts);
}
