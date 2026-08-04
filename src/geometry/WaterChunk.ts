import * as THREE from 'three';
import type { HexLayout } from '../math/HexLayout.js';
import { hexToWorld, hexCorners } from '../math/HexLayout.js';
import { HEX_DIRECTIONS } from '../math/HexCoord.js';
import type { HexMap } from '../map/HexMap.js';
import { RIVER_SURFACE_ELEVATION_OFFSET, ELEVATION_SCALE } from '../map/HexCell.js';
import { DEFAULT_WATER_TERRAIN_INDEX } from './TerrainTypes.js';
import { sampleNoise } from '../math/Noise.js';
import type { ChunkBounds } from './HexChunk.js';
import { RIVER_BASE_HALF_WIDTH, riverWidthScale, riverEdgeFlow } from './RiverWidth.js';

export interface WaterGeometryOptions {
  noiseScale?: number;
  perturbStrength?: number;
  elevationScale?: number;
  /**
   * Constant world-space Y added to every water surface position after the
   * elevation scale is applied. Prevents z-fighting between the water mesh and
   * coplanar terrain (e.g. a cell at elevation 0 connected to the ocean).
   * Default 0.02.
   */
  surfaceLift?: number;
  /** Set of terrain indices that count as water. Defaults to {5} (built-in Water). */
  waterTerrains?: Set<number>;
  /**
   * Set of ALL liquid terrain indices across every liquid type.
   * When provided, river geometry is only built for river cells that drain into
   * a terrain in `waterTerrains`. Cells draining into a different liquid type
   * (in allLiquidTerrains but not waterTerrains) are skipped so each liquid type
   * only owns the rivers that flow into it.
   */
  allLiquidTerrains?: Set<number>;
  /**
   * Terrain-mesh noise parameters, matching the ChunkGeometryOptions used to build
   * the terrain. Land-side shore/estuary vertices and river channels are perturbed
   * with these — not the liquid's own noiseScale/perturbStrength — so they stay
   * glued to the terrain even when a liquid overrides its surface noise settings.
   * ChunkManager injects these automatically from its geometryOptions.
   */
  terrainNoiseScale?: number;
  terrainPerturbStrength?: number;
  terrainElevPerturbStrength?: number;
  /**
   * When true, this liquid also renders river chains whose drainage target could
   * not be classified (the river dries out on land, leaves the map, or exceeds
   * the trace limit). ChunkManager sets this on exactly one liquid — the
   * highest-priority one with a river material — so unclassified rivers are
   * drawn once instead of once per liquid type. Ignored when allLiquidTerrains
   * is unset (single-liquid backward-compat mode renders everything).
   */
  ownsUnclassifiedRivers?: boolean;
  /**
   * Terrain index → liquid priority (the lowest terrain index of the liquid that
   * index belongs to). Used at liquid-liquid boundaries so liquids spanning
   * multiple terrain indices compare at the liquid level. Falls back to the raw
   * terrain index when absent.
   */
  liquidPriorityByTerrain?: Map<number, number>;
  /**
   * Cells (row * width + col) whose river channels this liquid should render —
   * the pre-computed ownership set from ChunkManager's map-wide river
   * classification cache. When provided, buildRiverGeometry skips its own
   * per-chunk drainage tracing entirely.
   */
  riverCells?: Set<number>;
  /**
   * Shore distance (in cells) at which the surface reaches full deep color.
   * Depth blends the larger of bathymetric depth and shore-distance depth, so
   * both carved basins and wide bodies read as deep. Default 6.
   */
  depthShoreFalloff?: number;
  /**
   * Elevation difference at which a river edge renders as a waterfall (level
   * lip + steep drop) instead of one smooth slope. Should match the terrain's
   * ChunkGeometryOptions.cliffThreshold; ChunkManager injects it. Default 2.
   */
  cliffThreshold?: number;
  /**
   * Accumulated river flow per cell (cellKey → flow, from `computeRiverFlow`).
   * When provided, river channels widen with flow (see RiverWidth.ts). Must be
   * the SAME map passed to `buildChunkGeometry` so the carved stream bed
   * widens in lockstep. ChunkManager injects its cached flow automatically.
   */
  riverFlow?: Map<number, number>;
  /**
   * Carved river elevation per cell (cellKey → elevation, from
   * `computeRiverElevations`): the running minimum along flow. When provided,
   * the river surface holds the carried level through uphill stretches
   * (whose terrain carves a gorge) instead of climbing them. Must be the
   * SAME map passed to `buildChunkGeometry`. ChunkManager injects it
   * automatically.
   */
  riverElevations?: Map<number, number>;
}

const SOLID_FACTOR   = 0.8;
const INNER_TO_OUTER = 1 / 0.866025404;
const UV_WATER_SCALE = 0.0625;

function neighborOffset(col: number, row: number, d: number): { col: number; row: number } {
  const q  = col - (row - (row & 1)) / 2;
  const nq = q  + HEX_DIRECTIONS[d].q;
  const nr = row + HEX_DIRECTIONS[d].r;
  return { col: nq + (nr - (nr & 1)) / 2, row: nr };
}

