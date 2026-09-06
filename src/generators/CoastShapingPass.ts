import type { HexMap } from '../map/HexMap.js';
import { offsetNeighbor } from '../math/HexCoord.js';

export interface CoastShapingOptions {
  /**
   * How strongly land elevation is pulled toward a distance-from-coast
   * profile, 0–1. 0 leaves the stacked chunk heights alone (default); 1
   * replaces them outright. Mid values keep the chunk detail but make
   * elevation rise inland — coastal lowlands, high interior — which is how
   * continents read.
   */
  coastShaping?: number;
  /** Maximum land elevation the profile rises toward. Default 12. */
  elevationMax?: number;
}

/**
 * Reshapes land elevation by blending it with a distance-from-coast field:
 * every land cell's target height grows with its BFS distance from the
 * nearest water, normalized by the farthest interior point. Water cells are
 * never touched, and land never drops below 0 or above elevationMax, so the
 * land/water split the chunk stage placed is preserved exactly.
 *
 * Runs between the landmass and mountain-range passes: ranges then rise from
 * an interior that is already the high ground. Deterministic and rand-free.
 */
export function applyCoastShaping(map: HexMap, opts: CoastShapingOptions): void {
  const strength = opts.coastShaping ?? 0;
  if (strength <= 0) return;
  const elevMax = opts.elevationMax ?? 12;

  // Multi-source BFS from every coastal land cell.
  const dist = new Int32Array(map.width * map.height).fill(-1);
  let frontier: number[] = [];
  map.forEach((col, row) => {
    if (map.getElevation(col, row) < 0) return;
    for (let d = 0; d < 6; d++) {
      const nb = offsetNeighbor(col, row, d);
      if (map.inBounds(nb.col, nb.row) && map.getElevation(nb.col, nb.row) < 0) {
        const key = row * map.width + col;
        dist[key] = 0;
        frontier.push(key);
        return;
      }
    }
  });
  // No coast at all (all land or all water) — no gradient to shape toward.
  if (frontier.length === 0) return;

  let maxDist = 0;
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const key of frontier) {
      const col = key % map.width;
      const row = (key - col) / map.width;
      const nd = dist[key] + 1;
      for (let d = 0; d < 6; d++) {
        const nb = offsetNeighbor(col, row, d);
        if (!map.inBounds(nb.col, nb.row)) continue;
        const nbKey = nb.row * map.width + nb.col;
        if (dist[nbKey] !== -1 || map.getElevation(nb.col, nb.row) < 0) continue;
        dist[nbKey] = nd;
        next.push(nbKey);
      }
    }
    if (next.length > 0) maxDist = dist[next[0]];
    frontier = next;
  }
  // Every land cell is coastal — there is no interior to raise toward.
  if (maxDist === 0) return;

  map.forEach((col, row) => {
    const key = row * map.width + col;
    if (dist[key] < 0) return; // water, or land unreached (no coast in its component)
    const elev   = map.getElevation(col, row);
    // Slightly convex profile: broad low coastal shelf, steeper rise inland.
    const target = elevMax * Math.pow(dist[key] / maxDist, 1.3);
    const shaped = Math.round(elev + (target - elev) * strength);
    map.setElevation(col, row, Math.min(elevMax, Math.max(0, shaped)));
  });
}
