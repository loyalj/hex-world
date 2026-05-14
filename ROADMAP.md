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
- [x] Cliff wall quads — extend high cell lip down to eliminate gaps at cliff edges
- [x] Cliff wall colour gradient (top→bottom) for depth
- [x] `cliffThreshold` configurable via `ChunkGeometryOptions`

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

- [x] Road data model — undirected per-cell edge bits (`roadBits` Uint8Array); full API (`hasRoads`, `hasRoadThroughEdge`, `setRoad`) (Part 7)
- [x] Road geometry — strip mesh along cell edges with `RoadMaterial`; rendered at `renderOrder=2` above terrain and water (Part 7)
- [x] Scatter / feature placement API — `HexHashGrid` (seeded mulberry32, 256×256 × 5 floats), `ScatterLayerConfig` (density tier × variant), `buildScatterMeshes` with 7 slots per cell (center + 6 direction triangles), competition logic, `InstancedMesh` per (layer-tier-variant) key (Part 9)
- [x] Feature layer data — `featureLayerCount` on `HexMap`, `Uint8Array` feature storage, `getFeatureLevel`/`setFeatureLevel` (values 0–3) (Part 9)
- [x] Demo: pine tree scatter on grassland/desert with 3 density tiers; roads traced on grid avoiding water, rivers, and steep slopes
- [ ] Wall geometry between designated cells (Part 10)
- [ ] Wall colour gradient / cliff walls (Part 11)

---

## Stage 7 — Saving & Loading ✅
*Tutorial equivalent: Parts 12–13*

- [x] Binary serialization format for `HexMap` data — `HXMP` magic, version byte, uint32 dimensions, three packed data sections
- [x] Save/load API — `serializeMap` / `deserializeMap` (binary `Uint8Array`), `serializeMapJSON` / `deserializeMapJSON` (base64 JSON envelope)
- [x] Map metadata (`MapMetadata` interface: name, seed, generatorId) — optional second arg to `serializeMapJSON`, returned in `DeserializedMap` from `deserializeMapJSON`
- [x] Demo: `[S]` saves current map + metadata to localStorage; `[L]` loads and restores generator selection, seed, and cell data; status shown in HUD

---

## Stage 8 — Distances & Pathfinding
*Tutorial equivalent: Parts 15–17*

- [x] Hex distance, neighbors, range, line — already in `HexCoord.ts`
- [x] A* pathfinding — `findPath(from, to, costFn, map)` returns `HexCoord[] | null`; game supplies `MoveCostFn`, return `Infinity` for impassable
- [x] Movement range — `getMovementRange(center, budget, costFn, map)` returns all reachable cells; Dijkstra flood-fill, budget in cost units
- [ ] Path smoothing helper
- [ ] Demo: click-to-pathfind with movement range highlight

---

## Stage 9 — Units & Animated Movement ✅
*Tutorial equivalent: Parts 18–19*

- [x] `HexUnit` entity — col/row position, smooth worldX/Y/Z interpolation, facing angle, `travelSpeed`, `heightOffset`, `fogRevealRange`; `travel(path)` / `stop()` / `update(dt, map, layout)` API; `onMoveStart` / `onCellEnter` / `onMoveEnd` callbacks for consumer animation control
- [x] `UnitManager` — Three.js bridge; maps each `HexUnit` to a consumer-supplied `Object3D`; updates position + rotation each frame; manages per-unit fog reveal via `FogData` (increase on enter, decrease on leave); `addUnit` / `removeUnit` / `update` / `reapplyFog` / `dispose`
- [x] Path-following animation — smooth lerp between cells, facing updated per segment, deltaTime-capped movement, multi-cell per frame handled with while loop
- [x] Demo: single capsule unit; click land to move via A*; path preview on hover; movement-range highlight rebuilds on cell enter; fog reveals as unit walks; `[Esc]` stops movement; color changes on move/idle to demonstrate callback hooks

---

## Stage 10 — Fog of War & Exploration ✅
*Tutorial equivalent: Parts 20–22*

- [x] `FogData` class — `DataTexture` (R=visible, G=explored), integer visibility counts per cell, dirty-flag GPU upload, `increaseVisibility` / `decreaseVisibility` / `reset` / `dispose`
- [x] `cellIndex` attribute on all geometry builders — flat `row * width + col` index stored per vertex so shaders can sample the fog texture without geometry rebuilds
  - Terrain (`HexChunk`): `vec3 cellIndex` (3-cell blend, averaged visibility at corners/terraces/bridges)
  - Water, river, shore, estuary, road: `float cellIndex` (own water/road cell)
