import {
  CELL_STRIDE,
  OFFSET_TERRAIN,
  OFFSET_ELEVATION,
  OFFSET_FLAGS,
  OFFSET_RIVER_DIR,
  TerrainType,
} from './HexCell.js';
import { HEX_DIRECTIONS } from '../math/HexCoord.js';
import type { HexOrientation } from '../math/HexOrientation.js';
import { MapTransaction, type MapEdit } from './MapEdit.js';

export interface HexMapOptions {
  width: number;
  height: number;
  /** Default terrain for all cells */
  defaultTerrain?: TerrainType;
  /** Number of scatter feature layers. Default 0. */
  featureLayerCount?: number;
}

/**
 * Row-major rectangular hex map backed by a flat ArrayBuffer.
 * Coordinates are offset (col, row) internally; all public API accepts
 * either offset or cube (HexCoord) coordinates.
 *
 * Memory layout per cell (CELL_STRIDE bytes):
 *   [terrain: Uint8][elevation: Int8][flags: Uint8][reserved: Uint8]
 */
export class HexMap {
  readonly width: number;
  readonly height: number;
  readonly featureLayerCount: number;

  readonly uint8: Uint8Array;
  private readonly int8: Int8Array;
  readonly roadBits: Uint8Array;
  /**
   * Per-cell bitmask of incoming river edges (bit e = a river enters across
   * edge e). Supports confluences — multiple tributaries entering one cell.
   * The cell byte keeps only the primary (lowest) incoming for compatibility.
   */
  readonly riverInBits: Uint8Array;
  readonly featureData: Uint8Array | null;
  /**
   * Per-cell water surface elevation (elevation index, same units as `getElevation`).
   * Populated by `computeWaterSurfaces`. World-space Y = `getWaterSurface(col, row) * elevScale`.
   * Initialized to 0 (sea level). Non-water cells retain 0 and should not be queried.
   */
  readonly waterSurfaces: Int8Array;
  /**
   * Per-cell hex distance to the nearest land-adjacent cell of the same water
   * body (0 = touches land, 255 = far open water / capped). Populated by
   * `computeWaterSurfaces` alongside surfaces. Drives the shallow→deep color
   * gradient in the water surface geometry. Non-water cells retain 0.
   */
  readonly shoreDistances: Uint8Array;
  /**
   * Sparse per-cell metadata channel: arbitrary JSON-serializable game data
   * (ownership, yields, quest flags, grazing state…) keyed by flat cell index
   * (`row * width + col`). Rides through save/load and `.hexpack` — values must
   * survive `JSON.stringify`/`JSON.parse` round-trips (no functions, no class
   * instances, no cycles). Prefer the `getCellData`/`setCellData` accessors;
   * the raw map is exposed for serializers and bulk iteration.
   */
  readonly cellData: Map<number, Record<string, unknown>>;
  /**
   * Bumped by every write that can change how rivers render map-wide: any
   * river edge write, and terrain or elevation writes on a cell that carries
   * a river (ownership follows the terrain a river drains into; carved levels
   * follow elevation along the flow). `ChunkManager` keys its river caches on
   * it, so a terrain stroke across dry land never triggers the whole-map
   * river walks. Raw-array writers (undo/redo, generators) must call
   * {@link bumpRiverRevision} themselves.
   */
  private _riverRevision = 0;

  constructor(options: HexMapOptions) {
    this.width = options.width;
    this.height = options.height;
    this.featureLayerCount = options.featureLayerCount ?? 0;
    const buffer = new ArrayBuffer(this.width * this.height * CELL_STRIDE);
    this.uint8 = new Uint8Array(buffer);
    this.int8 = new Int8Array(buffer);
    this.roadBits    = new Uint8Array(this.width * this.height);
    this.riverInBits = new Uint8Array(this.width * this.height);
    this.featureData = this.featureLayerCount > 0
      ? new Uint8Array(this.width * this.height * this.featureLayerCount)
      : null;
    this.waterSurfaces  = new Int8Array(this.width * this.height);
    this.shoreDistances = new Uint8Array(this.width * this.height);
    this.cellData       = new Map();

    if (options.defaultTerrain !== undefined && options.defaultTerrain !== TerrainType.Grassland) {
      for (let i = 0; i < this.width * this.height; i++) {
        this.uint8[i * CELL_STRIDE + OFFSET_TERRAIN] = options.defaultTerrain;
      }
    }
  }

