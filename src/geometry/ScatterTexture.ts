import * as THREE from 'three';
import { SEASON_COLOR_SLOT, ensureSeasonColorSlot } from '../season/SeasonGLSL.js';

/**
 * Surface mottling for scatter: a fine procedural break-up of the flat colour
 * a low-poly plant is otherwise painted in.
 *
 * The problem it solves is a mismatch rather than a plant being wrong on its
 * own. The terrain shader puts real texture on the ground — triplanar samples,
 * splat blending, bedding on the cliffs — and a tree standing in it is a
 * handful of large facets of one flat green. Next to a textured hillside that
 * reads as plastic, and the bigger the canopy facet the more it reads that way.
 *
 * This is not a lighting change and not an attempt to hide the faceting: the
 * low-poly silhouette is the look. It varies the surface *brightness* on a
 * scale finer than a facet, so each flat plane stops being uniform while its
 * edges stay exactly as crisp as they were.
 */

/** Uniform declarations and the noise backing {@link SCATTER_TEXTURE_FRAG_BODY}. */
export const SCATTER_TEXTURE_GLSL = /* glsl */`
  uniform float uScatterTexEnabled;
  uniform float uScatterTexStrength;
  uniform float uScatterTexScale;
  varying vec3  vScatterTexPos;

  float stHash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
  }

  /** Value noise, 0–1, smooth across cell boundaries. */
  float stNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(stHash(i + vec3(0, 0, 0)), stHash(i + vec3(1, 0, 0)), f.x),
          mix(stHash(i + vec3(0, 1, 0)), stHash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(stHash(i + vec3(0, 0, 1)), stHash(i + vec3(1, 0, 1)), f.x),
          mix(stHash(i + vec3(0, 1, 1)), stHash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
`;

/**
 * Vertex half: publish the coordinate the noise is sampled in.
 *
 * Built from the **raw `position` attribute**, not from `transformed`. That is
 * the whole trick, and it is deliberate: `transformed` is what wind sway bends,
 * so sampling it would drag the texture across the surface every time the plant
 * leaned — mottling that swims over a canopy reads as a shader bug even when
 * the motion is small. `position` never moves, so the pattern is welded to the
 * model.
 *
 * The instance origin is added rather than the full instance matrix, which
 * decorrelates one plant from the next without rotating the pattern with them
 * — nobody can tell a wood apart by which way its noise points, and skipping
 * the rotation keeps this to an add.
 */
export const SCATTER_TEXTURE_VERT_BODY = /* glsl */`
  {
    vec3 stBase = position + modelMatrix[3].xyz;
    #ifdef USE_INSTANCING
      stBase += instanceMatrix[3].xyz;
    #endif
    vScatterTexPos = stBase;
  }
`;

/**
 * Fragment half: two octaves of noise, multiplied into `diffuseColor`.
 *
 * Multiplicative, so it scales whatever the surface already is — it keeps the
 * hue, survives the seasonal tint recolouring underneath it, and is exactly a
 * no-op at strength 0. Additive would wash a dark trunk and a bright canopy by
 * the same absolute amount and grey both.
 */
export const SCATTER_TEXTURE_FRAG_BODY = /* glsl */`
  {
    vec3 stQ = vScatterTexPos * uScatterTexScale;
    // Taken BEFORE the branch below. fwidth is undefined under non-uniform
    // control flow, and the strength test is uniform today but the cost of
    // being careless here is garbage derivatives exactly along a silhouette.
    float stPx = max(max(fwidth(stQ.x), fwidth(stQ.y)), fwidth(stQ.z));
    if (uScatterTexEnabled > 0.5 && uScatterTexStrength > 0.0) {
      // Two octaves: one alone is blobby at this scale, and the second is what
      // makes it read as surface rather than as a stain.
      float stN = stNoise(stQ) * 0.65 + stNoise(stQ * 2.7) * 0.35;
      // Fade out once a feature is down to about a pixel. Left in, a
      // sub-pixel pattern does not average to a tint — it crawls as the camera
      // moves, and a forest of crawling trees is far worse than a flat one.
      float stFade = 1.0 - smoothstep(0.5, 1.5, stPx);
      diffuseColor.rgb *= 1.0 + (stN - 0.5) * uScatterTexStrength * stFade;
    }
  }
`;

/** How the mottling reads. Unset fields keep their current value. */
export interface ScatterTextureOptions {
  /** Whether this material is mottled at all. Default true. */
  enabled?: boolean;
  /**
   * Peak-to-peak brightness variation as a fraction of the surface's own
   * colour — 0.18 means roughly ±9%. Default 0.18.
   *
   * Low on purpose. The job is to stop a facet being *perfectly* uniform, and
   * the eye picks that up long before the variation is nameable as a texture;
   * much past 0.3 a canopy starts to look mouldy rather than leafy.
   */
  strength?: number;
  /**
   * Noise features per world unit. Default 6 — features of about 0.17 units,
   * comfortably finer than a canopy facet, which is what lets it break the
   * facet up instead of tinting it.
   *
   * Raise it for a small plant whose facets are already tiny; lower it for a
   * large prop, or the pattern vanishes into the distance fade.
   */
  scale?: number;
}

