import { TerrainType } from '../map/HexCell.js';
import type { HexMap } from '../map/HexMap.js';
import { DEFAULT_WATER_TERRAIN_INDEX } from '../geometry/TerrainTypes.js';

export interface BiomeAssignerOptions {
  /** Three thresholds that divide temperature into 4 bands. Default [0.1, 0.3, 0.6]. */
  temperatureBands?: [number, number, number];
  /** Three thresholds that divide moisture into 4 bands. Default [0.12, 0.28, 0.85]. */
  moistureBands?:    [number, number, number];
  /** Maximum land elevation — used for rock-desert and snowcap elevation tweaks. Default 12. */
  elevationMax?:     number;
  /**
   * 4×4 biome matrix indexed by [temperatureBand][moistureBand].
   * Band 0 = coldest/driest, band 3 = hottest/wettest.
   */
  biomeMatrix?:       TerrainType[][];
  /** 4×4 tree-density matrix (values 0–3) with the same indexing. */
  treeDensityMatrix?: number[][];
  /** Terrain index assigned to submerged (elevation < 0) cells. Default 5 (built-in Water). */
  waterTerrainIndex?: number;
}

// ---- Defaults (matching Part 26 tutorial) ----

// T0=arctic, T1=cold, T2=temperate, T3=hot  ×  M0=dry, M1=low, M2=moderate, M3=wet
const DEFAULT_BIOME_MATRIX: TerrainType[][] = [
  [TerrainType.Desert, TerrainType.Snow,      TerrainType.Snow,      TerrainType.Snow],
  [TerrainType.Desert, TerrainType.Mud,       TerrainType.Mud,       TerrainType.Mud],
  [TerrainType.Desert, TerrainType.Grassland, TerrainType.Grassland, TerrainType.Grassland],
  [TerrainType.Desert, TerrainType.Grassland, TerrainType.Grassland, TerrainType.Grassland],
];

const DEFAULT_TREE_MATRIX: number[][] = [
  [0, 0, 0, 0],
  [0, 0, 1, 2],
  [0, 0, 1, 2],
  [0, 1, 2, 3],
];

function bandIndex(value: number, thresholds: [number, number, number]): number {
  if (value < thresholds[0]) return 0;
  if (value < thresholds[1]) return 1;
  if (value < thresholds[2]) return 2;
  return 3;
}

/**
 * Assigns terrain types and tree-density feature levels to every cell
 * based on temperature × moisture biome matrices, with post-matrix elevation tweaks.
 */
export function assignBiomes(
  map: HexMap,
  temperature: Float32Array,
  moisture: Float32Array,
  opts: BiomeAssignerOptions = {},
): void {
  const tempBands      = opts.temperatureBands  ?? [0.1, 0.3, 0.6] as [number, number, number];
  const moistBands     = opts.moistureBands     ?? [0.12, 0.28, 0.85] as [number, number, number];
  const elevMax        = opts.elevationMax      ?? 12;
  const biomes         = opts.biomeMatrix       ?? DEFAULT_BIOME_MATRIX;
  const trees          = opts.treeDensityMatrix ?? DEFAULT_TREE_MATRIX;
  const waterIdx       = opts.waterTerrainIndex ?? DEFAULT_WATER_TERRAIN_INDEX;

  // High-elevation desert cells become rock desert above this line
  const rockDesertElevation = elevMax - Math.floor(elevMax / 2);

  map.forEach((col, row) => {
    const elev = map.getElevation(col, row);
    const i    = row * map.width + col;

    // ---- Underwater cells ----
    if (elev < 0) {
      map.setTerrain(col, row, waterIdx);
      if (map.featureLayerCount > 0) map.setFeatureLevel(col, row, 0, 0);
      return;
    }

    // ---- Land cells: biome lookup ----
    const tb = bandIndex(temperature[i], tempBands);
    const mb = bandIndex(moisture[i],    moistBands);

    let terrain  = biomes[tb][mb];
    let treeLevel = trees[tb][mb];

    // Post-matrix tweak 1: high-elevation desert → rock desert
    if (terrain === TerrainType.Desert && elev >= rockDesertElevation) {
      terrain = TerrainType.Rock;
    }

    // Post-matrix tweak 2: max-elevation non-desert → forced snowcap
    if (elev === elevMax && terrain !== TerrainType.Desert) {
      terrain = TerrainType.Snow;
    }

    // Plant tweaks: no plants on snow; river adjacency boosts density
    if (terrain === TerrainType.Snow) {
      treeLevel = 0;
    } else if (treeLevel < 3 && map.hasRiver(col, row)) {
      treeLevel += 1;
    }

    map.setTerrain(col, row, terrain);
    if (map.featureLayerCount > 0) map.setFeatureLevel(col, row, 0, treeLevel);
    if (map.featureLayerCount > 1) {
      const rockLevel = terrain === TerrainType.Rock ? 1 : 0;
      map.setFeatureLevel(col, row, 1, rockLevel);
    }
  });
}
