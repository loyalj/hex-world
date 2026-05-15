# Adding a Terrain Type

Terrain is stored per-cell as a `Uint8` index (0–255). The library ships with six built-in types (indices 0–5). You can define your own complete set — or extend the defaults — by providing a `TerrainDescriptor` array at startup. The descriptors drive the texture atlas, vertex color blending, road colors, and which cells receive water geometry.

---

## 1. Plan your terrain indices

Each terrain type has a numeric index that is stored directly in cell data. Pick your indices up front and treat them as stable constants — changing them requires migrating existing save files.

```ts
// Define as constants so they're easy to reference throughout your game
const MY_TERRAIN = {
  GRASSLAND: 0,
  DESERT:    1,
  TUNDRA:    2,
  VOLCANO:   3,
  OCEAN:     4,
} as const;
```

Indices 0–5 match the library defaults (`TerrainType.Grassland` through `TerrainType.Water`). If you're keeping the defaults, start your custom types at index 6.

---

## 2. Write `TerrainDescriptor` entries

```ts
import type { TerrainDescriptor } from 'hex-world';

const MY_TERRAIN_DESCRIPTORS: TerrainDescriptor[] = [
  // Procedural noise texture — generated from `color`
  {
    index: 0,
    id:    'grassland',
    name:  'Grassland',
    color: 0x86b888,              // hex color, used for vertex blending and noise tinting
    texture: { type: 'procedural' },
  },

  // Procedural with custom grain — higher noiseFrequency = finer texture
  {
    index: 1,
    id:    'desert',
    name:  'Desert',
    color: 0xc8bea0,
    texture: { type: 'procedural', noiseFrequency: 256 },
  },

  // Custom road color — linear RGB 0–1; derived from `color` if omitted
  {
    index:     2,
    id:        'tundra',
    name:      'Tundra',
    color:     0xb8ccd5,
    roadColor: [0.36, 0.41, 0.52],
    texture:   { type: 'procedural' },
  },

  // Image texture — supply a registered asset ID
  {
    index: 3,
    id:    'volcano',
    name:  'Volcano',
    color: 0x5a3a2a,              // fallback color if image fails to load
    texture: { type: 'image', assetId: 'terrain/volcano' },
  },

  // Water — receives water surface, shore foam, and river geometry
  {
    index:   4,
    id:      'ocean',
    name:    'Ocean',
    color:   0x4a8fb5,
    isWater: true,
    texture: { type: 'procedural' },
  },
];
```

### `TerrainDescriptor` fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `index` | `number` (0–255) | yes | Stored in cell data; must be unique per map |
| `id` | `string` | yes | Stable key used in save files |
| `name` | `string` | yes | Display label for editors and HUDs |
| `color` | `number` | yes | Hex color for vertex blending and procedural noise |
| `roadColor` | `[r, g, b]` | no | Linear 0–1 RGB; derived from `color` if omitted |
| `isWater` | `boolean` | no | If true, receives water surface, shore, and estuary geometry |
| `texture.type` | `'procedural' \| 'image'` | yes | How the texture atlas slice is built |
| `texture.assetId` | `string` | image only | Key looked up in the `TerrainAssetRegistry` |
| `texture.noiseFrequency` | `number` | no | Noise grain scale (higher = finer detail) |

Indices do not need to be contiguous. The atlas is sized to `max(index) + 1`, so a gap at index 3 in a 0–4 set produces a transparent slice at 3.

---

## 3. Register image sources (if using image textures)

For any descriptor with `texture.type: 'image'`, map the `assetId` to a URL or preloaded image before building the texture atlas:

```ts
import type { TerrainAssetRegistry } from 'hex-world';

const registry: TerrainAssetRegistry = new Map([
  ['terrain/volcano', '/assets/textures/volcano.jpg'],
  // or pass an HTMLImageElement or ImageBitmap directly:
  // ['terrain/volcano', myImageBitmap],
]);
```

---

## 4. Build the texture atlas and resolve definitions

```ts
import {
  buildTerrainTextureArray, createTerrainMaterial,
  resolveTerrainDefinitions,
} from 'hex-world';

// Builds a DataArrayTexture — one slice per terrain index.
// Pass registry even if empty; it's only consulted for 'image' descriptors.
const terrainTex = await buildTerrainTextureArray(MY_TERRAIN_DESCRIPTORS, registry);
const terrainMaterial = createTerrainMaterial(terrainTex);

// Converts descriptors to runtime TerrainDefinition objects (resolves THREE.Color, etc.)
const definitions = resolveTerrainDefinitions(MY_TERRAIN_DESCRIPTORS);
```

