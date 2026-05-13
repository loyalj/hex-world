import type { HexMap } from '../map/HexMap.js';
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
  // mulberry32 — derive two noise-space offsets from the seed
  let s = seed >>> 0;
  const next = (): number => {
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    return ((s ^ (s >>> 14)) >>> 0) / 0x100000000;
  };
  // Offset by up to ±500 period-units so different seeds produce genuinely different maps
  return { x: next() * 1000, z: next() * 1000 };
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