// ---------------------------------------------------------------------------
// Standing water
// ---------------------------------------------------------------------------
export function buildWaterGeometry(
  map: HexMap,
  layout: HexLayout,
  bounds: ChunkBounds,
  opts: WaterGeometryOptions = {},
): THREE.BufferGeometry | null {
  const noiseScale    = opts.noiseScale      ?? 0.35;
  const perturbStr    = opts.perturbStrength ?? 0.8;
  const elevScale     = opts.elevationScale  ?? ELEVATION_SCALE;
  const surfaceLift   = opts.surfaceLift     ?? 0.02;
  const depthFalloff  = opts.depthShoreFalloff ?? 6;
  const waterTerrains = opts.waterTerrains ?? new Set([DEFAULT_WATER_TERRAIN_INDEX]);
  const isWater = (t: number) => waterTerrains.has(t);

  const { colStart, colEnd, rowStart, rowEnd } = bounds;
  const hexCount = (colEnd - colStart) * (rowEnd - rowStart);
  // Indexed: 7 unique vertices per hex (center + 6 corners), 6 triangles.
  const maxVerts   = hexCount * 7;
  const maxIndices = hexCount * 18;

  const positions   = new Float32Array(maxVerts * 3);
  const uvs         = new Float32Array(maxVerts * 2);
  const depths      = new Float32Array(maxVerts);
  const cellIndices = new Float32Array(maxVerts);
  const indices     = maxVerts > 65535 ? new Uint32Array(maxIndices) : new Uint16Array(maxIndices);
  let vi = 0, uvi = 0, di = 0, cii = 0, ii = 0;
  let vertCount = 0;

  const perturb = (x: number, z: number): [number, number] => {
    const n = sampleNoise(x * noiseScale, z * noiseScale);
    return [(n[0] * 2 - 1) * perturbStr, (n[2] * 2 - 1) * perturbStr];
  };

  const addVertW = (x: number, z: number, y: number, depth: number, ci: number): number => {
    const [dx, dz] = perturb(x, z);
    positions[vi++] = x + dx;
    positions[vi++] = y;
    positions[vi++] = z + dz;
    uvs[uvi++] = x * UV_WATER_SCALE;
    uvs[uvi++] = z * UV_WATER_SCALE;
    depths[di++] = depth;
    cellIndices[cii++] = ci;
    return vertCount++;
  };

  const cornerVerts = new Array<number>(6);

  for (let row = rowStart; row < rowEnd; row++) {
    for (let col = colStart; col < colEnd; col++) {
      if (!map.inBounds(col, row)) continue;
      if (!isWater(map.getTerrain(col, row))) continue;

      const q    = col - (row - (row & 1)) / 2;
      const c    = hexToWorld(layout, { q, r: row });
      const crns = hexCorners(layout, { q, r: row });
      const ci   = row * map.width + col;

      const elev        = map.getElevation(col, row);
      const surfaceElev = map.getWaterSurface(col, row);
      const surfaceY    = surfaceElev * elevScale + surfaceLift;
      // Depth drives the shallow→deep color mix. Generators usually place
      // floors at exactly surface−1, which alone gives a flat ~0.11 — blend in
      // distance-to-shore so wide bodies actually read as deep.
      const depthBathy  = (surfaceElev - elev) / 9.0;
      const depthShore  = Math.min(1.0, map.getShoreDistance(col, row) / depthFalloff);
      const depth       = Math.min(1.0, Math.max(0.0, Math.max(depthBathy, depthShore)));

      const center = addVertW(c.x, c.z, surfaceY, depth, ci);
      for (let i = 0; i < 6; i++) {
        cornerVerts[i] = addVertW(crns[i].x, crns[i].z, surfaceY, depth, ci);
      }
      for (let i = 0; i < 6; i++) {
        const i1 = (i + 1) % 6;
        indices[ii++] = center;
        indices[ii++] = cornerVerts[i1];
        indices[ii++] = cornerVerts[i];
      }
    }
  }

  if (vertCount === 0) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',  new THREE.BufferAttribute(positions.slice(0, vertCount * 3), 3));
  geo.setAttribute('uv',        new THREE.BufferAttribute(uvs.slice(0, vertCount * 2), 2));
  geo.setAttribute('depth',     new THREE.BufferAttribute(depths.slice(0, vertCount), 1));
  geo.setAttribute('cellIndex', new THREE.BufferAttribute(cellIndices.slice(0, vertCount), 1));
  geo.setIndex(new THREE.BufferAttribute(indices.slice(0, ii), 1));
  return geo;
}

// ---------------------------------------------------------------------------
// River channel ownership
// ---------------------------------------------------------------------------

