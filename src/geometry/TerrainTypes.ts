import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Serializable descriptor types (JSON-safe — go in map save files)
// ---------------------------------------------------------------------------

export interface TerrainTextureDescriptor {
  /** 'procedural' = noise-based from color; 'image' = loaded from asset registry */
  type: 'procedural' | 'image';
  /** For 'image': stable asset ID looked up in TerrainAssetRegistry */
  assetId?: string;
  /** For 'procedural': noise spatial frequency override. Higher = finer grain. */
  noiseFrequency?: number;
}

/**
 * Serializable description of one terrain type.
 * Embed in map save files via MapSerializer. Does not hold Three.js objects.
 */
export interface TerrainDescriptor {
  /** uint8 value (0–255) stored in HexMap cell data. Must be unique per map. */
  index: number;
  /** Stable string key — used in save files to identify this type. */
  id: string;
  /** Display name for editors and HUDs. */
  name: string;
  /** Hex color for vertex blending and flat-color rendering. */
  color: number;
  /** Road color as linear RGB 0–1. If omitted, derived from color at resolve time. */
  roadColor?: [number, number, number];
  /**
   * ID of the LiquidTypeDescriptor this terrain belongs to (e.g. 'water', 'lava', 'acid').
   * When set, cells of this type receive liquid surface, shore foam, estuary, and river
   * geometry for that liquid type. Also tells generators and scatter to treat this as liquid.
   * Takes precedence over the legacy `isWater` flag.
   */
  liquidType?: string;
  /**
   * Legacy alias for `liquidType: 'water'`. Prefer `liquidType` for new descriptors.
   * Ignored when `liquidType` is also set.
   */
  isWater?: boolean;
  /** How to build the texture atlas slice for this type. */
  texture: TerrainTextureDescriptor;
  /**
   * Pathfinding cost multiplier for crossing this terrain on a road.
   * Defaults to 1.0 (neutral cost). Higher values make the tile more expensive to traverse.
   */
  roadCost?: number;
}

// ---------------------------------------------------------------------------
// Asset registry
// ---------------------------------------------------------------------------

/**
 * Maps stable string asset IDs to image sources for terrain texture slices.
 * Populate at startup before calling buildTerrainTextureArray.
 */
export type TerrainAssetRegistry = Map<string, string | HTMLImageElement | ImageBitmap>;

// ---------------------------------------------------------------------------
// Runtime definition (descriptor + resolved Three.js objects)
// ---------------------------------------------------------------------------

/**
 * Runtime terrain definition consumed by ChunkManager and all geometry builders.
 * Build via resolveTerrainDefinitions(descriptors).
 */
export interface TerrainDefinition {
  index: number;
  id: string;
  name: string;
  /** Resolved Three.js Color for vertex blending. */
  color: THREE.Color;
  /** Road color as linear RGB 0–1. */
  roadColor: [number, number, number];
  /**
   * ID of the liquid type this terrain belongs to, or undefined for solid terrain.
   * Matches a LiquidTypeDescriptor.id.
   */
  liquidType: string | undefined;
  /** True if this type belongs to any liquid type (convenience alias for !!liquidType). */
  isWater: boolean;
  /** Texture descriptor, carried through for buildTerrainTextureArray. */
  texture: TerrainTextureDescriptor;
  /** Pathfinding cost multiplier for road traversal. Always present; defaults to 1.0. */
  roadCost: number;
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolves serializable TerrainDescriptors into runtime TerrainDefinitions.
 * Does not touch the texture atlas — call buildTerrainTextureArray separately.
 */
export function resolveTerrainDefinitions(descriptors: TerrainDescriptor[]): TerrainDefinition[] {
  return descriptors.map(d => {
    const c = new THREE.Color(d.color);
    const roadColor: [number, number, number] = d.roadColor ?? [
      c.r * 0.65,
      c.g * 0.60,
      c.b * 0.55,
    ];
    const liquidType = d.liquidType ?? (d.isWater ? 'water' : undefined);
    return {
      index:      d.index,
      id:         d.id,
      name:       d.name,
      color:      c,
      roadColor,
      liquidType,
      isWater:    liquidType !== undefined,
      texture:    d.texture,
      roadCost:   d.roadCost ?? 1.0,
    };
  });
}

/**
 * Builds a Set of terrain type indices that count as water (any liquid type).
 * Used for scatter exclusion and other all-liquid checks.
 */
export function buildWaterTerrainSet(definitions: TerrainDefinition[]): Set<number> {
  return new Set(definitions.filter(d => d.isWater).map(d => d.index));
}

/**
 * Builds a map from liquid type ID → Set of terrain indices belonging to that liquid.
 * Each entry drives one set of liquid surface / shore / estuary / river meshes in ChunkManager.
 */
export function buildLiquidTerrainSets(definitions: TerrainDefinition[]): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const def of definitions) {
    if (!def.liquidType) continue;
    let s = result.get(def.liquidType);
    if (!s) { s = new Set(); result.set(def.liquidType, s); }
    s.add(def.index);
  }
  return result;
}

/**
 * Builds a lookup Map from terrain index → TerrainDefinition.
 * Geometry builders use this for O(1) color / road-color access.
 */
export function buildTerrainLookup(definitions: TerrainDefinition[]): Map<number, TerrainDefinition> {
  return new Map(definitions.map(d => [d.index, d]));
}

// ---------------------------------------------------------------------------
// Default terrain types (the built-in six, matching TerrainType enum values)
// ---------------------------------------------------------------------------

export const DEFAULT_TERRAIN_DESCRIPTORS: TerrainDescriptor[] = [
  {
    index: 0, id: 'grassland', name: 'Grassland', color: 0x86b888,
    roadColor: [0.50, 0.43, 0.33], roadCost: 1,
    texture: { type: 'procedural' },
  },
  {
    index: 1, id: 'desert', name: 'Desert', color: 0xc8bea0,
    roadColor: [0.54, 0.46, 0.34], roadCost: 2,
    texture: { type: 'procedural', noiseFrequency: 256 },
  },
  {
    index: 2, id: 'snow', name: 'Snow', color: 0xd5e6f5,
    roadColor: [0.36, 0.41, 0.52], roadCost: 3,
    texture: { type: 'procedural' },
  },
  {
    index: 3, id: 'mud', name: 'Mud', color: 0xa08870,
    roadColor: [0.35, 0.27, 0.16], roadCost: 3,
    texture: { type: 'procedural' },
  },
  {
    index: 4, id: 'rock', name: 'Rock', color: 0xa3adb5,
    roadColor: [0.46, 0.46, 0.45], roadCost: 5,
    texture: { type: 'procedural', noiseFrequency: 64 },
  },
  {
    index: 5, id: 'water', name: 'Water', color: 0x4a8fb5,
    roadColor: [0.42, 0.46, 0.50], roadCost: 1,
    liquidType: 'water',
    texture: { type: 'procedural' },
  },
];

export const DEFAULT_TERRAIN_DEFINITIONS: TerrainDefinition[] =
  resolveTerrainDefinitions(DEFAULT_TERRAIN_DESCRIPTORS);

// Kept for backward-compat lookup by TerrainType enum value (same as index).
export const DEFAULT_TERRAIN_LOOKUP: Map<number, TerrainDefinition> =
  buildTerrainLookup(DEFAULT_TERRAIN_DEFINITIONS);

/** The default water terrain index (TerrainType.Water = 5). */
export const DEFAULT_WATER_TERRAIN_INDEX: number = 5;
