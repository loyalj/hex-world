import * as THREE from 'three';

/**
 * Wind sway: the vertex-side half of the shared {@link Wind}.
 *
 * A plant bends downwind by an amount that grows with height above its own
 * base, so the trunk stays planted and the crown does the moving, and the gust
 * arrives as a *wave travelling along the wind* rather than as every tree in
 * the wood leaning at the same instant. That travelling front is the whole
 * effect — a field of individually-animated plants reads as noise, and one
 * synchronized field reads as a decal.
 */

/** Uniform declarations backing {@link WIND_SWAY_VERT_BODY}. */
export const WIND_SWAY_GLSL = /* glsl */`
  // Shared world wind — see the Wind class. Direction is a unit vector in
  // world XZ and strength carries the magnitude, so nothing renormalizes here.
  uniform vec2  uWindDir;
  uniform float uWindStrength;
  // Integrated on the CPU, never time × rate: a rate that changes would rewind
  // the wave's phase every time the wind picks up.
  uniform float uWindPhase;
  uniform float uWindWave;

  uniform float uSwayEnabled;
  uniform float uSwayAmplitude;
  uniform float uSwayStiffness;
  uniform float uSwayHeight;
  uniform float uSwayFlutter;
`;

/**
 * The sway displacement itself. Goes in **after `<begin_vertex>`**, which is
 * where `transformed` first exists and — being ahead of `<project_vertex>` —
 * ahead of everything that derives a world position from it, so a swaying tree
 * carries its haze and its snow with it.
 *
 * Bends `transformed` in object space, because that is the space the vertex is
 * in at this point; the world wind is pulled back through the instance's own
 * basis to get there. Normals are not re-bent — at the amplitudes a plant sways
 * through, relighting the crown costs more than the shading error is worth.
 */
export const WIND_SWAY_VERT_BODY = /* glsl */`
  {
    float swayH = transformed.y;
    if (uSwayEnabled > 0.5 && uSwayAmplitude > 0.0 && swayH > 0.0) {
      vec3 swayOrigin = modelMatrix[3].xyz;
      mat3 swayBasis  = mat3(modelMatrix);
      #ifdef USE_INSTANCING
        swayOrigin += swayBasis * instanceMatrix[3].xyz;
        swayBasis   = swayBasis * mat3(instanceMatrix);
      #endif

      // The gust travels ALONG the wind: subtracting the plant's position
      // projected onto the wind direction is what makes a wave cross a wood
      // instead of the whole wood leaning together.
      float swayPhase = uWindPhase - dot(swayOrigin.xz, uWindDir) * uWindWave;
      // …plus a per-plant offset, so two trees the same distance downwind are
      // still not in lockstep with each other.
      swayPhase += fract(sin(dot(swayOrigin.xz, vec2(127.1, 311.7))) * 43758.5453) * 6.2831853;

      // Two rates again — the slow lean the trunk takes, and a faster shiver
      // riding on it.
      float lean    = sin(swayPhase) * 0.72 + sin(swayPhase * 2.3 + 1.1) * 0.28;
      float flutter = sin(swayPhase * 3.7 + 2.4);

      // Stiffness is floored rather than taken raw: pow(0.0, 0.0) is undefined,
      // and at the base rel IS 0, so a stiffness of 0 would spray NaN vertices
      // along the ground line rather than bowing evenly as it reads like it
      // should.
      float rel  = clamp(swayH / max(uSwayHeight, 1e-3), 0.0, 1.0);
      float bend = uSwayAmplitude * uSwayHeight * pow(rel, max(uSwayStiffness, 1e-3)) * uWindStrength;

      // World wind pulled into object space. \`v * m\` is \`transpose(m) * v\`, and
      // for the rotation these matrices carry the transpose IS the inverse —
      // which is how this gets there without an inverse() the GLSL1 path
      // doesn't have. Uniform instance scale divides back out in the normalize.
      vec3 windObj = vec3(uWindDir.x, 0.0, uWindDir.y) * swayBasis;
      float windLen = length(windObj);
      if (windLen > 1e-5) {
        windObj /= windLen;
        vec3 sideObj = vec3(-windObj.z, 0.0, windObj.x);
        // Biased downwind rather than centred: wind pushes one way, so the
        // plant oscillates between a fifth of its bend and all of it, never
        // back through upright into the wind's eye.
        vec3 offset = windObj * (bend * (0.6 + 0.4 * lean))
                    + sideObj * (bend * uSwayFlutter * flutter);
        transformed += offset;
        // A bend is an arc, not a stretch: drop the tip by the sagitta, or a
        // leaning tree also grows taller than the still one beside it.
        transformed.y -= dot(offset.xz, offset.xz) / (2.0 * max(swayH, 1e-3));
      }
    }
  }
`;

/** How a given plant answers the wind. Unset fields keep their current value. */
export interface WindSwayOptions {
  /** Whether this material sways at all. Default true. */
  enabled?: boolean;
  /**
   * Tip displacement at full wind as a fraction of {@link height} — so it means
   * the same thing on a sapling and on an old oak. Default 0.065.
   *
   * Low on purpose. A plant's silhouette is what the eye tracks, and past
   * roughly a tenth of its height the bend stops reading as wind and starts
   * reading as rubber.
   */
  amplitude?: number;
  /**
   * How the bend is distributed up the plant: 1 bows evenly from the base, 2
   * keeps the trunk stiff and moves the crown, 4 flicks only the tip.
   * Default 2.
   */
  stiffness?: number;
  /**
   * The plant's overall height in world units — what `amplitude` is a fraction
   * of, and the height at which the bend reaches full. Default 2.
   */
  height?: number;
  /** Sideways shiver across the wind, as a fraction of the downwind bend. Default 0.35. */
  flutter?: number;
}