  /** Total number of cells (`width × height`). */
  get cellCount(): number {
    return this.width * this.height;
  }

  /** Returns `true` if (col, row) is within the map boundaries. */
  inBounds(col: number, row: number): boolean {
    return col >= 0 && col < this.width && row >= 0 && row < this.height;
  }

  private index(col: number, row: number): number {
    return (row * this.width + col) * CELL_STRIDE;
  }

  // --- Feature layers ---

  /**
   * Returns the feature density level (0–3) for the given cell and scatter layer.
   * Returns 0 if the layer index is out of range or no feature layers were allocated.
   */
  getFeatureLevel(col: number, row: number, layer: number): number {
    if (!this.featureData || layer >= this.featureLayerCount) return 0;
    return this.featureData[(row * this.width + col) * this.featureLayerCount + layer];
  }

  /**
   * Sets the feature density level for the given cell and scatter layer.
   * `value` is clamped to 0–3 (2-bit). No-op if the layer index is out of range.
   */
  setFeatureLevel(col: number, row: number, layer: number, value: number): void {
    if (!this.featureData || layer >= this.featureLayerCount) return;
    this.featureData[(row * this.width + col) * this.featureLayerCount + layer] = value & 3;
  }

  // --- Per-cell metadata channel ---

  /**
   * Returns the metadata value stored under `key` for the cell, or `undefined`
   * if the cell has no entry for that key. Values are arbitrary
   * JSON-serializable game data — see {@link cellData}.
   */
  getCellData(col: number, row: number, key: string): unknown {
    return this.cellData.get(row * this.width + col)?.[key];
  }

  /**
   * Stores a metadata value under `key` for the cell. Passing `undefined`
   * deletes the key (and drops the cell's record entirely once its last key is
   * removed, keeping the store sparse). Values must be JSON-serializable —
   * they ride through save/load and `.hexpack` via `JSON.stringify`.
   * No-op for out-of-bounds cells.
   */
  setCellData(col: number, row: number, key: string, value: unknown): void {
    if (!this.inBounds(col, row)) return;
    const ci = row * this.width + col;
    const record = this.cellData.get(ci);
    if (value === undefined) {
      if (!record) return;
      delete record[key];
      if (Object.keys(record).length === 0) this.cellData.delete(ci);
      return;
    }
    if (record) {
      record[key] = value;
    } else {
      this.cellData.set(ci, { [key]: value });
    }
  }

  /**
   * Returns the cell's full metadata record, or `undefined` if the cell has
   * none. The record is the live object — treat it as read-only and mutate
   * through {@link setCellData} so sparse-store invariants hold.
   */
  getCellDataRecord(col: number, row: number): Readonly<Record<string, unknown>> | undefined {
    return this.cellData.get(row * this.width + col);
  }

  /** Returns `true` if the cell has any metadata entries. */
  hasCellData(col: number, row: number): boolean {
    return this.cellData.has(row * this.width + col);
  }

  /** Removes all metadata entries for the cell. */
  clearCellData(col: number, row: number): void {
    this.cellData.delete(row * this.width + col);
  }

  // --- Terrain ---

  getTerrain(col: number, row: number): TerrainType {
    return this.uint8[this.index(col, row) + OFFSET_TERRAIN] as TerrainType;
  }

