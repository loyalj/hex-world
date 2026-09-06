import type * as THREE from 'three';
import type { HexMap } from '../map/HexMap.js';
import { offsetNeighbor } from '../math/HexCoord.js';
import { DEFAULT_WATER_TERRAIN_INDEX } from './TerrainTypes.js';

// ---------------------------------------------------------------------------
// Core resolved types (hold live Three.js objects — not serializable)
// ---------------------------------------------------------------------------

/** Three.js geometry + material for one scatter variant. Stored in the asset registry. */
export interface ScatterAsset {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

/** Resolved scatter variant: asset geometry/material combined with placement params. */
export interface FeatureCollection {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** World-units to lift the mesh so its base sits at ground level. */
  yOffset: number;
}

/** [densityTier 0–2][variant index within that tier] */
export type ScatterLayerConfig = FeatureCollection[][];

// ---------------------------------------------------------------------------
// Serializable descriptor types (JSON-safe — go in map save files)
// ---------------------------------------------------------------------------

/** Serializable reference to one (tier, variant) slot. */
export interface ScatterVariantDescriptor {
  assetId: string;
  yOffset: number;
  /**
   * Uniform scale applied to the asset for this slot. Default 1. Three tiers
   * of one asset at 1 / 0.75 / 0.5 is how a plant gets its sizes without
   * three assets.
   */
  scale?: number;
}

/**
 * Where a definition may spawn, beyond `allowedTerrains`. Resolved into the
 * definition's `canSpawnAt` by {@link resolveScatterDefinition}.
 */
export interface ScatterPlacementRules {
  /** Lowest cell elevation, inclusive. */
  minElevation?: number;
  /** Highest cell elevation, inclusive. */
  maxElevation?: number;
  /** Only cells with a liquid neighbour — palms on a beach, reeds by a lake. */
  shore?: boolean;
  /** Skip cells a river runs through. */
  avoidRivers?: boolean;
}

/**
 * Per-density-level hash cutoffs, indexed `[level - 1][tier]`: a slot whose
 * spawn hash falls below `thresholds[level-1][tier]` (and above the previous
 * tier's) draws that tier. The default table fills 40 / 60 / 80 % of slots
 * for levels 1 / 2 / 3, with the dense tier only reached at level 3.
 */
export type ScatterThresholds = readonly (readonly [number, number, number])[];

/**
 * Fully serializable description of a scatter layer.
 * Embeds in a map save file. Does not hold Three.js objects — assets are
 * referenced by stable string ID and resolved at load time via a registry.
 */
export interface ScatterDescriptor {
  id: string;
  name: string;
  /** Feature layer slot index in `HexMap.featureData`. Must be unique per map. */
  layerIndex: number;
  /** [tier 0=dense → tier 2=sparse][variant within tier] */
  tiers: ScatterVariantDescriptor[][];
  /** If set, only cells whose terrain type index is in this list can host this scatter. */
  allowedTerrains?: number[];
  /** Random X/Z tilt applied to each instance matrix (radians). 0 = upright only. */
  tiltStrength?: number;
  /** Elevation band, shore, and river rules — see {@link ScatterPlacementRules}. */
  placement?: ScatterPlacementRules;
  /** Own density curve; omit for the shared default. See {@link ScatterThresholds}. */
  thresholds?: ScatterThresholds;
}

// ---------------------------------------------------------------------------
// Asset registry
// ---------------------------------------------------------------------------

/**
 * Maps stable string asset IDs to Three.js geometry + material pairs.
 * Populated by the game or editor at startup before any maps are loaded.
 * Use `resolveScatterDefinition` to combine a registry with a `ScatterDescriptor`.
 */
export type ScatterAssetRegistry = Map<string, ScatterAsset>;

// ---------------------------------------------------------------------------
// Runtime definition (descriptor + resolved Three.js assets)
// ---------------------------------------------------------------------------

/**
 * Runtime scatter definition consumed by `ChunkManager` and `buildScatterMeshes`.
 *
 * Can be built two ways:
 *  - Directly: construct with inline `tiers` (procedural geometry, demo/test use).
 *  - Via registry: call `resolveScatterDefinition(descriptor, registry)` at load time.
 */
export interface ScatterDefinition {
  id: string;
  name: string;
  /** Feature layer slot index in `HexMap.featureData`. Must be unique per map. */
  layerIndex: number;
  tiers: ScatterLayerConfig;
  /** If set, only cells whose terrain type index is in this list can host this scatter. */
  allowedTerrains?: number[];
  /** Custom per-cell filter applied after `allowedTerrains`. */
  canSpawnAt?(map: HexMap, col: number, row: number): boolean;
  /** Random X/Z tilt applied to each instance matrix (radians). 0 = upright only. */
  tiltStrength?: number;
  /** Own density curve; omit for the shared default. See {@link ScatterThresholds}. */
  thresholds?: ScatterThresholds;
}

export interface ResolveScatterOptions {
  /** Which terrains are liquid, for the `shore` placement rule. Default: the built-in water index. */
  isLiquid?: (terrain: number) => boolean;
}

/** `canSpawnAt` for a set of placement rules, or undefined when there are none. */
export function placementFilter(
  rules: ScatterPlacementRules | undefined,
  isLiquid: (terrain: number) => boolean = t => t === DEFAULT_WATER_TERRAIN_INDEX,
): ((map: HexMap, col: number, row: number) => boolean) | undefined {
  if (!rules) return undefined;
  const { minElevation, maxElevation, shore, avoidRivers } = rules;
  if (minElevation === undefined && maxElevation === undefined && !shore && !avoidRivers) return undefined;
  return (map, col, row) => {
    const e = map.getElevation(col, row);
    if (minElevation !== undefined && e < minElevation) return false;
    if (maxElevation !== undefined && e > maxElevation) return false;
    if (avoidRivers && map.hasRiver(col, row)) return false;
    if (shore) {
      let wet = false;
      for (let d = 0; d < 6 && !wet; d++) {
        const nb = offsetNeighbor(col, row, d);
        wet = map.inBounds(nb.col, nb.row) && isLiquid(map.getTerrain(nb.col, nb.row));
      }
      if (!wet) return false;
    }
    return true;
  };
}

// ---------------------------------------------------------------------------
// Resolution helper
// ---------------------------------------------------------------------------

/**
 * Resolves a serializable `ScatterDescriptor` into a runtime `ScatterDefinition`
 * by looking up each `assetId` in the provided registry.
 *
 * Throws with the missing ID if any asset cannot be found, so load failures are
 * caught early rather than silently producing empty scatter.
 */
export function resolveScatterDefinition(
  descriptor: ScatterDescriptor,
  registry: ScatterAssetRegistry,
  opts: ResolveScatterOptions = {},
): ScatterDefinition {
  const tiers: ScatterLayerConfig = descriptor.tiers.map(tier =>
    tier.map(variant => {
      const asset = registry.get(variant.assetId);
      if (!asset) throw new Error(`resolveScatterDefinition: unknown asset ID "${variant.assetId}"`);
      const s = variant.scale ?? 1;
      // A scaled slot takes its own copy: the registry's geometry is shared
      // by every slot that names the asset, and scaling it in place would
      // shrink them all.
      const geometry = s === 1 ? asset.geometry : asset.geometry.clone().scale(s, s, s);
      return { geometry, material: asset.material, yOffset: variant.yOffset * s };
    })
  );
  return {
    id:              descriptor.id,
    name:            descriptor.name,
    layerIndex:      descriptor.layerIndex,
    tiers,
    allowedTerrains: descriptor.allowedTerrains,
    canSpawnAt:      placementFilter(descriptor.placement, opts.isLiquid),
    tiltStrength:    descriptor.tiltStrength,
    thresholds:      descriptor.thresholds,
  };
}
