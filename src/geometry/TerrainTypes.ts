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
   * If true, cells of this type receive water surface, shore foam, and estuary
   * geometry. Also tells generators and scatter to treat this as water.
   */
  isWater?: boolean;
  /** How to build the texture atlas slice for this type. */
  texture: TerrainTextureDescriptor;
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
  /** True if this type receives water surface / shore / estuary geometry. */
  isWater: boolean;
  /** Texture descriptor, carried through for buildTerrainTextureArray. */
  texture: TerrainTextureDescriptor;
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
    return {
      index:    d.index,
      id:       d.id,
      name:     d.name,
      color:    c,
      roadColor,
      isWater:  d.isWater ?? false,
      texture:  d.texture,
    };
  });
}

/**
 * Builds a Set of terrain type indices that count as water.
 * Pass to geometry builders and generators via their options.
 */
export function buildWaterTerrainSet(definitions: TerrainDefinition[]): Set<number> {
  return new Set(definitions.filter(d => d.isWater).map(d => d.index));
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
    roadColor: [0.50, 0.43, 0.33],
    texture: { type: 'procedural' },
  },
  {
    index: 1, id: 'desert', name: 'Desert', color: 0xc8bea0,
    roadColor: [0.54, 0.46, 0.34],
    texture: { type: 'procedural', noiseFrequency: 256 },
  },
  {
    index: 2, id: 'snow', name: 'Snow', color: 0xd5e6f5,
    roadColor: [0.36, 0.41, 0.52],
    texture: { type: 'procedural' },
  },
  {
    index: 3, id: 'mud', name: 'Mud', color: 0xa08870,
    roadColor: [0.35, 0.27, 0.16],
    texture: { type: 'procedural' },
  },
  {
    index: 4, id: 'rock', name: 'Rock', color: 0xa3adb5,
    roadColor: [0.46, 0.46, 0.45],
    texture: { type: 'procedural', noiseFrequency: 64 },
  },
  {
    index: 5, id: 'water', name: 'Water', color: 0x4a8fb5,
    roadColor: [0.42, 0.46, 0.50],
    isWater: true,
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