  setTerrain(col: number, row: number, terrain: TerrainType): void {
    const idx = this.index(col, row) + OFFSET_TERRAIN;
    if (this.uint8[idx] !== terrain && this.hasRiver(col, row)) this._riverRevision++;
    this.uint8[idx] = terrain;
  }

  // --- Elevation ---

  getElevation(col: number, row: number): number {
    return this.int8[this.index(col, row) + OFFSET_ELEVATION];
  }

  setElevation(col: number, row: number, elevation: number): void {
    const idx = this.index(col, row) + OFFSET_ELEVATION;
    if (this.int8[idx] !== elevation && this.hasRiver(col, row)) this._riverRevision++;
    this.int8[idx] = elevation;
  }

  // --- River revision ---

  /** See the field doc: changes whenever map-wide river rendering could. */
  get riverRevision(): number {
    return this._riverRevision;
  }

  /** Call after writing river, terrain, or elevation data through the raw arrays. */
  bumpRiverRevision(): void {
    this._riverRevision++;
  }

  // --- Flags ---

  /** Returns the raw flag bitmask for a cell. Use `hasFlag` for individual flag checks. */
  getFlags(col: number, row: number): number {
    return this.uint8[this.index(col, row) + OFFSET_FLAGS];
  }

  /** Sets one or more flag bits on a cell (OR). */
  setFlag(col: number, row: number, flag: number): void {
    this.uint8[this.index(col, row) + OFFSET_FLAGS] |= flag;
  }

  /** Clears one or more flag bits on a cell (AND NOT). */
  clearFlag(col: number, row: number, flag: number): void {
    this.uint8[this.index(col, row) + OFFSET_FLAGS] &= ~flag;
  }

  /** Returns `true` if all bits in `flag` are set on the cell. */
  hasFlag(col: number, row: number, flag: number): boolean {
    return (this.uint8[this.index(col, row) + OFFSET_FLAGS] & flag) !== 0;
  }

  // --- River directions ---
  // Cell byte layout: bits 2-0 = PRIMARY incoming+1, bits 5-3 = outgoing+1, 0 = none.
  // The full set of incoming edges lives in `riverInBits` (one bit per edge),
  // enabling confluences — multiple tributaries entering one cell. The cell
  // byte's incoming bits are maintained as the lowest set incoming edge (the
  // "primary", used where a single flow direction is needed, e.g. estuary UVs).

  private riverByte(col: number, row: number): number {
    return this.uint8[this.index(col, row) + OFFSET_RIVER_DIR];
  }

  /** Re-derive the cell byte's primary incoming bits from the incoming mask. */
  private syncPrimaryIncoming(col: number, row: number): void {
    const mask = this.riverInBits[row * this.width + col];
    let primary = 0; // encoded edge+1, 0 = none
    for (let e = 0; e < 6; e++) {
      if (mask & (1 << e)) { primary = e + 1; break; }
    }
    const idx = this.index(col, row) + OFFSET_RIVER_DIR;
    this.uint8[idx] = (this.uint8[idx] & 0x38) | primary;
  }

  /** Returns `true` if the cell has any river data (incoming or outgoing). */
  hasRiver(col: number, row: number): boolean {
    return this.riverByte(col, row) !== 0 || this.riverInBits[row * this.width + col] !== 0;
  }

  /** Returns `true` if at least one river flows *into* this cell from a neighbour. */
  hasIncomingRiver(col: number, row: number): boolean {
    return this.riverInBits[row * this.width + col] !== 0;
  }

  /** Returns `true` if a river flows *out of* this cell to a neighbour. */
  hasOutgoingRiver(col: number, row: number): boolean {
    return (this.riverByte(col, row) & 0x38) !== 0;
  }

  /** Returns `true` if the cell is a river source or terminus (has exactly one of incoming/outgoing). */
  hasRiverBeginOrEnd(col: number, row: number): boolean {
    return this.hasIncomingRiver(col, row) !== this.hasOutgoingRiver(col, row);
  }

