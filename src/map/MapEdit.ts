import type { HexMap } from './HexMap.js';
import type { HexOrientation } from '../math/HexOrientation.js';
import type { TerrainType } from './HexCell.js';
import { CELL_STRIDE } from './HexCell.js';

/**
 * Byte snapshot of one cell across every mutable channel:
 * `[terrain, elevation, flags, riverDir, roadBits, riverInBits, ...featureLevels]`.
 * Derived data (water surfaces, shore distances) is intentionally excluded —
 * `ChunkManager.update()` recomputes it for dirty regions.
 */
type CellSnapshot = Uint8Array;

interface CellRecord {
  col: number;
  row: number;
  before: CellSnapshot;
  after: CellSnapshot | null; // captured at commit()
}

function snapshotCell(map: HexMap, col: number, row: number): CellSnapshot {
  const layers = map.featureLayerCount;
  const ci   = row * map.width + col;
  const snap = new Uint8Array(CELL_STRIDE + 2 + layers);
  snap.set(map.uint8.subarray(ci * CELL_STRIDE, (ci + 1) * CELL_STRIDE), 0);
  snap[CELL_STRIDE]     = map.roadBits[ci];
  snap[CELL_STRIDE + 1] = map.riverInBits[ci];
  if (map.featureData && layers > 0) {
    snap.set(map.featureData.subarray(ci * layers, (ci + 1) * layers), CELL_STRIDE + 2);
  }
  return snap;
}

function restoreCell(map: HexMap, col: number, row: number, snap: CellSnapshot): void {
  const layers = map.featureLayerCount;
  const ci = row * map.width + col;
  map.uint8.set(snap.subarray(0, CELL_STRIDE), ci * CELL_STRIDE);
  map.roadBits[ci]    = snap[CELL_STRIDE];
  map.riverInBits[ci] = snap[CELL_STRIDE + 1];
  if (map.featureData && layers > 0) {
    map.featureData.set(snap.subarray(CELL_STRIDE + 2, CELL_STRIDE + 2 + layers), ci * layers);
  }
}

/**
 * The result of a committed map transaction: the set of touched cells with
 * before/after snapshots, replayable in either direction.
 *
 * Feed {@link cells} to `ChunkManager.markDirtyCells()` after `undo()`/`redo()`
 * so the affected geometry rebuilds. This is the building block for
 * editor-style undo/redo — one `MapEdit` per user action.
 */
export class MapEdit {
  private readonly map: HexMap;
  private readonly records: CellRecord[];
  /** Every cell this edit touched (whether or not its value actually changed). */
  readonly cells: ReadonlyArray<{ col: number; row: number }>;

  constructor(map: HexMap, records: CellRecord[]) {
    this.map     = map;
    this.records = records;
    this.cells   = records.map(r => ({ col: r.col, row: r.row }));
  }

  get isEmpty(): boolean { return this.records.length === 0; }

  /** Restore every touched cell to its pre-transaction state. */
  undo(): void {
    for (const r of this.records) restoreCell(this.map, r.col, r.row, r.before);
  }

  /** Re-apply the transaction's final state to every touched cell. */
  redo(): void {
    for (const r of this.records) restoreCell(this.map, r.col, r.row, r.after!);
  }
}

/**
 * Records before-state for every cell it mutates, so the whole batch can be
 * undone/redone as one unit. Create with `map.beginEdit()` (long-lived, e.g. a
 * paint stroke spanning many pointer events) or `map.edit(tx => …)` (one-shot).
 *
 * Mutations apply to the map immediately — there is no deferred apply — and
 * the first write to each cell snapshots all of that cell's channels first.
 * Call {@link commit} exactly once when the interaction ends.
 */
export class MapTransaction {
  private readonly map: HexMap;
  private readonly records = new Map<number, CellRecord>();
  private committed = false;

  constructor(map: HexMap) {
    this.map = map;
  }

  private guard(): void {
    if (this.committed) throw new Error('MapTransaction already committed');
  }

  /**
   * Snapshot a cell before mutation (no-op if already touched or out of
   * bounds). Called automatically by every setter; call it directly only when
   * mutating the map through APIs the transaction doesn't wrap.
   */
  touch(col: number, row: number): void {
    this.guard();
    if (!this.map.inBounds(col, row)) return;
    const key = row * this.map.width + col;
    if (this.records.has(key)) return;
    this.records.set(key, { col, row, before: snapshotCell(this.map, col, row), after: null });
  }

  setTerrain(col: number, row: number, terrain: TerrainType): void {
    this.touch(col, row);
    this.map.setTerrain(col, row, terrain);
  }

  setElevation(col: number, row: number, elevation: number): void {
    this.touch(col, row);
    this.map.setElevation(col, row, elevation);
  }

  setFlag(col: number, row: number, flag: number): void {
    this.touch(col, row);
    this.map.setFlag(col, row, flag);
  }

  clearFlag(col: number, row: number, flag: number): void {
    this.touch(col, row);
    this.map.clearFlag(col, row, flag);
  }

  setFeatureLevel(col: number, row: number, layer: number, value: number): void {
    this.touch(col, row);
    this.map.setFeatureLevel(col, row, layer, value);
  }

  setRoad(col: number, row: number, edgeIndex: number, state: boolean): void {
    this.touch(col, row);
    this.map.setRoad(col, row, edgeIndex, state);
  }

  /** Paired road-edge write — see `HexMap.setRoadEdge`. Touches both cells. */
  setRoadEdge(col: number, row: number, edgeIndex: number, state: boolean, orientation: HexOrientation): Array<{ col: number; row: number }> {
    this.touch(col, row);
    const n = this.map.roadEdgeNeighbor(col, row, edgeIndex, orientation);
    if (n) this.touch(n.col, n.row);
    return this.map.setRoadEdge(col, row, edgeIndex, state, orientation);
  }

  setRiverIncoming(col: number, row: number, edgeIndex: number): void {
    this.touch(col, row);
    this.map.setRiverIncoming(col, row, edgeIndex);
  }

  setRiverOutgoing(col: number, row: number, edgeIndex: number): void {
    this.touch(col, row);
    this.map.setRiverOutgoing(col, row, edgeIndex);
  }

  removeRiverIncoming(col: number, row: number, edgeIndex: number): void {
    this.touch(col, row);
    this.map.removeRiverIncoming(col, row, edgeIndex);
  }

  removeRiverOutgoing(col: number, row: number): void {
    this.touch(col, row);
    this.map.removeRiverOutgoing(col, row);
  }

  clearRiver(col: number, row: number): void {
    this.touch(col, row);
    this.map.clearRiver(col, row);
  }

  /** Number of cells touched so far. */
  get size(): number { return this.records.size; }

  /**
   * Capture after-state for every touched cell and return the finished
   * {@link MapEdit}. The transaction cannot be used afterwards.
   */
  commit(): MapEdit {
    this.guard();
    this.committed = true;
    const records = [...this.records.values()];
    for (const r of records) r.after = snapshotCell(this.map, r.col, r.row);
    return new MapEdit(this.map, records);
  }
}
