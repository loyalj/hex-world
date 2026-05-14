/**
 * Five independent pseudo-random values in [0, 1) for a world-space position.
 * Used by the scatter system to decide whether to place a feature and which
 * variant/tier to pick. Each channel is uncorrelated from the others.
 */
export interface HexHash {
  a: number; b: number; c: number; d: number; e: number;
}

/**
 * Deterministic per-position hash sampler.
 *
 * Positions are quantized to 1/8 world-unit cells before hashing, which is
 * fine enough that every scatter slot gets a unique hash (minimum slot spacing
 * is ~0.58 world units) while remaining fully stable across chunk boundaries.
 *
 * Replaces the old 256×256 pre-allocated grid, which quantized at 4 world
 * units and produced visible checkerboard block patterns in scatter placement.
 */
export class HexHashGrid {
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  /**
   * Returns five independent hash values for the given world-space position.
   * Results are stable across frames and chunk boundaries — the same (x, z)
   * always produces the same hash for a given seed.
   */
  sample(worldX: number, worldZ: number): HexHash {
    const xi = Math.floor(worldX * 8) | 0;
    const zi = Math.floor(worldZ * 8) | 0;
    return {
      a: this._hash(xi, zi, 0),
      b: this._hash(xi, zi, 1),
      c: this._hash(xi, zi, 2),
      d: this._hash(xi, zi, 3),
      e: this._hash(xi, zi, 4),
    };
  }

  private _hash(x: number, z: number, channel: number): number {
    let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(this.seed ^ (channel * 2246822519 | 0), 2654435761)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
}
