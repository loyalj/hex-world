import { TerrainType } from '../map/HexCell.js';
import type { HexMap } from '../map/HexMap.js';

export interface BiomeAssignerOptions {
  /** Three thresholds that divide temperature into 4 bands. Default [0.1, 0.3, 0.6]. */
  temperatureBands?: [number, number, number];
  /** Three thresholds that divide moisture into 4 bands. Default [0.12, 0.28, 0.85]. */
  moistureBands?:    [number, number, number];
  /**
   * 4×4 biome matrix indexed by [temperatureBand][moistureBand].
   * Band 0 = coldest/driest, band 3 = hottest/wettest.
   */
  biomeMatrix?:      TerrainType[][];
  /** 4×4 tree-density matrix (values 0–3) with the same indexing. */
  treeDensityMatrix?: number[][];
}

// ---- Defaults ----

const DEFAULT_BIOME_MATRIX: TerrainType[][] = [
  // M0:dry    M1:low     M2:mod       M3:wet
  [TerrainType.Desert,    TerrainType.Rock,      TerrainType.Rock,      TerrainType.Snow],      // T0: arctic
  [TerrainType.Desert,    TerrainType.Mud,       TerrainType.Mud,       TerrainType.Snow],       // T1: cold
  [TerrainType.Desert,    TerrainType.Grassland, TerrainType.Grassland, TerrainType.Mud],        // T2: temperate
  [TerrainType.Desert,    TerrainType.Desert,    TerrainType.Grassland, TerrainType.Grassland],  // T3: hot
];

const DEFAULT_TREE_MATRIX: number[][] = [
  [0, 0, 0, 0],  // T0: no trees
  [0, 1, 2, 1],  // T1: sparse taiga
  [0, 2, 3, 2],  // T2: temperate forest
  [0, 0, 2, 3],  // T3: tropical
];

function bandIndex(value: number, thresholds: [number, number, number]): number {
  if (value < thresholds[0]) return 0;
  if (value < thresholds[1]) return 1;
  if (value < thresholds[2]) return 2;
  return 3;
}

/**
 * Assigns terrain types and tree-density feature levels to every land cell
 * based on temperature × moisture biome matrices.
 * Water cells (elev < 0) are left as TerrainType.Water with tree level 0.
 */
export function assignBiomes(
  map: HexMap,
  temperature: Float32Array,
  moisture: Float32Array,
  opts: BiomeAssignerOptions = {},
): void {
  const tempBands  = opts.temperatureBands  ?? [0.1, 0.3, 0.6];
  const moistBands = opts.moistureBands     ?? [0.12, 0.28, 0.85];
  const biomes     = opts.biomeMatrix       ?? DEFAULT_BIOME_MATRIX;
  const trees      = opts.treeDensityMatrix ?? DEFAULT_TREE_MATRIX;

  map.forEach((col, row) => {
    const elev = map.getElevation(col, row);

    if (elev < 0) {
      map.setTerrain(col, row, TerrainType.Water);
      if (map.featureLayerCount > 0) map.setFeatureLevel(col, row, 0, 0);
      return;
    }

    const i  = row * map.width + col;
    const tb = bandIndex(temperature[i], tempBands);
    const mb = bandIndex(moisture[i],    moistBands);

    map.setTerrain(col, row, biomes[tb][mb]);
    if (map.featureLayerCount > 0) map.setFeatureLevel(col, row, 0, trees[tb][mb]);
  });
}
