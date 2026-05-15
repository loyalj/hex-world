import * as THREE from 'three';
import type { HexMap } from '../map/HexMap.js';
import type { HexLayout } from '../math/HexLayout.js';
import { hexToWorld, hexCorners } from '../math/HexLayout.js';
import { sampleNoise } from '../math/Noise.js';
import type { HexHashGrid } from './HexHashGrid.js';
import type { ScatterDefinition, ScatterLayerConfig, FeatureCollection } from './ScatterTypes.js';
import type { ChunkBounds } from './HexChunk.js';
import { DEFAULT_WATER_TERRAIN_INDEX } from './TerrainTypes.js';

// Tutorial threshold table: index = level-1, values = per-tier hash cutoffs.
// Tier 0 = highest density variant, tier 2 = lowest density variant.
const FEATURE_THRESHOLDS = [
  [0.0, 0.0, 0.4],  // level 1: only tier-2 variant, 40% chance
  [0.0, 0.4, 0.6],  // level 2: tier-1 at 0–0.4, tier-2 at 0.4–0.6
  [0.4, 0.6, 0.8],  // level 3: tier-0 at 0–0.4, tier-1 at 0.4–0.6, tier-2 at 0.6–0.8
] as const;

const NOISE_SCALE           = 0.35;
const PERTURB_STRENGTH      = 0.4;
const ELEV_SCALE            = 0.5;
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

/**
 * Returns a deterministic spawn hash for a given definition, using the definition's
 * own layerIndex as the hash channel so placement is stable regardless of array order.
 */
function spawnHashForDef(
  hash: { a: number; b: number; c: number },
  layerIndex: number,
): number {
  if (layerIndex === 0) return hash.a;
  if (layerIndex === 1) return hash.b;
  if (layerIndex === 2) return hash.c;
  return ((hash.a + layerIndex * 0.618033988) % 1.0 + 1.0) % 1.0;
}

function pickFromLayer(
  tiers: ScatterLayerConfig,
  level: number,
  spawnHash: number,
  choiceHash: number,
): { tierIdx: number; variantIdx: number } | null {
  if (level <= 0) return null;
  const thresholds = FEATURE_THRESHOLDS[level - 1];
  for (let i = 0; i < thresholds.length; i++) {
    if (spawnHash < thresholds[i]) {
      const tier = tiers[i];
      if (!tier || tier.length === 0) return null;
      return { tierIdx: i, variantIdx: Math.floor(choiceHash * tier.length) };
    }
  }
  return null;
}

const _pos   = new THREE.Vector3();
const _quat  = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _euler = new THREE.Euler();
const _mat   = new THREE.Matrix4();

interface WinnerRef { def: ScatterDefinition; tierIdx: number; variantIdx: number }

function addSlot(
  rawX: number,
  rawZ: number,
  worldY: number,
  col: number,
  row: number,
  mapWidth: number,
  map: HexMap,
  eligibleDefs: ScatterDefinition[],
  hashGrid: HexHashGrid,
  accumulator: Map<string, THREE.Matrix4[]>,
  cellAccumulator: Map<string, number[]>,
  collectionRef: Map<string, WinnerRef>,
): void {
  const hash = hashGrid.sample(rawX, rawZ);

  // Compete: find the definition with the lowest spawn hash that yields a variant.
  let winnerKey: string | null = null;
  let winnerHash    = Infinity;
  let winnerDef: ScatterDefinition | null = null;
  let winnerTier    = 0;
  let winnerVariant = 0;

  for (const def of eligibleDefs) {
    const level = map.getFeatureLevel(col, row, def.layerIndex);
    const sh    = spawnHashForDef(hash, def.layerIndex);
    const pick  = pickFromLayer(def.tiers, level, sh, hash.d);
    if (pick && sh < winnerHash) {
      winnerHash    = sh;
      winnerDef     = def;
      winnerTier    = pick.tierIdx;
      winnerVariant = pick.variantIdx;
      winnerKey     = `${def.id}-${pick.tierIdx}-${pick.variantIdx}`;
    }
  }

  if (!winnerKey || !winnerDef) return;

  const [dx, dz]   = perturbXZ(rawX, rawZ);
  const collection: FeatureCollection = winnerDef.tiers[winnerTier][winnerVariant];

  _pos.set(rawX + dx, worldY + collection.yOffset, rawZ + dz);
  const tilt = winnerDef.tiltStrength ?? 0;
  const tiltX = tilt > 0 ? (hash.b - 0.5) * 2 * tilt : 0;
  const tiltZ = tilt > 0 ? (hash.c - 0.5) * 2 * tilt : 0;
  _euler.set(tiltX, hash.e * Math.PI * 2, tiltZ);
  _quat.setFromEuler(_euler);
  _mat.compose(_pos, _quat, _scale);

  if (!accumulator.has(winnerKey)) {
    accumulator.set(winnerKey, []);
    cellAccumulator.set(winnerKey, []);
    collectionRef.set(winnerKey, { def: winnerDef, tierIdx: winnerTier, variantIdx: winnerVariant });
  }
  accumulator.get(winnerKey)!.push(_mat.clone());
  cellAccumulator.get(winnerKey)!.push(row * mapWidth + col);
}

