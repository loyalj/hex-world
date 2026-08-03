# Roadmap

Started 2026-08-02. The previous roadmap (2026-07-19 functional review, liquids
improvements, and editor convergence) completed in full — see git history through
commit `197f404` for the record.

Two tracks. Part 1 is engine feature work, grouped by theme and roughly ordered so
that foundation items land before the features that build on them. Part 2 is the
reference mini game, **The Long Migration** — a real game built on the library to
validate API ergonomics, showcase huge-map streaming, and drive several Part 1
features from actual need.

---

## Part 1 — Engine features

### Foundation (data + pipeline)

- [x] **Generic per-cell metadata channel** — `HexMap.cellData` sparse store with
  `getCellData`/`setCellData`, undo/redo via `MapTransaction.setCellData`, and a
  v2→v3 serialization bump (binary trailer + JSON `cellData` field) with
  migrations. Rides through `.hexpack` in both formats. *Underpins: territory
  layer, resource layer, and most Long Migration mechanics.*
- [x] **Async generation with progress** — `generateMapAsync` /
  `generatePluginAsync` drive step-generator pipelines (`generateMapSteps`,
  plugin `generateSteps`) in time-sliced chunks with `AbortSignal` cancellation
  and per-pass `GenerationProgress` events. Deterministic vs. the sync path.
- [x] **Web Worker chunk building** — `buildChunkGeometry` split into a
  three-free core (`buildChunkArrays`) that runs in `chunk.worker.ts`;
  `ChunkManager` streams new chunks through `WorkerChunkBuilder` (opt-in via
  `workerFactory` / HexWorld `chunkWorker: true`) with transferable buffers and
  stale-result invalidation. Dirty rebuilds and liquids stay synchronous.
- [x] **Finish indexed liquid geometry** — shore, estuary, and river builders now
  weld per-cell vertices into indexed geometry like the surface builder, cutting
  liquid vertex memory ~2.3–2.7×.

### Rendering & atmosphere

- [x] **Shader-based hex grid overlay** — anti-aliased lattice lines in the
  terrain fragment shader (`configureTerrainGrid` / `HexWorld.setHexGrid`),
  fading with camera distance and on cliff faces. Toggle and restyle are
  uniform flips — no geometry rebuild. Demo: `[H]`. The editor can drop its
  line meshes.
- [ ] **Sky system** — gradient dome or skybox with horizon fog color-matched to
  the biome palette, so map edges dissolve into atmosphere instead of a hard void.
- [ ] **Waterfall polish** — the waterfall geometry exists; add spray/mist
  particles and a foam pool at the base to sell it.
- [ ] **Seasons and snow accumulation** — gradual snowline descent and river
  freeze driven by the temperature model the climate generator already computes,
  blended in the terrain shader. Needs a world-time input and per-cell temperature
  available at render time. *The Long Migration's antagonist mechanic.*
- [ ] **Day/night cycle** — animated sun direction with warm dawn/dusk tinting and
  a moonlight mode. Lava's emissive glow really pays off at night. Shares the
  world-time input with seasons; sky system should react to time of day.
- [ ] **Weather effects** — rain/snow particle layers and drifting cloud shadows
  (a scrolling noise texture darkening the terrain shader is cheap and very
  effective). Cloud-shadow noise can ride the existing terrain shader uniforms.
- [ ] **Shadow support** — a tuned directional-light shadow setup (cascade or
  camera-fit ortho frustum) that plays well with chunk streaming; mountains and
  cliffs currently read flat in some light angles. Must track the day/night sun
  direction once that lands.
- [ ] **Post-processing integration** — an optional composer wiring in `HexWorld`:
  bloom (lava/emissive liquids), selection outline pass for units, SSAO for cliff
  definition. Keep it opt-in so the à-la-carte path stays composer-free.

### Gameplay layers

- [ ] **Fog-of-war memory tiers** — split "visible" from "explored": explored
  cells show remembered terrain and buildings but hide current unit positions
  (the classic Civ/AoE ghost state). The reference-counted visibility system is
  the right substrate; needs a persistence story so explored state saves with
  the map or a companion blob.
