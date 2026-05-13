import { TerrainType } from '../map/HexCell.js';
import type { HexMap } from '../map/HexMap.js';
import { fbm } from '../math/Noise.js';

export interface FbmTerrainOptions {
  /** Horizontal period in cells. Default 64. */
  period?: number;
  /** FBM octave count. Default 6. */
  octaves?: number;
  /** Multiplier applied to the raw FBM output to spread the distribution. Default 2.2. */
  amplitude?: number;
  /** Elevation offset added after rounding (land >= 0, water < 0). Default 4. */
  elevOffset?: number;
  /** Multiplier on n before rounding to elevation steps — higher values create steeper cliffs. Default 16. */
  elevScale?: number;
  /** FBM threshold below which cells become Water. Default -0.55. */
  waterThreshold?: number;
  /** FBM threshold above which cells become Desert (and below waterThreshold). Default -0.38. */
  desertThreshold?: number;
  /** FBM threshold above which cells become Mud (thin band between desert and grassland). Default -0.28. */
  mudThreshold?: number;
  /** FBM threshold above which cells become Rock (below snowThreshold). Default 0.42. */
  rockThreshold?: number;
  /** FBM threshold above which cells become Snow. Default 0.72. */
  snowThreshold?: number;
  /** World-space X offset added to noise input — use to shift to a different region of noise space. Default 0. */
  noiseOffsetX?: number;
  /** World-space Z offset added to noise input. Default 0. */
  noiseOffsetZ?: number;
}

/**
 * Fills every cell of `map` with terrain type and elevation derived from FBM noise.
 * Also sets feature layer 0 to a pine-tree density level based on terrain type,
 * if the map has at least one feature layer.
 */
export function generateFbmTerrain(map: HexMap, opts: FbmTerrainOptions = {}): void {
  const period         = opts.period         ?? 64;
  const octaves        = opts.octaves        ?? 6;
  const amplitude      = opts.amplitude      ?? 2.2;
  const elevOffset     = opts.elevOffset     ?? 4;
  const elevScale      = opts.elevScale      ?? 16;
  const waterThreshold  = opts.waterThreshold  ?? -0.55;
  const desertThreshold = opts.desertThreshold ?? -0.38;
  const mudThreshold    = opts.mudThreshold    ?? -0.28;
  const rockThreshold   = opts.rockThreshold   ?? 0.42;
  const snowThreshold   = opts.snowThreshold   ?? 0.72;
  const noiseOffsetX   = opts.noiseOffsetX   ?? 0;
  const noiseOffsetZ   = opts.noiseOffsetZ   ?? 0;

  map.forEach((col, row) => {
    const n = fbm((col + noiseOffsetX) / period, (row + noiseOffsetZ) / period, octaves) * amplitude;

    const isWater = n < waterThreshold;
    if      (n > snowThreshold)   map.setTerrain(col, row, TerrainType.Snow);
    else if (n > rockThreshold)   map.setTerrain(col, row, TerrainType.Rock);
    else if (isWater)             map.setTerrain(col, row, TerrainType.Water);
    else if (n < desertThreshold) map.setTerrain(col, row, TerrainType.Desert);
    else if (n < mudThreshold)    map.setTerrain(col, row, TerrainType.Mud);
    else                          map.setTerrain(col, row, TerrainType.Grassland);

    const elev = Math.round(n * elevScale) + elevOffset;
    map.setElevation(col, row, isWater ? Math.min(elev, -1) : Math.max(elev, 0));

    if (map.featureLayerCount > 0) {
      const treeLevel = isWater || n > rockThreshold ? 0 : n >= mudThreshold ? 2 : n >= desertThreshold ? 1 : 0;
      map.setFeatureLevel(col, row, 0, treeLevel);
    }
  });
}