/** Builds the uniform set matching {@link SCATTER_TEXTURE_GLSL}. */
export function scatterTextureUniforms(opts: ScatterTextureOptions = {}): Record<string, THREE.IUniform> {
  return {
    uScatterTexEnabled:  { value: opts.enabled === false ? 0 : 1 },
    uScatterTexStrength: { value: opts.strength ?? 0.18 },
    uScatterTexScale:    { value: opts.scale ?? 6 },
  };
}

/** Where {@link attachScatterTexture} parks the uniforms it injects. */
const ATTACHED = 'hexWorldScatterTexture';

/**
 * Give a stock three.js material fine procedural mottling, so a flat-shaded
 * low-poly plant stops reading as plastic beside textured ground.
 *
 * Opt-in per material like every other attach in this library, and for the
 * usual reason — a rock wants a different grain from a canopy, and some props
 * want none. Unlike `attachSnow` and `attachWindSway` this one needs no data
 * and no driver: it is inert-or-on from the moment it is attached, and there is
 * nothing to push per frame.
 *
 * **Composition.** The mottle lands *before* {@link SEASON_COLOR_SLOT}, which
 * puts it under both of the seasonal effects however they were attached: the
 * foliage tint recolours the already-mottled surface (so the variation carries
 * through autumn instead of being flattened by it), and snow covers it, which
 * is what snow does to a texture.
 *
 * Safe on a material that already has an `onBeforeCompile` (the existing hook
 * still runs), and idempotent.
 *
 * @example
 * const broadleaf = new THREE.MeshLambertMaterial({ vertexColors: true });
 * attachScatterTexture(broadleaf);
 * attachSeasonalTint(broadleaf, { summer: BROADLEAF_CANOPY_COLOR });
 * attachSnow(broadleaf);
 *
 * @example
 * // A bush's facets are already small — go finer, and lighter.
 * attachScatterTexture(bush, { scale: 11, strength: 0.14 });
 */
export function attachScatterTexture(material: THREE.Material, opts: ScatterTextureOptions = {}): void {
  if (material.userData?.[ATTACHED]) {
    styleScatterTexture(material, opts); // already mottled — restyle in place
    return;
  }

  const uniforms = scatterTextureUniforms(opts);
  material.userData[ATTACHED] = uniforms;

  const prior = material.onBeforeCompile;
  // Same reasoning as every other attach here: a material's default program
  // cache key is its onBeforeCompile source, and every patched material would
  // otherwise share one — fold the original hook's text in.
  const ownKey = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey')
    ? material.customProgramCacheKey.bind(material)
    : null;
  const priorSource = prior ? prior.toString() : '';

  material.onBeforeCompile = function (shader, renderer) {
    prior?.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`#include <common>
  uniform float uScatterTexScale;
  varying vec3 vScatterTexPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${SCATTER_TEXTURE_VERT_BODY}`);

    shader.fragmentShader = ensureSeasonColorSlot(shader.fragmentShader)
      .replace('#include <common>', /* glsl */`#include <common>
  ${SCATTER_TEXTURE_GLSL}`)
      // Before the slot, so the seasonal tint recolours a mottled surface and
      // snow settles on top of one.
      .replace(SEASON_COLOR_SLOT, `${SCATTER_TEXTURE_FRAG_BODY}\n  ${SEASON_COLOR_SLOT}`);
  };
  material.customProgramCacheKey = () => `${ownKey ? ownKey() : priorSource}|hex-world-scatter-texture`;
  material.needsUpdate = true;
}

/** True if {@link attachScatterTexture} has already patched this material. */
export function hasScatterTexture(material: THREE.Material): boolean {
  return Boolean(material.userData?.[ATTACHED]);
}

/**
 * Restyle the mottling. A no-op on a material that never got
 * {@link attachScatterTexture}, so it is safe to fan out over a mixed list.
 */
export function styleScatterTexture(material: THREE.Material, opts: ScatterTextureOptions = {}): void {
  const u = material.userData?.[ATTACHED] as Record<string, THREE.IUniform> | undefined;
  if (!u) return;
  if (opts.scale    !== undefined) u.uScatterTexScale.value = opts.scale;
  if (opts.strength !== undefined) u.uScatterTexStrength.value = opts.strength;
  if (opts.enabled  !== undefined) setScatterTextureEnabled(material, opts.enabled);
}

/**
 * Switch the mottling off or on without disturbing its styling — the shader
 * branches out entirely when off, giving back the flat colour the material had
 * before, and a toggle round-trips because the strength is never zeroed.
 */
export function setScatterTextureEnabled(material: THREE.Material, enabled: boolean): void {
  const u = material.userData?.[ATTACHED] as Record<string, THREE.IUniform> | undefined;
  if (u) u.uScatterTexEnabled.value = enabled ? 1 : 0;
}
