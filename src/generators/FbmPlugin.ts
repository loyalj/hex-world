import type { HexMap } from '../map/HexMap.js';
import { makeRng } from '../math/Random.js';
import type { MapGeneratorPlugin, ConfigFieldDescriptor } from './MapGeneratorPlugin.js';
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

const CONFIG_SCHEMA: ConfigFieldDescriptor[] = [
  // Terrain Shape
  { key: 'terrain.period',         label: 'Noise Period',       type: 'integer', default: 64,    min: 16,   max: 256,  step: 8,    group: 'Terrain' },
  { key: 'terrain.octaves',        label: 'Octaves',            type: 'integer', default: 6,     min: 1,    max: 10,               group: 'Terrain' },
  { key: 'terrain.amplitude',      label: 'Amplitude',          type: 'number',  default: 2.2,   min: 0.5,  max: 5.0,  step: 0.1,  group: 'Terrain' },
  { key: 'terrain.elevScale',      label: 'Elevation Scale',    type: 'integer', default: 16,    min: 4,    max: 32,   step: 2,    group: 'Terrain' },
  { key: 'terrain.elevOffset',     label: 'Elevation Offset',   type: 'integer', default: 4,     min: -8,   max: 16,               group: 'Terrain' },
  // Biomes
  { key: 'terrain.waterThreshold',  label: 'Water Level',       type: 'number',  default: -0.55, min: -1.5, max: -0.1, step: 0.01, group: 'Biomes' },
  { key: 'terrain.desertThreshold', label: 'Desert Threshold',  type: 'number',  default: -0.38, min: -0.8, max: 0.1,  step: 0.01, group: 'Biomes' },
  { key: 'terrain.mudThreshold',    label: 'Mud Threshold',     type: 'number',  default: -0.28, min: -0.5, max: 0.3,  step: 0.01, group: 'Biomes' },
  { key: 'terrain.rockThreshold',   label: 'Rock Threshold',    type: 'number',  default: 0.42,  min: 0.1,  max: 1.0,  step: 0.01, group: 'Biomes' },
  { key: 'terrain.snowThreshold',   label: 'Snow Threshold',    type: 'number',  default: 0.72,  min: 0.3,  max: 1.5,  step: 0.01, group: 'Biomes' },
  // Rivers
  { key: 'rivers.gridSpacing',      label: 'Grid Spacing',      type: 'integer', default: 48,    min: 4,    max: 80,   step: 2,    group: 'Rivers' },
  { key: 'rivers.minSeedElevation', label: 'Min Seed Elevation',type: 'integer', default: 5,     min: 0,    max: 12,               group: 'Rivers' },
  // Roads
  { key: 'roads.gridSpacing',       label: 'Grid Spacing',      type: 'integer', default: 24,    min: 4,    max: 60,   step: 2,    group: 'Roads' },
  { key: 'roads.maxElevationDiff',  label: 'Max Elev. Diff',    type: 'integer', default: 1,     min: 0,    max: 8,                group: 'Roads' },
];

export const FbmPlugin: MapGeneratorPlugin<FbmGeneratorConfig> = {
  id: 'fbm',
  name: 'FBM (fast)',
  defaultConfig: DEFAULT_CONFIG,
  configSchema: CONFIG_SCHEMA,

  generate(map: HexMap, config: FbmGeneratorConfig, seed: number): void {
    const { x, z } = seedToNoiseOffset(seed);
    generateFbmTerrain(map, { ...config.terrain, noiseOffsetX: x, noiseOffsetZ: z });
    generateRivers(map, config.rivers);
    generateRoads(map, config.roads);
  },
};
