# hex-world

A Three.js library for building hex-grid strategy and exploration games. Handles the hard rendering and simulation work so your game can focus on rules and content.

---

## What it does

- **Chunk-based rendering** — large maps streamed in and out as the camera moves, one draw call per chunk; optional Web Worker geometry building for hitch-free streaming on big maps
- **HexWorld facade** — batteries-included entry point: renderer, RTS camera, lighting, materials, streaming, picking, and overlays wired in one call, with every piece still reachable for à-la-carte use
- **Terrain system** — six built-in types with vertex color blending and triplanar texture splatting, so a cliff face takes a side projection instead of the flat ground's smeared one; baked ambient occlusion darkens the feet of cliffs and the insides of carved gorges; sedimentary strata band the bare rock, continuous across cells so a canyon cut through six hexes reads as one cut through one rock, and slope-gated so hillsides and grass banks stay unbanded; fully extensible with custom types, procedural noise, or image textures; shader-based hex grid overlay with distance fading
- **Liquid types** — modular system supporting multiple liquid types on one map (water, lava, acid, or custom); each type has its own surface, shore, estuary, and river materials; correct foam boundaries where liquid types meet; rivers classified by which pool they drain into, widened by accumulated flow, joined at confluences, and carved into flared channels with rendered waterfalls at cliffs — each fall throwing GPU-animated spray and churning a foam plunge pool where it lands, tunable per liquid (a lava fall throws sparse heavy ash, an acid fall a fine fume cloud)
- **Sun shadows** — a shadow-casting directional sun whose frustum re-fits the camera view every frame (texel-snapped, so panning doesn't shimmer) — built to pair with chunk streaming
- **Day/night cycle** — animated sun/moon arc with warm dawn/dusk tinting, cool moonlight, sky color tracking, and liquid darkening that leaves emissive lava glowing after dark; terrain and roads share one light state, so a road never glows after dark
- **Weather** — drifting cloud shadows across terrain, roads, *and* water, plus world-anchored rain streaks and snow that fall under the denser clouds and follow the camera without sticking to it. Clear weather is a *fair* day, not an empty sky: scattered cumulus shadows keep moving over the ground unless you ask for `clouds: false`
- **Scatter texture** — fine procedural mottling that stops a flat-shaded low-poly plant reading as plastic beside ground that carries real triplanar texture. It varies brightness on a scale finer than a facet, so each flat plane stops being *perfectly* uniform while its edges stay exactly as crisp as they were — it breaks the colour up, not the silhouette. Sampled off the raw vertex position rather than the swayed one, so wind can bend a tree without the pattern swimming across it, and faded out once a feature drops under a pixel so a distant forest doesn't crawl. One call, no data, nothing to drive per frame: `attachScatterTexture`
- **Wind** — one shared vector the whole world answers: the cloud deck drifts by it, the rain slants and streaks along it, the ripple pattern marches across open water with it, and every plant bends downwind. It *gusts*, on a clock of its own — and because the gust arrives as a wave travelling along the wind rather than as a global multiplier, you watch it cross a wood tree by tree, which is the difference between a scene that is animated and one that is alive. The sustained wind and the gust are separate on purpose: a whole overcast deck doesn't surge in a two-second squall, but the hedge under it does. Which plants bend is one call per material — `attachWindSway`, the same division `attachSeasonalTint` makes — so a boulder stays put, and a river keeps flowing down its own channel no matter which way the air is going
- **Seasons and snow** — a year clock that drives a snowline *down the map* as winter deepens (the seasonal swing scales with latitude, so poles turn first and the equator barely moves) and back up as it thaws. Snow accumulates and melts per cell, breaks up along a noisy edge, sheds off cliff faces, and settles on trees and rocks as well as ground. Liquids freeze at their own `freezePoint` — water skins over while lava never does — stilling waves, surf, and river flow, and leaving waterfall spray hanging as suspended crystals. Snow falls where snow lies and rain everywhere else. Crucially the snow depth the shader draws *is* the number `climate.snowDepth(col, row)` returns, so "is this hex snowed in" and what the player sees can never disagree
- **Seasonal foliage** — grass and deciduous plants swing spring green → summer → autumn gold → bare on the same clock, per cell rather than globally, so cold uplands turn while the valley below is still green and the tropics never turn at all. Plants also *bloom*: a share of them flower pink or blue as spring reaches them, then go green for the summer. Which plants turn is one call per material: a broadleaf gets `attachSeasonalTint` and a pine doesn't, and that is the entire difference. Individual trees stray from the shared autumn colour so a wood doesn't read as one decal, and on a merged trunk-and-canopy mesh the tint finds the leaves by their colour — no second material, no vertex mask. Built-in low-poly `createPineGeometry` / `createBroadleafGeometry` / `createBushGeometry` give the scatter system something to draw before there's art
- **Sky system** — gradient dome with a sun/moon glow and a night star field, plus matching distance haze on terrain, roads, and every liquid layer, so the map edge dissolves into the horizon instead of ending against a void; the horizon leans toward the terrain palette's own color, follows the day/night cycle, and greys over under rain and snow. `attachAtmosphere` gives your own scatter, unit, and prop materials the identical haze — matched in color space and distance measure, which `scene.fog` cannot do
- **God rays** — crepuscular shafts fanning out from the sun wherever a ridgeline or a wood breaks its edge, added over the frame rather than through it, so the renderer's antialiasing survives and nothing re-encodes an already-final image. They are scattered sunlight and behave like it: fading in with the daylight, going orange at dawn with the light itself, and snuffed out by an overcast sky — and while the sun is down, behind the camera, or under cloud the pass is skipped outright, so it costs nothing at all
- **Map skirt** — the map as a block of earth rather than a surface. Terrain is a shell whose edges are simply where the triangles stop, so any camera low enough to see the horizon also sees under it; the skirt closes that with a wall whose top follows the terrain's own contour, sharing the exact vertex perturbation so the seam is invisible, and whose base is one flat floor below the lowest ground on the map. The outside is banded soil strata keyed to *world* height, so a layer holds its level around every corner and the four walls read as one cut block — with a dark topsoil line under the turf, and the water's own cross-section where the edge runs through a sea. Only the perimeter is built, so it is `O(width + height)` and cheap to recut on every brush stroke
- **Roads** — geometry strips rendered above terrain, lit and shadowed with the ground they sit on (day/night, cloud shadows, and sun shadows all reach them)
- **Scatter features** — instanced meshes (trees, rocks, buildings) placed deterministically from per-cell density levels; modular definitions with terrain filters and density tiers
- **Fog of war** — reference-counted per-cell visibility with smooth reveal animation, split into two memory tiers: *visible* (live) and *explored* (remembered). Explored cells keep showing their terrain, scatter, and resources, dimmed, while units standing on them are hidden — the classic ghost state. Exploration saves and restores as a compact run-length blob, independent of the map
- **Territory** — per-cell ownership with translucent faction tints and per-faction border outlines; cells can be held outright or contested between factions, blending their colors; stored in the metadata channel, so borders serialize with the map
- **Resources** — per-cell resource types (ore, fish, game) drawn as instanced camera-facing icons that follow the fog's memory tiers, with a biome-aware generation pass driven by terrain, elevation, rivers, coastline, scatter density, and climate; descriptor-driven, so packs carry custom resources
- **Per-cell metadata** — a sparse, serialized data channel (`getCellData`/`setCellData`) with undo/redo, backing territory, resources, and any game-specific state
- **Procedural generation** — full climate-driven pipeline (BFS landmass → erosion → moisture simulation → temperature model → biome assignment → rivers → roads), plus a fast FBM alternative; composable raw passes for custom generators; async time-sliced variants with progress events and cancellation for loading bars
- **Minimap rendering** — `drawMapImage` paints a top-down map straight into a canvas (terrain, elevation shading, rivers, roads, fog, plus a per-cell tint hook for ownership or highlights) and hands back the world↔pixel transform, so a camera-viewport rectangle, click-to-jump, and unit pins all line up without extra math; `renderMapImage` wraps it for PNG thumbnails, and `cameraGroundFootprint` gives you the exact ground quad the camera is looking at
- **Pathfinding** — A\*, flood-fill movement range, BFS visibility radius, elevation-aware line of sight, Catmull-Rom path smoothing
- **Units** — position, smooth path-following, facing, fog reveal; wire your own `Object3D` and animation callbacks
- **Typed events** — `world.events.on('cellClick' | 'cellHover' | 'cellEnter' | 'cellLeave' | 'chunkLoaded' | 'unitArrived' | …)` instead of wiring raycasts, pointer listeners, and per-unit callbacks by hand. Clicks are drag-filtered, so releasing a right-button camera pan never reads as a click, and taps work without a preceding pointer move. Any number of systems can subscribe to the same event — the single-slot `onFrame` and `unit.onMoveEnd` hooks still work alongside it
- **RTS camera** — pan, zoom, tilt, and swing around the target, all with smooth damping. Middle-drag does both angles at once (up/down tilts, left/right turns), or drive them from code with `rotateTo` / `tiltTo`. The tilt floor is deliberately low enough to put the horizon on screen — a strictly top-down camera can never look at the sky, which quietly makes the dome, sunsets, and god rays invisible. `setPitchLimits` and `setYawEnabled` change both at runtime, so a game can offer a constrained classic-RTS view and a free-look one as selectable modes; locking the heading swings it back to rest rather than freezing it wherever it happened to be
- **Save/load** — binary and JSON formats; scatter, terrain, liquid, resource, and faction descriptors travel with the map; water surfaces recomputed correctly for all liquid types on load
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

The fastest path is the `HexWorld` facade — one call wires the renderer, RTS camera, lights, materials, chunk streaming, and picking:

```ts
import { HexWorld, HexMap, FbmPlugin } from '@loyalj/hex-world';

const map = new HexMap({ width: 200, height: 100, featureLayerCount: 1 });
FbmPlugin.generate(map, FbmPlugin.defaultConfig, Date.now());

const world = await HexWorld.create({
  container: document.body,
  map,
  shadows: true,          // camera-fitted sun shadows
  dayNight: true,         // animated day/night cycle (see also world.setTimeOfDay)
  sky: true,              // gradient sky dome + horizon haze on the map edges
  godRays: true,          // sun shafts past the ridgelines (see also world.setGodRays)
  skirt: true,            // cut-earth walls, so a low camera can't see under the map
  seasons: true,          // snowline, freezing water (see also world.setSeason)
  wind: true,             // one shared wind: cloud drift, rain slant, sway, ripples
  chunkWorker: true,      // build streamed chunks off the main thread
});

world.setWeather('rain');  // cloud shadows, rain under them, and an overcast sky
world.setWeather('clear'); // no precipitation, but fair-weather shadows still drift
world.onFrame = () => { if (world.hoveredCell) { /* your game logic */ } };
```

### Seasons

The year clock is shaped like the day clock — `0` is midwinter, `0.5` midsummer — and it can either run in real time or be scrubbed a day at a time by a turn-based game:

```ts
import { ClimateData, generateMap } from '@loyalj/hex-world';

// Keep the temperature field the generator computes on its way to biomes.
const climate = new ClimateData(map.width, map.height);
generateMap(map, { climateData: climate }, seed);

world.setSeasons({ daysPerYear: 120 }, climate);

// One turn is one day; winter arrives on its own.
world.seasons.advanceDays(1);
world.setSeason(world.seasons.phase);

// Gameplay reads the same bytes the shaders sample — these can't disagree
// with what's on screen.
if (world.climate.snowDepth(col, row) > 0.5) moveCost += 2;
if (world.climate.isFrozen(col, row, waterDescriptor.freezePoint)) allowCrossing();
```

How much world the map covers decides what a season *is*, so that's a setting:

```ts
world.setSeasons({ scope: 'continental' }); // default — winter arrives up the map
world.setSeasons({ scope: 'local' });       // one valley, one season, all at once
```

`'continental'` scales the swing by latitude and lets the generator's elevation cooling stand, so the snowline descends the map and peaks keep year-round caps — the model that makes a subcontinent feel like one. `'local'` inverts which term dominates: the whole map shares a season, and its own temperature field is demoted to a slight stagger on *when* each cell turns, so the high ground still leads by a little. By midwinter every tree is bare and every hex is under snow; by spring all of it blooms. Nothing downstream knows which model ran — snow, ice, foliage, blossom, precipitation and `climate.snowDepth` all read the same two bytes.

Grass and foliage turn with the same clock. Which plants turn is decided by which materials get `attachSeasonalTint` — that one call is the whole difference between a broadleaf and a pine:

```ts
import { attachSnow, attachSeasonalTint, createBroadleafGeometry, BROADLEAF_CANOPY_COLOR } from '@loyalj/hex-world';

const broadleaf = new THREE.MeshLambertMaterial({ vertexColors: true });
attachSeasonalTint(broadleaf, { summer: BROADLEAF_CANOPY_COLOR, blossomShare: 0.6 });
attachSnow(broadleaf);          // blooms, greens, turns gold, then takes a cap

const pine = new THREE.MeshLambertMaterial({ color: 0x3f6b2c });
attachSnow(pine);               // takes a cap, stays green

world.setSeasons({ foliage: { autumn: 0xd2601a } });  // restyle the palette
```

The turn is per cell, not global: it's driven by the same season-adjusted temperature the ice is, so cold uplands go gold while the valley below is still green and the tropics never turn at all. On a merged trunk-and-canopy mesh the tint finds the leaves by their colour, so no second material or vertex mask is needed.

Blossom comes with the tint. A share of the plants flower as spring passes through them — each somewhere between two petal colours, so a hillside reads as pinks and lilacs among the green rather than one repeated tree — then go green for the summer. Coverage stops short of full, so some canopy shows through and the bloom reads as petals *on* a tree. Because it rides the same per-cell turn, the bloom climbs the map the way the snowline retreats.

Ground cover keeps its own palette, because it doesn't do what a canopy does: grass goes straw and then dun where a wood goes gold and then bare. Tune the two apart with `terrainFoliage`, which layers over `foliage`:

```ts
world.setSeasons({
  foliage:        { autumn: 0xd2601a },  // every plant that turns
  terrainFoliage: { autumn: 0xc9b070 },  // …but the ground stays straw
});
```

Each liquid decides its own freeze point, so a map can hold water that ices over in autumn beside lava that never does:

```ts
{ id: 'water', name: 'Water', freezePoint: 0.12 }  // freezes across much of the map
{ id: 'lava',  name: 'Lava'  }                     // no freezePoint — never freezes
```

### Scatter texture

Flat-shaded plants sit in a scene whose ground is triplanar-textured, and a large facet of one solid colour reads as plastic next to it. One call per material breaks it up:

```ts
import { attachScatterTexture } from '@loyalj/hex-world';

attachScatterTexture(broadleaf);                          // tuned defaults
attachScatterTexture(bush, { scale: 11, strength: 0.14 }); // small facets, go finer
attachScatterTexture(rock, { scale: 9,  strength: 0.20 }); // stone wants grain
```

`strength` is peak-to-peak brightness variation as a fraction of the surface's own colour (0.18 ≈ ±9%), and `scale` is noise features per world unit — pick it against *facet* size, not plant size, since the point is to break a facet up rather than tint it. It multiplies into `diffuseColor` before lighting, so the mottling is lit and shadowed with the model and keeps its hue.

It composes with the rest by landing before the seasonal colour slot: the foliage tint recolours an already-mottled surface (so the variation carries through autumn instead of being flattened by it) and snow covers it, which is what snow does to a texture. Attach order doesn't matter.

Two details that stop it looking like a bug: the noise is sampled off the **raw vertex position**, not the wind-swayed one, so a bending tree doesn't drag the pattern across its own canopy; and it fades out once a feature drops below about a pixel, because a sub-pixel pattern doesn't average into a tint — it crawls, and a whole forest of crawling trees is worse than a flat one.

### Wind

One vector for the whole world. Switch it on and the cloud deck, the rain, the water and the plants all start answering the same weather:

```ts
world.setWind({ heading: Math.PI * 0.25, speed: 4 });
world.wind.setPolar(world.wind.heading + 0.4, 6);  // the squall veers and builds
world.setWind(false);                              // dead calm
```

Which plants bend is one call per material — the same division `attachSeasonalTint` makes between a broadleaf and a pine, and for the same reason: that a hedge answers the wind and a boulder does not is a fact about your scatter, not about the renderer. `setWind` *drives* whatever carries the patch and applies it to nothing:

```ts
import { attachWindSway } from '@loyalj/hex-world';

attachWindSway(broadleaf, { height: 1.9 });
attachWindSway(bushes,    { height: 0.5, stiffness: 1.2, amplitude: 0.125 });
// the rock material gets no call, and stays put
```

`amplitude` is tip displacement as a fraction of the plant's own height, so it means the same thing on a seedling and an old oak; `stiffness` decides where the bend lives (1 bows from the base, 2 keeps the trunk planted and moves the crown, 4 flicks the tip only).

Water needs no call: every liquid material already carries the uniforms and sits at zero until a wind drives them. Open water drifts its ripple pattern downwind and roughens as the wind rises, and onshore wind thickens the surf — but a **river ignores the wind entirely**, because its direction is its channel's, and a gust must never run a stream backwards up a hill.

Three details do most of the work:

- **It gusts, and the gust travels.** The surge arrives as a wave moving along the wind rather than as a global multiplier, so you watch it cross a wood tree by tree instead of the whole wood leaning at once. `waveLength` sets how big a patch leans together.
- **Sustained and surface wind are separate.** `wind.base` is the sustained vector and drifts the cloud deck; `wind.surface` is what the gust is doing right now and is what the rain and the plants follow. An overcast sky that surged with every two-second squall would read as the whole world sliding.
- **Phase is integrated, never `time × speed`.** Multiplying a shared clock by a changing rate rewinds the wave every time the wind picks up, which reads as the trees briefly swaying backwards.

The wind exists and advances from the first frame whether or not it has been switched on, which is why a shower gusts before anything on the ground is wired up to answer it. `setWind` gates only the push out to the materials.

### Events

Cell interaction, the frame tick, chunk streaming, and unit movement all arrive on one typed emitter, so a consumer never has to own a raycast or a pointer listener:

```ts
world.events.on('cellClick', ({ col, row, button, pointer }) => {
  if (button === 0) select(col, row);        // drag-filtered: a pan is not a click
  if (button === 2) { deselect(); pointer.preventDefault(); }
});

// Fires on change only — including to null when the cursor leaves the map.
world.events.on('cellHover', ({ cell, previous }) => highlight(cell, previous));

world.events.on('chunkLoaded', ({ bounds }) => spawnPropsIn(bounds));

// `on` returns an unsubscribe function.
const off = world.events.on('frame', ({ dt }) => mixer.update(dt));
off();
```

Units keep their own emitter, so the à-la-carte path gets the same events; `trackUnits` re-broadcasts them through the world so there is still only one place to listen:

```ts
const units = new UnitManager({ scene: world.scene, map: world.map, layout: world.layout });
world.trackUnits(units);

world.events.on('unitArrived', ({ unit, col, row }) => endTurn(unit, col, row));
// `unitArrived` means the path finished; `unitMoveEnd` also fires for an
// interrupted move and carries `completed` to tell them apart.
```

`ChunkManager` and `UnitManager` expose `.events` directly if you never build a `HexWorld`.

### Gameplay layers

Ownership and resources are per-cell game state, so they live in the map's metadata channel and serialize with the map — no companion file:

```ts
import { generateResources, DEFAULT_RESOURCE_DESCRIPTORS } from '@loyalj/hex-world';

// Territory — outright claims, or contested cells that blend faction colors
const territory = world.setFactions([
  { id: 'red',  name: 'Kelmar',  color: 0xdd4433 },
  { id: 'blue', name: 'Ossiran', color: 0x3377dd },
]);
territory.claim(10, 10, 'red');
territory.setInfluence(11, 10, { red: 0.6, blue: 0.4 });  // contested border hex

// Resources — instanced icons that respect fog, from a biome-aware pass
world.setResourceTypes(DEFAULT_RESOURCE_DESCRIPTORS);
generateResources(world.map, DEFAULT_RESOURCE_DESCRIPTORS, seed, { isWater: world.isWater });
```

Fog of war keeps two tiers — what you can see now, and what you remember. Exploration is per-player rather than per-map, so it saves as its own compact blob:

```ts
const fog = new FogData(map.width, map.height);   // pass via the `fogData` option

fog.isVisible(col, row);    // in someone's sight right now
fog.isExplored(col, row);   // seen at some point — terrain remembered, units hidden

localStorage.setItem('fog', fog.toBase64());      // save
fog.loadBase64(localStorage.getItem('fog')!);     // restore the remembered world
unitManager.reapplyFog();                         // rebuild live sight from the units
```

Every piece `HexWorld` wires is also available à la carte if you'd rather own the scene yourself:

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
