import { describe, it, expect } from 'vitest';
import type * as THREE from 'three';
import { HexMap } from '../src/map/HexMap.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';
import { createLayout, hexToWorld, hexCorners } from '../src/math/HexLayout.js';
import { offsetToHex } from '../src/math/HexCoord.js';
import { sampleNoise } from '../src/math/Noise.js';
import { RIVER_SURFACE_ELEVATION_OFFSET, STREAM_BED_ELEVATION_OFFSET } from '../src/map/HexCell.js';
import {
  RIVER_BASE_HALF_WIDTH, RIVER_MIN_HALF_WIDTH, RIVER_MAX_HALF_WIDTH,
  riverHalfWidth, riverWidthScale, riverEdgeFlow,
} from '../src/geometry/RiverWidth.js';
import { computeRiverFlow, buildRiverGeometry } from '../src/geometry/WaterChunk.js';
import { buildChunkGeometry } from '../src/geometry/HexChunk.js';

const EDGE_DIRS = POINTY_TOP.edgeDirections;
const eastEdge  = EDGE_DIRS.findIndex(d => d === 0); // HEX_DIRECTIONS[0] = {q:1, r:0}
const layout    = createLayout(POINTY_TOP, 1);
const bounds    = { colStart: 0, colEnd: 24, rowStart: 0, rowEnd: 24 };

/** Straight west→east river along `row`, from col `c0` to col `c1` (inclusive). */
function paintEastRiver(map: HexMap, row: number, c0: number, c1: number): void {
  for (let c = c0; c < c1; c++) {
    map.setRiverOutgoing(c, row, eastEdge);
    map.setRiverIncoming(c + 1, row, (eastEdge + 3) % 6);
  }
}

/** The default XZ perturbation both geometry builders apply (noiseScale 0.35, strength 0.8). */
function perturb(x: number, z: number): [number, number] {
  const n = sampleNoise(x * 0.35, z * 0.35);
  return [(n[0] * 2 - 1) * 0.8, (n[2] * 2 - 1) * 0.8];
}

/** True if the geometry contains a vertex within eps of (x, y, z). */
function hasVertex(geo: THREE.BufferGeometry, x: number, y: number, z: number, eps = 1e-4): boolean {
  const pos = geo.getAttribute('position');
  for (let k = 0; k < pos.count; k++) {
    if (Math.abs(pos.getX(k) - x) < eps && Math.abs(pos.getY(k) - y) < eps && Math.abs(pos.getZ(k) - z) < eps) {
      return true;
    }
  }
  return false;
}

describe('riverHalfWidth', () => {
  it('headwaters are slim, big rivers capped, all inside the hex edge', () => {
    expect(riverHalfWidth(1)).toBe(RIVER_MIN_HALF_WIDTH);
    expect(riverHalfWidth(0)).toBe(RIVER_MIN_HALF_WIDTH);
    expect(riverHalfWidth(1e9)).toBe(RIVER_MAX_HALF_WIDTH);
    expect(RIVER_MAX_HALF_WIDTH).toBeLessThan(0.5);
  });

  it('grows monotonically and does NOT saturate before typical map-scale flows', () => {
    let prev = riverHalfWidth(1);
    for (const f of [2, 4, 8, 16, 20]) {
      const s = riverHalfWidth(f);
      expect(s).toBeGreaterThan(prev); // strictly — visible growth across the whole range
      prev = s;
    }
    // A confluence of two flow-5 tributaries must be visibly wider than either.
    expect(riverHalfWidth(11)).toBeGreaterThan(riverHalfWidth(5) * 1.1);
  });

  it('riverWidthScale is halfWidth relative to the fixed-width era', () => {
    expect(riverWidthScale(7)).toBeCloseTo(riverHalfWidth(7) / RIVER_BASE_HALF_WIDTH);
  });
});

