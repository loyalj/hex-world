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
- [x] **Sky system** *(2026-08-03)* — `SkyDome` draws a zenith→horizon→ground
  gradient with a sun/moon glow and a hash-based night star field, and pairs it
  with matching distance haze (`ATMOSPHERE_GLSL` / `configureAtmosphere`) in the
  terrain, road, and all six liquid shaders, so the map edge dissolves into the
  same color the sky shows at the horizon. Haze is measured in *ground* (XZ)
  distance, one measure for every material, so there is no seam at a shoreline
  and a far peak hazes as much as the valley beside it. `DayNightCycle` now
  splits its sky into `skyHorizon`/`skyZenith` (`skyColor` stays the horizon,
  so background-only scenes are unchanged) and drives the dome via a new `sky`
  target; `WeatherSystem` exposes an `overcast` factor (0 clear / 0.85 rain /
  0.7 snow, scaled by intensity) that flattens the gradient toward grey, dims
  the haze with it, and puts out the sun and stars. The horizon leans toward
  `averageTerrainColor` of the terrain palette for the biome match, faded out
  by daylight so a midnight horizon stays dark. Stock three materials (scatter,
  unit models) get the identical haze via `attachAtmosphere`, **not**
  `scene.fog` — three fogs before tone mapping and the output-colorspace
  conversion while this library's shaders write raw, so the same haze color
  lands far brighter on a tree than on the hill behind it (tried it; distant
  trees glowed pale white over a dark hillside). The injected mix runs after
  `<colorspace_fragment>` so both sides reach exactly `uAtmoColor`. HexWorld:
  `sky: true` / `setSky(...)`, re-derived on terrain swaps, scatter materials
  auto-attached. Demo: `[K]`.
- [x] **God rays / crepuscular shafts** *(2026-08-08)* — `GodRays`: the scene is
  re-rendered at a quarter resolution with every material overridden to flat
  black on a white clear, giving a mask of where the sky is open, and a
  full-screen quad then marches that mask from each pixel toward the sun's
  screen point with a per-step decay and adds the result to the frame.
  **Deliberately not a composer.** The main render never goes through a target,
  so the renderer's MSAA survives and nothing re-encodes an already-final image
  — the same colour-space trap `attachAtmosphere` exists to dodge, and the
  reason the composer item below stayed open. Call it straight after
  `renderer.render(scene, camera)`.
  It is a sink like the dome, and takes `sunDir` rather than `lightDir`: the
  moon is the active light after dark, and pointing the shafts at it would fan
  them out of the wrong side of the sky. The gates it shares with the
  atmosphere are `daylight` (these *are* scattered light) and
  `1 - overcast * 0.92`, read straight off the attached `SkyDome` so weather
  reaches them with nothing wired. Sun height it shares only at the *bottom* —
  the same `-0.05` cutoff as the dome's disc, since below the horizon the world
  is in the way — but it reaches full by `0.02` rather than the dome's `0.1`,
  because `daylight` is already a ramp over sun height and applying both would
  square it, dimming the rays to nothing across exactly the dawn and dusk hours
  they belong to. Two more gates are the pass's own, both fades rather than
  pops: the projection mirrors behind the camera, and a pitched RTS camera
  looks *down*, so the sun spends most of the day above the top edge — the
  off-frame fade therefore runs out to ~3× the frame, which is cheap in
  artifacts because `decay` already weights the clamped off-screen tail least.
  With the gate shut the whole pass is skipped, which is most of the clock.
  `intensity` means "brightness added at the sun" — the gain is divided by
  Σ decay^i, so changing `decay` (how far the shafts throw) or `samples` (the
  one real cost knob) doesn't silently rescale it. Ray colour follows the sun's
  own, so dawn shafts go orange with the light. The dome is excluded from the
  occlusion pass — it is the light, not an obstacle — and `exclude()` takes
  particles and overlays. HexWorld: `godRays: true` / `setGodRays(...)`.
  Demo: `[X]`, plus `[Y]` to swing to the sun and drop to the shallowest tilt.
  Editor: View ▸ God rays, on by default.
  **This shipped invisible, and the reason was the camera, not the pass.**
  `RtsCameraController` had no yaw, so the view axis was always −Z, while
  `DayNightCycle`'s arc tilts 30° toward +Z: sweeping all 1440 minutes, the
  closest the sun ever came to the view axis while it was up was *exactly 90°*,
  and the measured strength was 0.0000 at every minute at every pitch. The
  30° pitch floor was the second wall — with a 45° vertical FOV the top of the
  frame sat 7.5° *below* horizontal, so no sky reached the screen at all. Both
  are fixed under "Camera can look at the sky" below; the same sweep now peaks
  at 0.995 an hour after sunrise. Lesson worth keeping: before tuning a
  screen-space effect, check the set of directions the camera can be pointed
  at — no constant in the shader can fix a sun that is never on screen.
