# Hex World — Three.js Library Roadmap

Follows the structure of the [Catlike Coding Hex Map tutorial series](https://catlikecoding.com/unity/tutorials/hex-map/), adapted for a reusable Three.js library targeting large-scale strategy games.

---

## Stage 1 — Core Grid & Geometry ✅
*Tutorial equivalent: Parts 1–2*

- [x] Project setup (Vite + TypeScript)
- [x] Cube coordinate system (`HexCoord`) with axial conversion helpers
- [x] Flat-top and pointy-top orientation support (`HexOrientation`)
- [x] World-space layout math — hex center, corner positions (`HexLayout`)
- [x] Single hex `BufferGeometry` generation
- [x] Basic `HexMap` data structure (flat `TypedArray` backed cell storage)
- [x] Demo: render a flat grid of colored hexes

---

## Stage 2 — Chunk System & Large Map Support ✅
*Tutorial equivalent: Part 5 (Larger Maps)*

- [x] Divide map into NxN chunks (`HexChunk`)
- [x] Per-chunk merged `BufferGeometry` (single draw call per chunk)
- [x] `ChunkManager` — track loaded/unloaded chunks relative to camera, with `markDirty` rebuild support
- [x] Frustum culling per chunk
- [x] Demo: 512×512 map with chunk streaming and debug HUD (FPS, chunk count, zoom)

---

## Camera & Controls ✅
*Outside tutorial scope — library addition*

- [x] `RtsCameraController` — strategy-game camera with smooth damping
- [x] Right-drag pan using ground-plane raycasting (correct speed at any zoom/pitch)
- [x] Scroll-wheel zoom toward cursor
- [x] Middle-drag pitch tilt (15°–80° range)
- [x] Configurable min/max distance, damping, tilt speed

---

## Stage 3 — Color Blending & Cell Appearance ✅
*Tutorial equivalent: Parts 2, 14*

- [x] Per-cell color/terrain-type storage
- [x] Vertex color blending at cell edges — 3-cell corner average, no hard borders
- [x] Texture splatting — `TerrainMaterial` (splat map + `DataArrayTexture`), procedural noise per terrain type with per-type image override support (`buildTerrainTextureArray`), `colorMode: 'flat' | 'splat' | 'debug'` on `ChunkGeometryOptions`, `ChunkManager.setColorMode()` for runtime switching
- [x] Demo: multi-terrain map with smooth blends

---

## Stage 4 — Elevation & Terraces ✅
*Tutorial equivalent: Parts 3–4*

- [x] Per-cell elevation data (Int8, -128–127 steps)
- [x] Terrace geometry on slope edges — 5-step TerraceLerp for Y, linear XZ, matching tutorial Part 3
- [x] Full corner dispatch (SSF/SFS/FSS/SCC/CSS/CCSR/CCSL) — all 7 three-cell corner configurations
- [x] XZ vertex perturbation via smooth 4-channel value noise (`sampleNoise`) — organic jittered edges (Part 4)
- [x] Per-cell Y elevation offset via noise channel — subtle height variation without per-vertex Y chaos (Part 4)
- [x] Edge subdivision: EdgeFan (4 triangles per solid direction, 5-vertex edge) + EdgeStrip (4 or 20 quads per bridge) (Part 4 / Part 6)
- [x] `SOLID_FACTOR` 0.8, `BLEND_FACTOR` 0.2 (Part 4)
- [x] `computeVertexNormals()` on each chunk so lighting reacts to slopes
- [x] Demo: mountainous terrain with smooth slopes, terraced edges, and organically perturbed geometry
- [ ] Cliff wall quads — extend high cell lip down to eliminate gaps at cliff edges
- [ ] Cliff wall colour gradient (top→bottom) for depth
- [ ] `cliffThreshold` configurable via `ChunkGeometryOptions`

---

## Stage 5 — Water ✅
*Tutorial equivalent: Parts 6, 8*

- [x] River data model — directed per-cell packed byte (`OFFSET_RIVER_DIR`): bits 2-0 = incoming+1, bits 5-3 = outgoing+1; full API (`hasRiver`, `getIncomingRiverDir`, `getOutgoingRiverDir`, `hasRiverThroughEdge`, `setRiverOutgoing`, `setRiverIncoming`)
- [x] River channel geometry — 5-vertex edge strips (0/0.25/0.5/0.75/1.0) with center vertex depressed to `streamBedY = (elev − 1.75) × elevScale`; no noise perturbation on stream bed for cross-cell consistency (Part 6)
- [x] Inside-cell river routing — 5-case dispatch per direction: normal fan / adjacent-to-river / begin-or-end / straight-through / sharp-turn / gentle-curve; `INNER_TO_OUTER` scaling for curve center line (Part 6)
- [x] Standing water — full hex fan at configurable `waterLevel` over Water-terrain cells
- [x] River water surface — inner-hex fan at `riverSurfaceY = (elev − 0.5) × elevScale` (SOLID_FACTOR vertices); slope quads at hex boundary for elevation-different adjacent river cells; XZ perturbation via `sampleNoise` matching terrain builder for seamless edges
- [x] Water shader — dual-layer sin-wave `ShaderMaterial` with specular glint, world-XZ-driven UV animation
- [x] Demo: rivers auto-traced downhill from high-elevation cells to ocean/lakes using directed outgoing/incoming edge API

---

## Stage 6 — Roads & Terrain Features
*Tutorial equivalent: Parts 7, 9–11*

- [ ] Road data model (undirected edges)
- [ ] Road geometry (strip mesh along cell edges)
- [ ] Feature placement API (forests, cities, landmarks) using `InstancedMesh`
- [ ] Wall geometry between designated cells
- [ ] Demo: roads, forests, and walls on terrain

---

## Stage 7 — Saving & Loading
*Tutorial equivalent: Parts 12–13*

- [ ] Binary serialization format for `HexMap` data
- [ ] Save/load API (`MapSerializer`)
- [ ] Map metadata (name, size, seed)
- [ ] Demo: save and reload a map in-browser

---

## Stage 8 — Distances & Pathfinding
*Tutorial equivalent: Parts 15–17*

- [x] Hex distance, neighbors, range, line — already in `HexCoord.ts`
- [ ] A* pathfinding on hex grid with terrain cost support
- [ ] Movement range calculation (flood fill with budget)
- [ ] Path smoothing helper
- [ ] Demo: click-to-pathfind with movement range highlight

---

## Stage 9 — Units & Animated Movement
*Tutorial equivalent: Parts 18–19*

- [ ] `HexUnit` entity (position, facing, stats)
- [ ] Unit renderer (instanced or individual mesh)
- [ ] Path-following animation along hex path
- [ ] Demo: multiple units moving across map

---

## Stage 10 — Fog of War & Exploration
*Tutorial equivalent: Parts 20–22*

- [ ] Per-cell visibility state (unseen / seen / visible)
- [ ] Line-of-sight calculation (hex raycasting with elevation)
- [ ] Fog of war overlay mesh / shader
- [ ] Exploration reveal animation
- [ ] Demo: units revealing fog as they move

---

## Stage 11 — Procedural Map Generation
*Tutorial equivalent: Parts 23–27*

- [ ] Land mass generator (configurable island/continent ratio)
- [ ] Erosion pass (smooth elevation distribution)
- [ ] Water cycle (river source placement, flow-to-sea)
- [ ] Biome assignment (temperature + moisture → terrain type)
- [ ] Wrapping support (toroidal map edges)
- [ ] Demo: procedurally generated playable map

---

## Stage 12 — Performance & Polish
*Tutorial equivalent: Modern project updates (v2.0.0–v5.2.0)*

- [ ] LOD system (simplified chunk geometry at distance)
- [ ] Worker-thread chunk mesh generation (off main thread)
- [ ] Map streaming (unload distant chunks, stream new ones)
- [ ] TypeScript API documentation
- [ ] Published example scene with all features

---

## Notes

- All coordinate math lives in a dependency-free `math/` module — usable without Three.js.
- Three.js is a peer dependency; the library does not bundle it.
- Chunk size is configurable; default target is 32×32 cells per chunk.
- Cell data is stored as `Int16Array` / `Uint8Array` typed arrays for memory efficiency at scale.
