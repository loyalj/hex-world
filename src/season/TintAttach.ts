import * as THREE from 'three';
import {
  FOLIAGE_GLSL, SEASON_COLOR_SLOT, DEFAULT_BLOSSOM_STRENGTH, foliageUniforms,
  seasonBindingUniforms, injectSeasonLookup, ensureSeasonColorSlot, styleFoliage,
} from './SeasonGLSL.js';
import type { FoliageTintOptions } from './SeasonGLSL.js';

const ATTACHED = 'hexWorldFoliage';

/**
 * Give a stock three.js material a seasonal foliage tint: spring green through
 * summer, gold through autumn, bare through winter, driven per cell by the
 * climate texture's temperature channel — and a spring bloom, since this is the
 * call that says the surface is a plant rather than a hillside.
 *
 * This is the counterpart to {@link attachSnow}, and deliberately a *separate*
 * call rather than part of it — because which of the two a plant gets is what
 * distinguishes one from another. A pine takes snow and no tint and stays green
 * all year; a broadleaf takes both and turns under the same snow. Handing a
 * material one and not the other is the whole API.
 *
 * `summer` defaults to the material's own `color`, which is what makes the tint
 * a no-op at midsummer instead of a wash that flattens the material — see
 * {@link FOLIAGE_GLSL} for why the palette is applied as a ratio against it.
 *
 * The tint lands *before* {@link SEASON_COLOR_SLOT} and snow lands after, so
 * the two compose in that order however they were attached.
 *
 * Like `attachSnow`, this needs the per-instance `cellIndex` attribute that
 * `buildScatterMeshes` puts on every scatter mesh, and stays inert until
 * {@link configureSeason} supplies a climate. Safe on a material that already
 * has an `onBeforeCompile`, and idempotent.
 *
 * @example
 * // A wood that turns, standing in a wood that doesn't.
 * const broadleaf = new THREE.MeshLambertMaterial({ color: 0x6f9c3a });
 * attachSeasonalTint(broadleaf, { blossom: 0xf2a8c8, blossomShare: 0.6 });
 * attachSnow(broadleaf);
 *
 * const pine = new THREE.MeshLambertMaterial({ color: 0x35592a });
 * attachSnow(pine);            // snow, but no turn
 *
 * configureSeason(broadleaf, climate);
 * configureSeason(pine, climate);
 */
export function attachSeasonalTint(material: THREE.Material, opts: FoliageTintOptions = {}): void {
  if (material.userData?.[ATTACHED]) {
    styleFoliage(material, opts); // already tinted — restyle without unbinding
    return;
  }

  // The material's own color is the right summer reference: it *is* the surface
  // as authored, so the ratio against it comes out at exactly 1 in high summer.
  const ownColor = (material as THREE.MeshBasicMaterial).color;
  const summer   = opts.summer ?? (ownColor ? ownColor.getHex() : undefined);

  // Shared with any other seasonal effect on this material, by identity — see
  // seasonBindingUniforms.
  const uniforms = { ...seasonBindingUniforms(material), ...foliageUniforms({ summer }) };
  material.userData[ATTACHED] = uniforms;

  const prior = material.onBeforeCompile;
  // A material's default program cache key is its onBeforeCompile source, and
  // every patched material would otherwise share one — fold the original hook's
  // text in so a tinted tree and a tinted bush stay distinct programs.
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
  ${FOLIAGE_GLSL}`)
      // Into diffuseColor, before lighting, for the same reason snow goes
      // there: autumn leaves have to shade and shadow like the model they are
      // part of. After <color_fragment> so a merged trunk-and-canopy mesh's
      // vertex colors are already in — that is what the green test reads.
      .replace(SEASON_COLOR_SLOT, /* glsl */`
  if (uSeasonEnabled > 0.5) {
    diffuseColor.rgb = seasonalFoliage(diffuseColor.rgb, vSeasonTemp, vSeasonSeed);
  }
  ${SEASON_COLOR_SLOT}`);
  };
  material.customProgramCacheKey = () => `${ownKey ? ownKey() : priorSource}|hex-world-foliage`;
  material.needsUpdate = true;

  // Blossom defaults on here and nowhere else. The uniforms are shared with the
  // terrain shader, and a flowering hillside is not the same idea as a
  // flowering tree — this call is the one that says "this is a plant".
  // `blossomStrength: 0` in opts still wins, for an evergreen-looking shrub.
  styleFoliage(material, { blossomStrength: DEFAULT_BLOSSOM_STRENGTH, ...opts });
}

/** True if {@link attachSeasonalTint} has already patched this material. */
export function hasSeasonalTint(material: THREE.Material): boolean {
  return Boolean(material.userData?.[ATTACHED]);
}
