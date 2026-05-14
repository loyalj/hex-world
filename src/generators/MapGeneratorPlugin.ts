import type { HexMap } from '../map/HexMap.js';

/**
 * Describes a single editable field in a generator's config.
 * Keys may use dot notation for nested paths (e.g. "climate.cycles").
 * Consumers can use this to render controls generically for any plugin.
 */
export interface ConfigFieldDescriptor {
  /** Dot-notation path into the config object, e.g. "terrain.period" or "regionCount". */
  key: string;
  /** Human-readable label for the control. */
  label: string;
  /** Control type. 'integer' renders a stepped number input with no decimals. */
  type: 'number' | 'integer' | 'boolean' | 'select';
  /** Runtime default used when the field is absent from the config. */
  default: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  /** For 'select' type only. */
  options?: { value: string | number; label: string }[];
  /** Groups related fields together in the UI, e.g. "Terrain", "Climate". */
  group?: string;
}

/**
 * Common interface for all map generators.
 * Raw generator functions remain exported for library consumers;
 * this interface is for the demo/game plugin system (dropdown + R/G keys).
 */
export interface MapGeneratorPlugin<TConfig = unknown> {
  /** Unique registry key, e.g. 'fbm'. */
  readonly id: string;
  /** Display name shown in UI, e.g. 'FBM (fast)'. */
  readonly name: string;
  /** Starting config — used to populate controls and as serialisation baseline. */
  readonly defaultConfig: TConfig;
  /**
   * Describes every user-facing config field for generic UI rendering.
   * Internal fields (noise offsets, jitter channels, etc.) are omitted.
   * Keys use dot notation for nested paths.
   */
  readonly configSchema?: ConfigFieldDescriptor[];
  /**
   * Fills every cell of an already-constructed, already-cleared map.
   * Caller owns the map; the plugin does not resize or recreate it.
   * Same seed + same config + same map dimensions must always produce the same result.
   */
  generate(map: HexMap, config: TConfig, seed: number): void;
}
