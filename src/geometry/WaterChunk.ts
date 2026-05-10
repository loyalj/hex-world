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

function neighborOffset(col: number, row: number, d: number): { col: number; row: number } {
  const q  = col - (row - (row & 1)) / 2;
  const nq = q  + HEX_DIRECTIONS[d].q;
  const nr = row + HEX_DIRECTIONS[d].r;
  return { col: nq + (nr - (nr & 1)) / 2, row: nr };
}

/**
 * Builds a water geometry for a chunk following the Part 6/8 tutorial approach:
 *
 * - Standing water: full hex fan at `waterLevel` over every Water-terrain cell.
 * - River water: the between-cell connection quad is generated ONCE from the
 *   outgoing cell, using y1 = cell.RiverSurfaceY and y2 = neighbor.RiverSurfaceY
 *   (full slope, not averaged). Incoming edges produce no outer quad — the
 *   upstream cell's outgoing quad already covers the bridge. This matches the
 *   tutorial's TriangulateRiverQuad / TriangulateConnection pattern.
 * - Waterfalls into water: outer quad goes from ry down to waterLevel; suppressed
 *   when the cell's river surface is already at or below the water surface.
 *
 * All XZ perturbation uses sampleNoise with the same parameters as the terrain
 * builder, so water edges are seamless with the terrain they overlay.
 */
