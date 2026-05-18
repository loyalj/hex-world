import type * as THREE from 'three';

// ---------------------------------------------------------------------------
// Serializable descriptor (JSON-safe — goes in map save files)
// ---------------------------------------------------------------------------

/**
 * Serializable description of one liquid surface type (water, lava, acid, …).
 * Embed in map save files via MapSerializer alongside TerrainDescriptors.
 */
export interface LiquidTypeDescriptor {
  /** Stable string key — used in save files and to link TerrainDescriptor.liquidType. */
  id: string;
  /** Display name for editors and HUDs. */
  name: string;
  /**
   * Per-type geometry overrides merged over the global WaterGeometryOptions.
   * Leave undefined to inherit the global setting.
   */
  noiseScale?: number;
  perturbStrength?: number;
  surfaceLift?: number;
}

// ---------------------------------------------------------------------------
// Runtime material set
// ---------------------------------------------------------------------------

/**
 * Set of Three.js materials used to render one liquid type.
 * Pass inside `liquidMaterials` on ChunkManagerOptions.
 */
export interface LiquidMaterialSet {
  /** Standing body surface mesh material. */
  surface?: THREE.Material;
  /** Shore foam strip mesh material. */
  shore?: THREE.Material;
  /** Estuary (river-mouth) mesh material. */
  estuary?: THREE.Material;
  /** River channel mesh material. */
  river?: THREE.Material;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * The three built-in liquid types.
 * Custom games can extend this array and register new terrain types that
 * reference their custom liquid IDs.
 */
export const DEFAULT_LIQUID_DESCRIPTORS: LiquidTypeDescriptor[] = [
  { id: 'water', name: 'Water' },
  { id: 'lava',  name: 'Lava' },
  { id: 'acid',  name: 'Acid' },
];
