# Adding a Scatter Type

Scatter types place instanced meshes — trees, rocks, buildings, debris — on hex cells based on a per-cell density level. Each type owns one **feature layer** slot in the map's cell data, which stores how densely that feature should appear on every cell (0 = none, 1–3 = sparse to dense).

---

## 1. Allocate feature layers on the map

Every scatter type needs its own layer slot. Set `featureLayerCount` when you create the `HexMap` to be at least as large as the highest `layerIndex + 1` across all your definitions:

```ts
const map = new HexMap({
  width: 100,
  height: 100,
  featureLayerCount: 2,   // supports layer indices 0 and 1
});
```

This is stored in the binary and JSON save formats, so the count must match between map creation and save/load.

---

## 2. Write a `ScatterDefinition`

`ScatterDefinition` is the runtime object that `ChunkManager` consumes. You build it directly when your geometry is procedural or preloaded.

```ts
import type { ScatterDefinition } from '@loyalj/hex-world';
import * as THREE from 'three';

const treeMat = new THREE.MeshLambertMaterial({ color: 0x4a7c2a });

const pineDefinition: ScatterDefinition = {
  id:         'pine-tree',          // stable string key
  name:       'Pine Tree',          // display label
  layerIndex: 0,                    // reads map.getFeatureLevel(col, row, 0)

  // tiers[tierIdx][variantIdx]
  // tierIdx 0 = dense (feature level 3), 1 = medium (level 2), 2 = sparse (level 1)
  // Multiple variants within a tier are chosen randomly per slot.
  tiers: [
    [{ geometry: new THREE.ConeGeometry(0.42, 2.0, 7), material: treeMat, yOffset: 1.0 }],
    [{ geometry: new THREE.ConeGeometry(0.33, 1.5, 7), material: treeMat, yOffset: 0.75 }],
    [{ geometry: new THREE.ConeGeometry(0.24, 1.0, 7), material: treeMat, yOffset: 0.5 }],
  ],

  // Optional: restrict placement to specific terrain indices.
  // Uses the same numeric indices as map.setTerrain / map.getTerrain.
  allowedTerrains: [0, 3],   // e.g. Grassland (0) and Mud (3)

  // Optional: custom per-cell predicate, evaluated after allowedTerrains.
  // Returning false prevents any scatter on that cell for this definition.
  canSpawnAt: (map, col, row) => map.getElevation(col, row) < 5,

  // Optional: random lean in radians on X and Z axes. 0 = always upright.
  tiltStrength: 0.15,
};
```

### `tiers` in detail

| Index | When it spawns | Visual intent |
|---|---|---|
| `tiers[0]` | Feature level 3 (dense) | Large / dominant variant |
| `tiers[1]` | Feature levels 2–3 | Medium variant |
| `tiers[2]` | Feature levels 1–3 | Small / background variant |

A slot at feature level 2 can produce a tier-1 or tier-2 mesh, but never tier-0. The `FEATURE_THRESHOLDS` table controls the exact probability of each.

Each tier is an array of variants — at level 3 you might have three different pine meshes to break up repetition:

```ts
tiers: [
  [
    { geometry: largePineGeo, material: treeMat, yOffset: 1.0 },
    { geometry: deadTreeGeo,  material: deadMat, yOffset: 0.9 },
  ],
  [{ geometry: mediumPineGeo, material: treeMat, yOffset: 0.7 }],
  [{ geometry: smallPineGeo,  material: treeMat, yOffset: 0.4 }],
],
```

---

## 3. Set up `HexHashGrid`

The scatter system needs a seeded hash grid for deterministic placement. One grid per map is enough for all definitions:

```ts
import { HexHashGrid } from '@loyalj/hex-world';

const hashGrid = new HexHashGrid(seed);   // same seed = same placement
```

---

## 4. Pass definitions to `ChunkManager`

```ts
import { ChunkManager } from '@loyalj/hex-world';

const chunks = new ChunkManager({
  map, layout, scene,
  // ...materials...
  hashGrid,
  scatterDefinitions: [pineDefinition, rockDefinition],
});
```

Definitions compete for each slot: the definition with the lowest spawn hash wins. Multiple definitions can share the same feature layer if you want them to compete for the same density budget, or use separate layers if they should be independent.

