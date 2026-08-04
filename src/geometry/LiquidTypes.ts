import * as THREE from 'three';
import { createWaterMaterial } from './WaterMaterial.js';
import { createWaterShoreMaterial } from './WaterShoreMaterial.js';
import { createEstuaryMaterial } from './EstuaryMaterial.js';
import { createRiverMaterial } from './RiverMaterial.js';
import { createWaterfallFoamMaterial, createWaterfallSprayMaterial } from './WaterfallMaterial.js';

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

  // --- Waterfalls -----------------------------------------------------------
  // A liquid's falls inherit its foam color, flow speed, wave scale, foam
  // intensity, and emissive glow, so a new liquid looks right before touching
  // any of these. Reach for them when the inherited look is wrong for the
  // substance: thick liquids want a low, heavy, sparse spray; volatile ones
  // want a fine cloud carrying much further downstream.

  /**
   * Spray density multiplier. 0 emits no mist particles (the plunge pool still
   * renders — silence that with `foamIntensity: 0`). Default 1.
   */
  sprayIntensity?: number;
  /**
   * Hex color of the mist. Defaults to `foamColor` — override where the vapor
   * a liquid throws isn't the color of its foam (lava's ash, acid's fumes).
   */
  sprayColor?: number;
  /**
   * How far a puff climbs over its life, world units — the liquid's "energy"
   * knob. Mist rises monotonically (no ballistic arc), so this is the height
   * the cloud reaches. Default 0.75; a viscous liquid barely clears its pool
   * at ~0.3.
   */
  sprayRise?: number;
  /**
   * Whether the spray rises or is thrown, 0–1 — the axis that separates the
   * two things "spray" can mean.
   *
   * At 0 it is mist: it climbs steadily, wanders on turbulence, swells and
   * thins as it goes, and never falls back. At 1 it is spatter: a real
   * ballistic arc that peaks and lands, flying outward from the impact,
   * holding its size and opacity until it dies, and largely ignoring air
   * currents. Per-particle alpha is allowed higher as this rises, since
   * thrown droplets separate instead of stacking up.
   *
   * Default 0. Water and acid are mist; the built-in lava is 1.
   */
  sprayArc?: number;
  /** How far downstream spray carries over its life, world units. Default 0.55. */
  sprayDrift?: number;
  /**
   * Particle size in pixels at 110 world units of depth (attenuation is
   * clamped, so this is not the on-screen size up close). Default 3.5. Bigger
   * reads as slow smoke or steam, smaller as fine water mist.
   */
  spraySize?: number;
  /**
   * Plunge-pool footprint multiplier, relative to the width of the falling
   * sheet. Default 1; below that the churn stays tight under the fall.
   */
  poolScale?: number;
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
  /** Plunge-pool foam at the foot of each waterfall. Omit to skip the layer. */
  waterfallFoam?: THREE.Material;
  /** Waterfall spray particles (a `THREE.Points` material). Omit to skip the layer. */
  waterfallSpray?: THREE.Material;
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
  // A lava fall doesn't mist — molten rock is THROWN. `sprayArc: 1` swaps the
  // rising cloud for ballistic spatter that arcs out of the impact and lands,
  // sparse and heavy, holding its size. Dark ash color, but the liquid's own
  // emissive lights each droplet from within, so they read as glowing embers.
  { id: 'lava',  name: 'Lava',
    shallowColor: 0xd45a10, deepColor: 0xffb832, foamColor: 0xf2b24c,
    opacity: 1.0, flowSpeed: 0.25, waveScale: 0.5,
    emissiveColor: 0xff5a00, emissiveStrength: 0.6,
    sprayIntensity: 0.55, sprayColor: 0x4a3b33, sprayArc: 1, sprayRise: 0.45,
    sprayDrift: 0.3, spraySize: 6, poolScale: 0.75 },
  // Acid is thin and volatile — a fine, pale fume cloud carried well past the
  // fall, over a pool that spreads wider than water's.
  { id: 'acid',  name: 'Acid',
    shallowColor: 0x4db318, deepColor: 0x266608, foamColor: 0xb3f266,
    opacity: 0.9, flowSpeed: 0.6,
    emissiveColor: 0x66ff33, emissiveStrength: 0.15,
    sprayIntensity: 1.2, sprayColor: 0xd8ffa8, sprayRise: 0.9,
    sprayDrift: 0.8, spraySize: 3, poolScale: 1.15 },
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
    waterfallFoam:  createWaterfallFoamMaterial(appearance),
    waterfallSpray: createWaterfallSprayMaterial({
      ...appearance,
      // Spray falls back to the liquid's foam color when it has no color of
      // its own — the common case, and what makes water look right untuned.
      foam:    descriptor.sprayColor != null ? new THREE.Color(descriptor.sprayColor) : appearance.foam,
      rise:    descriptor.sprayRise,
      arc:     descriptor.sprayArc,
      drift:   descriptor.sprayDrift,
      size:    descriptor.spraySize,
    }),
  };
}

/**
 * Every material in a set, in render order — the canonical iteration order for
 * per-frame uniform pushes (time, light tint, cloud shadows) and disposal.
 * Sets built by hand may leave layers out, so entries can be undefined.
 */
export function liquidMaterialList(set: LiquidMaterialSet): (THREE.Material | undefined)[] {
  return [set.surface, set.shore, set.estuary, set.river, set.waterfallFoam, set.waterfallSpray];
}