- [x] **Map skirt — the map as a solid, not a surface** *(2026-08-08)* —
  `MapSkirt` + `MapSkirtCore` + `SkirtMaterial`: a wall of cut earth around the
  map's perimeter, top following the terrain's own contour, base one flat floor
  under everything. Fell straight out of the camera work above — the moment the
  tilt floor let the horizon into frame, the first thing on screen was daylight
  under the map's edges.
  Seam-tightness is the whole problem, and it is solved by *sharing* rather
  than approximating: the terrain's vertex perturbation is a pure function of
  world XZ, so calling the same function with the same options puts the skirt's
  top vertices exactly where the terrain's edge vertices already are. **The
  first cut shipped with the seam torn open**, because "the same options" were
  hand-copied defaults and one had drifted — `noiseScale` 0.06 against the
  terrain's 0.35, which is not a near miss but a different noise field
  entirely. The four options that decide where a vertex lands are now
  `CHUNK_GEOMETRY_DEFAULTS`, exported from HexChunkCore and *imported* here, and
  a test builds real terrain and a real skirt from one map and requires the
  inner ring to be coincident with terrain vertices rather than close to them.
  Every default that has to agree across two builders should be shared this way;
  a comment saying "must match" is not a mechanism. It
  follows the five-point polyline the boundary fan actually emits, not the two
  endpoints — every one of those points is perturbed independently, so the
  midpoints do *not* lie on the line between the ends and a two-point wall
  would gap. `HexWorld` forwards its own `geometryOptions`, since a mismatch
  tears the seam along the entire edge rather than showing up as anything
  subtle. The strip from the terrain's inset ring out to the full hex edge is
  capped with a flat lip at ground height, so the cut reads as ground
  continuing to the very rim.
  The floor is derived from the elevation *range* plus exact worst-case bounds
  (elevation jitter, carved river beds) rather than by sampling cells, so no
  cell whose noise happened to dip further can poke through. Strata key off
  **world Y**, never a per-face coordinate: that is what carries a layer's
  level around every corner and makes four walls read as one block instead of
  four painted panels. Bands pick colours by hash rather than gradient (real
  bedding puts pale silt straight onto dark loam), with a dark topsoil line
  under the turf. It borrows the terrain's `uLightDir`/`uLightColor`/`uAmbient`
  so it darkens at dusk with the ground it holds up — `DayNightTargets` gained
  a general `lightMaterials` for exactly this — and carries the shared
  atmosphere haze, being the surface that most needs to dissolve into the
  horizon rather than end against it.
  **Corner seals** close the last hole. Three cells meet at every hex corner;
  where one is off the map the terrain skips the corner fill that would have
  joined the other two, and a flat per-face lip leaves an open wedge between
  two rim cells of different elevation — sky, straight through the block. Each
  wedge is bridged by a fan from the shared corner across the open end of the
  bridge between the two cells, a vertical riser at that corner (which
  genuinely exists at *both* heights, one per lip, and so takes a horizontal
  normal — shading it as ground lights a wall like a floor and leaves its
  winding undecidable), and soil down to the floor beneath as a backstop.
  The fan **traces the terrain's terrace profile**, and has to: a terraced
  slope is a staircase, and a straight line across it passes under every tread,
  which is the sky showing through between the steps. `TERRACE_STEPS`,
  `terraceFactors`, and `edgeTypeOf` are exported from HexChunkCore and shared
  the same way the geometry defaults are — the interpolation is deliberately
  *not* linear (`v` advances on every other step, which is what makes a tread
  flat) and would have been impossible to guess. Flat and cliff edges really
  are straight, so those stay two points. Sealing only the *starting* corner of each boundary
  face visits every wedge exactly once — verified by counting, since twice
  would z-fight and never would leave the hole.
  Triangle winding is now enforced against the normal inside the emitter rather
  than ordered by hand. Hex corner order is not obvious enough to reason about:
  the lip and the wall were both inside-out on the first attempt, and the
  corner riser was degenerate on the second.
  The top follows the **ground** even under water, so a coast is cut honestly:
  soil to the sea bed, then the water's own cross-section above it (`waterCut`,
  on by default — without it every coastline keeps an open slot between bed and
  surface). Water is identified by **terrain index**, the way the liquid
  builders do it, not by the cell's `FLAG_WATER`: the first cut used the flag
  and the band never fired on a real map, leaving exactly the slot it exists to
  close. `waterTerrains` takes a custom liquid palette. Only the perimeter is built — `O(width + height)` — so it is recut
  outright on every edit rather than needing chunk machinery.
  *Known gap, left open deliberately:* a river running off the map edge carves
  below the cell top while the wall's top is flat across the face, so a river
  mouth exactly on the rim leaves a small notch. Closing it means mirroring
  HexChunkCore's river branch here, which is the duplication that has already
  bitten the waterfall code. `HexWorld`: `skirt: true` / `setSkirt(...)`.
  Demo: `[I]`. Editor: View ▸ Map skirt, on by default.
- [x] **Camera can look at the sky** *(2026-08-08)* — `RtsCameraController`
  gains **yaw**: the camera now swings around its target instead of being
  welded to the +Z side looking down −Z. Middle-drag became one two-axis
  gesture (up/down tilts, left/right turns), and `rotateTo` / `rotateBy` /
  `tiltTo` drive it from code — `rotateTo` takes the short way round, so 170°
  to −170° is a 20° swing and not a 340° unwind, while `rotateBy` accumulates
  past a full turn because that is what a "spin the view" binding wants. Yaw
  is unclamped; a compass has no ends. At yaw 0 the placement math reduces
  exactly to what it was, so every existing scene is untouched — there is a
  regression test pinning that.
  The **pitch floor drops from 30° to 6°** (`RtsCameraController`, `HexWorld`,
  demo, editor). Above roughly half the vertical FOV the horizon never enters
  the frame, which is a silent, total ceiling on every sky feature the library
  has: the dome, the star field, sunrise and sunset colour, and the god rays
  were all drawing things the camera was structurally unable to look at.
  Panning degrades gracefully rather than breaking — `groundHit` simply
  returns null for rays aimed above the horizon, so a drag that starts on sky
  is a no-op instead of a lurch. Demo: middle-drag, `[Y]` to face the sun.
  Both constraints are then **runtime-settable**, so the extra freedom is a
  choice rather than something imposed on every project: `setPitchLimits` and
  `setYawEnabled`. Tightening the limits glides the current angle back inside
  them instead of snapping, and locking the heading swings it to rest (0) the
  short way — from 350° it goes forward 10° to 360, not back the way it came —
  then makes the drag gesture and both rotate calls no-ops, so a fixed-heading
  mode cannot be nudged out of alignment. The library deliberately ships the
  mechanism and no named modes: which limits count as "RTS" is a question
  about the game, not about the camera. Editor: **View ▸ Camera ▸ RTS / Free**,
  a radio pair whose presets (`rts` 30–66° heading-locked, `free` 6–80° free
  look) live next to the UI that offers them; opens in Free.
- [x] **River channel polish** *(2026-08-03, from visual review)* — waterfall
  water now actually renders on the cliff face (notched backstop wall +
  groove-hugging sheet welded to the downstream channel); channel walls flare
  outward (`riverBankFlare`, default 1.3, hard ceiling ~1.4); carved bed faces
  blend to a new riverbed terrain (sandy tan + grey gravel, index 6,
  auto-resolved by descriptor id `riverbed`); rivers routed uphill hold a
  level surface and carve a gorge (`computeRiverElevations` running-min)
  instead of climbing as a floating plane.
