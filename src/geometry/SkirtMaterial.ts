import * as THREE from 'three';
import { ATMOSPHERE_GLSL, atmosphereUniforms } from '../sky/Atmosphere.js';

const vertexShader = /* glsl */`
  varying vec3 vNormalW;
  varying vec2 vWorldXZ;
  varying float vY;
  varying float vDepth;
  varying float vWater;

  /** World units below the cut line at the top of the wall. */
  attribute float aDepth;
  /** 1 on the water cross-section, 0 on earth. */
  attribute float aWater;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldXZ = worldPos.xz;
    vY       = worldPos.y;
    vDepth   = aDepth;
    vWater   = aWater;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  #include <common>

  varying vec3 vNormalW;
  varying vec2 vWorldXZ;
  varying float vY;
  varying float vDepth;
  varying float vWater;

  uniform vec3  uLightDir;
  uniform vec3  uLightColor;
  uniform vec3  uAmbient;

  uniform vec3  uSoilTop;
  uniform vec3  uSoilDeep;
  uniform vec3  uSoilPale;
  uniform vec3  uTopsoil;
  uniform vec3  uWaterColor;
  uniform float uTopsoilDepth;
  uniform float uBandScale;
  uniform float uBandWobble;
  uniform float uBandContrast;
  uniform float uGrain;
  uniform float uDeepen;

  ${ATMOSPHERE_GLSL}

  float hash1(float n) { return fract(sin(n * 127.1) * 43758.5453123); }

  float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash2(i),               hash2(i + vec2(1.0, 0.0)), f.x),
      mix(hash2(i + vec2(0.0,1.0)), hash2(i + vec2(1.0,1.0)), f.x), f.y);
  }

  /**
   * One stratum's colour. Bands are picked by a hash of the band index rather
   * than a gradient, so consecutive layers differ the way real bedding does —
   * a pale silt can sit directly on a dark loam — while the whole run stays
   * inside the soil palette.
   */
  vec3 strataColor(float band) {
    float h = hash1(band);
    // Two mixes rather than one: the first sets how deep-brown the layer is,
    // the second lets a minority of layers wash out toward the pale sandy end,
    // which is what stops the wall reading as a single colour with noise on it.
    vec3 c = mix(uSoilTop, uSoilDeep, hash1(band + 3.7));
    c = mix(c, uSoilPale, smoothstep(0.62, 1.0, h) * uBandContrast);
    // Per-band brightness jitter, so two layers that hash to similar colours
    // still separate.
    return c * (0.86 + 0.28 * hash1(band + 11.3));
  }

  void main() {
    // Banding runs off world Y, not a per-face coordinate, so a layer carries
    // level around every corner of the map — that continuity is the whole
    // reason the block reads as one piece of ground rather than four walls.
    // The wobble is horizontal only, for the same reason: it must not shear a
    // layer up or down as it travels.
    float wobble = (vnoise(vWorldXZ * 0.22) - 0.5) * 2.0 * uBandWobble
                 + (vnoise(vWorldXZ * 0.85) - 0.5) * uBandWobble * 0.4;
    float b    = (vY + wobble) * uBandScale;
    float band = floor(b);

    // A soft edge only in the last sliver of each band: strata part along
    // sharp bedding planes, and a wide blend turns them into a gradient.
    vec3 col = mix(strataColor(band), strataColor(band + 1.0),
                   smoothstep(0.88, 1.0, fract(b)));

    // Fine grain across the face, breaking up the flat bands.
    float grain = vnoise(vWorldXZ * 6.0) * 0.6 + vnoise(vWorldXZ * 19.0) * 0.4;
    col *= 1.0 + (grain - 0.5) * uGrain;

    // Damp, dark earth at the bottom of the cut and darker still in the
    // corners: soil doesn't get brighter the deeper you dig.
    col *= 1.0 - clamp(vDepth * uDeepen, 0.0, 0.55);

    // The dark line of topsoil directly under the ground surface — the detail
    // that makes it read as turf cut through rather than a painted cliff.
    col = mix(col, uTopsoil, 1.0 - smoothstep(0.0, uTopsoilDepth, vDepth));

    // The pond cut open above the ground line, darkening with depth the way
    // water does. Replaces the soil rather than tinting it.
    col = mix(col, uWaterColor * (1.0 - clamp(vDepth * 0.22, 0.0, 0.45)), vWater);

    // Hand-rolled lambert on the same uniforms the terrain and roads take, so
    // the wall darkens with them at dusk instead of glowing after dark. Walls
    // are flat-shaded by construction, which is what keeps the corners hard.
    vec3 n = normalize(vNormalW);
    float diff = max(dot(n, normalize(uLightDir)), 0.0);
    col *= uAmbient + uLightColor * diff;

    // Last, and un-converted: same space the rest of the library writes in.
    gl_FragColor = vec4(applyAtmosphere(col, vWorldXZ), 1.0);
  }
`;

