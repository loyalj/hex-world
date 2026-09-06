/**
 * Fixed scenes for the visual snapshot harness (see `visual.test.ts`).
 *
 * Every scene is deterministic by construction: seeded generation or a
 * hand-built map, a paused clock, no weather, no wind, no worker, and a
 * settle step that pumps the chunk streamer until nothing is left to build
 * before the one frame that is captured. Anything time-based (water uTime,
 * fog reveals) is left at zero.
 *
 * Add a scene by adding an entry to `SCENES`; the test picks it up by name
 * and the golden lands in `__snapshots__/<name>.png` on the next update run.
 */
import * as THREE from 'three';
import {
  HexMap, HexWorld, TerrainType,
  DEFAULT_TERRAIN_DESCRIPTORS, VOLCANIC_ASH_TERRAIN_DESCRIPTOR,
  generateMap, generateRoads, LiquidShowcasePlugin,
  createPineGeometry, createSmokeGeometry, createBroadleafGeometry, BROADLEAF_CANOPY_COLOR,
  offsetNeighbor, offsetToHex, hexToWorld,
  POINTY_TOP,
  setPort, listPorts, isShoreCell,
  resolveScatterAssets, resolveScatterDefinition, PALM_RECIPE, BUSH_RECIPE,
  type ScatterAssetDescriptor, type ScatterDescriptor,
  type ScatterDefinition, type HexWorldOptions,
} from '../../src/index.js';

const STAGE = document.getElementById('stage') as HTMLDivElement;

const TERRAINS = [
  ...DEFAULT_TERRAIN_DESCRIPTORS,
  { index: 7, id: 'lava', name: 'Lava', color: 0xd44010, liquidType: 'lava', texture: { type: 'procedural' as const } },
  // The showcase island's acid swamp spans two indices of one liquid.
  { index: 8, id: 'acid',      name: 'Acid',      color: 0x55cc22, liquidType: 'acid', texture: { type: 'procedural' as const } },
  { index: 9, id: 'acid-deep', name: 'Deep Acid', color: 0x2f7a12, liquidType: 'acid', texture: { type: 'procedural' as const } },
  VOLCANIC_ASH_TERRAIN_DESCRIPTOR,
];

const EDGE_DIRS = POINTY_TOP.edgeDirections;

/** Link consecutive cells with a river, resolving the face between each pair. */
function riverChain(map: HexMap, cells: [number, number][]): void {
  for (let i = 0; i + 1 < cells.length; i++) {
    const [c, r]   = cells[i];
    const [nc, nr] = cells[i + 1];
    for (let f = 0; f < 6; f++) {
      const nb = offsetNeighbor(c, r, EDGE_DIRS[f]);
      if (nb.col === nc && nb.row === nr) {
        map.setRiverOutgoing(c, r, f);
        map.setRiverIncoming(nc, nr, (f + 3) % 6);
        break;
      }
    }
  }
}

function scatterDefs(withSmoke: boolean): ScatterDefinition[] {
  const pineMat  = new THREE.MeshLambertMaterial({ color: 0x2f6b3a });
  const leafMat  = new THREE.MeshLambertMaterial({ vertexColors: true });
  const smokeMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false });
  const defs: ScatterDefinition[] = [
    { id: 'pine', name: 'Pine', layerIndex: 0, tiers: [
      [{ geometry: createPineGeometry(2.0), material: pineMat, yOffset: 0 }],
      [{ geometry: createPineGeometry(1.5), material: pineMat, yOffset: 0 }],
      [{ geometry: createPineGeometry(1.0), material: pineMat, yOffset: 0 }],
    ] },
    { id: 'broadleaf', name: 'Broadleaf', layerIndex: 2, tiers: [
      [{ geometry: createBroadleafGeometry(1.9, { foliageColor: BROADLEAF_CANOPY_COLOR }), material: leafMat, yOffset: 0 }],
      [{ geometry: createBroadleafGeometry(1.4, { foliageColor: BROADLEAF_CANOPY_COLOR }), material: leafMat, yOffset: 0 }],
      [{ geometry: createBroadleafGeometry(1.0, { foliageColor: BROADLEAF_CANOPY_COLOR }), material: leafMat, yOffset: 0 }],
    ] },
  ];
  if (withSmoke) {
    defs.push({ id: 'smoke', name: 'Smoke', layerIndex: 4, tiers: [
      [{ geometry: createSmokeGeometry(3.0), material: smokeMat, yOffset: 0 }],
      [{ geometry: createSmokeGeometry(2.2), material: smokeMat, yOffset: 0 }],
      [{ geometry: createSmokeGeometry(1.5), material: smokeMat, yOffset: 0 }],
    ] });
  }
  return defs;
}

interface SceneView { col: number; row: number; distance: number; pitch: number; yaw?: number }

const WATER_ONLY = (t: number): boolean => t === TerrainType.Water;