/**
 * Builds the predicate deciding whether a given cell's river channel is drawn
 * by THIS liquid: it must carry a river, must not itself be a liquid cell, and
 * its chain must drain into this liquid (unclassified chains go to whichever
 * liquid owns them — see `ownsUnclassifiedRivers`).
 *
 * `buildRiverGeometry` and `findWaterfalls` share it so a waterfall's spray and
 * plunge pool are emitted by exactly the liquid that renders the channel
 * feeding it — never twice, never by the wrong liquid.
 *
 * When `opts.riverCells` is supplied (ChunkManager's map-wide ownership cache)
 * this is a set lookup; otherwise it falls back to tracing the outgoing chain,
 * memoised across the whole call so a shared downstream reach is walked once.
 */
export function createRiverCellFilter(
  map: HexMap,
  layout: HexLayout,
  opts: WaterGeometryOptions = {},
): (col: number, row: number) => boolean {
  const edgeDirs          = layout.orientation.edgeDirections;
  const waterTerrains     = opts.waterTerrains ?? new Set([DEFAULT_WATER_TERRAIN_INDEX]);
  const allLiquidTerrains = opts.allLiquidTerrains;

  // Follow outgoing river chain to determine which liquid type it drains into.
  // edgeDirs maps edge index (0-5) → HEX_DIRECTIONS index for the neighbor across that edge.
  // Returns true if it drains into THIS liquid type (waterTerrains),
  // false if it drains into a different liquid type, null if undetermined (render for all).
  // Cached so cells that share a downstream chain reuse the first result.
  // Also prevents inconsistency when two separate traces happen to join the same channel.
  const ownershipCache = new Map<number, boolean | null>();

  const drainsIntoThisLiquid = (startCol: number, startRow: number): boolean | null => {
    if (!allLiquidTerrains) return null; // no filtering — backward compat

    const startKey = startRow * map.width + startCol;
    if (ownershipCache.has(startKey)) return ownershipCache.get(startKey)!;

    // Accumulate the path so we can back-fill the cache once the result is known.
    const path: number[] = [startKey];
    const visitedLocal = new Set<number>([startKey]);
    let c = startCol, r = startRow;

    const resolve = (result: boolean | null): boolean | null => {
      for (const k of path) ownershipCache.set(k, result);
      return result;
    };

    for (let step = 0; step < 200; step++) {
      const outEdge = map.getOutgoingRiverDir(c, r);
      if (outEdge === -1) break; // no outgoing — unclassified
      const nb = neighborOffset(c, r, edgeDirs[outEdge]); // edgeDirs maps edge→HEX_DIRECTIONS index
      if (!map.inBounds(nb.col, nb.row)) break;

      const nbKey = nb.row * map.width + nb.col;
      if (ownershipCache.has(nbKey)) return resolve(ownershipCache.get(nbKey)!); // hit cache mid-chain
      if (visitedLocal.has(nbKey))   break; // cycle — shouldn't happen but defensive

      const nbTerrain = map.getTerrain(nb.col, nb.row);
      if (waterTerrains.has(nbTerrain))     return resolve(true);  // flows into this liquid type
      if (allLiquidTerrains.has(nbTerrain)) return resolve(false); // flows into a different liquid type

      visitedLocal.add(nbKey);
      path.push(nbKey);
      c = nb.col;
      r = nb.row;
    }
    return resolve(null); // unclassified — rendered only by the owning default liquid
  };

  return (col: number, row: number): boolean => {
    const terrain      = map.getTerrain(col, row);
    const cellIsLiquid = allLiquidTerrains ? allLiquidTerrains.has(terrain) : waterTerrains.has(terrain);
    if (cellIsLiquid || !map.hasRiver(col, row)) return false;

    if (opts.riverCells) {
      // Fast path: membership in the pre-computed map-wide ownership set.
      return opts.riverCells.has(row * map.width + col);
    }
    const drains = drainsIntoThisLiquid(col, row);
    if (drains === false) return false; // belongs to a different liquid type
    // Unclassified rivers are owned by exactly one liquid (see
    // ownsUnclassifiedRivers) so they aren't drawn once per liquid type.
    if (drains === null && allLiquidTerrains && !opts.ownsUnclassifiedRivers) return false;
    return true;
  };
}

