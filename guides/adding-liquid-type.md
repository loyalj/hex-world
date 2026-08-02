# Adding a Liquid Type

The liquid system is modular — each liquid type (water, lava, acid, or your own) owns its terrain cell index, its surface/shore/estuary/river materials, and optional geometry overrides. Multiple liquid types can coexist on the same map with correct foam boundaries between them.

---

## Overview

Three things define a liquid type:

1. **`TerrainDescriptor`** — registers the terrain index (stored in cell data) and links it to a liquid type ID via `liquidType`.
2. **`LiquidTypeDescriptor`** — declares the liquid type ID and optional per-type geometry tuning.
3. **`LiquidMaterialSet`** — the four Three.js materials that render the liquid (surface, shore, estuary, river).

---

## 1. Pick a terrain index and liquid ID

Choose a unique terrain index not already in use (the built-ins occupy 0–5), and pick a stable string ID that will appear in save files.

```ts
const MY_LIQUID_INDEX = 6;   // stored in cell data
const MY_LIQUID_ID    = 'mercury';
```

---

## 2. Write the `TerrainDescriptor`

Add your terrain to your descriptor array. Set `liquidType` to your chosen ID — this is what tells the renderer to build liquid geometry for cells of this type.

```ts
import type { TerrainDescriptor } from '@loyalj/hex-world';
import { DEFAULT_TERRAIN_DESCRIPTORS } from '@loyalj/hex-world';

const MY_TERRAIN_DESCRIPTORS: TerrainDescriptor[] = [
  ...DEFAULT_TERRAIN_DESCRIPTORS,   // keeps built-in types 0–5
  {
    index:      6,
    id:         'mercury',
    name:       'Mercury',
    color:      0xaabbc0,           // used for vertex blending and fallback
    liquidType: 'mercury',          // links to LiquidTypeDescriptor.id
    texture:    { type: 'procedural' },
  },
];
```

`liquidType` replaces the legacy `isWater: true` flag. You can have multiple terrain indices share the same liquid ID (e.g., shallow and deep variants of the same liquid).

---

## 3. Write the `LiquidTypeDescriptor`

This is a small serializable record that names the liquid type and optionally overrides geometry parameters:

```ts
import type { LiquidTypeDescriptor } from '@loyalj/hex-world';
import { DEFAULT_LIQUID_DESCRIPTORS } from '@loyalj/hex-world';

const MY_LIQUID_DESCRIPTORS: LiquidTypeDescriptor[] = [
  ...DEFAULT_LIQUID_DESCRIPTORS,   // water, lava, acid
  {
    id:   'mercury',
    name: 'Mercury',
    // Optional geometry overrides — omit to inherit global defaults
    noiseScale:      0.8,    // surface noise frequency (lower = larger ripples)
    perturbStrength: 0.05,   // shore foam jitter amount
    surfaceLift:     0.02,   // how far above the cell floor the surface sits
    // Optional appearance — this is what makes a liquid NOT look like tinted water
    opacity:          0.98,  // thick liquids want ~1.0
    flowSpeed:        0.35,  // slow, viscous animation
    emissiveColor:    0xbfd4dd,
    emissiveStrength: 0.1,   // subtle sheen; lava uses ~0.4
    waveScale:        0.5,   // broader, slower-looking swells
    foamIntensity:    0.4,   // subdued shore foam
  },
];
```

| Field | Default | Effect |
|---|---|---|
| `id` | — | Stable key, matches `TerrainDescriptor.liquidType` |
| `name` | — | Display label |
| `noiseScale` | global | Surface ripple frequency |
| `perturbStrength` | global | Shore foam edge jitter |
| `surfaceLift` | global | Surface Y offset above cell floor |
| `opacity` | 0.82 (river 0.78) | Surface alpha — lava wants ~1.0 |
| `flowSpeed` | 1 | Animation time multiplier for waves/foam/river flow |
| `emissiveColor` | — | Self-illumination color (only partially dimmed by fog) |
| `emissiveStrength` | 0 | Emissive intensity; the built-in lava uses 0.6 |
| `waveScale` | 1 | Surface-noise frequency multiplier |
| `foamIntensity` | 1 | Shore/estuary foam multiplier; 0 disables foam |

