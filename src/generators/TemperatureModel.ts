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
  /** Maximum land elevation — used for elevation cooling. Default 12. */
  elevationMax?:      number;
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
  const elevMax    = opts.elevationMax      ?? 12;

  const result = new Float32Array(map.width * map.height);

  map.forEach((col, row) => {
    // Latitude: 0 = pole (cold), 1 = equator (hot)
    let latitude: number;
    if (hemisphere === 'both') {
      latitude = 1 - Math.abs(row / map.height - 0.5) * 2;
    } else if (hemisphere === 'north') {
      latitude = row / map.height;          // 0 at top (pole), 1 at bottom (equator)
    } else {
      latitude = 1 - row / map.height;      // 1 at top (equator), 0 at bottom (pole)
    }

    let temp = lowTemp + (highTemp - lowTemp) * latitude;

    // Elevation cooling: high land cells are colder
    const elev = map.getElevation(col, row);
    if (elev > 0) {
      temp *= 1 - elev / (elevMax + 1);
    }

    // Symmetric noise jitter
    const noise = sampleNoise(col * 0.1, row * 0.1);
    temp += (noise[0] - 0.5) * jitter;

    result[row * map.width + col] = Math.max(0, Math.min(1, temp));
  });

  return result;
}