// ---------------------------------------------------------------------------
// River water
// ---------------------------------------------------------------------------
export function buildRiverGeometry(
  map: HexMap,
  layout: HexLayout,
  bounds: ChunkBounds,
  opts: WaterGeometryOptions = {},
): THREE.BufferGeometry | null {
  // River channels overlay land terrain, so ALL their perturbation must match the
  // terrain mesh (which uses ChunkGeometryOptions), not the liquid's surface noise —
  // otherwise a per-liquid noiseScale override would wiggle the channel out of the
  // stream bed carved by HexChunk.
  const noiseScale     = opts.terrainNoiseScale          ?? 0.35;
  const perturbStr     = opts.terrainPerturbStrength     ?? 0.8;
  const elevScale      = opts.elevationScale             ?? ELEVATION_SCALE;
  const surfaceLift    = opts.surfaceLift                ?? 0.02;
  const elevPerturbStr = opts.terrainElevPerturbStrength ?? 0.2;
  const cliffThreshold = opts.cliffThreshold             ?? 2;
  const riverElevs     = opts.riverElevations;
  const edgeDirs       = layout.orientation.edgeDirections;
  const waterTerrains  = opts.waterTerrains ?? new Set([DEFAULT_WATER_TERRAIN_INDEX]);
  const isWaterTerrain = (t: number) => waterTerrains.has(t);
  const rendersChannel = createRiverCellFilter(map, layout, opts);

  const landCellY = (c: number, r: number): number => {
    const qq = c - (r - (r & 1)) / 2;
    const wc = hexToWorld(layout, { q: qq, r });
    const n  = sampleNoise(wc.x * noiseScale, wc.z * noiseScale);
    return map.getElevation(c, r) * elevScale + (n[1] * 2 - 1) * elevPerturbStr;
  };

  const { colStart, colEnd, rowStart, rowEnd } = bounds;
  const hexCount = (colEnd - colStart) * (rowEnd - rowStart);
  // Indexed: the old per-hex vertex budget (per-edge segments + waterfall quads
  // + junction cap) now bounds the index count; welding shrinks the attributes.
  const maxVerts   = hexCount * 96;
  const maxIndices = hexCount * 96;

  const positions   = new Float32Array(maxVerts * 3);
  const uvs         = new Float32Array(maxVerts * 2);
  const cellIndices = new Float32Array(maxVerts);
  const indices     = maxVerts > 65535 ? new Uint32Array(maxIndices) : new Uint16Array(maxIndices);
  let vi = 0, uvi = 0, cii = 0, ii = 0;
  let vertCount = 0;
  let curCi = 0;

  // Per-cell vertex weld: identical (position, uv) tuples within one cell
  // collapse to a single indexed vertex (channel corners shared between the
  // mouth triangle and the channel quad, junction-cap seams). Never welded
  // across cells — cellIndex differs there. Points reused with DIFFERENT uv
  // (e.g. cR in the junction mouth fan vs bank fan) stay separate vertices.
  const vertIds = new Map<string, number>();
  const vertKey = (x: number, y: number, z: number, u: number, v: number) =>
    `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)},${u},${v}`;

  const perturb = (x: number, z: number): [number, number] => {
    const n = sampleNoise(x * noiseScale, z * noiseScale);
    return [(n[0] * 2 - 1) * perturbStr, (n[2] * 2 - 1) * perturbStr];
  };

  /** Returns the vertex id, reusing an identical vertex emitted earlier in the same cell. */
  const addVert = (x: number, y: number, z: number, u: number, v: number): number => {
    const key = vertKey(x, y, z, u, v);
    const existing = vertIds.get(key);
    if (existing !== undefined) return existing;
    const [dx, dz] = perturb(x, z);
    positions[vi++] = x + dx;
    positions[vi++] = y;
    positions[vi++] = z + dz;
    uvs[uvi++] = u;
    uvs[uvi++] = v;
    cellIndices[cii++] = curCi;
    vertIds.set(key, vertCount);
    return vertCount++;
  };

  const addTri = (
    x0: number, y0: number, z0: number, u0: number, v0: number,
    x1: number, y1: number, z1: number, u1: number, v1: number,
    x2: number, y2: number, z2: number, u2: number, v2: number,
  ) => {
    indices[ii++] = addVert(x0, y0, z0, u0, v0);
    indices[ii++] = addVert(x1, y1, z1, u1, v1);
    indices[ii++] = addVert(x2, y2, z2, u2, v2);
  };

  const addQuad = (
    x0: number, y0: number, z0: number, u0: number, v0: number,
    x1: number, y1: number, z1: number, u1: number, v1: number,
    x2: number, y2: number, z2: number, u2: number, v2: number,
    x3: number, y3: number, z3: number, u3: number, v3: number,
  ) => {
    addTri(x0, y0, z0, u0, v0,  x1, y1, z1, u1, v1,  x3, y3, z3, u3, v3);
    addTri(x0, y0, z0, u0, v0,  x3, y3, z3, u3, v3,  x2, y2, z2, u2, v2);
  };

  for (let row = rowStart; row < rowEnd; row++) {
    for (let col = colStart; col < colEnd; col++) {
      if (!map.inBounds(col, row)) continue;
      if (!rendersChannel(col, row)) continue;

      const cellKey = row * map.width + col;
      curCi = cellKey;
      vertIds.clear(); // weld within this cell only

      const q      = col - (row - (row & 1)) / 2;
      const center = hexToWorld(layout, { q, r: row });
      const crns   = hexCorners(layout, { q, r: row });
      const ownElev = riverElevs?.get(cellKey) ?? map.getElevation(col, row);
      const ry      = (ownElev + RIVER_SURFACE_ELEVATION_OFFSET) * elevScale;
      const isBeginEnd = map.hasRiverBeginOrEnd(col, row);
      const outDir     = map.getOutgoingRiverDir(col, row);

      // Flow-dependent widening — same formulas as the stream bed carve in
      // buildChunkGeometry so the water tiles the widened groove exactly.
      const riverFlow = opts.riverFlow;
      const cellW = riverFlow ? riverWidthScale(riverFlow.get(cellKey) ?? 1) : 1;

      // Junction cells (3+ channels) use symmetric channel mouths matching the
      // terrain basin in HexChunk, so the water tiles the carved bed.
      let riverEdgeCount = 0;
      for (let f = 0; f < 6; f++) if (map.hasRiverThroughEdge(col, row, f)) riverEdgeCount++;
      const isJunctionCell = riverEdgeCount >= 3 && !isBeginEnd;

      const ox = crns.map(c => c.x - center.x);
      const oz = crns.map(c => c.z - center.z);

      // Inner channel-corner points per rendered edge, in edge order — used to
      // cap the cell center when 3+ channels meet (a confluence junction).
      const ringPts: Array<{ cLx: number; cLz: number; cRx: number; cRz: number }> = [];

      for (let i = 0; i < 6; i++) {
        if (!map.hasRiverThroughEdge(col, row, i)) continue;
        const i1         = (i + 1) % 6;
        const isOutgoing = (i === outDir);

        const hw = riverFlow
          ? RIVER_BASE_HALF_WIDTH * riverWidthScale(riverEdgeFlow(map, riverFlow, col, row, i, edgeDirs))
          : RIVER_BASE_HALF_WIDTH;
        const eLx = crns[i].x + (crns[i1].x - crns[i].x) * (0.5 - hw);
        const eLz = crns[i].z + (crns[i1].z - crns[i].z) * (0.5 - hw);
        const eRx = crns[i].x + (crns[i1].x - crns[i].x) * (0.5 + hw);
        const eRz = crns[i].z + (crns[i1].z - crns[i].z) * (0.5 + hw);

        let   nbRy            = ry;
        let   nbIsWater       = false;
        let   nbWaterSurfaceY = 0;
        const d  = edgeDirs[i];
        const nb = neighborOffset(col, row, d);
        if (map.inBounds(nb.col, nb.row)) {
          const nbTerrain = map.getTerrain(nb.col, nb.row);
          const nbElev    = riverElevs?.get(nb.row * map.width + nb.col) ?? map.getElevation(nb.col, nb.row);
          nbIsWater = isWaterTerrain(nbTerrain);
          if (nbIsWater) {
            nbWaterSurfaceY = map.getWaterSurface(nb.col, nb.row) * elevScale + surfaceLift;
            nbRy = nbWaterSurfaceY;
          } else {
            nbRy = (nbElev + RIVER_SURFACE_ELEVATION_OFFSET) * elevScale;
          }
        }
        const estuaryEdgeY = nbIsWater
          ? nbWaterSurfaceY + (landCellY(col, row) - nbWaterSurfaceY) * 0.5
          : nbRy;

        // Cliff-lip points radially aligned with eL/eR on the solid-hex
        // boundary, plus the bridge-strip translation to the neighbor's solid
        // boundary — together the span a waterfall sheet covers. Must stay in
        // sync with the wall notch in HexChunkCore (SOLID_FACTOR, blend vector).
        const wLx = center.x + (eLx - center.x) * SOLID_FACTOR, wLz = center.z + (eLz - center.z) * SOLID_FACTOR;
        const wRx = center.x + (eRx - center.x) * SOLID_FACTOR, wRz = center.z + (eRz - center.z) * SOLID_FACTOR;
        const bwx = (ox[i] + ox[i1]) * (1 - SOLID_FACTOR);
        const bwz = (oz[i] + oz[i1]) * (1 - SOLID_FACTOR);
        // Upstream neighbor a cliff above: its waterfall sheet covers the
        // bridge strip down to OUR solid boundary, so the incoming channel
        // starts there — the shared edge lies buried inside the cliff face.
        const fromCliff = !nbIsWater && !isOutgoing && nbRy - ry >= cliffThreshold * elevScale * 0.999;
        const sLx = fromCliff ? wLx : eLx, sLz = fromCliff ? wLz : eLz;
        const sRx = fromCliff ? wRx : eRx, sRz = fromCliff ? wRz : eRz;

        if (isBeginEnd) {
          if (isOutgoing) {
            if (nbIsWater && ry > nbWaterSurfaceY) {
              addTri(
                center.x, ry,           center.z, 0.5, 0.0,
                eLx,      estuaryEdgeY, eLz,      0.0, 1.0,
                eRx,      estuaryEdgeY, eRz,      1.0, 1.0,
              );
            } else {
              const mLx = (center.x + eLx) * 0.5, mLz = (center.z + eLz) * 0.5;
              const mRx = (center.x + eRx) * 0.5, mRz = (center.z + eRz) * 0.5;
              addTri(center.x, ry, center.z, 0.5, 0.0,  mLx, ry, mLz, 0.0, 0.4,  mRx, ry, mRz, 1.0, 0.4);
              if (!nbIsWater && ry - nbRy >= cliffThreshold * elevScale * 0.999) {
                // Spring right at a cliff lip — same sheet as the main
                // waterfall branch below.
                addQuad(mLx, ry, mLz, 0.0, 0.4,  mRx, ry, mRz, 1.0, 0.4,  wLx, ry, wLz, 0.0, 0.8,  wRx, ry, wRz, 1.0, 0.8);
                addQuad(wLx, ry, wLz, 0.0, 0.8,  wRx, ry, wRz, 1.0, 0.8,  wLx + bwx, nbRy, wLz + bwz, 0.0, 1.0,  wRx + bwx, nbRy, wRz + bwz, 1.0, 1.0);
              } else {
                addQuad(mLx, ry, mLz, 0.0, 0.4,  mRx, ry, mRz, 1.0, 0.4,  eLx, estuaryEdgeY, eLz, 0.0, 0.8,  eRx, estuaryEdgeY, eRz, 1.0, 0.8);
              }
            }
          } else {
            const mLx = (center.x + eLx) * 0.5, mLz = (center.z + eLz) * 0.5;
            const mRx = (center.x + eRx) * 0.5, mRz = (center.z + eRz) * 0.5;
            addQuad(sLx, ry, sLz, 1.0, 0.0,  sRx, ry, sRz, 0.0, 0.0,  mLx, ry, mLz, 1.0, 0.4,  mRx, ry, mRz, 0.0, 0.4);
            addTri(center.x, ry, center.z, 0.5, 0.8,  mLx, ry, mLz, 1.0, 0.4,  mRx, ry, mRz, 0.0, 0.4);
          }
        } else {
          const ip  = (i + 5) % 6;
          const in2 = (i + 2) % 6;
          let cLx: number, cLz: number, cRx: number, cRz: number;

          if (isJunctionCell) {
            cLx = center.x + ox[i]  * SOLID_FACTOR * 0.4 * cellW;
            cLz = center.z + oz[i]  * SOLID_FACTOR * 0.4 * cellW;
            cRx = center.x + ox[i1] * SOLID_FACTOR * 0.4 * cellW;
            cRz = center.z + oz[i1] * SOLID_FACTOR * 0.4 * cellW;
          } else if (map.hasRiverThroughEdge(col, row, (i + 3) % 6)) {
            cLx = center.x + ox[ip]  * SOLID_FACTOR * 0.25 * cellW;
            cLz = center.z + oz[ip]  * SOLID_FACTOR * 0.25 * cellW;
            cRx = center.x + ox[in2] * SOLID_FACTOR * 0.25 * cellW;
            cRz = center.z + oz[in2] * SOLID_FACTOR * 0.25 * cellW;
          } else if (map.hasRiverThroughEdge(col, row, i1)) {
            const f = Math.min(0.85, (2 / 3) * cellW);
            cLx = center.x; cLz = center.z;
            cRx = center.x + ox[i1] * SOLID_FACTOR * f;
            cRz = center.z + oz[i1] * SOLID_FACTOR * f;
          } else if (map.hasRiverThroughEdge(col, row, ip)) {
            const f = Math.min(0.85, (2 / 3) * cellW);
            cLx = center.x + ox[i] * SOLID_FACTOR * f;
            cLz = center.z + oz[i] * SOLID_FACTOR * f;
            cRx = center.x; cRz = center.z;
          } else if (map.hasRiverThroughEdge(col, row, in2)) {
            cLx = center.x; cLz = center.z;
            cRx = center.x + (ox[i1] + ox[in2]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER * cellW;
            cRz = center.z + (oz[i1] + oz[in2]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER * cellW;
          } else {
            cLx = center.x + (ox[ip] + ox[i]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER * cellW;
            cLz = center.z + (oz[ip] + oz[i]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER * cellW;
            cRx = center.x; cRz = center.z;
          }

          const ccx = (cLx + cRx) * 0.5, ccz = (cLz + cRz) * 0.5;
          ringPts.push({ cLx, cLz, cRx, cRz });

          if (isOutgoing) {
            addTri(cLx, ry, cLz, 0.0, 0.8,  ccx, ry, ccz, 0.5, 0.8,  cRx, ry, cRz, 1.0, 0.8);
            if (nbIsWater) {
              addQuad(cLx, ry, cLz, 0.0, 0.8,  cRx, ry, cRz, 1.0, 0.8,  eLx, estuaryEdgeY, eLz, 0.0, 1.0,  eRx, estuaryEdgeY, eRz, 1.0, 1.0);
            } else if (ry - nbRy >= cliffThreshold * elevScale * 0.999) {
              // Waterfall: hold the channel level out to the cliff lip at the
              // solid-hex boundary, then slide the sheet down the bridge
              // strip's carved groove (the visible cliff face) to the
              // neighbor's solid boundary, where its channel takes over. The
              // compressed V range makes the flow read faster over the fall.
              addQuad(cLx, ry, cLz, 0.0, 0.8,  cRx, ry, cRz, 1.0, 0.8,  wLx, ry, wLz, 0.0, 0.86,  wRx, ry, wRz, 1.0, 0.86);
              addQuad(wLx, ry, wLz, 0.0, 0.86,  wRx, ry, wRz, 1.0, 0.86,  wLx + bwx, nbRy, wLz + bwz, 0.0, 1.0,  wRx + bwx, nbRy, wRz + bwz, 1.0, 1.0);
            } else {
              addQuad(cLx, ry, cLz, 0.0, 0.8,  cRx, ry, cRz, 1.0, 0.8,  eLx, nbRy, eLz, 0.0, 1.0,  eRx, nbRy, eRz, 1.0, 1.0);
            }
          } else {
            addTri(cLx, ry, cLz, 1.0, 0.8,  ccx, ry, ccz, 0.5, 0.8,  cRx, ry, cRz, 0.0, 0.8);
            addQuad(sLx, ry, sLz, 1.0, 0.0,  sRx, ry, sRz, 0.0, 0.0,  cLx, ry, cLz, 1.0, 0.8,  cRx, ry, cRz, 0.0, 0.8);
          }
        }
      }

      // Confluence junction cap: with 3+ channels meeting in one cell, the
      // per-edge segments no longer share their inner corner points, leaving
      // holes at the cell center. Two fans are needed: the mouth sectors
      // (center → each segment's cL–cR chord — the per-edge "mouth triangle"
      // is degenerate by construction, so the channel quads stop AT the
      // chord), and the bank sectors between consecutive segments (a.cR →
      // next segment's cL, going around in edge order).
      if (ringPts.length >= 3) {
        for (let k = 0; k < ringPts.length; k++) {
          const a = ringPts[k];
          const b = ringPts[(k + 1) % ringPts.length];
          addTri(
            center.x, ry, center.z, 0.5, 0.8,
            a.cLx,    ry, a.cLz,    0.3, 0.8,
            a.cRx,    ry, a.cRz,    0.7, 0.8,
          );
          addTri(
            center.x, ry, center.z, 0.5, 0.8,
            a.cRx,    ry, a.cRz,    0.5, 0.8,
            b.cLx,    ry, b.cLz,    0.5, 0.8,
          );
        }
      }
    }
  }

  if (vertCount === 0) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',  new THREE.BufferAttribute(positions.slice(0, vertCount * 3), 3));
  geo.setAttribute('uv',        new THREE.BufferAttribute(uvs.slice(0, vertCount * 2), 2));
  geo.setAttribute('cellIndex', new THREE.BufferAttribute(cellIndices.slice(0, vertCount), 1));
  geo.setIndex(new THREE.BufferAttribute(indices.slice(0, ii), 1));
  return geo;
}

// ---------------------------------------------------------------------------
// Map-wide river ownership
// ---------------------------------------------------------------------------

/**
 * Classifies every river cell on the map by the liquid its chain drains into.
 * Returns cellKey (row * width + col) → liquid ID, or null when the chain
 * never reaches a liquid (dries out, leaves the map, or loops).
 *
 * ChunkManager caches this once map-wide (invalidated by markDirty) and hands
 * per-liquid membership sets to buildRiverGeometry via
 * `WaterGeometryOptions.riverCells`, replacing the per-chunk-per-liquid
 * drainage tracing fallback.
 *
 * @param edgeDirs Edge-index → HEX_DIRECTIONS mapping (layout.orientation.edgeDirections).
 * @param liquidIdByTerrain Terrain index → liquid ID for every liquid terrain.
 */
export function computeRiverOwnership(
  map: HexMap,
  edgeDirs: readonly number[],
  liquidIdByTerrain: ReadonlyMap<number, string>,
): Map<number, string | null> {
  const ownership = new Map<number, string | null>();
  const w = map.width;

  map.forEach((col, row) => {
    const startKey = row * w + col;
    if (ownership.has(startKey)) return;
    if (!map.hasRiver(col, row)) return;
    if (liquidIdByTerrain.has(map.getTerrain(col, row))) return; // liquid cells render no channel

    // Follow the outgoing chain until it reaches a liquid, a cached cell, or ends.
    const path: number[] = [startKey];
    const seen = new Set<number>([startKey]);
    let c = col, r = row;
    let result: string | null = null;

    for (let step = 0; step < 4096; step++) {
      const outEdge = map.getOutgoingRiverDir(c, r);
      if (outEdge === -1) break;
      const nb = neighborOffset(c, r, edgeDirs[outEdge]);
      if (!map.inBounds(nb.col, nb.row)) break;
      const nbKey = nb.row * w + nb.col;
      if (ownership.has(nbKey)) { result = ownership.get(nbKey)!; break; }
      if (seen.has(nbKey)) break; // defensive: cycle
      const owner = liquidIdByTerrain.get(map.getTerrain(nb.col, nb.row));
      if (owner !== undefined) { result = owner; break; }
      seen.add(nbKey);
      path.push(nbKey);
      c = nb.col;
      r = nb.row;
    }

    for (const k of path) ownership.set(k, result);
  });

  return ownership;
}

/**
 * Accumulates flow volume down every river network: each cell's flow is 1 plus
 * the flow of every upstream cell draining into it, so confluences sum their
 * tributaries. Returns cellKey (row * width + col) → flow (≥ 1).
 *
 * Derived data — nothing is stored on the map. Used for gameplay (bridge
 * costs, fishing yields, …) and as the input for flow-dependent channel width
 * rendering: ChunkManager caches this map-wide and injects it into both
 * geometry builders as `riverFlow` (see RiverWidth.ts).
 *
 * @param edgeDirs Edge-index → HEX_DIRECTIONS mapping (layout.orientation.edgeDirections).
 */
export function computeRiverFlow(
  map: HexMap,
  edgeDirs: readonly number[],
): Map<number, number> {
  const flow = new Map<number, number>();
  const w = map.width;

  /** Upstream cellKeys: incoming edges whose neighbor's outgoing points back at us. */
  const upstreamOf = (col: number, row: number): number[] => {
    const ups: number[] = [];
    const mask = map.getIncomingRiverMask(col, row);
    if (mask === 0) return ups;
    for (let e = 0; e < 6; e++) {
      if (!(mask & (1 << e))) continue;
      const nb = neighborOffset(col, row, edgeDirs[e]);
      if (!map.inBounds(nb.col, nb.row)) continue;
      if (map.getOutgoingRiverDir(nb.col, nb.row) === (e + 3) % 6) {
        ups.push(nb.row * w + nb.col);
      }
    }
    return ups;
  };

  const onStack = new Set<number>();
  const compute = (startKey: number): void => {
    const stack = [startKey];
    onStack.add(startKey);
    while (stack.length > 0) {
      const key = stack[stack.length - 1];
      if (flow.has(key)) { stack.pop(); onStack.delete(key); continue; }
      const col = key % w;
      const row = (key / w) | 0;
      let total = 1;
      let pending = false;
      for (const u of upstreamOf(col, row)) {
        const f = flow.get(u);
        if (f !== undefined) { total += f; continue; }
        if (onStack.has(u)) continue; // defensive: data cycle — ignore that branch
        stack.push(u);
        onStack.add(u);
        pending = true;
      }
      if (!pending) {
        flow.set(key, total);
        stack.pop();
        onStack.delete(key);
      }
    }
  };

  map.forEach((col, row) => {
    if (!map.hasRiver(col, row)) return;
    const key = row * w + col;
    if (!flow.has(key)) compute(key);
  });

  return flow;
}

/**
 * Carved river elevation per cell: the running minimum of cell elevations
 * along the flow direction. Equals the cell's own elevation everywhere a
 * river descends normally; where map data routes a river uphill, the carried
 * upstream minimum wins — the water surface holds level and the terrain
 * builder carves a gorge through the rising cells instead of the water
 * climbing them (which rendered as a floating slide). Confluences take the
 * minimum across all inflows, so a tributary arriving higher gets a genuine
 * fall into the junction.
 *
 * Purely a derived render-time quantity — map data is untouched. ChunkManager
 * caches this map-wide and passes it to both the terrain and river builders
 * via `riverElevations`.
 */
export function computeRiverElevations(
  map: HexMap,
  edgeDirs: readonly number[],
): Map<number, number> {
  const eff = new Map<number, number>();
  const w = map.width;

  /** Upstream cellKeys: incoming edges whose neighbor's outgoing points back at us. */
  const upstreamOf = (col: number, row: number): number[] => {
    const ups: number[] = [];
    const mask = map.getIncomingRiverMask(col, row);
    if (mask === 0) return ups;
    for (let e = 0; e < 6; e++) {
      if (!(mask & (1 << e))) continue;
      const nb = neighborOffset(col, row, edgeDirs[e]);
      if (!map.inBounds(nb.col, nb.row)) continue;
      if (map.getOutgoingRiverDir(nb.col, nb.row) === (e + 3) % 6) {
        ups.push(nb.row * w + nb.col);
      }
    }
    return ups;
  };

  const onStack = new Set<number>();
  const compute = (startKey: number): void => {
    const stack = [startKey];
    onStack.add(startKey);
    while (stack.length > 0) {
      const key = stack[stack.length - 1];
      if (eff.has(key)) { stack.pop(); onStack.delete(key); continue; }
      const col = key % w;
      const row = (key / w) | 0;
      let level = map.getElevation(col, row);
      let pending = false;
      for (const u of upstreamOf(col, row)) {
        const e = eff.get(u);
        if (e !== undefined) { level = Math.min(level, e); continue; }
        if (onStack.has(u)) continue; // defensive: data cycle — ignore that branch
        stack.push(u);
        onStack.add(u);
        pending = true;
      }
      if (!pending) {
        eff.set(key, level);
        stack.pop();
        onStack.delete(key);
      }
    }
  };

  map.forEach((col, row) => {
    if (!map.hasRiver(col, row)) return;
    const key = row * w + col;
    if (!eff.has(key)) compute(key);
  });

  return eff;
}
