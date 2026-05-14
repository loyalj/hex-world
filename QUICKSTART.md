# hex-world — Quick Start

A Three.js hex grid library for strategy and exploration games. Handles map data, chunk-based rendering, terrain, water, roads, scatter features, fog of war, units, and map generation. Your game owns the UI, game logic, and unit models.

---

## Installation

```bash
# During development, link the local package:
npm link ../hex-world

# Later, when published:
npm install hex-world
```

Three.js is a peer dependency — your project brings it:

```bash
npm install three @types/three
```

---

## Minimal setup

```ts
import * as THREE from 'three';
import {
  HexMap, ChunkManager, createLayout, POINTY_TOP,
  FbmPlugin,
  createWaterMaterial, createWaterShoreMaterial,
  createEstuaryMaterial, createRiverMaterial, createRoadMaterial,
  buildTerrainTextureArray, createTerrainMaterial,
} from 'hex-world';

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
const terrainTex = await buildTerrainTextureArray();
const terrainMaterial = createTerrainMaterial(terrainTex);

// 5. ChunkManager — owns all Three.js meshes, handles chunk streaming
const chunks = new ChunkManager({
  map, layout, scene,
  material:         terrainMaterial,
  waterMaterial:    createWaterMaterial(),
  shoreMaterial:    createWaterShoreMaterial(),
  estuaryMaterial:  createEstuaryMaterial(),
  riverMaterial:    createRiverMaterial(),
  roadMaterial:     createRoadMaterial(),
  chunkSize:        32,
  loadRadius:       5,
});

// 6. Render loop
function animate() {
  requestAnimationFrame(animate);
  chunks.update(camera);     // streams chunks in/out based on camera position
  renderer.render(scene, camera);
}
animate();
```

---

## Terrain types

The six built-in types are numeric constants:

```ts
import { TerrainType } from 'hex-world';

// TerrainType.Water | Grassland | Desert | Mud | Rock | Snow
map.setTerrain(col, row, TerrainType.Grassland);
map.setElevation(col, row, 3);   // Int8, -128–127; negative = underwater
```

Stored as `Uint8` (0–255). The built-in materials and generators use values 0–5. Values 6–255 are available for custom terrain. Provide a custom `TerrainMaterial` shader that knows how to render your values.

---

## Generators

### Built-in plugins

```ts
import { FbmPlugin, ChunkPlugin } from 'hex-world';

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
import type { MapGeneratorPlugin, HexMap, TerrainType } from 'hex-world';

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

Scatter layers place instanced meshes (trees, rocks, buildings) using cell feature levels (0–3).

```ts
import { HexHashGrid, ChunkManager } from 'hex-world';
import type { ScatterLayerConfig } from 'hex-world';

const hashGrid = new HexHashGrid(seed);

const treeMat = new THREE.MeshLambertMaterial({ color: 0x4a7c2a });
const pineLayer: ScatterLayerConfig = [
  // tier 0 (density 3): large trees
  [{ geometry: new THREE.ConeGeometry(0.42, 2.0, 7), material: treeMat, yOffset: 1.0 }],
  // tier 1 (density 2): medium trees
  [{ geometry: new THREE.ConeGeometry(0.33, 1.5, 7), material: treeMat, yOffset: 0.75 }],
  // tier 2 (density 1): small trees
  [{ geometry: new THREE.ConeGeometry(0.24, 1.0, 7), material: treeMat, yOffset: 0.5 }],
];

const chunks = new ChunkManager({
  // ...other options...
  hashGrid,
  scatterLayers: [pineLayer],   // add as many layers as you need
});

// Set per-cell density in map data (0 = none, 3 = dense)
map.setFeatureLevel(col, row, 0, 3);   // layer 0, density tier 3
```

Each scatter layer is fully game-defined — geometry, material, density curve. The library handles placement, instancing, and chunk streaming.

---

## Cell picking

### Mesh raycasting (recommended)

Cast against the actual terrain geometry — accurate at any camera angle and elevation. Pass `chunkManager.terrainMeshes` to get the currently loaded chunk meshes.

```ts
import { pickHexFromMeshes } from 'hex-world';

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
import { pickHex } from 'hex-world';

