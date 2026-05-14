import type { HexCoord } from './HexCoord.js';
import type { HexOrientation } from './HexOrientation.js';
import { hexRound } from './HexCoord.js';

/**
 * Defines how hex coordinates map to world space.
 * Create one with {@link createLayout} and pass it to all geometry and picking functions.
 */
export interface HexLayout {
  orientation: HexOrientation;
  /** Hex radius in world units (center to corner). */
  size: number;
  /** World-space X origin offset. */
  originX: number;
  /** World-space Z origin offset. */
  originZ: number;
}

/**
 * Creates a `HexLayout` that maps cube coordinates to world space.
 *
 * @param orientation - `POINTY_TOP` or `FLAT_TOP` from `HexOrientation`.
 * @param size        - Hex radius in world units (center to corner).
 * @param originX     - World-space X offset of the grid origin. Default 0.
 * @param originZ     - World-space Z offset of the grid origin. Default 0.
 *
 * @example
 * const layout = createLayout(POINTY_TOP, 1);
 */
export function createLayout(
  orientation: HexOrientation,
  size: number,
  originX = 0,
  originZ = 0,
): HexLayout {
  return { orientation, size, originX, originZ };
}

/**
 * Returns the world-space (x, z) center of a hex cell.
 * Y is always 0 — add terrain elevation separately.
 */
export function hexToWorld(layout: HexLayout, h: HexCoord): { x: number; z: number } {
  const { f0, f1, f2, f3 } = layout.orientation;
  const x = (f0 * h.q + f1 * h.r) * layout.size + layout.originX;
  const z = (f2 * h.q + f3 * h.r) * layout.size + layout.originZ;
  return { x, z };
}

/**
 * Returns the world-space (x, z) position of a specific corner (0–5) of a hex.
 * Corner 0 is at the East (or North-East for pointy-top) and indices increase clockwise.
 */
export function hexCorner(layout: HexLayout, h: HexCoord, corner: number): { x: number; z: number } {
  const center = hexToWorld(layout, h);
  const angle = (2 * Math.PI * (layout.orientation.startAngle + corner)) / 6;
  return {
    x: center.x + layout.size * Math.cos(angle),
    z: center.z + layout.size * Math.sin(angle),
  };
}

/** Returns all 6 corner positions of a hex in world space (x, z). */
export function hexCorners(layout: HexLayout, h: HexCoord): Array<{ x: number; z: number }> {
  return Array.from({ length: 6 }, (_, i) => hexCorner(layout, h, i));
}

/**
 * Converts a world-space (x, z) point to the nearest hex cell.
 * Useful for cursor-to-hex picking on a flat map; for elevated terrain prefer
 * `pickHexFromMeshes` which raycasts the actual geometry.
 */
export function worldToHex(layout: HexLayout, x: number, z: number): HexCoord {
  const { b0, b1, b2, b3 } = layout.orientation;
  const px = (x - layout.originX) / layout.size;
  const pz = (z - layout.originZ) / layout.size;
  const q = b0 * px + b1 * pz;
  const r = b2 * px + b3 * pz;
  return hexRound(q, r);
}
