import type { HexMap } from '../map/HexMap.js';
import type { GenerationProgress, MapGeneratorConfig } from './MapGenerator.js';
import { generateMapSteps } from './MapGenerator.js';
import type { MapGeneratorPlugin } from './MapGeneratorPlugin.js';

/** Options for the async generation drivers. */
export interface GenerateAsyncOptions {
  /** Abort mid-generation — the returned promise rejects with the signal's reason. */
  signal?:     AbortSignal;
  /** Called with every progress event, in order. Drive a loading bar from this. */
  onProgress?: (progress: GenerationProgress) => void;
  /**
   * Milliseconds of generation work per slice before yielding to the event
   * loop. Default 12 — leaves headroom for a 60 fps frame. Raise it to finish
   * faster at the cost of responsiveness.
   */
  sliceMs?:    number;
}

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/**
 * Drives any {@link GenerationProgress} step generator to completion without
 * blocking the event loop: runs steps for `sliceMs`, yields a macrotask, checks
 * the abort signal, repeats. The building block under `generateMapAsync` and
 * `generatePluginAsync` — use it directly for custom pipelines.
 */
export async function driveGenerationSteps(
  steps: Generator<GenerationProgress, void>,
  opts: GenerateAsyncOptions = {},
): Promise<void> {
  const sliceMs = opts.sliceMs ?? 12;
  opts.signal?.throwIfAborted();

  let sliceStart = now();
  for (const progress of steps) {
    opts.onProgress?.(progress);
    if (now() - sliceStart >= sliceMs) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      opts.signal?.throwIfAborted();
      sliceStart = now();
    }
  }
}

/**
 * Cancellable, non-blocking form of `generateMap`: runs the full procedural
 * pipeline in event-loop-friendly slices, reporting progress per pass.
 * Deterministic — same seed + config produces the same map as `generateMap`.
 *
 * @example
 * const controller = new AbortController();
 * await generateMapAsync(map, config, seed, {
 *   signal: controller.signal,
 *   onProgress: p => loadingBar.set(p.progress, p.pass),
 * });
 */
export async function generateMapAsync(
  map: HexMap,
  config: MapGeneratorConfig,
  seed: number,
  opts: GenerateAsyncOptions = {},
): Promise<void> {
  await driveGenerationSteps(generateMapSteps(map, config, seed), opts);
}

/**
 * Runs a generator plugin without blocking the event loop. Plugins that
 * implement `generateSteps` get sliced execution with real per-pass progress;
 * plugins that only implement `generate` run synchronously in one slice and
 * report a single completion event.
 */
export async function generatePluginAsync<TConfig>(
  plugin: MapGeneratorPlugin<TConfig>,
  map: HexMap,
  config: TConfig,
  seed: number,
  opts: GenerateAsyncOptions = {},
): Promise<void> {
  if (plugin.generateSteps) {
    await driveGenerationSteps(plugin.generateSteps(map, config, seed), opts);
    return;
  }
  opts.signal?.throwIfAborted();
  plugin.generate(map, config, seed);
  opts.onProgress?.({
    pass: 'generate', passIndex: 0, passCount: 1, passProgress: 1, progress: 1,
  });
}