describe('riverEdgeFlow', () => {
  it('both cells of every shared river edge agree on the edge flow', () => {
    const map = new HexMap({ width: 24, height: 24 });
    paintEastRiver(map, 10, 2, 20);
    // Tributary: cell (10,8) drains south-ish into the stem via paired edges,
    // using whatever edge geometry connects (10,9)→(10,10)'s neighborhood —
    // built with the paired-edge convention so it forms a real confluence.
    for (let e = 0; e < 6; e++) {
      const n = map.roadEdgeNeighbor(10, 9, e, POINTY_TOP);
      if (n && n.col === 10 && n.row === 10) {
        map.setRiverOutgoing(10, 9, e);
        map.setRiverIncoming(10, 10, n.edge);
        break;
      }
    }
    const flow = computeRiverFlow(map, EDGE_DIRS);

    map.forEach((col, row) => {
      if (!map.hasRiver(col, row)) return;
      for (let e = 0; e < 6; e++) {
        if (!map.hasRiverThroughEdge(col, row, e)) continue;
        const n = map.roadEdgeNeighbor(col, row, e, POINTY_TOP);
        if (!n || !map.hasRiverThroughEdge(n.col, n.row, n.edge)) continue;
        expect(riverEdgeFlow(map, flow, n.col, n.row, n.edge, EDGE_DIRS))
          .toBe(riverEdgeFlow(map, flow, col, row, e, EDGE_DIRS));
      }
    });

    // The confluence actually accumulated: downstream of the join carries
    // more than the stem alone would (9 stem cells + 1 tributary at col 10).
    expect(flow.get(10 * 24 + 11)!).toBeGreaterThan(10);
  });

  it('accumulates downstream', () => {
    const map = new HexMap({ width: 24, height: 24 });
    paintEastRiver(map, 10, 2, 20);
    const flow = computeRiverFlow(map, EDGE_DIRS);
    expect(riverEdgeFlow(map, flow, 18, 10, eastEdge, EDGE_DIRS))
      .toBeGreaterThan(riverEdgeFlow(map, flow, 3, 10, eastEdge, EDGE_DIRS));
  });
});

