# @loyalj/hex-world — Quick Start

A Three.js hex grid library for strategy and exploration games. Handles map data, chunk-based rendering, terrain, water, roads, scatter features, fog of war, units, and map generation. Your game owns the UI, game logic, and unit models.

---

## Installation

```bash
# During development, link the local package:
npm link ../hex-world

# Later, when published:
npm install @loyalj/hex-world
```

Three.js is a peer dependency — your project brings it:

```bash
npm install three @types/three
```

---

## Minimal setup

`HexWorld` is the batteries-included entry point: renderer, RTS camera,
lighting, terrain + liquid materials, chunk streaming, per-frame hover picking,
and a cell overlay layer, all wired with sensible defaults:

```ts
import { HexWorld, FbmPlugin } from '@loyalj/hex-world';

const world = await HexWorld.create({ container: document.body });
FbmPlugin.generate(world.map, FbmPlugin.defaultConfig, Date.now());
```

Everything stays reachable — `world.scene`, `world.camera`, `world.renderer`,
`world.chunks`, `world.controls`, `world.map`, `world.overlays`,
`world.picker` — so you can drop to the à-la-carte API below at any point.
Common hooks:

```ts
// Per-frame logic (hover cell is already picked for you)
world.onFrame = dt => {
  if (world.hoveredCell) world.overlays.set('hover', [world.hoveredCell]);
};

// Options: custom terrain, scatter, fog, camera limits, chunk sizing…
const world = await HexWorld.create({
  container,
  map: myMap,                          // or width/height for a blank map
  terrainDescriptors: MY_TERRAIN_DESCRIPTORS,
  scatterDefinitions: [pineDefinition],
  camera: { initialDistance: 60, maxDistance: 120 },
});

// Runtime swaps
world.setMap(otherMap);                          // chunks rebuild, camera recenters
await world.setTerrainDescriptors(descriptors);  // new terrain set / textures
world.dispose();                                 // tear everything down
```

### À-la-carte setup

The same wiring by hand, when you want full control over each piece:

```ts
import * as THREE from 'three';
import {
  HexMap, ChunkManager, createLayout, POINTY_TOP,
  FbmPlugin,
  createWaterMaterial, createWaterShoreMaterial,
  createEstuaryMaterial, createRiverMaterial, createRoadMaterial,
  buildTerrainTextureArray, createTerrainMaterial,
  DEFAULT_TERRAIN_DESCRIPTORS, DEFAULT_TERRAIN_DEFINITIONS,
  DEFAULT_LIQUID_DESCRIPTORS,
} from '@loyalj/hex-world';

// 1. Map data
const map = new HexMap({ width: 100, height: 100, featureLayerCount: 1 });
FbmPlugin.generate(map, FbmPlugin.defaultConfig, Date.now());

// 2. Layout — POINTY_TOP or FLAT_TOP, size in world units
const layout = createLayout(POINTY_TOP, 1);

// 3. Three.js scene
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 200);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

// 4. Terrain material (splat = texture blend, flat = vertex colour, debug = terrain IDs)
const terrainTex = await buildTerrainTextureArray(DEFAULT_TERRAIN_DESCRIPTORS);
const terrainMaterial = createTerrainMaterial(terrainTex);

// 5. Liquid materials — one set of four materials per liquid type
const liquidMaterials = new Map([
  ['water', {
    surface: createWaterMaterial(),
    shore:   createWaterShoreMaterial(),
    estuary: createEstuaryMaterial(),
    river:   createRiverMaterial(),
  }],
]);

// 6. ChunkManager — owns all Three.js meshes, handles chunk streaming
const chunks = new ChunkManager({
  map, layout, scene,
  material:           terrainMaterial,
  liquidMaterials,
  liquidDescriptors:  DEFAULT_LIQUID_DESCRIPTORS,
  roadMaterial:       createRoadMaterial(),
  terrainDefinitions: DEFAULT_TERRAIN_DEFINITIONS,
  chunkSize:          32,
  loadRadius:         5,
});

// 7. Render loop
function animate() {
  requestAnimationFrame(animate);
  chunks.update(camera);     // streams chunks in/out based on camera position
  renderer.render(scene, camera);
}
animate();
```

