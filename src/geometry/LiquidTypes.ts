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
  /**
   * Surface alpha, 0–1. Default 0.82 (0.78 for rivers). Lava wants ~1.0 —
   * translucency is the biggest "tinted water" tell for thick liquids.
   */
  opacity?: number;
  /**
   * Animation time multiplier for waves, foam, and river flow. 1 = water
   * default. Lava crawls around 0.2–0.3; energetic liquids go above 1.
   */
  flowSpeed?: number;
  /**
   * Hex color added as self-illumination, scaled by emissiveStrength.
   * Emissive light is only partially dimmed by fog-of-war so lava keeps a
   * glow in explored-but-unseen cells.
   */
  emissiveColor?: number;
  /** Emissive intensity, 0 = none (default). The built-in lava uses 0.6. */
  emissiveStrength?: number;
  /** Surface-noise frequency multiplier. <1 = broader, slower-looking swells. Default 1. */
  waveScale?: number;
  /** Shore/estuary foam intensity multiplier. 0 disables foam. Default 1. */
  foamIntensity?: number;
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
  // Lava inverts the usual depth reading: deepColor is HOTTER, not darker, so
  // the pool center looks molten while the edges read as cooling crust.
  { id: 'lava',  name: 'Lava',
    shallowColor: 0xd45a10, deepColor: 0xffb832, foamColor: 0xf2b24c,
    opacity: 1.0, flowSpeed: 0.25, waveScale: 0.5,
    emissiveColor: 0xff5a00, emissiveStrength: 0.6 },
  { id: 'acid',  name: 'Acid',
    shallowColor: 0x4db318, deepColor: 0x266608, foamColor: 0xb3f266,
    opacity: 0.9, flowSpeed: 0.6,
    emissiveColor: 0x66ff33, emissiveStrength: 0.15 },
];

// ---------------------------------------------------------------------------
// Resolution helper
// ---------------------------------------------------------------------------

/**
 * Builds a complete LiquidMaterialSet from a LiquidTypeDescriptor.
 * Colors and appearance fields (opacity, flowSpeed, emissive, waveScale,
 * foamIntensity) are read from the descriptor; anything omitted falls back to
 * the built-in water defaults.
 */
export function resolveLiquidMaterials(descriptor: LiquidTypeDescriptor): LiquidMaterialSet {
  const appearance = {
    shallow: descriptor.shallowColor  != null ? new THREE.Color(descriptor.shallowColor)  : undefined,
    deep:    descriptor.deepColor     != null ? new THREE.Color(descriptor.deepColor)     : undefined,
    foam:    descriptor.foamColor     != null ? new THREE.Color(descriptor.foamColor)     : undefined,
    emissive: descriptor.emissiveColor != null ? new THREE.Color(descriptor.emissiveColor) : undefined,
    opacity:          descriptor.opacity,
    flowSpeed:        descriptor.flowSpeed,
    emissiveStrength: descriptor.emissiveStrength,
    waveScale:        descriptor.waveScale,
    foamIntensity:    descriptor.foamIntensity,
  };
  return {
    surface: createWaterMaterial(appearance),
    shore:   createWaterShoreMaterial(appearance),
    estuary: createEstuaryMaterial(appearance),
    river:   createRiverMaterial(appearance),
  };
}
