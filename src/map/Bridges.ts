import type { HexMap } from './HexMap.js';

/**
 * Where a road meets a river inside one cell.
 *
 * Rivers and roads both run from a cell's centre out through its edges, so a
 * road never "crosses" a river on an edge — the crossing happens inside the
 * cell, where the road has to get from one bank to the other. The geometry
 * builder keeps each road fragment on its own bank by pushing its centre
 * point sideways, and a bridge is what joins the two bank centres when both
 * banks carry road. These helpers answer the map-level half of that question
 * — which edges lie on which bank, and whether a cell earns a deck — so the
 * chunk builder, the pathfinder, and any game rule agree on it.
 */

/**
 * Which bank each edge of a river cell lies on.
 *
 * Returns six entries indexed by edge: `-1` for the two edges the river runs
 * through, `0` for the edges on one bank and `1` for the other. Returns `null`
 * when the cell has no through-river — no river, a source or mouth (the
 * channel ends at the centre, so there is only one bank), a confluence (three
 * or more channels, no road is drawn there at all), or a hairpin where the
 * river enters and leaves through adjacent edges, which leaves one bank with
 * no edges on it.
 */
export function riverBanks(map: HexMap, col: number, row: number): Int8Array | null {
  const inDir  = map.getIncomingRiverDir(col, row);
  const outDir = map.getOutgoingRiverDir(col, row);
  if (inDir < 0 || outDir < 0 || inDir === outDir) return null;
  // Only ever two channels: a confluence gets no road, so it gets no bridge.
  let count = 0;
  for (let e = 0; e < 6; e++) if (map.hasRiverThroughEdge(col, row, e)) count++;
  if (count !== 2) return null;

  const banks = new Int8Array(6).fill(-1);
  // Bank 0 runs clockwise from just past the inflow to just before the outflow;
  // bank 1 is the rest. A hairpin (adjacent edges) leaves one of them empty.
  let n0 = 0, n1 = 0;
  for (let e = (inDir + 1) % 6; e !== outDir; e = (e + 1) % 6) { banks[e] = 0; n0++; }
  for (let e = (outDir + 1) % 6; e !== inDir; e = (e + 1) % 6) { banks[e] = 1; n1++; }
  return n0 > 0 && n1 > 0 ? banks : null;
}

/**
 * True when a road crosses the river inside this cell — the river runs
 * through it and there is road on **both** banks. This is the cell the chunk
 * builder spans with a deck, and the cell a land unit can cross dry-shod.
 *
 * A road that reaches a river cell from one side and stops there is a jetty,
 * not a crossing, and gets no deck.
 */
export function hasBridge(map: HexMap, col: number, row: number): boolean {
  const banks = riverBanks(map, col, row);
  if (!banks) return false;
  let road0 = false, road1 = false;
  for (let e = 0; e < 6; e++) {
    if (!map.hasRoadThroughEdge(col, row, e)) continue;
    if (banks[e] === 0) road0 = true;
    else if (banks[e] === 1) road1 = true;
  }
  return road0 && road1;
}
