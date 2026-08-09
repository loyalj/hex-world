import type { HexMap } from '../map/HexMap.js';
import { sampleNoise } from '../math/Noise.js';

export interface TemperatureModelOptions {
  /** Temperature at the poles (latitude = 0). Default 0. */
  lowTemperature?:    number;
  /** Temperature at the equator (latitude = 1). Default 1. */
  highTemperature?:   number;
  /** 'both' places the equator at the map centre; 'north'/'south' put it at the bottom/top edge. Default 'both'. */
  hemisphere?:        'both' | 'north' | 'south';
  /** Amount of per-cell noise added to temperature. Default 0.1. */
  temperatureJitter?: number;
  /** Which noise channel (0–3) to use for jitter — vary per map for uniqueness. Default 0. */
  jitterChannel?:     number;
  /** Maximum land elevation — used for elevation cooling. Default 12. */
  elevationMax?:      number;
}

/**
 * Normalized latitude of a map row: 0 at the pole (cold), 1 at the equator
 * (hot). Exported because anything that reasons about latitude — the seasonal
 * swing in `SeasonCycle`, for one — has to agree with the temperature field
 * cell for cell, and the only way to guarantee that is to share the formula.
 *
 * @param hemisphere 'both' puts the equator at the map centre; 'north'/'south'
 *   put it at the bottom/top edge.
 */
export function latitudeAt(row: number, height: number, hemisphere: 'both' | 'north' | 'south' = 'both'): number {
  let latitude = row / height;
  if (hemisphere === 'both') {
    latitude *= 2;
    if (latitude > 1) latitude = 2 - latitude;
  } else if (hemisphere === 'north') {
    latitude = 1 - latitude;
  }
  // 'south' uses latitude as-is (0 at top = pole, 1 at bottom = equator)
  return latitude;
}

/**
 * Computes per-cell temperature (0–1) from latitude, elevation, and noise.
 * Hot at the equator, cold at the poles and at high elevation.
 * Returns a Float32Array indexed by row * map.width + col.
 */
export function computeTemperature(map: HexMap, opts: TemperatureModelOptions = {}): Float32Array {
  const lowTemp    = opts.lowTemperature    ?? 0;
  const highTemp   = opts.highTemperature   ?? 1;
  const hemisphere = opts.hemisphere        ?? 'both';
  const jitter     = opts.temperatureJitter ?? 0.1;
  const channel    = Math.floor(opts.jitterChannel ?? 0) & 3; // clamp to 0–3
  const elevMax    = opts.elevationMax      ?? 12;

  const result = new Float32Array(map.width * map.height);

  map.forEach((col, row) => {
    // Latitude using the tutorial's formula: 0 = pole (cold), 1 = equator (hot)
    const latitude = latitudeAt(row, map.height, hemisphere);

    let temp = lowTemp + (highTemp - lowTemp) * latitude;

    // Elevation cooling using view elevation (max(elev, 0) = 0 for water)
    const elev = map.getElevation(col, row);
    const viewElev = elev < 0 ? 0 : elev;
    temp *= 1 - viewElev / (elevMax + 1);

    // Noise jitter: random channel chosen once per map generation
    const noise = sampleNoise(col * 0.1, row * 0.1);
    temp += (noise[channel] * 2 - 1) * jitter;

    result[row * map.width + col] = Math.max(0, Math.min(1, temp));
  });

  return result;
}