---

## Terrain types

Terrain is stored per-cell as a `Uint8` index (0–255). The library ships with six built-in types (`TerrainType.Grassland = 0` through `TerrainType.Water = 5`). Games that need custom terrain — different biomes, color palettes, or image textures — define their own `TerrainDescriptor` array and pass it to the library at startup.

### Using the defaults

```ts
import {
  TerrainType,
  DEFAULT_TERRAIN_DESCRIPTORS, DEFAULT_TERRAIN_DEFINITIONS,
  buildTerrainTextureArray, createTerrainMaterial, ChunkManager,
} from '@loyalj/hex-world';

const terrainTex = await buildTerrainTextureArray(DEFAULT_TERRAIN_DESCRIPTORS);
const terrainMaterial = createTerrainMaterial(terrainTex);

const chunks = new ChunkManager({
  // ...
  terrainDefinitions: DEFAULT_TERRAIN_DEFINITIONS,
});

map.setTerrain(col, row, TerrainType.Grassland);   // index 0
map.setTerrain(col, row, TerrainType.Water);        // index 5
map.setElevation(col, row, 3);                      // Int8, -128–127; negative = underwater
```

### Custom terrain types

Define your own descriptor array and pass it through the library at startup:

```ts
import type { TerrainDescriptor } from '@loyalj/hex-world';
import {
  resolveTerrainDefinitions, buildTerrainTextureArray, createTerrainMaterial,
  ChunkManager,
} from '@loyalj/hex-world';
import type { TerrainAssetRegistry } from '@loyalj/hex-world';

const MY_TERRAIN_DESCRIPTORS: TerrainDescriptor[] = [
  // Procedural noise textures — generated from `color`
  { index: 0, id: 'tundra', name: 'Tundra', color: 0xb8ccd5,
    texture: { type: 'procedural' } },
  { index: 1, id: 'steppe', name: 'Steppe', color: 0xc9b87a,
    texture: { type: 'procedural', noiseFrequency: 128 } },

  // Image texture — register the asset ID before building the atlas
  { index: 2, id: 'volcano', name: 'Volcano', color: 0x5a3a2a,
    texture: { type: 'image', assetId: 'terrain/volcano' } },

  // Water — receives shore, estuary, and river geometry
  { index: 3, id: 'lava', name: 'Lava', color: 0xdd4422,
    isWater: true,
    texture: { type: 'procedural' } },
];

// Map stable asset IDs to image URLs or preloaded bitmaps
const registry: TerrainAssetRegistry = new Map([
  ['terrain/volcano', '/assets/textures/volcano.jpg'],
]);

const terrainTex      = await buildTerrainTextureArray(MY_TERRAIN_DESCRIPTORS, registry);
const terrainMaterial = createTerrainMaterial(terrainTex);

const definitions = resolveTerrainDefinitions(MY_TERRAIN_DESCRIPTORS);

const chunks = new ChunkManager({
  // ...
  terrainDefinitions: definitions,
});
```

**`TerrainDescriptor` fields**

| Field | Type | Required | Notes |
|---|---|---|---|
| `index` | `number` (0–255) | yes | Stored in cell data; must be unique per map |
| `id` | `string` | yes | Stable key used in save files |
| `name` | `string` | yes | Display label for editors and HUDs |
| `color` | `number` | yes | Hex color for vertex blending and procedural noise |
| `roadColor` | `[r, g, b]` | no | Linear 0–1 RGB; derived from `color` if omitted |
| `isWater` | `boolean` | no | Receives water surface, shore, and estuary geometry |
| `texture.type` | `'procedural' \| 'image'` | yes | How the texture atlas slice is built |
| `texture.assetId` | `string` | image only | Key looked up in the `TerrainAssetRegistry` |
| `texture.noiseFrequency` | `number` | no | Noise grain scale (higher = finer detail) |

Indices do not need to be contiguous. The texture atlas is sized to `max(index) + 1` slices, so gaps produce transparent slices that will never be visible on valid cells.