- [x] **Waterfall polish** *(2026-08-03)* — every cliff-edge river now carries a
  GPU-animated spray cloud (`buildWaterfallSprayGeometry` +
  `createWaterfallSprayMaterial`: a plume arcing off the impact point plus a
  thinner veil drifting down the sheet) and a churning plunge pool welded to the
  receiving channel — all motion in the vertex shader, one uniform write per
  frame regardless of how many falls are on screen. `findWaterfalls` derives
  both from the same ownership filter, flow widths, and carved elevations as
  `buildRiverGeometry`, so they land exactly where the sheet does and stream in
  and out with their chunk. Falls inherit the liquid's foam color, flow speed,
  and emissive by default, then tune through the descriptor: `sprayIntensity`,
  `sprayColor`, `sprayArc`, `sprayRise`, `sprayDrift`, `spraySize`,
  `poolScale`. `sprayArc` is the axis that matters — 0 is mist (climbs, frays
  on turbulence, swells and thins, never falls back), 1 is spatter (ballistic
  arc that peaks and lands, flying outward, holding size and opacity). Water
  and acid mist; the built-in lava throws sparse ember-lit droplets.
- [x] **Seasons and snow accumulation** *(2026-08-05)* — `ClimateData` +
  `SeasonCycle`. The generator's temperature field is no longer discarded
  (`MapGeneratorConfig.climateData`); it lands in a map-sized RGBA `DataTexture`
  (R base temperature, G moisture, B snow depth, A season-adjusted temperature)
  that every material samples through the `cellIndex` attribute the fog of war
  already put on all geometry. `SeasonCycle` is a 0–1 year clock shaped like
  `DayNightCycle` (0 = midwinter, 0.5 = midsummer; `advance`/`advanceDays`/
  `setPhase`), whose per-cell pass biases temperature by a latitude-scaled
  seasonal swing — poles swing hard, the equator barely moves, so the snowline
  *descends the map* instead of the world fading white at once. Elevation
  cooling is already in the field, so peaks keep year-round caps for free.
  Snow is CPU-owned and eased (`accumulationRate`/`meltRate`), which is what
  keeps `climate.snowDepth(col, row)` and the white pixels the same number —
  gameplay and rendering cannot drift. Ice is *not* stored: each liquid derives
  it in-shader from its own `LiquidTypeDescriptor.freezePoint` (water 0.12;
  lava and acid never freeze), so one map can hold liquids that freeze at
  different colds. Renders across terrain (slope-masked, noise-frayed snowline
  sampling the pack's `snow` terrain slice), all six liquid layers (still
  water, dead surf, ice color and opacity via `liquidOutput`), frozen
  waterfalls whose spray *hangs* as suspended crystals rather than vanishing,
  and scatter (`attachSnow` patches stock materials at `<color_fragment>` so
  caps are lit and shadowed, composing with `attachAtmosphere` either way).
  Precipitation is gated on the snow channel and its inverse, so snow falls
  exactly where snow lies and rain everywhere else. Persistence stores the
  ~50-byte `temperatureOptions` and rebuilds the dense field on load, RLE-ing
  only the seasonal tier. `HexWorld`: `seasons` option, `world.seasons` /
  `world.climate`, `setSeasons` / `setSeason`, re-derived on terrain swaps.
  Demo: `[V]` play/pause, `[[` / `]]` scrub. *The Long Migration's antagonist
  mechanic.*
- [x] **Season scope — continental vs. whole-map** *(2026-08-08)* —
  `SeasonOptions.scope`. The latitude-and-elevation model is what makes a
  subcontinent feel like one, but on a valley a snowline creeping across the
  view reads as a bug rather than as scale. `'local'` inverts which term
  dominates: `effective = localSummer − localAmplitude · winter + (base − 0.5) ·
  localVariation`, so the map's own temperature field stops being *the* climate
  and becomes a small stagger on when each cell turns. Every cell crosses every
  threshold within a few days of the rest — by midwinter all foliage is bare and
  the whole map is under snow, by spring all of it blooms — while the high
  ground still leads by a little, because elevation cooling survives in the
  stagger. Defaults are chosen so the swing clears every threshold downstream
  (`bareTemp` 0.26, `snowThreshold` 0.22, water's `freezePoint` 0.12) and the
  stagger stays narrower than the swing, or "a hard winter strips every tree"
  stops being true. Nothing downstream changed: scope only decides what gets
  written into the two seasonal bytes every material already samples — it even
  works on a map with no temperature field at all, which continental scope
  cannot. Fixed alongside: `setSeasons` rebuilds the cycle, and was resetting
  the year to spring on every restyle; phase, paused and daysPerYear now carry
  across unless the call names them. Demo: `[J]`. Editor: a Continental /
  Whole map control in the Environment panel.
- [x] **Seasonal foliage colour, and two new scatter types** *(2026-08-08)* —
  the climate texture's A channel was already sampled by every material for the
  freeze test; `attachSeasonalTint` reads the same byte to swing grass and
  deciduous plants through spring green → summer → autumn gold → bare. Per cell,
  not globally: cold uplands turn while the valley below is still green and the
  tropics never turn at all, for the same reason the snowline descends the map.
  Temperature alone can't tell spring from autumn — they pass through identical
  values in opposite directions — so a single global `uFoliageWarming`
  (`seasonWarming(phase)`, a sine so nothing pops at the solstices) picks which
  mid-season colour the turn passes through, and it is the only non-per-cell
  input. The palette names four absolute colours but applies them as a *ratio*
  against the surface's own authored green, which makes midsummer exactly a
  no-op instead of a wash and carries every texel's variation through the turn.
  Which parts of a mesh are foliage is read off its own colours (the green ones)
  rather than demanded as a second material or a vertex mask, so one merged
  trunk-and-canopy tree works, and so does a terrain shader over grass, rock and
  sand — the mask is measured on the *summer* colour so it holds all year.
  Individual plants stray from the shared autumn hue by a hash seeded from the
  instance origin, so a wood doesn't read as one decal; ground cover doesn't,
  because it would only mottle. **Spring blossom** rides the same seed: a
  configurable share of plants flower somewhere between two petal colors (pink
  and blue by default) as the turn passes back through the middle, gated on
  `uFoliageWarming` so autumn's identical temperatures stay flowerless. It
  mixes *over* the turned canopy rather than joining the palette — petals cover
  a tree, they don't recolor it, and green can't reach pink through a ratio
  without running past its clamp. Blossom defaults on in `attachSeasonalTint`
  and off in the shared uniforms, which is what keeps hillsides from flowering.
  Tuned from screenshots afterwards: petals stop at 0.7 coverage so canopy shows
  through and a bloom reads as petals *on* a tree; the cool end of the range
  moved from blue to lilac, since a pure blue blossom sits too close in value to
  pale rock and hazy distance and reads as stone. Ground cover took its own
  palette — straw then dun, against the canopy's gold then bare — because a
  hillside going as orange as a wood reads as the map being recolored rather
  than as a season; `HexWorldSeasonOptions.terrainFoliage` layers over `foliage`
  to tune the two apart. Rock scatter got two densities instead of one in both
  generators: a single level draws a single tier, so every boulder on a map came
  out the same size at the same spacing, and the editor's rocks moved to
  `createRockMaterial` for per-instance squash. Which plants turn is one call per material, and
  that call *is* the difference between species: a broadleaf gets the tint and a
  pine doesn't. Snow and tint compose in a fixed order (tint, then snow —
  frost lies on gold leaves, not under them) however they were attached, via a
  shared `SEASON_COLOR_SLOT` marker, and share one climate binding by identity
  so `configureSeason` reaches both and neither ends up bound to nothing.
  New scatter: `createBroadleafGeometry` (vertex-coloured trunk + crown in one
  instanced draw) and `createBushGeometry` (low scrub, `select: 0` since it's
  foliage all the way down), alongside `createPineGeometry`. Generators fill two
  more feature layers when the map has them — broadleaf woods in the warm wet
  bands, scrub where the canopy gives out — and two-layer maps are untouched.
  Fixed on the way: scatter layers past the third took their spawn hash as an
  *offset* of channel A, which stays ordered against it, so layer 3 beat layer 0
  for 85% of slots instead of mixing; they now take a fresh stream from
  `HexHashGrid.channel`. Editor: four scatter brushes (Pines / Broadleaf /
  Bushes / Rocks), four inspector rows, and new maps built with four feature
  layers. Maps saved with the old two-layer count simply don't carry the new
  brushes — deliberately not migrated, since nothing shipped depends on them.
