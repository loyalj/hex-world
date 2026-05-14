/**
 * Smooth 2D value noise with 4 independent channels, mimicking the tiling
 * Perlin noise texture used in the Catlike Coding tutorial (Part 4).
 * Each channel returns a value in [0, 1].
 *
 * Scale world coordinates by noiseScale before passing:
 *   sampleNoise(worldX * noiseScale, worldZ * noiseScale)
 */

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

function hash(ix: number, iz: number, ch: number): number {
  const n = Math.sin(ix * 127.1 + iz * 311.7 + ch * 74.3) * 43758.5453123;
  return n - Math.floor(n);
}

/**
 * Fractal Brownian Motion over sampleNoise. Returns a value in roughly [-1, 1].
 * Each octave uses a different noise channel to avoid harmonic correlation.
 * startScale: world-space period of the first (largest) octave in cells.
 */
export function fbm(x: number, z: number, octaves: number): number {
  let value    = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxValue  = 0;
  for (let i = 0; i < octaves; i++) {
    const n = sampleNoise(x * frequency, z * frequency);
    value    += (n[i % 4] * 2 - 1) * amplitude;
    maxValue += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / maxValue;
}

/**
 * Samples smooth 2D value noise at (x, z) and returns four independent channels,
 * each in [0, 1]. Scale coordinates by a noise frequency before passing:
 * `sampleNoise(worldX * 0.05, worldZ * 0.05)`.
 *
 * Channels are used separately by the terrain builder for XZ perturbation (channels
 * 0–1), per-cell Y offset (channel 2), and texture blend weights (channel 3).
 */
export function sampleNoise(x: number, z: number): [number, number, number, number] {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const ux = fade(x - ix);
  const uz = fade(z - iz);

  const result: [number, number, number, number] = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const n00 = hash(ix,     iz,     c);
    const n10 = hash(ix + 1, iz,     c);
    const n01 = hash(ix,     iz + 1, c);
    const n11 = hash(ix + 1, iz + 1, c);
    result[c] = n00 + (n10 - n00) * ux + (n01 - n00) * uz + (n00 - n10 - n01 + n11) * ux * uz;
  }
  return result;
}