### Custom water terrain in generators

When passing custom terrain indices to built-in generators, set `waterTerrainIndex` so they know which type counts as water:

```ts
import { generateClimateRivers, generateRoads, BiomeAssigner } from '@loyalj/hex-world';

const WATER_IDX = 3;   // matches the 'lava' descriptor above

BiomeAssigner.assign(map, climateData, { waterTerrainIndex: WATER_IDX });

generateClimateRivers(map, { waterTerrainIndex: WATER_IDX });

generateRoads(map, {
  seed,
  waterTerrainIndex: WATER_IDX,   // also accepts number[] for multiple water types
});
```

---

## Generators

### Built-in plugins

```ts
import { FbmPlugin, ChunkPlugin } from '@loyalj/hex-world';

map.clear();
FbmPlugin.generate(map, FbmPlugin.defaultConfig, seed);
// or
ChunkPlugin.generate(map, ChunkPlugin.defaultConfig, seed);
```

`FbmPlugin` — fast fractal noise terrain, good for quick iteration.  
`ChunkPlugin` — full pipeline: BFS land shaping → erosion → climate simulation → biome assignment → rivers + roads. Slower but richer.

### Custom generator

Implement `MapGeneratorPlugin<TConfig>` to plug your generator into any seed/regen system:

```ts
import type { MapGeneratorPlugin, HexMap } from '@loyalj/hex-world';
import { TerrainType } from '@loyalj/hex-world';

interface MyConfig {
  islandRadius: number;
}

export const IslandPlugin: MapGeneratorPlugin<MyConfig> = {
  id: 'island',
  name: 'Island',
  defaultConfig: { islandRadius: 20 },

  generate(map: HexMap, config: MyConfig, seed: number): void {
    const cx = map.width / 2, cz = map.height / 2;
    map.forEach((col, row) => {
      const d = Math.hypot(col - cx, row - cz);
      map.setTerrain(col, row, d < config.islandRadius ? TerrainType.Grassland : TerrainType.Water);
      map.setElevation(col, row, d < config.islandRadius ? 2 : -1);
    });
  },
};
```

The library also exports the raw generator functions (`generateFbmTerrain`, `generateClimateRivers`, `generateRoads`, `ClimateSimulator`, `BiomeAssigner`, etc.) if you want to compose individual passes rather than use the full plugin.

---

## Scatter features

Scatter layers place instanced meshes (trees, rocks, buildings) using cell feature levels (0–3). Each definition owns a named `layerIndex` slot in `featureData`, so saves are stable regardless of registration order.

```ts
import { HexHashGrid, ChunkManager } from '@loyalj/hex-world';
import type { ScatterDefinition } from '@loyalj/hex-world';
import { TerrainType } from '@loyalj/hex-world';

// Map must have featureLayerCount >= the highest layerIndex + 1
const map = new HexMap({ width: 100, height: 100, featureLayerCount: 1 });
const hashGrid = new HexHashGrid(seed);

const treeMat = new THREE.MeshLambertMaterial({ color: 0x4a7c2a });
const pineDefinition: ScatterDefinition = {
  id:         'pine-tree',
  name:       'Pine Tree',
  layerIndex: 0,           // reads feature layer 0 for density
  tiers: [
    // tier 0 (density 3): large trees
    [{ geometry: new THREE.ConeGeometry(0.42, 2.0, 7), material: treeMat, yOffset: 1.0 }],
    // tier 1 (density 2): medium trees
    [{ geometry: new THREE.ConeGeometry(0.33, 1.5, 7), material: treeMat, yOffset: 0.75 }],
    // tier 2 (density 1): small trees
    [{ geometry: new THREE.ConeGeometry(0.24, 1.0, 7), material: treeMat, yOffset: 0.5 }],
  ],
  allowedTerrains: [TerrainType.Grassland, TerrainType.Mud],  // terrain indices; optional whitelist
  tiltStrength:    0,      // optional random X/Z lean in radians; 0 = upright
};

const chunks = new ChunkManager({
  // ...other options...
  hashGrid,
  scatterDefinitions: [pineDefinition],   // add as many definitions as you need
});

// Set per-cell density in map data (0 = none, 3 = dense)
map.setFeatureLevel(col, row, 0, 3);   // layer 0, density tier 3
```

