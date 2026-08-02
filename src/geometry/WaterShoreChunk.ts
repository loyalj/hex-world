import * as THREE from 'three';
import type { HexLayout } from '../math/HexLayout.js';
import { hexToWorld } from '../math/HexLayout.js';
import { HEX_DIRECTIONS } from '../math/HexCoord.js';
import type { HexMap } from '../map/HexMap.js';
import { DEFAULT_WATER_TERRAIN_INDEX } from './TerrainTypes.js';
import { ELEVATION_SCALE } from '../map/HexCell.js';
import { sampleNoise } from '../math/Noise.js';
import type { ChunkBounds } from './HexChunk.js';
import type { WaterGeometryOptions } from './WaterChunk.js';

/** Fraction of hex radius for the water-side edge of the shore strip. */
const WATER_FACTOR = 0.6;
/** Fraction of hex radius for the land-side edge (matches terrain solid factor). */
const SOLID_FACTOR = 0.8;

/**
 * Builds the shore water geometry for a chunk.
 *
 * Water-side vertices are flat at the per-body water surface Y. Land-side
 * vertices stop halfway between the water surface and the terrain Y of the land
 * cell, so the foamy V=1 edge hugs the terrain slope without climbing all the
 * way onto the tile surface. The mesh must render after the full-hex surface
 * mesh (ChunkManager assigns an explicit renderOrder) — the surface overlaps
 * the fan and most of the strip, and would wash the foam out otherwise.
 *
 * For every water cell edge bordering land we emit:
 *   1. A fan triangle (center → water-side corners) — V=0 throughout.
 *   2. A strip quad (water-side corners → land solid corners), V=0→1.
 *      Skipped for estuary edges — EstuaryChunk handles those instead.
 *   3. A corner triangle at corner i1 filling the three-way junction.
 *
 * UV: V=0 on the water side, V=1 on the land side.
 */