  /**
   * Returns the PRIMARY incoming river edge index (0–5), or -1 if none.
   * With multiple tributaries this is the lowest-indexed incoming edge; use
   * `hasRiverIncomingThroughEdge` / `getIncomingRiverMask` for the full set.
   */
  getIncomingRiverDir(col: number, row: number): number {
    const raw = this.riverByte(col, row) & 0x07;
    return raw === 0 ? -1 : raw - 1;
  }

  /** Returns the outgoing river edge index (0–5), or -1 if none. */
  getOutgoingRiverDir(col: number, row: number): number {
    const raw = (this.riverByte(col, row) >> 3) & 0x07;
    return raw === 0 ? -1 : raw - 1;
  }

  /** Bitmask of ALL incoming river edges (bit e = edge e). */
  getIncomingRiverMask(col: number, row: number): number {
    return this.riverInBits[row * this.width + col];
  }

  /** Returns `true` if a river flows into this cell across the given edge. */
  hasRiverIncomingThroughEdge(col: number, row: number, edgeIndex: number): boolean {
    return (this.riverInBits[row * this.width + col] & (1 << edgeIndex)) !== 0;
  }

  hasRiverThroughEdge(col: number, row: number, edgeIndex: number): boolean {
    if (this.hasRiverIncomingThroughEdge(col, row, edgeIndex)) return true;
    return ((this.riverByte(col, row) >> 3) & 0x07) === edgeIndex + 1;
  }

  /** Set the outgoing river direction for this cell (does NOT update the neighbour). */
  setRiverOutgoing(col: number, row: number, edgeIndex: number): void {
    const idx = this.index(col, row) + OFFSET_RIVER_DIR;
    this.uint8[idx] = (this.uint8[idx] & 0x07) | ((edgeIndex + 1) << 3);
    this._riverRevision++;
  }

  /**
   * ADD an incoming river through the given edge (does NOT update the neighbour).
   * Multiple incoming edges per cell are supported (confluences); adding an
   * edge never disturbs existing ones. The primary incoming direction is kept
   * as the lowest set edge.
   */
  setRiverIncoming(col: number, row: number, edgeIndex: number): void {
    this.riverInBits[row * this.width + col] |= (1 << edgeIndex);
    this.syncPrimaryIncoming(col, row);
    this._riverRevision++;
  }

  /** Remove one incoming river edge, keeping any others (does NOT update the neighbour). */
  removeRiverIncoming(col: number, row: number, edgeIndex: number): void {
    this.riverInBits[row * this.width + col] &= ~(1 << edgeIndex);
    this.syncPrimaryIncoming(col, row);
    this._riverRevision++;
  }

  /** Clear the outgoing river direction, keeping incoming tributaries (does NOT update the neighbour). */
  removeRiverOutgoing(col: number, row: number): void {
    this.uint8[this.index(col, row) + OFFSET_RIVER_DIR] &= 0x07;
    this._riverRevision++;
  }

  /** Clear all river data for this cell. */
  clearRiver(col: number, row: number): void {
    this.uint8[this.index(col, row) + OFFSET_RIVER_DIR] = 0;
    this.riverInBits[row * this.width + col] = 0;
    this._riverRevision++;
  }

  // --- Roads ---
  // One bit per edge direction (0–5) packed into a single byte per cell.

  /** Returns `true` if a road passes through the given edge (0–5) of the cell. */
  hasRoadThroughEdge(col: number, row: number, edgeIndex: number): boolean {
    return (this.roadBits[row * this.width + col] & (1 << edgeIndex)) !== 0;
  }

  /** Returns `true` if the cell has a road on any edge. */
  hasRoads(col: number, row: number): boolean {
    return this.roadBits[row * this.width + col] !== 0;
  }

  /** Set or clear a road through the given edge. Does NOT update the neighbour cell. */
  setRoad(col: number, row: number, edgeIndex: number, state: boolean): void {
    const idx = row * this.width + col;
    if (state) {
      this.roadBits[idx] |= (1 << edgeIndex);
    } else {
      this.roadBits[idx] &= ~(1 << edgeIndex);
    }
  }

