import type { HexMap } from '../map/HexMap.js';
import { offsetToHex, hexToOffset, hexDistance, hexRange, offsetNeighbor } from '../math/HexCoord.js';

export interface MountainRangeOptions {
  /** Number of mountain ranges to raise across the landmass. Default 0 (off). */
  mountainRanges?: number;
  /**
   * Peak uplift added along a range's spine, falling off by 1 per cell of
   * distance — so it is also the half-width of the range. Default 4.
   */
  rangeUplift?: number;
  /** Elevation cap — uplifted cells never exceed this. Default 12. */
  elevationMax?: number;
}

/** Sampling attempts when looking for a random land cell. */
const LAND_TRIES = 60;
/** How many end candidates compete for the farthest-from-start slot. */
const END_CANDIDATES = 5;
/** Ranges shorter than this are skipped — a 3-cell "range" is just a bump. */
const MIN_SPAN = 4;

function randomLandCell(map: HexMap, rand: () => number): { col: number; row: number } | null {
  for (let t = 0; t < LAND_TRIES; t++) {
    const col = Math.floor(rand() * map.width);
    const row = Math.floor(rand() * map.height);
    if (map.getElevation(col, row) >= 0) return { col, row };
  }
  return null;
}

/**
 * Raises mountain ranges over an already-generated landmass: each range is a
 * jittered walk between two far-apart land cells, uplifted along its spine
 * with a 1-per-cell falloff. This is what gives chunk-built continents a
 * skeleton — ridgelines with foothills grading down to coastal plains —
 * instead of height landing wherever chunk overlap happened to stack.
 *
 * Land-only by design: the walk stops at coasts and water cells are never
 * uplifted, so the pass cannot change the land percentage the chunk stage
 * placed. Runs before erosion, which then softens the ridges naturally.
 * Deterministic for a given map state, options, and `rand`; consumes no
 * randomness when `mountainRanges` is 0 or unset.
 */
export function applyMountainRanges(
  map: HexMap,
  opts: MountainRangeOptions,
  rand: () => number,
): void {
  const count = opts.mountainRanges ?? 0;
  if (count <= 0) return;
  const uplift   = Math.max(1, Math.round(opts.rangeUplift ?? 4));
  const elevMax  = opts.elevationMax ?? 12;
  const maxSteps = map.width + map.height;

  for (let i = 0; i < count; i++) {
    const start = randomLandCell(map, rand);
    if (!start) return; // no land at all — nothing to do for any range
    const startHex = offsetToHex(start.col, start.row);

    // End: the farthest of a handful of land candidates, so ranges tend to
    // span the landmass rather than hop between neighbors.
    let end: { col: number; row: number } | null = null;
    let bestDist = -1;
    for (let k = 0; k < END_CANDIDATES; k++) {
      const c = randomLandCell(map, rand);
      if (!c) continue;
      const d = hexDistance(offsetToHex(c.col, c.row), startHex);
      if (d > bestDist) { bestDist = d; end = c; }
    }
    if (!end || bestDist < MIN_SPAN) continue;

    // Greedy jittered walk start → end. Land only — a range ends where the
    // sea begins — and no revisits, so the jitter cannot trap it in a loop.
    const endHex  = offsetToHex(end.col, end.row);
    const ridge: { col: number; row: number }[] = [];
    const visited = new Set<number>();
    let cur = start;
    for (let s = 0; s < maxSteps; s++) {
      ridge.push(cur);
      visited.add(cur.row * map.width + cur.col);
      if (cur.col === end.col && cur.row === end.row) break;

      let next: { col: number; row: number } | null = null;
      let bestScore = Infinity;
      for (let d = 0; d < 6; d++) {
        const nb = offsetNeighbor(cur.col, cur.row, d);
        if (!map.inBounds(nb.col, nb.row)) continue;
        const nbElev = map.getElevation(nb.col, nb.row);
        if (nbElev < 0) continue;
        if (visited.has(nb.row * map.width + nb.col)) continue;
        // Distance dominates (×4 per step) so the walk always makes progress;
        // the elevation bonus lets it detour up to ~2 cells to follow high
        // ground, so ridges trace the terrain that is already there.
        const score = hexDistance(offsetToHex(nb.col, nb.row), endHex) * 4
                    - Math.min(nbElev, 8)
                    + (rand() < 0.35 ? 4 : 0);
        if (score < bestScore) { bestScore = score; next = nb; }
      }
      if (!next) break;
      cur = next;
    }

    // Collect the max uplift per cell first, then apply once — adjacent spine
    // cells share most of their neighborhoods, and stacking their overlaps
    // would turn the falloff profile into a wall.
    const adds = new Map<number, number>();
    for (const cell of ridge) {
      const center = offsetToHex(cell.col, cell.row);
      for (const h of hexRange(center, uplift - 1)) {
        const off = hexToOffset(h);
        if (!map.inBounds(off.col, off.row)) continue;
        const add = uplift - hexDistance(h, center);
        const key = off.row * map.width + off.col;
        if ((adds.get(key) ?? 0) < add) adds.set(key, add);
      }
    }
    for (const [key, add] of adds) {
      const col = key % map.width;
      const row = (key - col) / map.width;
      const elev = map.getElevation(col, row);
      if (elev < 0) continue;
      map.setElevation(col, row, Math.min(elevMax, elev + add));
    }
  }
}
