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
