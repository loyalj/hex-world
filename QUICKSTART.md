# hex-world — Quick Start

A Three.js hex grid library for strategy and exploration games. Handles map data, chunk-based rendering, terrain, water, roads, scatter features, and map generation. Your game owns the UI, game logic, and unit definitions.

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

---

## Reading map data

```ts
// Coordinate helpers
import { HexCoord, hexDistance, hexNeighbors, hexRange } from 'hex-world';

const coord = HexCoord.fromOffset(col, row);
const neighbors = hexNeighbors(coord);
const dist = hexDistance(a, b);
const ring = hexRange(center, 3);   // all cells within distance 3

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
- **Unit definitions** — stats, movement rules, combat
- **Game rules** — win conditions, resource costs
- **Pathfinding cost functions** — the library will provide A* and flood-fill algorithms; your game supplies the cost callback that knows what terrain costs mean for your units

---

## What's coming to the library

- `findPath(from, to, costFn)` — A* with game-supplied cost function
- `getMovementRange(center, budget, costFn)` — flood-fill reachable cells
- Fog of war — per-cell visibility state + LOS calculation
- Unit position / visibility hooks
