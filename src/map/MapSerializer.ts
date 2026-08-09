import { HexMap } from './HexMap.js';
import type { ScatterDescriptor } from '../geometry/ScatterTypes.js';
import type { TerrainDescriptor } from '../geometry/TerrainTypes.js';
import type { LiquidTypeDescriptor } from '../geometry/LiquidTypes.js';
import type { ResourceDescriptor } from '../gameplay/ResourceTypes.js';
import type { FactionDescriptor } from '../gameplay/TerritoryLayer.js';
import { DEFAULT_WATER_TERRAIN_INDEX } from '../geometry/TerrainTypes.js';

const MAGIC   = [0x48, 0x58, 0x4d, 0x50]; // "HXMP"
const HEADER_SIZE = 14; // 4 magic + 1 version + 4 width + 4 height + 1 featureLayerCount

// ---------------------------------------------------------------------------
// Versioning
//
// VERSION is the format written by serializeMap / serializeMapJSON. Files with
// versions in [MIN_VERSION, VERSION] are accepted: older files are upgraded one
// step at a time through the migration tables below before being read.
//
// When bumping VERSION:
//   1. Increment VERSION here.
//   2. Add a migration keyed by the OLD version that converts its payload to
//      the next version's shape (binary migrations must also update the
//      version byte at index 4). Never remove existing migrations.
//   3. Only raise MIN_VERSION if you deliberately drop support for a format —
//      doing so strands every map and .hexpack saved in older versions.
// ---------------------------------------------------------------------------
// Version history:
//   1 — initial format: header, cells, roads, features.
//   2 — adds the incoming-river bitmask section (`riverInBits`, one byte per
//       cell) after features, enabling river confluences. v1 masks are derived
//       from each cell byte's single incoming direction.
//   3 — adds the sparse per-cell metadata channel (`HexMap.cellData`). Binary:
//       a u32-length-prefixed UTF-8 JSON trailer after riverInBits. JSON: an
//       optional `cellData` object keyed by flat cell index. v2 files upgrade
//       to an empty store.
const VERSION     = 3;
const MIN_VERSION = 1;

/** Derive a v2 incoming-river mask byte from a v1 cell byte (bits 2-0 = incoming+1). */
function riverMaskFromCellByte(cellByte: number): number {
  const incoming = cellByte & 0x07;
  return incoming === 0 ? 0 : 1 << (incoming - 1);
}

const BINARY_MIGRATIONS: Record<number, (data: Uint8Array) => Uint8Array> = {
  // v1 → v2: append the riverInBits section, derived from the cells' packed bytes.
  1: (data) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const width  = view.getUint32(5, true);
    const height = view.getUint32(9, true);
    const n = width * height;

    const out = new Uint8Array(data.byteLength + n);
    out.set(data);
    out[4] = 2;

    const cellsStart = HEADER_SIZE;
    const maskStart  = data.byteLength; // appended after the v1 payload
    for (let i = 0; i < n; i++) {
      out[maskStart + i] = riverMaskFromCellByte(data[cellsStart + i * 4 + 3]);
    }
    return out;
  },
  // v2 → v3: append an empty cell-metadata trailer (u32 length prefix of 0).
  2: (data) => {
    const out = new Uint8Array(data.byteLength + 4);
    out.set(data);
    out[4] = 3;
    return out;
  },
};

const JSON_MIGRATIONS: Record<number, (payload: Record<string, unknown>) => Record<string, unknown>> = {
  // v1 → v2: derive the riverIn mask array from the base64 cell data.
  1: (payload) => {
    const cells = base64ToUint8(payload.cells as string);
    const n = cells.byteLength / 4;
    const masks = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      masks[i] = riverMaskFromCellByte(cells[i * 4 + 3]);
    }
    return { ...payload, version: 2, riverIn: uint8ToBase64(masks) };
  },
  // v2 → v3: no data change — an absent `cellData` field means an empty store.
  2: (payload) => ({ ...payload, version: 3 }),
};

/** Upgrades a parsed payload's version step-by-step until it reaches VERSION. */
function migrateJSON(payload: Record<string, unknown>, label: string): Record<string, unknown> {
  let version = payload.version as number;
  while (version < VERSION) {
    const migrate = JSON_MIGRATIONS[version];
    if (!migrate) throw new Error(`${label}: no migration from version ${version} to ${version + 1}`);
    payload = migrate(payload);
    if ((payload.version as number) <= version) {
      throw new Error(`${label}: migration from version ${version} did not advance the version`);
    }
    version = payload.version as number;
  }
  return payload;
}