  /**
   * The cell on the other side of the given edge, plus that cell's edge index
   * for the shared edge. Returns `null` when the neighbour is off-map.
   * Needs the layout orientation because edge indices are orientation-specific.
   */
  roadEdgeNeighbor(
    col: number,
    row: number,
    edgeIndex: number,
    orientation: HexOrientation,
  ): { col: number; row: number; edge: number } | null {
    const dir = orientation.edgeDirections[edgeIndex];
    const q   = col - (row - (row & 1)) / 2;
    const nq  = q   + HEX_DIRECTIONS[dir].q;
    const nr  = row + HEX_DIRECTIONS[dir].r;
    const nc  = nq  + (nr - (nr & 1)) / 2;
    if (!this.inBounds(nc, nr)) return null;
    const nEdge = orientation.edgeDirections.indexOf((dir + 3) % 6);
    return { col: nc, row: nr, edge: nEdge };
  }

  /**
   * Set or clear a road through an edge on BOTH cells that share it — road
   * rendering requires the half-edges to agree, and keeping that invariant by
   * hand is error-prone. Returns the affected cells (one if the neighbour is
   * off-map) so callers can mark them dirty.
   */
  setRoadEdge(
    col: number,
    row: number,
    edgeIndex: number,
    state: boolean,
    orientation: HexOrientation,
  ): Array<{ col: number; row: number }> {
    this.setRoad(col, row, edgeIndex, state);
    const affected: Array<{ col: number; row: number }> = [{ col, row }];
    const n = this.roadEdgeNeighbor(col, row, edgeIndex, orientation);
    if (n) {
      this.setRoad(n.col, n.row, n.edge, state);
      affected.push({ col: n.col, row: n.row });
    }
    return affected;
  }

  // --- Edit transactions ---

  /**
   * Start a transaction for a multi-event interaction (e.g. a paint stroke):
   * mutate through the returned `MapTransaction` as events arrive, then call
   * `commit()` once to get a replayable {@link MapEdit} for undo/redo.
   * Mutations apply to the map immediately; the transaction only records
   * before/after snapshots of the touched cells.
   */
  beginEdit(): MapTransaction {
    return new MapTransaction(this);
  }

  /**
   * Run a batch of edits as a single undoable unit.
   * Returns a {@link MapEdit}; pass its `cells` to
   * `ChunkManager.markDirtyCells()` and keep it for undo/redo.
   *
   * @example
   * const edit = map.edit(tx => {
   *   tx.setTerrain(4, 4, TerrainType.Water);
   *   tx.setElevation(4, 4, -1);
   * });
   * chunks.markDirtyCells(edit.cells);
   * // later: edit.undo(); chunks.markDirtyCells(edit.cells);
   */
  edit(fn: (tx: MapTransaction) => void): MapEdit {
    const tx = this.beginEdit();
    fn(tx);
    return tx.commit();
  }

  // --- Iteration ---

  /** Iterates over every cell in row-major order, calling `cb(col, row)` for each. */
  forEach(cb: (col: number, row: number) => void): void {
    for (let row = 0; row < this.height; row++) {
      for (let col = 0; col < this.width; col++) {
        cb(col, row);
      }
    }
  }

  // --- Reset ---

  /** Zero out all cell data so the map can be regenerated in place. */
  clear(): void {
    this.uint8.fill(0);
    this.roadBits.fill(0);
    this.riverInBits.fill(0);
    this.featureData?.fill(0);
    this.waterSurfaces.fill(0);
    this.shoreDistances.fill(0);
    this.cellData.clear();
    this._riverRevision++;
  }

  // --- Water surfaces ---

