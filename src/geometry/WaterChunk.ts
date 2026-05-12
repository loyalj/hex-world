import * as THREE from 'three';
import type { HexLayout } from '../math/HexLayout.js';
import { hexToWorld, hexCorners } from '../math/HexLayout.js';
import { HEX_DIRECTIONS } from '../math/HexCoord.js';
import type { HexMap } from '../map/HexMap.js';
import { TerrainType, RIVER_SURFACE_ELEVATION_OFFSET } from '../map/HexCell.js';
import { sampleNoise } from '../math/Noise.js';
import type { ChunkBounds } from './HexChunk.js';

export interface WaterGeometryOptions {
  /** Y position of the standing-water surface. Default 0. */
  waterLevel?: number;
  /** Noise sampling scale — must match terrain noiseScale. Default 0.35. */
  noiseScale?: number;
  /** XZ vertex jitter strength — must match terrain perturbStrength. Default 0.8. */
  perturbStrength?: number;
  /** World units per elevation step — must match terrain elevationScale. Default 0.5. */
  elevationScale?: number;
}

const SOLID_FACTOR   = 0.8;
const INNER_TO_OUTER = 1 / 0.866025404;
/** World-space UV scale for standing water. */
const UV_WATER_SCALE = 0.0625;

function neighborOffset(col: number, row: number, d: number): { col: number; row: number } {
  const q  = col - (row - (row & 1)) / 2;
  const nq = q  + HEX_DIRECTIONS[d].q;
  const nr = row + HEX_DIRECTIONS[d].r;
  return { col: nq + (nr - (nr & 1)) / 2, row: nr };
}

// ---------------------------------------------------------------------------
// Standing water — flat hex fans at waterLevel, world-space UV.
// Uses the WaterMaterial (blend-wave, world-position based).
// ---------------------------------------------------------------------------
export function buildWaterGeometry(
  map: HexMap,
  layout: HexLayout,
  bounds: ChunkBounds,
  opts: WaterGeometryOptions = {},
): THREE.BufferGeometry | null {
  const waterLevel = opts.waterLevel      ?? 0;
  const noiseScale = opts.noiseScale      ?? 0.35;
  const perturbStr = opts.perturbStrength ?? 0.8;

  const { colStart, colEnd, rowStart, rowEnd } = bounds;
  const hexCount = (colEnd - colStart) * (rowEnd - rowStart);
  const maxVerts = hexCount * 18; // 6 tris × 3 verts per hex

  const positions = new Float32Array(maxVerts * 3);
  const uvs       = new Float32Array(maxVerts * 2);
  let vi = 0, uvi = 0;

  const perturb = (x: number, z: number): [number, number] => {
    const n = sampleNoise(x * noiseScale, z * noiseScale);
    return [(n[0] * 2 - 1) * perturbStr, (n[2] * 2 - 1) * perturbStr];
  };

  const addVertW = (x: number, z: number) => {
    const [dx, dz] = perturb(x, z);
    positions[vi++] = x + dx;
    positions[vi++] = waterLevel;
    positions[vi++] = z + dz;
    uvs[uvi++] = x * UV_WATER_SCALE;
    uvs[uvi++] = z * UV_WATER_SCALE;
  };

  const addTriW = (
    x0: number, z0: number,
    x1: number, z1: number,
    x2: number, z2: number,
  ) => { addVertW(x0, z0); addVertW(x1, z1); addVertW(x2, z2); };

  for (let row = rowStart; row < rowEnd; row++) {
    for (let col = colStart; col < colEnd; col++) {
      if (!map.inBounds(col, row)) continue;
      if (map.getTerrain(col, row) !== TerrainType.Water) continue;

      const q    = col - (row - (row & 1)) / 2;
      const c    = hexToWorld(layout, { q, r: row });
      const crns = hexCorners(layout, { q, r: row });

      // Full hex fan — all 6 wedges. Shore renders on top (higher polygonOffset)
      // for land-facing edges, so no special skipping needed here.
      for (let i = 0; i < 6; i++) {
        const i1 = (i + 1) % 6;
        addTriW(c.x, c.z, crns[i1].x, crns[i1].z, crns[i].x, crns[i].z);
      }
    }
  }

  if (vi === 0) return null;

  const n   = vi / 3;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, n * 3), 3));
  geo.setAttribute('uv',       new THREE.BufferAttribute(uvs.subarray(0, n * 2), 2));
  return geo;
}