/** Shore cells ordered by distance from the map's centre — where a dock is worth looking at. */
function shoreNearCentre(map: HexMap): { col: number; row: number }[] {
  const cx = map.width / 2, cy = map.height / 2;
  const shore: { col: number; row: number; d: number }[] = [];
  map.forEach((c, r) => {
    if (isShoreCell(map, c, r, WATER_ONLY)) shore.push({ col: c, row: r, d: Math.hypot(c - cx, r - cy) });
  });
  return shore.sort((a, b) => a.d - b.d).map(({ col, row }) => ({ col, row }));
}

/** Centre of every cell of one terrain — how a seeded scene finds its volcano. */
function centroidOf(map: HexMap, terrain: number): { col: number; row: number } {
  let n = 0, sc = 0, sr = 0;
  map.forEach((c, r) => { if (map.getTerrain(c, r) === terrain) { n++; sc += c; sr += r; } });
  return n ? { col: Math.round(sc / n), row: Math.round(sr / n) } : { col: map.width >> 1, row: map.height >> 1 };
}

interface SceneDef {
  map(): HexMap;
  /** Camera target in cell coordinates (or derived from the map), distance, pitch and yaw in degrees. */
  view: SceneView | ((map: HexMap) => SceneView);
  world?: Partial<HexWorldOptions>;
  time?: number;
  smoke?: boolean;
  /** Use the data-driven scatter set instead of the code-built one. */
  scatter?: 'palms';
}

const PALM_ASSETS: ScatterAssetDescriptor[] = [
  { id: 'palm', name: 'Palm', type: 'shape', recipe: PALM_RECIPE, material: { doubleSide: true, windSway: true, scatterTexture: 0.5 } },
  { id: 'scrub', name: 'Scrub', type: 'shape', recipe: BUSH_RECIPE, material: { seasonalTint: true } },
];
const PALM_DESCRIPTORS: ScatterDescriptor[] = [
  { id: 'palms', name: 'Palms', layerIndex: 0, tiltStrength: 0.12, placement: { shore: true, maxElevation: 2 },
    tiers: [[{ assetId: 'palm', yOffset: 0 }], [{ assetId: 'palm', yOffset: 0, scale: 0.8 }], [{ assetId: 'palm', yOffset: 0, scale: 0.6 }]] },
  { id: 'scrub', name: 'Scrub', layerIndex: 3, tiltStrength: 0.1,
    tiers: [[{ assetId: 'scrub', yOffset: 0 }], [{ assetId: 'scrub', yOffset: 0, scale: 0.8 }], [{ assetId: 'scrub', yOffset: 0, scale: 0.6 }]] },
];
function palmDefs(): ScatterDefinition[] {
  const registry = resolveScatterAssets(PALM_ASSETS);
  return PALM_DESCRIPTORS.map(d => resolveScatterDefinition(d, registry, { isLiquid: WATER_ONLY }));
}