- [x] **Day/night cycle** *(2026-08-03)* — `DayNightCycle`: a 0–1 world clock
  mapped to a tilted sun/moon arc (one directional light plays both roles,
  swapping at the horizon where both intensities are zero), warm dawn/dusk
  tinting, cool moonlight mode, and a sky color that tracks time of day.
  Liquids gained a `uLightTint` uniform so water darkens at night while
  emissive (lava/acid) glow is exempt and carries the scene. Noon reproduces
  the static default lighting exactly. `HexWorld`: `dayNight` option +
  `setTimeOfDay`; `world.dayNight` exposes the cycle (the future seasons
  feature should share this clock). Demo: `[N]` play/pause, `[,]/[.]` scrub.
- [x] **Weather effects** *(2026-08-03)* — `WeatherSystem` + `PrecipitationLayer`
  + cloud shadows in the terrain shader. One world-space cloud noise field is
  shared by the terrain (drifting shadows attenuating the direct sun term) and
  the precipitation gate, so rain/snow falls under the denser cloud cores and
  moves with them while lighter clouds are just clouds (`precipCoverage` vs
  `coverage`). Particles are world-anchored (wrap-around volume follows the
  camera target, but each drop stays pinned over its hexes) — rain as
  line-segment streaks along the fall velocity, snow as swaying soft points;
  intensity ramps via drawRange. A per-cell mask hook (`setMask`) awaits the
  seasons/temperature layer. `HexWorld.setWeather('rain' | 'snow' | 'clear')`.
  Demo: `[M]` cycle. *(2026-08-08)* `clear` used to mean *cloudless*, which read
  as a bug in practice: scenes opened under a flat, shadowless sun and only
  gained drifting shadows once someone cycled through rain and back. It now
  means *no precipitation* — scattered fair-weather cover (lighter and slower
  than a storm deck, overcast still 0 so the sky stays blue), with
  `clouds: false` as the opt-in for an empty sky. The constructor pushes that
  initial state to the materials too, so a `WeatherSystem` looks like the
  `clear` it already reported before anyone calls `setWeather`.
- [x] **Shadow support** *(2026-08-03)* — `SunShadowRig`: a shadow-casting
  directional sun whose ortho frustum re-fits the camera's ground footprint
  every frame (clamped to `maxDistance`, texel-snapped in light space so
  panning doesn't shimmer), which is what makes it play well with chunk
  streaming. The terrain shader consumes three's shadow chunks
  (`lights: true` + `getShadowMask()`) attenuating only the direct sun term;
  terrain and scatter cast + receive, units cast. `HexWorld` opt-in via
  `shadows: true | SunShadowOptions`; `setSunDirection` updates rig + terrain
  light in one call (ready to track day/night). Demo: `[O]`.
- [x] **Roads join the lighting model** *(2026-08-05, from visual review)* — the
  road overlay was unlit: it stayed bright at midnight and cloud shadows slid
  over it without dimming it. `createRoadMaterial` now runs the terrain's
  lighting model under the terrain's own uniform names (`uLightDir` /
  `uLightColor` / `uAmbient`, plus `RoadMaterialOptions` so à-la-carte scenes
  can match the ground), samples the shared cloud field, and consumes three's
  shadow chunks (road meshes receive but don't cast — they lie flush on the
  ground). `DayNightTargets.roadMaterial` and `WeatherSystem`'s `roadMaterial`
  option carry the state; `HexWorld` wires both automatically and builds the
  road material from `terrainMaterialOptions`. Roads use the terrain normal
  flipped to the upper hemisphere rather than `gl_FrontFacing`, since a decal
  never lies on an overhang.
- [x] **Baked ambient occlusion for cliff definition** *(2026-08-08)* — cliff
  shading is static-geometry AO, so it is computed where the height field
  already lives rather than in a screen-space pass: `buildChunkArrays` bakes a
  per-vertex `occlusion` attribute from each vertex's drop below the tallest
  surface in its cell's 7-cell neighbourhood, and terrain + road shaders
  attenuate **only their ambient term** with it — the same direct/ambient split
  sun shadows use, so a lit cliff face keeps its full sun term and the effect
  reaches full strength in shade, where ambient is all the light there is.
  Running it as a post-pass over finished positions (rather than threading it
  through the vertex emitters) means every branch — flat fans, terrace steps,
  cliff walls, carved channels, junction basins, road strips — gets occlusion
  from one code path. `ChunkGeometryOptions.ambientOcclusion` takes
  `false | true | { strength, range }`, defaults on, and travels to the chunk
  worker; geometry built without the attribute reads 0 = fully open, so
  à-la-carte scenes are unaffected. Costs ~9% of chunk build time (off-thread
  with `chunkWorker: true`) and nothing per frame.
  This **replaced** a pre-existing AO term that folded occlusion into the vertex
  colors: in the default `splat` color mode those colors *are* the blend
  weights, and the fragment shader normalizes by their sum, so the factor
  divided straight back out — the map had been rendering with no AO at all. It
  also only ever ran on flat interior fans, never the cliff faces it was for.
