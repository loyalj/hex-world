/**
 * Built-in terrain types stored as `Uint8` values (0–5).
 * Values 6–255 are available for custom terrain — supply a shader that handles them.
 */
export const TerrainType = {
  Grassland: 0,
  Desert:    1,
  Snow:      2,
  Mud:       3,
  Rock:      4,
  Water:     5,
} as const;

// Named values union, widened to accept custom terrain (6–255) while keeping
// autocomplete for the built-in members.
export type TerrainType = typeof TerrainType[keyof typeof TerrainType] | (number & {});

/** Byte offsets within the per-cell data block */
export const CELL_STRIDE = 4; // bytes per cell

export const OFFSET_TERRAIN   = 0; // Uint8
export const OFFSET_ELEVATION = 1; // Int8  (-128..127)
export const OFFSET_FLAGS     = 2; // Uint8 (bitmask)
/**
 * Packed river directions (both fit in one byte).
 *   bits 2-0 = PRIMARY incoming edge index + 1 (0 = none, 1-6 = edge 0-5)
 *   bits 5-3 = outgoing edge index + 1         (0 = none, 1-6 = edge 0-5)
 *   bits 7-6 = unused
 * Default value 0x00 → no river (matches zero-initialised ArrayBuffer).
 * The FULL set of incoming edges (confluences) lives in HexMap.riverInBits;
 * the primary here is maintained as the lowest set incoming edge.
 */
export const OFFSET_RIVER_DIR = 3; // Uint8 packed

export const FLAG_ROAD   = 0b00000010;
export const FLAG_WALL   = 0b00000100;
export const FLAG_WATER  = 0b00001000;

/**
 * Default world-space Y units per elevation step. Single source of truth shared
 * by terrain geometry, water builders, scatter placement, units, and
 * line-of-sight so they all agree on cell heights. Systems that accept an
 * `elevationScale` option default to this — if you override it anywhere,
 * override it everywhere.
 */
export const ELEVATION_SCALE = 0.5;

/** Y offset (in elevation steps) for the stream-bed surface — Part 6 tutorial constant. */
export const STREAM_BED_ELEVATION_OFFSET    = -1.75;
/** Y offset (in elevation steps) for the river water surface — Part 6 tutorial constant. */
export const RIVER_SURFACE_ELEVATION_OFFSET = -0.5;
