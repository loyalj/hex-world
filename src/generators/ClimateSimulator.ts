import type { HexMap } from '../map/HexMap.js';
import { offsetNeighbor } from '../math/HexCoord.js';

export interface ClimateSimulatorOptions {
  /** Fraction of moisture evaporated per cycle. Default 0.5. */
  evaporationFactor?:   number;
  /** Fraction of clouds precipitated per cycle. Default 0.25. */
  precipitationFactor?: number;
  /** Fraction of moisture that drains downhill per cycle. Default 0.25. */
  runoffFactor?:        number;
  /** Fraction of moisture that spreads to equal-elevation neighbors. Default 0.125. */
  seepageFactor?:       number;
  /** Number of simulation cycles. Default 40. */
  cycles?:              number;
  /** HEX_DIRECTIONS index from which the dominant wind blows (0=E,1=NE,2=NW,3=W,4=SW,5=SE). Default 2 (NW). */
  windDirection?:       number;
  /** Relative strength of the dominant wind vs. uniform dispersal. Default 4. */
  windStrength?:        number;
  /** Initial moisture for all cells. Default 0.1. */
  startingMoisture?:    number;
  /** Maximum land elevation — used for rain shadow cloud cap. Default 12. */
  elevationMax?:        number;
}

/** Treats water cells as sea-level for runoff/seepage comparisons, preventing shoreline drain loops. */
function viewElevation(elev: number): number {
  return elev < 0 ? 0 : elev;
}

/**
 * Simulates a partial water cycle with parallel double-buffering, directional wind,
 * and elevation-based rain shadows. Returns per-cell moisture as a Float32Array
 * (index = row * map.width + col, values in [0, 1]).
 */
export function simulateClimate(map: HexMap, opts: ClimateSimulatorOptions = {}): Float32Array {
  const evaporation   = opts.evaporationFactor   ?? 0.5;
  const precipitation = opts.precipitationFactor ?? 0.25;
  const runoff        = opts.runoffFactor        ?? 0.25;
  const seepage       = opts.seepageFactor       ?? 0.125;
  const cycles        = opts.cycles              ?? 40;
  const windDir       = ((opts.windDirection     ?? 2) % 6 + 6) % 6;
  const windStrength  = opts.windStrength        ?? 4;
  const startMoisture = opts.startingMoisture    ?? 0.1;
  const elevMax       = opts.elevationMax        ?? 12;

  const size = map.width * map.height;

  // Double-buffered parallel evaluation: current arrays are read-only each cycle;
  // all writes accumulate in next arrays; then swap at end of cycle.
  let currentClouds   = new Float32Array(size);
  let currentMoisture = new Float32Array(size).fill(startMoisture);
  let nextClouds      = new Float32Array(size);
  let nextMoisture    = new Float32Array(size);

  // Clouds blow FROM windDir, dispersing TOWARDS the opposite face.
  const dispersalDir = (windDir + 3) % 6;

  for (let c = 0; c < cycles; c++) {
    map.forEach((col, row) => {
      const i     = row * map.width + col;
      const elev  = map.getElevation(col, row);
      const vElev = viewElevation(elev);

      let cClouds   = currentClouds[i];
      let cMoisture = currentMoisture[i];

      // 1. Evaporation
      if (elev < 0) {
        cMoisture = 1;
        cClouds  += evaporation;
      } else {
        const evap = cMoisture * evaporation;
        cMoisture -= evap;
        cClouds   += evap;
      }

      // 2. Precipitation
      const precip = cClouds * precipitation;
      cClouds   -= precip;
      cMoisture += precip;

      // 3. Cloud maximum — forces precipitation at high elevation (rain shadows)
      const cloudMax = 1 - vElev / (elevMax + 1);
      if (cClouds > cloudMax) {
        cMoisture += cClouds - cloudMax;
        cClouds    = cloudMax;
      }

      // 4. Cloud dispersal + runoff + seepage in a single neighbor pass
      const cloudShare  = cClouds * (1 / (5 + windStrength));
      const runoffShare = cMoisture * runoff  / 6;
      const seepShare   = cMoisture * seepage / 6;

      for (let d = 0; d < 6; d++) {
        const nb = offsetNeighbor(col, row, d);
        if (!map.inBounds(nb.col, nb.row)) continue;

        const ni = nb.row * map.width + nb.col;

        // Dominant wind direction gets windStrength× share; all others get 1×
        nextClouds[ni] += d === dispersalDir ? cloudShare * windStrength : cloudShare;

        const nbVElev = viewElevation(map.getElevation(nb.col, nb.row));
        const delta   = nbVElev - vElev;
        if (delta < 0) {
          cMoisture        -= runoffShare;
          nextMoisture[ni] += runoffShare;
        } else if (delta === 0) {
          cMoisture        -= seepShare;
          nextMoisture[ni] += seepShare;
        }
      }

      // 5. Carry remaining moisture forward; clamp to 1
      nextMoisture[i] = Math.min(1, nextMoisture[i] + cMoisture);
      // current cell's clouds are zeroed implicitly by the cycle-end swap + fill
    });

    // Swap buffers; zero the now-stale "next" arrays for the following cycle
    const tmpC = currentClouds;   currentClouds   = nextClouds;   nextClouds   = tmpC;
    const tmpM = currentMoisture; currentMoisture = nextMoisture; nextMoisture = tmpM;
    nextClouds.fill(0);
    nextMoisture.fill(0);
  }

  return currentMoisture;
}
