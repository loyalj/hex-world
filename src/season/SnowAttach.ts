import * as THREE from 'three';
import {
  SNOW_GLSL, SEASON_COLOR_SLOT, snowAppearanceUniforms, seasonBindingUniforms,
  injectSeasonLookup, ensureSeasonColorSlot, styleSnow,
} from './SeasonGLSL.js';
import type { SnowAppearanceOptions } from './SeasonGLSL.js';

const ATTACHED = 'hexWorldSnow';

/**
 * Give a stock three.js material (a scatter tree, a rock, anything not one of
 * this library's own shaders) seasonal snow caps.
 *
 * Snow is injected at `<color_fragment>`, *not* at the end of main() the way
 * `attachAtmosphere` injects haze. The difference matters: haze sits between
 * the eye and the surface and belongs after tone mapping, but snow is part of
 * the surface. Putting it into `diffuseColor` means it gets lit, shadowed, and
 * fogged like the rest of the model — a cap added after lighting would glow at
 * midnight. The two patches compose in either order for exactly that reason.
 *
 * It goes in *after* {@link SEASON_COLOR_SLOT}, which puts it after the foliage
 * tint however the two were attached — snow settles on autumn leaves rather
 * than turning gold with them.
 *
 * Coverage comes from {@link SNOW_GLSL}'s shared `snowCoverage`, the same
 * function the terrain shader calls, so a tree whitens at the same moment as
 * the ground it stands in. It is weighted by how far each surface faces the
 * sky, so snow settles on the canopy and leaves the trunk bare.
 *
 * Requires a per-instance (or per-vertex) `cellIndex` attribute to look the
 * cell up — `buildScatterMeshes` attaches one to every scatter mesh. On a mesh
 * without it, every instance reads cell 0; the effect stays inert until
 * {@link configureSeason} supplies a climate either way.
 *
 * Safe on a material that already has an `onBeforeCompile` (the existing hook
 * still runs), and idempotent.
 *
 * @example
 * const trees = new THREE.MeshLambertMaterial({ color: 0x5e8c2a });
 * attachSnow(trees);
 * configureSeason(trees, climate);
 */
export function attachSnow(material: THREE.Material, opts: SnowAppearanceOptions = {}): void {
  if (material.userData?.[ATTACHED]) {
    styleSnow(material, opts); // already snowy — restyle without unbinding
    return;
  }

  // Shared with any other seasonal effect on this material, by identity — see
  // seasonBindingUniforms.
  const uniforms = { ...seasonBindingUniforms(material), ...snowAppearanceUniforms() };
  material.userData[ATTACHED] = uniforms;

  const prior = material.onBeforeCompile;
  // Same reasoning as attachAtmosphere: a material's default program cache key
  // is its onBeforeCompile source, and every patched material would otherwise
  // share one — fold the original hook's text in so a snowy tree and a snowy
  // rock stay distinct programs.
  const ownKey = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey')
    ? material.customProgramCacheKey.bind(material)
    : null;
  const priorSource = prior ? prior.toString() : '';

  material.onBeforeCompile = function (shader, renderer) {
    prior?.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    injectSeasonLookup(shader);

    shader.fragmentShader = ensureSeasonColorSlot(shader.fragmentShader)
      .replace('#include <common>', /* glsl */`#include <common>
  ${SNOW_GLSL}`)
      // Into diffuseColor, so the cap is lit and shadowed with the model.
      .replace(SEASON_COLOR_SLOT, /* glsl */`${SEASON_COLOR_SLOT}
  if (uSeasonEnabled > 0.5) {
    float snowAmt = snowCoverage(vSeasonSnow, vSeasonUp, vSeasonWorldXZ);
    diffuseColor.rgb = mix(diffuseColor.rgb, uSnowColor, snowAmt);
  }`);
  };
  material.customProgramCacheKey = () => `${ownKey ? ownKey() : priorSource}|hex-world-snow`;
  material.needsUpdate = true;

  styleSnow(material, opts);
}

/** True if {@link attachSnow} has already patched this material. */
export function hasSnow(material: THREE.Material): boolean {
  return Boolean(material.userData?.[ATTACHED]);
}
