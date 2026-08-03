import type { HexMap } from '../map/HexMap.js';
import { makeRng } from '../math/Random.js';
import { createRegions } from './RegionLayout.js';
import type { RegionLayoutOptions } from './RegionLayout.js';
import { generateChunkTerrainSteps } from './ChunkTerrainGenerator.js';
import type { ChunkTerrainOptions } from './ChunkTerrainGenerator.js';
import { applyErosionSteps } from './ErosionPass.js';
import type { ErosionOptions } from './ErosionPass.js';
import { simulateClimateSteps } from './ClimateSimulator.js';
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
 * One progress event from a step-generator pipeline. Emitted at every
 * suspension point — feed it straight into a loading bar.
 */
export interface GenerationProgress {
  /** Name of the pass currently running (e.g. 'landmass', 'moisture', 'rivers'). */
  pass: string;
  /** 0-based index of the current pass. */
  passIndex: number;
  /** Total number of passes in the pipeline. */
  passCount: number;
  /** Progress within the current pass, 0–1. */
  passProgress: number;
  /** Estimated overall progress, 0–1, weighted by typical pass cost. */
  progress: number;
}

// Pass names + overall-progress weights (must sum to 1). Weights approximate
// relative wall-clock cost so the loading bar moves smoothly.
const PASSES: ReadonlyArray<readonly [string, number]> = [
  ['landmass',      0.25],
  ['erosion',       0.10],
  ['moisture',      0.40],
  ['temperature',   0.05],
  ['biomes',        0.05],
  ['rivers',        0.08],
  ['roads',         0.02],
  ['waterSurfaces', 0.05],
];

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
  const steps = generateMapSteps(map, config, seed);
  while (!steps.next().done) { /* drain */ }
}

/**
 * Step-generator form of {@link generateMap}: yields a {@link GenerationProgress}
 * at every suspension point (between passes and inside the heavy ones), so a
 * driver can spread the work across frames and show a loading bar. Drive it
 * with `generateMapAsync` for the batteries-included version, or iterate it
 * yourself for custom scheduling. Deterministic — same seed + config produces
 * the same map as `generateMap`.
 */
export function* generateMapSteps(
  map: HexMap,
  config: MapGeneratorConfig,
  seed: number,
): Generator<GenerationProgress, void> {
  const rand    = makeRng(seed);
  const elevMax = config.elevationMax ?? 12;

  let passIndex  = 0;
  let weightDone = 0;
  const event = (passProgress: number): GenerationProgress => ({
    pass:       PASSES[passIndex][0],
    passIndex,
    passCount:  PASSES.length,
    passProgress,
    progress:   Math.min(1, weightDone + PASSES[passIndex][1] * passProgress),
  });
  const finishPass = (): void => {
    weightDone += PASSES[passIndex][1];
    passIndex   = Math.min(passIndex + 1, PASSES.length - 1);
  };

  // landmass (region layout is O(1) — folded into this pass)
  const regions = createRegions(map.width, map.height, config, rand);
  for (const p of generateChunkTerrainSteps(map, regions, config, rand)) yield event(p);
  yield event(1); finishPass();

  // erosion
  for (const p of applyErosionSteps(map, config, rand)) yield event(p);
  yield event(1); finishPass();

  // moisture
  const climate = simulateClimateSteps(map, { ...config.climate, elevationMax: elevMax });
  let c = climate.next();
  while (!c.done) { yield event(c.value); c = climate.next(); }
  const moisture = c.value;
  yield event(1); finishPass();

  // temperature
  const temperature = computeTemperature(map, {
    ...config.temperature,
    elevationMax: elevMax,
    jitterChannel: Math.floor(rand() * 4),
  });
  yield event(1); finishPass();

  // biomes
  assignBiomes(map, temperature, moisture, { ...config.biomes, elevationMax: elevMax });
  yield event(1); finishPass();

  // rivers
  generateClimateRivers(map, moisture, { ...config.rivers, elevationMax: elevMax }, rand);
  yield event(1); finishPass();

  // roads
  generateRoads(map, config.roads);
  yield event(1); finishPass();

  // waterSurfaces
  map.computeWaterSurfaces();
  yield event(1);
}
