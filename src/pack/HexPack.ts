import * as THREE from 'three';
import { unzip, zip } from 'fflate';
import { buildTerrainTextureArray } from '../geometry/TerrainTextures.js';
import { createTerrainMaterial, type TerrainMaterialOptions } from '../geometry/TerrainMaterial.js';
import {
  resolveTerrainDefinitions,
  type TerrainDescriptor,
  type TerrainDefinition,
  type TerrainAssetRegistry,
} from '../geometry/TerrainTypes.js';
import {
  resolveLiquidMaterials,
  DEFAULT_LIQUID_DESCRIPTORS,
  type LiquidTypeDescriptor,
  type LiquidMaterialSet,
} from '../geometry/LiquidTypes.js';
import {
  resolveScatterDefinition,
  type ScatterDescriptor,
  type ScatterDefinition,
  type ScatterAsset,
  type ScatterAssetRegistry,
} from '../geometry/ScatterTypes.js';
import {
  deserializeMap,
  deserializeMapJSON,
  serializeMap,
  serializeMapJSON,
  type MapMetadata,
} from '../map/MapSerializer.js';
import type { ResourceDescriptor } from '../gameplay/ResourceTypes.js';
import type { FactionDescriptor } from '../gameplay/TerritoryLayer.js';
import type { HexMap } from '../map/HexMap.js';

const PACK_VERSION = 1;

// ---------------------------------------------------------------------------
// Manifest types (stored in manifest.json inside the zip)
// ---------------------------------------------------------------------------

export interface HexPackMapEntry {
  /** Stable ID used to look up the map in HexPackage.maps. */
  id: string;
  /** Display name. */
  name?: string;
  /** Path to the map file inside the zip. */
  path: string;
  /** 'binary' uses serializeMap (.hxmp); 'json' uses serializeMapJSON (.json). */
  format: 'binary' | 'json';
}

export interface HexPackManifest {
  version: number;
  name?: string;
  terrainDescriptors: TerrainDescriptor[];
  liquidDescriptors?: LiquidTypeDescriptor[];
  scatterDescriptors?: ScatterDescriptor[];
  /** Resource types the packed maps' `cellData` resource entries refer to. */
  resourceDescriptors?: ResourceDescriptor[];
  /** Faction roster the packed maps' `cellData` ownership entries refer to. */
  factions?: FactionDescriptor[];
  /** assetId → relative path inside the zip. */
  assets?: Record<string, string>;
  maps?: HexPackMapEntry[];
}

// ---------------------------------------------------------------------------
// Load API
// ---------------------------------------------------------------------------

/** Minimal interface the caller's GLTFLoader must satisfy. */
export interface GltfLoaderLike {
  loadAsync(url: string): Promise<{ scene: THREE.Group }>;
}

export interface LoadHexPackOptions {
  /**
   * GLTFLoader instance for loading scatter model assets.
   * Required if the pack contains GLB/GLTF scatter models.
   * If omitted, scatter descriptors are returned as-is and scatterDefinitions is empty.
   */
  gltfLoader?: GltfLoaderLike;
  /** Load only these map IDs. Default: load all maps. */
  mapIds?: string[];
  /** Lighting and texture options forwarded to createTerrainMaterial. */
  terrainMaterialOptions?: TerrainMaterialOptions;
}

/** Fully resolved, render-ready contents of a hexpack. */
export interface HexPackage {
  terrainDescriptors:  TerrainDescriptor[];
  terrainDefinitions:  TerrainDefinition[];
  /** The DataArrayTexture used to build terrainMaterial — pass to createTerrainMaterial to use custom lighting. */
  terrainTexture:      THREE.DataArrayTexture;
  /** Pre-built terrain material using terrainMaterialOptions (or defaults). */
  terrainMaterial:     THREE.ShaderMaterial;
  liquidDescriptors:   LiquidTypeDescriptor[];
  liquidMaterials:     Map<string, LiquidMaterialSet>;
  scatterDescriptors:  ScatterDescriptor[];
  /** Populated only when a gltfLoader is supplied and the pack contains model assets. */
  scatterDefinitions:  ScatterDefinition[];
  /** Resource types carried by the pack — hand to a `ResourceLayer`. Empty when the pack defines none. */
  resourceDescriptors: ResourceDescriptor[];
  /** Faction roster carried by the pack — hand to a `TerritoryLayer`. Empty when the pack defines none. */
  factions:            FactionDescriptor[];
  /** Loaded maps keyed by HexPackMapEntry.id. */
  maps:                Map<string, HexMap>;
}

/**
 * Loads a hexpack from a URL, File, Blob, or raw Uint8Array.
 * Unzips, parses the manifest, loads all assets, and returns render-ready objects.
 */
