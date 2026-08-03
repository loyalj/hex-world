import type { HexMap } from '../map/HexMap.js';
import { offsetNeighbor } from '../math/HexCoord.js';

export interface ErosionOptions {
  /** Percentage of the initial erodible-cell count to eliminate (0–100). Default 50. */
  erosionPercentage?: number;
}

function isErodible(col: number, row: number, map: HexMap): boolean {
  const threshold = map.getElevation(col, row) - 2;
  for (let d = 0; d < 6; d++) {
    const nb = offsetNeighbor(col, row, d);
    if (map.inBounds(nb.col, nb.row) && map.getElevation(nb.col, nb.row) <= threshold) return true;
  }
  return false;
}

function getErosionTarget(
  col: number, row: number, map: HexMap, rand: () => number,
): { col: number; row: number } {
  const threshold = map.getElevation(col, row) - 2;
  const candidates: { col: number; row: number }[] = [];
  for (let d = 0; d < 6; d++) {
    const nb = offsetNeighbor(col, row, d);
    if (map.inBounds(nb.col, nb.row) && map.getElevation(nb.col, nb.row) <= threshold) {
      candidates.push(nb);
    }
  }
  return candidates[Math.floor(rand() * candidates.length)];
}

/**
 * Smooths terrain by grinding down cliffs.
 * A cell is "erodible" if any neighbour is ≥2 elevation steps below it.
 * Each erosion step lowers the cliff-top by 1 and raises the cliff-base by 1,
 * conserving total landmass.
 */
export function applyErosion(map: HexMap, opts: ErosionOptions, rand: () => number): void {
  const steps = applyErosionSteps(map, opts, rand);
  while (!steps.next().done) { /* drain */ }
}

/**
 * Step-generator form of {@link applyErosion}: yields the completed fraction
 * (0–1) every few hundred erosion steps so async drivers can suspend.
 * Deterministic — the `rand` call order is identical to the synchronous version.
 */
export function* applyErosionSteps(
  map: HexMap,
  opts: ErosionOptions,
  rand: () => number,
): Generator<number, void> {
  const pct = opts.erosionPercentage ?? 50;

  // -- O(1) erodible-cell bookkeeping --
  // Array for random-access selection; Map for O(1) index lookup during removal.
  const erodible: [number, number][] = [];
  const erodibleIdx = new Map<number, number>(); // cellKey → array index

  const addErodible = (col: number, row: number): void => {
    const key = row * map.width + col;
    if (erodibleIdx.has(key)) return;
    erodibleIdx.set(key, erodible.length);
    erodible.push([col, row]);
  };

  const removeErodibleAt = (i: number): void => {
    const [c, r] = erodible[i];
    erodibleIdx.delete(r * map.width + c);
    const last = erodible[erodible.length - 1];
    erodible[i] = last;
    erodible.pop();
    if (i < erodible.length) {
      erodibleIdx.set(last[1] * map.width + last[0], i);
    }
  };

  const removeErodibleByKey = (key: number): void => {
    const i = erodibleIdx.get(key);
    if (i !== undefined) removeErodibleAt(i);
  };

  // Build initial erodible set
  map.forEach((col, row) => { if (isErodible(col, row, map)) addErodible(col, row); });

  const targetCount = Math.floor(erodible.length * (1 - pct / 100));
  const totalSteps  = erodible.length - targetCount;
  let doneSteps = 0;

  while (erodible.length > targetCount) {
    // Yield every 512 steps — cheap enough to keep slices responsive without
    // paying generator overhead per step.
    // The erodible set can grow mid-pass, so completed/planned may exceed 1.
    if (doneSteps > 0 && (doneSteps & 511) === 0) yield Math.min(1, doneSteps / totalSteps);
    doneSteps++;
    const i = Math.floor(rand() * erodible.length);
    const [col, row] = erodible[i];
    const t = getErosionTarget(col, row, map, rand);

    // Move one elevation unit from cliff-top to cliff-base
    map.setElevation(col,  row,  map.getElevation(col,  row)  - 1);
    map.setElevation(t.col, t.row, map.getElevation(t.col, t.row) + 1);

    // Cliff-top may no longer be erodible
    if (!isErodible(col, row, map)) removeErodibleAt(i);

    // Cliff-top's neighbours may have become erodible (because col/row is now lower)
    for (let d = 0; d < 6; d++) {
      const nb = offsetNeighbor(col, row, d);
      if (map.inBounds(nb.col, nb.row) && isErodible(nb.col, nb.row, map)) {
        addErodible(nb.col, nb.row);
      }
    }

    // Target's neighbours may no longer be erodible (because target is now higher)
    for (let d = 0; d < 6; d++) {
      const nb = offsetNeighbor(t.col, t.row, d);
      if (!map.inBounds(nb.col, nb.row)) continue;
      if (nb.col === col && nb.row === row) continue; // already handled above
      const nbKey = nb.row * map.width + nb.col;
      if (erodibleIdx.has(nbKey) && !isErodible(nb.col, nb.row, map)) {
        removeErodibleByKey(nbKey);
      }
    }
  }
}
