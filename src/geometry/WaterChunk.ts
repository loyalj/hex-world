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
  const noiseScale     = opts.noiseScale      ?? 0.35;
  const perturbStr     = opts.perturbStrength ?? 0.8;
  const elevScale      = opts.elevationScale  ?? 0.5;
  const surfaceLift    = opts.surfaceLift     ?? 0.02;
  const elevPerturbStr = 0.2;
  const edgeDirs       = layout.orientation.edgeDirections;
  const waterTerrains  = opts.waterTerrains ?? new Set([DEFAULT_WATER_TERRAIN_INDEX]);
  const isWaterTerrain = (t: number) => waterTerrains.has(t);

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

      const cellIsWater = isWaterTerrain(map.getTerrain(col, row));
      const hasRiver    = map.hasRiver(col, row);
      if (!hasRiver || cellIsWater) continue;

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