export async function loadHexPack(
  source: string | File | Blob | Uint8Array,
  opts: LoadHexPackOptions = {},
): Promise<HexPackage> {
  // 1. Fetch raw bytes
  let bytes: Uint8Array;
  if (typeof source === 'string') {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`loadHexPack: fetch failed (${res.status}) for "${source}"`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } else if (source instanceof Uint8Array) {
    bytes = source;
  } else {
    bytes = new Uint8Array(await (source as Blob).arrayBuffer());
  }

  // 2. Unzip
  const files = await unzipAsync(bytes);

  // 3. Parse manifest
  const manifestData = files['manifest.json'];
  if (!manifestData) throw new Error('loadHexPack: manifest.json not found in pack');
  const manifest = JSON.parse(new TextDecoder().decode(manifestData)) as HexPackManifest;
  if (manifest.version !== PACK_VERSION) {
    throw new Error(`loadHexPack: unsupported version ${manifest.version} (expected ${PACK_VERSION})`);
  }

  const terrainDescriptors  = manifest.terrainDescriptors;
  const liquidDescriptors   = manifest.liquidDescriptors   ?? DEFAULT_LIQUID_DESCRIPTORS;
  const scatterDescriptors  = manifest.scatterDescriptors  ?? [];
  const resourceDescriptors = manifest.resourceDescriptors ?? [];
  const factions            = manifest.factions            ?? [];
  const assetPaths          = manifest.assets ?? {};

  // 4. Load terrain image assets into registry
  const terrainRegistry: TerrainAssetRegistry = new Map();
  const imageIds = terrainDescriptors
    .filter(d => d.texture.type === 'image' && d.texture.assetId != null)
    .map(d => d.texture.assetId!);

  await Promise.all(imageIds.map(async assetId => {
    const path = assetPaths[assetId];
    if (!path) throw new Error(`loadHexPack: no asset path for terrain texture "${assetId}"`);
    const data = files[path];
    if (!data) throw new Error(`loadHexPack: missing file "${path}" for asset "${assetId}"`);
    terrainRegistry.set(assetId, await createImageBitmap(new Blob([toArrayBuffer(data)])));
  }));

  // 5. Build terrain
  const terrainDefinitions = resolveTerrainDefinitions(terrainDescriptors);
  const terrainTexture     = await buildTerrainTextureArray(terrainDescriptors, terrainRegistry);
  const terrainMaterial    = createTerrainMaterial(terrainTexture, opts.terrainMaterialOptions);

  // 6. Build liquid materials (fully derived from descriptor colors)
  const liquidMaterials = new Map(liquidDescriptors.map(d => [d.id, resolveLiquidMaterials(d)]));

  // 7. Load scatter GLB models and resolve definitions
  const scatterDefinitions: ScatterDefinition[] = [];
  if (scatterDescriptors.length > 0 && opts.gltfLoader) {
    const scatterRegistry: ScatterAssetRegistry = new Map();

    const modelIds = new Set(scatterDescriptors.flatMap(d => d.tiers.flat().map(v => v.assetId)));
    await Promise.all([...modelIds].map(async assetId => {
      const path = assetPaths[assetId];
      if (!path) throw new Error(`loadHexPack: no asset path for scatter model "${assetId}"`);
      const data = files[path];
      if (!data) throw new Error(`loadHexPack: missing file "${path}" for asset "${assetId}"`);

      const url = URL.createObjectURL(new Blob([toArrayBuffer(data)], { type: 'model/gltf-binary' }));
      try {
        const gltf = await opts.gltfLoader!.loadAsync(url);
        const asset = extractFirstMesh(gltf.scene);
        if (!asset) throw new Error(`loadHexPack: no mesh found in GLTF asset "${assetId}"`);
        scatterRegistry.set(assetId, asset);
      } finally {
        URL.revokeObjectURL(url);
      }
    }));

    for (const desc of scatterDescriptors) {
      scatterDefinitions.push(resolveScatterDefinition(desc, scatterRegistry));
    }
  }

  // 8. Deserialize maps
  const maps = new Map<string, HexMap>();
  const liquidIndices = new Set(
    terrainDescriptors.filter(d => d.liquidType != null || d.isWater).map(d => d.index),
  );
  const isWater = (t: number) => liquidIndices.has(t);

  const entriesToLoad = (manifest.maps ?? []).filter(
    e => !opts.mapIds || opts.mapIds.includes(e.id),
  );
  for (const entry of entriesToLoad) {
    const data = files[entry.path];
    if (!data) throw new Error(`loadHexPack: missing map file "${entry.path}"`);
    if (entry.format === 'json') {
      maps.set(entry.id, deserializeMapJSON(new TextDecoder().decode(data)).map);
    } else {
      maps.set(entry.id, deserializeMap(data, isWater));
    }
  }

  return {
    terrainDescriptors, terrainDefinitions, terrainTexture, terrainMaterial,
    liquidDescriptors, liquidMaterials,
    scatterDescriptors, scatterDefinitions,
    resourceDescriptors, factions,
    maps,
  };
}

// ---------------------------------------------------------------------------
// Export API
// ---------------------------------------------------------------------------