/** Upgrades binary data's version step-by-step until it reaches VERSION. */
function migrateBinary(data: Uint8Array, label: string): Uint8Array {
  let version = data[4];
  while (version < VERSION) {
    const migrate = BINARY_MIGRATIONS[version];
    if (!migrate) throw new Error(`${label}: no migration from version ${version} to ${version + 1}`);
    data = migrate(data);
    if (data[4] <= version) {
      throw new Error(`${label}: migration from version ${version} did not advance the version byte`);
    }
    version = data[4];
  }
  return data;
}

/**
 * The per-cell metadata channel as a plain sparse object keyed by flat cell
 * index, or `null` when the store is empty (so both formats can omit it).
 */
function cellDataToObject(map: HexMap): Record<string, Record<string, unknown>> | null {
  if (map.cellData.size === 0) return null;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [ci, record] of map.cellData) out[ci] = record;
  return out;
}

/** Validates and loads a parsed sparse cell-metadata object into the map. */
function applyCellDataObject(
  map: HexMap,
  obj: Record<string, unknown>,
  label: string,
): void {
  for (const [key, record] of Object.entries(obj)) {
    const ci = Number(key);
    if (!Number.isInteger(ci) || ci < 0 || ci >= map.cellCount) {
      throw new Error(
        `${label}: cell metadata index ${key} is out of range for a ${map.width}×${map.height} map`,
      );
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`${label}: cell metadata for index ${key} is not an object`);
    }
    map.cellData.set(ci, record as Record<string, unknown>);
  }
}

/** Metadata attached to a saved map. All fields are optional; `createdAt` is auto-populated by serializeMapJSON. */
export interface MapMetadata {
  /** Display name shown in map pickers and campaign screens. */
  name?:        string;
  /** RNG seed used during generation. */
  seed?:        number;
  /** Stable ID of the generator plugin that produced this map (e.g. 'fbm', 'chunk', 'hand-crafted'). */
  generatorId?: string;
  /** ISO 8601 creation timestamp. Set automatically by serializeMapJSON when not provided. */
  createdAt?:   string;
  /** Author name or identifier. */
  author?:      string;
  /** Short human-readable description of the map. */
  description?: string;
  /** Recommended player count. */
  playerCount?: number;
  /** Free-form tags for filtering and categorisation (e.g. ['pvp', 'large', 'island']). */
  tags?:        string[];
}

/**
 * The descriptor sets that can travel inside a JSON map, so a saved map is
 * self-describing: whatever the cells reference — terrain indices, liquid ids,
 * scatter assets, resource types, faction ids — is defined in the same file.
 */
export interface MapDescriptorSets {
  scatterDescriptors?:  ScatterDescriptor[];
  terrainDescriptors?:  TerrainDescriptor[];
  liquidDescriptors?:   LiquidTypeDescriptor[];
  /** Resource types the map's `cellData` resource entries refer to. */
  resourceDescriptors?: ResourceDescriptor[];
  /** Faction roster the map's `cellData` ownership entries refer to. */
  factions?:            FactionDescriptor[];
}

/** Result of deserializing a JSON map — includes the map, metadata, and descriptor sets. */
export interface DeserializedMap {
  map:                  HexMap;
  metadata:             MapMetadata;
  scatterDescriptors:   ScatterDescriptor[];
  terrainDescriptors:   TerrainDescriptor[];
  liquidDescriptors:    LiquidTypeDescriptor[];
  resourceDescriptors:  ResourceDescriptor[];
  factions:             FactionDescriptor[];
}

// --- Binary ---

/**
 * Serializes a HexMap to a compact binary Uint8Array.
 * Use for file saves, localStorage, or network transfer.
 * Pair with `deserializeMap`.
 *
 * The binary format stores per-cell data ONLY — including the `cellData`
 * metadata channel, but no MapMetadata and no descriptor arrays. Use
 * `serializeMapJSON` when metadata or descriptors must travel with the map
 * (HexPack does this automatically for entries that carry metadata).
 */