Each scatter definition is fully game-defined — geometry, material, terrain filter, density curve. The library handles placement, instancing, and chunk streaming. Pass any `THREE.Material` subclass including custom `onBeforeCompile` materials.

---

## Cell picking

### Mesh raycasting (recommended)

Cast against the actual terrain geometry — accurate at any camera angle and elevation. Pass `chunkManager.terrainMeshes` to get the currently loaded chunk meshes.

```ts
import { pickHexFromMeshes } from '@loyalj/hex-world';

renderer.domElement.addEventListener('pointermove', e => {
  const cell = pickHexFromMeshes(
    e.clientX, e.clientY, renderer.domElement,
    camera, layout, map,
    chunkManager.terrainMeshes,
  );
  if (cell) {
    console.log(cell.col, cell.row);
    console.log(map.getTerrain(cell.col, cell.row));
  }
});
```

Call it inside the render loop (not just on `pointermove`) so the hovered cell updates correctly when the camera pans or zooms under a stationary mouse.

### Plane raycasting (lightweight alternative)

Intersects a flat horizontal plane at a given Y. Faster, but drifts at low camera angles over elevated terrain. Useful for water surfaces or flat maps.

```ts
import { pickHex } from '@loyalj/hex-world';

const cell = pickHex(e.clientX, e.clientY, renderer.domElement, camera, layout, map, 0);
```

---

## RTS camera

```ts
import { RtsCameraController } from '@loyalj/hex-world';

const controls = new RtsCameraController({
  camera,
  domElement: renderer.domElement,
  initialTarget:   { x: map.width / 2, z: map.height / 2 },
  initialDistance: 60,
  minDistance: 6,  maxDistance: 120,
  minPitch: 20,    maxPitch: 75,
});

// In render loop:
controls.update();
```

Right-drag pans, scroll zooms toward cursor, middle-drag tilts. All configurable.

### Focusing the camera

```ts
// Instant reposition — use at startup so the first frame renders on terrain,
// not empty sky. Sets both current and goal position (no animation).
controls.snapTo(x, z);

// Smooth pan — sets the goal position and lets the damping lerp do the rest.
// Call each frame to track a moving target.
controls.panTo(x, z);
```

---

## Save and load

```ts
import { serializeMap, deserializeMap, serializeMapJSON, deserializeMapJSON } from '@loyalj/hex-world';

// Binary — compact, fast. Use for file saves, IndexedDB, network transfer.
const bytes    = serializeMap(map);              // Uint8Array (~60 KB for a 100×100 map)
const restored = deserializeMap(bytes);          // returns HexMap (built-in water only)

// If your map uses custom liquid types (lava, acid, …) pass an isWater predicate
// so their water surfaces are recomputed correctly after load:
const liquidTerrains = new Set([5, 6, 7]); // indices of all liquid terrain types
const restored = deserializeMap(bytes, t => liquidTerrains.has(t));

// Persist to a file (browser)
const blob = new Blob([bytes], { type: 'application/octet-stream' });
const url  = URL.createObjectURL(blob);
// attach url to an <a download="map.hxmp"> and click it

// Load from a file (browser)
const file = await fileInput.files[0].arrayBuffer();
const map  = deserializeMap(new Uint8Array(file), t => liquidTerrains.has(t));

// JSON with metadata — suitable for localStorage, editor clipboard, or debug export.
const json = serializeMapJSON(map, {
  name:        'My World',
  seed:        12345,
  generatorId: 'chunk',
});
const { map: loaded, metadata } = deserializeMapJSON(json);
console.log(metadata.name, metadata.seed, metadata.generatorId);
```

All map data is preserved: terrain, elevation, flags, rivers, roads, and scatter feature layers.

### Saving custom terrain and scatter descriptors

Pass your descriptor arrays as optional arguments to `serializeMapJSON`. The consumer can reconstruct the same definitions on load:

```ts
import {
  serializeMapJSON, deserializeMapJSON,
  resolveTerrainDefinitions,
} from '@loyalj/hex-world';

const json = serializeMapJSON(map, metadata, scatterDescriptors, MY_TERRAIN_DESCRIPTORS);

// On load:
const { map, metadata, scatterDescriptors, terrainDescriptors } = deserializeMapJSON(json);
const definitions = resolveTerrainDefinitions(terrainDescriptors);
```

---

## Pathfinding and movement range

The library provides the algorithms. Your game supplies a `MoveCostFn` that closes over your map and any unit-specific rules.

```ts
import {
  findPath, computeFlowField, getMovementRange, getVisibleCells, hasLineOfSight,
  smoothPath,
  offsetToHex, hexToOffset,
  type MoveCostFn,
} from '@loyalj/hex-world';

// Define movement costs for your game
const cost: MoveCostFn = (from, to) => {
  const { col, row } = hexToOffset(to);
  if (map.getTerrain(col, row) === TerrainType.Water) return Infinity; // impassable
  if (map.getElevation(col, row) > 4)                return 3;        // steep
  return 1;                                                            // normal
};

// A* — returns [start, ..., goal] or null if no path exists
const path = findPath(
  offsetToHex(startCol, startRow),
  offsetToHex(goalCol,  goalRow),
  cost,
  map,
);

// Flow field — one Dijkstra sweep from the destination serves every unit.
// Cheaper than one A* per unit as soon as several head to the same place.
const field = computeFlowField(offsetToHex(goalCol, goalRow), cost, map);
for (const unit of army) {
  const route = field.path(offsetToHex(unit.col, unit.row));  // same shape as findPath
  if (route && route.length > 1) unit.travel(route);
}

// Flood-fill — all cells reachable within a movement budget
const reachable = getMovementRange(
  offsetToHex(unitCol, unitRow),
  3,      // budget (in cost units)
  cost,
  map,
);

// BFS visibility radius — all cells within N steps (no cost function)
const visible = getVisibleCells(offsetToHex(col, row), 3, map);

// Line-of-sight — true if no terrain blocks the straight line between two cells.
// eyeHeight (default 1.5 world units) is added to both endpoints before checking.
const canSee = hasLineOfSight(offsetToHex(unitCol, unitRow), offsetToHex(targetCol, targetRow), map);
const canSeeCustom = hasLineOfSight(from, to, map, 2.0);  // taller observer

// Path smoothing — Catmull-Rom spline through cell centres, sampled densely.
// Returns { x, y, z }[] world-space points. Use for a curved path preview line.
const pts = smoothPath(path, layout, map);          // default 8 samples per segment
const fine = smoothPath(path, layout, map, 16);     // smoother curve

// Feed into a THREE.Line:
const positions = new Float32Array(pts.length * 3);
pts.forEach((p, i) => {
  positions[i * 3]     = p.x;
  positions[i * 3 + 1] = p.y + 0.15;   // float above terrain
  positions[i * 3 + 2] = p.z;
});
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffaa22, depthTest: false }));
scene.add(line);
```

Costs must be non-negative. Return `Infinity` to mark a transition as impassable.

---

## Fog of war

```ts
import { FogData } from '@loyalj/hex-world';

// Create fog state and pass it to ChunkManager
const fog = new FogData(map.width, map.height);
const chunks = new ChunkManager({ ..., fogData: fog });

// Reveal cells — typically called when a unit moves
import { getVisibleCells, hexToOffset, offsetToHex } from '@loyalj/hex-world';

function revealAround(col: number, row: number, range: number): void {
  const cells = getVisibleCells(offsetToHex(col, row), range, map);
  for (const c of cells) {
    const oc = hexToOffset(c);
    if (map.inBounds(oc.col, oc.row)) fog.increaseVisibility(oc.col, oc.row);
  }
}

// When a unit leaves a position, decrease visibility there
function hideAround(col: number, row: number, range: number): void {
  const cells = getVisibleCells(offsetToHex(col, row), range, map);
  for (const c of cells) {
    const oc = hexToOffset(c);
    if (map.inBounds(oc.col, oc.row)) fog.decreaseVisibility(oc.col, oc.row);
  }
}

// Toggle visibility behaviour at runtime
chunks.setHideUnexplored(true);  // hide cells that have never been seen
chunks.setDimExplored(true);     // dim cells seen but not currently visible

// Reset all fog state (e.g. new game)
fog.reset();
```

