import * as THREE from 'three';
import type { ScatterAsset, ScatterAssetRegistry } from './ScatterTypes.js';
import { buildShapeGeometry, recipeFoliageColor, type ScatterRecipe } from './ScatterRecipes.js';
import { fitHeight } from './ScatterShapes.js';
import { createRockMaterial } from './RockMaterial.js';
import { attachWindSway, type WindSwayOptions } from '../weather/WindSway.js';
import { attachSeasonalTint } from '../season/TintAttach.js';
import { attachScatterTexture } from './ScatterTexture.js';

/**
 * Serializable scatter assets: the shape **and** the material behaviour, as
 * JSON, so a map builder's plant survives a save and a `.hexpack` with its
 * wind, seasons, and texture intact. Before this the descriptor named an
 * `assetId` and left the material to whoever loaded the pack, which is why a
 * loaded pack's trees never swayed.
 */

/** Marker on `material.userData` that {@link resolveScatterMaterial} sets for `snow: false`; HexWorld honours it. */
export const NO_SNOW_KEY = 'hexWorldNoSnow';

export interface ScatterMaterialDescriptor {
  /** Flat colour, used only when `vertexColors` is off. */
  color?: number;
  /** Take colour from the geometry's vertex colours. Default true for shapes, false for models. */
  vertexColors?: boolean;
  /** Below 1 the material is transparent and stops writing depth (smoke, mist). Default 1. */
  opacity?: number;
  /** Render both faces — fronds and any single-sided plane need it. Default false. */
  doubleSide?: boolean;
  /** Faceted shading. Default true. */
  flatShading?: boolean;
  /** Bend in the wind (`attachWindSway`). `true` for the defaults, an object to tune. Default false. */
  windSway?: boolean | WindSwayOptions;
  /**
   * Turn with the seasons (`attachSeasonalTint`). `true` takes the recipe's
   * canopy colour as the summer reference; an object can override it and
   * tune the spread, blossom share, and the colour test. Default false.
   */
  seasonalTint?: boolean | { summer?: number; variance?: number; blossomShare?: number; select?: number; strength?: number };
  /** Catch snow. Default true; false keeps a smoke plume or a lantern bare. */
  snow?: boolean;
  /** Fine brightness mottling (`attachScatterTexture`), 0–1. Default 0 = off. */
  scatterTexture?: number;
  /** Mottling frequency — coarser for one smooth cone, finer for small lobes. Default the attach call's. */
  scatterTextureScale?: number;
  /** Use the strata-banded rock material instead of a plain Lambert. Default false. */
  rock?: boolean;
}

export interface ScatterAssetDescriptor {
  /** Stable id the descriptor tiers reference by `assetId`. */
  id: string;
  name?: string;
  /** `shape`: built from `recipe`. `model`: a GLB in the pack's `models/`, keyed by this id. */
  type: 'shape' | 'model';
  recipe?: ScatterRecipe;
  /** For models: scale to this overall height. Omit to keep the file's units. */
  height?: number;
  material?: ScatterMaterialDescriptor;
}

/**
 * Build a material from its descriptor and attach the behaviours it asks
 * for. Atmosphere haze and snow are not attached here: `HexWorld` does both
 * for every scatter material it is handed (and skips snow where the
 * descriptor said no), and an à-la-carte consumer calls `attachAtmosphere` /
 * `attachSnow` itself as before.
 */
export function resolveScatterMaterial(desc: ScatterMaterialDescriptor = {}, recipe?: ScatterRecipe): THREE.Material {
  const vertexColors = desc.vertexColors ?? recipe !== undefined;
  const opacity      = desc.opacity ?? 1;
  const material = desc.rock
    ? createRockMaterial(desc.color ?? 0x888880)
    : new THREE.MeshLambertMaterial({
        color:        vertexColors ? 0xffffff : (desc.color ?? 0x888888),
        vertexColors,
        flatShading:  desc.flatShading ?? true,
        transparent:  opacity < 1,
        opacity,
        depthWrite:   opacity >= 1,
        side:         desc.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
      });
  if (desc.rock && vertexColors) material.vertexColors = true;

  if (desc.windSway) attachWindSway(material, desc.windSway === true ? {} : desc.windSway);
  if (desc.seasonalTint) {
    const tint   = desc.seasonalTint === true ? {} : desc.seasonalTint;
    const summer = tint.summer ?? (recipe ? recipeFoliageColor(recipe) : undefined) ?? desc.color;
    attachSeasonalTint(material, { ...tint, summer });
  }
  if (desc.scatterTexture && desc.scatterTexture > 0) {
    attachScatterTexture(material, { strength: desc.scatterTexture, scale: desc.scatterTextureScale });
  }
  if (desc.snow === false) material.userData[NO_SNOW_KEY] = true;
  return material;
}

/**
 * Resolve asset descriptors into the registry `resolveScatterDefinition`
 * reads. Shapes need nothing else; models take their geometry from
 * `modelGeometries`, keyed by asset id — what a pack loader or an editor's
 * GLB import produces.
 */
export function resolveScatterAssets(
  descriptors: readonly ScatterAssetDescriptor[],
  modelGeometries?: ReadonlyMap<string, THREE.BufferGeometry>,
): ScatterAssetRegistry {
  const registry: ScatterAssetRegistry = new Map();
  for (const desc of descriptors) {
    let geometry: THREE.BufferGeometry;
    if (desc.type === 'shape') {
      if (!desc.recipe) throw new Error(`resolveScatterAssets: shape asset "${desc.id}" has no recipe`);
      geometry = buildShapeGeometry(desc.recipe);
    } else {
      const model = modelGeometries?.get(desc.id);
      if (!model) throw new Error(`resolveScatterAssets: no model geometry for asset "${desc.id}"`);
      geometry = desc.height ? fitHeight(model.clone(), desc.height) : model;
    }
    const material = resolveScatterMaterial(desc.material, desc.type === 'shape' ? desc.recipe : undefined);
    registry.set(desc.id, { geometry, material } satisfies ScatterAsset);
  }
  return registry;
}