---

## 5. Set density levels on cells

```ts
// Density 0 = no scatter; 1 = sparse; 2 = medium; 3 = dense
map.setFeatureLevel(col, row, layerIndex, density);

// Read it back
const level = map.getFeatureLevel(col, row, layerIndex);
```

Chunk geometry is rebuilt whenever `ChunkManager` marks the containing chunk dirty.

---

## 6. Multiple competing definitions

When two definitions are both eligible for a cell, scatter holds a competition: the definition with the lowest spawn hash for that slot wins, and only one mesh is placed. This keeps placement from doubling up on busy terrain:

```ts
const rockDefinition: ScatterDefinition = {
  id:         'rock',
  layerIndex: 1,       // independent layer — rocks don't compete with trees
  tiers: [
    [{ geometry: largeRockGeo, material: rockMat, yOffset: 0.3 }],
    [{ geometry: smallRockGeo, material: rockMat, yOffset: 0.15 }],
    [{ geometry: pebbleGeo,    material: rockMat, yOffset: 0.05 }],
  ],
  allowedTerrains: [4],   // Rock terrain only
};
```

To make two definitions genuinely compete for one slot, give them the **same `layerIndex`** and overlapping `allowedTerrains`.

---

## 7. Save/load compatible path

`ScatterDefinition` holds live Three.js objects so it can't be serialised directly. For save/load-compatible scatter, split the definition into a `ScatterDescriptor` (serialisable) and a `ScatterAssetRegistry` (runtime-only):

```ts
import type { ScatterDescriptor, ScatterAssetRegistry } from '@loyalj/hex-world';
import { resolveScatterDefinition } from '@loyalj/hex-world';

// Declare once at module level — stable across sessions
const PINE_DESCRIPTOR: ScatterDescriptor = {
  id:         'pine-tree',
  name:       'Pine Tree',
  layerIndex: 0,
  tiers: [
    [{ assetId: 'tree/pine-large',  yOffset: 1.0 }],
    [{ assetId: 'tree/pine-medium', yOffset: 0.75 }],
    [{ assetId: 'tree/pine-small',  yOffset: 0.5 }],
  ],
  allowedTerrains: [0, 3],
};

// Build at startup after your geometry is ready
const registry: ScatterAssetRegistry = new Map([
  ['tree/pine-large',  { geometry: largePineGeo,  material: treeMat }],
  ['tree/pine-medium', { geometry: mediumPineGeo, material: treeMat }],
  ['tree/pine-small',  { geometry: smallPineGeo,  material: treeMat }],
]);

const pineDefinition = resolveScatterDefinition(PINE_DESCRIPTOR, registry);
// throws if any assetId is missing — fail-fast at startup, not at render time
```

### Embedding in the map JSON

```ts
import { serializeMapJSON, deserializeMapJSON } from '@loyalj/hex-world';

// Save — descriptors travel with the map
const json = serializeMapJSON(map, metadata, [PINE_DESCRIPTOR]);

// Load — reconstruct definitions from the embedded descriptors
const { map: loaded, scatterDescriptors } = deserializeMapJSON(json);
const definitions = scatterDescriptors.map(d => resolveScatterDefinition(d, registry));

const chunks = new ChunkManager({ ..., hashGrid, scatterDefinitions: definitions });
```

The binary format (`serializeMap` / `deserializeMap`) stores only cell data; descriptors are a JSON-only feature.

---

## Quick reference

| Task | API |
|---|---|
| Allocate layers | `new HexMap({ featureLayerCount: N })` |
| Set density | `map.setFeatureLevel(col, row, layerIndex, 0–3)` |
| Inline definition | `ScatterDefinition` with `tiers: FeatureCollection[][]` |
| Save-compatible definition | `ScatterDescriptor` + `ScatterAssetRegistry` → `resolveScatterDefinition` |
| Register with renderer | `ChunkManager({ scatterDefinitions: [...] })` |
| Embed in save file | `serializeMapJSON(map, meta, descriptors)` |
| Restore on load | `deserializeMapJSON(json).scatterDescriptors` → `resolveScatterDefinition` |
