import type { HexMap } from '../map/HexMap.js';
import { makeRng } from '../math/Random.js';
import type { MapGeneratorPlugin } from './MapGeneratorPlugin.js';
import type { FbmTerrainOptions } from './FbmTerrainGenerator.js';
import type { RiverGeneratorOptions } from './RiverGenerator.js';
import type { RoadGeneratorOptions } from './RoadGenerator.js';
import { generateFbmTerrain } from './FbmTerrainGenerator.js';
import { generateRivers } from './RiverGenerator.js';
import { generateRoads } from './RoadGenerator.js';

export interface FbmGeneratorConfig {
  terrain?: FbmTerrainOptions;
  rivers?: RiverGeneratorOptions;
  roads?: RoadGeneratorOptions;
}

function seedToNoiseOffset(seed: number): { x: number; z: number } {
  const rand = makeRng(seed);
  // Offset by up to 1000 noise-space units so different seeds look genuinely different
  return { x: rand() * 1000, z: rand() * 1000 };
}

const DEFAULT_CONFIG: FbmGeneratorConfig = {};

export const FbmPlugin: MapGeneratorPlugin<FbmGeneratorConfig> = {
  id: 'fbm',
  name: 'FBM (fast)',
  defaultConfig: DEFAULT_CONFIG,

  generate(map: HexMap, config: FbmGeneratorConfig, seed: number): void {
    const { x, z } = seedToNoiseOffset(seed);
    generateFbmTerrain(map, { ...config.terrain, noiseOffsetX: x, noiseOffsetZ: z });
    generateRivers(map, config.rivers);
    generateRoads(map, config.roads);
  },
};