- [x] **Cliff strata** *(2026-08-08)* — the terrain shader already projects
  triplanar, so a vertical face has never taken the flat ground's XZ projection;
  what it lacked was *structure*. Grain tells you a wall is rock, but only
  layering tells you how tall it is, and a carved gorge with no bedding reads as
  a dark wall rather than as depth. `cliffStrata` bands the surface color along
  world height: a per-bed value and colour draw plus a hairline dark seam at each
  bedding plane, which is the part the eye actually counts. Because the bands are
  a function of world position and nothing else, they run **continuous across
  cells** — a canyon cut through six hexes reads as one cut through one rock
  instead of as six adjacent walls — and they pick out every terrace step for
  free.
  The parts that took thought:
  **Beds are neither level nor evenly spaced.** A regional dip (`tilt`) plus a
  low-frequency warp keeps two unrelated cliffs from sharing a stripe at the same
  altitude, which is the tell that gives a decal away; and the band coordinate is
  bent by two sines *before* it is quantized, so thickness varies without a
  per-bed table. The amplitudes are picked to keep that bend's derivative
  positive (min ≈ 0.41) — a fold would run `floor()` backwards and mirror a bed
  into the middle of the sequence.
  **The derivative is taken before the branches.** `fwidth` is undefined under
  non-uniform control flow, and the early-outs (flat ground, green surfaces,
  too-distant) diverge along exactly the cliff silhouette and the grass line —
  the two edges where a garbage derivative would be most visible. Band
  coordinate and `fwidth` are therefore computed unconditionally at the top, and
  everything else branches after. That derivative does double duty: it widens
  the seam into a soft gradient at distance instead of a moiré, and fades the
  whole pattern out once a bed is under a pixel, so a far cliff stops crawling
  as the camera moves.
  **It knows rock from grass the way the foliage tint knows leaves** — by the
  surface's own relative green — but with a *local* copy of that test rather
  than a call to `foliageMask`, because that one is switched off by
  `uFoliageSelect: 0` for a mesh that is foliage all over, and strata must not
  follow it into deciding rock is a leaf. Bedding goes on before the seasonal
  turn and before snow: snow lies on the bands, it is not banded itself.
  On by default, unlike the grid and the seasons — it is a property of rock
  rather than a mode to opt into, and it needs no data the material doesn't
  already carry. `configureCliffStrata` / `setCliffStrataEnabled` /
  `HexWorld.setCliffStrata`, plus `TerrainMaterialOptions.strata` so a `.hexpack`
  ships the bedding that matches its rock. The triplanar blend exponent became
  `TerrainMaterialOptions.triplanarSharpness` at its existing value of 8 (clamped
  to ≥1: `pow(0, 0)` on an axis-aligned face is NaN pixels, not a soft blend),
  which is the one lever that side of it was missing. Demo: `[B]`.
- [x] **Scatter texture** *(2026-08-09)* — the terrain shader puts real texture
  on the ground (triplanar samples, splat blending, bedding on the cliffs) and a
  tree standing in it was a handful of large facets of one flat green. The
  mismatch, not the plant, is what read as plastic — and the bigger the canopy
  facet the worse it got. `attachScatterTexture` multiplies fine procedural
  value noise into `diffuseColor` on a scale finer than a facet, so each flat
  plane stops being perfectly uniform while its edges stay exactly as crisp.
  Explicitly *not* an attempt to soften the faceting: the low-poly silhouette is
  the look, and this only touches the colour inside it.
  The parts that took thought:
  **The noise coordinate is the raw `position` attribute, not `transformed`.**
  `transformed` is what wind sway bends, so sampling it would drag the mottling
  across the canopy every time the plant leaned — a texture that swims over a
  surface reads as a shader bug even when the motion is small. `position` never
  moves. The instance *origin* is added to decorrelate one plant from the next,
  but not the full instance matrix: rotating the pattern with the tree costs a
  matrix multiply to achieve something nobody can see.
  **`fwidth` before the branch, and a fade under a pixel.** Same lesson the
  cliff strata learned: derivatives are undefined under non-uniform control
  flow, so the derivative is taken unconditionally at the top and everything
  else branches after. The fade matters more here than it did there, because a
  sub-pixel noise does not average into a tint — it crawls as the camera moves,
  and a whole forest of crawling trees is far worse than a flat one.
  **Multiplicative, and before the season slot.** Multiplying preserves hue,
  survives the tint recolouring underneath it, and is exactly a no-op at
  strength 0; an additive term would wash a dark trunk and a bright canopy by
  the same absolute amount and grey both. Landing before `SEASON_COLOR_SLOT`
  puts it under both seasonal effects however they were attached — the foliage
  tint recolours a mottled surface rather than flattening it, and snow settles
  on top, which is what snow does to a texture. There is a test that scrambles
  the attach order and asserts the composed ordering anyway.
  Needs no data and no per-frame driver — unlike every other attach here it is
  inert-or-on from the moment it is called. Scale is authored per material
  against *facet* size rather than plant size (pine 5, broadleaf 6, rock 9, bush
  11). Demo: `[P]`; the editor gets a strength slider under Environment.
