import * as THREE from 'three';
import { POINTY_TOP } from '../math/HexOrientation.js';
import { RtsCameraController } from '../camera/RtsCameraController.js';
import { createLayout } from '../math/HexLayout.js';
import { HexMap } from '../map/HexMap.js';
import { ChunkManager } from '../geometry/ChunkManager.js';
import { createRoadMaterial } from '../geometry/RoadMaterial.js';
import { buildTerrainTextureArray } from '../geometry/TerrainTextures.js';
import { DEFAULT_TERRAIN_DESCRIPTORS, resolveTerrainDefinitions, buildWaterTerrainSet } from '../geometry/TerrainTypes.js';
import { configureTerrainGrid, createTerrainMaterial, setCliffStrataEnabled } from '../geometry/TerrainMaterial.js';
import { resolveLiquidMaterials, DEFAULT_LIQUID_DESCRIPTORS } from '../geometry/LiquidTypes.js';
import type { TerrainColorMode } from '../geometry/ChunkManager.js';
import { HexHashGrid } from '../geometry/HexHashGrid.js';
import type { ScatterDefinition } from '../geometry/ScatterTypes.js';
import { createRockMaterial } from '../geometry/RockMaterial.js';
import {
  createPineGeometry, createBroadleafGeometry, createBushGeometry,
  BROADLEAF_CANOPY_COLOR, BUSH_COLOR,
} from '../geometry/ScatterShapes.js';
import type { MapGeneratorPlugin } from '../generators/MapGeneratorPlugin.js';
import { FbmPlugin } from '../generators/FbmPlugin.js';
import { ChunkPlugin } from '../generators/ChunkPlugin.js';
import { MountainLakePlugin } from '../generators/MountainLakePlugin.js';
import { LiquidShowcasePlugin } from '../generators/LiquidShowcasePlugin.js';
import { pickHexFromMeshes } from '../geometry/HexPicking.js';
import { hexToWorld, hexCorners } from '../math/HexLayout.js';
import { offsetToHex } from '../math/HexCoord.js';
import { TerrainType } from '../map/HexCell.js';
import { FogData } from '../geometry/FogData.js';
import { findPath, getMovementRange, getVisibleCells, hasLineOfSight, type MoveCostFn } from '../pathfinding/Pathfinding.js';
import { FlowField } from '../pathfinding/FlowField.js';
import { smoothPath } from '../pathfinding/PathSmoothing.js';
import { hexToOffset } from '../math/HexCoord.js';
import { serializeMapJSON, deserializeMapJSON } from '../map/MapSerializer.js';
import { drawMapImage, getMapImageTransform, type MapImageTransform } from '../map/MapImageRenderer.js';
import { cameraGroundFootprint } from '../camera/GroundProjection.js';
import { HexUnit } from '../units/HexUnit.js';
import { UnitManager } from '../units/UnitManager.js';
import { SunShadowRig } from '../lighting/SunShadows.js';
import { DayNightCycle, formatTimeOfDay } from '../lighting/DayNightCycle.js';
import { WeatherSystem, type WeatherType } from '../weather/WeatherSystem.js';
import { setMaterialWind } from '../weather/Wind.js';
import { attachWindSway } from '../weather/WindSway.js';
import { attachScatterTexture, setScatterTextureEnabled } from '../geometry/ScatterTexture.js';
import { SkyDome, averageTerrainColor } from '../sky/SkyDome.js';
import { MapSkirt } from '../geometry/MapSkirt.js';
import { GodRays } from '../sky/GodRays.js';
import { attachAtmosphere } from '../sky/Atmosphere.js';
import { ClimateData } from '../season/ClimateData.js';
import { SeasonCycle, formatSeason, type SeasonScope } from '../season/SeasonCycle.js';
import { configureSeason, resolveSnowTerrain, resolveFoliageColor, setSeasonPhase } from '../season/SeasonGLSL.js';
import { attachSnow } from '../season/SnowAttach.js';
import { attachSeasonalTint } from '../season/TintAttach.js';
import { computeTemperature } from '../generators/TemperatureModel.js';
import { CellOverlayLayer } from '../geometry/CellOverlayLayer.js';
import { TerritoryLayer, type FactionDescriptor } from '../gameplay/TerritoryLayer.js';
import { ResourceLayer } from '../gameplay/ResourceLayer.js';
import { generateResources } from '../gameplay/ResourceGenerator.js';
import { DEFAULT_RESOURCE_DESCRIPTORS } from '../gameplay/ResourceTypes.js';
import { hexRange, hexDistance } from '../math/HexCoord.js';

/** Change this one constant to switch terrain rendering mode. */
const TERRAIN_COLOR_MODE: TerrainColorMode = 'splat';

const TERRAIN_NAMES: Record<number, string> = {
  [TerrainType.Water]:     'Water',
  [TerrainType.Grassland]: 'Grassland',
  [TerrainType.Desert]:    'Desert',
  [TerrainType.Mud]:       'Mud',
  [TerrainType.Rock]:      'Rock',
  [TerrainType.Snow]:      'Snow',
  6: 'Riverbed',
  7: 'Lava',
  8: 'Acid',
  9: 'Deep Acid',
};

// Extended terrain descriptors — default seven (incl. riverbed at 6) plus
// lava (7) and acid (8, deep 9). Deep Acid shares liquidType 'acid' with
// Acid: one liquid spanning two terrain indices (no internal foam line; the
// pool floor dips at the deep cells).
const DEMO_TERRAIN_DESCRIPTORS = [
  ...DEFAULT_TERRAIN_DESCRIPTORS,
  { index: 7, id: 'lava', name: 'Lava', color: 0xd44010 as number,
    liquidType: 'lava', texture: { type: 'procedural' as const } },
  { index: 8, id: 'acid', name: 'Acid', color: 0x55cc22 as number,
    liquidType: 'acid', texture: { type: 'procedural' as const } },
  { index: 9, id: 'acid-deep', name: 'Deep Acid', color: 0x2f7a12 as number,
    liquidType: 'acid', texture: { type: 'procedural' as const } },
];
const DEMO_TERRAIN_DEFINITIONS = resolveTerrainDefinitions(DEMO_TERRAIN_DESCRIPTORS);
const DEMO_WATER_TERRAINS      = buildWaterTerrainSet(DEMO_TERRAIN_DEFINITIONS);

const MAP_WIDTH   = 200;
const MAP_HEIGHT  = 100;
const HEX_SIZE    = 1;
const CHUNK_SIZE  = 32;
const LOAD_RADIUS = 5;

// --- Generator registry ---
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GENERATORS: MapGeneratorPlugin<any>[] = [FbmPlugin, ChunkPlugin, MountainLakePlugin, LiquidShowcasePlugin];
let activeGenIndex = 0;
let seed = Math.floor(Math.random() * 0xffffffff);

// --- Map ---
// Four feature layers: conifers, rocks, broadleaf trees, bushes — the four the
// generators fill (see assignBiomes / generateFbmTerrain).
const map = new HexMap({ width: MAP_WIDTH, height: MAP_HEIGHT, featureLayerCount: 4 });

function runGenerator(): void {
  const gen = GENERATORS[activeGenIndex];
  map.clear();
  gen.generate(map, gen.defaultConfig, seed);
}

runGenerator();

// --- Layout ---
const layout = createLayout(POINTY_TOP, HEX_SIZE);