export interface ExportMapEntry {
  id: string;
  name?: string;
  map: HexMap;
  metadata?: MapMetadata;
  /**
   * Serialization format for this map's file inside the pack.
   * Defaults to 'json' when `metadata` is provided (the binary format cannot
   * store metadata and would silently drop it), otherwise 'binary' for
   * compactness. Set explicitly to override.
   */
  format?: 'binary' | 'json';
}

export interface ExportHexPackOptions {
  name?: string;
  terrainDescriptors: TerrainDescriptor[];
  liquidDescriptors?: LiquidTypeDescriptor[];
  scatterDescriptors?: ScatterDescriptor[];
  /** Resource types the packed maps use. Travels in the manifest and in each JSON map. */
  resourceDescriptors?: ResourceDescriptor[];
  /** Faction roster the packed maps' ownership refers to. Travels in the manifest and in each JSON map. */
  factions?: FactionDescriptor[];
  /**
   * Image assets keyed by assetId (matching TerrainDescriptor.texture.assetId).
   * Only needed for descriptors with texture.type === 'image'.
   */
  textureAssets?: Map<string, Blob>;
  /**
   * GLB model assets keyed by assetId (matching ScatterVariantDescriptor.assetId).
   */
  modelAssets?: Map<string, Blob>;
  maps?: ExportMapEntry[];
}

/**
 * Packages descriptors, assets, and optional maps into a .hexpack zip blob.
 * Save it with a filename like `my-world.hexpack`.
 */
export async function exportHexPack(opts: ExportHexPackOptions): Promise<Blob> {
  const zipFiles: Record<string, Uint8Array> = {};
  const assetPaths: Record<string, string>   = {};

  // Texture assets
  if (opts.textureAssets) {
    for (const [assetId, blob] of opts.textureAssets) {
      const ext  = blob.type.includes('png') ? 'png' : 'jpg';
      const path = `textures/${sanitizeName(assetId)}.${ext}`;
      zipFiles[path] = new Uint8Array(await blob.arrayBuffer());
      assetPaths[assetId] = path;
    }
  }

  // Model assets
  if (opts.modelAssets) {
    for (const [assetId, blob] of opts.modelAssets) {
      const path = `models/${sanitizeName(assetId)}.glb`;
      zipFiles[path] = new Uint8Array(await blob.arrayBuffer());
      assetPaths[assetId] = path;
    }
  }

  // Maps
  const mapEntries: HexPackMapEntry[] = [];
  for (const { id, name, map, metadata, format: formatOpt } of (opts.maps ?? [])) {
    // Metadata only survives in the JSON format — default to it when present.
    const format = formatOpt ?? (metadata ? 'json' : 'binary');
    let data: Uint8Array;
    let path: string;
    if (format === 'json') {
      const json = serializeMapJSON(map, metadata ?? {}, {
        scatterDescriptors:  opts.scatterDescriptors,
        terrainDescriptors:  opts.terrainDescriptors,
        liquidDescriptors:   opts.liquidDescriptors,
        resourceDescriptors: opts.resourceDescriptors,
        factions:            opts.factions,
      });
      data = new TextEncoder().encode(json);
      path = `maps/${sanitizeName(id)}.json`;
    } else {
      data = serializeMap(map);
      path = `maps/${sanitizeName(id)}.hxmp`;
    }
    zipFiles[path] = data;
    mapEntries.push({ id, name, path, format });
  }

  // Manifest
  const manifest: HexPackManifest = {
    version: PACK_VERSION,
    ...(opts.name                      ? { name:               opts.name               } : {}),
    terrainDescriptors: opts.terrainDescriptors,
    ...(opts.liquidDescriptors?.length ? { liquidDescriptors:  opts.liquidDescriptors  } : {}),
    ...(opts.scatterDescriptors?.length? { scatterDescriptors: opts.scatterDescriptors } : {}),
    ...(opts.resourceDescriptors?.length?{ resourceDescriptors: opts.resourceDescriptors } : {}),
    ...(opts.factions?.length          ? { factions:           opts.factions            } : {}),
    ...(Object.keys(assetPaths).length ? { assets:             assetPaths              } : {}),
    ...(mapEntries.length              ? { maps:               mapEntries              } : {}),
  };
  zipFiles['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

  return new Blob([toArrayBuffer(await zipAsync(zipFiles))], { type: 'application/zip' });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function unzipAsync(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(data, (err, result) => { if (err) reject(err); else resolve(result); });
  });
}

function zipAsync(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, (err, result) => { if (err) reject(err); else resolve(result); });
  });
}

function extractFirstMesh(scene: THREE.Group): ScatterAsset | null {
  let result: ScatterAsset | null = null;
  scene.traverse(obj => {
    if (result) return;
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      result = {
        geometry: mesh.geometry,
        material: Array.isArray(mesh.material) ? mesh.material[0] : mesh.material,
      };
    }
  });
  return result;
}

function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '-');
}

/** Converts a fflate Uint8Array (ArrayBufferLike) to a Blob-compatible ArrayBuffer. */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}
