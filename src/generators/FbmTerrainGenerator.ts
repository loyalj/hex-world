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
  const steps = generateFbmTerrainSteps(map, opts);
  while (!steps.next().done) { /* drain */ }
}

/**
 * Step-generator form of {@link generateFbmTerrain}: yields the completed
 * fraction (0–1) every 16 rows so async drivers can suspend. The pass is pure
 * per-cell noise, so suspension points cannot change the result.
 */
export function* generateFbmTerrainSteps(
  map: HexMap,
  opts: FbmTerrainOptions = {},
): Generator<number, void> {
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

  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
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
      if (map.featureLayerCount > 1) {
        const t = map.getTerrain(col, row);
        // Two densities rather than one. A single level draws a single tier —
        // see the threshold table in ScatterBuilder — so every boulder on the
        // map came out the same size at the same spacing, which reads as a
        // pattern rather than as scree. The higher ground is the rockier.
        const rockLevel = t !== TerrainType.Rock ? 0
          : n > (rockThreshold + snowThreshold) / 2 ? 2 : 1;
        map.setFeatureLevel(col, row, 1, rockLevel);
      }
      // Layers 2 and 3 exist only on maps that asked for them, so a two-layer
      // map generates exactly as it did before.
      //
      // Broadleaf woods take the warm lowlands and thin out toward the
      // treeline, while layer 0's conifers hold an even density all the way up.
      // Neither layer excludes the other — the scatter builder competes for
      // each slot — so the shift in their relative densities is what makes the
      // wood change species as the ground rises, without a hard line anywhere.
      if (map.featureLayerCount > 2) {
        const lowland = (mudThreshold + rockThreshold) / 2;
        const broadleaf = isWater || n >= rockThreshold || n < mudThreshold ? 0
          : n < lowland ? 3 : 1;
        map.setFeatureLevel(col, row, 2, broadleaf);
      }
      // Scrub fills in where trees thin out: densest on the dry ground below
      // the woods, present but sparse as understory within them.
      if (map.featureLayerCount > 3) {
        const bush = isWater || n >= rockThreshold || n < desertThreshold ? 0
          : n < mudThreshold ? 2 : 1;
        map.setFeatureLevel(col, row, 3, bush);
      }
    }
    if ((row & 15) === 15) yield (row + 1) / map.height;
  }
}
