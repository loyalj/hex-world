import * as THREE from 'three';
import type { HexMap } from '../map/HexMap.js';
import type { HexLayout } from '../math/HexLayout.js';
import { hexToWorld, hexCorners } from '../math/HexLayout.js';
import { TerrainType } from '../map/HexCell.js';
import { sampleNoise } from '../math/Noise.js';
import type { HexHashGrid } from './HexHashGrid.js';
import type { ScatterLayerConfig } from './ScatterTypes.js';
import type { ChunkBounds } from './HexChunk.js';

// Tutorial threshold table: index = level-1, values = per-tier hash cutoffs.
// Tier 0 = highest density variant, tier 2 = lowest density variant.
const FEATURE_THRESHOLDS = [
  [0.0, 0.0, 0.4],  // level 1: only tier-2 variant, 40% chance
  [0.0, 0.4, 0.6],  // level 2: tier-1 at 0–0.4, tier-2 at 0.4–0.6
  [0.4, 0.6, 0.8],  // level 3: tier-0 at 0–0.4, tier-1 at 0.4–0.6, tier-2 at 0.6–0.8
] as const;

const NOISE_SCALE          = 0.35;
const PERTURB_STRENGTH     = 0.4;
const ELEV_SCALE           = 0.5;
const ELEV_PERTURB_STRENGTH = 0.2;

function cellWorldY(map: HexMap, layout: HexLayout, col: number, row: number): number {
  const q  = col - (row - (row & 1)) / 2;
  const wc = hexToWorld(layout, { q, r: row });
  const n  = sampleNoise(wc.x * NOISE_SCALE, wc.z * NOISE_SCALE);
  return map.getElevation(col, row) * ELEV_SCALE + (n[1] * 2 - 1) * ELEV_PERTURB_STRENGTH;
}

function perturbXZ(x: number, z: number): [number, number] {
  const n = sampleNoise(x * NOISE_SCALE, z * NOISE_SCALE);
  return [(n[0] * 2 - 1) * PERTURB_STRENGTH, (n[2] * 2 - 1) * PERTURB_STRENGTH];
}

/** Returns spawn hash for layer index — layers 0-2 use a/b/c, beyond that mix from a. */
function spawnHashForLayer(
  hash: { a: number; b: number; c: number },
  layerIdx: number,
): number {
  if (layerIdx === 0) return hash.a;
  if (layerIdx === 1) return hash.b;
  if (layerIdx === 2) return hash.c;
  return ((hash.a + layerIdx * 0.618033988) % 1.0 + 1.0) % 1.0;
}

function pickFromLayer(
  config: ScatterLayerConfig,
  level: number,
  spawnHash: number,
  choiceHash: number,
): { tierIdx: number; variantIdx: number } | null {
  if (level <= 0) return null;
  const thresholds = FEATURE_THRESHOLDS[level - 1];
  for (let i = 0; i < thresholds.length; i++) {
    if (spawnHash < thresholds[i]) {
      const tier = config[i];
      if (!tier || tier.length === 0) return null;
      return { tierIdx: i, variantIdx: Math.floor(choiceHash * tier.length) };
    }
  }
  return null;
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _euler = new THREE.Euler();
const _mat = new THREE.Matrix4();

function addSlot(
  rawX: number,
  rawZ: number,
  worldY: number,
  col: number,
  row: number,
  map: HexMap,
  layers: ScatterLayerConfig[],
  hashGrid: HexHashGrid,
  accumulator: Map<string, THREE.Matrix4[]>,
  collectionRef: Map<string, { layerIdx: number; tierIdx: number; variantIdx: number }>,
): void {
  const hash = hashGrid.sample(rawX, rawZ);

  // Compete: find the layer with the lowest spawn hash that actually yields a prefab.
  let winnerKey: string | null = null;
  let winnerHash = Infinity;
  let winnerTier = 0;
  let winnerVariant = 0;
  let winnerLayer = 0;

  for (let li = 0; li < layers.length; li++) {
    const level = map.getFeatureLevel(col, row, li);
    const sh    = spawnHashForLayer(hash, li);
    const pick  = pickFromLayer(layers[li], level, sh, hash.d);
    if (pick && sh < winnerHash) {
      winnerHash    = sh;
      winnerLayer   = li;
      winnerTier    = pick.tierIdx;
      winnerVariant = pick.variantIdx;
      winnerKey     = `${li}-${pick.tierIdx}-${pick.variantIdx}`;
    }
  }

  if (!winnerKey) return;

  const [dx, dz] = perturbXZ(rawX, rawZ);
  const collection = layers[winnerLayer][winnerTier][winnerVariant];

  _pos.set(rawX + dx, worldY + collection.yOffset, rawZ + dz);
  _euler.set(0, hash.e * Math.PI * 2, 0);
  _quat.setFromEuler(_euler);
  _mat.compose(_pos, _quat, _scale);

  if (!accumulator.has(winnerKey)) {
    accumulator.set(winnerKey, []);
    collectionRef.set(winnerKey, { layerIdx: winnerLayer, tierIdx: winnerTier, variantIdx: winnerVariant });
  }
  accumulator.get(winnerKey)!.push(_mat.clone());
}

export function buildScatterMeshes(
  map: HexMap,
  layout: HexLayout,
  bounds: ChunkBounds,
  hashGrid: HexHashGrid,
  layers: ScatterLayerConfig[],
): THREE.InstancedMesh[] {
  if (layers.length === 0) return [];

  const { colStart, colEnd, rowStart, rowEnd } = bounds;

  const accumulator  = new Map<string, THREE.Matrix4[]>();
  const collectionRef = new Map<string, { layerIdx: number; tierIdx: number; variantIdx: number }>();

  for (let row = rowStart; row < rowEnd; row++) {
    for (let col = colStart; col < colEnd; col++) {
      if (!map.inBounds(col, row)) continue;
      if (map.getTerrain(col, row) === TerrainType.Water) continue;

      const q      = col - (row - (row & 1)) / 2;
      const center = hexToWorld(layout, { q, r: row });
      const worldY = cellWorldY(map, layout, col, row);
      const corners = hexCorners(layout, { q, r: row });

      // Center slot — skip if river or any road through the cell
      if (!map.hasRiver(col, row) && !map.hasRoads(col, row)) {
        addSlot(center.x, center.z, worldY, col, row, map, layers, hashGrid, accumulator, collectionRef);
      }

      // 6 direction slots — skip if river or road through that edge (i = face index 0-5)
      for (let i = 0; i < 6; i++) {
        if (map.hasRiverThroughEdge(col, row, i)) continue;
        if (map.hasRoadThroughEdge(col, row, i)) continue;

        const i1 = (i + 1) % 6;
        const fx = (center.x + corners[i].x + corners[i1].x) / 3;
        const fz = (center.z + corners[i].z + corners[i1].z) / 3;

        addSlot(fx, fz, worldY, col, row, map, layers, hashGrid, accumulator, collectionRef);
      }
    }
  }

  const meshes: THREE.InstancedMesh[] = [];

  for (const [key, matrices] of accumulator) {
    const ref  = collectionRef.get(key)!;
    const coll = layers[ref.layerIdx][ref.tierIdx][ref.variantIdx];
    const mesh = new THREE.InstancedMesh(coll.geometry, coll.material, matrices.length);
    mesh.frustumCulled = false; // chunk manager handles load radius culling
    for (let i = 0; i < matrices.length; i++) {
      mesh.setMatrixAt(i, matrices[i]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    meshes.push(mesh);
  }

  return meshes;
}
