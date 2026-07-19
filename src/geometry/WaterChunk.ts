import * as THREE from 'three';
import type { HexLayout } from '../math/HexLayout.js';
import { hexToWorld, hexCorners } from '../math/HexLayout.js';
import { HEX_DIRECTIONS } from '../math/HexCoord.js';
import type { HexMap } from '../map/HexMap.js';
import { RIVER_SURFACE_ELEVATION_OFFSET } from '../map/HexCell.js';
import { DEFAULT_WATER_TERRAIN_INDEX } from './TerrainTypes.js';
import { sampleNoise } from '../math/Noise.js';
import type { ChunkBounds } from './HexChunk.js';

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
  const elevScale     = opts.elevationScale  ?? 0.5;
  const surfaceLift   = opts.surfaceLift     ?? 0.02;
  const waterTerrains = opts.waterTerrains ?? new Set([DEFAULT_WATER_TERRAIN_INDEX]);
  const isWater = (t: number) => waterTerrains.has(t);

  const { colStart, colEnd, rowStart, rowEnd } = bounds;
  const hexCount = (colEnd - colStart) * (rowEnd - rowStart);
  const maxVerts = hexCount * 18;

  const positions   = new Float32Array(maxVerts * 3);
  const uvs         = new Float32Array(maxVerts * 2);
  const depths      = new Float32Array(maxVerts);
  const cellIndices = new Float32Array(maxVerts);
  let vi = 0, uvi = 0, di = 0, cii = 0;

  const perturb = (x: number, z: number): [number, number] => {
    const n = sampleNoise(x * noiseScale, z * noiseScale);
    return [(n[0] * 2 - 1) * perturbStr, (n[2] * 2 - 1) * perturbStr];
  };

  const addVertW = (x: number, z: number, y: number, depth: number, ci: number) => {
    const [dx, dz] = perturb(x, z);
    positions[vi++] = x + dx;
    positions[vi++] = y;
    positions[vi++] = z + dz;
    uvs[uvi++] = x * UV_WATER_SCALE;
    uvs[uvi++] = z * UV_WATER_SCALE;
    depths[di++] = depth;
    cellIndices[cii++] = ci;
  };

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
      const depth       = Math.min(1.0, Math.max(0.0, (surfaceElev - elev) / 9.0));

      for (let i = 0; i < 6; i++) {
        const i1 = (i + 1) % 6;
        addVertW(c.x,        c.z,        surfaceY, depth, ci);
        addVertW(crns[i1].x, crns[i1].z, surfaceY, depth, ci);
        addVertW(crns[i].x,  crns[i].z,  surfaceY, depth, ci);
      }
    }
  }

  if (vi === 0) return null;

  const n   = vi / 3;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',  new THREE.BufferAttribute(positions.subarray(0, n * 3), 3));
  geo.setAttribute('uv',        new THREE.BufferAttribute(uvs.subarray(0, n * 2), 2));
  geo.setAttribute('depth',     new THREE.BufferAttribute(depths.subarray(0, n), 1));
  geo.setAttribute('cellIndex', new THREE.BufferAttribute(cellIndices.subarray(0, n), 1));
  return geo;
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
  const elevScale      = opts.elevationScale             ?? 0.5;
  const surfaceLift    = opts.surfaceLift                ?? 0.02;
  const elevPerturbStr = opts.terrainElevPerturbStrength ?? 0.2;
  const edgeDirs       = layout.orientation.edgeDirections;
  const waterTerrains    = opts.waterTerrains    ?? new Set([DEFAULT_WATER_TERRAIN_INDEX]);
  const allLiquidTerrains = opts.allLiquidTerrains;
  const isWaterTerrain   = (t: number) => waterTerrains.has(t);

  // Follow outgoing river chain to determine which liquid type it drains into.
  // edgeDirs maps edge index (0-5) → HEX_DIRECTIONS index for the neighbor across that edge.
  // Returns true if it drains into THIS liquid type (waterTerrains),
  // false if it drains into a different liquid type, null if undetermined (render for all).
  // Per-chunk cache so cells that share a downstream chain reuse the first result.
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

  const landCellY = (c: number, r: number): number => {
    const qq = c - (r - (r & 1)) / 2;
    const wc = hexToWorld(layout, { q: qq, r });
    const n  = sampleNoise(wc.x * noiseScale, wc.z * noiseScale);
    return map.getElevation(c, r) * elevScale + (n[1] * 2 - 1) * elevPerturbStr;
  };

  const { colStart, colEnd, rowStart, rowEnd } = bounds;
  const hexCount = (colEnd - colStart) * (rowEnd - rowStart);
  const maxVerts = hexCount * 72;

  const positions   = new Float32Array(maxVerts * 3);
  const uvs         = new Float32Array(maxVerts * 2);
  const cellIndices = new Float32Array(maxVerts);
  let vi = 0, uvi = 0, cii = 0;
  let curCi = 0;

  const perturb = (x: number, z: number): [number, number] => {
    const n = sampleNoise(x * noiseScale, z * noiseScale);
    return [(n[0] * 2 - 1) * perturbStr, (n[2] * 2 - 1) * perturbStr];
  };

  const addVert = (x: number, y: number, z: number, u: number, v: number) => {
    const [dx, dz] = perturb(x, z);
    positions[vi++] = x + dx;
    positions[vi++] = y;
    positions[vi++] = z + dz;
    uvs[uvi++] = u;
    uvs[uvi++] = v;
    cellIndices[cii++] = curCi;
  };

  const addTri = (
    x0: number, y0: number, z0: number, u0: number, v0: number,
    x1: number, y1: number, z1: number, u1: number, v1: number,
    x2: number, y2: number, z2: number, u2: number, v2: number,
  ) => {
    addVert(x0, y0, z0, u0, v0);
    addVert(x1, y1, z1, u1, v1);
    addVert(x2, y2, z2, u2, v2);
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

      const terrain     = map.getTerrain(col, row);
      const cellIsLiquid = allLiquidTerrains ? allLiquidTerrains.has(terrain) : isWaterTerrain(terrain);
      const hasRiver    = map.hasRiver(col, row);
      if (!hasRiver || cellIsLiquid) continue;

      const drains = drainsIntoThisLiquid(col, row);
      if (drains === false) continue; // belongs to a different liquid type
      // Unclassified rivers are owned by exactly one liquid (see
      // ownsUnclassifiedRivers) so they aren't drawn once per liquid type.
      if (drains === null && allLiquidTerrains && !opts.ownsUnclassifiedRivers) continue;

      curCi = row * map.width + col;

      const q      = col - (row - (row & 1)) / 2;
      const center = hexToWorld(layout, { q, r: row });
      const crns   = hexCorners(layout, { q, r: row });
      const ownElev = map.getElevation(col, row);
      const ry      = (ownElev + RIVER_SURFACE_ELEVATION_OFFSET) * elevScale;
      const isBeginEnd = map.hasRiverBeginOrEnd(col, row);
      const outDir     = map.getOutgoingRiverDir(col, row);

      const ox = crns.map(c => c.x - center.x);
      const oz = crns.map(c => c.z - center.z);

      for (let i = 0; i < 6; i++) {
        if (!map.hasRiverThroughEdge(col, row, i)) continue;
        const i1         = (i + 1) % 6;
        const isOutgoing = (i === outDir);

        const eLx = crns[i].x * 0.75 + crns[i1].x * 0.25;
        const eLz = crns[i].z * 0.75 + crns[i1].z * 0.25;
        const eRx = crns[i].x * 0.25 + crns[i1].x * 0.75;
        const eRz = crns[i].z * 0.25 + crns[i1].z * 0.75;

        let   nbRy            = ry;
        let   nbIsWater       = false;
        let   nbWaterSurfaceY = 0;
        const d  = edgeDirs[i];
        const nb = neighborOffset(col, row, d);
        if (map.inBounds(nb.col, nb.row)) {
          const nbTerrain = map.getTerrain(nb.col, nb.row);
          const nbElev    = map.getElevation(nb.col, nb.row);
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

        if (isBeginEnd) {
          if (isOutgoing) {
            if (nbIsWater && ry > nbWaterSurfaceY) {
              const [dcx, dcz] = perturb(center.x, center.z);
              const [dLx, dLz] = perturb(eLx, eLz);
              const [dRx, dRz] = perturb(eRx, eRz);
              const pcx = center.x + dcx, pcz = center.z + dcz;
              positions[vi++] = pcx;       positions[vi++] = ry;           positions[vi++] = pcz;       uvs[uvi++] = 0.5; uvs[uvi++] = 0.0; cellIndices[cii++] = curCi;
              positions[vi++] = eLx + dLx; positions[vi++] = estuaryEdgeY; positions[vi++] = eLz + dLz; uvs[uvi++] = 0.0; uvs[uvi++] = 1.0; cellIndices[cii++] = curCi;
              positions[vi++] = eRx + dRx; positions[vi++] = estuaryEdgeY; positions[vi++] = eRz + dRz; uvs[uvi++] = 1.0; uvs[uvi++] = 1.0; cellIndices[cii++] = curCi;
            } else {
              const mLx = (center.x + eLx) * 0.5, mLz = (center.z + eLz) * 0.5;
              const mRx = (center.x + eRx) * 0.5, mRz = (center.z + eRz) * 0.5;
              addTri(center.x, ry, center.z, 0.5, 0.0,  mLx, ry, mLz, 0.0, 0.4,  mRx, ry, mRz, 1.0, 0.4);
              addQuad(mLx, ry, mLz, 0.0, 0.4,  mRx, ry, mRz, 1.0, 0.4,  eLx, estuaryEdgeY, eLz, 0.0, 0.8,  eRx, estuaryEdgeY, eRz, 1.0, 0.8);
            }
          } else {
            const mLx = (center.x + eLx) * 0.5, mLz = (center.z + eLz) * 0.5;
            const mRx = (center.x + eRx) * 0.5, mRz = (center.z + eRz) * 0.5;
            addQuad(eLx, ry, eLz, 1.0, 0.0,  eRx, ry, eRz, 0.0, 0.0,  mLx, ry, mLz, 1.0, 0.4,  mRx, ry, mRz, 0.0, 0.4);
            addTri(center.x, ry, center.z, 0.5, 0.8,  mLx, ry, mLz, 1.0, 0.4,  mRx, ry, mRz, 0.0, 0.4);
          }
        } else {
          const ip  = (i + 5) % 6;
          const in2 = (i + 2) % 6;
          let cLx: number, cLz: number, cRx: number, cRz: number;

          if (map.hasRiverThroughEdge(col, row, (i + 3) % 6)) {
            cLx = center.x + ox[ip]  * SOLID_FACTOR * 0.25;
            cLz = center.z + oz[ip]  * SOLID_FACTOR * 0.25;
            cRx = center.x + ox[in2] * SOLID_FACTOR * 0.25;
            cRz = center.z + oz[in2] * SOLID_FACTOR * 0.25;
          } else if (map.hasRiverThroughEdge(col, row, i1)) {
            cLx = center.x; cLz = center.z;
            cRx = center.x + ox[i1] * SOLID_FACTOR * (2 / 3);
            cRz = center.z + oz[i1] * SOLID_FACTOR * (2 / 3);
          } else if (map.hasRiverThroughEdge(col, row, ip)) {
            cLx = center.x + ox[i] * SOLID_FACTOR * (2 / 3);
            cLz = center.z + oz[i] * SOLID_FACTOR * (2 / 3);
            cRx = center.x; cRz = center.z;
          } else if (map.hasRiverThroughEdge(col, row, in2)) {
            cLx = center.x; cLz = center.z;
            cRx = center.x + (ox[i1] + ox[in2]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER;
            cRz = center.z + (oz[i1] + oz[in2]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER;
          } else {
            cLx = center.x + (ox[ip] + ox[i]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER;
            cLz = center.z + (oz[ip] + oz[i]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER;
            cRx = center.x; cRz = center.z;
          }

          const ccx = (cLx + cRx) * 0.5, ccz = (cLz + cRz) * 0.5;

          if (isOutgoing) {
            addTri(cLx, ry, cLz, 0.0, 0.8,  ccx, ry, ccz, 0.5, 0.8,  cRx, ry, cRz, 1.0, 0.8);
            if (nbIsWater) {
              addQuad(cLx, ry, cLz, 0.0, 0.8,  cRx, ry, cRz, 1.0, 0.8,  eLx, estuaryEdgeY, eLz, 0.0, 1.0,  eRx, estuaryEdgeY, eRz, 1.0, 1.0);
            } else {
              addQuad(cLx, ry, cLz, 0.0, 0.8,  cRx, ry, cRz, 1.0, 0.8,  eLx, nbRy, eLz, 0.0, 1.0,  eRx, nbRy, eRz, 1.0, 1.0);
            }
          } else {
            addTri(cLx, ry, cLz, 1.0, 0.8,  ccx, ry, ccz, 0.5, 0.8,  cRx, ry, cRz, 0.0, 0.8);
            addQuad(eLx, ry, eLz, 1.0, 0.0,  eRx, ry, eRz, 0.0, 0.0,  cLx, ry, cLz, 1.0, 0.8,  cRx, ry, cRz, 0.0, 0.8);
          }
        }
      }
    }
  }

  if (vi === 0) return null;

  const n   = vi / 3;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',  new THREE.BufferAttribute(positions.subarray(0, n * 3), 3));
  geo.setAttribute('uv',        new THREE.BufferAttribute(uvs.subarray(0, n * 2), 2));
  geo.setAttribute('cellIndex', new THREE.BufferAttribute(cellIndices.subarray(0, n), 1));
  return geo;
}