export function serializeMap(map: HexMap): Uint8Array {
  const featureBytes = map.featureData ? map.featureData.byteLength : 0;
  const cellDataObj  = cellDataToObject(map);
  const metaBytes    = cellDataObj ? new TextEncoder().encode(JSON.stringify(cellDataObj)) : null;
  const metaLength   = metaBytes ? metaBytes.byteLength : 0;
  const out  = new Uint8Array(
    HEADER_SIZE + map.uint8.byteLength + map.roadBits.byteLength + featureBytes
    + map.riverInBits.byteLength + 4 + metaLength,
  );
  const view = new DataView(out.buffer);

  out[0] = MAGIC[0]; out[1] = MAGIC[1]; out[2] = MAGIC[2]; out[3] = MAGIC[3];
  out[4] = VERSION;
  view.setUint32(5, map.width,             true);
  view.setUint32(9, map.height,            true);
  out[13] = map.featureLayerCount;

  let offset = HEADER_SIZE;
  out.set(map.uint8,     offset); offset += map.uint8.byteLength;
  out.set(map.roadBits,  offset); offset += map.roadBits.byteLength;
  if (map.featureData) { out.set(map.featureData, offset); offset += map.featureData.byteLength; }
  out.set(map.riverInBits, offset); offset += map.riverInBits.byteLength;

  // Cell-metadata trailer: u32 byte length + UTF-8 JSON (length 0 = no data).
  view.setUint32(offset, metaLength, true); offset += 4;
  if (metaBytes) out.set(metaBytes, offset);

  return out;
}

/**
 * Deserializes a HexMap from binary data produced by `serializeMap`.
 * Accepts versions MIN_VERSION..VERSION, upgrading older files via migrations.
 * Throws on invalid magic bytes, out-of-range versions, corrupt headers, or
 * truncated data.
 */
