import type { HexMap } from '../map/HexMap.js';
import type { MapGeneratorPlugin } from './MapGeneratorPlugin.js';
import { generateMap } from './MapGenerator.js';
import type { MapGeneratorConfig } from './MapGenerator.js';

export type { MapGeneratorConfig as ChunkGeneratorConfig };

export const ChunkPlugin: MapGeneratorPlugin<MapGeneratorConfig> = {
  id: 'chunk',
  name: 'Chunk (tutorial)',
  defaultConfig: {},

  generate(map: HexMap, config: MapGeneratorConfig, seed: number): void {
    generateMap(map, config, seed);
  },
};
