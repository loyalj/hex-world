import type { HexMap } from '../map/HexMap.js';
import { makeRng } from '../math/Random.js';
import { hexRange, offsetToHex, hexToOffset, HEX_DIRECTIONS } from '../math/HexCoord.js';
import { DEFAULT_WATER_TERRAIN_INDEX } from '../geometry/TerrainTypes.js';
import type { ResourceDescriptor, PlacedResource } from './ResourceTypes.js';

export interface GenerateResourcesOptions {
  /**
   * Liquid predicate (e.g. `world.isWater`). Drives the `requiresLiquid` and
   * `requiresCoast` rules. Defaults to the built-in water terrain.
   */
  isWater?: (terrain: number) => boolean;
  /** Metadata channel key to write. Must match the `ResourceLayer`'s. Default `'resource'`. */
  dataKey?: string;
  /** Remove existing resources before generating. Default true. */
  clearExisting?: boolean;
  /**
   * Per-cell temperature field (0–1), as produced by `ClimateSimulator`.
   * Required for descriptors that set a temperature window.
   */
  temperature?: Float32Array;
  /** Per-cell moisture field (0–1). Required for descriptors that set a moisture window. */
  moisture?: Float32Array;
  /**
   * Starting quantity written with each deposit, for games that deplete them.
   * Omit to store bare type ids (permanent deposits).
   */
  amount?: number;
}

/** Deterministic per-descriptor seed, so adding a resource type doesn't reshuffle the others. */
function seedForId(seed: number, id: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Scatters resources across a map according to each descriptor's placement
 * rules — terrain, elevation, rivers, coastline, scatter density, and (when the
 * climate fields are supplied) temperature and moisture windows.
 *
 * Deterministic for a given seed: each resource type draws from its own
 * sub-stream, so adding or removing a type leaves the others' placements
 * unchanged. Types are considered in descriptor order and one cell holds at
 * most one resource, so earlier descriptors win contested cells — put the rare,
 * highly-constrained resources first.
 *
 * Writes through the map's metadata channel, which means the result serializes
 * with the map and needs no companion file. Call `ResourceLayer.refresh()` (or
 * let its `update()` pick it up) to draw the result.
 *
 * @returns Every deposit placed, in the order they were written.
 *
 * @example
 * const placed = generateResources(map, DEFAULT_RESOURCE_DESCRIPTORS, seed, {
 *   isWater: world.isWater,
 *   temperature, moisture,   // from ClimateSimulator, optional
 * });
 */
export function generateResources(
  map: HexMap,
  descriptors: ResourceDescriptor[],
  seed: number,
  opts: GenerateResourcesOptions = {},
): PlacedResource[] {
  const isWater = opts.isWater ?? ((t: number) => t === DEFAULT_WATER_TERRAIN_INDEX);
  const dataKey = opts.dataKey ?? 'resource';
  const { temperature, moisture, amount } = opts;

  if (opts.clearExisting !== false) {
    // Snapshot first — setCellData deletes records, mutating cellData mid-iteration.
    const existing: number[] = [];
    for (const [ci, record] of map.cellData) {
      if (record[dataKey] !== undefined) existing.push(ci);
    }
    for (const ci of existing) {
      map.setCellData(ci % map.width, (ci / map.width) | 0, dataKey, undefined);
    }
  }

  const placed: PlacedResource[] = [];
  /** Flat indices already holding a resource — one deposit per cell, any type. */
  const occupied = new Set<number>();
  for (const [ci, record] of map.cellData) {
    if (record[dataKey] !== undefined) occupied.add(ci);
  }

  for (const descriptor of descriptors) {
    const rule = descriptor.placement ?? {};
    const frequency  = rule.frequency  ?? 0.05;
    const minSpacing = rule.minSpacing ?? 0;
    if (frequency <= 0) continue;

    const rng = makeRng(seedForId(seed, descriptor.id));
    const allowed = rule.allowedTerrains ? new Set(rule.allowedTerrains) : null;
    /** Cells of THIS type, for the spacing check. */
    const ofType = new Set<number>();

    for (let row = 0; row < map.height; row++) {
      for (let col = 0; col < map.width; col++) {
        // Draw for every cell, eligible or not, so a cell's roll depends only on
        // its position — changing the terrain elsewhere can't shift this cell's luck.
        const roll = rng();
        const ci = row * map.width + col;
        if (occupied.has(ci)) continue;

        const terrain = map.getTerrain(col, row);
        const liquid  = isWater(terrain);

        if (rule.requiresLiquid && !liquid) continue;
        if (!rule.requiresLiquid && liquid) continue; // land resources never sit on water
        if (allowed && !allowed.has(terrain)) continue;

        const elevation = map.getElevation(col, row);
        if (rule.minElevation !== undefined && elevation < rule.minElevation) continue;
        if (rule.maxElevation !== undefined && elevation > rule.maxElevation) continue;

        if (rule.requiresRiver && !map.hasRiver(col, row)) continue;
        if (rule.requiresCoast && !touchesLiquid(map, col, row, isWater)) continue;

        if (rule.minFeatureLevel
          && map.getFeatureLevel(col, row, rule.minFeatureLevel.layer) < rule.minFeatureLevel.level) continue;

        if (temperature) {
          const t = temperature[ci];
          if (rule.minTemperature !== undefined && t < rule.minTemperature) continue;
          if (rule.maxTemperature !== undefined && t > rule.maxTemperature) continue;
        }
        if (moisture) {
          const m = moisture[ci];
          if (rule.minMoisture !== undefined && m < rule.minMoisture) continue;
          if (rule.maxMoisture !== undefined && m > rule.maxMoisture) continue;
        }

        if (roll >= frequency) continue;
        if (minSpacing > 0 && hasNeighborOfType(map, col, row, minSpacing, ofType)) continue;

        map.setCellData(col, row, dataKey,
          amount === undefined ? descriptor.id : { type: descriptor.id, amount });
        occupied.add(ci);
        ofType.add(ci);
        placed.push({
          col, row, type: descriptor.id,
          ...(amount !== undefined ? { amount } : {}),
        });
      }
    }
  }

  return placed;
}

/** True if any of the cell's six neighbours is liquid (i.e. the cell is coastal). */
function touchesLiquid(
  map: HexMap,
  col: number,
  row: number,
  isWater: (terrain: number) => boolean,
): boolean {
  const q = col - (row - (row & 1)) / 2;
  for (let d = 0; d < 6; d++) {
    const nq = q   + HEX_DIRECTIONS[d].q;
    const nr = row + HEX_DIRECTIONS[d].r;
    const nc = nq  + (nr - (nr & 1)) / 2;
    if (!map.inBounds(nc, nr)) continue;
    if (isWater(map.getTerrain(nc, nr))) return true;
  }
  return false;
}

/** True if another deposit of the same type sits within `spacing` hexes. */
function hasNeighborOfType(
  map: HexMap,
  col: number,
  row: number,
  spacing: number,
  ofType: Set<number>,
): boolean {
  if (ofType.size === 0) return false;
  for (const hex of hexRange(offsetToHex(col, row), spacing)) {
    const { col: nc, row: nr } = hexToOffset(hex);
    if (!map.inBounds(nc, nr)) continue;
    if (ofType.has(nr * map.width + nc)) return true;
  }
  return false;
}