- [ ] **Territory/ownership layer** — per-cell owner IDs with blended fill tints
  and border outlines. `CellOverlayLayer` already draws outline-of-set; this adds
  persistence (via the metadata channel), serialization, and multi-faction color
  blending.
- [ ] **Resource layer** — per-cell resource types (ore, fish, forest yield) with
  billboard/instanced icons and a biome-aware generation pass. Descriptor-driven
  like terrain/liquid/scatter so packs carry custom resources.
- [ ] **Naval support** — embark/disembark transitions, ships constrained to
  liquid cells, port designation on shore cells. Liquids are first-class; units
  on them aren't yet. Movement costs and pathfinding need liquid-aware modes.

### Developer experience

- [ ] **HexWorld event emitter** — typed events (`cellClick`, `cellHover`,
  `cellEnter`/`cellLeave`, `unitArrived`, `chunkLoaded`) so consumers stop wiring
  raycasts and callbacks by hand. Plus a live minimap component built on
  `MapImageRenderer` with a viewport rectangle and click-to-jump, which dogfoods
  the events immediately.

---

## Part 2 — Reference mini game: The Long Migration

Guide a nomad clan and their herd across a continent-scale generated map, one hex
per day, with winter chasing you. Oregon Trail DNA: party and herd management,
supplies, event cards, and river crossings as the signature risk moment.

### Why this game

- **The huge-map showcase is structural** — the game *is* a journey across a
  512×1024 map; chunk streaming keeps only the caravan's surroundings loaded, and
  `MapImageRenderer` provides the zoomed-out journey-map screen with the route
  drawn on it.
- **River crossings exploit the library's best feature** — crossing danger scales
  with `computeRiverFlow` volume on the exact edge being crossed, and
  flow-dependent width rendering means dangerous rivers *look* wide. Walking
  upstream to find a safer ford is real spatial gameplay the renderer
  communicates for free.
- **The climate model is the antagonist** — per-cell temperature and moisture
  read as grazing quality, water access, and cold danger. Seasons drift the
  snowline down the map as days pass; winter is visible terrain pressure, not a
  timer UI.

### Core loop (one day = one turn)

1. **Morning** — choose the day's path; movement-range flood-fill shows reachable
   hexes with costs from terrain, elevation, weather, and herd condition.
2. **Travel** — the caravan walks it, camera following.
3. **Evening camp** — graze the herd (depletes the cell via metadata), hunt/forage
   (scatter density), rest, trade at settlements; event cards fire here.
4. **Status** — food, water, herd size, party health, days until deep winter.

Win: reach the wintering grounds with your herd. Score: animals + people + days.
Losses are part of the genre ("You lost 12 goats crossing the Kelmar River").

### Engine features it drives

Per-cell metadata (grazing depletion, event flags), fog memory (known world vs.
visible; scouting), seasons/snow (the antagonist), async generation with progress
(continent maps need a loading bar). It exercises without modification: chunk
streaming at scale, rivers/flow, pathfinding costs, biome assignment, generated
settlements as trading posts, scatter, save/load, and the minimap renderer.

### Milestones (each independently demoable)

- [ ] **M1 — Walking skeleton** — huge map generation, caravan unit with camera
  follow, day tick, terrain-cost movement. Already a better big-map streaming
  demo than anything the repo has today.
- [ ] **M2 — Survival layer** — food/water/herd condition, grazing from moisture
  data, day counter and season drift.
- [ ] **M3 — Rivers and winter** — crossing mechanics scaled by flow, snowline
  descent, frozen rivers (crossable, risky).
- [ ] **M4 — Oregon Trail dressing** — event cards, trading posts, the
  journey-map screen, end-of-run summary.

Open question: where the game lives — a sibling repo (like `hex-world-editor`) or
a `demo/` expansion in this repo. Leaning sibling repo with the same conditional
Vite alias to library HEAD.
