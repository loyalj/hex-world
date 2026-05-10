export interface HexOrientation {
  // Forward matrix (hex-to-pixel)
  f0: number; f1: number; f2: number; f3: number;
  // Inverse matrix (pixel-to-hex)
  b0: number; b1: number; b2: number; b3: number;
  // Starting angle for corner 0, in multiples of 60°
  startAngle: number;
  /**
   * Maps edge index i (the edge between corner[i] and corner[i+1]) to the
   * HEX_DIRECTIONS index for the neighbor across that edge.
   * Derived by matching each edge's outward-normal angle to a direction vector.
   */
  edgeDirections: readonly number[];
}

// Pointy-top: flat sides on left/right, points at top/bottom
export const POINTY_TOP: HexOrientation = {
  f0: Math.sqrt(3),     f1: Math.sqrt(3) / 2, f2: 0,   f3: 3 / 2,
  b0: Math.sqrt(3) / 3, b1: -1 / 3,           b2: 0,   b3: 2 / 3,
  startAngle: 0.5,
  edgeDirections: [5, 4, 3, 2, 1, 0],
};

// Flat-top: flat sides on top/bottom, points at left/right
export const FLAT_TOP: HexOrientation = {
  f0: 3 / 2,   f1: 0,   f2: Math.sqrt(3) / 2, f3: Math.sqrt(3),
  b0: 2 / 3,   b1: 0,   b2: -1 / 3,           b3: Math.sqrt(3) / 3,
  startAngle: 0,
  edgeDirections: [0, 5, 4, 3, 2, 1],
};