All appearance fields are JSON-safe and travel with map saves and hexpacks, so a
liquid's look is part of its definition, not the renderer's configuration.

---

## 4. Create the materials

Call `resolveLiquidMaterials(descriptor)` — it reads the color fields from your descriptor and builds all four materials in one call:

```ts
import { resolveLiquidMaterials } from '@loyalj/hex-world';

const mercuryMaterials = resolveLiquidMaterials(MY_LIQUID_DESCRIPTORS.find(d => d.id === 'mercury')!);
```

Or build a complete map for all types at once:

```ts
const liquidMaterials = new Map(MY_LIQUID_DESCRIPTORS.map(d => [d.id, resolveLiquidMaterials(d)]));
```

If you need full control over the Three.js material (custom shaders, extra uniforms, etc.), you can still construct a `LiquidMaterialSet` manually using the individual factory functions:

```ts
import { createWaterMaterial, createWaterShoreMaterial,
         createEstuaryMaterial, createRiverMaterial } from '@loyalj/hex-world';
import * as THREE from 'three';

const mercuryMaterials = {
  surface: createWaterMaterial({ shallow: new THREE.Color(0xaabbc0), deep: new THREE.Color(0x6b8088) }),
  shore:   createWaterShoreMaterial({ shallow: new THREE.Color(0x99adb5), foam: new THREE.Color(0xd9e8ec) }),
  estuary: createEstuaryMaterial({ shallow: new THREE.Color(0x99adb5), foam: new THREE.Color(0xd9e8ec) }),
  river:   createRiverMaterial({ shallow: new THREE.Color(0xb8ccd0), deep: new THREE.Color(0x7294a0) }),
};
```

### `LiquidColorOptions` fields (for manual construction)

| Field | Used by | Default |
|---|---|---|
| `shallow` | surface, shore, estuary, river | blue-green water |
| `deep` | surface, river | dark blue |
| `foam` | shore, estuary | near-white |

---

## 5. Pass everything to `ChunkManager`

```ts
import { ChunkManager, resolveTerrainDefinitions, buildTerrainTextureArray } from '@loyalj/hex-world';

const terrainTex  = await buildTerrainTextureArray(MY_TERRAIN_DESCRIPTORS);
const definitions = resolveTerrainDefinitions(MY_TERRAIN_DESCRIPTORS);

const liquidMaterials = new Map([
  ['water',   { surface: createWaterMaterial(), shore: createWaterShoreMaterial(),
                estuary: createEstuaryMaterial(), river: createRiverMaterial() }],
  ['mercury', mercuryMaterials],
]);

const chunks = new ChunkManager({
  map, layout, scene,
  material:           createTerrainMaterial(terrainTex),
  liquidMaterials,                          // ← one entry per liquid type to render
  liquidDescriptors:  MY_LIQUID_DESCRIPTORS,
  roadMaterial:       createRoadMaterial(),
  terrainDefinitions: definitions,
});
```

Every key in `liquidMaterials` must have a matching entry in `liquidDescriptors`. Liquid types that have a descriptor but no material entry are silently skipped (no geometry built).

---

## 6. Place cells in your generator

Set the terrain index and elevation just like any other terrain. The cell must have a negative elevation to act as a liquid body — the water surface is computed from neighboring cells.

```ts
// Lake floor at elevation-1 so computeWaterSurfaces lifts the surface to elevation 0
map.setTerrain(col, row, MY_LIQUID_INDEX);
map.setElevation(col, row, -1);   // one below desired surface level
```

After placing all cells, call `computeWaterSurfaces` with a predicate covering all your liquid indices so BFS flood-fill correctly identifies enclosed pools:

```ts
const allLiquidIndices = new Set([
  5,                  // built-in water
  6,                  // mercury
]);

map.computeWaterSurfaces(t => allLiquidIndices.has(t));
```

If you skip the predicate, only the default water terrain (index 5) is recognised.

