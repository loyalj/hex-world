import type * as THREE from 'three';
import { TerrainType } from '../map/HexCell.js';

/**
 * Where a resource is allowed to appear. Consumed by `generateResources`;
 * the renderer ignores it, so hand-placed resources can break any of these rules.
 */
export interface ResourcePlacementRule {
  /** Terrain indices this resource can sit on. Omit to allow every terrain. */
  allowedTerrains?: number[];
  /** Inclusive elevation window. */
  minElevation?: number;
  maxElevation?: number;
  /** Require a river through the cell (river fish, mill sites). */
  requiresRiver?: boolean;
  /**
   * Require a *land* cell touching a liquid cell (shellfish, salt, ports).
   * Mutually sensible with `requiresLiquid`, which is the open-water case.
   */
  requiresCoast?: boolean;
  /** Require the cell itself to be liquid (ocean fish, whales). */
  requiresLiquid?: boolean;
  /**
   * Require a scatter layer's density level at or above `level` — how
   * "forest yield" attaches itself to cells that actually have trees.
   */
  minFeatureLevel?: { layer: number; level: number };
  /**
   * Climate window, matched against the temperature/moisture fields
   * `ClimateSimulator` produces (both 0–1). Terrain already encodes the biome
   * coarsely; these narrow a resource to part of one — cotton in the warm,
   * damp end of grassland rather than all of it.
   *
   * Ignored unless the corresponding field is handed to `generateResources`.
   */
  minTemperature?: number;
  maxTemperature?: number;
  minMoisture?: number;
  maxMoisture?: number;
  /** Chance of spawning on an otherwise eligible cell, 0–1. Default 0.05. */
  frequency?: number;
  /**
   * Minimum hex distance between two deposits of this resource. Default 0
   * (no spacing). Raise it to break up the clumps that pure per-cell chance
   * produces — 2–3 reads as "scattered deposits" rather than "ore country".
   */
  minSpacing?: number;
}

/**
 * A resource type — ore, fish, forest yield. Fully JSON-serializable, so a
 * resource set rides through a `.hexpack` manifest and a map's save file the
 * same way terrain, liquid, and scatter descriptors do, and a pack can carry
 * resources this library has never heard of.
 */
export interface ResourceDescriptor {
  /** Stable id written into the map's metadata channel. Keep it short — it is stored per cell. */
  id: string;
  name: string;
  /** Icon tint. Also the fallback marker color when no icon texture is resolved. */
  color: number;
  /**
   * Icon texture id, resolved through the registry passed to `ResourceLayer`.
   * Without one (or without a matching entry) the resource draws as a flat
   * colored disc, which is enough to read a map during development.
   */
  iconAssetId?: string;
  /** Billboard width in world units. Default 0.55. */
  size?: number;
  /** Height of the icon above the cell surface. Default 0.8. */
  yOffset?: number;
  /** Placement rules for the generation pass. */
  placement?: ResourcePlacementRule;
  /**
   * Free-form per-turn yields (`{ food: 2, production: 1 }`) or any other
   * game-specific numbers. The library never reads these — they ride along so
   * a pack's resources arrive with their rules attached.
   */
  yields?: Record<string, number>;
}

/**
 * Icon textures keyed by `ResourceDescriptor.iconAssetId`. Populate it at
 * startup from your own loader; resources whose id is missing fall back to
 * flat colored discs.
 */
export type ResourceIconRegistry = Map<string, THREE.Texture>;

/**
 * Per-cell resource as stored in the metadata channel: a bare type id, or a
 * type id with a quantity for games that deplete deposits.
 */
export type ResourceValue = string | { type: string; amount?: number };

/** A placed resource with its cell, as returned by queries and the generator. */
export interface PlacedResource {
  col: number;
  row: number;
  /** Resource type id. */
  type: string;
  /** Present only when the cell stores a quantity. */
  amount?: number;
}

/** Built-in starter set — enough to see the layer working before a pack supplies its own. */
export const DEFAULT_RESOURCE_DESCRIPTORS: ResourceDescriptor[] = [
  {
    id: 'ore', name: 'Iron Ore', color: 0xb0b6c0,
    yields: { production: 2 },
    placement: {
      allowedTerrains: [TerrainType.Rock, TerrainType.Snow],
      minElevation: 3, frequency: 0.08, minSpacing: 2,
    },
  },
  {
    id: 'gold', name: 'Gold', color: 0xffcc33,
    yields: { gold: 3 },
    placement: {
      allowedTerrains: [TerrainType.Desert, TerrainType.Rock],
      minElevation: 2, frequency: 0.03, minSpacing: 4,
    },
  },
  {
    id: 'fish', name: 'Fish', color: 0x66ccee,
    yields: { food: 2 },
    placement: { requiresLiquid: true, frequency: 0.06, minSpacing: 2 },
  },
  {
    id: 'game', name: 'Game', color: 0xc08040,
    yields: { food: 2 },
    placement: { minFeatureLevel: { layer: 0, level: 2 }, frequency: 0.07, minSpacing: 2 },
  },
];