---

## 5. Pass definitions to `ChunkManager`

```ts
import { ChunkManager } from 'hex-world';

const chunks = new ChunkManager({
  map, layout, scene,
  material:           terrainMaterial,
  waterMaterial:      createWaterMaterial(),
  shoreMaterial:      createWaterShoreMaterial(),
  estuaryMaterial:    createEstuaryMaterial(),
  riverMaterial:      createRiverMaterial(),
  roadMaterial:       createRoadMaterial(),
  terrainDefinitions: definitions,   // ← your custom set
});
```

The chunk manager uses `terrainDefinitions` to resolve vertex colors and road colors during chunk geometry builds, and derives which terrain indices count as water to control water mesh generation.

---

## 6. Tell generators which index is water

Built-in generators need to know your water terrain index so they know where to stop tracing rivers, where to set lake terrain, and what to avoid when placing roads:

```ts
import { BiomeAssigner, generateClimateRivers, generateRoads } from 'hex-world';

const WATER_IDX = MY_TERRAIN.OCEAN;

BiomeAssigner.assign(map, climate, { waterTerrainIndex: WATER_IDX });

generateClimateRivers(map, { waterTerrainIndex: WATER_IDX });

generateRoads(map, {
  seed,
  waterTerrainIndex: WATER_IDX,
  // Pass an array if you have multiple water types:
  // waterTerrainIndex: [MY_TERRAIN.OCEAN, MY_TERRAIN.LAKE],
});
```

---

## 7. Set and read terrain on cells

```ts
// Write
map.setTerrain(col, row, MY_TERRAIN.GRASSLAND);
map.setTerrain(col, row, MY_TERRAIN.OCEAN);

// Read
const terrainIndex = map.getTerrain(col, row);   // returns the uint8 index

// Elevation — negative means underwater
map.setElevation(col, row, 3);    // above sea level
map.setElevation(col, row, -1);   // submerged
```

Chunks are rebuilt when marked dirty via `ChunkManager`. If you change terrain at runtime, call `chunks.markDirty(col, row)` to trigger a rebuild of the affected chunk.

---

## 8. Extending the built-in defaults

If you want to keep the six default types and add more on top:

```ts
import { DEFAULT_TERRAIN_DESCRIPTORS } from 'hex-world';

const MY_TERRAIN_DESCRIPTORS: TerrainDescriptor[] = [
  ...DEFAULT_TERRAIN_DESCRIPTORS,
  {
    index: 6,
    id:    'scorched',
    name:  'Scorched Earth',
    color: 0x3a2a1a,
    texture: { type: 'procedural', noiseFrequency: 64 },
  },
];
```

Indices 0–5 continue to work exactly as before; the atlas gains a 7th slice at index 6.

---

## 9. Save and load descriptors with the map

`TerrainDescriptor` is JSON-safe and can travel in the map's JSON envelope so the loading side doesn't need to hard-code the same definitions:

```ts
import { serializeMapJSON, deserializeMapJSON, resolveTerrainDefinitions } from 'hex-world';

// Save
const json = serializeMapJSON(map, metadata, scatterDescriptors, MY_TERRAIN_DESCRIPTORS);

// Load
const { map: loaded, terrainDescriptors } = deserializeMapJSON(json);
const definitions = resolveTerrainDefinitions(terrainDescriptors);
const terrainTex  = await buildTerrainTextureArray(terrainDescriptors, registry);
const chunks = new ChunkManager({ ..., terrainDefinitions: definitions });
```

The binary format (`serializeMap` / `deserializeMap`) stores only cell data; descriptors are a JSON-only feature.

---

## Quick reference

| Task | API |
|---|---|
| Describe a type | `TerrainDescriptor` in your descriptor array |
| Register image sources | `TerrainAssetRegistry` map of assetId → URL/image |
| Build texture atlas | `await buildTerrainTextureArray(descriptors, registry)` |
| Resolve runtime definitions | `resolveTerrainDefinitions(descriptors)` |
| Register with renderer | `ChunkManager({ terrainDefinitions: definitions })` |
| Set cell terrain | `map.setTerrain(col, row, index)` |
| Water index for generators | `BiomeAssigner`, `generateClimateRivers`, `generateRoads` — all accept `waterTerrainIndex` |
| Embed in save file | `serializeMapJSON(map, meta, scatterDesc, terrainDesc)` |
| Restore on load | `deserializeMapJSON(json).terrainDescriptors` → `resolveTerrainDefinitions` |