---

## 7. Trace rivers (optional)

Rivers are traced cell-by-cell using `setRiverOutgoing` / `setRiverIncoming`. The renderer classifies each river chain by following it downstream to the terminal liquid pool, so a river trace that ends at mercury cells will be rendered with the mercury river material.

Pass all liquid indices to your tracer so rivers stop at any liquid type:

```ts
const liquidTerrains = new Set([5, 6]);   // water + mercury

function traceRiver(map, startCol, startRow) {
  let c = startCol, r = startRow;
  for (let step = 0; step < 200; step++) {
    if (liquidTerrains.has(map.getTerrain(c, r))) break;
    if (map.getElevation(c, r) < 0) break;

    // … find lowest neighbor, set outgoing/incoming, advance …
  }
}
```

See [custom-map-generator.md](custom-map-generator.md) for the `generateClimateRivers` raw pass, which accepts a `waterTerrainIndex` option (pass an array for multiple liquid types).

---

## 8. Save and load

### Binary format

`serializeMap` stores only cell data — descriptors are not embedded. On load, pass an `isWater` predicate so `computeWaterSurfaces` runs correctly:

```ts
import { serializeMap, deserializeMap } from '@loyalj/hex-world';

// Save
const bytes = serializeMap(map);

// Load
const liquidIndices = new Set(MY_TERRAIN_DESCRIPTORS
  .filter(d => d.liquidType != null || d.isWater)
  .map(d => d.index));

const loadedMap = deserializeMap(bytes, t => liquidIndices.has(t));
```

### JSON format

`serializeMapJSON` embeds the descriptor arrays, and `deserializeMapJSON` reconstructs the `isWater` predicate automatically:

```ts
import { serializeMapJSON, deserializeMapJSON } from '@loyalj/hex-world';

// Save — pass all three descriptor arrays
const json = serializeMapJSON(map, metadata, scatterDescriptors, MY_TERRAIN_DESCRIPTORS, MY_LIQUID_DESCRIPTORS);

// Load — isWater predicate is rebuilt from the embedded terrainDescriptors
const { map: loaded, terrainDescriptors, liquidDescriptors } = deserializeMapJSON(json);

const definitions = resolveTerrainDefinitions(terrainDescriptors);
const terrainTex  = await buildTerrainTextureArray(terrainDescriptors, registry);

const chunks = new ChunkManager({ ..., terrainDefinitions: definitions,
  liquidDescriptors, liquidMaterials: rebuildLiquidMaterials(liquidDescriptors) });
```

---

## Liquid–liquid boundaries

Where two different liquid types are adjacent, the higher-priority type renders a compact foam ring within its own hex and the lower-priority type renders nothing at that edge. Priority is determined by terrain index — **lower index = higher priority**.

```
water (index 5)  |  mercury (index 6)
                 ^
         water renders shore here; mercury does not
```

To flip priority, swap the terrain indices in your descriptor array.

---

## Quick reference

| Task | API |
|---|---|
| Declare terrain index | `TerrainDescriptor` with `liquidType: 'your-id'` |
| Declare liquid type | `LiquidTypeDescriptor` with matching `id` and color fields |
| Build all four materials from descriptor | `resolveLiquidMaterials(descriptor)` |
| Build materials manually | `createWaterMaterial`, `createWaterShoreMaterial`, `createEstuaryMaterial`, `createRiverMaterial` — all accept `LiquidColorOptions` |
| Register with renderer | `ChunkManager({ liquidMaterials, liquidDescriptors })` |
| Place cells | `map.setTerrain(col, row, index)` · `map.setElevation(col, row, -1)` |
| Compute surfaces | `map.computeWaterSurfaces(t => myLiquidSet.has(t))` |
| Save (binary) | `deserializeMap(bytes, isWaterPredicate)` |
| Save (JSON) | `serializeMapJSON` / `deserializeMapJSON` (auto-reconstructs predicate) |

---

Once your liquid descriptors are ready, bundle them alongside terrain, scatter, and maps into a portable file using [HexPack](hex-pack.md).