const cell = pickHex(e.clientX, e.clientY, renderer.domElement, camera, layout, map, 0);
```

---

## RTS camera

```ts
import { RtsCameraController } from 'hex-world';

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
import { serializeMap, deserializeMap, serializeMapJSON, deserializeMapJSON } from 'hex-world';

// Binary — compact, fast. Use for file saves, IndexedDB, network transfer.
const bytes    = serializeMap(map);              // Uint8Array (~60 KB for a 100×100 map)
const restored = deserializeMap(bytes);          // returns HexMap

// Persist to a file (browser)
const blob = new Blob([bytes], { type: 'application/octet-stream' });
const url  = URL.createObjectURL(blob);
// attach url to an <a download="map.hxmp"> and click it

// Load from a file (browser)
const file = await fileInput.files[0].arrayBuffer();
const map  = deserializeMap(new Uint8Array(file));

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

---

## Pathfinding and movement range

The library provides the algorithms. Your game supplies a `MoveCostFn` that closes over your map and any unit-specific rules.

```ts
import {
  findPath, getMovementRange, getVisibleCells,
  offsetToHex, hexToOffset,
  type MoveCostFn,
} from 'hex-world';

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

// Flood-fill — all cells reachable within a movement budget
const reachable = getMovementRange(
  offsetToHex(unitCol, unitRow),
  3,      // budget (in cost units)
  cost,
  map,
);

// BFS visibility radius — all cells within N steps (no cost function)
const visible = getVisibleCells(offsetToHex(col, row), 3, map);
```

Costs must be non-negative. Return `Infinity` to mark a transition as impassable.

---

## Fog of war

```ts
import { FogData } from 'hex-world';

// Create fog state and pass it to ChunkManager
const fog = new FogData(map.width, map.height);
const chunks = new ChunkManager({ ..., fogData: fog });

// Reveal cells — typically called when a unit moves
import { getVisibleCells, hexToOffset, offsetToHex } from 'hex-world';

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

The fog texture stores two independent values per cell: **R** = currently visible (0 or 255) and **G** = ever explored (0 or 255, never decreases). Both are driven by integer reference counts — multiple overlapping visibility grants are handled automatically.

If you use `UnitManager` with `fogRevealRange > 0`, it manages all `increaseVisibility`/`decreaseVisibility` calls for you automatically.

---

## Units

The library handles position, path-following, facing, and fog reveal. You supply the `Object3D` (loaded GLTF, instanced mesh, or any Three.js object) and wire your animation system to the provided callbacks.

```ts
import { HexUnit, UnitManager } from 'hex-world';

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
import { hexDistance, hexNeighbors, hexRange, offsetToHex, hexToOffset } from 'hex-world';

const hex       = offsetToHex(col, row);
const neighbors = hexNeighbors(hex);
const dist      = hexDistance(a, b);
const ring      = hexRange(center, 3);   // all cells within distance 3

// Cell data
const terrain   = map.getTerrain(col, row);     // TerrainType (number)
const elevation = map.getElevation(col, row);   // Int8
const hasRiver  = map.hasRiver(col, row);
const hasRoad   = map.hasRoads(col, row);
```

---

## What the library does NOT own

Keep these in your game, not in hex-world:

- **UI** — menus, HUDs, tooltips, cell inspector panels
- **Turn structure** — action points, whose turn it is
- **Unit definitions** — stats, combat, abilities
- **Unit models** — geometry, materials, animations (pass your `Object3D` to `UnitManager`)
- **Game rules** — win conditions, resource costs
- **Pathfinding cost functions** — the library provides A* and flood-fill; your game supplies the cost callback

---

## What's coming to the library

- Line-of-sight blocking (elevation-aware raycasting)
- Exploration reveal animation (smooth fade-in on first sight)
- Wall geometry between designated cells
