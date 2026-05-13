import { TerrainType } from '../map/HexCell.js';
import type { HexMap } from '../map/HexMap.js';
import { POINTY_TOP } from '../math/HexOrientation.js';
import { offsetNeighbor } from '../math/HexCoord.js';

const EDGE_DIRS = POINTY_TOP.edgeDirections;

export interface RiverGeneratorOptions {
  /** Coarse grid spacing in cells between river seed candidates. Default 48. */
  gridSpacing?: number;
  /** Minimum elevation for a cell to seed a river. Default 5. */
  minSeedElevation?: number;
  /** Maximum steps a traced river will take. Default 60. */
  maxSteps?: number;
}

export interface ClimateRiverOptions {
  /** Percentage of land cells that may have rivers (0–20). Default 10. */
  riverPercentage?: number;
  /** Probability (0–1) of forming a lake when a river gets stuck. Default 0.25. */
  extraLakeProbability?: number;
  /** Maximum steps per river trace. Default 100. */
  maxSteps?: number;
  /** Maximum land elevation — used for origin weighting. Default 12. */
  elevationMax?: number;
}

function traceRiver(map: HexMap, col: number, row: number, maxSteps: number): void {
  let c = col, r = row;
  const visited = new Set<number>();

  for (let step = 0; step < maxSteps; step++) {
    if (map.getTerrain(c, r) === TerrainType.Water) break;

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

// ---- Climate-driven river generator ----

function traceClimateRiver(
  map: HexMap,
  startCol: number, startRow: number,
  maxSteps: number,
  lakeProbability: number,
  rand: () => number,
): number {
  let c = startCol, r = startRow;
  let prevFace = -1;
  let steps = 0;
  const visited = new Set<number>();

  for (let step = 0; step < maxSteps; step++) {
    if (map.getTerrain(c, r) === TerrainType.Water) break;
    const key = r * map.width + c;
    if (visited.has(key)) break;
    visited.add(key);

    const curElev = map.getElevation(c, r);
    let totalWeight = 0;
    const weights: number[] = [];

    for (let face = 0; face < 6; face++) {
      const nb = offsetNeighbor(c, r, EDGE_DIRS[face]);
      if (!map.inBounds(nb.col, nb.row)) { weights.push(0); continue; }
      if (map.hasIncomingRiver(nb.col, nb.row)) { weights.push(0); continue; }

      let w = 1;

      // Momentum: disallow reversals (> 120° turn)
      if (prevFace >= 0) {
        const delta = Math.min((face - prevFace + 6) % 6, (prevFace - face + 6) % 6);
        if (delta > 2) { weights.push(0); continue; }
      }

      // Triple weight for downhill steps
      if (map.getElevation(nb.col, nb.row) < curElev) w *= 3;

      weights.push(w);
      totalWeight += w;
    }

    if (totalWeight === 0) {
      // Stuck — optionally form a lake by levelling to the lowest neighbour
      if (rand() < lakeProbability) {
        let minElev = Infinity;
        let minNb = { col: -1, row: -1 };
        for (let d = 0; d < 6; d++) {
          const nb = offsetNeighbor(c, r, d);
          if (!map.inBounds(nb.col, nb.row)) continue;
          const e = map.getElevation(nb.col, nb.row);
          if (e < minElev) { minElev = e; minNb = nb; }
        }
        if (minNb.col >= 0) map.setElevation(c, r, minElev);
      }
      break;
    }

    // Weighted-random face selection
    let pick = rand() * totalWeight;
    let chosenFace = 0;
    for (let face = 0; face < 6; face++) {
      pick -= weights[face];
      if (pick <= 0) { chosenFace = face; break; }
    }

    const nb = offsetNeighbor(c, r, EDGE_DIRS[chosenFace]);
    map.setRiverOutgoing(c, r, chosenFace);
    map.setRiverIncoming(nb.col, nb.row, (chosenFace + 3) % 6);

    if (map.getTerrain(nb.col, nb.row) === TerrainType.Water) break;

    prevFace = chosenFace;
    c = nb.col;
    r = nb.row;
    steps++;
  }

  return steps;
}

/**
 * Climate-driven river placement: origins are weighted by moisture × elevation,
 * traced downhill with momentum. Replaces the coarse-grid seeding used by
 * the FBM generator.
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

  // Build weighted origin list (high moisture + high elevation → more entries)
  const origins: [number, number][] = [];
  map.forEach((col, row) => {
    if (map.getTerrain(col, row) === TerrainType.Water) return;
    const elev = map.getElevation(col, row);
    if (elev <= 0) return;
    const w = moisture[row * map.width + col] * elev / elevMax;
    const entries = w > 0.75 ? 4 : w > 0.5 ? 3 : w > 0.25 ? 2 : 0;
    for (let i = 0; i < entries; i++) origins.push([col, row]);
  });

  // Fisher-Yates shuffle
  for (let i = origins.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = origins[i]; origins[i] = origins[j]; origins[j] = tmp;
  }

  // Count land cells for budget
  let landCount = 0;
  map.forEach((col, row) => { if (map.getTerrain(col, row) !== TerrainType.Water) landCount++; });
  let budget = Math.floor(landCount * riverPct / 100);

  for (const [col, row] of origins) {
    if (budget <= 0) break;

    // Keep-distance: skip origins adjacent to existing rivers or water
    if (map.hasRiver(col, row)) continue;
    let tooClose = false;
    for (let d = 0; d < 6; d++) {
      const nb = offsetNeighbor(col, row, d);
      if (!map.inBounds(nb.col, nb.row)) continue;
      if (map.getTerrain(nb.col, nb.row) === TerrainType.Water || map.hasRiver(nb.col, nb.row)) {
        tooClose = true; break;
      }
    }
    if (tooClose) continue;

    budget -= traceClimateRiver(map, col, row, maxSteps, lakePct, rand);
  }
}

// ---- Simple grid-seeded river generator (used by FBM generator) ----

/**
 * Seeds rivers from high-elevation cells on a coarse grid and traces each downhill
 * until it reaches water or a dead end.
 */
export function generateRivers(map: HexMap, opts: RiverGeneratorOptions = {}): void {
  const gridSpacing      = opts.gridSpacing      ?? 48;
  const minSeedElevation = opts.minSeedElevation ?? 5;
  const maxSteps         = opts.maxSteps         ?? 60;

  for (let row = gridSpacing / 2; row < map.height; row += gridSpacing) {
    for (let col = gridSpacing / 2; col < map.width; col += gridSpacing) {
      if (!map.inBounds(col, row)) continue;
      if (map.getTerrain(col, row) === TerrainType.Water) continue;
      if (map.getElevation(col, row) >= minSeedElevation) {
        traceRiver(map, col, row, maxSteps);
      }
    }
  }
}
