import {
  CELL_STRIDE,
  OFFSET_TERRAIN,
  OFFSET_ELEVATION,
  OFFSET_FLAGS,
  OFFSET_RIVER_DIR,
  TerrainType,
} from './HexCell.js';

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
  readonly featureData: Uint8Array | null;

  constructor(options: HexMapOptions) {
    this.width = options.width;
    this.height = options.height;
    this.featureLayerCount = options.featureLayerCount ?? 0;
    const buffer = new ArrayBuffer(this.width * this.height * CELL_STRIDE);
    this.uint8 = new Uint8Array(buffer);
    this.int8 = new Int8Array(buffer);
    this.roadBits = new Uint8Array(this.width * this.height);
    this.featureData = this.featureLayerCount > 0
      ? new Uint8Array(this.width * this.height * this.featureLayerCount)
      : null;

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

  // --- Terrain ---

  getTerrain(col: number, row: number): TerrainType {
    return this.uint8[this.index(col, row) + OFFSET_TERRAIN] as TerrainType;
  }

  setTerrain(col: number, row: number, terrain: TerrainType): void {
    this.uint8[this.index(col, row) + OFFSET_TERRAIN] = terrain;
  }

  // --- Elevation ---

  getElevation(col: number, row: number): number {
    return this.int8[this.index(col, row) + OFFSET_ELEVATION];
  }

  setElevation(col: number, row: number, elevation: number): void {
    this.int8[this.index(col, row) + OFFSET_ELEVATION] = elevation;
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
  // Byte layout: bits 2-0 = incoming+1, bits 5-3 = outgoing+1, 0 = none.

  private riverByte(col: number, row: number): number {
    return this.uint8[this.index(col, row) + OFFSET_RIVER_DIR];
  }

  /** Returns `true` if the cell has any river data (incoming or outgoing). */
  hasRiver(col: number, row: number): boolean {
    return this.riverByte(col, row) !== 0;
  }

  /** Returns `true` if a river flows *into* this cell from a neighbour. */
  hasIncomingRiver(col: number, row: number): boolean {
    return (this.riverByte(col, row) & 0x07) !== 0;
  }

  /** Returns `true` if a river flows *out of* this cell to a neighbour. */
  hasOutgoingRiver(col: number, row: number): boolean {
    return (this.riverByte(col, row) & 0x38) !== 0;
  }

  /** Returns `true` if the cell is a river source or terminus (has exactly one of incoming/outgoing). */
  hasRiverBeginOrEnd(col: number, row: number): boolean {
    const b = this.riverByte(col, row);
    return ((b & 0x07) !== 0) !== ((b & 0x38) !== 0);
  }

  /** Returns the incoming river edge index (0–5), or -1 if none. */
  getIncomingRiverDir(col: number, row: number): number {
    const raw = this.riverByte(col, row) & 0x07;
    return raw === 0 ? -1 : raw - 1;
  }

  /** Returns the outgoing river edge index (0–5), or -1 if none. */
  getOutgoingRiverDir(col: number, row: number): number {
    const raw = (this.riverByte(col, row) >> 3) & 0x07;
    return raw === 0 ? -1 : raw - 1;
  }

  hasRiverThroughEdge(col: number, row: number, edgeIndex: number): boolean {
    const b       = this.riverByte(col, row);
    const encoded = edgeIndex + 1;
    return (b & 0x07) === encoded || ((b >> 3) & 0x07) === encoded;
  }

  /** Set the outgoing river direction for this cell (does NOT update the neighbour). */
  setRiverOutgoing(col: number, row: number, edgeIndex: number): void {
    const idx = this.index(col, row) + OFFSET_RIVER_DIR;
    this.uint8[idx] = (this.uint8[idx] & 0x07) | ((edgeIndex + 1) << 3);
  }

  /** Set the incoming river direction for this cell (does NOT update the neighbour). */
  setRiverIncoming(col: number, row: number, edgeIndex: number): void {
    const idx = this.index(col, row) + OFFSET_RIVER_DIR;
    this.uint8[idx] = (this.uint8[idx] & 0x38) | (edgeIndex + 1);
  }

  /** Clear all river data for this cell. */
  clearRiver(col: number, row: number): void {
    this.uint8[this.index(col, row) + OFFSET_RIVER_DIR] = 0;
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
    this.featureData?.fill(0);
  }

}
