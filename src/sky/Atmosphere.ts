import * as THREE from 'three';

/**
 * Shared aerial-perspective GLSL: every surface material (terrain, roads, all
 * six liquid layers) mixes its final color toward a single atmosphere color as
 * it recedes, so the far edge of the map dissolves into the sky instead of
 * ending against a hard void.
 *
 * Distance is measured on the **ground plane** (world XZ), not from the eye.
 * With a pitched RTS camera the far map edge is exactly what should dissolve,
 * and a peak on the horizon then hazes as much as the valley beside it —
 * eye-distance fog would leave ridgelines cut out against the sky. Because
 * every material uses the same measure, terrain, roads, and water fade in step
 * with no seam at a shoreline.
 *
 * `cameraPosition` is declared by three.js in both GLSL1 and GLSL3 fragment
 * shaders, so this block drops into either without changes.
 */
export const ATMOSPHERE_GLSL = /* glsl */`
  uniform float uAtmoEnabled;
  uniform vec3  uAtmoColor;
  uniform float uAtmoNear;
  uniform float uAtmoFar;
  uniform float uAtmoDensity;

  /** Haze fraction 0–1 at a world-XZ point: 0 = untouched, 1 = pure atmosphere. */
  float atmosphereFactor(vec2 worldXZ) {
    if (uAtmoEnabled < 0.5) return 0.0;
    float d = distance(worldXZ, cameraPosition.xz);
    return smoothstep(uAtmoNear, uAtmoFar, d) * uAtmoDensity;
  }

  vec3 applyAtmosphere(vec3 color, vec2 worldXZ) {
    return mix(color, uAtmoColor, atmosphereFactor(worldXZ));
  }
`;

/** Distance haze styling. Unset fields keep their current value. */
export interface AtmosphereOptions {
  /** Show or hide the haze. Defaults to true when configureAtmosphere is called. */
  enabled?: boolean;
  /** The color surfaces fade into — normally the sky's horizon color. */
  color?: THREE.ColorRepresentation;
  /** Ground distance where the haze starts, world units. Default 55. */
  near?: number;
  /** Ground distance where the haze reaches full strength. Default 170. */
  far?: number;
  /**
   * How completely the farthest surfaces dissolve, 0–1. Default 1 (they read
   * as pure sky). Drop toward 0.8 to keep distant silhouettes readable.
   */
  density?: number;
}

/** Uniforms backing {@link ATMOSPHERE_GLSL} (haze off until configured). */
export function atmosphereUniforms(): Record<string, THREE.IUniform> {
  return {
    uAtmoEnabled: { value: 0 },
    uAtmoColor:   { value: new THREE.Color(0x8fb2d9) },
    uAtmoNear:    { value: 55 },
    uAtmoFar:     { value: 170 },
    uAtmoDensity: { value: 1 },
  };
}

/** Where {@link attachAtmosphere} parks the uniforms it injects into a stock material. */
const ATTACHED = '__hexWorldAtmosphere';

/**
 * The atmosphere uniforms of a material, however it got them: declared inline
 * (the library's own shaders) or injected by {@link attachAtmosphere}. Null for
 * materials that have no haze, so every helper below can be fanned out over a
 * mixed list without checking first.
 */
function atmosphereUniformsOf(material: THREE.Material): Record<string, THREE.IUniform> | null {
  const own = (material as THREE.ShaderMaterial).uniforms;
  if (own && 'uAtmoEnabled' in own) return own;
  return (material.userData?.[ATTACHED] as Record<string, THREE.IUniform> | undefined) ?? null;
}

/**
 * Configure the distance haze on one material. Enabling and restyling are
 * uniform flips — no recompile. Materials without the atmosphere uniforms are
 * skipped, so this is safe to fan out over a mixed material list.
 *
 * A {@link SkyDome} drives this for you (keeping the color locked to its own
 * horizon band); reach for it directly for haze without a sky dome.
 */
export function configureAtmosphere(
  material: THREE.Material,
  opts: AtmosphereOptions = {},
): void {
  const u = atmosphereUniformsOf(material);
  if (!u) return;
  if (opts.color   !== undefined) (u.uAtmoColor.value as THREE.Color).set(opts.color);
  if (opts.near    !== undefined) u.uAtmoNear.value = opts.near;
  if (opts.far     !== undefined) u.uAtmoFar.value  = opts.far;
  if (opts.density !== undefined) u.uAtmoDensity.value = THREE.MathUtils.clamp(opts.density, 0, 1);
  // smoothstep is undefined when its edges coincide — keep far strictly above near.
  u.uAtmoFar.value = Math.max(u.uAtmoFar.value as number, (u.uAtmoNear.value as number) + 1e-3);
  u.uAtmoEnabled.value = (opts.enabled ?? true) ? 1 : 0;
}

