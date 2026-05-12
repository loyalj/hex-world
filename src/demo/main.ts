import * as THREE from 'three';
import { POINTY_TOP } from '../math/HexOrientation.js';
import { RtsCameraController } from '../camera/RtsCameraController.js';
import { createLayout } from '../math/HexLayout.js';
import { HexMap } from '../map/HexMap.js';
import { TerrainType } from '../map/HexCell.js';
import { ChunkManager } from '../geometry/ChunkManager.js';
import { createWaterMaterial } from '../geometry/WaterMaterial.js';
import { createWaterShoreMaterial } from '../geometry/WaterShoreMaterial.js';
import { createEstuaryMaterial } from '../geometry/EstuaryMaterial.js';
import { createRiverMaterial } from '../geometry/RiverMaterial.js';
import { buildTerrainTextureArray } from '../geometry/TerrainTextures.js';
import { createTerrainMaterial } from '../geometry/TerrainMaterial.js';
import { HEX_DIRECTIONS } from '../math/HexCoord.js';
import { fbm } from '../math/Noise.js';

const MAP_WIDTH   = 256;
const MAP_HEIGHT  = 256;
const HEX_SIZE    = 1;
const CHUNK_SIZE  = 32;
const LOAD_RADIUS = 5;

// --- Map ---
const map = new HexMap({ width: MAP_WIDTH, height: MAP_HEIGHT });

// Elevation offset so all land cells have elev >= 0 and water cells have elev < 0.
// With n*8 in range -8..8, +4 gives land (n>-0.5) at elev 0..12, water at elev <0.
const ELEV_OFFSET = 4;

map.forEach((col, row) => {
  // FBM: large continental scale (period=64 cells) down through 6 octaves of detail.
  // Scale by 2.2 to spread the value-noise distribution across the full ±1 threshold range.
  const n = fbm(col / 64, row / 64, 6) * 2.2;

  const isWater = n < -0.55;
  if      (n > 0.72)  map.setTerrain(col, row, TerrainType.Snow);
  else if (n > 0.42)  map.setTerrain(col, row, TerrainType.Rock);
  else if (isWater)   map.setTerrain(col, row, TerrainType.Water);
  else if (n < -0.38) map.setTerrain(col, row, TerrainType.Desert);
  else                map.setTerrain(col, row, TerrainType.Grassland);

  // Water cells capped at -1 so terrain stays below waterLevel.
  // Land cells clamped to 0 minimum so terrain Y >= -0.2 > waterLevel=-0.25 (shore slopes upward).
  const elev = Math.round(n * 10) + ELEV_OFFSET;
  map.setElevation(col, row, isWater ? Math.min(elev, -1) : Math.max(elev, 0));
});

// --- Rivers ---
const POINTY_TOP_EDGE_DIRS = POINTY_TOP.edgeDirections;

function neighborOff(col: number, row: number, d: number): { col: number; row: number } {
  const q  = col - (row - (row & 1)) / 2;
  const nq = q  + HEX_DIRECTIONS[d].q;
  const nr = row + HEX_DIRECTIONS[d].r;
  return { col: nq + (nr - (nr & 1)) / 2, row: nr };
}

function traceRiver(col: number, row: number, maxSteps: number): void {
  let c = col, r = row;
  // Track visited cells so the river can't loop on flat terrain
  const visited = new Set<number>();

  for (let step = 0; step < maxSteps; step++) {
    if (map.getTerrain(c, r) === TerrainType.Water) break;

    const cellKey = r * MAP_WIDTH + c;
    if (visited.has(cellKey)) break;
    visited.add(cellKey);

    const ownElev = map.getElevation(c, r);
    let bestEdge = -1;
    // Accept any neighbour at or below own elevation (allows traversal of flat land)
    let bestElev = ownElev + 1;
    let bestNbC = -1, bestNbR = -1;

    for (let i = 0; i < 6; i++) {
      const d  = POINTY_TOP_EDGE_DIRS[i];
      const nb = neighborOff(c, r, d);
      if (!map.inBounds(nb.col, nb.row)) continue;
      if (visited.has(nb.row * MAP_WIDTH + nb.col)) continue;
      const nbElev = map.getElevation(nb.col, nb.row);
      if (nbElev < bestElev) {
        bestElev = nbElev;
        bestEdge = i;
        bestNbC  = nb.col;
        bestNbR  = nb.row;
      }
    }

    if (bestEdge === -1) break;

    map.setRiverOutgoing(c, r, bestEdge);
    map.setRiverIncoming(bestNbC, bestNbR, (bestEdge + 3) % 6);

    if (map.getTerrain(bestNbC, bestNbR) === TerrainType.Water) break;

    c = bestNbC;
    r = bestNbR;
  }
}

// Seed rivers from high-elevation cells on a coarse grid.
// With ELEV_OFFSET=4, Desert cells start around elev 6 and Rock at 8+.
const RIVER_GRID = 48;
const RIVER_ELEV_MIN = 5;
for (let row = RIVER_GRID / 2; row < MAP_HEIGHT; row += RIVER_GRID) {
  for (let col = RIVER_GRID / 2; col < MAP_WIDTH; col += RIVER_GRID) {
    if (!map.inBounds(col, row)) continue;
    const elev  = map.getElevation(col, row);
    const terr  = map.getTerrain(col, row);
    if (terr !== TerrainType.Water && elev >= RIVER_ELEV_MIN) {
      traceRiver(col, row, 60);
    }
  }
}

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

// Lighting
const ambient = new THREE.AmbientLight(0xffffff, 0.5);
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(100, 120, 80);
scene.add(ambient, sun);

// --- Materials ---
const waterMaterial   = createWaterMaterial();
const shoreMaterial   = createWaterShoreMaterial();
const estuaryMaterial = createEstuaryMaterial();
const riverMaterial   = createRiverMaterial();

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

// --- FPS tracking ---
let fps = 0;
let frameCount = 0;
let lastFpsTime = performance.now();

async function start() {
  // Build terrain texture array (procedural noise; pass overrides: {...} to use images).
  const terrainTex      = await buildTerrainTextureArray();
  const terrainMaterial = createTerrainMaterial(terrainTex, {
    lightDir:   new THREE.Vector3(100, 120, 80),
    lightColor: new THREE.Color(0xffffff).multiplyScalar(0.7),
    ambient:    new THREE.Color(0xffffff).multiplyScalar(0.45),
  });

  // --- Chunk manager ---
  // waterLevel=-0.25 sits between water terrain max Y (-0.3, elev=-1 with perturbation)
  // and land terrain min Y (-0.2, elev=0 with max negative perturbation), so the
  // water surface is always above the water bowl and below adjacent land terrain.
  const waterGeoOptions = { waterLevel: -0.25 };

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
    geometryOptions: { colorMode: 'splat' },
    waterGeometryOptions: waterGeoOptions,
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

    hud.textContent =
      `FPS:    ${fps}\n` +
      `Map:    ${MAP_WIDTH} × ${MAP_HEIGHT} cells\n` +
      `Chunks: ${chunkManager.loadedChunkCount} loaded  (${CHUNK_SIZE}×${CHUNK_SIZE} cells each)\n` +
      `Total:  ${chunkManager.chunksX * chunkManager.chunksY} chunks in map\n` +
      `Zoom:   ${controls.currentDistance.toFixed(1)}  (min ${controls.minDist} / max ${controls.maxDist})\n` +
      `Tilt:   ${controls.currentPitchDeg.toFixed(1)}°  (min ${controls.minPitchDeg}° / max ${controls.maxPitchDeg}°)`;

    renderer.render(scene, camera);
  }
  animate();
}

start();