/** Look of the cut earth. Every colour is a soil tone; the defaults are a loam palette. */
export interface SkirtMaterialOptions {
  /** Match the terrain's, so the wall shades with the ground. */
  lightDir?: THREE.Vector3;
  lightColor?: THREE.Color;
  ambient?: THREE.Color;
  /** Lighter end of the soil range. Default 0x8a6a45. */
  soilTop?: THREE.ColorRepresentation;
  /** Darker end. Default 0x4a3524. */
  soilDeep?: THREE.ColorRepresentation;
  /** The pale sandy layer a minority of bands wash toward. Default 0xb09a72. */
  soilPale?: THREE.ColorRepresentation;
  /** The dark line directly under the ground surface. Default 0x33261a. */
  topsoil?: THREE.ColorRepresentation;
  /** How thick that line is, in world units. Default 0.35. */
  topsoilDepth?: number;
  /** Colour of the water cross-section above the sea bed. Default 0x1d3f5c. */
  waterColor?: THREE.ColorRepresentation;
  /** Bands per world unit — higher is finer bedding. Default 1.6. */
  bandScale?: number;
  /** How much the layers wander off level, in world units. Default 0.5. */
  bandWobble?: number;
  /** How far bands stray toward the pale end, 0–1. Default 0.85. */
  bandContrast?: number;
  /** Strength of the fine surface grain, 0–1. Default 0.35. */
  grain?: number;
  /** How fast the soil darkens with depth, per world unit. Default 0.08. */
  deepen?: number;
}

/**
 * The cut-earth shader for {@link MapSkirt}: horizontal strata in soil browns,
 * a dark topsoil line under the ground surface, and a water cross-section
 * where the map edge runs through a sea or lake.
 *
 * Bands key off **world Y**, so a layer holds its level all the way around the
 * map — that is what makes the four walls read as one block of ground rather
 * than four separately painted faces.
 *
 * Lighting is the same hand-rolled `uLightDir`/`uLightColor`/`uAmbient` trio
 * the terrain and road materials take, so a {@link DayNightCycle} drives all
 * three together; it carries the shared distance haze too, so the wall
 * dissolves into the horizon with the ground above it.
 */
export function createSkirtMaterial(opts: SkirtMaterialOptions = {}): THREE.ShaderMaterial {
  const lightDir = (opts.lightDir ?? new THREE.Vector3(0.6, 1, 0.5)).clone().normalize();

  return new THREE.ShaderMaterial({
    uniforms: {
      uLightDir:   { value: lightDir },
      uLightColor: { value: opts.lightColor ?? new THREE.Color(0xffffff) },
      uAmbient:    { value: opts.ambient    ?? new THREE.Color(0x595959) },
      uSoilTop:    { value: new THREE.Color(opts.soilTop    ?? 0x8a6a45) },
      uSoilDeep:   { value: new THREE.Color(opts.soilDeep   ?? 0x4a3524) },
      uSoilPale:   { value: new THREE.Color(opts.soilPale   ?? 0xb09a72) },
      uTopsoil:    { value: new THREE.Color(opts.topsoil    ?? 0x33261a) },
      uWaterColor: { value: new THREE.Color(opts.waterColor ?? 0x1d3f5c) },
      uTopsoilDepth: { value: opts.topsoilDepth ?? 0.35 },
      uBandScale:    { value: opts.bandScale    ?? 1.6 },
      uBandWobble:   { value: opts.bandWobble   ?? 0.5 },
      uBandContrast: { value: opts.bandContrast ?? 0.85 },
      uGrain:        { value: opts.grain        ?? 0.35 },
      uDeepen:       { value: opts.deepen       ?? 0.08 },
      ...atmosphereUniforms(),
    },
    vertexShader,
    fragmentShader,
    // The wall is a closed shell around the map and is only ever seen from
    // outside; culling the inside halves the fill and stops the far wall
    // drawing over the terrain when the camera is low.
    side: THREE.FrontSide,
  });
}

/** Restyle a skirt material in place. Unset fields keep their current value. */
export function configureSkirt(material: THREE.ShaderMaterial, opts: SkirtMaterialOptions): void {
  const u = material.uniforms;
  if (!u || !('uSoilTop' in u)) return;
  const color = (name: string, v: THREE.ColorRepresentation | undefined) => {
    if (v !== undefined) (u[name].value as THREE.Color).set(v);
  };
  color('uSoilTop', opts.soilTop);
  color('uSoilDeep', opts.soilDeep);
  color('uSoilPale', opts.soilPale);
  color('uTopsoil', opts.topsoil);
  color('uWaterColor', opts.waterColor);
  if (opts.topsoilDepth !== undefined) u.uTopsoilDepth.value = opts.topsoilDepth;
  if (opts.bandScale    !== undefined) u.uBandScale.value    = Math.max(opts.bandScale, 1e-3);
  if (opts.bandWobble   !== undefined) u.uBandWobble.value   = opts.bandWobble;
  if (opts.bandContrast !== undefined) u.uBandContrast.value = THREE.MathUtils.clamp(opts.bandContrast, 0, 1);
  if (opts.grain        !== undefined) u.uGrain.value        = THREE.MathUtils.clamp(opts.grain, 0, 1);
  if (opts.deepen       !== undefined) u.uDeepen.value       = Math.max(opts.deepen, 0);
}
