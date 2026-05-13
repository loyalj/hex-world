import type { HexMap } from '../map/HexMap.js';
import { makeRng } from '../math/Random.js';
import type { MapGeneratorPlugin } from './MapGeneratorPlugin.js';
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

export interface ChunkGeneratorConfig
  extends RegionLayoutOptions, ChunkTerrainOptions, ErosionOptions {
  climate?:       ClimateSimulatorOptions;
  temperature?:   TemperatureModelOptions;
  biomes?:        BiomeAssignerOptions;
  rivers?:        ClimateRiverOptions;
  roads?:         RoadGeneratorOptions;
}

const DEFAULT_CONFIG: ChunkGeneratorConfig = {};

export const ChunkPlugin: MapGeneratorPlugin<ChunkGeneratorConfig> = {
  id: 'chunk',
  name: 'Chunk (tutorial)',
  defaultConfig: DEFAULT_CONFIG,

  generate(map: HexMap, config: ChunkGeneratorConfig, seed: number): void {
    const rand     = makeRng(seed);
    const elevMax  = config.elevationMax ?? 12;

    const regions  = createRegions(map.width, map.height, config, rand);
    generateChunkTerrain(map, regions, config, rand);
    applyErosion(map, config, rand);

    const moisture    = simulateClimate(map, config.climate);
    const temperature = computeTemperature(map, { ...config.temperature, elevationMax: elevMax });
    assignBiomes(map, temperature, moisture, config.biomes);

    generateClimateRivers(map, moisture, { ...config.rivers, elevationMax: elevMax }, rand);
    generateRoads(map, config.roads);
  },
};
