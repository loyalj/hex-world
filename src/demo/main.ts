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
import { generateFbmTerrain } from '../generators/FbmTerrainGenerator.js';
import { generateRivers } from '../generators/RiverGenerator.js';
import { generateRoads } from '../generators/RoadGenerator.js';

/** Change this one constant to switch terrain rendering mode. */
const TERRAIN_COLOR_MODE: TerrainColorMode = 'splat';

const MAP_WIDTH   = 100;
const MAP_HEIGHT  = 100;
const HEX_SIZE    = 1;
const CHUNK_SIZE  = 32;
const LOAD_RADIUS = 5;

// --- Map generation ---
const map = new HexMap({ width: MAP_WIDTH, height: MAP_HEIGHT, featureLayerCount: 1 });
generateFbmTerrain(map);
generateRivers(map);
generateRoads(map);

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

// --- FPS tracking ---
let fps = 0;
let frameCount = 0;
let lastFpsTime = performance.now();

async function start() {
  // --- Chunk manager ---
  // waterLevel=-0.25 sits between water terrain max Y (-0.3, elev=-1 with perturbation)
  // and land terrain min Y (-0.2, elev=0 with max negative perturbation), so the
  // water surface is always above the water bowl and below adjacent land terrain.
  const waterGeoOptions = { waterLevel: -0.25 };

  let terrainMaterial: THREE.Material;
  if (TERRAIN_COLOR_MODE === 'splat') {
    const terrainTex = await buildTerrainTextureArray();
    terrainMaterial = createTerrainMaterial(terrainTex, {
      lightDir:   new THREE.Vector3(100, 120, 80),
      lightColor: new THREE.Color(0xffffff).multiplyScalar(0.7),
      ambient:    new THREE.Color(0xffffff).multiplyScalar(0.45),
    });
  } else {
    terrainMaterial = new THREE.MeshPhongMaterial({ vertexColors: true, side: THREE.DoubleSide });
  }

  // --- Scatter ---
  const hashGrid = new HexHashGrid(1234);

  const treeMat = new THREE.MeshLambertMaterial({ color: 0x5e8c2a });
  const pineLayer: ScatterLayerConfig = [
    // tier 0 (high density / level-3 cells): tall tree
    [{ geometry: new THREE.ConeGeometry(0.42, 2.0, 7), material: treeMat, yOffset: 1.0 }],
    // tier 1 (medium)
    [{ geometry: new THREE.ConeGeometry(0.33, 1.5, 7), material: treeMat, yOffset: 0.75 }],
    // tier 2 (low density / level-1 cells): small scrubby tree
    [{ geometry: new THREE.ConeGeometry(0.24, 1.0, 7), material: treeMat, yOffset: 0.5 }],
  ];

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
