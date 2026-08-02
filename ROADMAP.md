# Roadmap

Findings from the 2026-07-19 functional review. Part 1 lists concrete weaknesses to fix
(correctness, robustness, performance), grouped by area. Part 2 is the liquids
improvement track — feature work to bring the liquids system up to the quality of the
rest of the library. Part 3 is the convergence track with the sister project
`hex-world-editor` (../hex-world-editor): promote its generic infrastructure down into
the library so both the editor and games built on hex-world get it.

---

## Part 1 — Concrete weaknesses

### Liquids correctness

- [x] **Shore foam washed out by camera-dependent draw order** — three.js sorts
  transparent meshes back-to-front by bounding-sphere depth, and the full-hex water
  surface mesh overlaps the shore strip, so for many camera positions whole chunks
  composited the deep surface *over* the foam (shore/estuary meshes had no
  `renderOrder`, unlike rivers/roads). Fixed with an explicit transparent stack in
  `ChunkManager`: surface 0 → shore 1 → estuary 2 → river 3 → roads 4.
- [x] **Shoreline seam coupling** — `buildShoreGeometry`, `buildEstuaryGeometry`, and
  `buildRiverGeometry` hard-code `elevPerturbStr = 0.2` and sample land-edge Y with the
  *liquid's* `noiseScale`, while terrain uses `ChunkGeometryOptions.elevPerturbStrength`
  and its own `noiseScale` (`src/geometry/WaterShoreChunk.ts:41`,
  `src/geometry/EstuaryChunk.ts:39`, `src/geometry/HexChunk.ts:116`). Thread the terrain
  values into `WaterGeometryOptions` (separate from the liquid's surface-noise scale) so
  per-liquid `noiseScale` overrides no longer open gaps at the waterline.
- [x] **Shore/estuary overlap at river mouths** — `buildShoreGeometry` documents that
  estuary edges are skipped but never checks `hasRiverThroughEdge`
  (`src/geometry/WaterShoreChunk.ts:26`). Both transparent meshes render on the same
  edge and double-blend. Skip the strip quad on estuary edges.
- [x] **River-generated lakes ignore liquid type and punch craters** — mid-flow lakes
  hard-code `TerrainType.Water` instead of `waterTerrainIndex`
  (`src/generators/RiverGenerator.ts:123`), and both lake paths force elevation to −1.
  A river stuck on a high plateau becomes a sea-level pit. Use `waterIdx` consistently
  and set the floor to `currentElevation - 1` (the `MountainLakePlugin` convention:
  floor = desired surface − 1).
- [x] **Unclassified rivers render once per liquid type** — when downstream tracing
  can't classify a river, it is included in *every* liquid's river mesh
  (`src/geometry/WaterChunk.ts:184`), producing 2–3 overlapping translucent channels.
  Assign unclassified rivers to a single default liquid.
- [x] **River merges corrupt chains** — the simple tracer overwrites an existing
  incoming direction on the joined cell (`src/generators/RiverGenerator.ts:226`),
  leaving the other river's channel dead-ending at a hex border. Check
  `hasIncomingRiver` before merging (the climate tracer already does);
  `LiquidShowcasePlugin.traceDemoRiver` has the same partial problem.
- [x] **Liquid–liquid shore priority breaks for multi-index liquids** — the priority
  test compares the neighbor's raw terrain index against `min(waterTerrains)` of the
  current liquid (`src/geometry/WaterShoreChunk.ts:156`). With a liquid spanning
  indices {5, 9} adjacent to {6}, both liquids render foam. Compare liquid-level
  priorities instead of per-cell indices.

### Geometry / ChunkManager

- [x] **Scatter rebuild regression** — the dirty-rebuild path omits the
  `allWaterTerrains` argument that `loadChunk` passes
  (`src/geometry/ChunkManager.ts:473` vs `:293`), so after any `markDirty` edit,
  scatter can spawn on custom liquid cells (lava/acid). One-line fix.
- [x] **Scratch buffer churn** — `buildChunkGeometry` allocates ~69 MB of transient
  `Float32Array`s per 32×32 chunk build and discards them
  (`src/geometry/HexChunk.ts:93`). Hoist to reusable module-scope buffers; this is the
  dominant GC/perf cost during streaming.
- [x] **Unguarded `uTime` uniform access** — `ChunkManager.update()` sets
  `uniforms.uTime.value` on any liquid `ShaderMaterial`
  (`src/geometry/ChunkManager.ts:351`). A custom material without `uTime` throws every
  frame. Guard with `'uTime' in uniforms` like `_pushFogUniform` does.
- [x] **Document `dispose()` scope** — `ChunkManager.dispose()` unloads chunks but
  never frees the terrain material, texture array, liquid materials, or
  `FogData.texture` (`src/geometry/ChunkManager.ts:597`). Document that the caller
  owns what it passed in (or add an `ownsMaterials` option).

### Generators

- [x] **`POINTY_TOP` hard-coded in generation** — `RoadGenerator` and `RiverGenerator`
  capture `POINTY_TOP.edgeDirections` at module load (`src/generators/RoadGenerator.ts:6`,
  `src/generators/RiverGenerator.ts:7`), breaking flat-top layouts silently. Accept the
  orientation (or layout) as a parameter.
- [x] **Non-reentrant module state** — `ChunkTerrainGenerator` keeps `frontier` /
  `inFrontier` as module singletons (`src/generators/ChunkTerrainGenerator.ts:50`).
  Make them instance-local or document non-reentrancy.
- [x] **Silent `guard < 10000` cap** — high `landPercentage` on small maps can spin the
  raise loop to the cap with no signal (`src/generators/ChunkTerrainGenerator.ts:174`).
  Warn or surface the shortfall.
- [x] **Plugin exposure inconsistency** — `MountainLakePlugin` and
  `LiquidShowcasePlugin` live in `src/generators` but are not exported from
  `generators/index.ts`. Either export them or move them under `src/demo`.

### Map / serialization

- [x] **Version compatibility strategy** — both deserializers hard-throw on
  `version !== 1` (`src/map/MapSerializer.ts:77`, `:175`) with no migration hook. Add a
  supported-version range + per-version migration before `VERSION` ever bumps;
  otherwise every saved map and `.hexpack` is one bump from unloadable. Raised
  priority: hex-world-editor saves maps users invest real time in.
- [x] **Truncated binary loads silently** — `deserializeMap` copies via `subarray`
  with no length validation (`src/map/MapSerializer.ts:88`), so a short file yields a
  partially zero-filled map instead of an error. Validate expected byte length (and
  consider a checksum).
- [x] **Binary format drops metadata** — `serializeMap` keeps only
  width/height/featureLayerCount; name/seed/generator are lost, and binary is the
  default pack format (`src/pack/HexPack.ts:273`). Persist metadata in binary too, or
  document the limitation and steer packs to JSON when metadata matters.
- [x] **`OffscreenCanvas` without feature detection** — `MapImageRenderer` throws on
  platforms without it (`src/map/MapImageRenderer.ts:99`). Feature-detect and fall back
  to a DOM canvas. Also remove the stale `// Pass 2` comment.

### Pathfinding / units / camera

- [x] **Single-source the elevation scale** — `0.5` is independently hard-coded in
  `src/units/HexUnit.ts:7`, `src/pathfinding/Pathfinding.ts:3`,
  `src/geometry/ScatterBuilder.ts:21`, and defaulted in `src/geometry/HexChunk.ts:73`.
  Any custom `elevationScale` makes units/scatter/LOS disagree with the rendered
  terrain. Export one constant and thread it through. hex-world-editor carries a
  fourth copy (`src/scene.ts:21`) — external proof the constant leaks to consumers.
- [x] **A\* heuristic admissibility** — `findPath` uses raw `hexDistance`
  (`src/pathfinding/Pathfinding.ts:118`), which assumes step cost ≥ 1, but `roadCost`
  invites cheaper roads. Document the ≥ 1 contract loudly or scale the heuristic by the
  minimum possible cost.
- [x] **Unit Y-placement ignores terrain perturbation and water surfaces** —
  `HexUnit._loadSegment` uses raw `getElevation * 0.5`
  (`src/units/HexUnit.ts:162`), so units don't sit exactly on the perturbed surface and
  have no notion of water-surface height. Consult the same Y formula the terrain uses.
- [x] **`getVisibleCells` uses `Array.shift()`** — O(n) per pop in the fog hot path
  (`src/pathfinding/Pathfinding.ts:252`). Use an index cursor.

---

## Part 2 — Liquids improvements

The feature track. Goal: liquids that read as distinct materials (lava ≠ tinted
water) with richer motion, at equal or better performance.

### Descriptor-driven appearance (highest visual payoff)

- [x] **`opacity`** — currently hard-coded at 0.82 in all four shaders. Lava wants
  ~1.0; per-liquid alpha is the single biggest "tinted water" tell.
- [x] **`flowSpeed` / animation time scale** — wave, foam, and river-flow rates are
  constants in `WATER_GLSL`. Lava should crawl; acid could pulse. One per-liquid time
  multiplier uniform covers all four materials.
- [x] **`emissive` + `emissiveStrength`** — lava doesn't glow and fog-of-war dims it
  like water. An emissive term in the fragment shaders (exempt or partially exempt
  from fog dimming) would transform it.
- [x] **`waveScale` / foam tuning** — expose the surface-noise frequency and foam
  band parameters that are currently baked into the GLSL.
- [x] All new fields live on `LiquidTypeDescriptor` (JSON-safe, serialized with maps,
  resolved by `resolveLiquidMaterials`), so packs and saves carry the look.

### Depth and color

- [x] **Revive the shallow→deep gradient** — every generator places floors at exactly
  surface − 1, so `depth ≈ 0.11` everywhere and `deepColor` never shows
  (`src/geometry/WaterChunk.ts:100`). Derive depth from distance-to-shore (BFS from
  land cells, cheap at build time) or actual bathymetry where generators carve deeper.

### Rivers

- [x] **Waterfall geometry** — a river crossing a cliff currently renders as one
  steep stretched quad. Emit dedicated waterfall geometry (and faster UV flow) when
  the elevation drop exceeds the cliff threshold.
- [x] **Confluences / flow volume** — `HexMap.riverInBits` stores a per-cell
  incoming-edge bitmask (multiple tributaries per cell); `setRiverIncoming` is
  additive with `removeRiverIncoming` / `removeRiverOutgoing` for editing; the
  cell byte keeps the lowest incoming as the primary. Serialization bumped to
  v2 with v1→v2 migrations for both formats (first real use of the migration
  machinery). Generators merge mid-stream; junction cells get a center-cap fan;
  multi-tributary water cells render an estuary per incoming edge; and
  `computeRiverFlow` accumulates flow volume down every network (derived, not
  stored).
- [x] **Flow-dependent channel width rendering** — rivers now widen downstream
  with accumulated flow, on by default (`flowWidenedRivers: false` on
  ChunkManager/HexWorld restores fixed widths). `src/geometry/RiverWidth.ts`
  holds the shared mapping: half-width = `0.16 · flow^0.22` clamped to
  [0.16, 0.32] of the edge span — headwaters render SLIMMER than the old fixed
  0.25, major rivers up to 2× a source, saturating around flow ~23 so
  hand-painted maps use the whole range (the first cut used a log curve that
  capped at flow ~10, making every river look uniformly wide). `riverEdgeFlow`
  resolves each edge's width from the UPSTREAM cell so both cells of a shared
  edge always agree — this keeps widths continuous across cell and chunk
  borders — and interior flanks/junction mouths all scale by the same
  per-cell factor, so confluence-basin proportions match the original design
  at every flow. Both builders parameterize the same points: HexChunk widens
  the groove notch (`ie2/ie4` in both edge-strip variants, `e2/e4` on river
  faces), the interior flank factors and matching bank-face offsets; WaterChunk
  widens `eL/eR` and the identical inner flank formulas, so the water tiles the
  widened bed exactly (vertex-level lockstep asserted in
  `tests/river-width.test.ts`, including every face of a confluence). Flow is
  cached map-wide in ChunkManager; because one edit changes flow far
  downstream, invalidation diffs the recomputed flow and marks every cell whose
  flow changed, so downstream chunks rebuild instead of keeping stale widths
  (regression test in `tests/chunk-manager.test.ts`). Tuning knobs are the four
  constants in RiverWidth.ts. Fixing this also surfaced two PRE-EXISTING
  confluence-cell bugs (found with an offline top-down rasterizer over the real
  builder output): (1) the water junction cap only fanned BETWEEN mouths — the
  per-edge "mouth triangle" is degenerate by construction — leaving a hole at
  every mouth-chord sector; the cap now also fans center → each cL–cR chord.
  (2) The terrain junction basin fanned straight from the bed-depth center up
  to the bank-top B ring, and each junction channel face converged its groove
  to a single bed point — both put walls above the river water surface across
  most of the pool, pinching channels to slits at the junction. The basin now
  has a flat bed floor out to 60% of the ring with a narrow rising rim, and
  junction mouths carry a bed-depth strip across 70% of the chord, so the
  water cuts only a thin shoreline band. Regression-tested in
  `tests/river-width.test.ts` (mouth sector triangle + mouth bed strip).

### Performance / infrastructure

- [x] **Map-wide river ownership cache** — drainage classification is re-traced per
  chunk × per liquid on every rebuild (`src/geometry/WaterChunk.ts:147`). Classify
  once map-wide, invalidate via `markDirty`.
- [x] **Incremental `computeWaterSurfaces`** — currently re-floods the entire map
  whenever any chunk is dirty (`src/geometry/ChunkManager.ts:364`). Track dirty water
  bodies and re-flood only those.
- [x] **Indexed liquid geometry** (surface builder done; shore/estuary/river remain non-indexed) — all builders emit non-indexed triangles
  (18 verts/hex for surfaces); vertex sharing would cut memory 2–3×.
- [x] **Wrap `uTime`** — `elapsedSeconds` grows unbounded; float precision degrades
  shader animation in long sessions (`src/geometry/ChunkManager.ts:349`). Wrap at a
  period that all animation frequencies divide.

---

## Part 3 — Library/editor convergence

`hex-world-editor` (../hex-world-editor) is the first-party consumer and has built
generic infrastructure by hand that belongs in the library. Standing rule: generic
code flows down into hex-world; the editor keeps only UI and tool logic. Ordered as
a promotion queue — each item shrinks the editor and gives games the same feature.

### Promotion queue

- [x] **`HexPicker` — robust picking with fallback chain** — promoted to
  `src/geometry/HexPicker.ts`: stateful class running mesh pick → flat-plane
  fallback → water-surface re-pick → last-elevation retry → short hold
  (`holdFrames`, default 4). Takes accessors for map/meshes so editors that swap
  maps stay correct, plus a bounds guard + `reset()` for map swaps (fixes a
  latent editor bug where a held cell from a larger map could read out of
  bounds). Editor now calls `picker.pick(mouseX, mouseY)` per frame and deleted
  its ~45-line copy.
- [x] **Cell overlay / highlight layer** — `src/geometry/CellOverlayLayer.ts`:
  named overlays (`set(id, cells, {style, color, opacity})`) with `'fill'`
  (hover highlight, movement-range tint) and `'outline'` (selected cell,
  territory borders — draws only boundary edges of the set) styles, plus
  `setPath(id, path)` smoothed path previews. Water-surface aware via `isWater`.
  Went with overlay meshes (depth-test-off, like the editor's implementation)
  rather than the fog data-texture substrate — no terrain-shader coupling, and
  outlines/paths need geometry anyway; a shader tint channel can still be added
  later if whole-map tints outgrow meshes. Editor deleted its three hand-built
  overlay meshes (~80 lines); covered by `tests/cell-overlay.test.ts`.
- [x] **Edit transactions with automatic dirty marking** — `src/map/MapEdit.ts`:
  `map.edit(tx => …)` (one-shot) and `map.beginEdit()`/`tx.commit()` (multi-event
  strokes) snapshot every touched cell across all channels — terrain, elevation,
  flags, rivers *including confluence masks*, roads, scatter — and return a
  replayable `MapEdit` with `undo()`/`redo()` + `cells` for dirty marking. The
  chunk-border staleness bug was fixed at the root instead: `ChunkManager.markDirty`
  is now neighbor-aware (border cells also mark the adjacent chunk whose
  shore/skirt/bridge/road geometry samples them), so every edit path benefits;
  `markDirtyCells(edit.cells)` added for batches. Editor's six command classes
  collapsed into one 20-line `MapEditCommand`; this also fixed the old
  `RiverPaintStrokeCommand` losing confluence masks on undo (it only restored the
  primary incoming direction). Covered by `tests/map-edit.test.ts`.
- [x] **ChunkManager in-place swaps** — `setMap(map)` and
  `setTerrainDefinitions(defs, material?)` unload all chunks, swap the derived
  state (`chunksX/chunksY` are now computed getters; terrain-definition lookups
  recompute via a shared `applyTerrainDefinitions`), and recompute water
  surfaces with the new liquid membership; chunks stream back in on the next
  `update()`/`loadAll()`. The editor's three dispose-and-recreate sites
  (`replaceMap`, `rebuildTerrainFromDescriptors`, `loadAndApplyHexPack`) now
  swap in place. Covered in `tests/chunk-manager.test.ts`.
- [x] **Paired road-edge helper** — `HexMap.setRoadEdge(col, row, edge, state,
  orientation)` sets both half-edges and returns the affected cells (one at the
  map border), with `roadEdgeNeighbor()` exposing the edge↔neighbor mapping.
  Mirrored on `MapTransaction.setRoadEdge` so road strokes snapshot both cells.
  The editor's road tool now uses it; symmetry covered in `tests/map-edit.test.ts`.
- [x] **`HexWorld` façade** — `src/world/HexWorld.ts`: `HexWorld.create(opts)`
  wires renderer, RTS camera controller, lighting, terrain/liquid materials,
  ChunkManager, per-frame `HexPicker`, `CellOverlayLayer`, resize handling, and
  the animate loop (`onFrame` hook, `start`/`stop`/`dispose`). Runtime swaps
  built on the new in-place APIs: `setMap`, `setTerrainDescriptors`,
  `applyTerrainDefinitions` (for `loadHexPack` results). Every piece stays
  public so consumers can drop to the à-la-carte API. Editor's `initScene`
  shrank from ~365 lines to ~115 (only scatter defs + editor-specific API
  remain); quick start now starts with the 4-line `HexWorld` path.

### Workflow

- [x] **Link the editor to library HEAD** — done via a conditional Vite alias
  (not `npm link`): the editor's `vite.config.ts` + `tsconfig.json` `paths` map
  `@loyalj/hex-world` → `../hex-world/src/index.ts` when the sibling repo exists,
  falling back to the published npm package otherwise. `package.json` is
  untouched, so cloners of the editor repo get the npm version with a plain
  `npm install`. Side effect: the editor now typechecks library HEAD source,
  which surfaced and fixed two non-erasable syntax issues in the library
  (`TerrainType` exported `const enum` → `as const` object + widened type;
  `MinHeap` constructor parameter property → explicit field).

### Editor follow-ups unlocked by library work

- [x] **Liquid painting palette** — the editor palette now ships Lava (index 6)
  and Acid (index 7) terrain entries linked to the built-in liquid descriptors,
  paintable out of the box alongside Water. The editor also manages a live
  `liquidDescriptors` array: the add-terrain dialog's liquid dropdown is
  populated from it (so custom liquids are paintable via liquid-typed terrain),
  map JSON saves and `.hexpack` exports carry it, and loads adopt the file's
  liquids (JSON via `deserializeMapJSON`, packs via `loadHexPack`'s resolved
  descriptors + materials). Library support: `ChunkManager.setLiquids()` and
  `HexWorld.setLiquidDescriptors()` swap liquid types in place (covered in
  `tests/chunk-manager.test.ts`).
- [x] **Liquid appearance editing** — new 💧 "Liquid Types" dialog in the
  terrain palette: edit any liquid's name, shallow/deep/foam colors, opacity,
  flow speed, wave scale, foam intensity, and emissive color/strength, or
  create new liquids ("+ New liquid…"). Applies live through
  `setLiquidDescriptors` and rides the same save/load paths as the palette
  item, so packs carry the look.
- [x] **Confluence-aware river tool** — undo/redo now snapshots the full
  incoming mask for free via `MapEdit`. Tool behavior updated for partial
  detaches: painting merges with existing rivers (incoming edges are additive;
  replacing a cell's outgoing detaches the old downstream neighbour's matching
  incoming), path-erase removes only the half-edges along the drawn path so
  tributaries at confluences survive, and brush-erase detaches every neighbour
  half-edge pointing at the erased cell (no dangling channel stubs).
