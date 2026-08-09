import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  createTerrainMaterial, configureCliffStrata, setCliffStrataEnabled,
} from '../src/geometry/TerrainMaterial.js';

function makeMaterial(opts = {}): THREE.ShaderMaterial {
  const tex = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
  return createTerrainMaterial(tex, opts);
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** JS mirror of the shader's tHash. */
const tHash = (x: number, y: number): number => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * JS mirror of `cliffStrata`, minus the derivative-driven terms (`fwidth` has
 * no meaning off the GPU): returns the multiplier the shader applies to the
 * surface color at a point, given the uniform values.
 *
 * `phaseOverride` stands in for where inside a bed the sample lands when a test
 * wants to look at a seam rather than at a bed's body.
 */
function strataFactor(
  u: Record<string, { value: any }>,
  base: [number, number, number],
  upness: number,
  world: [number, number, number],
  warpNoise = 0.5,
): [number, number, number] {
  const face = 1 - smoothstep(0, Math.max(u.uStrataSlope.value, 1e-4), upness);
  if (face <= 0) return base;

  const green = (base[1] - Math.max(base[0], base[2])) / Math.max(base[1], 1e-4);
  const rock  = 1 + (1 - smoothstep(0.02, 0.20, green) - 1) * u.uStrataRockOnly.value;
  if (rock <= 0) return base;

  const [wx, wy, wz] = world;
  const h = wy
    + (wx * 0.83 + wz * 0.55) * u.uStrataTilt.value
    + (warpNoise - 0.5) * 2 * u.uStrataWarp.value;

  let b = h * u.uStrataScale.value;
  b += Math.sin(b * 1.7) * 0.22 + Math.sin(b * 0.63) * 0.35;

  const idx    = Math.floor(b);
  const phase  = b - idx;
  const pale   = tHash(idx, 11.3);
  const warmth = tHash(idx, 47.9);

  const tint = u.uStrataTint.value as THREE.Color;
  const bed  = base.map(ch => ch * (1 + (pale - 0.5) * 2 * u.uStrataContrast.value)) as [number, number, number];
  const rgb  = [tint.r, tint.g, tint.b];
  for (let i = 0; i < 3; i++) bed[i] = bed[i] * (1 - warmth) + bed[i] * rgb[i] * warmth;

  // Hairline seam floor (max(px * 1.2, 0.03) with px → 0 up close).
  const seam = u.uStrataSeam.value * (1 - smoothstep(0, 0.03, Math.min(phase, 1 - phase)));
  for (let i = 0; i < 3; i++) bed[i] *= 1 - seam;

  const amt = Math.min(1, Math.max(0, u.uStrataStrength.value * face * rock));
  return base.map((ch, i) => ch * (1 - amt) + bed[i] * amt) as [number, number, number];
}

const ROCK: [number, number, number] = [0.55, 0.52, 0.48];
const GRASS: [number, number, number] = [0.32, 0.55, 0.24];

/** How far a factor strays from leaving the base untouched. */
const deviation = (a: [number, number, number], b: [number, number, number]): number =>
  Math.max(...a.map((ch, i) => Math.abs(ch - b[i])));

describe('cliff strata', () => {
  it('is on out of the box, with every uniform present', () => {
    const mat = makeMaterial();
    expect(mat.uniforms.uStrataEnabled.value).toBe(1);
    for (const name of ['uStrataStrength', 'uStrataScale', 'uStrataContrast', 'uStrataSeam',
                        'uStrataWarp', 'uStrataTilt', 'uStrataTint', 'uStrataSlope',
                        'uStrataRockOnly']) {
      expect(mat.uniforms[name]).toBeDefined();
    }
  });

  it('configureCliffStrata applies styling and enables; setCliffStrataEnabled toggles', () => {
    const mat = makeMaterial();
    configureCliffStrata(mat, {
      enabled: false, strength: 0.5, scale: 5, contrast: 0.3, seam: 0.4,
      warp: 0.2, tilt: 0.1, tint: 0xff0000, slope: 0.4, rockOnly: 0,
    });
    expect(mat.uniforms.uStrataEnabled.value).toBe(0);
    expect(mat.uniforms.uStrataStrength.value).toBe(0.5);
    expect(mat.uniforms.uStrataScale.value).toBe(5);
    expect(mat.uniforms.uStrataContrast.value).toBe(0.3);
    expect(mat.uniforms.uStrataSeam.value).toBe(0.4);
    expect(mat.uniforms.uStrataWarp.value).toBe(0.2);
    expect(mat.uniforms.uStrataTilt.value).toBe(0.1);
    expect(mat.uniforms.uStrataSlope.value).toBe(0.4);
    expect(mat.uniforms.uStrataRockOnly.value).toBe(0);
    expect((mat.uniforms.uStrataTint.value as THREE.Color).getHex()).toBe(0xff0000);

    setCliffStrataEnabled(mat, true);
    expect(mat.uniforms.uStrataEnabled.value).toBe(1);
    setCliffStrataEnabled(mat, false);
    expect(mat.uniforms.uStrataEnabled.value).toBe(0);

    // A restyle with no `enabled` turns it back on, like the grid's.
    configureCliffStrata(mat, { seam: 0.1 });
    expect(mat.uniforms.uStrataEnabled.value).toBe(1);
  });

  it('takes styling at construction, and defaults triplanar sharpness to the old constant', () => {
    const plain = makeMaterial();
    expect(plain.uniforms.uTriplanarSharpness.value).toBe(8);

    const styled = makeMaterial({ triplanarSharpness: 4, strata: { scale: 6, enabled: false } });
    expect(styled.uniforms.uTriplanarSharpness.value).toBe(4);
    expect(styled.uniforms.uStrataScale.value).toBe(6);
    expect(styled.uniforms.uStrataEnabled.value).toBe(0);

    // pow(0, 0) on an axis-aligned face is undefined — NaN pixels, not a soft blend.
    expect(makeMaterial({ triplanarSharpness: 0 }).uniforms.uTriplanarSharpness.value).toBe(1);
  });

  it('configure calls are no-ops on a material without the uniforms', () => {
    const bare = new THREE.ShaderMaterial({ uniforms: {} });
    expect(() => configureCliffStrata(bare, { scale: 2 })).not.toThrow();
    expect(() => setCliffStrataEnabled(bare, true)).not.toThrow();
    expect(bare.uniforms.uStrataEnabled).toBeUndefined();
  });

  describe('band math', () => {
    it('leaves flat ground untouched and reaches full strength on a vertical face', () => {
      const u = makeMaterial().uniforms;
      // upness 1 (flat) and upness at the slope cutoff both fall outside.
      expect(strataFactor(u, ROCK, 1, [3, 2, 4])).toEqual(ROCK);
      expect(strataFactor(u, ROCK, u.uStrataSlope.value, [3, 2, 4])).toEqual(ROCK);
      // A wall bands.
      expect(deviation(strataFactor(u, ROCK, 0, [3, 2, 4]), ROCK)).toBeGreaterThan(0.005);
    });

    it('fades in as the ground steepens rather than switching on', () => {
      const u = makeMaterial().uniforms;
      const at = (upness: number) => deviation(strataFactor(u, ROCK, upness, [3, 2.37, 4]), ROCK);
      const steps = [0.6, 0.45, 0.3, 0.15, 0].map(at);
      for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1]);
    });

    it('leaves living green alone while rockOnly is on, and bands it once off', () => {
      const mat = makeMaterial();
      expect(strataFactor(mat.uniforms, GRASS, 0, [3, 2, 4])).toEqual(GRASS);

      configureCliffStrata(mat, { rockOnly: 0 });
      expect(deviation(strataFactor(mat.uniforms, GRASS, 0, [3, 2, 4]), GRASS)).toBeGreaterThan(0.005);
    });

    it('the bent band coordinate stays monotonic in height — no mirrored bed', () => {
      // A fold would make floor() run backwards and repeat a bed upside down.
      const bend = (b: number) => b + Math.sin(b * 1.7) * 0.22 + Math.sin(b * 0.63) * 0.35;
      let prev = bend(-40);
      for (let b = -40; b <= 40; b += 0.01) {
        const cur = bend(b);
        expect(cur).toBeGreaterThanOrEqual(prev);
        prev = cur;
      }
    });

    it('bands vary in value from one to the next, and repeat with height rather than randomly', () => {
      const u = makeMaterial().uniforms;
      // Sample straight up a wall face: the value must not be constant.
      const values: number[] = [];
      for (let y = 0; y < 3; y += 0.05) values.push(strataFactor(u, ROCK, 0, [0, y, 0])[0]);
      const spread = Math.max(...values) - Math.min(...values);
      expect(spread).toBeGreaterThan(0.02);

      // Deterministic: the same point gives the same band twice.
      expect(strataFactor(u, ROCK, 0, [0, 1.234, 0]))
        .toEqual(strataFactor(u, ROCK, 0, [0, 1.234, 0]));
    });

    it('the seam is a thin dark line, not half the bed', () => {
      const u = makeMaterial().uniforms;
      // Walk a full bed's worth of height and count how much of it reads darker
      // than the bed body — the hairline seam must be a small fraction of it.
      const scale = u.uStrataScale.value;
      const samples: number[] = [];
      for (let i = 0; i < 400; i++) samples.push(strataFactor(u, ROCK, 0, [0, i / (400 * scale), 0])[0]);
      const median = [...samples].sort((a, b) => a - b)[samples.length >> 1];
      const dark   = samples.filter(v => v < median * 0.9).length / samples.length;
      expect(dark).toBeGreaterThan(0);
      expect(dark).toBeLessThan(0.25);
    });

    it('tilt and warp move the beds off level', () => {
      const level = makeMaterial();
      configureCliffStrata(level, { warp: 0, tilt: 0 });
      const lu = level.uniforms;
      // Same height, different XZ — dead level means the identical band.
      expect(strataFactor(lu, ROCK, 0, [0, 1.7, 0], 0.5))
        .toEqual(strataFactor(lu, ROCK, 0, [30, 1.7, -20], 0.5));

      // With the defaults the sequence dips, so one height is not one bed:
      // walking the XZ plane at a fixed altitude crosses beds.
      const du = makeMaterial().uniforms;
      const across = [0, 20, 40, 60, 80].map(x => strataFactor(du, ROCK, 0, [x, 1.7, -x * 0.7], 0.5));
      expect(Math.max(...across.map(f => deviation(f, across[0])))).toBeGreaterThan(0.005);

      // …and the warp alone does it too, with the dip switched off.
      const warpOnly = makeMaterial();
      configureCliffStrata(warpOnly, { tilt: 0, warp: 0.5 });
      expect(deviation(
        strataFactor(warpOnly.uniforms, ROCK, 0, [0, 1.7, 0], 0.0),
        strataFactor(warpOnly.uniforms, ROCK, 0, [0, 1.7, 0], 1.0),
      )).toBeGreaterThan(0.005);
    });

    it('strength scales the whole effect, and 0 is exactly off', () => {
      const mat = makeMaterial();
      const full = deviation(strataFactor(mat.uniforms, ROCK, 0, [3, 2.37, 4]), ROCK);

      configureCliffStrata(mat, { strength: 0.5 });
      const half = deviation(strataFactor(mat.uniforms, ROCK, 0, [3, 2.37, 4]), ROCK);
      expect(half).toBeCloseTo(full * 0.5, 6);

      configureCliffStrata(mat, { strength: 0 });
      expect(strataFactor(mat.uniforms, ROCK, 0, [3, 2.37, 4])).toEqual(ROCK);
    });
  });
});