export function buildWaterGeometry(
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
  const maxVerts = hexCount * 80;

  const positions = new Float32Array(maxVerts * 3);
  let vi = 0;

  const perturb = (x: number, z: number): [number, number] => {
    const n = sampleNoise(x * noiseScale, z * noiseScale);
    return [(n[0] * 2 - 1) * perturbStr, (n[2] * 2 - 1) * perturbStr];
  };

  const addVert = (x: number, y: number, z: number) => {
    const [dx, dz] = perturb(x, z);
    positions[vi++] = x + dx;
    positions[vi++] = y;
    positions[vi++] = z + dz;
  };

  const addTri = (
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
  ) => { addVert(x0,y0,z0); addVert(x1,y1,z1); addVert(x2,y2,z2); };

  const addQuad = (
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    x3: number, y3: number, z3: number,
  ) => {
    addTri(x0,y0,z0, x1,y1,z1, x3,y3,z3);
    addTri(x0,y0,z0, x3,y3,z3, x2,y2,z2);
  };

  /**
   * Waterfall quad clipped to the water surface (Part 8 TriangulateWaterfallInWater).
   * Top vertices stay at y1 (river surface); bottom vertices are pulled toward the
   * top along XZ to sit at waterY, then the quad is added unperturbed (vertices were
   * already perturbed before the lerp).
   */
  const addWaterfallQuad = (
    x0: number, z0: number,  // top-left  XZ at y1
    x1: number, z1: number,  // top-right XZ at y1
    x2: number, z2: number,  // bot-left  XZ at y2
    x3: number, z3: number,  // bot-right XZ at y2
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
    // Pull bottom vertices toward top so they land at wY
    const t = (wY - y2) / (y1 - y2);
    p2x += (p0x - p2x) * t;  p2z += (p0z - p2z) * t;
    p3x += (p1x - p3x) * t;  p3z += (p1z - p3z) * t;
    // Add without further perturbation (already applied)
    positions[vi++] = p0x; positions[vi++] = y1; positions[vi++] = p0z;
    positions[vi++] = p1x; positions[vi++] = y1; positions[vi++] = p1z;
    positions[vi++] = p3x; positions[vi++] = wY; positions[vi++] = p3z;
    positions[vi++] = p0x; positions[vi++] = y1; positions[vi++] = p0z;
    positions[vi++] = p3x; positions[vi++] = wY; positions[vi++] = p3z;
    positions[vi++] = p2x; positions[vi++] = wY; positions[vi++] = p2z;
  };

  for (let row = rowStart; row < rowEnd; row++) {
    for (let col = colStart; col < colEnd; col++) {
      if (!map.inBounds(col, row)) continue;

      const isWater  = map.getTerrain(col, row) === TerrainType.Water;
      const hasRiver = map.hasRiver(col, row);
      if (!isWater && !hasRiver) continue;

      const q      = col - (row - (row & 1)) / 2;
      const center = hexToWorld(layout, { q, r: row });
      const crns   = hexCorners(layout, { q, r: row });
      const ownElev = map.getElevation(col, row);

      // --- Standing water: full hex fan at waterLevel ---
      if (isWater) {
        for (let i = 0; i < 6; i++) {
          const i1 = (i + 1) % 6;
          addTri(
            center.x,   waterLevel, center.z,
            crns[i1].x, waterLevel, crns[i1].z,
            crns[i].x,  waterLevel, crns[i].z,
          );
        }
      }

      // --- River water ---
      if (hasRiver && !isWater) {
        const ry         = (ownElev + RIVER_SURFACE_ELEVATION_OFFSET) * elevScale;
        const isBeginEnd = map.hasRiverBeginOrEnd(col, row);
        const outDir     = map.getOutgoingRiverDir(col, row);

        const ox = crns.map(c => c.x - center.x);
        const oz = crns.map(c => c.z - center.z);

        for (let i = 0; i < 6; i++) {
          if (!map.hasRiverThroughEdge(col, row, i)) continue;
          const i1         = (i + 1) % 6;
          const isOutgoing = (i === outDir);

          // Look up the neighbour's river surface Y.
          // The outgoing quad uses the full range ry→nbRy (tutorial Part 6 approach).
          let   nbRy     = ry;
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
              // Source: fan triangle from centre out to the hex edge.
              if (nbIsWater && ry > waterLevel) {
                // Waterfall into standing water: clip to water surface level.
                const [dcx, dcz] = perturb(center.x, center.z);
                const [dLx, dLz] = perturb(crns[i].x, crns[i].z);
                const [dRx, dRz] = perturb(crns[i1].x, crns[i1].z);
                const pcx = center.x + dcx, pcz = center.z + dcz;
                const t = (waterLevel - nbRy) / (ry - nbRy);
                const pLx = (crns[i].x  + dLx) + (pcx - (crns[i].x  + dLx)) * t;
                const pLz = (crns[i].z  + dLz) + (pcz - (crns[i].z  + dLz)) * t;
                const pRx = (crns[i1].x + dRx) + (pcx - (crns[i1].x + dRx)) * t;
                const pRz = (crns[i1].z + dRz) + (pcz - (crns[i1].z + dRz)) * t;
                positions[vi++] = pcx; positions[vi++] = ry;         positions[vi++] = pcz;
                positions[vi++] = pLx; positions[vi++] = waterLevel; positions[vi++] = pLz;
                positions[vi++] = pRx; positions[vi++] = waterLevel; positions[vi++] = pRz;
              } else if (!nbIsWater) {
                addTri(
                  center.x,    ry,    center.z,
                  crns[i].x,   nbRy,  crns[i].z,
                  crns[i1].x,  nbRy,  crns[i1].z,
                );
              }
            } else {
              // Terminus: full flat fan from centre to hex edge at own river surface.
              // The upstream outgoing quad ends at these hex corners, so this fills
              // the receiving cell's half of the connection seamlessly.
              addTri(
                center.x,    ry, center.z,
                crns[i].x,   ry, crns[i].z,
                crns[i1].x,  ry, crns[i1].z,
              );
            }
          } else {
            // Through-river: replicate terrain's 5-case cL/cR routing.
            const ip  = (i + 5) % 6;
            const in2 = (i + 2) % 6;
            let cLx: number, cLz: number, cRx: number, cRz: number;

            if (map.hasRiverThroughEdge(col, row, (i + 3) % 6)) {
              // straight
              cLx = center.x + ox[ip]  * SOLID_FACTOR * 0.25;
              cLz = center.z + oz[ip]  * SOLID_FACTOR * 0.25;
              cRx = center.x + ox[in2] * SOLID_FACTOR * 0.25;
              cRz = center.z + oz[in2] * SOLID_FACTOR * 0.25;
            } else if (map.hasRiverThroughEdge(col, row, i1)) {
              // sharp turn toward next
              cLx = center.x; cLz = center.z;
              cRx = center.x + ox[i1] * SOLID_FACTOR * (2 / 3);
              cRz = center.z + oz[i1] * SOLID_FACTOR * (2 / 3);
            } else if (map.hasRiverThroughEdge(col, row, ip)) {
              // sharp turn toward prev
              cLx = center.x + ox[i] * SOLID_FACTOR * (2 / 3);
              cLz = center.z + oz[i] * SOLID_FACTOR * (2 / 3);
              cRx = center.x; cRz = center.z;
            } else if (map.hasRiverThroughEdge(col, row, in2)) {
              // gentle curve toward next+2
              cLx = center.x; cLz = center.z;
              cRx = center.x + (ox[i1] + ox[in2]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER;
              cRz = center.z + (oz[i1] + oz[in2]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER;
            } else {
              // gentle curve toward prev+2
              cLx = center.x + (ox[ip] + ox[i]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER;
              cLz = center.z + (oz[ip] + oz[i]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER;
              cRx = center.x; cRz = center.z;
            }

            const ccx = (cLx + cRx) * 0.5, ccz = (cLz + cRz) * 0.5;

            // Centre tri: fills the inner channel — emitted for both directions.
            addTri(cLx, ry, cLz,  ccx, ry, ccz,  cRx, ry, cRz);

            if (isOutgoing) {
              // Outgoing: full-slope outer quad from cL/cR to hex boundary at nbRy.
              if (nbIsWater && ry > waterLevel) {
                addWaterfallQuad(
                  cLx, cLz, cRx, cRz,
                  crns[i].x, crns[i].z, crns[i1].x, crns[i1].z,
                  ry, nbRy, waterLevel,
                );
              } else if (!nbIsWater) {
                addQuad(
                  cLx,        ry,    cLz,
                  cRx,        ry,    cRz,
                  crns[i].x,  nbRy,  crns[i].z,
                  crns[i1].x, nbRy,  crns[i1].z,
                );
              }
            } else {
              // Incoming: flat fill quad from hex boundary inward to cL/cR, all at ry.
              // This fills the receiving cell's half of the bridge; the upstream
              // outgoing quad already ends at these hex corners at ry.
              addQuad(
                crns[i].x,  ry, crns[i].z,
                crns[i1].x, ry, crns[i1].z,
                cLx,        ry, cLz,
                cRx,        ry, cRz,
              );
            }
          }
        }
      }
    }
  }

  if (vi === 0) return null;

  const n   = vi / 3;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, n * 3), 3));
  return geo;
}