  /**
   * Returns the pre-computed water surface elevation for a cell (elevation index units).
   * Multiply by your `elevScale` to get world-space Y.
   * Returns 0 for non-water cells and before `computeWaterSurfaces` has been called.
   */
  getWaterSurface(col: number, row: number): number {
    return this.waterSurfaces[row * this.width + col];
  }

  /**
   * Hex distance to the nearest land-adjacent cell of the same water body
   * (0 = shore cell, larger = deeper open water, capped at 255).
   * Populated by `computeWaterSurfaces`. Returns 0 for non-water cells.
   */
  getShoreDistance(col: number, row: number): number {
    return this.shoreDistances[row * this.width + col];
  }

  /**
   * BFS flood-fill that finds every connected water body and records its surface
   * elevation in `waterSurfaces` plus each cell's distance-to-shore in
   * `shoreDistances`. The surface is `max(0, maxFloorElevation + 1)`:
   * one step above the highest floor cell, clamped so ocean bodies (floor ≤ −1)
   * always surface at 0. Elevated lakes (floor ≥ 0) surface one step above their floor.
   *
   * Called automatically by `ChunkManager.update()` before any dirty chunk rebuilds,
   * and by generators / deserializers after map data is written. Call it yourself
   * after bulk edits if you need `getWaterSurface` to be accurate before the next
   * `ChunkManager.update()`.
   *
   * @param isWater Predicate that returns `true` for liquid terrain indices.
   *   Defaults to the built-in water terrain (index 5). Pass a custom predicate
   *   when using additional liquid terrain types.
   * @param dirtyRegions When provided, only water bodies intersecting these
   *   cell-coordinate regions are re-flooded; everything else keeps its current
   *   values. Regions MUST extend at least one cell beyond the edited cells so
   *   bodies merely adjacent to an edit are re-seeded (`ChunkManager` passes
   *   its dirty chunk bounds expanded by one). Requires surfaces to have been
   *   fully computed once before.
   */
  computeWaterSurfaces(
    isWater: (terrain: number) => boolean = t => t === TerrainType.Water,
    dirtyRegions?: ReadonlyArray<{ colStart: number; colEnd: number; rowStart: number; rowEnd: number }>,
  ): void {
    const w = this.width, h = this.height;
    const n = w * h;
    const visited = new Uint8Array(n);
    const body    = new Int32Array(n); // cells of the body being flooded
    const queue   = new Int32Array(n); // scratch queue for the shore-distance BFS

    const processBody = (startIdx: number): void => {
      let bTail = 0, bHead = 0;
      body[bTail++] = startIdx;
      visited[startIdx] = 1;
      let maxElev = -128;

      while (bHead < bTail) {
        const ci  = body[bHead++];
        const row = (ci / w) | 0;
        const col = ci % w;
        const elev = this.getElevation(col, row);
        if (elev > maxElev) maxElev = elev;

        const q = col - (row - (row & 1)) / 2;
        for (let d = 0; d < 6; d++) {
          const nq = q   + HEX_DIRECTIONS[d].q;
          const nr = row + HEX_DIRECTIONS[d].r;
          const nc = nq  + (nr - (nr & 1)) / 2;
          if (nc < 0 || nc >= w || nr < 0 || nr >= h) continue;
          const ni = nr * w + nc;
          if (!visited[ni] && isWater(this.getTerrain(nc, nr))) {
            visited[ni] = 1;
            body[bTail++] = ni;
          }
        }
      }

      // Surface is one step above the highest floor cell, clamped to ≥ 0 so that
      // ocean bodies (floor cells at −1 or lower) always sit at sea level (0).
      // Elevated lakes (floor cells at ≥ 0) surface one step above their floor.
      const surfaceElev = Math.max(0, maxElev + 1);
      for (let i = 0; i < bTail; i++) {
        this.waterSurfaces[body[i]] = surfaceElev;
      }

      // Shore distances: multi-source BFS from the body's land-adjacent cells.
      // Bodies are separated by land, so relaxing across liquid neighbors can
      // never leak into another body's values.
      let sHead = 0, sTail = 0;
      for (let i = 0; i < bTail; i++) {
        const ci  = body[i];
        const row = (ci / w) | 0;
        const col = ci % w;
        const q = col - (row - (row & 1)) / 2;
        let landAdjacent = false;
        for (let d = 0; d < 6; d++) {
          const nq = q   + HEX_DIRECTIONS[d].q;
          const nr = row + HEX_DIRECTIONS[d].r;
          const nc = nq  + (nr - (nr & 1)) / 2;
          if (nc < 0 || nc >= w || nr < 0 || nr >= h) continue;
          if (!isWater(this.getTerrain(nc, nr))) { landAdjacent = true; break; }
        }
        if (landAdjacent) {
          this.shoreDistances[ci] = 0;
          queue[sTail++] = ci;
        } else {
          this.shoreDistances[ci] = 255;
        }
      }
      while (sHead < sTail) {
        const ci   = queue[sHead++];
        const next = Math.min(255, this.shoreDistances[ci] + 1);
        const row  = (ci / w) | 0;
        const col  = ci % w;
        const q = col - (row - (row & 1)) / 2;
        for (let d = 0; d < 6; d++) {
          const nq = q   + HEX_DIRECTIONS[d].q;
          const nr = row + HEX_DIRECTIONS[d].r;
          const nc = nq  + (nr - (nr & 1)) / 2;
          if (nc < 0 || nc >= w || nr < 0 || nr >= h) continue;
          const ni = nr * w + nc;
          if (isWater(this.getTerrain(nc, nr)) && this.shoreDistances[ni] > next) {
            this.shoreDistances[ni] = next;
            queue[sTail++] = ni;
          }
        }
      }
    };

    const tryStart = (idx: number): void => {
      if (visited[idx]) return;
      const row = (idx / w) | 0;
      const col = idx % w;
      if (!isWater(this.getTerrain(col, row))) return;
      processBody(idx);
    };

    if (dirtyRegions) {
      for (const rg of dirtyRegions) {
        const c0 = Math.max(0, rg.colStart), c1 = Math.min(w, rg.colEnd);
        const r0 = Math.max(0, rg.rowStart), r1 = Math.min(h, rg.rowEnd);
        for (let row = r0; row < r1; row++) {
          for (let col = c0; col < c1; col++) tryStart(row * w + col);
        }
      }
    } else {
      for (let i = 0; i < n; i++) tryStart(i);
    }
  }

