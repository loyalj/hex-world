import * as THREE from 'three';
import type { HexLayout } from '../math/HexLayout.js';
import { hexToWorld } from '../math/HexLayout.js';
import { HEX_DIRECTIONS } from '../math/HexCoord.js';
import type { HexMap } from '../map/HexMap.js';
import { TerrainType } from '../map/HexCell.js';
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
 * Water-side vertices are flat at waterLevel. Land-side vertices use the actual
 * terrain Y so the foamy V=1 edge sits on the terrain surface and is rendered
 * on top via polygonOffset rather than being hidden underground.
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
  const waterLevel     = opts.waterLevel         ?? 0;
  const noiseScale     = opts.noiseScale         ?? 0.35;
  const perturbStr     = opts.perturbStrength    ?? 0.8;
  const elevScale      = opts.elevationScale     ?? 0.5;
  const elevPerturbStr = 0.2; // must match HexChunk elevPerturbStrength default
  const edgeDirs   = layout.orientation.edgeDirections;
  const startAngle = layout.orientation.startAngle;

  const { colStart, colEnd, rowStart, rowEnd } = bounds;
  const hexCount = (colEnd - colStart) * (rowEnd - rowStart);
  const maxVerts = hexCount * 60;

  const positions = new Float32Array(maxVerts * 3);
  const uvs       = new Float32Array(maxVerts * 2);
  let vi = 0, uvi = 0;

  const perturbSample = (x: number, z: number) =>
    sampleNoise(x * noiseScale, z * noiseScale);

  const perturbXZ = (x: number, z: number): [number, number] => {
    const n = perturbSample(x, z);
    return [(n[0] * 2 - 1) * perturbStr, (n[2] * 2 - 1) * perturbStr];
  };

  /** Y matching HexChunk.cellElevY — samples at cell center, same formula. */
  const landCellY = (col: number, row: number): number => {
    const q  = col - (row - (row & 1)) / 2;
    const wc = hexToWorld(layout, { q, r: row });
    const n  = perturbSample(wc.x, wc.z);
    const dy = (n[1] * 2 - 1) * elevPerturbStr;
    return map.getElevation(col, row) * elevScale + dy;
  };

  const addVert = (x: number, z: number, y: number, u: number, v: number) => {
    const [dx, dz] = perturbXZ(x, z);
    positions[vi++] = x + dx;
    positions[vi++] = y;
    positions[vi++] = z + dz;
    uvs[uvi++] = u;
    uvs[uvi++] = v;
  };

  const addTri = (
    x0: number, z0: number, y0: number, u0: number, v0: number,
    x1: number, z1: number, y1: number, u1: number, v1: number,
    x2: number, z2: number, y2: number, u2: number, v2: number,
  ) => { addVert(x0, z0, y0, u0, v0); addVert(x1, z1, y1, u1, v1); addVert(x2, z2, y2, u2, v2); };

  const addQuad = (
    x0: number, z0: number, y0: number, u0: number, v0: number,
    x1: number, z1: number, y1: number, u1: number, v1: number,
    x2: number, z2: number, y2: number, u2: number, v2: number,
    x3: number, z3: number, y3: number, u3: number, v3: number,
  ) => {
    addTri(x0, z0, y0, u0, v0,  x1, z1, y1, u1, v1,  x3, z3, y3, u3, v3);
    addTri(x0, z0, y0, u0, v0,  x3, z3, y3, u3, v3,  x2, z2, y2, u2, v2);
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
      if (map.getTerrain(col, row) !== TerrainType.Water) continue;

      const q      = col - (row - (row & 1)) / 2;
      const center = hexToWorld(layout, { q, r: row });

      for (let i = 0; i < 6; i++) {
        const d  = edgeDirs[i];
        const dv = HEX_DIRECTIONS[d];
        const nq = q  + dv.q;
        const nr = row + dv.r;
        const nc = nq + (nr - (nr & 1)) / 2;

        if (!map.inBounds(nc, nr)) continue;
        if (map.getTerrain(nc, nr) === TerrainType.Water) continue;

        // Shore edge found: current cell is water, neighbor (nc,nr) is land.
        const i1 = (i + 1) % 6;

        // Water-side corners at WATER_FACTOR, all at waterLevel (V=0).
        const c1 = cornerAt(center.x, center.z, i,  WATER_FACTOR);
        const c2 = cornerAt(center.x, center.z, i1, WATER_FACTOR);

        // 1. Fan triangle: center → water corners, all at waterLevel, V=0.
        addTri(
          center.x, center.z, waterLevel, 0, 0,
          c2.x,     c2.z,     waterLevel, 0, 0,
          c1.x,     c1.z,     waterLevel, 0, 0,
        );

        // 2. Strip quad: water side (waterLevel) → land side (terrain Y).
        //    Land-side uses actual terrain Y so the V=1 foam edge sits on the
        //    terrain surface and is visible via polygonOffset over the terrain.
        //    Skipped for estuary edges; EstuaryChunk handles those.
        const isEstuary = map.hasRiverThroughEdge(col, row, i);
        if (!isEstuary) {
          const nbc  = hexCenter(nc, nr);
          const ls1  = cornerAt(nbc.x, nbc.z, (i + 4) % 6, SOLID_FACTOR);
          const ls2  = cornerAt(nbc.x, nbc.z, (i + 3) % 6, SOLID_FACTOR);
          const nbY  = landCellY(nc, nr);

          addQuad(
            c1.x,  c1.z,  waterLevel, 0, 0,
            c2.x,  c2.z,  waterLevel, 0, 0,
            ls1.x, ls1.z, nbY,        0, 1,
            ls2.x, ls2.z, nbY,        0, 1,
          );
        }

        // 3. Corner triangle: fill the three-way junction at corner i1.
        const d2v  = HEX_DIRECTIONS[edgeDirs[i1]];
        const nb2q = q  + d2v.q;
        const nb2r = row + d2v.r;
        const nb2c = nb2q + (nb2r - (nb2r & 1)) / 2;

        if (map.inBounds(nb2c, nb2r)) {
          const nb2IsWater = map.getTerrain(nb2c, nb2r) === TerrainType.Water;
          const nb2Center  = hexCenter(nb2c, nb2r);
          const cornerJ    = (i + 5) % 6;
          const factor     = nb2IsWater ? WATER_FACTOR : SOLID_FACTOR;
          const v3         = cornerAt(nb2Center.x, nb2Center.z, cornerJ, factor);
          const v3Y        = nb2IsWater ? waterLevel : landCellY(nb2c, nb2r);
          const v3V        = nb2IsWater ? 0 : 1;

          const nbc2 = hexCenter(nc, nr);
          const ls2  = cornerAt(nbc2.x, nbc2.z, (i + 3) % 6, SOLID_FACTOR);
          const ls2Y = landCellY(nc, nr);

          addTri(
            c2.x,  c2.z,  waterLevel, 0, 0,
            ls2.x, ls2.z, ls2Y,       0, 1,
            v3.x,  v3.z,  v3Y,        0, v3V,
          );
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
