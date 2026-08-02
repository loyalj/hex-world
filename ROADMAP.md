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
- [ ] **Flow-dependent channel width rendering** — visually widen channels with
  accumulated flow (`computeRiverFlow` provides the data). Deferred because the
  water channel and the terrain's carved stream bed (`HexChunk` river-edge
  triangulation) must widen in lockstep with matching widths across cell
  borders — a visual-iteration job, not a data change.

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

- [ ] **`HexPicker` — robust picking with fallback chain** — promote the ~45 lines
  from editor `src/scene.ts:289-330`: mesh pick → flat-plane fallback (while chunks
  build) → water-surface re-pick (seabed-depth terrain makes raw picks land on the
  wrong water cell) → last-elevation retry at map edges → short hold to prevent
  hover flicker at chunk seams. Every consumer needs exactly this; the editor then
  deletes its copy.
- [ ] **Cell overlay / highlight layer** — promote and generalize the editor's
  hover-footprint mesh and path preview line (`src/scene.ts:144-185`, `:334-358`)
  into a library `CellOverlayLayer`: hover highlight, selected-cell outline,
  movement-range tint, path preview, territory/ownership borders. Water-surface
  aware like the editor's version. The fog system's per-cell data-texture pattern
  is the substrate. Highest-demand feature for games built on the library.
- [ ] **Edit transactions with automatic dirty marking** — a library-level
  `map.edit(tx => …)` that snapshots touched cells, applies changes, and marks
  dirty chunks INCLUDING neighbor chunks when edge cells change. Fixes a live
  editor bug: stroke commands (`src/commands.ts`) call `markDirty` only on edited
  cells, so chunk-border edits leave the adjacent chunk's shore/skirt/road geometry
  stale. Also collapses the editor's six near-identical command classes into one
  generic cell-snapshot command, and gives games undo/redo for free.
- [ ] **ChunkManager in-place swaps** — `setMap()` and `setTerrainDefinitions()`
  so consumers stop dispose-and-recreate: the editor does this dance in three
  places (`replaceMap`, `rebuildTerrainFromDescriptors`, `loadAndApplyHexPack` in
  `src/scene.ts`).
- [ ] **Paired road-edge helper** — `setRoadEdge(col, row, edge, state)` that sets
  both half-edges and reports both dirty cells; the pairing invariant currently
  lives in the editor's `RoadPaintStrokeCommand` and is easy for consumers to get
  wrong.
- [ ] **`HexWorld` façade** — batteries-included entry class extracted from the
  editor's `initScene()` (`src/scene.ts:41-365`): renderer, lighting, camera
  controller, chunk wiring, animate loop, with the à-la-carte API unchanged
  underneath. `initScene` is the spec; the quick start should drop from ~40 lines
  to ~5.

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

- [ ] **Liquid painting palette** — lava/acid/custom liquids in the editor terrain
  palette (the editor currently ships only `DEFAULT_LIQUID_DESCRIPTORS`), including
  save/load of custom liquid descriptors.
- [ ] **Liquid appearance editing** — the Part 2 descriptor fields (opacity, flow
  speed, emissive, waveScale, foamIntensity) exist; expose them in the editor UI
  so packs carry the look.
- [ ] **Confluence-aware river tool** — the editor's river paint/undo
  (`src/commands.ts` RiverPaintStrokeCommand) snapshots a single incoming
  direction; update it to snapshot/restore the full incoming mask
  (`getIncomingRiverMask`) and use `removeRiverIncoming`/`removeRiverOutgoing`
  for partial detaches.
