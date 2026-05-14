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
import type { ScatterLayerConfig } from '../geometry/ScatterTypes.js';
import type { MapGeneratorPlugin } from '../generators/MapGeneratorPlugin.js';
import { FbmPlugin } from '../generators/FbmPlugin.js';
import { ChunkPlugin } from '../generators/ChunkPlugin.js';
import { pickHexFromMeshes } from '../geometry/HexPicking.js';
import { hexToWorld, hexCorners } from '../math/HexLayout.js';
import { offsetToHex } from '../math/HexCoord.js';
import { TerrainType } from '../map/HexCell.js';
import { FogData } from '../geometry/FogData.js';
import { getVisibleCells, findPath, getMovementRange, type MoveCostFn } from '../pathfinding/Pathfinding.js';
import { hexToOffset } from '../math/HexCoord.js';

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
const map = new HexMap({ width: MAP_WIDTH, height: MAP_HEIGHT, featureLayerCount: 1 });

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
  const pineLayer: ScatterLayerConfig = [
    [{ geometry: new THREE.ConeGeometry(0.42, 2.0, 7), material: treeMat, yOffset: 1.0 }],
    [{ geometry: new THREE.ConeGeometry(0.33, 1.5, 7), material: treeMat, yOffset: 0.75 }],
    [{ geometry: new THREE.ConeGeometry(0.24, 1.0, 7), material: treeMat, yOffset: 0.5 }],
  ];

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

  let selectedCell: { col: number; row: number } | null = null;
  let lastHoveredForPath: { col: number; row: number } | null = null;

  const rangeMat = new THREE.MeshBasicMaterial({
    color: 0x4488ff, transparent: true, opacity: 0.25,
    depthWrite: false, depthTest: false, side: THREE.DoubleSide,
  });
  const rangeMesh = new THREE.Mesh(new THREE.BufferGeometry(), rangeMat);
  rangeMesh.renderOrder = 6;
  rangeMesh.visible = false;
  scene.add(rangeMesh);

  const pathMat = new THREE.MeshBasicMaterial({
    color: 0xffaa22, transparent: true, opacity: 0.55,
    depthWrite: false, depthTest: false, side: THREE.DoubleSide,
  });
  const pathOverlay = new THREE.Mesh(new THREE.BufferGeometry(), pathMat);
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

  function selectCell(cell: { col: number; row: number }): void {
    selectedCell = cell;
    const hex = offsetToHex(cell.col, cell.row);
    const wp  = hexToWorld(layout, hex);
    selectedMesh.position.set(wp.x, map.getElevation(cell.col, cell.row) * 0.5 + 0.03, wp.z);
    selectedMesh.visible = true;

    const reachable = getMovementRange(hex, MOVE_BUDGET, moveCost, map);
    rangeMesh.geometry.dispose();
    rangeMesh.geometry = buildHighlightGeo(reachable.map(h => hexToOffset(h)), 0.04);
    rangeMesh.visible = true;

    pathOverlay.geometry.dispose();
    pathOverlay.geometry = new THREE.BufferGeometry();
    pathOverlay.visible = false;
    lastHoveredForPath = null;
  }

  function clearSelection(): void {
    selectedCell = null;
    selectedMesh.visible = false;
    rangeMesh.geometry.dispose();
    rangeMesh.geometry = new THREE.BufferGeometry();
    rangeMesh.visible = false;
    pathOverlay.geometry.dispose();
    pathOverlay.geometry = new THREE.BufferGeometry();
    pathOverlay.visible = false;
    lastHoveredForPath = null;
  }

  function updatePathPreview(target: { col: number; row: number }): void {
    if (!selectedCell) return;
    if (lastHoveredForPath?.col === target.col && lastHoveredForPath?.row === target.row) return;
    lastHoveredForPath = target;
    const path = findPath(offsetToHex(selectedCell.col, selectedCell.row), offsetToHex(target.col, target.row), moveCost, map);
    pathOverlay.geometry.dispose();
    if (path && path.length > 1) {
      pathOverlay.geometry = buildHighlightGeo(path.map(h => hexToOffset(h)), 0.06);
      pathOverlay.visible = true;
    } else {
      pathOverlay.geometry = new THREE.BufferGeometry();
      pathOverlay.visible = false;
    }
  }

  // --- Fog of war ---
  const fogData = new FogData(MAP_WIDTH, MAP_HEIGHT);
  let hideUnexplored = true;  // E: whether unexplored cells are hidden
  let dimExplored    = true;  // F: whether explored cells are dimmed

  const FOG_REVEAL_RANGE = 3;

  // Cells currently granting visibility (the "unit's" position).
  // Tracked so we can decrease visibility when the unit moves.
  let visibleCells: { col: number; row: number }[] = [];

  function revealAt(col: number, row: number): void {
    // Remove visibility from previous position.
    for (const { col: oc, row: or } of visibleCells) {
      fogData.decreaseVisibility(oc, or);
    }
    // Grant visibility at new position.
    const cells = getVisibleCells(offsetToHex(col, row), FOG_REVEAL_RANGE, map);
    visibleCells = [];
    for (const c of cells) {
      const nc = c.q + (c.r - (c.r & 1)) / 2;
      const nr = c.r;
      if (map.inBounds(nc, nr)) {
        fogData.increaseVisibility(nc, nr);
        visibleCells.push({ col: nc, row: nr });
      }
    }
  }

  // Seed initial visibility from map center
  revealAt(Math.floor(MAP_WIDTH / 2), Math.floor(MAP_HEIGHT / 2));

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
    scatterLayers: [pineLayer],
    fogData,
  });

  const resetFog = () => {
    visibleCells = [];  // prevent decreaseVisibility against stale indices after reset
    fogData.reset();
    revealAt(Math.floor(MAP_WIDTH / 2), Math.floor(MAP_HEIGHT / 2));
  };

  // --- Keyboard shortcuts ---
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      clearSelection();
    } else if (e.key === 'r' || e.key === 'R') {
      seed = Math.floor(Math.random() * 0xffffffff);
      runGenerator();
      resetFog();
      clearSelection();
      chunkManager.dispose();
    } else if (e.key === 'g' || e.key === 'G') {
      activeGenIndex = (activeGenIndex + 1) % GENERATORS.length;
      runGenerator();
      resetFog();
      clearSelection();
      chunkManager.dispose();
    } else if (e.key === 'e' || e.key === 'E') {
      hideUnexplored = !hideUnexplored;
      chunkManager.setHideUnexplored(hideUnexplored);
    } else if (e.key === 'f' || e.key === 'F') {
      dimExplored = !dimExplored;
      chunkManager.setDimExplored(dimExplored);
    }
  });

  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !hoverCell) return;
    revealAt(hoverCell.col, hoverCell.row);
    if (map.getTerrain(hoverCell.col, hoverCell.row) === TerrainType.Water) {
      clearSelection();
    } else if (selectedCell?.col === hoverCell.col && selectedCell?.row === hoverCell.row) {
      clearSelection();
    } else {
      selectCell(hoverCell);
    }
  });

  // --- Render loop ---
  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    chunkManager.update(camera);

    const t = performance.now() / 1000;
    waterMaterial.uniforms.uTime.value   = t;
    shoreMaterial.uniforms.uTime.value   = t;
    estuaryMaterial.uniforms.uTime.value = t;
    riverMaterial.uniforms.uTime.value   = t;

    frameCount++;
    const now     = performance.now();
    const elapsed = now - lastFpsTime;
    if (elapsed >= 500) {
      fps        = Math.round((frameCount / elapsed) * 1000);
      frameCount = 0;
      lastFpsTime = now;
    }

    // Cell picking — raycast against actual terrain meshes for accurate results
    const picked = pickHexFromMeshes(lastMouseX, lastMouseY, renderer.domElement, camera, layout, map, chunkManager.terrainMeshes);
    hoverCell = picked;
    if (picked) {
      const wp = hexToWorld(layout, offsetToHex(picked.col, picked.row));
      hoverMesh.position.set(wp.x, map.getElevation(picked.col, picked.row) * 0.5 + 0.02, wp.z);
      hoverMesh.visible = true;
      if (selectedCell) updatePathPreview(picked);
    } else {
      hoverMesh.visible = false;
    }

    const gen = GENERATORS[activeGenIndex];
    const hoverLine = hoverCell
      ? `Hover:     [${hoverCell.col}, ${hoverCell.row}]  ` +
        `${TERRAIN_NAMES[map.getTerrain(hoverCell.col, hoverCell.row)] ?? '?'}  ` +
        `elev ${map.getElevation(hoverCell.col, hoverCell.row)}`
      : `Hover:     —`;
    const selLine = selectedCell
      ? `Selected:  [${selectedCell.col}, ${selectedCell.row}]  budget ${MOVE_BUDGET}  [Esc] clear`
      : `Selected:  — (click land to select)`;
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
      `\n${selLine}\n${hoverLine}`;

    renderer.render(scene, camera);
  }
  animate();
}

start();