describe('flow-dependent channel widening', () => {
  it('omitting the flow map reproduces the legacy fixed width; flow-1 streams render slimmer', () => {
    const map = new HexMap({ width: 24, height: 24 });
    paintEastRiver(map, 10, 2, 6);
    const ones = new Map<number, number>();
    map.forEach((c, r) => { if (map.hasRiver(c, r)) ones.set(r * map.width + c, 1); });

    // With flow enabled, a flow-1 stream uses RIVER_MIN_HALF_WIDTH < 0.25:
    // its channel-edge vertices sit at t = 0.5 − MIN instead of 0.25.
    const slim = buildRiverGeometry(map, layout, bounds, { riverFlow: ones })!;
    const hex  = offsetToHex(3, 10);
    const crns = hexCorners(layout, hex);
    const i = eastEdge, i1 = (eastEdge + 1) % 6;
    const ry = RIVER_SURFACE_ELEVATION_OFFSET * 0.5;
    for (const [geo, hw] of [[slim, RIVER_MIN_HALF_WIDTH], [buildRiverGeometry(map, layout, bounds, {})!, RIVER_BASE_HALF_WIDTH]] as const) {
      const x = crns[i].x + (crns[i1].x - crns[i].x) * (0.5 - hw);
      const z = crns[i].z + (crns[i1].z - crns[i].z) * (0.5 - hw);
      const [dx, dz] = perturb(x, z);
      expect(hasVertex(geo, x + dx, ry, z + dz)).toBe(true);
    }
  });

  it('every river face of a confluence agrees between water and bed (incl. the junction cell)', () => {
    const map = new HexMap({ width: 24, height: 24 });
    // Main stem through (2..20, 10) plus a tributary entering the junction
    // cell (10,10) from (10,9): junction cell has 2 incoming + 1 outgoing.
    paintEastRiver(map, 10, 2, 20);
    for (let e = 0; e < 6; e++) {
      const n = map.roadEdgeNeighbor(10, 9, e, POINTY_TOP);
      if (n && n.col === 10 && n.row === 10) {
        map.setRiverOutgoing(10, 9, e);
        map.setRiverIncoming(10, 10, n.edge);
        break;
      }
    }
    const flow    = computeRiverFlow(map, EDGE_DIRS);
    const water   = buildRiverGeometry(map, layout, bounds, { riverFlow: flow })!;
    const terrain = buildChunkGeometry(map, layout, bounds, { riverFlow: flow }).terrain;

    const failures: string[] = [];
    map.forEach((col, row) => {
      if (!map.hasRiver(col, row)) return;
      const hex    = offsetToHex(col, row);
      const center = hexToWorld(layout, hex);
      const crns   = hexCorners(layout, hex);
      const ry     = RIVER_SURFACE_ELEVATION_OFFSET * 0.5;
      const cn     = sampleNoise(center.x * 0.35, center.z * 0.35);
      const ownY   = (cn[1] * 2 - 1) * 0.2;

      for (let e = 0; e < 6; e++) {
        if (!map.hasRiverThroughEdge(col, row, e)) continue;
        const e1  = (e + 1) % 6;
        const hw  = RIVER_BASE_HALF_WIDTH * riverWidthScale(riverEdgeFlow(map, flow, col, row, e, EDGE_DIRS));

        for (const t of [0.5 - hw, 0.5 + hw]) {
          // Water channel edge vertex on the full hex edge.
          const wx = crns[e].x + (crns[e1].x - crns[e].x) * t;
          const wz = crns[e].z + (crns[e1].z - crns[e].z) * t;
          const [wdx, wdz] = perturb(wx, wz);
          if (!hasVertex(water, wx + wdx, ry, wz + wdz)) {
            failures.push(`water (${col},${row}) edge ${e} t=${t.toFixed(3)}`);
          }
          // Terrain groove shoulder on the SOLID_FACTOR ring.
          const a  = { x: center.x + (crns[e].x  - center.x) * 0.8, z: center.z + (crns[e].z  - center.z) * 0.8 };
          const b  = { x: center.x + (crns[e1].x - center.x) * 0.8, z: center.z + (crns[e1].z - center.z) * 0.8 };
          const tx = a.x + (b.x - a.x) * t, tz = a.z + (b.z - a.z) * t;
          const [tdx, tdz] = perturb(tx, tz);
          if (!hasVertex(terrain, tx + tdx, ownY, tz + tdz)) {
            failures.push(`terrain (${col},${row}) edge ${e} t=${t.toFixed(3)}`);
          }
        }
      }
    });
    expect(failures).toEqual([]);
  });

  it('junction cells render a connected pool: mouth sectors covered, mouth bed strip carved', () => {
    const map = new HexMap({ width: 24, height: 24 });
    paintEastRiver(map, 10, 2, 20);
    for (let e = 0; e < 6; e++) {
      const n = map.roadEdgeNeighbor(10, 9, e, POINTY_TOP);
      if (n && n.col === 10 && n.row === 10) {
        map.setRiverOutgoing(10, 9, e);
        map.setRiverIncoming(10, 10, n.edge);
        break;
      }
    }
    const flow    = computeRiverFlow(map, EDGE_DIRS);
    const water   = buildRiverGeometry(map, layout, bounds, { riverFlow: flow })!;
    const terrain = buildChunkGeometry(map, layout, bounds, { riverFlow: flow }).terrain;

    const col = 10, row = 10;
    const cellW  = riverWidthScale(flow.get(row * 24 + col)!);
    const hex    = offsetToHex(col, row);
    const center = hexToWorld(layout, hex);
    const crns   = hexCorners(layout, hex);
    const out    = map.getOutgoingRiverDir(col, row);
    const o1     = (out + 1) % 6;
    const bI = {
      x: center.x + (crns[out].x - center.x) * 0.8 * 0.4 * cellW,
      z: center.z + (crns[out].z - center.z) * 0.8 * 0.4 * cellW,
    };
    const bJ = {
      x: center.x + (crns[o1].x - center.x) * 0.8 * 0.4 * cellW,
      z: center.z + (crns[o1].z - center.z) * 0.8 * 0.4 * cellW,
    };
    const ry = RIVER_SURFACE_ELEVATION_OFFSET * 0.5;

    // WATER: the outgoing mouth sector (center → cL–cR chord) must be a real
    // triangle in the mesh — this was the hole at every confluence.
    const [cdx, cdz] = perturb(center.x, center.z);
    const [ldx, ldz] = perturb(bI.x, bI.z);
    const [rdx, rdz] = perturb(bJ.x, bJ.z);
    const pos = water.getAttribute('position');
    const idx = water.getIndex()!;
    let mouthCovered = false;
    for (let k = 0; k + 2 < idx.count; k += 3) {
      const match = (i: number, x: number, z: number) =>
        Math.abs(pos.getX(i) - x) < 1e-4 && Math.abs(pos.getY(i) - ry) < 1e-4 && Math.abs(pos.getZ(i) - z) < 1e-4;
      if (match(idx.getX(k), center.x + cdx, center.z + cdz)
        && match(idx.getX(k + 1), bI.x + ldx, bI.z + ldz)
        && match(idx.getX(k + 2), bJ.x + rdx, bJ.z + rdz)) { mouthCovered = true; break; }
    }
    expect(mouthCovered).toBe(true);

    // TERRAIN: the mouth chord must carry a bed-depth STRIP (cL2/cR2), not a
    // single point — a converging V left walls above the waterline across the
    // mouth, pinching the channel to a slit where it met the pool.
    const bedY = STREAM_BED_ELEVATION_OFFSET * 0.5;
    for (const t of [0.15, 0.85]) {
      const x = bI.x + (bJ.x - bI.x) * t;
      const z = bI.z + (bJ.z - bI.z) * t;
      const [dx, dz] = perturb(x, z);
      expect(hasVertex(terrain, x + dx, bedY, z + dz)).toBe(true);
    }
  });

  it('water channel and carved bed widen in lockstep at a downstream edge', () => {
    const map = new HexMap({ width: 24, height: 24 });
    paintEastRiver(map, 10, 2, 20);
    const flow = computeRiverFlow(map, EDGE_DIRS);

    const col = 17, row = 10;
    const hw = RIVER_BASE_HALF_WIDTH
      * riverWidthScale(riverEdgeFlow(map, flow, col, row, eastEdge, EDGE_DIRS));
    expect(hw).toBeGreaterThan(RIVER_BASE_HALF_WIDTH + 0.01); // actually widened

    const hex    = offsetToHex(col, row);
    const center = hexToWorld(layout, hex);
    const crns   = hexCorners(layout, hex);
    const i  = eastEdge, i1 = (eastEdge + 1) % 6;

    // WATER: channel edge vertex eL at t = 0.5 − hw along the full hex edge,
    // at river surface height, with the shared XZ perturbation applied.
    const ry  = RIVER_SURFACE_ELEVATION_OFFSET * 0.5; // elevation 0 cells
    const eLx = crns[i].x + (crns[i1].x - crns[i].x) * (0.5 - hw);
    const eLz = crns[i].z + (crns[i1].z - crns[i].z) * (0.5 - hw);
    const [wdx, wdz] = perturb(eLx, eLz);
    const water = buildRiverGeometry(map, layout, bounds, { riverFlow: flow })!;
    expect(hasVertex(water, eLx + wdx, ry, eLz + wdz)).toBe(true);

    // TERRAIN: groove shoulder e2 at the same t on the SOLID_FACTOR inner
    // ring, at the cell's (noise-perturbed) surface height.
    const e1x = center.x + (crns[i].x  - center.x) * 0.8;
    const e1z = center.z + (crns[i].z  - center.z) * 0.8;
    const e5x = center.x + (crns[i1].x - center.x) * 0.8;
    const e5z = center.z + (crns[i1].z - center.z) * 0.8;
    const e2x = e1x + (e5x - e1x) * (0.5 - hw);
    const e2z = e1z + (e5z - e1z) * (0.5 - hw);
    const cn  = sampleNoise(center.x * 0.35, center.z * 0.35);
    const ownY = (cn[1] * 2 - 1) * 0.2; // elevation 0 + elevPerturb
    const [tdx, tdz] = perturb(e2x, e2z);
    const terrain = buildChunkGeometry(map, layout, bounds, { riverFlow: flow }).terrain;
    expect(hasVertex(terrain, e2x + tdx, ownY, e2z + tdz)).toBe(true);

    // And neither vertex exists in the fixed-width build (they sit at t=0.25 there).
    const waterFixed   = buildRiverGeometry(map, layout, bounds, {})!;
    const terrainFixed = buildChunkGeometry(map, layout, bounds, {}).terrain;
    expect(hasVertex(waterFixed, eLx + wdx, ry, eLz + wdz)).toBe(false);
    expect(hasVertex(terrainFixed, e2x + tdx, ownY, e2z + tdz)).toBe(false);
  });
});
