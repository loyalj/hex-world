import * as THREE from 'three';
import { POINTY_TOP } from '../math/HexOrientation.js';
import { RtsCameraController } from '../camera/RtsCameraController.js';
import { createLayout } from '../math/HexLayout.js';
import { HexMap } from '../map/HexMap.js';
import { ChunkManager } from '../geometry/ChunkManager.js';
import { createWaterMaterial } from '../geometry/WaterMaterial.js';
import { createWaterShoreMaterial } from '../geometry/WaterShoreMaterial.js';
import { createEstuaryMaterial } from '../geometry/EstuaryMaterial.js';
import { createRiverMaterial } from '../geometry/RiverMaterial.js';
import { createRoadMaterial } from '../geometry/RoadMaterial.js';
import { buildTerrainTextureArray } from '../geometry/TerrainTextures.js';
import { createTerrainMaterial } from '../geometry/TerrainMaterial.js';
import type { TerrainColorMode } from '../geometry/ChunkManager.js';
import { HexHashGrid } from '../geometry/HexHashGrid.js';
import type { ScatterDefinition } from '../geometry/ScatterTypes.js';
import { createRockMaterial } from '../geometry/RockMaterial.js';
import type { MapGeneratorPlugin } from '../generators/MapGeneratorPlugin.js';
import { FbmPlugin } from '../generators/FbmPlugin.js';
import { ChunkPlugin } from '../generators/ChunkPlugin.js';
import { pickHexFromMeshes } from '../geometry/HexPicking.js';
import { hexToWorld, hexCorners } from '../math/HexLayout.js';
import { offsetToHex } from '../math/HexCoord.js';
import { TerrainType } from '../map/HexCell.js';
import { FogData } from '../geometry/FogData.js';
import { findPath, getMovementRange, getVisibleCells, hasLineOfSight, type MoveCostFn } from '../pathfinding/Pathfinding.js';
import { smoothPath } from '../pathfinding/PathSmoothing.js';
import { hexToOffset } from '../math/HexCoord.js';
import { serializeMapJSON, deserializeMapJSON } from '../map/MapSerializer.js';
import { HexUnit } from '../units/HexUnit.js';
import { UnitManager } from '../units/UnitManager.js';

/** Change this one constant to switch terrain rendering mode. */
const TERRAIN_COLOR_MODE: TerrainColorMode = 'splat';

const TERRAIN_NAMES: Record<number, string> = {
  [TerrainType.Water]:     'Water',
  [TerrainType.Grassland]: 'Grassland',
  [TerrainType.Desert]:    'Desert',
  [TerrainType.Mud]:       'Mud',
  [TerrainType.Rock]:      'Rock',
  [TerrainType.Snow]:      'Snow',
};

const MAP_WIDTH   = 100;
const MAP_HEIGHT  = 100;
const HEX_SIZE    = 1;
const CHUNK_SIZE  = 32;
const LOAD_RADIUS = 5;

// --- Generator registry ---
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GENERATORS: MapGeneratorPlugin<any>[] = [FbmPlugin, ChunkPlugin];
let activeGenIndex = 0;
let seed = Math.floor(Math.random() * 0xffffffff);

// --- Map ---
const map = new HexMap({ width: MAP_WIDTH, height: MAP_HEIGHT, featureLayerCount: 2 });

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
document.body.appendChild(renderer.domElement);

const controls = new RtsCameraController({
  camera,
  domElement: renderer.domElement,
  initialTarget:   { x: MAP_WIDTH / 2, z: MAP_HEIGHT / 2 },
  initialDistance: 60,
  minPitch: 30,
  maxPitch: 66,
  minDistance: 6,
  maxDistance: 80,
});

