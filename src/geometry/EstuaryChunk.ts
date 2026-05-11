import * as THREE from 'three';
import type { HexLayout } from '../math/HexLayout.js';
import { hexToWorld } from '../math/HexLayout.js';
import { HEX_DIRECTIONS } from '../math/HexCoord.js';
import type { HexMap } from '../map/HexMap.js';
import { TerrainType } from '../map/HexCell.js';
import { sampleNoise } from '../math/Noise.js';
import type { ChunkBounds } from './HexChunk.js';
import type { WaterGeometryOptions } from './WaterChunk.js';

const WATER_FACTOR = 0.6;
const SOLID_FACTOR = 0.8;

/**
 * Builds the estuary geometry for a chunk.
 *
 * Matches Part 8 tutorial exactly — each estuary edge uses full 5-vertex edges:
 *   e1 (water side): v1..v5 at WATER_FACTOR from the water hex center
 *   e2 (land  side): v1..v5 at SOLID_FACTOR from the land  hex center
 *
 * Three shapes per estuary edge (corner tris stay in WaterShoreChunk):
 *   Left quad  (rotated): e2v1, e1v2, e2v2, e1v3
 *   Middle triangle:      e1v3, e2v2, e2v4
 *   Right quad:           e1v3, e1v4, e2v4, e2v5
 *
 * UV1 (uv)  — (blend, shore): blend=0 at sides/water-center, blend=1 at land center
 * UV2 (uv2) — incoming river flow with widening/curving fan (tutorial "Adjusting the Flow")
 */
