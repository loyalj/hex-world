import type { HexMap } from '../map/HexMap.js';
import { offsetNeighbor } from '../math/HexCoord.js';

/**
 * Port designation for naval movement.
 *
 * A port is a **shore** cell — land with at least one liquid neighbour — that
 * ships may enter and land units may embark from. It lives in the map's
 * per-cell metadata channel under {@link PORT_KEY}, so it serializes with the
 * map (binary, JSON, and `.hexpack`) and rides the editor's undo stack the
 * same way ownership and resources do: an editor writes it through
 * `MapTransaction.setCellData(col, row, PORT_KEY, true)`; a game can use
 * {@link setPort} directly.
 *
 * Which terrains count as liquid is the caller's to say — the same predicate
 * `HexWorld.isWater` or `buildWaterTerrainSet` gives you — because a lava
 * shore is not a harbour, and only the game knows which liquids float ships.
 */
export const PORT_KEY = 'port';

export type LiquidPredicate = (terrain: number) => boolean;

/** True if the cell carries the port flag. Does not re-check that it is still shore. */
export function isPort(map: HexMap, col: number, row: number): boolean {
  return map.getCellData(col, row, PORT_KEY) === true;
}

/**
 * Set or clear a port. Refuses (returns false) to set one on a cell that is
 * not shore — a port with no water beside it is a mistake that would only
 * show up as an unreachable dock later.
 */
export function setPort(map: HexMap, col: number, row: number, port: boolean, isLiquid: LiquidPredicate): boolean {
  if (port && !isShoreCell(map, col, row, isLiquid)) return false;
  map.setCellData(col, row, PORT_KEY, port ? true : undefined);
  return true;
}

/** A land cell with at least one in-bounds liquid neighbour. */
export function isShoreCell(map: HexMap, col: number, row: number, isLiquid: LiquidPredicate): boolean {
  if (!map.inBounds(col, row) || isLiquid(map.getTerrain(col, row))) return false;
  for (let d = 0; d < 6; d++) {
    const nb = offsetNeighbor(col, row, d);
    if (map.inBounds(nb.col, nb.row) && isLiquid(map.getTerrain(nb.col, nb.row))) return true;
  }
  return false;
}

/** The liquid cells adjacent to a cell — the water a port opens onto. */
export function shoreLiquidNeighbors(
  map: HexMap, col: number, row: number, isLiquid: LiquidPredicate,
): { col: number; row: number }[] {
  const out: { col: number; row: number }[] = [];
  for (let d = 0; d < 6; d++) {
    const nb = offsetNeighbor(col, row, d);
    if (map.inBounds(nb.col, nb.row) && isLiquid(map.getTerrain(nb.col, nb.row))) out.push(nb);
  }
  return out;
}

/** Every port on the map, from a walk of the sparse metadata store. */
export function listPorts(map: HexMap): { col: number; row: number }[] {
  const out: { col: number; row: number }[] = [];
  for (const [ci, record] of map.cellData) {
    if (record[PORT_KEY] === true) {
      const col = ci % map.width;
      out.push({ col, row: (ci - col) / map.width });
    }
  }
  return out;
}
