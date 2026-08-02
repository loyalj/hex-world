import { HEX_DIRECTIONS } from '../math/HexCoord.js';

/**
 * Shared flow→width mapping for river channels. Both geometry builders — the
 * terrain's carved stream bed (HexChunk) and the water channel (WaterChunk) —
 * derive widths from these helpers so the bed and the water widen in lockstep,
 * and both cells sharing an edge compute the identical width for it.
 */

/**
 * Channel half-width (fraction of the edge span) used when no flow map is
 * provided — the historical fixed value, kept for backward compatibility.
 */
export const RIVER_BASE_HALF_WIDTH = 0.25;

/** Half-width of a headwater stream (accumulated flow 1). Noticeably slimmer than the fixed-width era. */
export const RIVER_MIN_HALF_WIDTH = 0.16;

/** Half-width cap — a major river spans at most 0.64 of its hex edge. */
export const RIVER_MAX_HALF_WIDTH = 0.32;

/**
 * Growth exponent: halfWidth = MIN · flow^EXPONENT. At 0.22 the width doubles
 * over the flow range 1 → ~23, so hand-painted maps (chains of 5–30 cells)
 * spread across the full slim-to-wide range instead of saturating instantly.
 */
export const RIVER_WIDTH_EXPONENT = 0.22;

/** Accumulated flow (≥ 1, from `computeRiverFlow`) → channel half-width in edge-span units. */
export function riverHalfWidth(flow: number): number {
  const f = flow > 1 ? flow : 1;
  return Math.min(RIVER_MAX_HALF_WIDTH, RIVER_MIN_HALF_WIDTH * Math.pow(f, RIVER_WIDTH_EXPONENT));
}

/**
 * Width multiplier relative to the historic fixed half-width — used to scale
 * the channel's interior flank factors (which were tuned for the fixed 0.25).
 * Ranges ~0.64 (slim source) to ~1.28 (capped major river).
 */
export function riverWidthScale(flow: number): number {
  return riverHalfWidth(flow) / RIVER_BASE_HALF_WIDTH;
}

/** Minimal map surface needed by riverEdgeFlow — HexMap satisfies it. */
export interface RiverFlowSource {
  width: number;
  height: number;
  inBounds(col: number, row: number): boolean;
  getOutgoingRiverDir(col: number, row: number): number;
}

/**
 * The accumulated flow crossing a given edge of a cell: the flow of whichever
 * cell is upstream of that edge. Because both cells sharing the edge resolve
 * to the same upstream cell, they always agree — this is what keeps channel
 * width continuous across cell (and chunk) borders.
 *
 * Falls back to the cell's own flow for edges without a paired upstream
 * (sources, estuary mouths, dangling half-edges).
 */
export function riverEdgeFlow(
  map: RiverFlowSource,
  flow: Map<number, number>,
  col: number,
  row: number,
  edgeIndex: number,
  edgeDirs: readonly number[],
): number {
  const own = flow.get(row * map.width + col) ?? 1;
  if (map.getOutgoingRiverDir(col, row) === edgeIndex) return own;

  const d  = HEX_DIRECTIONS[edgeDirs[edgeIndex]];
  const q  = col - (row - (row & 1)) / 2;
  const nq = q + d.q;
  const nr = row + d.r;
  const nc = nq + (nr - (nr & 1)) / 2;
  if (map.inBounds(nc, nr) && map.getOutgoingRiverDir(nc, nr) === (edgeIndex + 3) % 6) {
    return flow.get(nr * map.width + nc) ?? own;
  }
  return own;
}