- [x] **Wind system** *(2026-08-08)* — `WeatherSystem` already owned a wind
  vector, but only the clouds and the rain could see it, and nothing on the
  ground moved at all. `Wind` promotes it to a property of the world: one
  vector, advanced once a frame, that the cloud deck drifts by, the rain slants
  and streaks along, the ripple pattern marches across open water with, and
  every plant bends downwind to. `HexWorld` owns one eagerly and hands it to the
  `WeatherSystem` it builds, so `setWind` and `setWeather` compose in either
  order and the two can never disagree about which way the weather is going.
  `setMaterialWind` fans it out over a mixed material list in one pass, skipping
  whatever carries neither uniform family — the same shape as
  `setAtmosphereColor`.
  The parts that took thought:
  **The gust travels.** A scalar multiplier on the whole world is the tell that
  gives a wind away — every tree leans at the same instant, which reads as one
  animated object. Instead the sway phase is offset by the plant's own position
  *projected onto the wind direction*, so the surge crosses a wood tree by tree
  at a rate `waveLength` sets. It is one `dot` in the vertex shader and it is
  most of what makes the effect work.
  **Sustained and surface wind are different things.** `base` is what the cloud
  deck drifts by; `surface` is `base` swung in speed by `gustiness` and in
  direction by `turbulence`, and it is what the rain and the plants follow. A
  whole overcast deck does not surge in a two-second gust — the hedge under it
  does — and having both available is what lets each consumer take the one that
  is true of it. Gust and wander ride *different* rates, too: a squall that
  always veers as it strengthens reads as a single moving object.
  **Phase is integrated, not `time × speed`.** Recovering it in the shader from
  a shared clock times a changing rate rewinds the wave every time the wind
  picks up, which reads as the trees briefly swaying backwards. The same
  reasoning that keeps the cloud offset and the water drift on the CPU — and
  the same reason the ice code damps the wave rather than scaling `uTime`. The
  phase wraps on a whole multiple of 2π so an overnight session keeps float
  precision without a discontinuity at the seam.
  **The wind is pulled into object space, not the vertex into world space.**
  `transformed` is bent after `<begin_vertex>`, which means the bend has to
  happen in the space the vertex is already in; a scatter instance carries a
  random Y rotation, so the world wind comes back through its basis as
  `v * mat3(modelMatrix * instanceMatrix)` — the transpose, which for a rotation
  is the inverse, and which avoids an `inverse()` the GLSL1 path doesn't have.
  Being ahead of `<project_vertex>` also means a swaying tree carries its haze
  and its snow with it. The bend is biased downwind rather than centred (wind
  pushes one way) and the tip drops by the sagitta, or a leaning tree grows
  taller than the still one beside it.
  **Which plants bend is not the renderer's call.** `attachWindSway` is opt-in
  per material, exactly as `attachSeasonalTint` is — `HexWorld.setWind` drives
  every material carrying the patch and applies it to none, so a boulder stays
  put. `amplitude` is tip displacement as a *fraction of plant height*, so it
  means the same thing on a seedling and an oak. Its own `uSwayEnabled` gate
  rather than a zeroed amplitude, so disabling survives the per-frame push and
  a stopped plant stands upright instead of freezing mid-lean.
  **A river ignores the wind.** Open water takes a `uWindDrift` offset (so the
  ripple pattern marches downwind) and a `uWindChop` factor (so it roughens, and
  onshore wind thickens the surf), but the river and estuary shaders sample
  neither: their direction is the channel's, and a gust must never run a stream
  backwards uphill. Shore foam takes chop and not drift for the matching reason
  — the surf band is anchored to the beach it breaks on. Both uniforms are zero
  until a wind drives them, so a scene without one is untouched.
  **Gusting exposed a latent bug in the precipitation drift.** The particle
  shader positioned the field at `position.xz + uWind * uTime`, which is exact
  while the wind is constant and wrong the moment it isn't: the field jumps by
  (change in wind) × (elapsed time), so a gust a minute into a session
  displaces the whole sky sideways, and the error grows without bound as
  `uTime` does. It is the same trap the cloud offset, the sway phase and the
  water drift were all already avoiding, and nothing had caught it because
  before this the wind never moved. Drift is now integrated on the CPU into a
  `uWindOffset` uniform and wrapped on the volume period (invisible, since the
  shader folds the field into `uArea` anyway); `uWind` stays live and is read
  only to aim the rain streak, which is a direction and so is correct
  instantaneous.
  **Tuning, after looking at it.** Three numbers came down from where they were
  first set: precipitation takes a tenth of the wind (`windResponse`, an option
  rather than a constant, because it is the one that most wants overriding —
  rain is already moving several times faster than the air and is only airborne
  a second or two, so the full ground wind slants it like a gale and makes every
  gust read as the camera lurching); sway amplitudes came down ~30%, since past
  roughly a tenth of a plant's height a bend stops reading as wind and starts
  reading as rubber; and the water chop term came down to a fifth, because it
  rides on the highlight that is already the brightest thing on the surface and
  gets to "choppier" long before it gets to "turned up". The water *drift* came
  down hardest of all, from 0.15 to 0.02, and that one was closer to a mistake
  than a taste call: the drift is added to `worldXZ` **before** the shader's
  `* 4.5` frequency multiplier, so one world unit of it carries the pattern
  across four and a half noise features. At 0.15 a lake was marching at eleven
  times its own wave animation — rapids, not a breeze — and it was worst at
  exactly the low wind speeds that should have looked calm. The test on it
  reads both constants off the real shader and asserts the derived rate stays
  under the water's own, rather than pinning the number. Every chop factor is
  written `1.0 + k · chop` so that windless scenes stay bit-identical whatever
  `k` becomes — there is a test on that shape rather than on the constants.
  The one behaviour change: rain now gusts by default, because the wind advances
  from the first frame whether or not `setWind` has been called. `setWind` gates
  only the push out to the materials. Demo: `[W]` toggle, `[Q]` veer.
- [ ] **Post-processing integration** — an optional composer in `HexWorld` for
  **selective bloom on emissive liquids** (lava, acid). Threshold bloom is the
  wrong tool: the library's shaders write final LDR color straight to
  `gl_FragColor` with no HDR stage, so nothing exceeds 1.0 and a luminance
  threshold would bloom sunlit snow and water specular as eagerly as lava.
  Instead put emissive liquid meshes (plus their waterfall foam and spray) on a
  dedicated `THREE.Layers` channel, render that channel alone to a half-res
  target, blur, and additive-composite — which also sidesteps the color-space
  problem entirely, since no `OutputPass` is involved and nothing re-encodes an
  already-final image. `emissiveStrength > 0` on the liquid descriptor is the
  trigger. Needs `WebGLRenderTarget({ samples: 4 })` or routing through a
  composer silently loses the renderer's MSAA, and
  `external: [/^three(\/|$)/]` in the vite config so `three/addons` stays a peer
  import instead of being bundled. Keep it opt-in so the à-la-carte path stays
  composer-free.
  *Narrowed:* the god rays above wanted a composer too and did without one —
  an extra pass rendered to its own target and added over the finished frame
  costs no MSAA and re-encodes nothing. Selective bloom is the same shape (a
  layer rendered small, blurred, additively composited), so this item is now
  only about the emissive-liquid case, and it may not need a composer either.
  *Dropped from the original scope:* SSAO (superseded by the baked AO above —
  screen-space cannot beat exact knowledge of a static height field) and the
  unit selection outline pass (deferred with the selection API it would need).

### Gameplay layers

