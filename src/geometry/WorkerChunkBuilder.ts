// ---------------------------------------------------------------------------
// Main-thread client for the chunk-build worker. Wraps any Worker-shaped
// object (a real Web Worker, or a synchronous fake in tests) in a promise API.
// ---------------------------------------------------------------------------
import type { HexMap } from '../map/HexMap.js';
import type { HexLayout } from '../math/HexLayout.js';
import type { ChunkArrays, ChunkBounds, ChunkGeometryOptions } from './HexChunkCore.js';
import { resolveChunkGeometryOptions } from './HexChunk.js';
import type {
  ChunkWorkerGeometryOptions,
  ChunkWorkerRequest,
  ChunkWorkerResponse,
} from './ChunkWorkerProtocol.js';

/**
 * The Worker surface WorkerChunkBuilder needs — a real `Worker` satisfies it.
 * Tests supply a fake that runs the protocol handler in-process.
 */
export interface ChunkWorkerLike {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  onmessage: ((event: { data: ChunkWorkerResponse }) => void) | null;
  terminate(): void;
}

/**
 * Creates the library's bundled chunk worker. Call sites that bundle with
 * Vite/Rollup/webpack 5 get automatic worker chunking via the
 * `new URL(..., import.meta.url)` pattern; environments without `Worker`
 * (Node, vitest) should not call this — pass a custom factory or none at all.
 */
export function createDefaultChunkWorker(): ChunkWorkerLike {
  const worker = new Worker(new URL('./chunk.worker.ts', import.meta.url), { type: 'module' });
  // Thin adapter — Worker's postMessage overloads don't accept an optional
  // transfer list in one signature, so bridge the difference here.
  return {
    postMessage(message: unknown, transfer?: ArrayBuffer[]): void {
      if (transfer && transfer.length > 0) worker.postMessage(message, transfer);
      else worker.postMessage(message);
    },
    get onmessage() {
      return worker.onmessage as ChunkWorkerLike['onmessage'];
    },
    set onmessage(handler: ChunkWorkerLike['onmessage']) {
      worker.onmessage = handler as unknown as Worker['onmessage'];
    },
    terminate(): void { worker.terminate(); },
  };
}

/**
 * Reduce runtime {@link ChunkGeometryOptions} (which may hold THREE.Color
 * instances) to the postMessage-safe shape the worker consumes.
 */
export function serializeChunkGeometryOptions(opts: ChunkGeometryOptions): ChunkWorkerGeometryOptions {
  const resolved = resolveChunkGeometryOptions(opts);
  return {
    elevationScale:      resolved.elevationScale,
    perturbStrength:     resolved.perturbStrength,
    elevPerturbStrength: resolved.elevPerturbStrength,
    noiseScale:          resolved.noiseScale,
    cliffThreshold:      resolved.cliffThreshold,
    colorMode:           resolved.colorMode,
    terrainDefinitions:  resolved.terrainDefinitions?.map(d => ({
      index: d.index,
      color: { r: d.color.r, g: d.color.g, b: d.color.b },
      ...(d.roadColor ? { roadColor: [d.roadColor[0], d.roadColor[1], d.roadColor[2]] as const } : {}),
    })),
    fallbackColor: resolved.fallbackColor
      ? { r: resolved.fallbackColor.r, g: resolved.fallbackColor.g, b: resolved.fallbackColor.b }
      : undefined,
    riverFlow: resolved.riverFlow,
  };
}

/**
 * Promise-based chunk building on a worker: `syncMap` uploads the map snapshot
 * and options, `build` requests one chunk's arrays. Responses resolve in any
 * order (matched by id). `dispose` terminates the worker and rejects all
 * in-flight builds with `null` resolutions so callers can simply drop them.
 */
export class WorkerChunkBuilder {
  private readonly worker: ChunkWorkerLike;
  private readonly pending = new Map<number, (arrays: ChunkArrays | null) => void>();
  private nextId   = 0;
  private disposed = false;

  constructor(worker: ChunkWorkerLike) {
    this.worker = worker;
    this.worker.onmessage = (event) => this.handleResponse(event.data);
  }

  private handleResponse(msg: ChunkWorkerResponse): void {
    if (msg.type === 'error') {
      if (msg.id !== null) {
        const resolve = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve?.(null);
      }
      console.error(`WorkerChunkBuilder: ${msg.message}`);
      return;
    }
    const resolve = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    resolve?.(msg.arrays);
  }

  /**
   * Upload the current map state, layout, and geometry options. Buffers are
   * copied (not transferred) so the main-thread map stays usable. Call again
   * after any map edit before requesting rebuilds — the worker builds from its
   * snapshot, not the live map.
   */
  syncMap(map: HexMap, layout: HexLayout, options: ChunkGeometryOptions): void {
    if (this.disposed) return;
    const cells       = map.uint8.slice().buffer;
    const roadBits    = map.roadBits.slice().buffer;
    const riverInBits = map.riverInBits.slice().buffer;
    const msg: ChunkWorkerRequest = {
      type: 'setMap',
      width: map.width,
      height: map.height,
      cells, roadBits, riverInBits,
      layout,
      options: serializeChunkGeometryOptions(options),
    };
    // The snapshot copies are transferred — they exist only for the worker.
    this.worker.postMessage(msg, [cells, roadBits, riverInBits]);
  }

  /**
   * Request one chunk build against the last-synced snapshot. Resolves with
   * the finished arrays (normals included), or `null` if the build failed or
   * the builder was disposed mid-flight.
   */
  build(bounds: ChunkBounds): Promise<ChunkArrays | null> {
    if (this.disposed) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise<ChunkArrays | null>((resolve) => {
      this.pending.set(id, resolve);
      const msg: ChunkWorkerRequest = { type: 'build', id, bounds };
      this.worker.postMessage(msg);
    });
  }

  /** Number of builds currently in flight. */
  get pendingCount(): number { return this.pending.size; }

  /** Terminate the worker and resolve all in-flight builds with `null`. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
    this.worker.terminate();
  }
}