const SCENES: Record<string, SceneDef> = {
  /**
   * A plateau with two rivers — one straight down a column, one with a gentle
   * bend — and a road grid crossing both, so every deck case is on screen:
   * straight crossing, bend crossing, and a road that ends at a bank.
   */
  'roads-bridges': {
    map() {
      const map = new HexMap({ width: 18, height: 14, featureLayerCount: 4 });
      map.forEach((c, r) => {
        map.setTerrain(c, r, TerrainType.Grassland);
        map.setElevation(c, r, r < 5 ? 3 : 2);
      });
      // Straight river down column 8, top to bottom (odd-r offset: alternate faces).
      const straight: [number, number][] = [];
      for (let r = 0; r < 14; r++) straight.push([8, r]);
      riverChain(map, straight);
      // Bending river across the right half.
      riverChain(map, [[16, 1], [15, 2], [15, 3], [14, 4], [14, 5], [13, 6], [13, 7], [13, 8], [12, 9], [12, 10], [11, 11], [11, 12], [11, 13]]);
      generateRoads(map, { gridSpacing: 4 });
      // A road that reaches the straight river and stops: a jetty, no deck.
      map.setRoadEdge(6, 12, 0, true, POINTY_TOP);
      map.setRoadEdge(7, 12, 0, true, POINTY_TOP);
      map.computeWaterSurfaces();
      return map;
    },
    view: { col: 9, row: 7, distance: 17, pitch: 52 },
    world: { shadows: true },
  },

  /** A seeded continent with one volcano crowning its range, ash apron and smoke included. */
  volcano: {
    map() {
      const map = new HexMap({ width: 48, height: 32, featureLayerCount: 5 });
      generateMap(map, {
        landPercentage: 70, mountainRanges: 1, rangeUplift: 5, erosionPercentage: 40,
        volcanoes: 1, volcanoRadius: 5, volcanoHeight: 6,
        volcanoLavaTerrain: 7, volcanoAshTerrain: VOLCANIC_ASH_TERRAIN_DESCRIPTOR.index, volcanoSmokeLayer: 4,
        rivers: { riverPercentage: 12 },
        roads: { gridSpacing: 16 },
      }, 20260906);
      return map;
    },
    view: map => ({ ...centroidOf(map, 7), distance: 26, pitch: 46, yaw: 20 }),
    smoke: true,
  },

  /** The map's corner from a low tilt: the skirt, its strata, and the horizon behind it. */
  'skirt-edge': {
    map() {
      const map = new HexMap({ width: 32, height: 24, featureLayerCount: 4 });
      generateMap(map, { landPercentage: 75, mountainRanges: 1, roads: { gridSpacing: 12 } }, 4242);
      return map;
    },
    view: { col: 4, row: 20, distance: 22, pitch: 22, yaw: 35 },
    world: { skirt: true, sky: true },
    time: 0.32,
  },

  /** Every liquid case the showcase island exercises, at a size that fits one frame. */
  liquids: {
    map() {
      const map = new HexMap({ width: 60, height: 40, featureLayerCount: 4 });
      LiquidShowcasePlugin.generate(map, LiquidShowcasePlugin.defaultConfig, 99);
      return map;
    },
    view: { col: 30, row: 22, distance: 44, pitch: 50 },
  },

  /**
   * Scatter from data: a palm recipe and a bush recipe resolved through
   * asset descriptors, the palms held to the shore by a placement rule and
   * sized per tier by `scale`. What the editor's scatter builder produces.
   */
  'palm-coast': {
    map() {
      const map = new HexMap({ width: 24, height: 18, featureLayerCount: 4 });
      generateMap(map, { landPercentage: 55, roads: { gridSpacing: 8 } }, 777);
      // Palms everywhere the rule allows: paint the layer dense and let
      // `placement.shore` do the choosing.
      map.forEach((c, r) => { map.setFeatureLevel(c, r, 0, 3); map.setFeatureLevel(c, r, 2, 0); });
      return map;
    },
    view: map => ({ ...(shoreNearCentre(map)[0] ?? { col: 12, row: 9 }), distance: 11, pitch: 40, yaw: 25 }),
    scatter: 'palms',
  },

  /** A coast with ports marked, for the naval work: shore cells flagged as docks. */
  ports: {
    map() {
      const map = new HexMap({ width: 24, height: 18, featureLayerCount: 4 });
      generateMap(map, { landPercentage: 55, roads: { gridSpacing: 8 } }, 777);
      // Three docks on the shore cells nearest the map's centre, so they are
      // in view and not lost under a canopy at the edge.
      for (const cell of shoreNearCentre(map).slice(0, 3)) setPort(map, cell.col, cell.row, true, WATER_ONLY);
      return map;
    },
    view: map => ({ ...(shoreNearCentre(map)[0] ?? { col: 12, row: 9 }), distance: 12, pitch: 55 }),
  },
};

async function renderScene(name: string): Promise<string[]> {
  const def = SCENES[name];
  if (!def) throw new Error(`unknown scene "${name}" — have: ${Object.keys(SCENES).join(', ')}`);
  STAGE.innerHTML = '';

  const map   = def.map();
  const view  = typeof def.view === 'function' ? def.view(map) : def.view;
  const world = await HexWorld.create({
    container: STAGE,
    map,
    terrainDescriptors: TERRAINS,
    scatterDefinitions: def.scatter === 'palms' ? palmDefs() : scatterDefs(def.smoke ?? false),
    scatterSeed: 1234,
    geometryOptions: { colorMode: 'splat' },
    chunkWorker: false,
    chunkSize: 16,
    loadRadius: 8,
    sky: true,
    dayNight: { time: def.time ?? 0.42, paused: true },
    camera: { initialDistance: view.distance, initialPitch: view.pitch, initialYaw: view.yaw ?? 0 },
    autoStart: false,
    ...def.world,
  });

  const target = hexToWorld(world.layout, offsetToHex(view.col, view.row));
  world.controls.snapTo(target.x, target.z);
  world.controls.update();

  // Settle: pump the streamer until a pass loads nothing new, then draw once.
  let previous = -1;
  for (let i = 0; i < 12; i++) {
    world.chunks.update(world.camera, 0);
    const count = world.scene.children.length;
    if (count === previous) break;
    previous = count;
  }
  // Docks are map data with no library-side drawing (the demo and the editor
  // each draw their own); rings here so the ports scene shows what it tests.
  const ringGeo = new THREE.TorusGeometry(0.55, 0.06, 6, 24);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd166 });
  for (const { col, row } of listPorts(map)) {
    const wp   = hexToWorld(world.layout, offsetToHex(col, row));
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(wp.x, map.getElevation(col, row) * 0.5 + 0.06, wp.z);
    world.scene.add(ring);
  }
  world.renderer.render(world.scene, world.camera);

  // Handy for a diff reader: which cells earned a deck, and where the ports are.
  const notes: string[] = [];
  map.forEach((c, r) => { if (map.hasRiver(c, r) && map.hasRoads(c, r)) notes.push(`river+road ${c},${r}`); });
  return notes;
}

declare global {
  interface Window { renderScene: typeof renderScene; sceneNames: string[] }
}
window.renderScene = renderScene;
window.sceneNames  = Object.keys(SCENES);