// --- Three.js scene ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 200);
camera.position.set(MAP_WIDTH * 0.5, 40, MAP_HEIGHT * 0.5 + 30);
camera.lookAt(MAP_WIDTH * 0.5, 0, MAP_HEIGHT * 0.5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const controls = new RtsCameraController({
  camera,
  domElement: renderer.domElement,
  initialTarget:   { x: MAP_WIDTH / 2, z: MAP_HEIGHT / 2 },
  initialDistance: 60,
  // 6°, not 30°: above ~22° (half the vertical FOV) the horizon never enters
  // the frame, so the sky's best hours — and the god rays — can't be looked at.
  minPitch: 6,
  maxPitch: 66,
  minDistance: 6,
  maxDistance: 80,
});

// Lighting — cool sky ambient + warm shadow-casting sun whose ortho frustum
// re-fits the camera view every frame (see SunShadowRig).
const ambient = new THREE.AmbientLight(0xd0e0ff, 0.5);
scene.add(ambient);
const sunRig = new SunShadowRig({ direction: new THREE.Vector3(100, 120, 80) }).addTo(scene);

// --- Hover indicator (flat translucent hex that follows the cursor) ---
const indicatorGeo = new THREE.BufferGeometry();
const corners = hexCorners(layout, { q: 0, r: 0 });
const indicatorVerts: number[] = [];
corners.forEach((c, i) => {
  const next = corners[(i + 1) % 6];
  indicatorVerts.push(0, 0, 0, c.x, 0, c.z, next.x, 0, next.z);
});
indicatorGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(indicatorVerts), 3));
const hoverMesh = new THREE.Mesh(
  indicatorGeo,
  new THREE.MeshBasicMaterial({ color: 0xffff88, transparent: true, opacity: 0.35, depthWrite: false, depthTest: false, side: THREE.DoubleSide }),
);
hoverMesh.renderOrder = 5;
hoverMesh.visible = false;
scene.add(hoverMesh);
let hoverCell: { col: number; row: number } | null = null;

// --- Materials ---
const roadMaterial    = createRoadMaterial();
const liquidMaterials = new Map(DEFAULT_LIQUID_DESCRIPTORS.map(d => [d.id, resolveLiquidMaterials(d)]));
// Scatter materials live up here with the rest so the sky can haze them before
// the scatter definitions below are built.
//
// Three plant materials, and which seasonal patches each one gets is the whole
// difference between them: the pine takes snow only and stays green all year,
// the other two take the tint as well and turn. See the attach calls in start().
const pineMat      = new THREE.MeshLambertMaterial({ color: 0x3f6b2c });
const broadleafMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const bushMat      = new THREE.MeshLambertMaterial({ vertexColors: true });
const rockMat      = createRockMaterial();
const scatterMats  = [pineMat, broadleafMat, bushMat, rockMat];

// --- HUD ---
const hud = document.createElement('div');
hud.style.cssText = `
  position: fixed; top: 12px; left: 12px;
  color: #fff; font: 13px/1.6 monospace;
  background: rgba(0,0,0,0.45); padding: 8px 12px;
  border-radius: 6px; pointer-events: none;
`;
document.body.appendChild(hud);

// --- Resize ---
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- Mouse tracking (re-picked every frame so hover updates on camera move) ---
let lastMouseX = 0;
let lastMouseY = 0;
window.addEventListener('pointermove', e => { lastMouseX = e.clientX; lastMouseY = e.clientY; });

// --- FPS tracking ---
let fps = 0;
let frameCount = 0;
let lastFpsTime = performance.now();

