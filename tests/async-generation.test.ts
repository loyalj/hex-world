import { describe, it, expect } from 'vitest';
import { HexMap } from '../src/map/HexMap.js';
import { generateMap, generateMapSteps } from '../src/generators/MapGenerator.js';
import type { GenerationProgress } from '../src/generators/MapGenerator.js';
import {
  generateMapAsync, generatePluginAsync,
} from '../src/generators/AsyncGeneration.js';
import { FbmPlugin } from '../src/generators/FbmPlugin.js';
import { ChunkPlugin } from '../src/generators/ChunkPlugin.js';

const SEED = 12345;

describe('generateMapSteps', () => {
  it('produces the exact same map as the synchronous generateMap', () => {
    const a = new HexMap({ width: 40, height: 30, featureLayerCount: 1 });
    const b = new HexMap({ width: 40, height: 30, featureLayerCount: 1 });
    generateMap(a, {}, SEED);
    for (const _ of generateMapSteps(b, {}, SEED)) { /* drain step by step */ }
    expect(b.uint8).toEqual(a.uint8);
    expect(b.riverInBits).toEqual(a.riverInBits);
    expect(b.roadBits).toEqual(a.roadBits);
  });

  it('reports monotonic overall progress across named passes, ending at 1', () => {
    const map = new HexMap({ width: 30, height: 20 });
    const events: GenerationProgress[] = [];
    for (const p of generateMapSteps(map, {}, SEED)) events.push(p);

    expect(events.length).toBeGreaterThan(8);
    let prev = -1;
    for (const e of events) {
      expect(e.progress).toBeGreaterThanOrEqual(prev);
      expect(e.passProgress).toBeGreaterThanOrEqual(0);
      expect(e.passProgress).toBeLessThanOrEqual(1);
      prev = e.progress;
    }
    expect(events[events.length - 1].progress).toBe(1);

    const passes = new Set(events.map(e => e.pass));
    for (const name of ['landmass', 'erosion', 'moisture', 'rivers', 'roads', 'waterSurfaces']) {
      expect(passes).toContain(name);
    }
  });
});

describe('generateMapAsync', () => {
  it('matches the synchronous result and resolves after reporting completion', async () => {
    const a = new HexMap({ width: 40, height: 30 });
    const b = new HexMap({ width: 40, height: 30 });
    generateMap(a, {}, SEED);

    const events: GenerationProgress[] = [];
    await generateMapAsync(b, {}, SEED, { onProgress: p => events.push(p) });

    expect(b.uint8).toEqual(a.uint8);
    expect(events[events.length - 1].progress).toBe(1);
  });

  it('rejects and stops early when the signal aborts mid-generation', async () => {
    const map = new HexMap({ width: 64, height: 64 });
    const controller = new AbortController();
    let eventsSeen = 0;

    await expect(generateMapAsync(map, {}, SEED, {
      signal: controller.signal,
      sliceMs: 0, // yield after every step so the abort lands quickly
      onProgress: p => {
        eventsSeen++;
        if (p.progress > 0.2) controller.abort();
      },
    })).rejects.toThrow(/abort/i);

    expect(eventsSeen).toBeGreaterThan(0);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const map = new HexMap({ width: 8, height: 8 });
    const controller = new AbortController();
    controller.abort();
    await expect(generateMapAsync(map, {}, SEED, { signal: controller.signal }))
      .rejects.toThrow(/abort/i);
  });
});

describe('generatePluginAsync', () => {
  it('FbmPlugin.generateSteps matches FbmPlugin.generate', async () => {
    const a = new HexMap({ width: 40, height: 30, featureLayerCount: 2 });
    const b = new HexMap({ width: 40, height: 30, featureLayerCount: 2 });
    FbmPlugin.generate(a, {}, SEED);

    const events: GenerationProgress[] = [];
    await generatePluginAsync(FbmPlugin, b, {}, SEED, { onProgress: p => events.push(p) });

    expect(b.uint8).toEqual(a.uint8);
    expect(b.roadBits).toEqual(a.roadBits);
    expect(events[events.length - 1].progress).toBe(1);
    expect(new Set(events.map(e => e.pass))).toContain('terrain');
  });

  it('ChunkPlugin exposes the full pipeline steps', async () => {
    const a = new HexMap({ width: 30, height: 20 });
    const b = new HexMap({ width: 30, height: 20 });
    ChunkPlugin.generate(a, {}, SEED);
    await generatePluginAsync(ChunkPlugin, b, {}, SEED);
    expect(b.uint8).toEqual(a.uint8);
  });

  it('falls back to a single synchronous run for plugins without generateSteps', async () => {
    const a = new HexMap({ width: 16, height: 16 });
    const stepless = { ...FbmPlugin, generateSteps: undefined };
    const events: GenerationProgress[] = [];
    await generatePluginAsync(stepless, a, {}, SEED, { onProgress: p => events.push(p) });
    expect(events).toHaveLength(1);
    expect(events[0].progress).toBe(1);
  });
});