  /**
   * BFS from `(col, row)` that returns all cells in the same connected water body.
   * Returns an empty array if the starting cell is not a water cell.
   * Useful for editor tools that need to paint a whole lake consistently.
   */
  getConnectedWaterBody(
    col: number,
    row: number,
    isWater: (terrain: number) => boolean,
  ): Array<{ col: number; row: number }> {
    if (!this.inBounds(col, row) || !isWater(this.getTerrain(col, row))) return [];

    const w = this.width, h = this.height;
    const visited = new Uint8Array(w * h);
    const result: Array<{ col: number; row: number }> = [];
    const queue: number[] = [];

    const start = row * w + col;
    visited[start] = 1;
    queue.push(start);

    for (let qi = 0; qi < queue.length; qi++) {
      const ci = queue[qi];
      const r  = (ci / w) | 0;
      const c  = ci % w;
      result.push({ col: c, row: r });

      const q = c - (r - (r & 1)) / 2;
      for (let d = 0; d < 6; d++) {
        const nq = q + HEX_DIRECTIONS[d].q;
        const nr = r + HEX_DIRECTIONS[d].r;
        const nc = nq + (nr - (nr & 1)) / 2;
        if (nc < 0 || nc >= w || nr < 0 || nr >= h) continue;
        const ni = nr * w + nc;
        if (!visited[ni] && isWater(this.getTerrain(nc, nr))) {
          visited[ni] = 1;
          queue.push(ni);
        }
      }
    }

    return result;
  }

}