// Lighting — cool sky ambient + warm directional sun
const ambient = new THREE.AmbientLight(0xd0e0ff, 0.5);
const sun = new THREE.DirectionalLight(0xfff4d0, 1.4);
sun.position.set(100, 120, 80);
scene.add(ambient, sun);

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
const waterMaterial   = createWaterMaterial();
const shoreMaterial   = createWaterShoreMaterial();
const estuaryMaterial = createEstuaryMaterial();
const riverMaterial   = createRiverMaterial();
const roadMaterial    = createRoadMaterial();

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
  // waterLevel=-0.25 sits between water terrain max Y (-0.3, elev=-1 with perturbation)
  // and land terrain min Y (-0.2, elev=0 with max negative perturbation).
  const waterGeoOptions = { waterLevel: -0.25 };

  let terrainMaterial: THREE.Material;
  if (TERRAIN_COLOR_MODE === 'splat') {
    const terrainTex = await buildTerrainTextureArray();
    terrainMaterial = createTerrainMaterial(terrainTex, {
      lightDir:   new THREE.Vector3(100, 120, 80),
      lightColor: new THREE.Color(0xfff4d0).multiplyScalar(0.7),
      ambient:    new THREE.Color(0xd0e0ff).multiplyScalar(0.45),
    });
  } else {
    terrainMaterial = new THREE.MeshPhongMaterial({ vertexColors: true, side: THREE.DoubleSide });
  }

  // --- Scatter ---
  const hashGrid = new HexHashGrid(1234);

  const treeMat = new THREE.MeshLambertMaterial({ color: 0x5e8c2a });
  const pineDefinition: ScatterDefinition = {
    id:         'pine-tree',
    name:       'Pine Tree',
    layerIndex: 0,
    tiers: [
      [{ geometry: new THREE.ConeGeometry(0.42, 2.0, 7), material: treeMat, yOffset: 1.0 }],
      [{ geometry: new THREE.ConeGeometry(0.33, 1.5, 7), material: treeMat, yOffset: 0.75 }],
      [{ geometry: new THREE.ConeGeometry(0.24, 1.0, 7), material: treeMat, yOffset: 0.5 }],
    ],
  };

  const rockMat = createRockMaterial();
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
    if (map.getTerrain(col, row) === TerrainType.Water) return Infinity;
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

  // --- Save / Load ---
  const SAVE_KEY = 'hexworld-save';
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
      });
      localStorage.setItem(SAVE_KEY, json);
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
      if (map.featureData && loaded.featureData) map.featureData.set(loaded.featureData);
      if (metadata.seed !== undefined) seed = metadata.seed;
      if (metadata.generatorId) {
        const idx = GENERATORS.findIndex(g => g.id === metadata.generatorId);
        if (idx >= 0) activeGenIndex = idx;
      }
      resetFog();
      pathOverlay.geometry.dispose();
      pathOverlay.geometry = new THREE.BufferGeometry();
      pathOverlay.visible = false;
      lastHoveredForPath = null;
      chunkManager.dispose();
      saveStatus = `Loaded: ${metadata.name ?? 'map'}`;
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
    waterMaterial,
    shoreMaterial,
    estuaryMaterial,
    riverMaterial,
    chunkSize: CHUNK_SIZE,
    loadRadius: LOAD_RADIUS,
    geometryOptions: { colorMode: TERRAIN_COLOR_MODE },
    waterGeometryOptions: waterGeoOptions,
    roadMaterial,
    hashGrid,
    scatterDefinitions: [pineDefinition, rockDefinition],
    fogData,
  });

  // --- Units ---
  // Demo uses simple capsules. Real consumers attach loaded GLTF Object3Ds instead.

  /** BFS outward from (col, row) to find the nearest non-water cell. */
  function findSpawnCell(col: number, row: number): { col: number; row: number } {
    if (map.inBounds(col, row) && map.getTerrain(col, row) !== TerrainType.Water) return { col, row };
    const candidates = getVisibleCells(offsetToHex(col, row), Math.max(MAP_WIDTH, MAP_HEIGHT), map);
    for (const c of candidates) {
      const oc = hexToOffset(c);
      if (map.inBounds(oc.col, oc.row) && map.getTerrain(oc.col, oc.row) !== TerrainType.Water) return oc;
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
    const spawn = findSpawnCell(def.col, def.row);
    const u = new HexUnit({ col: spawn.col, row: spawn.row, travelSpeed: 4, heightOffset: 0.6, fogRevealRange: FOG_REVEAL_RANGE });

    // Callbacks: real consumers toggle GLTF AnimationMixer clips here.
    const idleColor = def.color;
    u.onMoveStart = () => mat.color.setHex(0xffffff);
    u.onMoveEnd   = () => {
      mat.color.setHex(idleColor);
      if (selectedUnit === u) { rangeNeedsUpdate = true; lastHoveredForPath = null; }
    };
    u.onCellEnter = () => {
      if (selectedUnit === u) { rangeNeedsUpdate = true; lastHoveredForPath = null; }
    };

    units.push(u);
    unitMeshes.push(mesh);
    unitManager.addUnit(u, mesh);
  }

  // Focus camera on the first unit's actual spawn position so the first frame
  // renders on terrain rather than empty sky.
  controls.snapTo(units[0].worldX, units[0].worldZ);

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
  }

  // --- Keyboard shortcuts ---
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      deselectUnit();
    } else if (e.key === 'r' || e.key === 'R') {
      seed = Math.floor(Math.random() * 0xffffffff);
      runGenerator();
      resetUnits();
      resetFog();
      chunkManager.dispose();
    } else if (e.key === 'g' || e.key === 'G') {
      activeGenIndex = (activeGenIndex + 1) % GENERATORS.length;
      runGenerator();
      resetUnits();
      resetFog();
      chunkManager.dispose();
    } else if (e.key === 'e' || e.key === 'E') {
      hideUnexplored = !hideUnexplored;
      chunkManager.setHideUnexplored(hideUnexplored);
    } else if (e.key === 'f' || e.key === 'F') {
      dimExplored = !dimExplored;
      chunkManager.setDimExplored(dimExplored);
    } else if (e.key === 'c' || e.key === 'C') {
      if (selectedUnit) controls.panTo(selectedUnit.worldX, selectedUnit.worldZ);
    } else if (e.key === 's' || e.key === 'S') {
      saveMap();
    } else if (e.key === 'l' || e.key === 'L') {
      loadMap();
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
    if (map.getTerrain(hoverCell.col, hoverCell.row) === TerrainType.Water) return;

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

  // --- Render loop ---
  let lastFrameTime = performance.now();

  function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const dt  = Math.min((now - lastFrameTime) / 1000, 0.1); // cap at 100 ms
    lastFrameTime = now;

    controls.update();
    unitManager.update(dt);
    chunkManager.update(camera, dt);

    const t = now / 1000;
    waterMaterial.uniforms.uTime.value   = t;
    shoreMaterial.uniforms.uTime.value   = t;
    estuaryMaterial.uniforms.uTime.value = t;
    riverMaterial.uniforms.uTime.value   = t;

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
    hud.textContent =
      `FPS:       ${fps}\n` +
      `Generator: ${gen.name}  [G] cycle\n` +
      `Seed:      ${seed >>> 0}  [R] new\n` +
      `Map:       ${MAP_WIDTH} × ${MAP_HEIGHT} cells\n` +
      `Chunks:    ${chunkManager.loadedChunkCount} loaded  (${CHUNK_SIZE}×${CHUNK_SIZE} cells each)\n` +
      `Total:     ${chunkManager.chunksX * chunkManager.chunksY} chunks in map\n` +
      `Zoom:      ${controls.currentDistance.toFixed(1)}  (min ${controls.minDist} / max ${controls.maxDist})\n` +
      `Tilt:      ${controls.currentPitchDeg.toFixed(1)}°  (min ${controls.minPitchDeg}° / max ${controls.maxPitchDeg}°)\n` +
      `Hide unexplored: ${hideUnexplored ? 'ON  [E] toggle' : 'OFF  [E] toggle'}\n` +
      `Dim explored:    ${dimExplored    ? 'ON  [F] toggle' : 'OFF  [F] toggle'}\n` +
      `Save: [S]  Load: [L]  ${saveStatus}\n` +
      `\n${unitLine}\n${hoverLine}`;

    renderer.render(scene, camera);
  }
  animate();
}

start();
