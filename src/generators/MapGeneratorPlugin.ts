import type { HexMap } from '../map/HexMap.js';

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
   * Fills every cell of an already-constructed, already-cleared map.
   * Caller owns the map; the plugin does not resize or recreate it.
   * Same seed + same config + same map dimensions must always produce the same result.
   */
  generate(map: HexMap, config: TConfig, seed: number): void;
}
