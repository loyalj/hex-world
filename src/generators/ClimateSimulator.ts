import type { HexMap } from '../map/HexMap.js';
import { offsetNeighbor } from '../math/HexCoord.js';

export interface ClimateSimulatorOptions {
  /** How much moisture evaporates into clouds per cycle. Default 0.5. */
  evaporationFactor?:   number;
  /** Fraction of clouds that precipitate as moisture per cycle. Default 0.25. */
  precipitationFactor?: number;
  /** Fraction of moisture drained downhill per cycle (split across lower neighbors). Default 0.25. */
  runoffFactor?:        number;
  /** Fraction of moisture spread to equal-elevation neighbors per cycle. Default 0.125. */
  seepageFactor?:       number;
  /** Number of simulation cycles. Default 40. */
  cycles?:              number;
}

/** Treats water cells as sea-level for runoff/seepage comparisons, preventing shoreline drain loops. */
function viewElevation(elev: number): number {
  return elev < 0 ? 0 : elev;
}

/**
 * Runs a partial water-cycle simulation and returns per-cell moisture as a Float32Array
 * (index = row * map.width + col, values in [0, 1]).
 *
 * Intended to run after elevation is set, before terrain/biome assignment.
 */
export function simulateClimate(map: HexMap, opts: ClimateSimulatorOptions = {}): Float32Array {
  const evaporation   = opts.evaporationFactor   ?? 0.5;
  const precipitation = opts.precipitationFactor ?? 0.25;
  const runoff        = opts.runoffFactor        ?? 0.25;
  const seepage       = opts.seepageFactor       ?? 0.125;
  const cycles        = opts.cycles              ?? 40;

  const size     = map.width * map.height;
  const clouds   = new Float32Array(size);
  const moisture = new Float32Array(size);
  const cloudBuf = new Float32Array(size);

  for (let c = 0; c < cycles; c++) {

    // 1. Evaporation: water cells saturate moisture and emit clouds at full rate;
    //    land cells convert a fraction of their moisture to clouds.
    map.forEach((col, row) => {
      const i = row * map.width + col;
      if (map.getElevation(col, row) < 0) {
        moisture[i] = 1;
        clouds[i] += evaporation;
      } else {
        clouds[i] += moisture[i] * evaporation;
      }
    });

    // 2. Precipitation: clouds fall as moisture.
    map.forEach((col, row) => {
      const i    = row * map.width + col;
      const drop = clouds[i] * precipitation;
      clouds[i]   -= drop;
      moisture[i] += drop;
    });

    // 3. Cloud dispersal: each cell spreads 1/6 of its clouds to each in-bounds
    //    neighbor; clouds that would cross map edges are lost.
    cloudBuf.fill(0);
    map.forEach((col, row) => {
      const share = clouds[row * map.width + col] / 6;
      for (let d = 0; d < 6; d++) {
        const nb = offsetNeighbor(col, row, d);
        if (map.inBounds(nb.col, nb.row)) {
          cloudBuf[nb.row * map.width + nb.col] += share;
        }
      }
    });
    clouds.set(cloudBuf);

    // 4. Runoff: drain moisture downhill (view elevation keeps water cells at 0
    //    so coastal land doesn't endlessly drain into deep ocean).
    map.forEach((col, row) => {
      const i     = row * map.width + col;
      const vElev = viewElevation(map.getElevation(col, row));
      const share = moisture[i] * runoff / 6;
      for (let d = 0; d < 6; d++) {
        const nb = offsetNeighbor(col, row, d);
        if (!map.inBounds(nb.col, nb.row)) continue;
        if (viewElevation(map.getElevation(nb.col, nb.row)) < vElev) {
          moisture[nb.row * map.width + nb.col] += share;
          moisture[i] -= share;
        }
      }
    });

    // 5. Seepage: equalize moisture between neighbors at the same view elevation.
    map.forEach((col, row) => {
      const i     = row * map.width + col;
      const vElev = viewElevation(map.getElevation(col, row));
      const share = moisture[i] * seepage / 6;
      for (let d = 0; d < 6; d++) {
        const nb = offsetNeighbor(col, row, d);
        if (!map.inBounds(nb.col, nb.row)) continue;
        if (viewElevation(map.getElevation(nb.col, nb.row)) === vElev) {
          moisture[nb.row * map.width + nb.col] += share;
          moisture[i] -= share;
        }
      }
    });
  }

  return moisture;
}
