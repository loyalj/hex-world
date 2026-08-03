import * as THREE from 'three';
import type { HexLayout } from '../math/HexLayout.js';
import type { HexMap } from '../map/HexMap.js';
import { DEFAULT_TERRAIN_DEFINITIONS } from './TerrainTypes.js';
import {
  buildChunkArrays,
  type ChunkArrays,
  type ChunkBounds,
  type ChunkGeometryOptions,
  type PlainColor,
} from './HexChunkCore.js';

// The pure builder core (buildChunkArrays, ChunkBounds, ChunkGeometryOptions,
// computeFlatNormals, …) lives in HexChunkCore.ts so the chunk worker can run
// it without importing `three`. Re-exported here so existing imports keep
// working unchanged.
export * from './HexChunkCore.js';

const _fallbackColor = new THREE.Color(0x888888);

/**
 * The default vertex color for terrain indices that have no definition —
 * exported so the worker client serializes the exact same fallback the
 * synchronous path uses (THREE.Color applies sRGB→linear conversion, so the
 * value is not simply 0x88/255).
 */
export const TERRAIN_FALLBACK_COLOR: Readonly<PlainColor> = _fallbackColor;

export interface ChunkGeometries {
  terrain: THREE.BufferGeometry;
  roads: THREE.BufferGeometry | null;
}

/**
 * Fill in the option defaults that live on the THREE side of the split:
 * terrain definitions (resolved THREE.Color instances) and the fallback color.
 * `buildChunkGeometry` applies this automatically; the worker client calls it
 * before serializing options for the worker.
 */
export function resolveChunkGeometryOptions(opts: ChunkGeometryOptions): ChunkGeometryOptions {
  return {
    ...opts,
    terrainDefinitions: opts.terrainDefinitions ?? DEFAULT_TERRAIN_DEFINITIONS,
    fallbackColor:      opts.fallbackColor      ?? _fallbackColor,
  };
}

/**
 * Assemble THREE geometries from raw chunk arrays — the tail end of
 * `buildChunkGeometry`, split out so worker-built arrays (which arrive with
 * normals precomputed) go through the identical assembly path.
 */
export function chunkArraysToGeometries(arrays: ChunkArrays): ChunkGeometries {
  const t   = arrays.terrain;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',  new THREE.BufferAttribute(t.positions, 3));
  geo.setAttribute('color',     new THREE.BufferAttribute(t.colors, 3));
  geo.setAttribute('cellIndex', new THREE.BufferAttribute(t.cellIndices, 3));
  if (t.terrainTypes) {
    geo.setAttribute('terrainType', new THREE.BufferAttribute(t.terrainTypes, 3));
  }
  if (t.normals) geo.setAttribute('normal', new THREE.BufferAttribute(t.normals, 3));
  else geo.computeVertexNormals();

  let roadsGeo: THREE.BufferGeometry | null = null;
  if (arrays.roads) {
    const r = arrays.roads;
    roadsGeo = new THREE.BufferGeometry();
    roadsGeo.setAttribute('position',  new THREE.BufferAttribute(r.positions, 3));
    roadsGeo.setAttribute('uv',        new THREE.BufferAttribute(r.uvs, 2));
    roadsGeo.setAttribute('color',     new THREE.BufferAttribute(r.colors, 3));
    roadsGeo.setAttribute('cellIndex', new THREE.BufferAttribute(r.cellIndices, 1));
    if (r.normals) roadsGeo.setAttribute('normal', new THREE.BufferAttribute(r.normals, 3));
    else roadsGeo.computeVertexNormals();
  }

  return { terrain: geo, roads: roadsGeo };
}

/**
 * Builds the merged terrain (and optional roads) geometry for one chunk of the
 * map. Synchronous and single-threaded — for off-main-thread builds, drive the
 * same core through `WorkerChunkBuilder` instead.
 */
export function buildChunkGeometry(
  map: HexMap,
  layout: HexLayout,
  bounds: ChunkBounds,
  opts: ChunkGeometryOptions = {},
): ChunkGeometries {
  return chunkArraysToGeometries(buildChunkArrays(map, layout, bounds, resolveChunkGeometryOptions(opts)));
}