/** Show or hide the haze on one material without touching its styling. */
export function setAtmosphereEnabled(material: THREE.Material, enabled: boolean): void {
  const u = atmosphereUniformsOf(material);
  if (u) u.uAtmoEnabled.value = enabled ? 1 : 0;
}

/**
 * Re-point the haze color on a whole material list — the per-frame call when
 * the sky changes color. Entries may be undefined (hand-built liquid sets
 * leave layers out) and non-atmosphere materials are ignored.
 */
export function setAtmosphereColor(
  materials: Iterable<THREE.Material | undefined | null>,
  color: THREE.Color,
): void {
  for (const mat of materials) {
    const u = mat ? atmosphereUniformsOf(mat) : null;
    if (u) (u.uAtmoColor.value as THREE.Color).copy(color);
  }
}

/**
 * Give a stock three.js material (scatter meshes, unit models, anything you
 * built yourself) the library's own distance haze, so it recedes in step with
 * the terrain instead of standing out against it.
 *
 * This exists because `scene.fog` is **not** interchangeable here. three's fog
 * mixes in linear working space and the result is then tone-mapped and
 * sRGB-encoded, while this library's hand-rolled shaders write their values
 * straight out — so handing both the same haze color lands it far brighter on a
 * stock material than on the terrain beside it (distant trees glowing pale over
 * a dark hillside, and worse at night). The injected mix runs *after* tone
 * mapping and encoding instead, in the same numeric space the library writes,
 * so at full haze both sides reach exactly `uAtmoColor` and there is no seam.
 * Distance is the same ground-plane measure too, not view depth.
 *
 * Safe to call on a material that already has an `onBeforeCompile` (the
 * existing hook still runs), and idempotent. After attaching, the material
 * responds to {@link configureAtmosphere} and a {@link SkyDome}'s material list
 * exactly like the library's own shaders.
 *
 * @example
 * const trees = new THREE.MeshLambertMaterial({ color: 0x5e8c2a });
 * attachAtmosphere(trees);
 * const sky = new SkyDome({ materials: () => [terrainMat, trees] });
 */
export function attachAtmosphere(material: THREE.Material, opts: AtmosphereOptions = {}): void {
  if ((material as THREE.ShaderMaterial).uniforms?.uAtmoEnabled || material.userData?.[ATTACHED]) {
    configureAtmosphere(material, opts); // already hazed — just restyle
    return;
  }

  const uniforms = atmosphereUniforms();
  material.userData[ATTACHED] = uniforms;

  const prior = material.onBeforeCompile;
  // Material's default program cache key is `onBeforeCompile.toString()`, and
  // every material we patch ends up with the same handler text — so fold the
  // original hook's source in, or a patched rock and a patched tree would share
  // one compiled program despite injecting different code.
  const ownKey = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey')
    ? material.customProgramCacheKey.bind(material)
    : null;
  const priorSource = prior ? prior.toString() : '';

  material.onBeforeCompile = function (shader, renderer) {
    prior?.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vAtmoWorldXZ;')
      .replace('#include <project_vertex>', /* glsl */`#include <project_vertex>
  {
    // Rebuilt from transformed rather than reusing three's worldPosition,
    // which only exists under envmap/shadow/transmission defines.
    vec4 atmoWorld = vec4(transformed, 1.0);
    #ifdef USE_BATCHING
      atmoWorld = batchingMatrix * atmoWorld;
    #endif
    #ifdef USE_INSTANCING
      atmoWorld = instanceMatrix * atmoWorld;
    #endif
    vAtmoWorldXZ = (modelMatrix * atmoWorld).xz;
  }`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vAtmoWorldXZ;\n${ATMOSPHERE_GLSL}`)
      // dithering_fragment is the last chunk in every stock material's main(),
      // so this lands after tone mapping and the output-colorspace conversion.
      .replace('#include <dithering_fragment>', /* glsl */`#include <dithering_fragment>
  gl_FragColor.rgb = applyAtmosphere(gl_FragColor.rgb, vAtmoWorldXZ);`);
  };
  material.customProgramCacheKey = () => `${ownKey ? ownKey() : priorSource}|hex-world-atmosphere`;
  material.needsUpdate = true;

  configureAtmosphere(material, opts);
}
