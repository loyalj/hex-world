import type { HexCoord } from './HexCoord.js';
import type { HexOrientation } from './HexOrientation.js';
import { hexRound } from './HexCoord.js';

export interface HexLayout {
  orientation: HexOrientation;
  /** Hex radius in world units (center to corner) */
  size: number;
  /** World-space origin offset */
  originX: number;
  originZ: number;
}

export function createLayout(
  orientation: HexOrientation,
  size: number,
  originX = 0,
  originZ = 0,
): HexLayout {
  return { orientation, size, originX, originZ };
}

/** Returns world-space (x, z) center of a hex */
export function hexToWorld(layout: HexLayout, h: HexCoord): { x: number; z: number } {
  const { f0, f1, f2, f3 } = layout.orientation;
  const x = (f0 * h.q + f1 * h.r) * layout.size + layout.originX;
  const z = (f2 * h.q + f3 * h.r) * layout.size + layout.originZ;
  return { x, z };
}

/** Returns world-space (x, z) position of a specific corner (0–5) of a hex */
export function hexCorner(layout: HexLayout, h: HexCoord, corner: number): { x: number; z: number } {
  const center = hexToWorld(layout, h);
  const angle = (2 * Math.PI * (layout.orientation.startAngle + corner)) / 6;
  return {
    x: center.x + layout.size * Math.cos(angle),
    z: center.z + layout.size * Math.sin(angle),
  };
}

/** Returns all 6 corner positions for a hex */
export function hexCorners(layout: HexLayout, h: HexCoord): Array<{ x: number; z: number }> {
  return Array.from({ length: 6 }, (_, i) => hexCorner(layout, h, i));
}

/** Converts a world-space (x, z) point to fractional hex coordinates, then rounds */
export function worldToHex(layout: HexLayout, x: number, z: number): HexCoord {
  const { b0, b1, b2, b3 } = layout.orientation;
  const px = (x - layout.originX) / layout.size;
  const pz = (z - layout.originZ) / layout.size;
  const q = b0 * px + b1 * pz;
  const r = b2 * px + b3 * pz;
  return hexRound(q, r);
}
