# HexPack — Asset and Map Packages

A `.hexpack` file bundles everything that defines a world — terrain types, liquid types, scatter types, image textures, scatter 3D models, and saved maps — into one portable zip archive. It is the primary handoff format between an editor and a game.

Without hexpack, getting your custom types from editor to game means shipping descriptor arrays as source code, managing individual image URLs, loading GLTF files separately, and constructing all Three.js registries by hand. With hexpack, the editor calls `exportHexPack(...)` and the game calls `loadHexPack(url)`.

---

## What lives in a hexpack

```
my-world.hexpack  (zip archive)
├── manifest.json          ← all descriptors + file index
├── textures/
│   └── volcano.jpg        ← one file per image-textured terrain type
├── models/
│   └── pine-tree.glb      ← one GLB per scatter asset
└── maps/
    └── main-world.hxmp    ← binary HexMap, or .json for readable packs
```

Everything is optional except `manifest.json`. A pack with only procedural terrain and no maps is just the manifest file.

---

## `manifest.json` reference

| Field | Type | Description |
|---|---|---|
| `version` | `number` | Pack format version (currently 1) |
| `name` | `string` | Display name for the pack |
| `terrainDescriptors` | `TerrainDescriptor[]` | Required. All terrain types, including built-ins if used |
| `liquidDescriptors` | `LiquidTypeDescriptor[]` | All liquid types. Omit to use the library defaults (water, lava, acid) |
| `scatterDescriptors` | `ScatterDescriptor[]` | All scatter layers. Omit if no scatter |
| `assets` | `Record<string, string>` | Maps each `assetId` to its path inside the zip |
| `maps` | `HexPackMapEntry[]` | Embedded maps |

Each `HexPackMapEntry`:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Stable key — used to retrieve the map from `HexPackage.maps` |
| `name` | `string` | Display name |
| `path` | `string` | Path to the map file inside the zip |
| `format` | `'binary' \| 'json'` | Binary `.hxmp` is compact; JSON is human-readable |

---

## Full workflow

### 1 — Editor exports

The editor collects all descriptors and asset blobs into one call:

```ts
import { exportHexPack } from '@loyalj/hex-world';

const blob = await exportHexPack({
  name: 'Volcano Island',

  // Descriptor arrays — define all your types here
  terrainDescriptors: MY_TERRAIN_DESCRIPTORS,
  liquidDescriptors:  MY_LIQUID_DESCRIPTORS,
  scatterDescriptors: MY_SCATTER_DESCRIPTORS,

  // Image files — only needed for terrain types with texture.type === 'image'
  // Key = TerrainDescriptor.texture.assetId
  textureAssets: new Map([
    ['terrain/volcano', volcanoJpgBlob],
  ]),

  // 3D model files — one GLB per scatter asset ID
  // Key = ScatterVariantDescriptor.assetId
  modelAssets: new Map([
    ['scatter/pine-tree', pineTreeGlbBlob],
    ['scatter/rock',      rockGlbBlob],
  ]),

  // Maps to embed
  maps: [
    {
      id:       'main-world',
      name:     'Main World',
      map,
      metadata: { seed, generatorId: 'chunk' },
    },
  ],
});

// Trigger browser download
const a = document.createElement('a');
a.href = URL.createObjectURL(blob);
a.download = 'volcano-island.hexpack';
a.click();
URL.revokeObjectURL(a.href);
```

### 2 — Game loads

```ts
import { loadHexPack, createRoadMaterial, createLayout, POINTY_TOP } from '@loyalj/hex-world';
import { ChunkManager } from '@loyalj/hex-world';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as THREE from 'three';

const pack = await loadHexPack('/assets/volcano-island.hexpack', {
  gltfLoader: new GLTFLoader(),
});

const scene    = new THREE.Scene();
const camera   = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 200);
const renderer = new THREE.WebGLRenderer({ antialias: true });
document.body.appendChild(renderer.domElement);

const chunks = new ChunkManager({
  map:                pack.maps.get('main-world')!,
  layout:             createLayout(POINTY_TOP, 1),
  scene,
  material:           pack.terrainMaterial,
  terrainDefinitions: pack.terrainDefinitions,
  liquidMaterials:    pack.liquidMaterials,
  liquidDescriptors:  pack.liquidDescriptors,
  scatterDefinitions: pack.scatterDefinitions,
  roadMaterial:       createRoadMaterial(),
});

(function animate(now = 0) {
  requestAnimationFrame(animate);
  chunks.update(camera, now / 1000);
  renderer.render(scene, camera);
})();
```

---

## `loadHexPack` options

```ts
const pack = await loadHexPack(source, options);
```

`source` accepts: `string` (URL), `File`, `Blob`, or `Uint8Array`.

| Option | Type | Description |
|---|---|---|
| `gltfLoader` | `GltfLoaderLike` | A `GLTFLoader` instance for loading scatter models. If omitted, `scatterDefinitions` will be empty. |
| `mapIds` | `string[]` | Load only these map IDs. Default: load all maps. |
| `terrainMaterialOptions` | `TerrainMaterialOptions` | Lighting and texture scale forwarded to `createTerrainMaterial`. |

`GltfLoaderLike` is satisfied by any object with `loadAsync(url: string): Promise<{ scene: THREE.Group }>`, so the standard `three/addons` `GLTFLoader` works directly.