- [x] Fog uniforms on all shader materials — `uFogData` (sampler2D), `uFogDataSize` (vec2), `uFogEnabled` (float); all shaders multiply final color by `vVisibility`; dummy 1×1 texture bound when fog is off
- [x] `FogGLSL.ts` — shared GLSL1 snippet constants and `fogUniforms()` factory used by all water/road materials
- [x] `ChunkManager` integration — `fogData?: FogData` option, `applyFog()` helper sets uniforms on all ShaderMaterials, `update()` calls `fogData.update()` each frame, `setFogData(fog|null)` for runtime toggle
- [x] `getVisibleCells(center, range, map)` in pathfinding module — BFS, no cost function, returns all cells within `range` steps
- [x] Demo: `[F]` toggles fog; click to reveal cells (range 3 BFS) around hovered hex; initial reveal seeded from map center
- [ ] Line-of-sight blocking (elevation-aware raycasting)
- [ ] Exploration reveal animation (smooth fade-in)

---

## Stage 11 — Procedural Map Generation
*Tutorial equivalent: Parts 23–26*

### Infrastructure ✅
- [x] Generator extraction — `src/generators/` with `generateFbmTerrain`, `generateRivers`, `generateRoads`; all params exposed as optional config objects; `offsetNeighbor` added to `HexCoord.ts`

### Plugin Interface (do first, before any Phase A work)
All generators implement a common interface so the demo (and future games) can swap them via a dropdown without knowing their internal details. Raw generator functions remain exported for library consumers who want fine-grained control.

- [x] **`MapGeneratorPlugin<TConfig>`** (`src/generators/MapGeneratorPlugin.ts`) — `id`, `name`, `defaultConfig`, `generate(map, config, seed)`
- [x] **`FbmPlugin`** (`src/generators/FbmPlugin.ts`) — wraps `generateFbmTerrain` + `generateRivers` + `generateRoads`; seed drives `noiseOffsetX/Z` via mulberry32 so different seeds produce genuinely different maps
- [x] **`HexMap.clear()`** — zeros all cell data (uint8, roadBits, featureData) for in-place regeneration
- [x] Update demo `main.ts` — `GENERATORS` array, `[R]` new seed, `[G]` cycle generator, seed + generator name shown in HUD

### Phase A — Chunk Land Generator (Part 23–24)
Replaces the current FBM elevation pass with a budget-controlled BFS raise/sink algorithm.
Terrain type is NOT assigned here — elevation only. FBM generator kept as a fast alternative.

- [x] **`ChunkTerrainGenerator`** (`src/generators/ChunkTerrainGenerator.ts`) — bucket-queue BFS raise/sink; module-level `frontier`+`inFrontier` reused across calls; 10 000-iteration guard; all cells start at elev -1
- [x] **`RegionLayout`** (`src/generators/RegionLayout.ts`) — 1–4 regions; 2-region split orientation chosen randomly from `rand`; degenerate regions filtered out
- [x] **`ErosionPass`** (`src/generators/ErosionPass.ts`) — O(1) erodible bookkeeping via array + index Map; conserves landmass by raising cliff-base; checks both eroded cell's and target's neighbours
- [x] **`makeRng`** (`src/math/Random.ts`) — shared mulberry32 PRNG; used by ChunkPlugin and FbmPlugin
- [x] **`ChunkPlugin`** (`src/generators/ChunkPlugin.ts`) — wires RegionLayout → ChunkTerrain → Erosion → placeholder terrain/feature assignment → Rivers → Roads; registered in demo `GENERATORS` array

### Phase B — Climate Simulation (Part 25)
Per-cell moisture derived from a partial water cycle simulation. Runs after elevation is set.

