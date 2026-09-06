import type { HexMap } from '../map/HexMap.js';
import type { MapGeneratorPlugin, ConfigFieldDescriptor } from './MapGeneratorPlugin.js';
import { generateMap, generateMapSteps } from './MapGenerator.js';
import type { GenerationProgress, MapGeneratorConfig } from './MapGenerator.js';

export type { MapGeneratorConfig as ChunkGeneratorConfig };

const CONFIG_SCHEMA: ConfigFieldDescriptor[] = [
  // Terrain
  { key: 'regionCount',        label: 'Region Count',    type: 'integer', default: 1,    min: 1,    max: 4,               group: 'Terrain' },
  { key: 'landPercentage',     label: 'Land %',          type: 'integer', default: 50,   min: 10,   max: 90,   step: 5,   group: 'Terrain' },
  { key: 'elevationMax',       label: 'Max Elevation',   type: 'integer', default: 12,   min: 4,    max: 20,              group: 'Terrain' },
  { key: 'chunkSizeMin',       label: 'Min Chunk Size',  type: 'integer', default: 30,   min: 5,    max: 80,   step: 5,   group: 'Terrain' },
  { key: 'chunkSizeMax',       label: 'Max Chunk Size',  type: 'integer', default: 100,  min: 30,   max: 300,  step: 10,  group: 'Terrain' },
  { key: 'jitterProbability',  label: 'Shape Jitter',    type: 'number',  default: 0.25, min: 0,    max: 0.5,  step: 0.05, group: 'Terrain' },
  { key: 'sinkProbability',    label: 'Sink Probability',type: 'number',  default: 0.2,  min: 0,    max: 0.5,  step: 0.05, group: 'Terrain' },
  { key: 'seedPlacement',      label: 'Seed Placement',  type: 'select',  default: 'uniform',
    options: [{ value: 'uniform', label: 'Uniform' }, { value: 'accrete', label: 'Accrete' }, { value: 'scatter', label: 'Scatter' }],
    group: 'Terrain' },
  { key: 'scatterGap',         label: 'Scatter Gap',     type: 'integer', default: 0,    min: 0,    max: 20,              group: 'Terrain' },
  { key: 'seedArcs',           label: 'Seed Arcs',       type: 'integer', default: 0,    min: 0,    max: 6,               group: 'Terrain' },
  { key: 'chunkElongation',    label: 'Chunk Elongation',type: 'number',  default: 1,    min: 1,    max: 4,    step: 0.1, group: 'Terrain' },
  { key: 'peninsulaProbability', label: 'Peninsula Chance', type: 'number', default: 0,  min: 0,    max: 0.5,  step: 0.05, group: 'Terrain' },
  { key: 'coastWarp',          label: 'Coast Warp',      type: 'number',  default: 0,    min: 0,    max: 8,    step: 0.5, group: 'Terrain' },
  { key: 'coastShaping',       label: 'Coast Shaping',   type: 'number',  default: 0,    min: 0,    max: 1,    step: 0.05, group: 'Terrain' },
  { key: 'mountainRanges',     label: 'Mountain Ranges', type: 'integer', default: 0,    min: 0,    max: 6,               group: 'Terrain' },
  { key: 'rangeUplift',        label: 'Range Uplift',    type: 'integer', default: 4,    min: 1,    max: 8,               group: 'Terrain' },
  { key: 'volcanoes',          label: 'Volcanoes',       type: 'integer', default: 0,    min: 0,    max: 4,               group: 'Terrain' },
  { key: 'volcanoRadius',      label: 'Volcano Radius',  type: 'integer', default: 4,    min: 2,    max: 8,               group: 'Terrain' },
  { key: 'volcanoHeight',      label: 'Volcano Height',  type: 'integer', default: 5,    min: 2,    max: 10,              group: 'Terrain' },
  { key: 'erosionPercentage',  label: 'Erosion %',       type: 'integer', default: 50,   min: 0,    max: 100,  step: 5,   group: 'Terrain' },
  // Climate
  { key: 'climate.cycles',              label: 'Cycles',         type: 'integer', default: 40,   min: 10,   max: 80,   step: 5,    group: 'Climate' },
  { key: 'climate.evaporationFactor',   label: 'Evaporation',    type: 'number',  default: 0.5,  min: 0.1,  max: 1.0,  step: 0.05, group: 'Climate' },
  { key: 'climate.precipitationFactor', label: 'Precipitation',  type: 'number',  default: 0.25, min: 0.05, max: 0.5,  step: 0.05, group: 'Climate' },
  { key: 'climate.runoffFactor',        label: 'Runoff',         type: 'number',  default: 0.25, min: 0.05, max: 0.5,  step: 0.05, group: 'Climate' },
  { key: 'climate.seepageFactor',       label: 'Seepage',        type: 'number',  default: 0.125,min: 0.025,max: 0.3,  step: 0.025,group: 'Climate' },
  { key: 'climate.windDirection',       label: 'Wind Direction',  type: 'integer', default: 2,    min: 0,    max: 5,               group: 'Climate' },
  { key: 'climate.windStrength',        label: 'Wind Strength',   type: 'integer', default: 4,    min: 1,    max: 8,               group: 'Climate' },
  // Temperature
  { key: 'temperature.lowTemperature',    label: 'Min Temperature', type: 'number',  default: 0,    min: 0,    max: 0.4,  step: 0.05, group: 'Temperature' },
  { key: 'temperature.highTemperature',   label: 'Max Temperature', type: 'number',  default: 1,    min: 0.6,  max: 1.0,  step: 0.05, group: 'Temperature' },
  { key: 'temperature.hemisphere',        label: 'Hemisphere',      type: 'select',  default: 'both',
    options: [{ value: 'both', label: 'Both' }, { value: 'north', label: 'North' }, { value: 'south', label: 'South' }],
    group: 'Temperature' },
  { key: 'temperature.temperatureJitter', label: 'Temp. Jitter',    type: 'number',  default: 0.1,  min: 0,    max: 0.3,  step: 0.01, group: 'Temperature' },
  // Rivers
  { key: 'rivers.riverPercentage',      label: 'River %',       type: 'integer', default: 10,   min: 0,    max: 20,              group: 'Rivers' },
  { key: 'rivers.extraLakeProbability', label: 'Lake Chance',   type: 'number',  default: 0.25, min: 0,    max: 0.5,  step: 0.05, group: 'Rivers' },
  // Roads
  { key: 'roads.gridSpacing',      label: 'Grid Spacing',   type: 'integer', default: 24,   min: 4,    max: 60,   step: 2,   group: 'Roads' },
  { key: 'roads.maxElevationDiff', label: 'Max Elev. Diff', type: 'integer', default: 1,    min: 0,    max: 8,               group: 'Roads' },
];

export const ChunkPlugin: MapGeneratorPlugin<MapGeneratorConfig> = {
  id: 'chunk',
  name: 'Chunk (tutorial)',
  defaultConfig: {},
  configSchema: CONFIG_SCHEMA,

  generate(map: HexMap, config: MapGeneratorConfig, seed: number): void {
    generateMap(map, config, seed);
  },

  generateSteps(map: HexMap, config: MapGeneratorConfig, seed: number): Generator<GenerationProgress, void> {
    return generateMapSteps(map, config, seed);
  },
};
