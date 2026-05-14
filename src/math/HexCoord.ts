/**
 * A position in cube (axial) coordinates. The third axis `s = -q - r` is derived
 * and not stored. All hex math functions operate on this type.
 *
 * Convert to/from offset grid coordinates with {@link offsetToHex} / {@link hexToOffset}.
 */
export interface HexCoord {
  readonly q: number;
  readonly r: number;
}

/** Creates a `HexCoord` from axial `q` and `r` components. */
export function hexCoord(q: number, r: number): HexCoord {
  return { q, r };
}

export function s(h: HexCoord): number {
  return -h.q - h.r;
}

/** Returns the vector sum `a + b`. */
export function hexAdd(a: HexCoord, b: HexCoord): HexCoord {
  return { q: a.q + b.q, r: a.r + b.r };
}

/** Returns the vector difference `a - b`. */
export function hexSubtract(a: HexCoord, b: HexCoord): HexCoord {
  return { q: a.q - b.q, r: a.r - b.r };
}

/** Returns `h` scaled by `factor`. */
export function hexScale(h: HexCoord, factor: number): HexCoord {
  return { q: h.q * factor, r: h.r * factor };
}

/** Returns the distance from the origin to `h` in cells (hex Manhattan distance). */
export function hexLength(h: HexCoord): number {
  return (Math.abs(h.q) + Math.abs(h.r) + Math.abs(s(h))) / 2;
}

/** Returns the distance between `a` and `b` in cells (steps along hex edges). */
export function hexDistance(a: HexCoord, b: HexCoord): number {
  return hexLength(hexSubtract(a, b));
}

/** Returns `true` if `a` and `b` refer to the same cell. */
export function hexEquals(a: HexCoord, b: HexCoord): boolean {
  return a.q === b.q && a.r === b.r;
}

// The 6 direction vectors in cube coordinates
export const HEX_DIRECTIONS: readonly HexCoord[] = [
  { q: 1,  r: 0  },
  { q: 1,  r: -1 },
  { q: 0,  r: -1 },
  { q: -1, r: 0  },
  { q: -1, r: 1  },
  { q: 0,  r: 1  },
];

/** Returns the neighbour of `h` in the given direction (0–5, clockwise from East). */
export function hexNeighbor(h: HexCoord, direction: number): HexCoord {
  return hexAdd(h, HEX_DIRECTIONS[((direction % 6) + 6) % 6]);
}

/** Returns all 6 neighbours of `h`. */
export function hexNeighbors(h: HexCoord): HexCoord[] {
  return HEX_DIRECTIONS.map(d => hexAdd(h, d));
}

/**
 * Returns all cells within `radius` steps of `center` (inclusive).
 * The center cell is always included (at radius 0).
 * Result count: `3 * radius * (radius + 1) + 1`.
 */
export function hexRange(center: HexCoord, radius: number): HexCoord[] {
  const results: HexCoord[] = [];
  for (let q = -radius; q <= radius; q++) {
    const rMin = Math.max(-radius, -q - radius);
    const rMax = Math.min(radius, -q + radius);
    for (let r = rMin; r <= rMax; r++) {
      results.push({ q: center.q + q, r: center.r + r });
    }
  }
  return results;
}

/**
 * Converts offset (col, row) grid coordinates to cube coordinates.
 * Uses odd-row offset layout (pointy-top hexes).
 */
export function offsetToHex(col: number, row: number): HexCoord {
  const q = col - (row - (row & 1)) / 2;
  const r = row;
  return { q, r };
}

/**
 * Converts cube coordinates back to offset (col, row) grid coordinates.
 * Uses odd-row offset layout (pointy-top hexes).
 */
export function hexToOffset(h: HexCoord): { col: number; row: number } {
  const col = h.q + (h.r - (h.r & 1)) / 2;
  const row = h.r;
  return { col, row };
}

// Round fractional cube coordinates to nearest hex
export function hexRound(q: number, r: number): HexCoord {
  let rq = Math.round(q);
  let rr = Math.round(r);
  let rs = Math.round(-q - r);

  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - (-q - r));

  if (dq > dr && dq > ds) {
    rq = -rr - rs;
  } else if (dr > ds) {
    rr = -rq - rs;
  }

  return { q: rq, r: rr };
}

// Linear interpolation between two hexes (for line drawing)
export function hexLerp(a: HexCoord, b: HexCoord, t: number): { q: number; r: number } {
  return {
    q: a.q + (b.q - a.q) * t,
    r: a.r + (b.r - a.r) * t,
  };
}

/**
 * Returns all cells on the straight line from `a` to `b`, inclusive.
 * Uses fractional hex lerp + rounding, so the result follows the natural hex grid line.
 * Result length: `hexDistance(a, b) + 1`.
 */
export function hexLine(a: HexCoord, b: HexCoord): HexCoord[] {
  const n = hexDistance(a, b);
  const results: HexCoord[] = [];
  for (let i = 0; i <= n; i++) {
    const frac = hexLerp(a, b, i / n);
    results.push(hexRound(frac.q, frac.r));
  }
  return results;
}

/** Returns the offset {col, row} of the neighbour of (col, row) in the given direction (0–5). */
export function offsetNeighbor(col: number, row: number, direction: number): { col: number; row: number } {
  return hexToOffset(hexNeighbor(offsetToHex(col, row), direction));
}
