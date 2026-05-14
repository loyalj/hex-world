/**
 * Built-in terrain types stored as `Uint8` values (0–5).
 * Values 6–255 are available for custom terrain — supply a shader that handles them.
 */
export const enum TerrainType {
  Grassland = 0,
  Desert    = 1,
  Snow      = 2,
  Mud       = 3,
  Rock      = 4,
  Water     = 5,
}

/** Byte offsets within the per-cell data block */
export const CELL_STRIDE = 4; // bytes per cell

export const OFFSET_TERRAIN   = 0; // Uint8
export const OFFSET_ELEVATION = 1; // Int8  (-128..127)
export const OFFSET_FLAGS     = 2; // Uint8 (bitmask)
/**
 * Packed river directions (both fit in one byte).
 *   bits 2-0 = incoming edge index + 1  (0 = no incoming, 1-6 = edge 0-5)
 *   bits 5-3 = outgoing edge index + 1  (0 = no outgoing, 1-6 = edge 0-5)
 *   bits 7-6 = unused
 * Default value 0x00 → no river (matches zero-initialised ArrayBuffer).
 */
export const OFFSET_RIVER_DIR = 3; // Uint8 packed

export const FLAG_ROAD   = 0b00000010;
export const FLAG_WALL   = 0b00000100;
export const FLAG_WATER  = 0b00001000;

/** Y offset (in elevation steps) for the stream-bed surface — Part 6 tutorial constant. */
export const STREAM_BED_ELEVATION_OFFSET    = -1.75;
/** Y offset (in elevation steps) for the river water surface — Part 6 tutorial constant. */
export const RIVER_SURFACE_ELEVATION_OFFSET = -0.5;