async function start() {
  const waterGeoOptions = {};
  let gridVisible = false;
  // On out of the box — the toggle is here to show the before/after, since it
  // is the kind of change you only see by taking it away.
  let strataVisible = true;

  let terrainMaterial: THREE.Material;
  if (TERRAIN_COLOR_MODE === 'splat') {
    const terrainTex = await buildTerrainTextureArray(DEMO_TERRAIN_DESCRIPTORS);
    terrainMaterial = createTerrainMaterial(terrainTex, {
      lightDir:   new THREE.Vector3(100, 120, 80),
      lightColor: new THREE.Color(0xfff4d0).multiplyScalar(0.7),
      ambient:    new THREE.Color(0xd0e0ff).multiplyScalar(0.45),
    });
  } else {
    terrainMaterial = new THREE.MeshPhongMaterial({ vertexColors: true, side: THREE.DoubleSide });
  }

  // --- Sky, day/night + weather ---
  const shaderTerrainMat = terrainMaterial instanceof THREE.ShaderMaterial ? terrainMaterial : undefined;

  // Flat-shaded low-poly plants read as plastic next to textured ground, so
  // break each facet up with fine procedural mottling. Scale is per material
  // and tracks facet size: a pine's cone is one big smooth sweep and wants the
  // coarsest pattern, a bush's lobes are tiny and want the finest. Rock takes
  // it too — it is the one that most obviously wants grain.
  attachScatterTexture(pineMat,      { scale: 5,  strength: 0.16 });
  attachScatterTexture(broadleafMat, { scale: 6,  strength: 0.18 });
  attachScatterTexture(bushMat,      { scale: 11, strength: 0.14 });
  attachScatterTexture(rockMat,      { scale: 9,  strength: 0.20 });
  let scatterTexture = true;

  // Scatter uses stock three materials, which have no haze of their own —
  // scene.fog is the wrong tool (it mixes before tone mapping and encoding, so
  // the same color lands far brighter on a tree than on the hill behind it).
  for (const mat of scatterMats) attachAtmosphere(mat);

  // Every material that carries the atmosphere uniforms, so the map edge and
  // everything standing on it dissolve into the same horizon color.
  // The map as a block of earth rather than a surface: without it, the low
  // tilt the camera now allows looks straight under the terrain's edge.
  const skirt = new MapSkirt(map, layout, { depth: 2.5 }).addTo(scene);
  let skirtVisible = true;

  function* hazeMaterials(): Generator<THREE.Material> {
    if (shaderTerrainMat) yield shaderTerrainMat;
    yield roadMaterial;
    yield skirt.material;
    yield* scatterMats;
    for (const set of liquidMaterials.values()) {
      for (const mat of [set.surface, set.shore, set.estuary, set.river, set.waterfallFoam, set.waterfallSpray]) {
        if (mat) yield mat;
      }
    }
  }

  const sky = new SkyDome({
    // The demo palette runs grass → desert → rock → snow; its average is the
    // dusty warm grey the horizon leans toward by day.
    groundTint: averageTerrainColor(DEMO_TERRAIN_DEFINITIONS),
    materials:  hazeMaterials,
  }).addTo(scene);
  let skyVisible = true;

  // Shafts fanning past the ridgelines. Handed the dome so the weather that
  // greys it out puts the rays out too, and so the dome itself — which is the
  // light, not an obstacle — stays out of the occlusion pass.
  const godRays = new GodRays({ sky });

  // Starts paused at noon (which reproduces the static default lighting);
  // [N] lets time flow, [,]/[.] scrub in 30-minute steps.
  const dayNight = new DayNightCycle({ dayLength: 90, paused: true });
  // liquidMaterials.values() is a one-shot iterator, so build the targets fresh each apply.
  function applyDayNight(): void {
    dayNight.applyTo({
      sunRig,
      ambientLight: ambient,
      terrainMaterial: shaderTerrainMat,
      roadMaterial,
      liquidMaterials: liquidMaterials.values(),
      lightMaterials:  [skirt.material],
      scene,
      sky,
      godRays,
    });
  }
  applyDayNight();

  const weather = new WeatherSystem({
    scene,
    terrainMaterial: shaderTerrainMat ?? null,
    roadMaterial,
    liquidMaterials: () => liquidMaterials.values(),
    sky,
  });
  const WEATHER_TYPES: WeatherType[] = ['clear', 'rain', 'snow'];
  let weatherIndex = 0;

  // --- Wind ---
  // The weather built its own wind above; take it rather than making a second,
  // so the shower and the hillside under it agree on which way the air is
  // going. HexWorld does the same thing from the other side — it owns the wind
  // and hands it to the WeatherSystem it builds.
  const wind = weather.windField;
  wind.configure({ heading: Math.PI * 0.28, speed: 3.4 });
  let windEnabled = true;

  // Which scatter bends is the whole reason this is per-material: the three
  // plants take the patch and the rock does not. Amplitudes are per plant too —
  // a bush is short, soft and mostly leaf, so it moves far more of its own
  // height than a pine does, and a stiff conifer barely moves at all.
  attachWindSway(pineMat,      { height: 2.2, stiffness: 2.6, amplitude: 0.035, flutter: 0.2 });
  attachWindSway(broadleafMat, { height: 1.9, stiffness: 2.0, amplitude: 0.07 });
  attachWindSway(bushMat,      { height: 0.5, stiffness: 1.2, amplitude: 0.125, flutter: 0.6 });

  function* windMaterials(): Generator<THREE.Material> {
    yield pineMat; yield broadleafMat; yield bushMat;
    for (const set of liquidMaterials.values()) {
      for (const mat of [set.surface, set.shore, set.estuary, set.river, set.waterfallFoam, set.waterfallSpray]) {
        if (mat) yield mat;
      }
    }
  }

  // --- Seasons ---
  // The demo generates through plugins rather than the full pipeline, so there
  // is no temperature field lying around — recompute it from the map, which is
  // the same fallback a loaded or hand-authored map takes.
  const climate = new ClimateData(MAP_WIDTH, MAP_HEIGHT);
  // Opens in late spring: peaks already white, everything below them bare, so
  // there is somewhere for the snowline to descend from.
  //
  // Rebuildable rather than const because the scope is fixed at construction —
  // it decides how a year is computed, not how far through one we are, so [J]
  // makes a new cycle at the same point in the same year.
  let seasonScope: SeasonScope = 'continental';
  let seasons = new SeasonCycle({ dayLength: 90, daysPerYear: 6, phase: 0.38, paused: true });

  function* snowMaterials(): Generator<THREE.Material> {
    if (shaderTerrainMat) yield shaderTerrainMat;
    yield* scatterMats;
    for (const set of liquidMaterials.values()) {
      for (const mat of [set.surface, set.shore, set.estuary, set.river, set.waterfallFoam, set.waterfallSpray]) {
        if (mat) yield mat;
      }
    }
  }

  // Stock scatter materials need a snow path injected, exactly as they needed
  // a haze one above. Everything standing on the ground catches snow…
  for (const mat of scatterMats) attachSnow(mat);

  // …but only the deciduous plants turn with the year. That the pine does not
  // get this call is the entire reason it reads as a conifer in October.
  //
  // Both take an explicit `summer` reference because a vertexColors material's
  // own `color` is white, which would make a useless one — the palette is
  // applied relative to the surface's authored green (see FOLIAGE_GLSL).
  //
  // Blossom comes with the tint. Rather more than half the wood flowers, and
  // each tree lands somewhere between the two petal colors, so a spring hillside
  // reads as pinks and blues among the green rather than one repeated tree.
  attachSeasonalTint(broadleafMat, { summer: BROADLEAF_CANOPY_COLOR, blossomShare: 0.6 });
  // A bush is foliage all the way down, so skip the green test that keeps the
  // tint off a broadleaf's trunk. Scrub flowers more sparsely than the wood.
  attachSeasonalTint(bushMat, {
    summer: BUSH_COLOR, select: 0, variance: 0.35, blossomShare: 0.3,
  });

  for (const mat of snowMaterials()) {
    configureSeason(mat, climate, {
      snowTerrain: resolveSnowTerrain(DEMO_TERRAIN_DEFINITIONS),
      // Only the terrain takes a summer reference from here — the scatter
      // materials already carry their own, set at attach time.
      foliage: mat === shaderTerrainMat
        ? { summer: resolveFoliageColor(DEMO_TERRAIN_DEFINITIONS) }
        : undefined,
    });
  }

  // World rect the map-sized climate texture spans, so precipitation can look
  // up the cell under each falling particle.
  const c00 = hexToWorld(layout, offsetToHex(0, 0));
  const c11 = hexToWorld(layout, offsetToHex(MAP_WIDTH - 1, MAP_HEIGHT - 1));
  weather.setPrecipitationMask(climate.texture, {
    x:     Math.min(c00.x, c11.x) - HEX_SIZE,
    z:     Math.min(c00.z, c11.z) - HEX_SIZE,
    width: Math.abs(c11.x - c00.x) + HEX_SIZE * 2,
    depth: Math.abs(c11.z - c00.z) + HEX_SIZE * 2,
  });

  /** Repaint snow, ice and foliage for the current phase (scrubbing, or after a regenerate). */
  function refreshSeason(): void {
    seasons.apply(climate);
    climate.update();
    // The one seasonal input that isn't in the climate texture: which way the
    // year is going, which is all that separates spring green from autumn gold.
    for (const mat of snowMaterials()) setSeasonPhase(mat, seasons.phase);
  }

  /** Rebuild the base climate after a regenerate, then repaint. */
  function refreshClimate(): void {
    climate.setTemperature(computeTemperature(map, { elevationMax: 12 }));
    refreshSeason();
  }
  refreshClimate();

  // --- Scatter ---
  const hashGrid = new HexHashGrid(1234);

  // Four scatter layers, one per feature slot the generators fill: conifers,
  // rocks, broadleaf woods, and scrub. Every slot on the map is competed for by
  // whichever layers are eligible there, so the biome densities the generator
  // wrote come out as mixed woodland rather than four separate stands.
  const pineDefinition: ScatterDefinition = {
    id:         'pine-tree',
    name:       'Pine Tree',
    layerIndex: 0,
    tiers: [
      [{ geometry: createPineGeometry(2.0), material: pineMat, yOffset: 0 }],
      [{ geometry: createPineGeometry(1.5), material: pineMat, yOffset: 0 }],
      [{ geometry: createPineGeometry(1.0), material: pineMat, yOffset: 0 }],
    ],
  };

  const broadleafDefinition: ScatterDefinition = {
    id:           'broadleaf-tree',
    name:         'Broadleaf Tree',
    layerIndex:   2,
    tiltStrength: 0.05,
    tiers: [
      [{ geometry: createBroadleafGeometry(1.9), material: broadleafMat, yOffset: 0 }],
      [{ geometry: createBroadleafGeometry(1.4), material: broadleafMat, yOffset: 0 }],
      [{ geometry: createBroadleafGeometry(1.0), material: broadleafMat, yOffset: 0 }],
    ],
  };

  const bushDefinition: ScatterDefinition = {
    id:           'bush',
    name:         'Bush',
    layerIndex:   3,
    tiltStrength: 0.12,
    tiers: [
      [{ geometry: createBushGeometry(0.85), material: bushMat, yOffset: 0 }],
      [{ geometry: createBushGeometry(0.65), material: bushMat, yOffset: 0 }],
      [{ geometry: createBushGeometry(0.45), material: bushMat, yOffset: 0 }],
    ],
  };

  const rockDefinition: ScatterDefinition = {
    id:             'rock',
    name:           'Rock',
    layerIndex:     1,
    allowedTerrains: [TerrainType.Rock],
    tiltStrength:   0.35,
    tiers: [
      [{ geometry: new THREE.DodecahedronGeometry(0.28, 0), material: rockMat, yOffset: 0.14 }],
      [{ geometry: new THREE.DodecahedronGeometry(0.20, 0), material: rockMat, yOffset: 0.10 }],
      [{ geometry: new THREE.DodecahedronGeometry(0.13, 0), material: rockMat, yOffset: 0.06 }],
    ],
  };

  // --- Pathfinding overlay ---
  const MOVE_BUDGET = 4;

  const moveCost: MoveCostFn = (_from, to) => {
    const { col, row } = hexToOffset(to);
    if (!map.inBounds(col, row)) return Infinity;
    // When unexplored cells are hidden, treat them as impassable.
    if (hideUnexplored && fogData.rawData[(row * MAP_WIDTH + col) * 4 + 1] === 0) return Infinity;
    if (DEMO_WATER_TERRAINS.has(map.getTerrain(col, row))) return Infinity;
    return 1;
  };

  let lastHoveredForPath: { col: number; row: number } | null = null;

  const rangeMat = new THREE.MeshBasicMaterial({
    color: 0x4488ff, transparent: true, opacity: 0.25,
    depthWrite: false, depthTest: false, side: THREE.DoubleSide,
  });
  const rangeMesh = new THREE.Mesh(new THREE.BufferGeometry(), rangeMat);
  rangeMesh.renderOrder = 6;
  rangeMesh.visible = false;
  scene.add(rangeMesh);

  const pathLineMat = new THREE.LineBasicMaterial({ color: 0xffaa22, depthTest: false });
  const pathOverlay = new THREE.Line(new THREE.BufferGeometry(), pathLineMat);
  pathOverlay.renderOrder = 7;
  pathOverlay.visible = false;
  scene.add(pathOverlay);

  const selectedMat = new THREE.MeshBasicMaterial({
    color: 0x88ff44, transparent: true, opacity: 0.6,
    depthWrite: false, depthTest: false, side: THREE.DoubleSide,
  });
  const selectedMesh = new THREE.Mesh(indicatorGeo.clone(), selectedMat);
  selectedMesh.renderOrder = 8;
  selectedMesh.visible = false;
  scene.add(selectedMesh);

  function buildHighlightGeo(cells: { col: number; row: number }[], yOffset = 0.05): THREE.BufferGeometry {
    const verts: number[] = [];
    for (const { col, row } of cells) {
      const hex = offsetToHex(col, row);
      const wp  = hexToWorld(layout, hex);
      const y   = map.getElevation(col, row) * 0.5 + yOffset;
      const cs  = hexCorners(layout, hex);
      for (let i = 0; i < 6; i++) {
        const c1 = cs[i], c2 = cs[(i + 1) % 6];
        verts.push(wp.x, y, wp.z, c1.x, y, c1.z, c2.x, y, c2.z);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    return geo;
  }

  function updatePathPreview(target: { col: number; row: number }): void {
    if (lastHoveredForPath?.col === target.col && lastHoveredForPath?.row === target.row) return;
    lastHoveredForPath = target;
    if (!selectedUnit) return;
    const path = findPath(offsetToHex(selectedUnit.col, selectedUnit.row), offsetToHex(target.col, target.row), moveCost, map);
    pathOverlay.geometry.dispose();
    if (path && path.length > 1) {
      const pts = smoothPath(path, layout, map);
      const positions = new Float32Array(pts.length * 3);
      for (let i = 0; i < pts.length; i++) {
        positions[i * 3]     = pts[i].x;
        positions[i * 3 + 1] = pts[i].y + 0.15;
        positions[i * 3 + 2] = pts[i].z;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      pathOverlay.geometry = geo;
      pathOverlay.visible = true;
    } else {
      pathOverlay.geometry = new THREE.BufferGeometry();
      pathOverlay.visible = false;
    }
  }

  // --- Minimap ---
  const MINIMAP_SCALE   = 2;
  const MINIMAP_PADDING = 2;
  const MINIMAP_WIDTH   = 220; // CSS display width in px

  const minimapContainer = document.createElement('div');
  minimapContainer.style.cssText = `
    position: fixed; bottom: 12px; right: 12px;
    width: ${MINIMAP_WIDTH}px;
    border: 1px solid rgba(255,255,255,0.2); border-radius: 4px;
    overflow: hidden;
  `;
  document.body.appendChild(minimapContainer);

  // Two stacked canvases: the terrain redraws only when the map changes, the
  // viewport outline redraws every frame. Drawing straight into a canvas keeps
  // the whole thing off the Blob/object-URL path renderMapImage needs.
  const minimapCanvas = document.createElement('canvas');
  minimapCanvas.style.cssText = `display: block; width: 100%; height: auto; image-rendering: pixelated;`;
  minimapContainer.appendChild(minimapCanvas);

  const viewportCanvas = document.createElement('canvas');
  viewportCanvas.style.cssText = `position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;`;
  minimapContainer.appendChild(viewportCanvas);

  let minimapTransform: MapImageTransform | null = null;
  let minimapDimExplored    = true;
  let minimapHideUnexplored = true;

  function updateMinimap(): void {
    const t = getMapImageTransform(map, layout, { scale: MINIMAP_SCALE, padding: MINIMAP_PADDING });
    if (minimapCanvas.width !== t.width || minimapCanvas.height !== t.height) {
      minimapCanvas.width  = viewportCanvas.width  = t.width;
      minimapCanvas.height = viewportCanvas.height = t.height;
    }

    minimapTransform = drawMapImage(minimapCanvas.getContext('2d')!, map, layout, DEMO_TERRAIN_DEFINITIONS, {
      scale:              MINIMAP_SCALE,
      padding:            MINIMAP_PADDING,
      elevationShading:   0.05,
      rivers:             true,
      roads:              true,
      fog:                fogData,
      fogDimOpacity:      minimapDimExplored    ? 0.55 : 0,
      fogHideUnexplored:  minimapHideUnexplored,
    });
  }

  const footprint: THREE.Vector3[] = [
    new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
  ];
  const imagePoint = { x: 0, y: 0 };

  function drawViewportOverlay(): void {
    const t = minimapTransform;
    if (!t) return;
    const ctx = viewportCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, t.width, t.height);

    const quad = cameraGroundFootprint(camera, { maxDistance: controls.maxDist * 3 }, footprint);
    if (!quad) return;

    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      t.worldToImage(quad[i].x, quad[i].z, imagePoint);
      if (i === 0) ctx.moveTo(imagePoint.x, imagePoint.y);
      else         ctx.lineTo(imagePoint.x, imagePoint.y);
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth   = 2;
    ctx.stroke();
  }

  // Click anywhere on the minimap to send the camera there.
  minimapCanvas.addEventListener('pointerdown', e => {
    const t = minimapTransform;
    if (!t) return;
    const rect = minimapCanvas.getBoundingClientRect();
    const { x, z } = t.imageToWorld(
      ((e.clientX - rect.left) / rect.width)  * t.width,
      ((e.clientY - rect.top)  / rect.height) * t.height,
    );
    controls.panTo(x, z);
  });

  // --- Save / Load ---
  const SAVE_KEY = 'hexworld-save';
  // Exploration is per-player state, not map data, so it saves as its own blob
  // alongside the map. Territory and resources need no such key — they live in
  // the map's metadata channel and travel inside the map JSON.
  const FOG_KEY  = 'hexworld-fog';
  let saveStatus = localStorage.getItem(SAVE_KEY)
    ? 'Saved map available  [L] load'
    : 'No saved map';

  function saveMap(): void {
    const gen = GENERATORS[activeGenIndex];
    try {
      const json = serializeMapJSON(map, {
        name:        `${gen.name} — ${seed >>> 0}`,
        seed,
        generatorId: gen.id,
      }, {
        factions:            FACTIONS,
        resourceDescriptors: DEFAULT_RESOURCE_DESCRIPTORS,
      });
      localStorage.setItem(SAVE_KEY, json);
      localStorage.setItem(FOG_KEY, fogData.toBase64());
      const t = new Date();
      saveStatus = `Saved at ${t.toLocaleTimeString()}  [L] load`;
    } catch (e) {
      console.error('Save failed:', e);
      saveStatus = 'Save failed';
    }
  }

  function loadMap(): void {
    const json = localStorage.getItem(SAVE_KEY);
    if (!json) { saveStatus = 'No saved map'; return; }
    try {
      const { map: loaded, metadata } = deserializeMapJSON(json);
      if (loaded.width !== MAP_WIDTH || loaded.height !== MAP_HEIGHT) {
        saveStatus = `Load failed: map size mismatch (${loaded.width}×${loaded.height})`;
        return;
      }
      map.uint8.set(loaded.uint8);
      map.roadBits.set(loaded.roadBits);
      map.riverInBits.set(loaded.riverInBits);
      if (map.featureData && loaded.featureData) map.featureData.set(loaded.featureData);
      // Territory and resources came back inside the map's metadata channel.
      map.cellData.clear();
      for (const [ci, record] of loaded.cellData) map.cellData.set(ci, record);
      if (metadata.seed !== undefined) seed = metadata.seed;
      if (metadata.generatorId) {
        const idx = GENERATORS.findIndex(g => g.id === metadata.generatorId);
        if (idx >= 0) activeGenIndex = idx;
      }

      // Restore the remembered world if a fog blob was saved with it; otherwise
      // start this map unexplored.
      const fogBlob = localStorage.getItem(FOG_KEY);
      if (fogBlob) {
        fogData.loadBase64(fogBlob);
        unitManager.reapplyFog();
      } else {
        resetFog();
      }
      territory.refresh();
      resources.refresh();
      pathOverlay.geometry.dispose();
      pathOverlay.geometry = new THREE.BufferGeometry();
      pathOverlay.visible = false;
      lastHoveredForPath = null;
      chunkManager.dispose();
      saveStatus = `Loaded: ${metadata.name ?? 'map'}`;
      updateMinimap();
    } catch (e) {
      console.error('Load failed:', e);
      saveStatus = 'Load failed';
    }
  }

  // --- Fog of war ---
  const fogData = new FogData(MAP_WIDTH, MAP_HEIGHT);
  let hideUnexplored = true;
  let dimExplored    = true;

  const FOG_REVEAL_RANGE = 3;

  const chunkManager = new ChunkManager({
    map,
    layout,
    scene,
    material: terrainMaterial,
    liquidMaterials,
    chunkSize: CHUNK_SIZE,
    loadRadius: LOAD_RADIUS,
    geometryOptions: { colorMode: TERRAIN_COLOR_MODE },
    waterGeometryOptions: waterGeoOptions,
    roadMaterial,
    hashGrid,
    scatterDefinitions:  [pineDefinition, rockDefinition, broadleafDefinition, bushDefinition],
    terrainDefinitions:  DEMO_TERRAIN_DEFINITIONS,
    fogData,
  });

  // --- Units ---
  // Demo uses simple capsules. Real consumers attach loaded GLTF Object3Ds instead.

  /** BFS outward from (col, row) to find the nearest non-water cell. */
  function findSpawnCell(col: number, row: number): { col: number; row: number } {
    if (map.inBounds(col, row) && !DEMO_WATER_TERRAINS.has(map.getTerrain(col, row))) return { col, row };
    const candidates = getVisibleCells(offsetToHex(col, row), Math.max(MAP_WIDTH, MAP_HEIGHT), map);
    for (const c of candidates) {
      const oc = hexToOffset(c);
      if (map.inBounds(oc.col, oc.row) && !DEMO_WATER_TERRAINS.has(map.getTerrain(oc.col, oc.row))) return oc;
    }
    return { col, row };
  }

  // Each entry: preferred spawn (quadrant centre) + idle color.
  const UNIT_DEFS = [
    { col: Math.floor(MAP_WIDTH * 0.50), row: Math.floor(MAP_HEIGHT * 0.50), color: 0x4488ff },
    { col: Math.floor(MAP_WIDTH * 0.25), row: Math.floor(MAP_HEIGHT * 0.25), color: 0xff6622 },
    { col: Math.floor(MAP_WIDTH * 0.75), row: Math.floor(MAP_HEIGHT * 0.25), color: 0xaa44ff },
    { col: Math.floor(MAP_WIDTH * 0.25), row: Math.floor(MAP_HEIGHT * 0.75), color: 0x22ddaa },
  ];

  const units: HexUnit[] = [];
  const unitMeshes: THREE.Mesh[] = [];
  const unitManager = new UnitManager({ scene, map, layout, fogData });

  for (const def of UNIT_DEFS) {
    const mat   = new THREE.MeshLambertMaterial({ color: def.color });
    const mesh  = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 0.7, 4, 8), mat);
    mesh.castShadow = true;
    const spawn = findSpawnCell(def.col, def.row);
    const u = new HexUnit({ col: spawn.col, row: spawn.row, travelSpeed: 4, heightOffset: 0.6, fogRevealRange: FOG_REVEAL_RANGE });

    // Per-unit callbacks are for per-unit state — this one closes over the
    // unit's own material. Real consumers toggle GLTF AnimationMixer clips here.
    const idleColor = def.color;
    u.onMoveStart = () => mat.color.setHex(0xffffff);
    u.onMoveEnd   = () => mat.color.setHex(idleColor);

    units.push(u);
    unitMeshes.push(mesh);
    unitManager.addUnit(u, mesh);
  }

  // Everything that reacts the same way whichever unit moved subscribes once
  // on the manager instead of being re-wired onto every unit.
  const unitMoved = ({ unit }: { unit: HexUnit }): void => {
    if (selectedUnit === unit) { rangeNeedsUpdate = true; lastHoveredForPath = null; }
    updateMinimap();
  };
  unitManager.events.on('unitCellEnter', unitMoved);
  unitManager.events.on('unitMoveEnd',   unitMoved);

  // --- Flow field ---
  // The counterpart to the per-unit A* above: one Dijkstra sweep outward from
  // the destination, after which every unit reads its own route out of the same
  // field for the price of an array lookup. Four units here, but the cost of
  // the sweep is the same for four hundred.
  const flowField = new FlowField(map);
  let flowGoal: { col: number; row: number } | null = null;

  // Deliberately not `moveCost`: that one treats unexplored cells as impassable
  // while [E] is on, and the units spawn in four quadrants with only their own
  // surroundings revealed — a fog-gated field would leave most of the army
  // standing still and hide the thing this is here to show. A rally order is a
  // reasonable place for a game to path on known-good ground anyway; the field
  // takes whichever rules you hand it.
  const flowCost: MoveCostFn = (_from, to) => {
    const { col, row } = hexToOffset(to);
    if (!map.inBounds(col, row)) return Infinity;
    return DEMO_WATER_TERRAINS.has(map.getTerrain(col, row)) ? Infinity : 1;
  };

  // Arrows are drawn only near the goal — the field itself covers the whole
  // map, but 20 000 arrows is a wall of blue, not a picture of a flow.
  const FLOW_ARROW_RANGE = 18;

  // Same recipe as the path preview line, which is the overlay in this demo
  // that is known to read against every terrain: opaque, depth-tested off.
  const flowArrowMat = new THREE.LineBasicMaterial({ color: 0x22ffff, depthTest: false });
  const flowArrows = new THREE.LineSegments(new THREE.BufferGeometry(), flowArrowMat);
  flowArrows.renderOrder = 6;
  flowArrows.visible = false;
  scene.add(flowArrows);

  function clearFlowField(): void {
    flowGoal = null;
    flowArrows.geometry.dispose();
    flowArrows.geometry = new THREE.BufferGeometry();
    flowArrows.visible  = false;
  }

  function rebuildFlowArrows(): void {
    const verts: number[] = [];
    flowField.forEachReached((col, row, cost) => {
      if (cost === 0 || cost > FLOW_ARROW_RANGE) return;
      // flowVector, not the raw direction index: the blended bearing is what
      // shows the field curving around an obstacle rather than snapping to one
      // of six axes.
      const v = flowField.flowVector(layout, offsetToHex(col, row));
      if (!v) return;

      const wp = hexToWorld(layout, offsetToHex(col, row));
      const y  = map.getElevation(col, row) * 0.5 + 0.12;
      const half = 0.42;
      const tipX = wp.x + v.x * half, tipZ = wp.z + v.z * half;
      const tailX = wp.x - v.x * half, tailZ = wp.z - v.z * half;
      verts.push(tailX, y, tailZ, tipX, y, tipZ);

      // Two barbs, the flow vector rotated ±150° about Y.
      for (const a of [2.618, -2.618]) {
        const bx = v.x * Math.cos(a) - v.z * Math.sin(a);
        const bz = v.x * Math.sin(a) + v.z * Math.cos(a);
        verts.push(tipX, y, tipZ, tipX + bx * 0.26, y, tipZ + bz * 0.26);
      }
    });

    flowArrows.geometry.dispose();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    flowArrows.geometry = geo;
    flowArrows.visible  = verts.length > 0;
  }

  /** Re-targets the field and marches every unit at once. */
  function setFlowGoal(target: { col: number; row: number }): void {
    flowGoal = target;
    // compute() reuses the field's buffers, so re-targeting allocates nothing.
    flowField.compute(offsetToHex(target.col, target.row), flowCost);
    rebuildFlowArrows();

    for (const u of units) {
      const path = flowField.path(offsetToHex(u.col, u.row));
      if (path && path.length > 1) u.travel(path);
    }
  }

  // Focus camera on the first unit's actual spawn position so the first frame
  // renders on terrain rather than empty sky.
  controls.snapTo(units[0].worldX, units[0].worldZ);

  // --- Territory + resources ---
  // Both live in the map's metadata channel, so they ride through [S]/[L]
  // saves with no companion file of their own.
  const overlays = new CellOverlayLayer({
    parent:  scene,
    layout,
    map,
    isWater: t => DEMO_WATER_TERRAINS.has(t),
  });

  // One faction per unit, sharing its color, so it's obvious who holds what.
  const FACTIONS: FactionDescriptor[] = UNIT_DEFS.map((def, i) => ({
    id:    `faction-${i}`,
    name:  ['Kelmar', 'Ossiran', 'Vashti', 'Tal Meren'][i] ?? `Faction ${i}`,
    color: def.color,
  }));

  const territory = new TerritoryLayer({ overlays, map, factions: FACTIONS });
  let territoryVisible = true;

  const TERRITORY_RADIUS = 4;

  /**
   * Claim a falloff-weighted region around each unit. Where two claims overlap
   * the cell ends up contested and the fill blends between both faction colors —
   * which is the point of the influence model.
   */
  function seedTerritory(): void {
    territory.clear();
    const weights = new Map<number, Record<string, number>>();
    units.forEach((unit, i) => {
      const center = offsetToHex(unit.col, unit.row);
      for (const hex of hexRange(center, TERRITORY_RADIUS)) {
        const { col, row } = hexToOffset(hex);
        if (!map.inBounds(col, row)) continue;
        if (DEMO_WATER_TERRAINS.has(map.getTerrain(col, row))) continue;
        const weight = TERRITORY_RADIUS + 1 - hexDistance(center, hex);
        const ci = row * MAP_WIDTH + col;
        const record = weights.get(ci) ?? {};
        record[FACTIONS[i].id] = (record[FACTIONS[i].id] ?? 0) + weight;
        weights.set(ci, record);
      }
    });
    for (const [ci, record] of weights) {
      territory.setInfluence(ci % MAP_WIDTH, (ci / MAP_WIDTH) | 0, record);
    }
    territory.refresh();
  }

  const resources = new ResourceLayer({
    parent:  scene,
    layout,
    map,
    descriptors: DEFAULT_RESOURCE_DESCRIPTORS,
    isWater: t => DEMO_WATER_TERRAINS.has(t),
    fogData,
  });
  let resourcesVisible = true;

  function seedResources(): void {
    generateResources(map, DEFAULT_RESOURCE_DESCRIPTORS, seed, {
      isWater: t => DEMO_WATER_TERRAINS.has(t),
    });
    resources.refresh();
  }

  /** "Kelmar 37, Ossiran 34, …" — cell counts per faction. */
  function territorySummary(): string {
    const counts = territory.cellCounts();
    const parts = FACTIONS
      .map(f => ({ name: f.name, n: counts.get(f.id) ?? 0 }))
      .filter(e => e.n > 0)
      .map(e => `${e.name} ${e.n}`);
    return parts.length > 0 ? parts.join(', ') : 'unclaimed';
  }

  /** "ore 21, fish 14, …" — deposit counts per resource type. */
  function resourceSummary(): string {
    const counts = resources.counts();
    const parts = DEFAULT_RESOURCE_DESCRIPTORS
      .map(d => ({ id: d.id, n: counts.get(d.id) ?? 0 }))
      .filter(e => e.n > 0)
      .map(e => `${e.id} ${e.n}`);
    return parts.length > 0 ? parts.join(', ') : 'none';
  }

  let rangeNeedsUpdate = true;
  let selectedUnit: HexUnit | null = null;

  function selectUnit(u: HexUnit): void {
    selectedUnit = u;
    rangeNeedsUpdate = true;
  }

  function deselectUnit(): void {
    selectedUnit = null;
    rangeMesh.geometry.dispose();
    rangeMesh.geometry = new THREE.BufferGeometry();
    rangeMesh.visible  = false;
    selectedMesh.visible = false;
    pathOverlay.geometry.dispose();
    pathOverlay.geometry = new THREE.BufferGeometry();
    pathOverlay.visible  = false;
    lastHoveredForPath   = null;
  }

  function resetFog(): void {
    fogData.reset();
    unitManager.reapplyFog();
  }

  function resetUnits(): void {
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      u.stop();
      const spawn = findSpawnCell(UNIT_DEFS[i].col, UNIT_DEFS[i].row);
      u.col = spawn.col;
      u.row = spawn.row;
      u.update(0, map, layout);
      unitMeshes[i].position.set(u.worldX, u.worldY, u.worldZ);
    }
    deselectUnit();
    clearFlowField();
  }

  // --- Keyboard shortcuts ---
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      deselectUnit();
      clearFlowField();
    } else if (e.key === 'a' || e.key === 'A') {
      // Auto-repeat has to be dropped, not just tolerated: held for a moment
      // this fires every ~30 ms, and each one re-issued the march and rebuilt
      // the arrows. It used to toggle on a repeat press, which meant the second
      // auto-repeat wiped the field a quarter-second after the first drew it —
      // the units kept walking on the orders they already had, and the arrows
      // vanished before anyone saw them. [A] now only ever re-targets; [Esc]
      // clears.
      if (!e.repeat && hoverCell && !DEMO_WATER_TERRAINS.has(map.getTerrain(hoverCell.col, hoverCell.row))) {
        setFlowGoal(hoverCell);
      }
    } else if (e.key === 'r' || e.key === 'R') {
      seed = Math.floor(Math.random() * 0xffffffff);
      runGenerator();
      resetUnits();
      resetFog();
      seedResources();
      seedTerritory();
      // New terrain means new latitudes and elevations under the snowline.
      refreshClimate();
      chunkManager.dispose();
      // New elevations mean a new contour along the rim and a new floor depth.
      skirt.rebuild();
      updateMinimap();
    } else if (e.key === 'g' || e.key === 'G') {
      activeGenIndex = (activeGenIndex + 1) % GENERATORS.length;
      runGenerator();
      resetUnits();
      resetFog();
      seedResources();
      seedTerritory();
      // New terrain means new latitudes and elevations under the snowline.
      refreshClimate();
      chunkManager.dispose();
      // New elevations mean a new contour along the rim and a new floor depth.
      skirt.rebuild();
      updateMinimap();
    } else if (e.key === 'e' || e.key === 'E') {
      hideUnexplored = !hideUnexplored;
      chunkManager.setHideUnexplored(hideUnexplored);
      resources.setHideUnexplored(hideUnexplored);
    } else if (e.key === 'f' || e.key === 'F') {
      dimExplored = !dimExplored;
      chunkManager.setDimExplored(dimExplored);
      resources.setDimExplored(dimExplored);
    } else if (e.key === 't' || e.key === 'T') {
      territoryVisible = !territoryVisible;
      territory.setVisible(territoryVisible);
    } else if (e.key === 'u' || e.key === 'U') {
      resourcesVisible = !resourcesVisible;
      resources.setVisible(resourcesVisible);
    } else if (e.key === 'c' || e.key === 'C') {
      if (selectedUnit) controls.panTo(selectedUnit.worldX, selectedUnit.worldZ);
    } else if (e.key === 's' || e.key === 'S') {
      saveMap();
    } else if (e.key === 'l' || e.key === 'L') {
      loadMap();
    } else if (e.key === 'h' || e.key === 'H') {
      if (terrainMaterial instanceof THREE.ShaderMaterial) {
        gridVisible = !gridVisible;
        configureTerrainGrid(terrainMaterial, layout, { enabled: gridVisible });
      }
    } else if (e.key === 'b' || e.key === 'B') {
      if (terrainMaterial instanceof THREE.ShaderMaterial) {
        strataVisible = !strataVisible;
        setCliffStrataEnabled(terrainMaterial, strataVisible);
      }
    } else if (e.key === 'o' || e.key === 'O') {
      sunRig.setEnabled(!sunRig.enabled);
    } else if (e.key === 'k' || e.key === 'K') {
      skyVisible = !skyVisible;
      sky.setEnabled(skyVisible);
    } else if (e.key === 'x' || e.key === 'X') {
      godRays.setEnabled(!godRays.enabled);
    } else if (e.key === 'i' || e.key === 'I') {
      skirtVisible = !skirtVisible;
      skirt.setEnabled(skirtVisible);
    } else if (e.key === 'y' || e.key === 'Y') {
      // Swing to face the sun and drop to the shallowest tilt — the shafts are
      // a low-sun effect, so without this you have to go looking for the one
      // heading and hour they happen at.
      const s = dayNight.evaluate();
      controls.rotateTo(Math.atan2(-s.sunDir.x, -s.sunDir.z) * 180 / Math.PI);
      controls.tiltTo(controls.minPitchDeg);
    } else if (e.key === 'n' || e.key === 'N') {
      dayNight.paused = !dayNight.paused;
    } else if (e.key === ',') {
      dayNight.setTime(dayNight.time - 1 / 48);
      applyDayNight();
    } else if (e.key === '.') {
      dayNight.setTime(dayNight.time + 1 / 48);
      applyDayNight();
    } else if (e.key === 'm' || e.key === 'M') {
      weatherIndex = (weatherIndex + 1) % WEATHER_TYPES.length;
      weather.setWeather(WEATHER_TYPES[weatherIndex]);
    } else if (e.key === 'p' || e.key === 'P') {
      scatterTexture = !scatterTexture;
      for (const mat of scatterMats) setScatterTextureEnabled(mat, scatterTexture);
    } else if (e.key === 'w' || e.key === 'W') {
      windEnabled = !windEnabled;
    } else if (e.key === 'q' || e.key === 'Q') {
      // Swing the wind a sixth of a turn — the fastest way to see that the
      // trees, the rain and the ripples all take the same vector.
      wind.setPolar(wind.heading + Math.PI / 3, wind.speed);
    } else if (e.key === 'v' || e.key === 'V') {
      seasons.paused = !seasons.paused;
    } else if (e.key === 'j' || e.key === 'J') {
      // Same year, same moment in it — only the question of whether this map is
      // a subcontinent or one valley.
      seasonScope = seasonScope === 'continental' ? 'local' : 'continental';
      seasons = new SeasonCycle({
        dayLength: 90, daysPerYear: 6, scope: seasonScope,
        phase: seasons.phase, paused: seasons.paused,
      });
      refreshSeason();
    } else if (e.key === '[') {
      seasons.setPhase(seasons.phase - 1 / 24);
      refreshSeason();
    } else if (e.key === ']') {
      seasons.setPhase(seasons.phase + 1 / 24);
      refreshSeason();
    } else if (e.key === '1') {
      minimapDimExplored = !minimapDimExplored;
      updateMinimap();
    } else if (e.key === '2') {
      minimapHideUnexplored = !minimapHideUnexplored;
      updateMinimap();
    }
  });

  // Capture-phase handler runs before the camera controller's bubble-phase pan handler,
  // so we can consume the right-click and prevent a pan from starting.
  renderer.domElement.addEventListener('mousedown', (e) => {
    if (e.button === 2 && selectedUnit) {
      deselectUnit();
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);

  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !hoverCell) return;
    if (DEMO_WATER_TERRAINS.has(map.getTerrain(hoverCell.col, hoverCell.row))) return;

    const cell = hoverCell;
    const clickedUnit = units.find(u => u.col === cell.col && u.row === cell.row);
    if (clickedUnit) {
      if (selectedUnit === clickedUnit) deselectUnit(); else selectUnit(clickedUnit);
      return;
    }

    if (!selectedUnit) return;

    const path = findPath(
      offsetToHex(selectedUnit.col, selectedUnit.row),
      offsetToHex(hoverCell.col, hoverCell.row),
      moveCost, map,
    );
    if (path && path.length > 1) {
      selectedUnit.travel(path);
      pathOverlay.geometry.dispose();
      pathOverlay.geometry = new THREE.BufferGeometry();
      pathOverlay.visible  = false;
      lastHoveredForPath   = null;
    }
  });

  seedResources();
  seedTerritory();
  updateMinimap();

  // --- Render loop ---
  let lastFrameTime = performance.now();

  function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const dt  = Math.min((now - lastFrameTime) / 1000, 0.1); // cap at 100 ms
    lastFrameTime = now;

    controls.update();
    if (!dayNight.paused) {
      dayNight.advance(dt);
      applyDayNight();
    }
    if (!seasons.paused) {
      seasons.advance(dt);
      // Eased rather than snapped, so snow visibly creeps down the slopes.
      seasons.apply(climate, dt);
      climate.update();
      for (const mat of snowMaterials()) setSeasonPhase(mat, seasons.phase);
    }
    // weather.update advances the wind itself (it owns this one), so this only
    // has to carry the result out to everything that isn't weather.
    weather.update(dt, controls.targetPosition);
    setMaterialWind(windMaterials(), windEnabled ? wind : null);
    sky.update(camera, dt);
    sunRig.update(camera);
    unitManager.update(dt);
    chunkManager.update(camera, dt);
    // No-ops unless a claim or placement changed since the last frame.
    territory.update();
    resources.update();

    frameCount++;
    const elapsed = now - lastFpsTime;
    if (elapsed >= 500) {
      fps        = Math.round((frameCount / elapsed) * 1000);
      frameCount = 0;
      lastFpsTime = now;
    }

    // Lazy-rebuild movement-range highlight when selected unit enters a new cell.
    if (rangeNeedsUpdate && selectedUnit) {
      const reachable = getMovementRange(offsetToHex(selectedUnit.col, selectedUnit.row), MOVE_BUDGET, moveCost, map);
      rangeMesh.geometry.dispose();
      rangeMesh.geometry = buildHighlightGeo(reachable.map(h => hexToOffset(h)), 0.04);
      rangeMesh.visible  = true;

      const uwp = hexToWorld(layout, offsetToHex(selectedUnit.col, selectedUnit.row));
      selectedMesh.position.set(uwp.x, map.getElevation(selectedUnit.col, selectedUnit.row) * 0.5 + 0.03, uwp.z);
      selectedMesh.visible = true;

      rangeNeedsUpdate = false;
    }

    // Cell picking — raycast against actual terrain meshes for accurate results.
    const picked = pickHexFromMeshes(lastMouseX, lastMouseY, renderer.domElement, camera, layout, map, chunkManager.terrainMeshes);
    hoverCell = picked;
    if (picked) {
      const wp = hexToWorld(layout, offsetToHex(picked.col, picked.row));
      hoverMesh.position.set(wp.x, map.getElevation(picked.col, picked.row) * 0.5 + 0.02, wp.z);
      hoverMesh.visible = true;
      if (selectedUnit && !selectedUnit.isMoving) updatePathPreview(picked);
    } else {
      hoverMesh.visible = false;
    }

    const gen = GENERATORS[activeGenIndex];
    const losStr = (selectedUnit && hoverCell)
      ? '  LOS: ' + (hasLineOfSight(offsetToHex(selectedUnit.col, selectedUnit.row), offsetToHex(hoverCell.col, hoverCell.row), map) ? 'yes' : 'blocked')
      : '';
    const hoverLine = hoverCell
      ? `Hover:     [${hoverCell.col}, ${hoverCell.row}]  ` +
        `${TERRAIN_NAMES[map.getTerrain(hoverCell.col, hoverCell.row)] ?? '?'}  ` +
        `elev ${map.getElevation(hoverCell.col, hoverCell.row)}${losStr}`
      : `Hover:     —`;
    const unitLine = selectedUnit
      ? `Unit:      [${selectedUnit.col}, ${selectedUnit.row}]  ${selectedUnit.isMoving ? 'moving' : 'selected — click to move'}  [Esc] deselect  [C] focus`
      : `Units:     ${units.length} on map — click one to select`;
    const flowLine = flowGoal
      ? `Flow field: goal [${flowGoal.col}, ${flowGoal.row}]  ${flowField.reachedCount} cells in one sweep  ` +
        `— all ${units.length} units marching  [A] re-target  [Esc] clear`
      : `Flow field: [A] send every unit to the hovered cell from one Dijkstra sweep`;
    hud.textContent =
      `FPS:       ${fps}\n` +
      `Generator: ${gen.name}  [G] cycle\n` +
      `Seed:      ${seed >>> 0}  [R] new\n` +
      `Map:       ${MAP_WIDTH} × ${MAP_HEIGHT} cells\n` +
      `Chunks:    ${chunkManager.loadedChunkCount} loaded  (${CHUNK_SIZE}×${CHUNK_SIZE} cells each)\n` +
      `Total:     ${chunkManager.chunksX * chunkManager.chunksY} chunks in map\n` +
      `Zoom:      ${controls.currentDistance.toFixed(1)}  (min ${controls.minDist} / max ${controls.maxDist})\n` +
      `Tilt:      ${controls.currentPitchDeg.toFixed(1)}°  (min ${controls.minPitchDeg}° / max ${controls.maxPitchDeg}°)  middle-drag up/down\n` +
      `Heading:   ${controls.currentYawDeg.toFixed(0)}°  middle-drag left/right\n` +
      `Hex grid:  ${gridVisible ? 'ON  [H] toggle' : 'OFF  [H] toggle'}\n` +
      `Strata:    ${strataVisible ? 'ON  [B] toggle' : 'OFF [B] toggle'}\n` +
      `Shadows:   ${sunRig.enabled ? 'ON  [O] toggle' : 'OFF [O] toggle'}\n` +
      `Time:      ${formatTimeOfDay(dayNight.time)}  ${dayNight.paused ? 'paused' : 'running'}  [N] play/pause  [,][.] scrub\n` +
      `Weather:   ${weather.type}  [M] cycle  (overcast ${weather.overcast.toFixed(2)})\n` +
      `Scatter tex: ${scatterTexture ? 'ON  [P] toggle' : 'OFF [P] toggle'}\n` +
      `Wind:      ${windEnabled ? 'ON  [W] toggle' : 'OFF [W] toggle'}  ` +
        `${(((wind.heading * 180 / Math.PI) % 360) + 360) % 360 | 0}° [Q] veer  ` +
        `${wind.speed.toFixed(1)} u/s, gust ×${wind.gust.toFixed(2)}\n` +
      `Season:    ${formatSeason(seasons.phase)}  ${seasons.paused ? 'paused' : 'running'}  [V] play/pause  [ [ ][ ] ] scrub\n` +
      `Scope:     ${seasonScope === 'local' ? 'whole map' : 'continental'}  [J] toggle\n` +
      `Sky:       ${skyVisible ? 'ON  [K] toggle' : 'OFF [K] toggle'}\n` +
      `Map skirt: ${skirtVisible ? 'ON  [I] toggle' : 'OFF [I] toggle'}  (base y ${skirt.baseY.toFixed(1)})\n` +
      `God rays:  ${godRays.enabled ? 'ON  [X] toggle' : 'OFF [X] toggle'}  (strength ${godRays.strength.toFixed(2)})  [Y] face the sun\n` +
      `Hide unexplored: ${hideUnexplored ? 'ON  [E] toggle' : 'OFF  [E] toggle'}\n` +
      `Dim explored:    ${dimExplored    ? 'ON  [F] toggle' : 'OFF  [F] toggle'}\n` +
      `Explored:  ${fogData.exploredCount} / ${MAP_WIDTH * MAP_HEIGHT} cells\n` +
      `Territory: ${territoryVisible ? 'ON  [T] toggle' : 'OFF [T] toggle'}  ${territorySummary()}\n` +
      `Resources: ${resourcesVisible ? 'ON  [U] toggle' : 'OFF [U] toggle'}  ${resourceSummary()}\n` +
      `Save: [S]  Load: [L]  ${saveStatus}\n` +
      `Minimap fog dim: ${minimapDimExplored    ? 'ON  [1] toggle' : 'OFF  [1] toggle'}\n` +
      `Minimap unexplored: ${minimapHideUnexplored ? 'ON  [2] toggle' : 'OFF  [2] toggle'}\n` +
      `\n${unitLine}\n${flowLine}\n${hoverLine}`;

    renderer.render(scene, camera);
    // After the frame, never through it — the canvas keeps its MSAA.
    godRays.render(renderer, scene, camera);
    drawViewportOverlay();
  }
  animate();
}

start();