- [x] **Fog-of-war memory tiers** *(2026-08-05)* — the two tiers are now split at
  the API, not just in the texture channels: `isVisible` / `isExplored` /
  `visibilityCount` / `exploredCount` read them apart, and `markExplored` adds
  memory without granting sight (scripted reveals, map fragments). Units are the
  ghost state's payoff — `UnitManager` hides any unit standing on an explored but
  currently-unseen cell (`hideUnitsInFog`, default on), which only ever hides
  units that grant no vision, since anything with `fogRevealRange > 0` sees its
  own hex. Persistence is a **companion blob**, not a map field: exploration is
  per-player, not per-map, so `serialize()` / `toBase64()` write a run-length
  encoded explored set (a 256×256 map costs under 32 bytes at either extreme) and
  `load()` restores it with the reveal animation already finished. Visibility is
  deliberately *not* saved — it is derived state, rebuilt by
  `UnitManager.reapplyFog()` once the units are back in place. Demo: [S]/[L] now
  save and restore the remembered world. *(2026-08-08)* `unexplore(col, row)`
  completes the pair — the memory tier only ever grows during play, but
  authoring tools and scripted amnesia need to take a cell back to never-seen;
  it clears exploration, the in-flight reveal animation, and the visibility
  count that would otherwise re-reveal the cell on the next frame.
- [x] **Territory/ownership layer** *(2026-08-05)* — `TerritoryLayer`: owner ids
  in the metadata channel (so ownership serializes with the map through binary,
  JSON, and `.hexpack` with no companion file), translucent faction tints, and an
  outline around each faction's holdings. A cell is either held outright
  (`claim`) or **contested** (`setInfluence`), where several factions carry
  fractional weights and the fill is their weighted blend — which is what drove
  the one substrate addition: `CellOverlayLayer` fills take a `cellColor`
  callback and switch to vertex colors, so a whole multi-faction map is one draw
  call instead of one per faction. Blending happens in the renderer's working
  color space, so a 50/50 cell lands on the perceptual midpoint rather than a
  muddy average of sRGB bytes. Rebuilds walk the sparse metadata store, so cost
  scales with owned cells, not map size; mutations only mark dirty and `update()`
  coalesces a whole flood fill into one rebuild. `HexWorld.setFactions`. Demo: [T].
- [x] **Resource layer** *(2026-08-05)* — `ResourceLayer` + `generateResources`:
  per-cell resource types stored in the metadata channel and drawn as instanced
  camera-facing billboards, one draw call per type, billboarded in the vertex
  shader so no per-frame CPU work. Icons read the same `FogData` texture the
  terrain does through a per-instance `cellIndex` attribute, so a deposit follows
  the memory tiers of the ground it sits on — hidden while unexplored, dimmed
  once remembered, full strength while watched. Descriptor-driven like
  terrain/liquid/scatter (`ResourceDescriptor` rides in the `.hexpack` manifest
  and in saved JSON maps), with optional per-cell amounts for deposits that
  deplete. The generation pass is biome-aware: terrain, elevation, river, coast,
  and scatter-density rules, plus optional temperature/moisture windows against
  the `ClimateSimulator` fields. Each type draws from its own seeded sub-stream,
  so adding a resource never reshuffles the others' placements, and `minSpacing`
  breaks up the clumps pure per-cell chance produces. `HexWorld.setResourceTypes`.
  Demo: [U].
- [x] **Flow-field pathfinding** *(2026-08-09)* — `FlowField` / `computeFlowField`.
  `findPath` is one A* per unit, which is the wrong shape the moment an army
  converges on one point: every search re-derives the same facts about the same
  terrain. One Dijkstra sweep *outward from the destination* records, for every
  cell, the cost to the goal and which neighbour to step to; after that each
  unit's next move is an array read. `field.path(from)` returns exactly what
  `findPath` returns — start first, goal last, `null` if unreachable — so it
  drops into `HexUnit.travel()` unchanged and the two are interchangeable at the
  call site. A single unit clicking a destination should still use A*, which
  stops at the goal instead of exploring everything; the crossover is a handful
  of units sharing one target.
  The parts that took thought:
  **The cost function has to run backwards.** The sweep expands goal-outward,
  but the move a unit makes runs inward, so when the search reaches `X` from a
  settled `Y` it asks `costFn(X, Y)` — the direction of travel, not the
  direction of expansion. Symmetric cost functions never notice; asymmetric ones
  (uphill dearer than down, one-way fords) come out right with nothing special
  at the call site, and there is a test that pins it with a cost function that is
  1 one way and 20 the other, cross-checked against A* from all 100 cells.
  A consequence worth stating: a cell the cost function refuses to *admit*
  anyone into still gets a direction if it has a passable way *out*, so a unit
  spawned or shoved onto a wall is handed a route off it rather than being
  stranded — nothing routes *through* it, since the step in is still rejected.
  **`flowVector` is not `next()` in world space.** The discrete step snaps to
  one of six axes, and a crowd following it files through a single hex in a
  single line, which is the tell that gives a shared field away. The steering
  vector instead blends every neighbour the field descends into, weighted by the
  cost each one saves, so units on open ground aim at the true bearing and a
  column meeting an obstacle splits around both sides. It re-checks each edge
  against the stored `costFn` rather than trusting the cost gradient alone —
  otherwise a cell whose cheap-looking neighbour sits across an impassable
  cliff edge steers straight off it, which is a visible bug and not a subtle
  one. Six cost calls per unit per frame, not per cell.
  **Storage is dense and reused.** Three typed arrays, 13 bytes a cell,
  allocated once; `compute` re-targets in place so a field that follows a moving
  quarry allocates nothing per frame. Invalidation is a monotonic pass stamp
  rather than a `fill()` — a 500k-cell field is dropped in one assignment. The
  heap is an index heap over parallel `Int32Array`/`Float64Array` rather than
  the object-per-node `MinHeap` A* uses, which is most of the constant-factor
  win. `maxCost` bounds the sweep for the common "only units within N will ever
  ask" case.
  Demo: hover a cell and press `[A]` — all four units march from one sweep, and
  the field is drawn as arrows (built from `flowVector`, so the curve around
  water is visible rather than hexagonal).
- [ ] **Naval support** — embark/disembark transitions, ships constrained to
  liquid cells, port designation on shore cells. Liquids are first-class; units
  on them aren't yet. Movement costs and pathfinding need liquid-aware modes.

### Developer experience