- [x] **`ClimateSimulator`** (`src/generators/ClimateSimulator.ts`)
  - Per-cell `ClimateData { clouds: number; moisture: number }`
  - Simulation loop (configurable cycle count, default 40):
    1. **Evaporation**: water cells → `moisture = 1`, add `evaporationFactor` to clouds; land cells → convert `moisture * evaporationFactor` to clouds
    2. **Precipitation**: remove `clouds * precipitationFactor` from clouds, add to moisture
    3. **Cloud dispersal**: spread clouds equally to all 6 neighbors (lost at map edges)
    4. **Runoff**: drain `moisture * runoffFactor / 6` to each neighbor that is strictly lower (use view elevation to handle shorelines correctly)
    5. **Seepage**: a smaller factor spreads moisture to equal-elevation neighbors
  - Returns `Float32Array` of per-cell moisture values (0–1)
  - Config: `evaporationFactor` (0.5), `precipitationFactor` (0.25), `runoffFactor` (0.25), `seepageFactor` (0.125), `cycles` (40)

### Phase C — Temperature, Biomes, and Rivers (Part 26)
Assigns terrain types based on temperature × moisture matrix, then places rivers at high-weight origins.

- [x] **`TemperatureModel`** (`src/generators/TemperatureModel.ts`)
  - Latitude-based temperature: `lerp(lowTemp, highTemp, latitude)`
  - Hemisphere modes: `both` (equator at center), `north`, `south`
  - Elevation cooling: `temp *= 1 - (elev - waterLevel) / (elevMax - waterLevel + 1)`
  - Noise jitter: channel from `sampleNoise(pos * 0.1)`, scaled by `temperatureJitter`
  - Returns `Float32Array` of per-cell temperature values (0–1)
  - Config: `lowTemperature` (0), `highTemperature` (1), `hemisphere` ('both'), `temperatureJitter` (0.1)
- [x] **`BiomeAssigner`** (`src/generators/BiomeAssigner.ts`)
  - 4×4 biome matrix indexed by temperature band (0.1, 0.3, 0.6) × moisture band (0.12, 0.28, 0.85)
  - Maps our 6 `TerrainType` values: Water (handled separately), Snow, Rock, Desert, Grassland, Mud (= taiga/tundra)
  - Default matrix: dry column → Desert; cold rows → Snow/Rock; warm+wet → Grassland; moderate → Mud
  - Also sets feature layer 0 (tree density) based on biome: wet warm biomes get level 2-3, dry/cold get 0-1
  - Config: matrix is overridable, temperature and moisture bands are configurable
- [x] **Upgrade `RiverGenerator`** to climate-driven placement (`generateClimateRivers`)
  - Instead of seeding from a coarse elevation grid, build a weighted origin list: weight = `moisture * (elev - waterLevel) / (elevMax - waterLevel)`
  - Four importance tiers: >0.75 → 4 entries, >0.5 → 3, >0.25 → 2, else skip
  - River budget: `riverPercentage` of land cells (0–20%, default 10%)
  - Flow algorithm: BFS downhill with momentum (prefer directions within 120° of previous), triple-weight downhill steps, avoid cells already having incoming rivers
  - Lake formation when stuck: raise `waterLevel` of stuck cell to min neighbor elevation
  - Keep-distance rule: disqualify origins adjacent to existing rivers or water
  - Config: `riverPercentage` (10), `extraLakeProbability` (0.25)

### Phase D — Orchestration & Demo
- [x] **`MapGenerator`** (`src/generators/MapGenerator.ts`)
  - Wires all phases in order: `RegionLayout` → `ChunkTerrainGenerator` → `ErosionPass` → `ClimateSimulator` → `TemperatureModel` → `BiomeAssigner` → upgraded `RiverGenerator` → `RoadGenerator`
  - Single `MapGeneratorConfig` object with all sub-configs nested
  - Returns the filled `HexMap` (caller provides the map instance)
  - `seed` drives all internal PRNG — same seed + same config = same map
- [x] `ChunkPlugin` delegates to `generateMap()` — no duplicate pipeline logic
- [x] Demo already exposes seed in HUD with `[R]` new seed / `[G]` cycle generator

### Notes on design decisions
- `FbmTerrainGenerator` is kept as a lightweight, no-simulation alternative (fast iteration, simple worlds)
- `ChunkTerrainGenerator` + climate is the "full quality" path
- Elevation scale: water cells at elev ≤ -1, land at elev ≥ 0 (unchanged from current system)
- `ClimateSimulator` does NOT use our river data — rivers are placed after simulation
- Tree feature levels come from `BiomeAssigner` replacing the inline assignment in `FbmTerrainGenerator`

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
