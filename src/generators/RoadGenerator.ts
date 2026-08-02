import type { HexMap } from '../map/HexMap.js';
import { POINTY_TOP, type HexOrientation } from '../math/HexOrientation.js';
import { offsetNeighbor, HEX_DIRECTIONS } from '../math/HexCoord.js';
import { DEFAULT_WATER_TERRAIN_INDEX } from '../geometry/TerrainTypes.js';

export interface RoadGeneratorOptions {
  /** Grid spacing between parallel horizontal and vertical road bands. Default 24. */
  gridSpacing?: number;
  /** Maximum elevation difference between adjacent cells for a road to continue. Default 1. */
  maxElevationDiff?: number;
  /** Terrain index(es) treated as impassable water. Default [5] (built-in Water). */
  waterTerrainIndex?: number | number[];
  /**
   * Hex orientation providing the edge-index → direction mapping. Must match
   * the layout used for rendering or road edges point at the wrong neighbors.
   * Default POINTY_TOP. Note: the offset-grid traversal (odd-r rows) assumes a
   * pointy-top layout — see the library's offset coordinate convention.
   */
  orientation?: HexOrientation;
}

function traceRoad(
  map: HexMap,
  col: number,
  row: number,
  getFaceIndex: (row: number) => number,
  steps: number,
  maxElevDiff: number,
  waterTerrains: Set<number>,
  edgeDirs: readonly number[],
): void {
  let c = col, r = row;
  for (let s = 0; s < steps; s++) {
    const faceIdx = getFaceIndex(r);
    const nb = offsetNeighbor(c, r, edgeDirs[faceIdx]);
    if (!map.inBounds(nb.col, nb.row)) break;
    if (waterTerrains.has(map.getTerrain(c, r))) break;
    if (waterTerrains.has(map.getTerrain(nb.col, nb.row))) break;
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
  const gridSpacing = opts.gridSpacing     ?? 24;
  const maxElevDiff = opts.maxElevationDiff ?? 1;
  const raw         = opts.waterTerrainIndex ?? DEFAULT_WATER_TERRAIN_INDEX;
  const waterTerrains = new Set(Array.isArray(raw) ? raw : [raw]);
  const edgeDirs    = (opts.orientation ?? POINTY_TOP).edgeDirections;

  // Derive face indices from the orientation's edge mapping instead of
  // hardcoding them, so a different edgeDirections ordering still traces
  // the intended axial directions.
  const faceOf = (dq: number, dr: number): number => {
    for (let f = 0; f < 6; f++) {
      const d = HEX_DIRECTIONS[edgeDirs[f]];
      if (d.q === dq && d.r === dr) return f;
    }
    throw new Error('generateRoads: orientation edgeDirections is missing a required axial direction');
  };
  const eastFace      = faceOf(1, 0);   // same row, +col
  const southEastFace = faceOf(0, 1);   // drifts right on odd rows
  const southWestFace = faceOf(-1, 1);  // corrects back on even rows

  // Horizontal roads — eastward along the row
  for (let row = gridSpacing / 2; row < map.height; row += gridSpacing) {
    traceRoad(map, 0, row, () => eastFace, map.width, maxElevDiff, waterTerrains, edgeDirs);
  }

  // Vertical roads: alternating SE/SW keeps the path on the same column (odd-r offset).
  for (let col = gridSpacing / 2; col < map.width; col += gridSpacing) {
    traceRoad(map, col, 0, r => r % 2 === 0 ? southEastFace : southWestFace, map.height, maxElevDiff, waterTerrains, edgeDirs);
  }
}