export function deserializeMap(data: Uint8Array, isWater?: (terrain: number) => boolean): HexMap {
  if (data.byteLength < HEADER_SIZE) {
    throw new Error(`deserializeMap: data too short (${data.byteLength} bytes) to contain a map header`);
  }
  if (data[0] !== MAGIC[0] || data[1] !== MAGIC[1] || data[2] !== MAGIC[2] || data[3] !== MAGIC[3]) {
    throw new Error('deserializeMap: invalid magic bytes — not a hex-world map file');
  }
  const rawVersion = data[4];
  if (rawVersion < MIN_VERSION || rawVersion > VERSION) {
    throw new Error(
      `deserializeMap: unsupported version ${rawVersion} (supported: ${MIN_VERSION}–${VERSION}). ` +
      `Files newer than this library cannot be read — upgrade @loyalj/hex-world.`,
    );
  }
  data = migrateBinary(data, 'deserializeMap');

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width             = view.getUint32(5, true);
  const height            = view.getUint32(9, true);
  const featureLayerCount = data[13];

  if (width === 0 || height === 0 || width > 0xffff || height > 0xffff) {
    throw new Error(`deserializeMap: corrupt header — implausible map size ${width}×${height}`);
  }

  const map = new HexMap({ width, height, featureLayerCount });

  // Validate total length BEFORE copying — Uint8Array.set with a short
  // subarray would otherwise silently produce a partially zero-filled map.
  // The fixed sections are followed by the 4-byte cell-metadata length prefix.
  const expected = HEADER_SIZE + map.uint8.byteLength + map.roadBits.byteLength
    + (map.featureData?.byteLength ?? 0) + map.riverInBits.byteLength + 4;
  if (data.byteLength < expected) {
    throw new Error(
      `deserializeMap: truncated data — a ${width}×${height} map with ` +
      `${featureLayerCount} feature layer(s) needs ${expected} bytes, got ${data.byteLength}`,
    );
  }

  let offset = HEADER_SIZE;
  map.uint8.set(data.subarray(offset, offset + map.uint8.byteLength));
  offset += map.uint8.byteLength;
  map.roadBits.set(data.subarray(offset, offset + map.roadBits.byteLength));
  offset += map.roadBits.byteLength;
  if (map.featureData) {
    map.featureData.set(data.subarray(offset, offset + map.featureData.byteLength));
    offset += map.featureData.byteLength;
  }
  map.riverInBits.set(data.subarray(offset, offset + map.riverInBits.byteLength));
  offset += map.riverInBits.byteLength;

  const metaLength = view.getUint32(offset, true);
  offset += 4;
  if (metaLength > 0) {
    if (data.byteLength < offset + metaLength) {
      throw new Error(
        `deserializeMap: truncated cell metadata — trailer declares ${metaLength} bytes, ` +
        `got ${data.byteLength - offset}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(data.subarray(offset, offset + metaLength)));
    } catch {
      throw new Error('deserializeMap: corrupt cell metadata trailer — invalid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('deserializeMap: corrupt cell metadata trailer — expected an object');
    }
    applyCellDataObject(map, parsed as Record<string, unknown>, 'deserializeMap');
  }

  map.computeWaterSurfaces(isWater);
  return map;
}

// --- JSON ---

interface MapJSON {
  version:           number;
  width:             number;
  height:            number;
  featureLayerCount: number;
  cells:             string;
  roads:             string;
  features:          string;
  /** Base64 incoming-river bitmask array (v2+). */
  riverIn:           string;
  /** Sparse per-cell metadata records keyed by flat cell index (v3+, omitted when empty). */
  cellData?:         Record<string, Record<string, unknown>>;
  name?:             string;
  seed?:             number;
  generatorId?:      string;
  createdAt?:        string;
  author?:           string;
  description?:      string;
  playerCount?:      number;
  tags?:             string[];
  scatterDescriptors?:   ScatterDescriptor[];
  terrainDescriptors?:   TerrainDescriptor[];
  liquidDescriptors?:    LiquidTypeDescriptor[];
  resourceDescriptors?:  ResourceDescriptor[];
  factions?:             FactionDescriptor[];
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
 *
 * Descriptor sets can be passed either as a single {@link MapDescriptorSets}
 * object (which is the only way to include resource and faction sets) or, for
 * backwards compatibility, positionally as scatter, terrain, and liquid arrays.
 *
 * @example
 * serializeMapJSON(map, { name: 'Kelmar Basin' }, {
 *   terrainDescriptors, liquidDescriptors, resourceDescriptors, factions,
 * });
 */
export function serializeMapJSON(
  map: HexMap,
  metadata?: MapMetadata,
  descriptors?: MapDescriptorSets,
): string;
export function serializeMapJSON(
  map: HexMap,
  metadata?: MapMetadata,
  scatterDescriptors?: ScatterDescriptor[],
  terrainDescriptors?: TerrainDescriptor[],
  liquidDescriptors?: LiquidTypeDescriptor[],
): string;
export function serializeMapJSON(
  map: HexMap,
  metadata: MapMetadata = {},
  scatterOrSets?: ScatterDescriptor[] | MapDescriptorSets,
  terrainDescriptorsArg?: TerrainDescriptor[],
  liquidDescriptorsArg?: LiquidTypeDescriptor[],
): string {
  const sets: MapDescriptorSets = Array.isArray(scatterOrSets) || scatterOrSets === undefined
    ? {
        scatterDescriptors: scatterOrSets,
        terrainDescriptors: terrainDescriptorsArg,
        liquidDescriptors:  liquidDescriptorsArg,
      }
    : scatterOrSets;
  const { scatterDescriptors, terrainDescriptors, liquidDescriptors, resourceDescriptors, factions } = sets;

  const payload: MapJSON = {
    version:           VERSION,
    width:             map.width,
    height:            map.height,
    featureLayerCount: map.featureLayerCount,
    cells:    uint8ToBase64(map.uint8),
    roads:    uint8ToBase64(map.roadBits),
    features: map.featureData ? uint8ToBase64(map.featureData) : '',
    riverIn:  uint8ToBase64(map.riverInBits),
    ...(map.cellData.size > 0 ? { cellData: cellDataToObject(map)! } : {}),
    ...metadata,
    createdAt: metadata.createdAt ?? new Date().toISOString(),
    ...(scatterDescriptors  && scatterDescriptors.length  > 0 ? { scatterDescriptors }  : {}),
    ...(terrainDescriptors  && terrainDescriptors.length  > 0 ? { terrainDescriptors }  : {}),
    ...(liquidDescriptors   && liquidDescriptors.length   > 0 ? { liquidDescriptors }   : {}),
    ...(resourceDescriptors && resourceDescriptors.length > 0 ? { resourceDescriptors } : {}),
    ...(factions            && factions.length            > 0 ? { factions }            : {}),
  };
  return JSON.stringify(payload);
}

/**
 * Deserializes a HexMap from a JSON string produced by `serializeMapJSON`.
 * Returns the map and any metadata that was stored with it.
 * Accepts versions MIN_VERSION..VERSION, upgrading older files via migrations.
 * Throws on out-of-range versions or cell data whose size doesn't match the
 * declared dimensions.
 */
export function deserializeMapJSON(json: string): DeserializedMap {
  let raw = JSON.parse(json) as Record<string, unknown>;
  const rawVersion = raw.version as number;
  if (typeof rawVersion !== 'number' || rawVersion < MIN_VERSION || rawVersion > VERSION) {
    throw new Error(
      `deserializeMapJSON: unsupported version ${rawVersion} (supported: ${MIN_VERSION}–${VERSION}). ` +
      `Files newer than this library cannot be read — upgrade @loyalj/hex-world.`,
    );
  }
  raw = migrateJSON(raw, 'deserializeMapJSON');
  const p = raw as unknown as MapJSON;

  const map = new HexMap({ width: p.width, height: p.height, featureLayerCount: p.featureLayerCount });

  const cells = base64ToUint8(p.cells);
  if (cells.byteLength !== map.uint8.byteLength) {
    throw new Error(
      `deserializeMapJSON: cell data is ${cells.byteLength} bytes but a ` +
      `${p.width}×${p.height} map needs ${map.uint8.byteLength}`,
    );
  }
  const roads = base64ToUint8(p.roads);
  if (roads.byteLength !== map.roadBits.byteLength) {
    throw new Error(
      `deserializeMapJSON: road data is ${roads.byteLength} bytes but a ` +
      `${p.width}×${p.height} map needs ${map.roadBits.byteLength}`,
    );
  }
  const riverIn = base64ToUint8(p.riverIn);
  if (riverIn.byteLength !== map.riverInBits.byteLength) {
    throw new Error(
      `deserializeMapJSON: river data is ${riverIn.byteLength} bytes but a ` +
      `${p.width}×${p.height} map needs ${map.riverInBits.byteLength}`,
    );
  }
  map.uint8.set(cells);
  map.roadBits.set(roads);
  map.riverInBits.set(riverIn);
  if (map.featureData && p.features) {
    const features = base64ToUint8(p.features);
    if (features.byteLength !== map.featureData.byteLength) {
      throw new Error(
        `deserializeMapJSON: feature data is ${features.byteLength} bytes but ` +
        `${p.featureLayerCount} layer(s) on a ${p.width}×${p.height} map need ${map.featureData.byteLength}`,
      );
    }
    map.featureData.set(features);
  }
  if (p.cellData) {
    if (typeof p.cellData !== 'object' || Array.isArray(p.cellData)) {
      throw new Error('deserializeMapJSON: cellData must be an object keyed by cell index');
    }
    applyCellDataObject(map, p.cellData, 'deserializeMapJSON');
  }

  // Build isWater predicate from embedded terrain descriptors so custom liquid
  // types (lava, acid, …) get correct water surfaces after deserialization.
  // Falls back to built-in water only when no descriptors are saved.
  const savedDescriptors = p.terrainDescriptors ?? [];
  const liquidIndices = new Set<number>(
    savedDescriptors
      .filter(d => d.liquidType != null || d.isWater)
      .map(d => d.index),
  );
  if (liquidIndices.size === 0) liquidIndices.add(DEFAULT_WATER_TERRAIN_INDEX);
  map.computeWaterSurfaces(t => liquidIndices.has(t));

  return {
    map,
    metadata: {
      name:        p.name,
      seed:        p.seed,
      generatorId: p.generatorId,
      createdAt:   p.createdAt,
      author:      p.author,
      description: p.description,
      playerCount: p.playerCount,
      tags:        p.tags,
    },
    scatterDescriptors:  p.scatterDescriptors  ?? [],
    terrainDescriptors:  p.terrainDescriptors  ?? [],
    liquidDescriptors:   p.liquidDescriptors   ?? [],
    resourceDescriptors: p.resourceDescriptors ?? [],
    factions:            p.factions            ?? [],
  };
}