// ---------------------------------------------------------------------------
// River water — flow-space UV geometry.
// Uses the RiverMaterial (directional flow based on UV).
// ---------------------------------------------------------------------------
export function buildRiverGeometry(
  map: HexMap,
  layout: HexLayout,
  bounds: ChunkBounds,
  opts: WaterGeometryOptions = {},
): THREE.BufferGeometry | null {
  const waterLevel = opts.waterLevel      ?? 0;
  const noiseScale = opts.noiseScale      ?? 0.35;
  const perturbStr = opts.perturbStrength ?? 0.8;
  const elevScale  = opts.elevationScale  ?? 0.5;
  const edgeDirs   = layout.orientation.edgeDirections;

  const { colStart, colEnd, rowStart, rowEnd } = bounds;
  const hexCount = (colEnd - colStart) * (rowEnd - rowStart);
  const maxVerts = hexCount * 72;

  const positions = new Float32Array(maxVerts * 3);
  const uvs       = new Float32Array(maxVerts * 2);
  let vi = 0, uvi = 0;

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

  /**
   * Waterfall quad clipped to the water surface.
   * Top vertices at y1; bottom vertices lerped toward top to land at wY.
   */
  const addWaterfallQuad = (
    x0: number, z0: number,
    x1: number, z1: number,
    x2: number, z2: number,
    x3: number, z3: number,
    y1: number, y2: number, wY: number,
  ) => {
    const [d0x, d0z] = perturb(x0, z0);
    const [d1x, d1z] = perturb(x1, z1);
    const [d2x, d2z] = perturb(x2, z2);
    const [d3x, d3z] = perturb(x3, z3);
    const p0x = x0 + d0x, p0z = z0 + d0z;
    const p1x = x1 + d1x, p1z = z1 + d1z;
    let   p2x = x2 + d2x, p2z = z2 + d2z;
    let   p3x = x3 + d3x, p3z = z3 + d3z;
    const t = (wY - y2) / (y1 - y2);
    p2x += (p0x - p2x) * t;  p2z += (p0z - p2z) * t;
    p3x += (p1x - p3x) * t;  p3z += (p1z - p3z) * t;
    positions[vi++] = p0x; positions[vi++] = y1;  positions[vi++] = p0z; uvs[uvi++] = 0.0; uvs[uvi++] = 0.8;
    positions[vi++] = p1x; positions[vi++] = y1;  positions[vi++] = p1z; uvs[uvi++] = 1.0; uvs[uvi++] = 0.8;
    positions[vi++] = p3x; positions[vi++] = wY;  positions[vi++] = p3z; uvs[uvi++] = 1.0; uvs[uvi++] = 1.0;
    positions[vi++] = p0x; positions[vi++] = y1;  positions[vi++] = p0z; uvs[uvi++] = 0.0; uvs[uvi++] = 0.8;
    positions[vi++] = p3x; positions[vi++] = wY;  positions[vi++] = p3z; uvs[uvi++] = 1.0; uvs[uvi++] = 1.0;
    positions[vi++] = p2x; positions[vi++] = wY;  positions[vi++] = p2z; uvs[uvi++] = 0.0; uvs[uvi++] = 1.0;
  };

  for (let row = rowStart; row < rowEnd; row++) {
    for (let col = colStart; col < colEnd; col++) {
      if (!map.inBounds(col, row)) continue;

      const isWater  = map.getTerrain(col, row) === TerrainType.Water;
      const hasRiver = map.hasRiver(col, row);
      if (!hasRiver || isWater) continue; // rivers only on land cells

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

        // Bridge positions: 1/4 and 3/4 of the way along the shared edge (tutorial e.v2 / e.v4).
        // These are narrower than the full corners, matching the carved channel width.
        const eLx = crns[i].x * 0.75 + crns[i1].x * 0.25;
        const eLz = crns[i].z * 0.75 + crns[i1].z * 0.25;
        const eRx = crns[i].x * 0.25 + crns[i1].x * 0.75;
        const eRz = crns[i].z * 0.25 + crns[i1].z * 0.75;

        let   nbRy      = ry;
        let   nbIsWater = false;
        const d  = edgeDirs[i];
        const nb = neighborOffset(col, row, d);
        if (map.inBounds(nb.col, nb.row)) {
          const nbTerrain = map.getTerrain(nb.col, nb.row);
          const nbElev    = map.getElevation(nb.col, nb.row);
          nbIsWater = nbTerrain === TerrainType.Water;
          nbRy = nbIsWater
            ? waterLevel
            : (nbElev + RIVER_SURFACE_ELEVATION_OFFSET) * elevScale;
        }

        if (isBeginEnd) {
          if (isOutgoing) {
            // Source: triangle fan from center outward.
            if (nbIsWater && ry > waterLevel) {
              // Clipped waterfall into water (bridge vertices at 1/4 and 3/4).
              const [dcx, dcz] = perturb(center.x, center.z);
              const [dLx, dLz] = perturb(eLx, eLz);
              const [dRx, dRz] = perturb(eRx, eRz);
              const pcx = center.x + dcx, pcz = center.z + dcz;
              const t = (waterLevel - nbRy) / (ry - nbRy);
              const pLx = (eLx + dLx) + (pcx - (eLx + dLx)) * t;
              const pLz = (eLz + dLz) + (pcz - (eLz + dLz)) * t;
              const pRx = (eRx + dRx) + (pcx - (eRx + dRx)) * t;
              const pRz = (eRz + dRz) + (pcz - (eRz + dRz)) * t;
              positions[vi++] = pcx; positions[vi++] = ry;         positions[vi++] = pcz; uvs[uvi++] = 0.5; uvs[uvi++] = 0.0;
              positions[vi++] = pLx; positions[vi++] = waterLevel; positions[vi++] = pLz; uvs[uvi++] = 0.0; uvs[uvi++] = 1.0;
              positions[vi++] = pRx; positions[vi++] = waterLevel; positions[vi++] = pRz; uvs[uvi++] = 1.0; uvs[uvi++] = 1.0;
            } else {
              // Land or same-level water: two-step source (center→midedge→bridge pts).
              const mLx = (center.x + eLx) * 0.5, mLz = (center.z + eLz) * 0.5;
              const mRx = (center.x + eRx) * 0.5, mRz = (center.z + eRz) * 0.5;
              addTri(
                center.x, ry, center.z, 0.5, 0.0,
                mLx,      ry, mLz,      0.0, 0.4,
                mRx,      ry, mRz,      1.0, 0.4,
              );
              addQuad(
                mLx, ry,   mLz, 0.0, 0.4,
                mRx, ry,   mRz, 1.0, 0.4,
                eLx, nbRy, eLz, 0.0, 0.8,
                eRx, nbRy, eRz, 1.0, 0.8,
              );
            }
          } else {
            // Terminus: two-step incoming (bridge pts→midedge→center), reversed U.
            const mLx = (center.x + eLx) * 0.5, mLz = (center.z + eLz) * 0.5;
            const mRx = (center.x + eRx) * 0.5, mRz = (center.z + eRz) * 0.5;
            addQuad(
              eLx, ry, eLz, 1.0, 0.0,
              eRx, ry, eRz, 0.0, 0.0,
              mLx, ry, mLz, 1.0, 0.4,
              mRx, ry, mRz, 0.0, 0.4,
            );
            addTri(
              center.x, ry, center.z, 0.5, 0.8,
              mLx,      ry, mLz,      1.0, 0.4,
              mRx,      ry, mRz,      0.0, 0.4,
            );
          }
        } else {
          // Through-river: 5-case cL/cR routing.
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
            // Centre tri at control points, V=0.8.
            addTri(
              cLx, ry, cLz, 0.0, 0.8,
              ccx, ry, ccz, 0.5, 0.8,
              cRx, ry, cRz, 1.0, 0.8,
            );
            // Bridge quad: control points (V=0.8) → inner edge 1/4 and 3/4 pts (V=1.0).
            if (nbIsWater && ry > waterLevel) {
              addWaterfallQuad(
                cLx, cLz, cRx, cRz,
                eLx, eLz, eRx, eRz,
                ry, nbRy, waterLevel,
              );
            } else {
              addQuad(
                cLx, ry,   cLz, 0.0, 0.8,
                cRx, ry,   cRz, 1.0, 0.8,
                eLx, nbRy, eLz, 0.0, 1.0,
                eRx, nbRy, eRz, 1.0, 1.0,
              );
            }
          } else {
            // Incoming: reversed U (1→0), V=0 at bridge pts → 0.8 at control pts.
            addTri(
              cLx, ry, cLz, 1.0, 0.8,
              ccx, ry, ccz, 0.5, 0.8,
              cRx, ry, cRz, 0.0, 0.8,
            );
            addQuad(
              eLx, ry, eLz, 1.0, 0.0,
              eRx, ry, eRz, 0.0, 0.0,
              cLx, ry, cLz, 1.0, 0.8,
              cRx, ry, cRz, 0.0, 0.8,
            );
          }
        }
      }
    }
  }

  if (vi === 0) return null;

  const n   = vi / 3;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, n * 3), 3));
  geo.setAttribute('uv',       new THREE.BufferAttribute(uvs.subarray(0, n * 2), 2));
  return geo;
}
