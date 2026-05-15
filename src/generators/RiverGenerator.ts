import { TerrainType } from '../map/HexCell.js';
import type { HexMap } from '../map/HexMap.js';
import { POINTY_TOP } from '../math/HexOrientation.js';
import { offsetNeighbor } from '../math/HexCoord.js';
import { DEFAULT_WATER_TERRAIN_INDEX } from '../geometry/TerrainTypes.js';

const EDGE_DIRS = POINTY_TOP.edgeDirections;

export interface RiverGeneratorOptions {
  /** Coarse grid spacing in cells between river seed candidates. Default 48. */
  gridSpacing?: number;
  /** Minimum elevation for a cell to seed a river. Default 5. */
  minSeedElevation?: number;
  /** Maximum steps a traced river will take. Default 60. */
  maxSteps?: number;
  /** Terrain index assigned to lake cells. Default 5 (built-in Water). */
  waterTerrainIndex?: number;
}

export interface ClimateRiverOptions {
  /** Percentage of land cells that may have rivers (0–20). Default 10. */
  riverPercentage?: number;
  /** Probability (0–1) of forming a mid-flow lake. Default 0.25. */
  extraLakeProbability?: number;
  /** Maximum steps per river trace. Default 100. */
  maxSteps?: number;
  /** Maximum land elevation — used for origin weighting. Default 12. */
  elevationMax?: number;
  /** Terrain index assigned to lake cells. Default 5 (built-in Water). */
  waterTerrainIndex?: number;
}

// ---- Climate-driven river generator ----

function traceClimateRiver(
  map: HexMap,
  startCol: number, startRow: number,
  maxSteps: number,
  lakeProbability: number,
  rand: () => number,
  waterIdx: number,
): number {
  let c = startCol, r = startRow;
  let prevFace = -1;
  let length = 1; // counts the origin cell, matching tutorial budget semantics

  for (let step = 0; step < maxSteps; step++) {
    if (map.getElevation(c, r) < 0) break; // reached water

    const curElev = map.getElevation(c, r);

    // Track min neighbour elevation for ALL in-bounds neighbours (needed for lake logic)
    let minNbElev = Infinity;
    const flowWeights = [0, 0, 0, 0, 0, 0];
    let totalWeight = 0;
    let mergeFace = -1;

    for (let face = 0; face < 6; face++) {
      const nb = offsetNeighbor(c, r, EDGE_DIRS[face]);
      if (!map.inBounds(nb.col, nb.row)) continue;

      const nbElev = map.getElevation(nb.col, nb.row);
      if (nbElev < minNbElev) minNbElev = nbElev; // before any filter

      if (nb.col === startCol && nb.row === startRow) continue; // skip origin
      if (map.hasIncomingRiver(nb.col, nb.row)) continue;

      const delta = nbElev - curElev;
      if (delta > 0) continue; // no uphill

      // Merge into an existing river origin (it has outgoing but no incoming yet)
      if (map.hasOutgoingRiver(nb.col, nb.row)) {
        mergeFace = face;
        break;
      }

      // Weight: 1 base + 3 downhill bonus + 1 momentum bonus
      let w = 1;
      if (delta < 0) w += 3;
      // Momentum: bonus for all directions EXCEPT ±2 face-steps from previous
      if (prevFace < 0 || (face !== (prevFace + 2) % 6 && face !== (prevFace + 4) % 6)) {
        w += 1;
      }

      flowWeights[face] = w;
      totalWeight += w;
    }

    // Merge: join the existing river and stop
    if (mergeFace >= 0) {
      const nb = offsetNeighbor(c, r, EDGE_DIRS[mergeFace]);
      map.setRiverOutgoing(c, r, mergeFace);
      map.setRiverIncoming(nb.col, nb.row, (mergeFace + 3) % 6);
      return length;
    }

    // Stuck: try to form a terminal lake
    if (totalWeight === 0) {
      if (length === 1) return 0; // couldn't leave origin — don't consume budget
      if (minNbElev >= curElev) {
        // Force elevation below sea level so the water surface renders correctly
        map.setTerrain(c, r, waterIdx);
        map.setElevation(c, r, -1);
      }
      break;
    }

    // Weighted-random face selection
    let pick = rand() * totalWeight;
    let chosenFace = 0;
    for (let face = 0; face < 6; face++) {
      pick -= flowWeights[face];
      if (pick <= 0) { chosenFace = face; break; }
    }

    const nb = offsetNeighbor(c, r, EDGE_DIRS[chosenFace]);
    map.setRiverOutgoing(c, r, chosenFace);
    map.setRiverIncoming(nb.col, nb.row, (chosenFace + 3) % 6);
    length++;

    // Extra lake at the current cell before moving on
    if (minNbElev >= curElev && rand() < lakeProbability) {
      map.setTerrain(c, r, TerrainType.Water);
      map.setElevation(c, r, -1); // below sea level so the water surface renders correctly
    }

    prevFace = chosenFace;
    c = nb.col;
    r = nb.row;
  }

  return length;
}

