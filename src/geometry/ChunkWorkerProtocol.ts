// ---------------------------------------------------------------------------
// Message protocol + handler for the chunk-build worker. Three-free (imported
// by the worker entry); the main-thread client lives in WorkerChunkBuilder.ts.
// The handler is a plain function so tests (and synchronous fallbacks) can
// drive it without a real Worker.
// ---------------------------------------------------------------------------
import { HexMap } from '../map/HexMap.js';
import type { HexLayout } from '../math/HexLayout.js';
import {
  buildChunkArrays,
  computeFlatNormals,
  type AmbientOcclusionOptions,
  type ChunkArrays,
  type ChunkBounds,
  type ChunkGeometryOptions,
  type ChunkTerrainColorSource,
  type PlainColor,
  type TerrainColorMode,
} from './HexChunkCore.js';

/**
 * The postMessage-safe subset of {@link ChunkGeometryOptions}: terrain
 * definitions reduced to plain colors, everything else already structured-
 * cloneable. Built by `serializeChunkGeometryOptions` on the main thread.
 */
export interface ChunkWorkerGeometryOptions {
  elevationScale?:      number;
  perturbStrength?:     number;
  elevPerturbStrength?: number;
  noiseScale?:          number;
  cliffThreshold?:      number;
  colorMode?:           TerrainColorMode;
  terrainDefinitions?:  ChunkTerrainColorSource[];
  fallbackColor?:       PlainColor;
  riverFlow?:           Map<number, number>;
  riverElevations?:     Map<number, number>;
  riverbedTerrain?:     number;
  riverBankFlare?:      number;
  riverbedBlend?:       number;
  ambientOcclusion?:    boolean | AmbientOcclusionOptions;
}

/** Uploads (or replaces) the worker's map snapshot, layout, and build options. */
export interface ChunkWorkerSetMapMessage {
  type:        'setMap';
  width:       number;
  height:      number;
  /** Copies of the map's per-cell channels the terrain builder reads. */
  cells:       ArrayBuffer;
  roadBits:    ArrayBuffer;
  riverInBits: ArrayBuffer;
  layout:      HexLayout;
  options:     ChunkWorkerGeometryOptions;
}

/** Requests one chunk build. `id` is echoed back on the response. */
export interface ChunkWorkerBuildMessage {
  type:   'build';
  id:     number;
  bounds: ChunkBounds;
}

export type ChunkWorkerRequest = ChunkWorkerSetMapMessage | ChunkWorkerBuildMessage;

export interface ChunkWorkerBuiltMessage {
  type:   'built';
  id:     number;
  arrays: ChunkArrays;
}

export interface ChunkWorkerErrorMessage {
  type:    'error';
  id:      number | null;
  message: string;
}

export type ChunkWorkerResponse = ChunkWorkerBuiltMessage | ChunkWorkerErrorMessage;

/** A handler invocation's result: the response to post (if any) plus its transfer list. */
export interface ChunkWorkerHandlerResult {
  response: ChunkWorkerResponse | null;
  transfer: ArrayBuffer[];
}

/**
 * Creates the worker-side message handler. Holds the current map snapshot in
 * closure state; `setMap` replaces it, `build` runs `buildChunkArrays` plus
 * flat-normal computation and returns the arrays with a transfer list so the
 * result buffers move (not copy) back to the main thread.
 */
export function createChunkWorkerHandler(): (msg: ChunkWorkerRequest) => ChunkWorkerHandlerResult {
  let map:     HexMap | null = null;
  let layout:  HexLayout | null = null;
  let options: ChunkWorkerGeometryOptions = {};

  return (msg: ChunkWorkerRequest): ChunkWorkerHandlerResult => {
    switch (msg.type) {
      case 'setMap': {
        // Reconstruct a real HexMap around the snapshot — the builder only
        // reads cells, roads, and river bits, so the other channels stay empty.
        map = new HexMap({ width: msg.width, height: msg.height });
        map.uint8.set(new Uint8Array(msg.cells));
        map.roadBits.set(new Uint8Array(msg.roadBits));
        map.riverInBits.set(new Uint8Array(msg.riverInBits));
        layout  = msg.layout;
        options = msg.options;
        return { response: null, transfer: [] };
      }
      case 'build': {
        if (!map || !layout) {
          return {
            response: { type: 'error', id: msg.id, message: 'chunk worker: build before setMap' },
            transfer: [],
          };
        }
        const arrays = buildChunkArrays(map, layout, msg.bounds, options);
        arrays.terrain.normals = computeFlatNormals(arrays.terrain.positions);
        if (arrays.roads) arrays.roads.normals = computeFlatNormals(arrays.roads.positions);

        const transfer: ArrayBuffer[] = [
          arrays.terrain.positions.buffer as ArrayBuffer,
          arrays.terrain.colors.buffer as ArrayBuffer,
          arrays.terrain.cellIndices.buffer as ArrayBuffer,
          arrays.terrain.normals.buffer as ArrayBuffer,
          arrays.terrain.occlusion.buffer as ArrayBuffer,
        ];
        if (arrays.terrain.terrainTypes) transfer.push(arrays.terrain.terrainTypes.buffer as ArrayBuffer);
        if (arrays.roads) {
          transfer.push(
            arrays.roads.positions.buffer as ArrayBuffer,
            arrays.roads.uvs.buffer as ArrayBuffer,
            arrays.roads.colors.buffer as ArrayBuffer,
            arrays.roads.cellIndices.buffer as ArrayBuffer,
            arrays.roads.normals!.buffer as ArrayBuffer,
            arrays.roads.occlusion.buffer as ArrayBuffer,
          );
        }
        return { response: { type: 'built', id: msg.id, arrays }, transfer };
      }
    }
  };
}