export function buildScatterMeshes(
  map: HexMap,
  layout: HexLayout,
  bounds: ChunkBounds,
  hashGrid: HexHashGrid,
  definitions: ScatterDefinition[],
  waterTerrains: Set<number> = new Set([DEFAULT_WATER_TERRAIN_INDEX]),
): THREE.InstancedMesh[] {
  if (definitions.length === 0) return [];

  const { colStart, colEnd, rowStart, rowEnd } = bounds;

  const accumulator   = new Map<string, THREE.Matrix4[]>();
  const cellAccumulator = new Map<string, number[]>();
  const collectionRef   = new Map<string, WinnerRef>();

  for (let row = rowStart; row < rowEnd; row++) {
    for (let col = colStart; col < colEnd; col++) {
      if (!map.inBounds(col, row)) continue;
      if (waterTerrains.has(map.getTerrain(col, row))) continue;

      const terrain = map.getTerrain(col, row);

      // Filter definitions to those eligible for this cell.
      const eligibleDefs = definitions.filter(def => {
        if (def.allowedTerrains && !def.allowedTerrains.includes(terrain)) return false;
        if (def.canSpawnAt && !def.canSpawnAt(map, col, row)) return false;
        return true;
      });
      if (eligibleDefs.length === 0) continue;

      const q      = col - (row - (row & 1)) / 2;
      const center = hexToWorld(layout, { q, r: row });
      const worldY = cellWorldY(map, layout, col, row);
      const corners = hexCorners(layout, { q, r: row });

      // Center slot — skip if river or any road through the cell
      if (!map.hasRiver(col, row) && !map.hasRoads(col, row)) {
        addSlot(center.x, center.z, worldY, col, row, map.width, map, eligibleDefs, hashGrid, accumulator, cellAccumulator, collectionRef);
      }

      // 6 direction slots — skip if river or road through that edge (i = face index 0-5)
      for (let i = 0; i < 6; i++) {
        if (map.hasRiverThroughEdge(col, row, i)) continue;
        if (map.hasRoadThroughEdge(col, row, i)) continue;

        const i1 = (i + 1) % 6;
        const fx = (center.x + corners[i].x + corners[i1].x) / 3;
        const fz = (center.z + corners[i].z + corners[i1].z) / 3;

        addSlot(fx, fz, worldY, col, row, map.width, map, eligibleDefs, hashGrid, accumulator, cellAccumulator, collectionRef);
      }
    }
  }

  const meshes: THREE.InstancedMesh[] = [];

  for (const [key, matrices] of accumulator) {
    const ref  = collectionRef.get(key)!;
    const coll = ref.def.tiers[ref.tierIdx][ref.variantIdx];
    const mesh = new THREE.InstancedMesh(coll.geometry, coll.material, matrices.length);
    mesh.frustumCulled = false;
    for (let i = 0; i < matrices.length; i++) {
      mesh.setMatrixAt(i, matrices[i]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.fogCellIndices = new Int32Array(cellAccumulator.get(key)!);
    const origMatrices = new Float32Array(matrices.length * 16);
    for (let i = 0; i < matrices.length; i++) matrices[i].toArray(origMatrices, i * 16);
    mesh.userData.originalMatrices = origMatrices;
    meshes.push(mesh);
  }

  return meshes;
}
