import { HexMap } from './HexMap.js';
import type { ScatterDescriptor } from '../geometry/ScatterTypes.js';
import type { TerrainDescriptor } from '../geometry/TerrainTypes.js';

const MAGIC   = [0x48, 0x58, 0x4d, 0x50]; // "HXMP"
const VERSION = 1;
const HEADER_SIZE = 14; // 4 magic + 1 version + 4 width + 4 height + 1 featureLayerCount

/** Optional metadata attached to a saved map (name, generator, seed). */
export interface MapMetadata {
  name?:        string;
  seed?:        number;
  generatorId?: string;
}

/** Result of deserializing a JSON map — includes the map, metadata, and descriptor sets. */
export interface DeserializedMap {
  map:                 HexMap;
  metadata:            MapMetadata;
  scatterDescriptors:  ScatterDescriptor[];
  terrainDescriptors:  TerrainDescriptor[];
}

// --- Binary ---

/**
 * Serializes a HexMap to a compact binary Uint8Array.
 * Use for file saves, localStorage, or network transfer.
 * Pair with `deserializeMap`.
 */
export function serializeMap(map: HexMap): Uint8Array {
  const featureBytes = map.featureData ? map.featureData.byteLength : 0;
  const out  = new Uint8Array(HEADER_SIZE + map.uint8.byteLength + map.roadBits.byteLength + featureBytes);
  const view = new DataView(out.buffer);

  out[0] = MAGIC[0]; out[1] = MAGIC[1]; out[2] = MAGIC[2]; out[3] = MAGIC[3];
  out[4] = VERSION;
  view.setUint32(5, map.width,             true);
  view.setUint32(9, map.height,            true);
  out[13] = map.featureLayerCount;

  let offset = HEADER_SIZE;
  out.set(map.uint8,     offset); offset += map.uint8.byteLength;
  out.set(map.roadBits,  offset); offset += map.roadBits.byteLength;
  if (map.featureData) out.set(map.featureData, offset);

  return out;
}

/**
 * Deserializes a HexMap from binary data produced by `serializeMap`.
 * Throws if the magic bytes or version are unrecognised.
 */
export function deserializeMap(data: Uint8Array): HexMap {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  if (data[0] !== MAGIC[0] || data[1] !== MAGIC[1] || data[2] !== MAGIC[2] || data[3] !== MAGIC[3]) {
    throw new Error('deserializeMap: invalid magic bytes — not a hex-world map file');
  }
  const version = data[4];
  if (version !== VERSION) {
    throw new Error(`deserializeMap: unsupported version ${version} (expected ${VERSION})`);
  }

  const width             = view.getUint32(5, true);
  const height            = view.getUint32(9, true);
  const featureLayerCount = data[13];

  const map = new HexMap({ width, height, featureLayerCount });

  let offset = HEADER_SIZE;
  map.uint8.set(data.subarray(offset, offset + map.uint8.byteLength));
  offset += map.uint8.byteLength;
  map.roadBits.set(data.subarray(offset, offset + map.roadBits.byteLength));
  offset += map.roadBits.byteLength;
  if (map.featureData) {
    map.featureData.set(data.subarray(offset, offset + map.featureData.byteLength));
  }

  return map;
}

// --- JSON ---

interface MapJSON {
  version: number;
  width: number;
  height: number;
  featureLayerCount: number;
  cells: string;
  roads: string;
  features: string;
  name?:                string;
  seed?:                number;
  generatorId?:         string;
  scatterDescriptors?:  ScatterDescriptor[];
  terrainDescriptors?:  TerrainDescriptor[];
}

function uint8ToBase64(data: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, Math.min(i + chunk, data.length)));
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Serializes a HexMap to a JSON string with base64-encoded cell data.
 * Suitable for clipboard, editor state, or human-readable export.
 * Pair with `deserializeMapJSON`.
 */
export function serializeMapJSON(
  map: HexMap,
  metadata: MapMetadata = {},
  scatterDescriptors?: ScatterDescriptor[],
  terrainDescriptors?: TerrainDescriptor[],
): string {
  const payload: MapJSON = {
    version:           VERSION,
    width:             map.width,
    height:            map.height,
    featureLayerCount: map.featureLayerCount,
    cells:    uint8ToBase64(map.uint8),
    roads:    uint8ToBase64(map.roadBits),
    features: map.featureData ? uint8ToBase64(map.featureData) : '',
    ...metadata,
    ...(scatterDescriptors  && scatterDescriptors.length  > 0 ? { scatterDescriptors }  : {}),
    ...(terrainDescriptors  && terrainDescriptors.length  > 0 ? { terrainDescriptors }  : {}),
  };
  return JSON.stringify(payload);
}

/**
 * Deserializes a HexMap from a JSON string produced by `serializeMapJSON`.
 * Returns the map and any metadata that was stored with it.
 * Throws if the version is unrecognised.
 */
export function deserializeMapJSON(json: string): DeserializedMap {
  const p = JSON.parse(json) as MapJSON;
  if (p.version !== VERSION) {
    throw new Error(`deserializeMapJSON: unsupported version ${p.version} (expected ${VERSION})`);
  }
  const map = new HexMap({ width: p.width, height: p.height, featureLayerCount: p.featureLayerCount });
  map.uint8.set(base64ToUint8(p.cells));
  map.roadBits.set(base64ToUint8(p.roads));
  if (map.featureData && p.features) {
    map.featureData.set(base64ToUint8(p.features));
  }
  return {
    map,
    metadata:           { name: p.name, seed: p.seed, generatorId: p.generatorId },
    scatterDescriptors: p.scatterDescriptors ?? [],
    terrainDescriptors: p.terrainDescriptors ?? [],
  };
}