/**
 * Climate-driven river placement: origins are weighted by moisture × elevation,
 * traced downhill with momentum, merging, and lake formation.
 */
export function generateClimateRivers(
  map: HexMap,
  moisture: Float32Array,
  opts: ClimateRiverOptions,
  rand: () => number,
): void {
  const riverPct  = Math.min(20, opts.riverPercentage      ?? 10);
  const lakePct   = opts.extraLakeProbability ?? 0.25;
  const maxSteps  = opts.maxSteps             ?? 100;
  const elevMax   = opts.elevationMax         ?? 12;
  const waterIdx  = opts.waterTerrainIndex    ?? DEFAULT_WATER_TERRAIN_INDEX;

  // Build weighted origin list using additive ifs (matching tutorial exactly)
  const origins: [number, number][] = [];
  map.forEach((col, row) => {
    if (map.getElevation(col, row) <= 0) return; // water or sea-level
    const w = moisture[row * map.width + col] * map.getElevation(col, row) / elevMax;
    if (w > 0.75) { origins.push([col, row]); origins.push([col, row]); } // +2
    if (w > 0.5)  { origins.push([col, row]); }                           // +1
    if (w > 0.25) { origins.push([col, row]); }                           // +1
    // total: >0.75→4, 0.5–0.75→2, 0.25–0.5→1
  });

  // Fisher-Yates shuffle
  for (let i = origins.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = origins[i]; origins[i] = origins[j]; origins[j] = tmp;
  }

  // Count land cells for budget
  let landCount = 0;
  map.forEach((col, row) => { if (map.getElevation(col, row) >= 0) landCount++; });
  let budget = Math.floor(landCount * riverPct / 100);

  for (const [col, row] of origins) {
    if (budget <= 0) break;
    if (map.hasRiver(col, row)) continue;

    // Keep-distance: skip origins adjacent to any river or water
    let tooClose = false;
    for (let d = 0; d < 6; d++) {
      const nb = offsetNeighbor(col, row, d);
      if (!map.inBounds(nb.col, nb.row)) continue;
      if (map.getElevation(nb.col, nb.row) < 0 || map.hasRiver(nb.col, nb.row)) {
        tooClose = true; break;
      }
    }
    if (tooClose) continue;

    budget -= traceClimateRiver(map, col, row, maxSteps, lakePct, rand, waterIdx);
  }
}

// ---- Simple grid-seeded river generator (used by FBM generator) ----

function traceRiver(map: HexMap, col: number, row: number, maxSteps: number, waterIdx: number): void {
  let c = col, r = row;
  const visited = new Set<number>();

  for (let step = 0; step < maxSteps; step++) {
    if (map.getElevation(c, r) < 0 || map.getTerrain(c, r) === waterIdx) break;

    const cellKey = r * map.width + c;
    if (visited.has(cellKey)) break;
    visited.add(cellKey);

    const ownElev = map.getElevation(c, r);
    let bestEdge = -1;
    let bestElev = ownElev + 1;
    let bestNbC = -1, bestNbR = -1;

    for (let i = 0; i < 6; i++) {
      const nb = offsetNeighbor(c, r, EDGE_DIRS[i]);
      if (!map.inBounds(nb.col, nb.row)) continue;
      if (visited.has(nb.row * map.width + nb.col)) continue;
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

/**
 * Seeds rivers from high-elevation cells on a coarse grid and traces each downhill.
 * Used by the FBM generator.
 */
export function generateRivers(map: HexMap, opts: RiverGeneratorOptions = {}): void {
  const gridSpacing      = opts.gridSpacing       ?? 48;
  const minSeedElevation = opts.minSeedElevation  ?? 5;
  const maxSteps         = opts.maxSteps          ?? 60;
  const waterIdx         = opts.waterTerrainIndex ?? DEFAULT_WATER_TERRAIN_INDEX;

  for (let row = gridSpacing / 2; row < map.height; row += gridSpacing) {
    for (let col = gridSpacing / 2; col < map.width; col += gridSpacing) {
      if (!map.inBounds(col, row)) continue;
      if (map.getTerrain(col, row) === waterIdx) continue;
      if (map.getElevation(col, row) >= minSeedElevation) {
        traceRiver(map, col, row, maxSteps, waterIdx);
      }
    }
  }
}
