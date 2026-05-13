/**
 * Cube coordinates: q + r + s === 0 always.
 * s is derived (-q - r) and not stored to save memory.
 */
export interface HexCoord {
  readonly q: number;
  readonly r: number;
}

export function hexCoord(q: number, r: number): HexCoord {
  return { q, r };
}

export function s(h: HexCoord): number {
  return -h.q - h.r;
}

export function hexAdd(a: HexCoord, b: HexCoord): HexCoord {
  return { q: a.q + b.q, r: a.r + b.r };
}

export function hexSubtract(a: HexCoord, b: HexCoord): HexCoord {
  return { q: a.q - b.q, r: a.r - b.r };
}

export function hexScale(h: HexCoord, factor: number): HexCoord {
  return { q: h.q * factor, r: h.r * factor };
}

export function hexLength(h: HexCoord): number {
  return (Math.abs(h.q) + Math.abs(h.r) + Math.abs(s(h))) / 2;
}

export function hexDistance(a: HexCoord, b: HexCoord): number {
  return hexLength(hexSubtract(a, b));
}

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

export function hexNeighbor(h: HexCoord, direction: number): HexCoord {
  return hexAdd(h, HEX_DIRECTIONS[((direction % 6) + 6) % 6]);
}

export function hexNeighbors(h: HexCoord): HexCoord[] {
  return HEX_DIRECTIONS.map(d => hexAdd(h, d));
}

// All hexes within a given radius (inclusive)
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

// Offset coordinate conversions (odd-r offset, pointy-top)
export function offsetToHex(col: number, row: number): HexCoord {
  const q = col - (row - (row & 1)) / 2;
  const r = row;
  return { q, r };
}

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
