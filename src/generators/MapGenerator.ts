import type { HexMap } from '../map/HexMap.js';
import { makeRng } from '../math/Random.js';
import { createRegions } from './RegionLayout.js';
import type { RegionLayoutOptions } from './RegionLayout.js';
import { generateChunkTerrain } from './ChunkTerrainGenerator.js';
import type { ChunkTerrainOptions } from './ChunkTerrainGenerator.js';
import { applyErosion } from './ErosionPass.js';
import type { ErosionOptions } from './ErosionPass.js';
import { simulateClimate } from './ClimateSimulator.js';
import type { ClimateSimulatorOptions } from './ClimateSimulator.js';
import { computeTemperature } from './TemperatureModel.js';
import type { TemperatureModelOptions } from './TemperatureModel.js';
import { assignBiomes } from './BiomeAssigner.js';
import type { BiomeAssignerOptions } from './BiomeAssigner.js';
import { generateClimateRivers } from './RiverGenerator.js';
import type { ClimateRiverOptions } from './RiverGenerator.js';
import { generateRoads } from './RoadGenerator.js';
import type { RoadGeneratorOptions } from './RoadGenerator.js';

/**
 * Single config object for the full procedural pipeline.
 * All sub-configs are optional — each phase falls back to its own defaults.
 */
export interface MapGeneratorConfig
  extends RegionLayoutOptions, ChunkTerrainOptions, ErosionOptions {
  climate?:     ClimateSimulatorOptions;
  temperature?: TemperatureModelOptions;
  biomes?:      BiomeAssignerOptions;
  rivers?:      ClimateRiverOptions;
  roads?:       RoadGeneratorOptions;
}

/**
 * Runs the full procedural generation pipeline in order:
 *   RegionLayout → ChunkTerrain → Erosion →
 *   ClimateSimulator → TemperatureModel → BiomeAssigner →
 *   ClimateRivers → Roads
 *
 * The caller provides an already-constructed (and cleared) HexMap.
 * The same seed + config always produces the same map.
 */
export function generateMap(map: HexMap, config: MapGeneratorConfig, seed: number): void {
  const rand    = makeRng(seed);
  const elevMax = config.elevationMax ?? 12;

  const regions = createRegions(map.width, map.height, config, rand);
  generateChunkTerrain(map, regions, config, rand);
  applyErosion(map, config, rand);

  const moisture    = simulateClimate(map, { ...config.climate, elevationMax: elevMax });
  const temperature = computeTemperature(map, {
    ...config.temperature,
    elevationMax: elevMax,
    jitterChannel: Math.floor(rand() * 4),
  });
  assignBiomes(map, temperature, moisture, { ...config.biomes, elevationMax: elevMax });

  generateClimateRivers(map, moisture, { ...config.rivers, elevationMax: elevMax }, rand);
  generateRoads(map, config.roads);
  map.computeWaterSurfaces();
}
