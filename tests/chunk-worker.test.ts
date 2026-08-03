import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { HexMap } from '../src/map/HexMap.js';
import { createLayout } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';
import { generateMap } from '../src/generators/MapGenerator.js';
import {
  buildChunkGeometry, resolveChunkGeometryOptions,
} from '../src/geometry/HexChunk.js';
import { buildChunkArrays, computeFlatNormals } from '../src/geometry/HexChunkCore.js';
import {
  createChunkWorkerHandler,
  type ChunkWorkerRequest, type ChunkWorkerResponse,
} from '../src/geometry/ChunkWorkerProtocol.js';
import {
  WorkerChunkBuilder, type ChunkWorkerLike,
} from '../src/geometry/WorkerChunkBuilder.js';
import { ChunkManager } from '../src/geometry/ChunkManager.js';

const layout = createLayout(POINTY_TOP, 1);

function makeMap(): HexMap {
  const map = new HexMap({ width: 24, height: 24 });
  generateMap(map, {}, 777);
  return map;
}

/** Runs the real protocol handler, delivering responses on a microtask like a real Worker would. */
class FakeWorker implements ChunkWorkerLike {
  onmessage: ((event: { data: ChunkWorkerResponse }) => void) | null = null;
  terminated = false;
  private readonly handle = createChunkWorkerHandler();

  postMessage(message: unknown): void {
    const { response } = this.handle(message as ChunkWorkerRequest);
    if (response) {
      queueMicrotask(() => this.onmessage?.({ data: response }));
    }
  }

  terminate(): void { this.terminated = true; }
}

const flushMicrotasks = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('chunk worker protocol', () => {
  it('worker-built arrays match the synchronous builder exactly', () => {
    const map    = makeMap();
    const bounds = { colStart: 0, colEnd: 24, rowStart: 0, rowEnd: 24 };
    const opts   = resolveChunkGeometryOptions({});

    const reference = buildChunkArrays(map, layout, bounds, opts);

    const handle = createChunkWorkerHandler();
    handle({
      type: 'setMap',
      width: map.width, height: map.height,
      cells:       map.uint8.slice().buffer,
      roadBits:    map.roadBits.slice().buffer,
      riverInBits: map.riverInBits.slice().buffer,
      layout,
      options: {
        terrainDefinitions: opts.terrainDefinitions!.map(d => ({
          index: d.index,
          color: { r: d.color.r, g: d.color.g, b: d.color.b },
          roadColor: d.roadColor,
        })),
        fallbackColor: opts.fallbackColor,
      },
    });
    const { response } = handle({ type: 'build', id: 1, bounds });

    expect(response?.type).toBe('built');
    if (response?.type !== 'built') return;
    expect(response.arrays.terrain.positions).toEqual(reference.terrain.positions);
    expect(response.arrays.terrain.colors).toEqual(reference.terrain.colors);
    expect(response.arrays.terrain.cellIndices).toEqual(reference.terrain.cellIndices);
    expect(response.arrays.terrain.normals).not.toBeNull();
    expect(response.arrays.roads !== null).toBe(reference.roads !== null);
  });

  it('flat normals match THREE.computeVertexNormals for non-indexed soup', () => {
    const map    = makeMap();
    const bounds = { colStart: 0, colEnd: 12, rowStart: 0, rowEnd: 12 };
    const geoms  = buildChunkGeometry(map, layout, bounds);
    const threeNormals = geoms.terrain.getAttribute('normal').array as Float32Array;

    const positions = geoms.terrain.getAttribute('position').array as Float32Array;
    const ours = computeFlatNormals(positions);

    expect(ours.length).toBe(threeNormals.length);
    for (let i = 0; i < ours.length; i++) {
      expect(Math.abs(ours[i] - threeNormals[i])).toBeLessThan(1e-6);
    }
  });

  it('reports an error for build before setMap', () => {
    const handle = createChunkWorkerHandler();
    const { response } = handle({
      type: 'build', id: 9,
      bounds: { colStart: 0, colEnd: 8, rowStart: 0, rowEnd: 8 },
    });
    expect(response?.type).toBe('error');
  });
});

describe('WorkerChunkBuilder', () => {
  it('resolves builds through a Worker-shaped transport', async () => {
    const map     = makeMap();
    const builder = new WorkerChunkBuilder(new FakeWorker());
    builder.syncMap(map, layout, {});
    const arrays = await builder.build({ colStart: 0, colEnd: 24, rowStart: 0, rowEnd: 24 });
    expect(arrays).not.toBeNull();
    expect(arrays!.terrain.positions.length).toBeGreaterThan(0);
    builder.dispose();
  });

  it('resolves in-flight builds with null on dispose', async () => {
    const worker  = new FakeWorker();
    const builder = new WorkerChunkBuilder(worker);
    const map     = makeMap();
    builder.syncMap(map, layout, {});
    const inFlight = builder.build({ colStart: 0, colEnd: 24, rowStart: 0, rowEnd: 24 });
    builder.dispose();
    expect(await inFlight).toBeNull();
    expect(worker.terminated).toBe(true);
  });
});

describe('ChunkManager worker streaming', () => {
  function managerPair(map: HexMap) {
    const asyncScene = new THREE.Scene();
    const syncScene  = new THREE.Scene();
    const material   = new THREE.MeshBasicMaterial();
    const asyncCm = new ChunkManager({
      map, layout, scene: asyncScene, material,
      chunkSize: 16, loadRadius: 1,
      workerFactory: () => new FakeWorker(),
    });
    const syncCm = new ChunkManager({
      map, layout, scene: syncScene, material,
      chunkSize: 16, loadRadius: 1,
    });
    return { asyncCm, syncCm };
  }

  it('streams chunks in asynchronously with geometry identical to the sync path', async () => {
    const map = makeMap();
    const { asyncCm, syncCm } = managerPair(map);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 10, 0);

    asyncCm.update(camera);
    expect(asyncCm.loadedChunkCount).toBe(0); // builds are in flight, not done

    await flushMicrotasks();
    expect(asyncCm.loadedChunkCount).toBeGreaterThan(0);

    syncCm.update(camera);
    expect(asyncCm.loadedChunkCount).toBe(syncCm.loadedChunkCount);

    const asyncPos = asyncCm.terrainMeshes.map(m => m.geometry.getAttribute('position').count).sort();
    const syncPos  = syncCm.terrainMeshes.map(m => m.geometry.getAttribute('position').count).sort();
    expect(asyncPos).toEqual(syncPos);

    asyncCm.dispose();
    syncCm.dispose();
  });

  it('drops stale async results after a map edit invalidates them', async () => {
    const map = makeMap();
    const { asyncCm } = managerPair(map);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 10, 0);

    asyncCm.update(camera);          // builds requested against snapshot A
    map.setElevation(1, 1, 9);
    asyncCm.markDirty(1, 1);         // invalidates snapshot A results
    await flushMicrotasks();
    expect(asyncCm.loadedChunkCount).toBe(0); // stale results dropped

    asyncCm.update(camera);          // re-requests against snapshot B
    await flushMicrotasks();
    expect(asyncCm.loadedChunkCount).toBeGreaterThan(0);
    asyncCm.dispose();
  });
});