The fog texture stores three values per cell: **R** = currently visible (0 or 255), **G** = ever explored (0 or 255, never decreases), **B** = reveal animation progress (0→255 over `revealDuration` seconds on first exploration). R and G are driven by integer reference counts — multiple overlapping visibility grants are handled automatically.

Pass an optional third argument to control the fade-in speed:

```ts
const fog = new FogData(map.width, map.height, 0.8);  // 0.8 s reveal (default 0.5)
```

Call `chunks.update(camera, dt)` (with elapsed seconds) each frame so the animation advances. Pass `0` or omit `dt` if you don't need the reveal animation.

If you use `UnitManager` with `fogRevealRange > 0`, it manages all `increaseVisibility`/`decreaseVisibility` calls for you automatically.

---

## Units

The library handles position, path-following, facing, and fog reveal. You supply the `Object3D` (loaded GLTF, instanced mesh, or any Three.js object) and wire your animation system to the provided callbacks.

```ts
import { HexUnit, UnitManager } from '@loyalj/hex-world';

// Create unit state
const unit = new HexUnit({
  col:            10,
  row:            10,
  travelSpeed:    4,    // cells per second
  heightOffset:   0.5,  // Y above terrain; set to half model height for centre-pivot models
  fogRevealRange: 3,    // BFS radius revealed as the unit moves; 0 = no fog reveal
});

// Wire your animation system to the callbacks
unit.onMoveStart = () => mixer.clipAction(walkClip).play();
unit.onMoveEnd   = () => mixer.clipAction(idleClip).play();
unit.onCellEnter = (col, row) => console.log('entered', col, row);

// Create manager and register the unit with its Object3D
const manager = new UnitManager({ scene, map, layout, fogData });
manager.addUnit(unit, gltf.scene);   // or any THREE.Object3D

// Move along an A* path
const path = findPath(offsetToHex(unit.col, unit.row), offsetToHex(goalCol, goalRow), cost, map);
if (path) unit.travel(path);

// Stop immediately (cancels movement)
unit.stop();

// In your render loop (dt = elapsed seconds):
chunks.update(camera, dt);   // dt drives fog reveal animation
manager.update(dt);
```

`UnitManager` updates `object3D.position` and `object3D.rotation.y` each frame. When `fogRevealRange > 0`, it also calls `fog.increaseVisibility` / `fog.decreaseVisibility` automatically as the unit moves between cells.

After a `fogData.reset()` call, re-apply all unit fog contributions:

```ts
fog.reset();
manager.reapplyFog();
```

---

## Reading map data

```ts
// Coordinate helpers
import { hexDistance, hexNeighbors, hexRange, offsetToHex, hexToOffset } from '@loyalj/hex-world';

const hex       = offsetToHex(col, row);
const neighbors = hexNeighbors(hex);
const dist      = hexDistance(a, b);
const ring      = hexRange(center, 3);   // all cells within distance 3

// Cell data
const terrain   = map.getTerrain(col, row);     // terrain index (number)
const elevation = map.getElevation(col, row);   // Int8
const hasRiver  = map.hasRiver(col, row);
const hasRoad   = map.hasRoads(col, row);
```

---

## What the library does NOT own

Keep these in your game, not in @loyalj/hex-world:

- **UI** — menus, HUDs, tooltips, cell inspector panels
- **Turn structure** — action points, whose turn it is
- **Unit definitions** — stats, combat, abilities
- **Unit models** — geometry, materials, animations (pass your `Object3D` to `UnitManager`)
- **Game rules** — win conditions, resource costs
- **Pathfinding cost functions** — the library provides A* and flood-fill; your game supplies the cost callback

---

## What's coming to the library

- LOD system for distant chunk geometry
- Worker-thread chunk mesh generation