### `HexPackage` fields

| Field | Type | Notes |
|---|---|---|
| `terrainDescriptors` | `TerrainDescriptor[]` | Raw descriptors, useful for re-exporting |
| `terrainDefinitions` | `TerrainDefinition[]` | Resolved — pass to `ChunkManager.terrainDefinitions` |
| `terrainTexture` | `DataArrayTexture` | Built atlas — use `createTerrainMaterial(pack.terrainTexture, myOpts)` for custom lighting |
| `terrainMaterial` | `ShaderMaterial` | Ready-to-use material with `terrainMaterialOptions` applied |
| `liquidDescriptors` | `LiquidTypeDescriptor[]` | Pass to `ChunkManager.liquidDescriptors` |
| `liquidMaterials` | `Map<string, LiquidMaterialSet>` | Pass to `ChunkManager.liquidMaterials` |
| `scatterDescriptors` | `ScatterDescriptor[]` | Raw descriptors |
| `scatterDefinitions` | `ScatterDefinition[]` | Resolved — pass to `ChunkManager.scatterDefinitions`. Empty if no `gltfLoader`. |
| `maps` | `Map<string, HexMap>` | Loaded maps keyed by `HexPackMapEntry.id` |

---

## `exportHexPack` options

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Display name stored in manifest |
| `terrainDescriptors` | `TerrainDescriptor[]` | Required |
| `liquidDescriptors` | `LiquidTypeDescriptor[]` | Optional — omit to use library defaults on load |
| `scatterDescriptors` | `ScatterDescriptor[]` | Optional |
| `textureAssets` | `Map<string, Blob>` | Image blobs keyed by `assetId`. Only needed for `texture.type: 'image'` terrain types. |
| `modelAssets` | `Map<string, Blob>` | GLB blobs keyed by `assetId`. One per unique scatter variant asset. |
| `maps` | `ExportMapEntry[]` | Maps to embed |

Each `ExportMapEntry`:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Stable ID — used to retrieve the map after loading |
| `name` | `string` | Display name |
| `map` | `HexMap` | The map to embed |
| `metadata` | `MapMetadata` | Seed, generator ID, display name — stored alongside the map |
| `format` | `'binary' \| 'json'` | Default: `'binary'`. Use `'json'` for diffable/readable packs. |

---

## Common patterns

### Procedural-texture-only pack

All terrain uses `texture.type: 'procedural'` — no image files needed. Omit `textureAssets`:

```ts
const blob = await exportHexPack({
  terrainDescriptors: MY_TERRAIN_DESCRIPTORS,  // all procedural
  maps: [{ id: 'world', map }],
});
// Result is just manifest.json + map file — very small
```

### Custom terrain lighting

Pass `terrainMaterialOptions` to apply scene-specific lighting to the pre-built material:

```ts
const pack = await loadHexPack(url, {
  terrainMaterialOptions: {
    lightDir:   new THREE.Vector3(100, 120, 80),
    lightColor: new THREE.Color(0xfff4d0).multiplyScalar(0.7),
    ambient:    new THREE.Color(0xd0e0ff).multiplyScalar(0.45),
  },
});
// pack.terrainMaterial now uses those values
```

Or use `pack.terrainTexture` directly to create your own material at any point:

```ts
const myMaterial = createTerrainMaterial(pack.terrainTexture, { texScale: 0.3 });
```

### Campaign pack with multiple maps

```ts
const blob = await exportHexPack({
  terrainDescriptors,
  maps: [
    { id: 'chapter-1', name: 'The Crossing',   map: chapter1Map, metadata: { generatorId: 'hand-crafted' } },
    { id: 'chapter-2', name: 'The Highlands',  map: chapter2Map, metadata: { generatorId: 'hand-crafted' } },
    { id: 'chapter-3', name: 'The Final Gate', map: chapter3Map, metadata: { generatorId: 'hand-crafted' } },
  ],
});

// Game loads only the current chapter
const pack = await loadHexPack(url, { mapIds: ['chapter-2'] });
const map  = pack.maps.get('chapter-2')!;
```

### Loading from a `<input type="file">` picker

```ts
document.getElementById('open-pack')!.addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const pack = await loadHexPack(file);
  // ... rebuild ChunkManager with pack data
});
```

---

## Related guides

- [Adding a Terrain Type](adding-terrain-type.md) — defining `TerrainDescriptor` arrays
- [Adding a Liquid Type](adding-liquid-type.md) — defining `LiquidTypeDescriptor` arrays
- [Adding a Scatter Type](adding-scatter-type.md) — defining `ScatterDescriptor` arrays and registries

---

## Quick reference

| Task | API |
|---|---|
| Export a pack | `await exportHexPack(opts)` → `Blob` |
| Load from URL | `await loadHexPack('/path/to/world.hexpack')` |
| Load from file picker | `await loadHexPack(file)` |
| Custom scene lighting | `opts.terrainMaterialOptions` |
| Load scatter models | `opts.gltfLoader: new GLTFLoader()` |
| Select maps to load | `opts.mapIds: ['id1', 'id2']` |
| Multiple maps in one pack | `exportHexPack({ maps: [...] })` |
| Binary vs JSON map | `format: 'binary'` (default) or `'json'` |
| Rebuild terrain material | `createTerrainMaterial(pack.terrainTexture, myOpts)` |
