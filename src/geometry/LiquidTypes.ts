import * as THREE from 'three';
import { createWaterMaterial } from './WaterMaterial.js';
import { createWaterShoreMaterial } from './WaterShoreMaterial.js';
import { createEstuaryMaterial } from './EstuaryMaterial.js';
import { createRiverMaterial } from './RiverMaterial.js';

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
  /**
   * Hex colors (e.g. 0x4a8fb5) used by resolveLiquidMaterials to build the material set.
   * Omit to use the built-in water defaults.
   */
  shallowColor?: number;
  deepColor?: number;
  foamColor?: number;
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
 * The three built-in liquid types with default colors.
 * Custom games can extend this array and register new terrain types that
 * reference their custom liquid IDs.
 */
export const DEFAULT_LIQUID_DESCRIPTORS: LiquidTypeDescriptor[] = [
  { id: 'water', name: 'Water',
    shallowColor: 0x527fb3, deepColor: 0x1e477a, foamColor: 0xeaf3ff },
  { id: 'lava',  name: 'Lava',
    shallowColor: 0xe6670d, deepColor: 0x8c1a04, foamColor: 0xf2b24c },
  { id: 'acid',  name: 'Acid',
    shallowColor: 0x4db318, deepColor: 0x266608, foamColor: 0xb3f266 },
];

// ---------------------------------------------------------------------------
// Resolution helper
// ---------------------------------------------------------------------------

/**
 * Builds a complete LiquidMaterialSet from a LiquidTypeDescriptor.
 * Uses the descriptor's shallowColor / deepColor / foamColor fields if present,
 * falling back to the built-in water defaults for any omitted value.
 */
export function resolveLiquidMaterials(descriptor: LiquidTypeDescriptor): LiquidMaterialSet {
  const shallow = descriptor.shallowColor != null ? new THREE.Color(descriptor.shallowColor) : undefined;
  const deep    = descriptor.deepColor    != null ? new THREE.Color(descriptor.deepColor)    : undefined;
  const foam    = descriptor.foamColor    != null ? new THREE.Color(descriptor.foamColor)    : undefined;
  const colors  = (shallow || deep || foam) ? { shallow, deep, foam } : undefined;
  return {
    surface: createWaterMaterial(colors),
    shore:   createWaterShoreMaterial(colors),
    estuary: createEstuaryMaterial(colors),
    river:   createRiverMaterial(colors),
  };
}
