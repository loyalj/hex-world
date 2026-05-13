import { TerrainType } from '../map/HexCell.js';
import type { HexMap } from '../map/HexMap.js';
import { POINTY_TOP } from '../math/HexOrientation.js';
import { offsetNeighbor } from '../math/HexCoord.js';

const EDGE_DIRS = POINTY_TOP.edgeDirections;

export interface RoadGeneratorOptions {
  /** Grid spacing between parallel horizontal and vertical road bands. Default 24. */
  gridSpacing?: number;
  /** Maximum elevation difference between adjacent cells for a road to continue. Default 1. */
  maxElevationDiff?: number;
}

function traceRoad(
  map: HexMap,
  col: number,
  row: number,
  getFaceIndex: (row: number) => number,
  steps: number,
  maxElevDiff: number,
): void {
  let c = col, r = row;
  for (let s = 0; s < steps; s++) {
    const faceIdx = getFaceIndex(r);
    const nb = offsetNeighbor(c, r, EDGE_DIRS[faceIdx]);
    if (!map.inBounds(nb.col, nb.row)) break;
    if (map.getTerrain(c, r) === TerrainType.Water) break;
    if (map.getTerrain(nb.col, nb.row) === TerrainType.Water) break;
    if (Math.abs(map.getElevation(c, r) - map.getElevation(nb.col, nb.row)) > maxElevDiff) break;
    if (map.hasRiverThroughEdge(c, r, faceIdx)) break;
    const oppFace = (faceIdx + 3) % 6;
    map.setRoad(c, r, faceIdx, true);
    map.setRoad(nb.col, nb.row, oppFace, true);
    c = nb.col;
    r = nb.row;
  }
}

/**
 * Lays a grid of horizontal and vertical roads across the map.
 * Roads break at water, steep elevation changes, and river crossings.
 */
export function generateRoads(map: HexMap, opts: RoadGeneratorOptions = {}): void {
  const gridSpacing    = opts.gridSpacing    ?? 24;
  const maxElevDiff    = opts.maxElevationDiff ?? 1;

  // Horizontal roads (face 5 = rightward along same row)
  for (let row = gridSpacing / 2; row < map.height; row += gridSpacing) {
    traceRoad(map, 0, row, () => 5, map.width, maxElevDiff);
  }

  // Vertical roads: face 0 on even rows, face 1 on odd rows keeps path on same column.
  // (face 0 = {q:0,r:+1} drifts right on odd rows; face 1 = {q:-1,r:+1} corrects back)
  for (let col = gridSpacing / 2; col < map.width; col += gridSpacing) {
    traceRoad(map, col, 0, r => r % 2 === 0 ? 0 : 1, map.height, maxElevDiff);
  }
}
