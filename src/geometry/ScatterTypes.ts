import type * as THREE from 'three';
import type { HexMap } from '../map/HexMap.js';
import type { TerrainType } from '../map/HexCell.js';

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
}

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
  /** If set, only cells whose terrain type is in this list can host this scatter. */
  allowedTerrains?: TerrainType[];
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
  /** If set, only cells whose terrain type is in this list can host this scatter. */
  allowedTerrains?: TerrainType[];
  /** Custom per-cell filter applied after `allowedTerrains`. */
  canSpawnAt?(map: HexMap, col: number, row: number): boolean;
  /** Random X/Z tilt applied to each instance matrix (radians). 0 = upright only. */
  tiltStrength?: number;
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
): ScatterDefinition {
  const tiers: ScatterLayerConfig = descriptor.tiers.map(tier =>
    tier.map(variant => {
      const asset = registry.get(variant.assetId);
      if (!asset) throw new Error(`resolveScatterDefinition: unknown asset ID "${variant.assetId}"`);
      return { geometry: asset.geometry, material: asset.material, yOffset: variant.yOffset };
    })
  );
  return {
    id:              descriptor.id,
    name:            descriptor.name,
    layerIndex:      descriptor.layerIndex,
    tiers,
    allowedTerrains: descriptor.allowedTerrains,
  };
}
