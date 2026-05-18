import type { HexMap } from '../map/HexMap.js';
import type { MapGeneratorPlugin } from './MapGeneratorPlugin.js';
import { makeRng } from '../math/Random.js';
import { TerrainType } from '../map/HexCell.js';
import { POINTY_TOP } from '../math/HexOrientation.js';
import { offsetNeighbor } from '../math/HexCoord.js';

// Lava and acid terrain indices registered in the demo's extended descriptor list.
// Cast to TerrainType — these are valid uint8 terrain indices even though they
// extend beyond the built-in enum values.
const LAVA_TERRAIN = 6 as TerrainType;
const ACID_TERRAIN = 7 as TerrainType;

const EDGE_DIRS = POINTY_TOP.edgeDirections;

/**
 * Traces a river downhill from (startCol, startRow) until it reaches any liquid
 * terrain (water, lava, acid, …) or negative elevation. Stops at all liquid types
 * so rivers don't accidentally pass through lava or acid pools.
 */
function traceDemoRiver(
  map: HexMap,
  startCol: number,
  startRow: number,
  maxSteps: number,
  liquidTerrains: Set<number>,
): void {
  let c = startCol, r = startRow;
  const visited = new Set<number>();

  for (let step = 0; step < maxSteps; step++) {
    if (map.getElevation(c, r) < 0 || liquidTerrains.has(map.getTerrain(c, r))) break;

    const cellKey = r * map.width + c;
    if (visited.has(cellKey)) break;
    visited.add(cellKey);

    const ownElev = map.getElevation(c, r);
    let bestEdge = -1;
    let bestElev = ownElev + 1;
    let bestNbC  = -1;
    let bestNbR  = -1;

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

    // Stop at liquid terrain OR when joining an existing river (prevents two traces
    // from trampling each other's downstream chain and causing type changes).
    if (liquidTerrains.has(map.getTerrain(bestNbC, bestNbR))) break;
    if (map.hasOutgoingRiver(bestNbC, bestNbR)) break;
    c = bestNbC;
    r = bestNbR;
  }
}

interface LiquidShowcaseConfig {
  lavaElevation: number;
  acidElevation: number;
}

/**
 * Demo generator showing all three built-in liquid types on one map:
 *   - Water ocean (surrounding the island)
 *   - Lava caldera lake (high-elevation volcanic crater)
 *   - Acid pools (low-elevation swamp on the western side)
 *   - Water rivers flowing from the volcanic slopes to the ocean
 */