- [x] **Editor caught up to engine HEAD** *(2026-08-08)* — the reference
  consumer (`hex-world-editor`) had drifted: every subsystem added since the
  0.3.0 rebuild is opt-in, and the editor opted into none of them, so sky,
  seasons, fog, territory, and resources were invisible there. It now enables
  `sky: true` and `chunkWorker: true` at construction (streaming builds go
  off-thread; dirty-chunk rebuilds stay synchronous in the library, so painting
  still lands on the next frame), and adds three authoring tools alongside the
  existing five: **Territory** (faction claim/release brush), **Resources**
  (place/erase, honouring each type's placement rule or ignoring it), and **Fog
  of war** (reveal/hide brush, bulk reveal, hide-unexplored and dim-remembered
  toggles). Seasons got an Environment group — enable, phase scrub with
  solstice presets, animate, days-per-year — and View gained sky, territory,
  and resource visibility toggles.
  Ownership and resources are metadata-channel writes made **through the map
  transaction** rather than through `TerritoryLayer.claim` / `setResource`, so
  the existing `MapEditCommand` undoes them with everything else — the snapshot
  already deep-clones the metadata record. The catch is that both layers redraw
  off their own dirty flags and never see a snapshot restore, so
  `MapEditCommand` gained an `afterApply` hook and every commit carries a layer
  refresh: those overlays are built at each cell's surface height, so an
  elevation undo would otherwise strand borders and icons at the old altitude.
  Fog deliberately stays **out** of the undo stack and out of the saved map —
  it is per-player state, not map data.
- [x] **Live minimap primitives** *(2026-08-08)* — `MapImageRenderer` could only
  produce a `Blob`, which is the wrong shape for a minimap that has to redraw on
  every brush stroke: encode, object URL, decode, and revoke, per edit. It now
  splits into `drawMapImage(ctx, …)`, a synchronous draw into a canvas the caller
  owns, and `renderMapImage`, the same pass wrapped for PNG export. The awkward
  part of a minimap was never the picture but the arithmetic around it, so the
  draw returns a `MapImageTransform` (`width`/`height`/`bounds` plus
  `worldToImage`/`imageToWorld`), and `getMapImageTransform` hands you the same
  object without drawing — size a canvas, place a viewport rectangle, convert a
  click back to world XZ, with no duplicated `(x - minX) * scale + padding` at
  the call site. Content gained rivers, roads, and a `cellTint(col, row)` hook —
  the escape hatch for anything the map itself doesn't describe (ownership,
  selection, brush footprint) — all drawn per cell inside the fog pass, so a
  tinted river in a remembered cell dims with the ground it sits on. Completing
  the loop, `cameraGroundFootprint(camera)` returns the ground quad the view
  covers, clamping corners near the horizon along their own ray instead of
  dropping the rectangle at shallow pitches, which is what the old demo did.
  `getMapWorldBounds` stopped allocating six corner objects per cell (the corner
  offsets are identical for every hex), making it safe to call per frame. Demo
  and editor both drive minimaps off this — the editor's is a right-rail panel
  with the viewport box and click-to-jump.
- [x] **HexWorld event emitter** *(2026-08-08)* — a small typed `Emitter<EventMap>`
  (`on` returning an unsubscribe, `once`, `off`, `emit`, `listenerCount`) plus
  emitters on the three places that have lifecycle to report:
  `ChunkManager.events` (`chunkLoaded`/`chunkUnloaded` with the chunk's cell
  bounds), `UnitManager.events` (`unitAdded`/`unitRemoved`/`unitMoveStart`/
  `unitCellEnter`/`unitArrived`/`unitMoveEnd`), and `HexWorld.events`, which
  re-emits both plus `frame`, `mapChanged`, and the cell interaction set
  (`cellHover`, `cellEnter`, `cellLeave`, `cellClick`, `cellPointerDown`).
  Each layer keeps its own emitter so the à-la-carte path gets the same events;
  `HexWorld.trackUnits(manager)` forwards a manager the consumer owns, since
  the world does not create one.
  The parts that took thought:
  **Clicks are drag-filtered** — press and release must land within
  `clickTolerance` (default 5 px), which is what stops a right-button camera pan
  from firing a `cellClick` when the button comes up, and it means right-click
  can be the cancel gesture it reads as. The press picks at the event's own
  coordinates rather than reusing the frame loop's hover cell, because a touch
  tap arrives with no preceding `pointermove` and the cached cell would be stale
  or null. `cellPointerDown` fires synchronously from the DOM handler so
  `pointer.preventDefault()` still works.
  **Hover diffs by value** — `HexPicker` returns a fresh object per pick, so
  identity comparison would report a change every frame; `cellLeave` fires
  before the matching `cellEnter` so a highlight handler can clear then paint
  without tracking the previous cell itself.
  **Dispatch is snapshotted and fault-isolated** — `emit` iterates a copy, so a
  listener that unsubscribes mid-dispatch doesn't make the iterator skip the
  next one, and a throwing listener can't halt chunk streaming or rob the
  remaining subscribers. The error is surfaced, not swallowed: rethrown from a
  microtask (reaching `window.onerror` with its stack) unless `onError` is set.
  **`dispose()` drops listeners first**, because tearing chunks down fires
  `chunkUnloaded` for every loaded chunk and a listener has no way to tell that
  from ordinary streaming.
  Two things fell out of it: `HexUnit.onMoveEnd` now takes `completed`, so
  `unitArrived` (path finished) is distinguishable from `unitMoveEnd` after a
  `stop()` — the distinction turn logic needs; and `UnitManager` now *restores*
  the callbacks it wraps on `removeUnit`, fixing a latent bug where removing and
  re-adding a unit double-wrapped `onCellEnter` and left its fog reveal stuck on.
  The demo shows the ergonomic payoff: the selection/minimap refresh that was
  copy-pasted onto every unit's `onCellEnter` and `onMoveEnd` is now two
  subscriptions on the manager, with per-unit callbacks kept only for the per-unit
  material swap.

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
  descent, frozen rivers (crossable, risky). *The engine side is done: drive
  `SeasonCycle.advanceDays(1)` per turn and read `climate.snowDepth` for
  movement cost and `climate.isFrozen(col, row, freezePoint)` for whether the
  ford is ice. Both are the exact values the player can see.*
- [ ] **M4 — Oregon Trail dressing** — event cards, trading posts, the
  journey-map screen, end-of-run summary.

Open question: where the game lives — a sibling repo (like `hex-world-editor`) or
a `demo/` expansion in this repo. Leaning sibling repo with the same conditional
Vite alias to library HEAD.
