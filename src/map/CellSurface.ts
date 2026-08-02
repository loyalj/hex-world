import type { HexLayout } from '../math/HexLayout.js';
import { hexToWorld } from '../math/HexLayout.js';
import { offsetToHex } from '../math/HexCoord.js';
import { sampleNoise } from '../math/Noise.js';
import { ELEVATION_SCALE } from './HexCell.js';

/** Minimal map surface needed by cellSurfaceY — HexMap satisfies it. */
export interface CellSurfaceSource {
  getElevation(col: number, row: number): number;
  getTerrain(col: number, row: number): number;
  getWaterSurface(col: number, row: number): number;
}

export interface CellSurfaceOptions {
  /** World units per elevation step. Must match the terrain geometry's `elevationScale`. Default ELEVATION_SCALE. */
  elevationScale?: number;
  /** Must match `ChunkGeometryOptions.elevPerturbStrength`. Default 0.2. */
  elevPerturbStrength?: number;
  /** Must match `ChunkGeometryOptions.noiseScale`. Default 0.35. */
  noiseScale?: number;
  /**
   * Liquid predicate. When provided and the cell's terrain is liquid, the
   * computed water surface Y is returned instead of the terrain floor —
   * useful for boats or floating props. Omit to always use the terrain floor.
   */
  isWater?: (terrain: number) => boolean;
  /** Y lift applied to water surfaces (matches `WaterGeometryOptions.surfaceLift`). Default 0.02. */
  surfaceLift?: number;
}

/**
 * World-space Y of the rendered surface at a cell center — the same formula
 * `buildChunkGeometry` uses for terrain vertices (elevation plus
 * center-sampled noise perturbation), or the computed water surface for
 * liquid cells when `isWater` is provided.
 *
 * Use this to place units, props, or cameras exactly on the visible ground
 * instead of the un-perturbed `getElevation() * scale` plane.
 */
export function cellSurfaceY(
  map: CellSurfaceSource,
  layout: HexLayout,
  col: number,
  row: number,
  opts: CellSurfaceOptions = {},
): number {
  const elevScale = opts.elevationScale ?? ELEVATION_SCALE;

  if (opts.isWater?.(map.getTerrain(col, row))) {
    return map.getWaterSurface(col, row) * elevScale + (opts.surfaceLift ?? 0.02);
  }

  const noiseScale = opts.noiseScale ?? 0.35;
  const perturb    = opts.elevPerturbStrength ?? 0.2;
  const wc = hexToWorld(layout, offsetToHex(col, row));
  const n  = sampleNoise(wc.x * noiseScale, wc.z * noiseScale);
  return map.getElevation(col, row) * elevScale + (n[1] * 2 - 1) * perturb;
}
