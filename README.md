# hex-world

A Three.js library for building hex-grid strategy and exploration games. Handles the hard rendering and simulation work so your game can focus on rules and content.

---

## What it does

- **Chunk-based rendering** — large maps streamed in and out as the camera moves, one draw call per chunk
- **Terrain system** — six built-in types with vertex color blending and texture splatting; fully extensible with custom types, procedural noise, or image textures
- **Liquid types** — modular system supporting multiple liquid types on one map (water, lava, acid, or custom); each type has its own surface, shore, estuary, and river materials; correct foam boundaries where liquid types meet; rivers classified by which pool they drain into
- **Roads** — geometry strips rendered above terrain
- **Scatter features** — instanced meshes (trees, rocks, buildings) placed deterministically from per-cell density levels; modular definitions with terrain filters and density tiers
- **Fog of war** — reference-counted per-cell visibility with smooth reveal animation; integrated with units
- **Procedural generation** — full climate-driven pipeline (BFS landmass → erosion → moisture simulation → temperature model → biome assignment → rivers → roads), plus a fast FBM alternative; composable raw passes for custom generators
- **Pathfinding** — A\*, flood-fill movement range, BFS visibility radius, elevation-aware line of sight, Catmull-Rom path smoothing
- **Units** — position, smooth path-following, facing, fog reveal; wire your own `Object3D` and animation callbacks
- **RTS camera** — pan, zoom, tilt with smooth damping
- **Save/load** — binary and JSON formats; scatter, terrain, and liquid descriptors travel with the map; water surfaces recomputed correctly for all liquid types on load
- **Asset packages** — `.hexpack` zip bundles terrain, liquid, scatter, image textures, 3D models, and maps into one file; `loadHexPack` resolves everything to render-ready objects in one call

Your game owns the UI, unit models, game rules, and render loop. The library owns the hex geometry, shaders, and algorithms.

---

## Installation

```bash
npm install @loyalj/hex-world
```

Three.js is a peer dependency — bring your own:

```bash
npm install three @types/three
```

---

## Quick start

```ts
import * as THREE from 'three';
import {
  HexMap, ChunkManager, createLayout, POINTY_TOP, FbmPlugin,
  buildTerrainTextureArray, createTerrainMaterial, createRoadMaterial,
  DEFAULT_TERRAIN_DESCRIPTORS, DEFAULT_TERRAIN_DEFINITIONS,
  DEFAULT_LIQUID_DESCRIPTORS, resolveLiquidMaterials,
} from '@loyalj/hex-world';

// Map data + generation
const map = new HexMap({ width: 100, height: 100, featureLayerCount: 1 });
FbmPlugin.generate(map, FbmPlugin.defaultConfig, Date.now());

// Three.js scene
const scene    = new THREE.Scene();
const camera   = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 200);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

// Terrain material
const terrainTex = await buildTerrainTextureArray(DEFAULT_TERRAIN_DESCRIPTORS);
const material   = createTerrainMaterial(terrainTex);

// Liquid materials — built from descriptors; add custom liquid types here
const liquidMaterials = new Map(DEFAULT_LIQUID_DESCRIPTORS.map(d => [d.id, resolveLiquidMaterials(d)]));

// Chunk manager — owns all meshes, handles streaming
const chunks = new ChunkManager({
  map, layout: createLayout(POINTY_TOP, 1), scene, material,
  liquidMaterials,
  liquidDescriptors:  DEFAULT_LIQUID_DESCRIPTORS,
  roadMaterial:       createRoadMaterial(),
  terrainDefinitions: DEFAULT_TERRAIN_DEFINITIONS,
});

// Render loop
let last = performance.now();
(function animate(now: number) {
  requestAnimationFrame(animate);
  const dt = (now - last) / 1000; last = now;
  chunks.update(camera, dt);
  renderer.render(scene, camera);
})(last);
```

---

## Documentation

| Guide | Description |
|---|---|
| [Quick Start](guides/QUICKSTART.md) | Full setup walkthrough — terrain, water, scatter, fog, units, save/load |
| [Adding a Terrain Type](guides/adding-terrain-type.md) | Custom terrain indices, procedural and image textures, water flags |
| [Adding a Liquid Type](guides/adding-liquid-type.md) | Custom liquid types with their own surface/shore/estuary/river materials and save/load |
| [Adding a Scatter Type](guides/adding-scatter-type.md) | Instanced feature meshes — tiers, terrain filters, save/load descriptors |
| [HexPack](guides/hex-pack.md) | Zip-based asset and map packages — bundle terrain, liquid, scatter, and maps into one file |
| [Custom Map Generator](guides/custom-map-generator.md) | Plugin interface and composing raw generation passes |
| [Runtime Map Editing](guides/runtime-map-editing.md) | Painting terrain, rivers, and roads at runtime; the markDirty loop |
| [Fog of War](guides/fog-of-war.md) | Reference-counted visibility, reveal animation, multi-unit integration |
| [Pathfinding and Movement](guides/pathfinding-and-movement.md) | A\*, movement range, LOS, path smoothing, MoveCostFn design |

API reference (TypeDoc): `docs/index.html` after running `npm run docs`, or live at [loyalj.github.io/hex-world/docs](https://loyalj.github.io/hex-world/docs).

Live demo: [loyalj.github.io/hex-world](https://loyalj.github.io/hex-world/)

---

## License

ISC