export function buildShoreGeometry(
  map: HexMap,
  layout: HexLayout,
  bounds: ChunkBounds,
  opts: WaterGeometryOptions = {},
): THREE.BufferGeometry | null {
  const noiseScale     = opts.noiseScale         ?? 0.35;
  const perturbStr     = opts.perturbStrength    ?? 0.8;
  const elevScale      = opts.elevationScale     ?? ELEVATION_SCALE;
  const surfaceLift    = opts.surfaceLift        ?? 0.02;
  // Land-side vertices must track the terrain mesh, which perturbs with its own
  // ChunkGeometryOptions — not the liquid's (possibly overridden) noise settings.
  const terrainNoiseScale = opts.terrainNoiseScale          ?? 0.35;
  const terrainPerturbStr = opts.terrainPerturbStrength     ?? 0.8;
  const elevPerturbStr    = opts.terrainElevPerturbStrength ?? 0.2;
  const edgeDirs       = layout.orientation.edgeDirections;
  const waterTerrains     = opts.waterTerrains ?? new Set([DEFAULT_WATER_TERRAIN_INDEX]);
  const allLiquidTerrains = opts.allLiquidTerrains;
  const isWater       = (t: number) => waterTerrains.has(t);
  const isOtherLiquid = (t: number) => !!allLiquidTerrains && allLiquidTerrains.has(t) && !waterTerrains.has(t);
  // Lower terrain index = higher rendering priority at liquid-liquid boundaries.
  // Only the higher-priority liquid renders a shore so there's a single clean foam
  // line. Priority is liquid-level: every terrain index of a liquid shares that
  // liquid's lowest index, so liquids spanning multiple indices compare correctly.
  const currentLiquidPriority = Math.min(...waterTerrains);
  const priorityOf = (t: number) => opts.liquidPriorityByTerrain?.get(t) ?? t;
  const startAngle = layout.orientation.startAngle;

  const { colStart, colEnd, rowStart, rowEnd } = bounds;
  const hexCount = (colEnd - colStart) * (rowEnd - rowStart);
  const maxVerts = hexCount * 60;

  const positions   = new Float32Array(maxVerts * 3);
  const uvs         = new Float32Array(maxVerts * 2);
  const cellIndices = new Float32Array(maxVerts);
  let vi = 0, uvi = 0, cii = 0;
  let curCi = 0;

  const perturbXZ = (x: number, z: number): [number, number] => {
    const n = sampleNoise(x * noiseScale, z * noiseScale);
    return [(n[0] * 2 - 1) * perturbStr, (n[2] * 2 - 1) * perturbStr];
  };

  /** XZ perturbation matching HexChunk's terrain vertices — used for land-side vertices. */
  const perturbXZLand = (x: number, z: number): [number, number] => {
    const n = sampleNoise(x * terrainNoiseScale, z * terrainNoiseScale);
    return [(n[0] * 2 - 1) * terrainPerturbStr, (n[2] * 2 - 1) * terrainPerturbStr];
  };

  /** Y matching HexChunk.cellElevY — samples at cell center, same formula. */
  const landCellY = (col: number, row: number): number => {
    const q  = col - (row - (row & 1)) / 2;
    const wc = hexToWorld(layout, { q, r: row });
    const n  = sampleNoise(wc.x * terrainNoiseScale, wc.z * terrainNoiseScale);
    const dy = (n[1] * 2 - 1) * elevPerturbStr;
    return map.getElevation(col, row) * elevScale + dy;
  };

  /** `land` selects the terrain-matched perturbation for land-side vertices. */
  const addVert = (x: number, z: number, y: number, u: number, v: number, land = false) => {
    const [dx, dz] = land ? perturbXZLand(x, z) : perturbXZ(x, z);
    positions[vi++] = x + dx;
    positions[vi++] = y;
    positions[vi++] = z + dz;
    uvs[uvi++] = u;
    uvs[uvi++] = v;
    cellIndices[cii++] = curCi;
  };

  const addTri = (
    x0: number, z0: number, y0: number, u0: number, v0: number,
    x1: number, z1: number, y1: number, u1: number, v1: number,
    x2: number, z2: number, y2: number, u2: number, v2: number,
    l0 = false, l1 = false, l2 = false,
  ) => { addVert(x0, z0, y0, u0, v0, l0); addVert(x1, z1, y1, u1, v1, l1); addVert(x2, z2, y2, u2, v2, l2); };

  const addQuad = (
    x0: number, z0: number, y0: number, u0: number, v0: number,
    x1: number, z1: number, y1: number, u1: number, v1: number,
    x2: number, z2: number, y2: number, u2: number, v2: number,
    x3: number, z3: number, y3: number, u3: number, v3: number,
    l0 = false, l1 = false, l2 = false, l3 = false,
  ) => {
    addTri(x0, z0, y0, u0, v0,  x1, z1, y1, u1, v1,  x3, z3, y3, u3, v3,  l0, l1, l3);
    addTri(x0, z0, y0, u0, v0,  x3, z3, y3, u3, v3,  x2, z2, y2, u2, v2,  l0, l3, l2);
  };

  /** World position of corner j of a hex centered at (cx, cz) at the given radius factor. */
  const cornerAt = (cx: number, cz: number, j: number, factor: number) => {
    const angle = (2 * Math.PI * (startAngle + j)) / 6;
    return { x: cx + layout.size * factor * Math.cos(angle), z: cz + layout.size * factor * Math.sin(angle) };
  };

  /** World-space center of the hex at offset (col, row). */
  const hexCenter = (col: number, row: number) => {
    const q = col - (row - (row & 1)) / 2;
    return hexToWorld(layout, { q, r: row });
  };

  for (let row = rowStart; row < rowEnd; row++) {
    for (let col = colStart; col < colEnd; col++) {
      if (!map.inBounds(col, row)) continue;
      if (!isWater(map.getTerrain(col, row))) continue;

      curCi = row * map.width + col;
      const q          = col - (row - (row & 1)) / 2;
      const center     = hexToWorld(layout, { q, r: row });
      const wSurfaceY  = map.getWaterSurface(col, row) * elevScale + surfaceLift;

      for (let i = 0; i < 6; i++) {
        const d  = edgeDirs[i];
        const dv = HEX_DIRECTIONS[d];
        const nq = q  + dv.q;
        const nr = row + dv.r;
        const nc = nq + (nr - (nr & 1)) / 2;

        if (!map.inBounds(nc, nr)) continue;
        const nbTerrain = map.getTerrain(nc, nr);
        if (isWater(nbTerrain)) continue;

        const i1 = (i + 1) % 6;
        const nbIsOtherLiquid = isOtherLiquid(nbTerrain);

        // Water-side corners at WATER_FACTOR, all at the water surface Y (V=0).
        const c1 = cornerAt(center.x, center.z, i,  WATER_FACTOR);
        const c2 = cornerAt(center.x, center.z, i1, WATER_FACTOR);

        // 1. Fan triangle: center → water corners, all at water surface Y, V=0.
        addTri(
          center.x, center.z, wSurfaceY, 0, 0,
          c2.x,     c2.z,     wSurfaceY, 0, 0,
          c1.x,     c1.z,     wSurfaceY, 0, 0,
        );

        // 2. Strip quad.
        if (nbIsOtherLiquid) {
          // Only the higher-priority liquid renders a shore here. The lower-priority
          // liquid skips so there's exactly one foam line at the boundary.
          if (priorityOf(nbTerrain) < currentLiquidPriority) continue;

          // Keep the strip within the current hex so it never overlaps the other
          // liquid's surface mesh. The foam (V=1) appears at SOLID_FACTOR — close
          // to the hex boundary but not crossing into the other cell.
          const ls1 = cornerAt(center.x, center.z, i,  SOLID_FACTOR);
          const ls2 = cornerAt(center.x, center.z, i1, SOLID_FACTOR);
          addQuad(
            c1.x,  c1.z,  wSurfaceY, 0, 0,
            c2.x,  c2.z,  wSurfaceY, 0, 0,
            ls1.x, ls1.z, wSurfaceY, 0, 1,
            ls2.x, ls2.z, wSurfaceY, 0, 1,
          );
          // No corner triangle for liquid-liquid boundaries.
        } else {
          // Neighbor is land. Standard shore strip + corner triangle.
          // Estuary edges get their strip from EstuaryChunk — only the fan and
          // corner triangles are emitted here, so the two transparent meshes
          // don't double-blend over the same area.
          if (!map.hasRiverThroughEdge(col, row, i)) {
            const nbc  = hexCenter(nc, nr);
            const ls1  = cornerAt(nbc.x, nbc.z, (i + 4) % 6, SOLID_FACTOR);
            const ls2  = cornerAt(nbc.x, nbc.z, (i + 3) % 6, SOLID_FACTOR);
            const nbY  = wSurfaceY + (landCellY(nc, nr) - wSurfaceY) * 0.5;

            addQuad(
              c1.x,  c1.z,  wSurfaceY, 0, 0,
              c2.x,  c2.z,  wSurfaceY, 0, 0,
              ls1.x, ls1.z, nbY,       0, 1,
              ls2.x, ls2.z, nbY,       0, 1,
              false, false, true, true,
            );
          }

          // 3. Corner triangle: fill the three-way junction at corner i1.
          const d2v  = HEX_DIRECTIONS[edgeDirs[i1]];
          const nb2q = q  + d2v.q;
          const nb2r = row + d2v.r;
          const nb2c = nb2q + (nb2r - (nb2r & 1)) / 2;

          if (map.inBounds(nb2c, nb2r)) {
            const nb2Terrain       = map.getTerrain(nb2c, nb2r);
            const nb2IsWater       = isWater(nb2Terrain);
            const nb2IsOtherLiquid = isOtherLiquid(nb2Terrain);
            const nb2IsLiquidLike  = nb2IsWater || nb2IsOtherLiquid;
            const nb2Center  = hexCenter(nb2c, nb2r);
            const cornerJ    = (i + 5) % 6;
            const factor     = nb2IsLiquidLike ? WATER_FACTOR : SOLID_FACTOR;
            const v3         = cornerAt(nb2Center.x, nb2Center.z, cornerJ, factor);
            const v3Y        = nb2IsLiquidLike
              ? (nb2IsOtherLiquid ? map.getWaterSurface(nb2c, nb2r) * elevScale + surfaceLift : wSurfaceY)
              : wSurfaceY + (landCellY(nb2c, nb2r) - wSurfaceY) * 0.5;
            const v3V        = nb2IsLiquidLike ? 0 : 1;

            const nbc2 = hexCenter(nc, nr);
            const ls2e = cornerAt(nbc2.x, nbc2.z, (i + 3) % 6, SOLID_FACTOR);
            const ls2Y = wSurfaceY + (landCellY(nc, nr) - wSurfaceY) * 0.5;

            addTri(
              c2.x,   c2.z,   wSurfaceY, 0, 0,
              ls2e.x, ls2e.z, ls2Y,      0, 1,
              v3.x,   v3.z,   v3Y,       0, v3V,
              false, true, !nb2IsLiquidLike,
            );
          }
        }
      }
    }
  }

  if (vi === 0) return null;

  const n   = vi / 3;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',  new THREE.BufferAttribute(positions.slice(0, n * 3), 3));
  geo.setAttribute('uv',        new THREE.BufferAttribute(uvs.slice(0, n * 2), 2));
  geo.setAttribute('cellIndex', new THREE.BufferAttribute(cellIndices.slice(0, n), 1));
  return geo;
}