export const LiquidShowcasePlugin: MapGeneratorPlugin<LiquidShowcaseConfig> = {
  id:   'liquid-showcase',
  name: 'Liquid Showcase',
  defaultConfig: { lavaElevation: 7, acidElevation: 1 },

  generate(map: HexMap, config: LiquidShowcaseConfig, seed: number): void {
    const rand = makeRng(seed);
    const w = map.width;
    const h = map.height;

    // Volcanic caldera (lava lake) — northern half of the island
    const lavaCX = w * 0.5;
    const lavaCZ = h * 0.35;
    const lavaFloor = config.lavaElevation - 1;
    const lavaElev  = config.lavaElevation;
    const rimElev   = lavaElev + 4;

    const lavaLakeR  = Math.min(w, h) * 0.09;
    const lavaRimR   = lavaLakeR * 2.2;
    const lavaSlopeR = lavaRimR * 1.7;

    // Acid swamp — southern-west region
    const acidCX = w * 0.25;
    const acidCZ = h * 0.65;
    const acidFloor = config.acidElevation - 1;
    const acidR1    = Math.min(w, h) * 0.08;
    const acidR2    = Math.min(w, h) * 0.055;

    const coastR = Math.min(w, h) * 0.48;

    map.forEach((col, row) => {
      const jitter = (rand() - 0.5) * 2.5;

      const dlava  = Math.hypot(col - lavaCX, row - lavaCZ);
      const dacid1 = Math.hypot(col - acidCX, row - acidCZ);
      const dacid2 = Math.hypot(col - (acidCX + 8), row - (acidCZ - 5));
      const dCoast = Math.hypot(col - w * 0.5, row - h * 0.5);

      if (dCoast > coastR + jitter) {
        map.setTerrain(col, row, TerrainType.Water);
        map.setElevation(col, row, -1);
        return;
      }

      if (dlava < lavaLakeR + jitter) {
        map.setTerrain(col, row, LAVA_TERRAIN);
        map.setElevation(col, row, lavaFloor);
        return;
      }

      if (dlava < lavaRimR + jitter) {
        const t = (dlava - lavaLakeR) / (lavaRimR - lavaLakeR);
        const elev = Math.round(lavaElev + (rimElev - lavaElev) * Math.sin(t * Math.PI));
        map.setTerrain(col, row, TerrainType.Rock);
        map.setElevation(col, row, Math.max(lavaElev, elev));
        return;
      }

      if (dlava < lavaSlopeR + jitter) {
        const t = (dlava - lavaRimR) / (lavaSlopeR - lavaRimR);
        const elev = Math.round(lavaElev * (1 - t * t));
        const terrain = elev > lavaElev - 1 ? TerrainType.Rock
                      : elev > 2            ? TerrainType.Grassland
                      :                       TerrainType.Mud;
        map.setTerrain(col, row, terrain);
        map.setElevation(col, row, Math.max(0, elev));
        return;
      }

      if (dacid1 < acidR1 + jitter || dacid2 < acidR2 + jitter) {
        map.setTerrain(col, row, ACID_TERRAIN);
        map.setElevation(col, row, acidFloor);
        return;
      }

      const distFromCenter = Math.hypot(col - w * 0.5, row - h * 0.5);
      const t = distFromCenter / coastR;
      const elev = Math.round((1 - t) * 3);
      const terrain = elev > 0 ? TerrainType.Grassland : TerrainType.Mud;
      map.setTerrain(col, row, terrain);
      map.setElevation(col, row, Math.max(0, elev));
    });

    // --- Rivers ---
    // traceDemoRiver stops at any liquid terrain (water, lava, acid) and also
    // stops when merging into an already-traced river to keep chains consistent.
    const liquidTerrains = new Set<number>([
      TerrainType.Water as number,
      LAVA_TERRAIN      as number,
      ACID_TERRAIN      as number,
    ]);

    // Lava rivers — inner crater wall, distance 1.1–1.25 × lavaLakeR from center.
    // At this distance the terrain reliably slopes inward toward the lava lake,
    // so the trace flows down into the caldera and terminates at lava terrain.
    const numLavaRivers = 2 + Math.floor(rand() * 3);
    const lavaAngle0 = rand() * Math.PI * 2;
    for (let i = 0; i < numLavaRivers; i++) {
      const angle = lavaAngle0 + (i / numLavaRivers) * Math.PI * 2 + (rand() - 0.5) * 0.4;
      const dist  = lavaLakeR * 1.1 + rand() * lavaLakeR * 0.15;
      const col = Math.round(lavaCX + Math.cos(angle) * dist);
      const row = Math.round(lavaCZ + Math.sin(angle) * dist);
      if (map.inBounds(col, row)) traceDemoRiver(map, col, row, 100, liquidTerrains);
    }

    // Outer slope rivers — scattered around the whole caldera at distance
    // just beyond the rim. Terrain determines the destination: seeds facing
    // the ocean become water rivers; seeds facing the acid swamp become acid.
    const numSlopeRivers = 4 + Math.floor(rand() * 4);
    const slopeAngle0 = rand() * Math.PI * 2;
    for (let i = 0; i < numSlopeRivers; i++) {
      const angle = slopeAngle0 + (i / numSlopeRivers) * Math.PI * 2 + (rand() - 0.5) * 0.5;
      const dist  = lavaRimR + rand() * (lavaSlopeR - lavaRimR) * 0.6;
      const col = Math.round(lavaCX + Math.cos(angle) * dist);
      const row = Math.round(lavaCZ + Math.sin(angle) * dist);
      if (map.inBounds(col, row)) traceDemoRiver(map, col, row, 100, liquidTerrains);
    }

    // Acid perimeter — dedicated seeds around the acid pool to guarantee
    // some acid rivers regardless of how the slope seeds happen to face.
    const numAcidRivers = 1 + Math.floor(rand() * 2);
    const acidAngle0 = rand() * Math.PI * 2;
    for (let i = 0; i < numAcidRivers; i++) {
      const angle = acidAngle0 + (i / numAcidRivers) * Math.PI * 2 + (rand() - 0.5) * 0.5;
      const dist  = acidR1 * 1.4 + rand() * acidR1 * 0.8;
      const col = Math.round(acidCX + Math.cos(angle) * dist);
      const row = Math.round(acidCZ + Math.sin(angle) * dist);
      if (map.inBounds(col, row)) traceDemoRiver(map, col, row, 100, liquidTerrains);
    }

    map.computeWaterSurfaces(t => t === TerrainType.Water || t === LAVA_TERRAIN || t === ACID_TERRAIN);
  },
};
