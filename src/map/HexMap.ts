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

  readonly uint8: Uint8Array;
  private readonly int8: Int8Array;

  constructor(options: HexMapOptions) {
    this.width = options.width;
    this.height = options.height;
    const buffer = new ArrayBuffer(this.width * this.height * CELL_STRIDE);
    this.uint8 = new Uint8Array(buffer);
    this.int8 = new Int8Array(buffer);

    if (options.defaultTerrain !== undefined && options.defaultTerrain !== TerrainType.Grassland) {
      for (let i = 0; i < this.width * this.height; i++) {
        this.uint8[i * CELL_STRIDE + OFFSET_TERRAIN] = options.defaultTerrain;
      }
    }
  }

  get cellCount(): number {
    return this.width * this.height;
  }

  inBounds(col: number, row: number): boolean {
    return col >= 0 && col < this.width && row >= 0 && row < this.height;
  }

  private index(col: number, row: number): number {
    return (row * this.width + col) * CELL_STRIDE;
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

  getFlags(col: number, row: number): number {
    return this.uint8[this.index(col, row) + OFFSET_FLAGS];
  }

  setFlag(col: number, row: number, flag: number): void {
    this.uint8[this.index(col, row) + OFFSET_FLAGS] |= flag;
  }

  clearFlag(col: number, row: number, flag: number): void {
    this.uint8[this.index(col, row) + OFFSET_FLAGS] &= ~flag;
  }

  hasFlag(col: number, row: number, flag: number): boolean {
    return (this.uint8[this.index(col, row) + OFFSET_FLAGS] & flag) !== 0;
  }

  // --- River directions ---
  // Byte layout: bits 2-0 = incoming+1, bits 5-3 = outgoing+1, 0 = none.

  private riverByte(col: number, row: number): number {
    return this.uint8[this.index(col, row) + OFFSET_RIVER_DIR];
  }

  hasRiver(col: number, row: number): boolean {
    return this.riverByte(col, row) !== 0;
  }

  hasIncomingRiver(col: number, row: number): boolean {
    return (this.riverByte(col, row) & 0x07) !== 0;
  }

  hasOutgoingRiver(col: number, row: number): boolean {
    return (this.riverByte(col, row) & 0x38) !== 0;
  }

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

  // --- Iteration ---

  forEach(cb: (col: number, row: number) => void): void {
    for (let row = 0; row < this.height; row++) {
      for (let col = 0; col < this.width; col++) {
        cb(col, row);
      }
    }
  }

  // --- Serialization ---

  toBuffer(): Uint8Array {
    return this.uint8.slice(0);
  }

  static fromBuffer(data: Uint8Array, width: number, height: number): HexMap {
    const map = new HexMap({ width, height });
    map.uint8.set(data);
    return map;
  }
}