export function buildEstuaryGeometry(
  map: HexMap,
  layout: HexLayout,
  bounds: ChunkBounds,
  opts: WaterGeometryOptions = {},
): THREE.BufferGeometry | null {
  const waterLevel = opts.waterLevel      ?? 0;
  const noiseScale = opts.noiseScale      ?? 0.35;
  const perturbStr = opts.perturbStrength ?? 0.8;
  const edgeDirs   = layout.orientation.edgeDirections;
  const startAngle = layout.orientation.startAngle;

  const { colStart, colEnd, rowStart, rowEnd } = bounds;
  const hexCount = (colEnd - colStart) * (rowEnd - rowStart);
  const maxVerts = hexCount * 90; // ≤6 estuary edges × 5 tris × 3 verts

  const positions = new Float32Array(maxVerts * 3);
  const uvs       = new Float32Array(maxVerts * 2);
  const uv2s      = new Float32Array(maxVerts * 2);
  let vi = 0, uvi = 0, uv2i = 0;

  const perturb = (x: number, z: number): [number, number] => {
    const n = sampleNoise(x * noiseScale, z * noiseScale);
    return [(n[0] * 2 - 1) * perturbStr, (n[2] * 2 - 1) * perturbStr];
  };

  const addVert = (
    x: number, z: number,
    u1: number, v1: number,
    u2: number, v2: number,
  ) => {
    const [dx, dz] = perturb(x, z);
    positions[vi++] = x + dx;
    positions[vi++] = waterLevel;
    positions[vi++] = z + dz;
    uvs[uvi++]   = u1; uvs[uvi++]   = v1;
    uv2s[uv2i++] = u2; uv2s[uv2i++] = v2;
  };

  const addTri = (
    x0: number, z0: number, u10: number, v10: number, u20: number, v20: number,
    x1: number, z1: number, u11: number, v11: number, u21: number, v21: number,
    x2: number, z2: number, u12: number, v12: number, u22: number, v22: number,
  ) => {
    addVert(x0, z0, u10, v10, u20, v20);
    addVert(x1, z1, u11, v11, u21, v21);
    addVert(x2, z2, u12, v12, u22, v22);
  };

  const cornerAt = (cx: number, cz: number, j: number, factor: number) => {
    const angle = (2 * Math.PI * (startAngle + j)) / 6;
    return { x: cx + layout.size * factor * Math.cos(angle), z: cz + layout.size * factor * Math.sin(angle) };
  };

  const hexCenter = (col: number, row: number) => {
    const q = col - (row - (row & 1)) / 2;
    return hexToWorld(layout, { q, r: row });
  };

  const lerp2 = (
    a: { x: number; z: number },
    b: { x: number; z: number },
    t: number,
  ) => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });

  for (let row = rowStart; row < rowEnd; row++) {
    for (let col = colStart; col < colEnd; col++) {
      if (!map.inBounds(col, row)) continue;
      if (map.getTerrain(col, row) !== TerrainType.Water) continue;

      const q      = col - (row - (row & 1)) / 2;
      const center = hexToWorld(layout, { q, r: row });

      for (let i = 0; i < 6; i++) {
        if (!map.hasRiverThroughEdge(col, row, i)) continue;

        const d  = edgeDirs[i];
        const dv = HEX_DIRECTIONS[d];
        const nq = q  + dv.q;
        const nr = row + dv.r;
        const nc = nq + (nr - (nr & 1)) / 2;

        if (!map.inBounds(nc, nr)) continue;
        if (map.getTerrain(nc, nr) === TerrainType.Water) continue;

        const i1 = (i + 1) % 6;

        // Incoming = river flows FROM land INTO this water cell.
        // Outgoing = river flows OUT OF this water cell into land.
        // UV2 mirrors: U → (1 − U), V → (0.8 − V) for outgoing (tutorial Part 8).
        const incomingRiver = (map.getIncomingRiverDir(col, row) === i);
        const fu = (u: number) => incomingRiver ? u : 1 - u;
        const fv = (v: number) => incomingRiver ? v : 0.8 - v;

        // e1: water-side 5-vertex edge at WATER_FACTOR
        const e1v1 = cornerAt(center.x, center.z, i,  WATER_FACTOR);
        const e1v5 = cornerAt(center.x, center.z, i1, WATER_FACTOR);
        const e1v2 = lerp2(e1v1, e1v5, 0.25);
        const e1v3 = lerp2(e1v1, e1v5, 0.50);
        const e1v4 = lerp2(e1v1, e1v5, 0.75);

        // e2: land-side 5-vertex edge at SOLID_FACTOR of the neighbour
        const nbc  = hexCenter(nc, nr);
        const e2v1 = cornerAt(nbc.x, nbc.z, (i + 4) % 6, SOLID_FACTOR);
        const e2v5 = cornerAt(nbc.x, nbc.z, (i + 3) % 6, SOLID_FACTOR);
        const e2v2 = lerp2(e2v1, e2v5, 0.25);
        const e2v4 = lerp2(e2v1, e2v5, 0.75);

        // Left quad (rotated for symmetry): e2v1, e1v2, e2v2, e1v3
        addTri(
          e2v1.x, e2v1.z,  0, 1,  fu(1.5),  fv(1.00),
          e1v2.x, e1v2.z,  0, 0,  fu(0.7),  fv(1.15),
          e2v2.x, e2v2.z,  1, 1,  fu(1.0),  fv(0.80),
        );
        addTri(
          e2v1.x, e2v1.z,  0, 1,  fu(1.5),  fv(1.00),
          e2v2.x, e2v2.z,  1, 1,  fu(1.0),  fv(0.80),
          e1v3.x, e1v3.z,  0, 0,  fu(0.5),  fv(1.10),
        );

        // Middle triangle: e1v3, e2v2, e2v4
        addTri(
          e1v3.x, e1v3.z,  0, 0,  fu(0.5),  fv(1.10),
          e2v2.x, e2v2.z,  1, 1,  fu(1.0),  fv(0.80),
          e2v4.x, e2v4.z,  1, 1,  fu(0.0),  fv(0.80),
        );

        // Right quad: e1v3, e1v4, e2v4, e2v5
        addTri(
          e1v3.x, e1v3.z,  0, 0,  fu(0.5),   fv(1.10),
          e1v4.x, e1v4.z,  0, 0,  fu(0.3),   fv(1.15),
          e2v4.x, e2v4.z,  1, 1,  fu(0.0),   fv(0.80),
        );
        addTri(
          e1v3.x, e1v3.z,  0, 0,  fu(0.5),   fv(1.10),
          e2v4.x, e2v4.z,  1, 1,  fu(0.0),   fv(0.80),
          e2v5.x, e2v5.z,  0, 1,  fu(-0.5),  fv(1.00),
        );
      }
    }
  }

  if (vi === 0) return null;

  const n   = vi / 3;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, n * 3), 3));
  geo.setAttribute('uv',       new THREE.BufferAttribute(uvs.subarray(0, n * 2), 2));
  geo.setAttribute('uv2',      new THREE.BufferAttribute(uv2s.subarray(0, n * 2), 2));
  return geo;
}