/** Builds the uniform set matching {@link WIND_SWAY_GLSL} (still until a wind drives it). */
export function windSwayUniforms(opts: WindSwayOptions = {}): Record<string, THREE.IUniform> {
  return {
    uWindDir:       { value: new THREE.Vector2(1, 0) },
    uWindStrength:  { value: 0 },
    uWindPhase:     { value: 0 },
    uWindWave:      { value: (Math.PI * 2) / 26 },
    uSwayEnabled:   { value: opts.enabled === false ? 0 : 1 },
    uSwayAmplitude: { value: opts.amplitude ?? 0.065 },
    uSwayStiffness: { value: opts.stiffness ?? 2 },
    uSwayHeight:    { value: opts.height    ?? 2 },
    uSwayFlutter:   { value: opts.flutter   ?? 0.35 },
  };
}

/** Where {@link attachWindSway} parks the uniforms it injects into a stock material. */
const ATTACHED = 'hexWorldWind';

/**
 * Give a stock three.js material (a scatter plant, a banner, a field of reeds)
 * a wind-driven bend, so it answers the same {@link Wind} that drifts the
 * clouds and slants the rain.
 *
 * **Opt in per material, deliberately.** Which scatter bends is what tells a
 * hedge from a boulder, exactly as `attachSeasonalTint` is what tells a
 * broadleaf from a pine — so `HexWorld.setWind` *drives* whatever carries this
 * patch but never applies it for you. Call it on the plants.
 *
 * The sway needs no attribute the mesh doesn't already have: height comes from
 * the geometry's own local Y — `createBroadleafGeometry` and every other shape
 * builder seats its plant at y = 0, which is what makes that height honest —
 * and the per-plant phase from the instance origin.
 *
 * Three limits worth knowing. Shadows are cast through three's own depth
 * material, which carries none of this — a swaying tree's shadow stands still,
 * and at the amplitudes here that is invisible against a moving canopy but
 * would not be on a flagpole. A mesh whose geometry is *not* seated at y = 0
 * bends around y = 0 rather than around its base; seat it, or set
 * {@link WindSwayOptions.height} to match what it actually spans. And the bend
 * goes in at `<begin_vertex>`, which `<skinning_vertex>` later overwrites
 * wholesale — so this moves scatter and props, not a skinned character's cloak.
 *
 * Safe on a material that already has an `onBeforeCompile` (the existing hook
 * still runs), and idempotent.
 *
 * @example
 * const broadleaf = new THREE.MeshLambertMaterial({ vertexColors: true });
 * attachWindSway(broadleaf, { height: 1.9 });
 * const bushes = new THREE.MeshLambertMaterial({ vertexColors: true });
 * attachWindSway(bushes, { height: 0.5, stiffness: 1.2, amplitude: 0.125 });
 * world.setWind({ speed: 4 });
 */
export function attachWindSway(material: THREE.Material, opts: WindSwayOptions = {}): void {
  if (material.userData?.[ATTACHED]) {
    styleWindSway(material, opts); // already swaying — restyle without rebinding
    return;
  }

  const uniforms = windSwayUniforms(opts);
  material.userData[ATTACHED] = uniforms;

  const prior = material.onBeforeCompile;
  // Same reasoning as attachAtmosphere and attachSnow: a material's default
  // program cache key is its onBeforeCompile source, and every patched material
  // would otherwise share one — fold the original hook's text in so a swaying
  // tree and a swaying bush stay distinct programs.
  const ownKey = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey')
    ? material.customProgramCacheKey.bind(material)
    : null;
  const priorSource = prior ? prior.toString() : '';

  material.onBeforeCompile = function (shader, renderer) {
    prior?.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WIND_SWAY_GLSL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WIND_SWAY_VERT_BODY}`);
  };
  material.customProgramCacheKey = () => `${ownKey ? ownKey() : priorSource}|hex-world-wind-sway`;
  material.needsUpdate = true;
}

/** True if {@link attachWindSway} has already patched this material. */
export function hasWindSway(material: THREE.Material): boolean {
  return Boolean(material.userData?.[ATTACHED]);
}

/**
 * Restyle how one plant answers the wind, without touching which wind that is.
 * A no-op on a material that never got {@link attachWindSway} — which is how a
 * boulder opts out: it simply never receives the patch.
 *
 * @example
 * styleWindSway(reedMat, { stiffness: 1, amplitude: 0.3, flutter: 0.6 });
 */
export function styleWindSway(material: THREE.Material, opts: WindSwayOptions = {}): void {
  const u = material.userData?.[ATTACHED] as Record<string, THREE.IUniform> | undefined;
  if (!u) return;
  if (opts.amplitude !== undefined) u.uSwayAmplitude.value = opts.amplitude;
  if (opts.stiffness !== undefined) u.uSwayStiffness.value = opts.stiffness;
  if (opts.height    !== undefined) u.uSwayHeight.value    = opts.height;
  if (opts.flutter   !== undefined) u.uSwayFlutter.value   = opts.flutter;
  if (opts.enabled   !== undefined) setWindSwayEnabled(material, opts.enabled);
}

/**
 * Stop or restart one material's sway without disturbing its styling.
 *
 * A gate of its own rather than a zeroed amplitude, so it survives the
 * per-frame wind push — and because a stopped plant should stand upright, not
 * freeze mid-lean.
 */
export function setWindSwayEnabled(material: THREE.Material, enabled: boolean): void {
  const u = material.userData?.[ATTACHED] as Record<string, THREE.IUniform> | undefined;
  if (u) u.uSwayEnabled.value = enabled ? 1 : 0;
}
