import * as THREE from 'three';
import type { HexLayout } from '../math/HexLayout.js';
import { hexToWorld, hexCorners } from '../math/HexLayout.js';
import { HEX_DIRECTIONS } from '../math/HexCoord.js';
import type { HexMap } from '../map/HexMap.js';
import { TerrainType, STREAM_BED_ELEVATION_OFFSET } from '../map/HexCell.js';
import { sampleNoise } from '../math/Noise.js';

export const TERRAIN_COLORS: Record<TerrainType, THREE.Color> = {
  [TerrainType.Grassland]: new THREE.Color(0x4caf50),
  [TerrainType.Desert]:    new THREE.Color(0xe8d44d),
  [TerrainType.Snow]:      new THREE.Color(0xeceff1),
  [TerrainType.Mud]:       new THREE.Color(0x795548),
  [TerrainType.Rock]:      new THREE.Color(0x9e9e9e),
  [TerrainType.Water]:     new THREE.Color(0x1565c0),
};

export interface ChunkBounds {
  colStart: number;
  colEnd: number;
  rowStart: number;
  rowEnd: number;
}

export interface ChunkGeometryOptions {
  /** World units per elevation step. Default 0.5. */
  elevationScale?: number;
  /** XZ vertex jitter strength. Default 0.25. */
  perturbStrength?: number;
  /** Per-cell Y noise offset strength. Default 0.15. */
  elevPerturbStrength?: number;
  /** Noise sampling scale (world units → noise coords). Default 0.03. */
  noiseScale?: number;
  /** Minimum elevation difference (in steps) to draw a cliff wall. Default 2. */
  cliffThreshold?: number;
  /**
   * Debug: colour each geometry region by type instead of terrain colour.
   *   grey  = solid hex core
   *   blue  = flat bridge (et 0)
   *   green = terrace bridge (et 1)
   *   red   = cliff bridge (et 2)
   *   yellow = corner triangles
   */
  debugColors?: boolean;
}

// Part 2 / Part 4
const SOLID_FACTOR  = 0.8;
const BLEND_FACTOR  = 1 - SOLID_FACTOR;
const INNER_TO_OUTER = 1 / 0.866025404; // reciprocal of sin(60°), used for gentle river curves

// Part 3 terraces
const TERRACES_PER_SLOPE = 2;
const TERRACE_STEPS      = TERRACES_PER_SLOPE * 2 + 1; // 5
const H_STEP             = 1 / TERRACE_STEPS;
const V_STEP             = 1 / (TERRACES_PER_SLOPE + 1);

// 0=Flat, 1=Slope, 2=Cliff
function getEdgeType(e1: number, e2: number): number {
  const d = Math.abs(e1 - e2);
  if (d === 0) return 0;
  if (d === 1) return 1;
  return 2;
}

function nbOffset(col: number, row: number, d: number): { col: number; row: number } {
  const q  = col - (row - (row & 1)) / 2;
  const nq = q + HEX_DIRECTIONS[d].q;
  const nr = row + HEX_DIRECTIONS[d].r;
  return { col: nq + (nr - (nr & 1)) / 2, row: nr };
}

// [x, y, z, elevation, r, g, b]
type CV = [number, number, number, number, number, number, number];

export function buildChunkGeometry(
  map: HexMap,
  layout: HexLayout,
  bounds: ChunkBounds,
  opts: ChunkGeometryOptions = {},
): THREE.BufferGeometry {
  const elevScale           = opts.elevationScale      ?? 0.5;
  const perturbStrength     = opts.perturbStrength      ?? 0.8;
  const elevPerturbStrength = opts.elevPerturbStrength  ?? 0.2;
  const noiseScale          = opts.noiseScale           ?? 0.35;
  const dbg                 = opts.debugColors          ?? false;
  const edgeDirs  = layout.orientation.edgeDirections;
  const { colStart, colEnd, rowStart, rowEnd } = bounds;
  const hexCount  = (colEnd - colStart) * (rowEnd - rowStart);

  // river solid ~222 + bridges terraced ~720 + corners ~150 + margin
  const maxVerts  = hexCount * 1400;
  const positions = new Float32Array(maxVerts * 3);
  const colors    = new Float32Array(maxVerts * 3);
  let vi = 0;

  // ---- perturbation ----

  const perturb = (x: number, z: number): [number, number] => {
    const n = sampleNoise(x * noiseScale, z * noiseScale);
    return [(n[0] * 2 - 1) * perturbStrength, (n[2] * 2 - 1) * perturbStrength];
  };

  const cellElevY = (c: number, r: number): number => {
    const qq = c - (r - (r & 1)) / 2;
    const wc = hexToWorld(layout, { q: qq, r });
    const n  = sampleNoise(wc.x * noiseScale, wc.z * noiseScale);
    return map.getElevation(c, r) * elevScale + (n[1] * 2 - 1) * elevPerturbStrength;
  };

  // Stream bed sits at a fixed offset below elevation — no noise perturbation so
  // the channel floor is consistent across both sides of every edge.
  const streamBedY = (c: number, r: number): number =>
    (map.getElevation(c, r) + STREAM_BED_ELEVATION_OFFSET) * elevScale;

  // ---- vertex emitters ----

  const addVert = (x: number, y: number, z: number, r: number, g: number, b: number) => {
    const [dx, dz] = perturb(x, z);
    positions[vi] = x + dx; positions[vi+1] = y; positions[vi+2] = z + dz;
    colors[vi]    = r; colors[vi+1]    = g; colors[vi+2]    = b;
    vi += 3;
  };

  // Boundary vertices (cliff intersections) skip XZ perturbation
  const addVertRaw = (x: number, y: number, z: number, r: number, g: number, b: number) => {
    positions[vi] = x; positions[vi+1] = y; positions[vi+2] = z;
    colors[vi]    = r; colors[vi+1]    = g; colors[vi+2]    = b;
    vi += 3;
  };

  const addTri = (
    x0: number, y0: number, z0: number, r0: number, g0: number, b0: number,
    x1: number, y1: number, z1: number, r1: number, g1: number, b1: number,
    x2: number, y2: number, z2: number, r2: number, g2: number, b2: number,
  ) => {
    addVert(x0, y0, z0, r0, g0, b0);
    addVert(x1, y1, z1, r1, g1, b1);
    addVert(x2, y2, z2, r2, g2, b2);
  };

  // Tutorial winding: (v1,v3,v2),(v2,v3,v4) → normals face up
  const addQuad = (
    x0: number, y0: number, z0: number, r0: number, g0: number, b0: number,
    x1: number, y1: number, z1: number, r1: number, g1: number, b1: number,
    x2: number, y2: number, z2: number, r2: number, g2: number, b2: number,
    x3: number, y3: number, z3: number, r3: number, g3: number, b3: number,
  ) => {
    addVert(x0, y0, z0, r0, g0, b0);
    addVert(x2, y2, z2, r2, g2, b2);
    addVert(x1, y1, z1, r1, g1, b1);
    addVert(x1, y1, z1, r1, g1, b1);
    addVert(x2, y2, z2, r2, g2, b2);
    addVert(x3, y3, z3, r3, g3, b3);
  };

  // ---- terrace lerp helpers ----

  const tlPos = (a: CV, b: CV, step: number): [number, number, number] => {
    const h = step * H_STEP;
    const v = Math.floor((step + 1) / 2) * V_STEP;
    return [a[0] + (b[0] - a[0]) * h, a[1] + (b[1] - a[1]) * v, a[2] + (b[2] - a[2]) * h];
  };

  const tlCol = (a: CV, b: CV, step: number): [number, number, number] => {
    const h = step * H_STEP;
    return [a[4] + (b[4] - a[4]) * h, a[5] + (b[5] - a[5]) * h, a[6] + (b[6] - a[6]) * h];
  };

  // ---- Part 3 corner sub-cases ----

  // Terraced fan converging on a cliff boundary point.
  // boundary uses addVertRaw per tutorial AddTriangleUnperturbed.
  const triangulateBoundaryTriangle = (
    begin: CV, left: CV,
    bx: number, by: number, bz: number, br: number, bg: number, bb: number,
  ) => {
    let [p1x, p1y, p1z] = tlPos(begin, left, 1);
    let [p1r, p1g, p1b] = tlCol(begin, left, 1);
    addVert(begin[0], begin[1], begin[2], begin[4], begin[5], begin[6]);
    addVert(p1x, p1y, p1z, p1r, p1g, p1b);
    addVertRaw(bx, by, bz, br, bg, bb);

    for (let i = 2; i < TERRACE_STEPS; i++) {
      const [q1x, q1y, q1z] = tlPos(begin, left, i);
      const [q1r, q1g, q1b] = tlCol(begin, left, i);
      addVert(p1x, p1y, p1z, p1r, p1g, p1b);
      addVert(q1x, q1y, q1z, q1r, q1g, q1b);
      addVertRaw(bx, by, bz, br, bg, bb);
      p1x = q1x; p1y = q1y; p1z = q1z; p1r = q1r; p1g = q1g; p1b = q1b;
    }

    addVert(p1x, p1y, p1z, p1r, p1g, p1b);
    addVert(left[0], left[1], left[2], left[4], left[5], left[6]);
    addVertRaw(bx, by, bz, br, bg, bb);
  };

  // SSF / SFS / FSS
  const triangulateCornerTerraces = (begin: CV, left: CV, right: CV) => {
    let [v3x, v3y, v3z] = tlPos(begin, left,  1);
    let [v3r, v3g, v3b] = tlCol(begin, left,  1);
    let [v4x, v4y, v4z] = tlPos(begin, right, 1);
    let [v4r, v4g, v4b] = tlCol(begin, right, 1);

    addTri(begin[0], begin[1], begin[2], begin[4], begin[5], begin[6],
           v3x, v3y, v3z, v3r, v3g, v3b,
           v4x, v4y, v4z, v4r, v4g, v4b);

    for (let i = 2; i < TERRACE_STEPS; i++) {
      const v1x = v3x, v1y = v3y, v1z = v3z, v1r = v3r, v1g = v3g, v1b = v3b;
      const v2x = v4x, v2y = v4y, v2z = v4z, v2r = v4r, v2g = v4g, v2b = v4b;
      [v3x, v3y, v3z] = tlPos(begin, left,  i);
      [v3r, v3g, v3b] = tlCol(begin, left,  i);
      [v4x, v4y, v4z] = tlPos(begin, right, i);
      [v4r, v4g, v4b] = tlCol(begin, right, i);
      addQuad(v1x, v1y, v1z, v1r, v1g, v1b,
              v2x, v2y, v2z, v2r, v2g, v2b,
              v3x, v3y, v3z, v3r, v3g, v3b,
              v4x, v4y, v4z, v4r, v4g, v4b);
    }

    addQuad(v3x, v3y, v3z, v3r, v3g, v3b,
            v4x, v4y, v4z, v4r, v4g, v4b,
            left[0],  left[1],  left[2],  left[4],  left[5],  left[6],
            right[0], right[1], right[2], right[4], right[5], right[6]);
  };

  // SCC — left=slope, right=cliff
  const triangulateCornerTerracesCliff = (begin: CV, left: CV, right: CV) => {
    const b  = Math.abs(1 / (right[3] - begin[3]));
    // Perturb begin and right before interpolating so boundary lies on the actual cliff face
    const [bdx, bdz] = perturb(begin[0], begin[2]);
    const [rdx, rdz] = perturb(right[0], right[2]);
    const bx = (begin[0] + bdx) + ((right[0] + rdx) - (begin[0] + bdx)) * b;
    const by = begin[1] + (right[1] - begin[1]) * b;
    const bz = (begin[2] + bdz) + ((right[2] + rdz) - (begin[2] + bdz)) * b;
    const br = begin[4] + (right[4] - begin[4]) * b;
    const bg = begin[5] + (right[5] - begin[5]) * b;
    const bb = begin[6] + (right[6] - begin[6]) * b;
    triangulateBoundaryTriangle(begin, left, bx, by, bz, br, bg, bb);
    if (getEdgeType(left[3], right[3]) === 1) {
      triangulateBoundaryTriangle(left, right, bx, by, bz, br, bg, bb);
    } else {
      addVert(left[0],  left[1],  left[2],  left[4],  left[5],  left[6]);
      addVert(right[0], right[1], right[2], right[4], right[5], right[6]);
      addVertRaw(bx, by, bz, br, bg, bb);
    }
  };

  // CSS — right=slope, left=cliff
  const triangulateCornerCliffTerraces = (begin: CV, left: CV, right: CV) => {
    const b  = Math.abs(1 / (left[3] - begin[3]));
    // Perturb begin and left before interpolating so boundary lies on the actual cliff face
    const [bdx, bdz] = perturb(begin[0], begin[2]);
    const [ldx, ldz] = perturb(left[0], left[2]);
    const bx = (begin[0] + bdx) + ((left[0] + ldx) - (begin[0] + bdx)) * b;
    const by = begin[1] + (left[1] - begin[1]) * b;
    const bz = (begin[2] + bdz) + ((left[2] + ldz) - (begin[2] + bdz)) * b;
    const br = begin[4] + (left[4] - begin[4]) * b;
    const bg = begin[5] + (left[5] - begin[5]) * b;
    const bb = begin[6] + (left[6] - begin[6]) * b;
    triangulateBoundaryTriangle(right, begin, bx, by, bz, br, bg, bb);
    if (getEdgeType(left[3], right[3]) === 1) {
      triangulateBoundaryTriangle(left, right, bx, by, bz, br, bg, bb);
    } else {
      addVert(left[0],  left[1],  left[2],  left[4],  left[5],  left[6]);
      addVert(right[0], right[1], right[2], right[4], right[5], right[6]);
      addVertRaw(bx, by, bz, br, bg, bb);
    }
  };

  const triangulateCorner = (bottom: CV, left: CV, right: CV) => {
    const le = getEdgeType(bottom[3], left[3]);
    const re = getEdgeType(bottom[3], right[3]);

    if (le === 1) {
      if      (re === 1) triangulateCornerTerraces(bottom, left, right);
      else if (re === 0) triangulateCornerTerraces(left, right, bottom);
      else               triangulateCornerTerracesCliff(bottom, left, right);
    } else if (re === 1) {
      if      (le === 0) triangulateCornerTerraces(right, bottom, left);
      else               triangulateCornerCliffTerraces(bottom, left, right);
    } else if (getEdgeType(left[3], right[3]) === 1) {
      if (left[3] < right[3]) triangulateCornerCliffTerraces(right, bottom, left);
      else                    triangulateCornerTerracesCliff(left, right, bottom);
    } else {
      addTri(bottom[0], bottom[1], bottom[2], bottom[4], bottom[5], bottom[6],
             left[0],   left[1],   left[2],   left[4],   left[5],   left[6],
             right[0],  right[1],  right[2],  right[4],  right[5],  right[6]);
    }
  };

  // ---- Part 4 edge strips ----

  // Flat or cliff: 4 quads with a center vertex that can be depressed for a river channel.
  // ownBedY / nbBedY default to ownY / nbY (no depression) when no river present.
  const addBridgeEdgeStrip = (
    ie1x: number, ie1z: number,
    ie5x: number, ie5z: number,
    bx: number, bz: number,
    ownY: number, nbY: number,
    or: number, og: number, ob: number,
    nr: number, ng: number, nb2: number,
    ownBedY = ownY, nbBedY = nbY,
  ) => {
    const ie2x = ie1x + (ie5x - ie1x) * 0.25, ie2z = ie1z + (ie5z - ie1z) * 0.25;
    const ie3x = ie1x + (ie5x - ie1x) * 0.50, ie3z = ie1z + (ie5z - ie1z) * 0.50;
    const ie4x = ie1x + (ie5x - ie1x) * 0.75, ie4z = ie1z + (ie5z - ie1z) * 0.75;
    const oe1x = ie1x + bx, oe1z = ie1z + bz;
    const oe2x = ie2x + bx, oe2z = ie2z + bz;
    const oe3x = ie3x + bx, oe3z = ie3z + bz;
    const oe4x = ie4x + bx, oe4z = ie4z + bz;
    const oe5x = ie5x + bx, oe5z = ie5z + bz;
    addQuad(ie1x, ownY,    ie1z, or, og, ob,  ie2x, ownY,    ie2z, or, og, ob,
            oe1x, nbY,     oe1z, nr, ng, nb2, oe2x, nbY,     oe2z, nr, ng, nb2);
    addQuad(ie2x, ownY,    ie2z, or, og, ob,  ie3x, ownBedY, ie3z, or, og, ob,
            oe2x, nbY,     oe2z, nr, ng, nb2, oe3x, nbBedY,  oe3z, nr, ng, nb2);
    addQuad(ie3x, ownBedY, ie3z, or, og, ob,  ie4x, ownY,    ie4z, or, og, ob,
            oe3x, nbBedY,  oe3z, nr, ng, nb2, oe4x, nbY,     oe4z, nr, ng, nb2);
    addQuad(ie4x, ownY,    ie4z, or, og, ob,  ie5x, ownY,    ie5z, or, og, ob,
            oe4x, nbY,     oe4z, nr, ng, nb2, oe5x, nbY,     oe5z, nr, ng, nb2);
  };

  // Slope: 5 terrace steps × 4 quads = 20 quads.
  // Pass lower-elevation edge first; (bx,bz) points toward higher elevation.
  // lowerBedY / upperBedY optionally depress the center column for a river channel.
  const addTerraceEdgeStrip = (
    ie1x: number, ie1z: number,
    ie5x: number, ie5z: number,
    bx: number, bz: number,
    lowerY: number, upperY: number,
    lr: number, lg: number, lb: number,
    ur: number, ug: number, ub: number,
    lowerBedY = lowerY, upperBedY = upperY,
  ) => {
    const ie2x = ie1x + (ie5x - ie1x) * 0.25, ie2z = ie1z + (ie5z - ie1z) * 0.25;
    const ie3x = ie1x + (ie5x - ie1x) * 0.50, ie3z = ie1z + (ie5z - ie1z) * 0.50;
    const ie4x = ie1x + (ie5x - ie1x) * 0.75, ie4z = ie1z + (ie5z - ie1z) * 0.75;

    let p1x = ie1x, p1z = ie1z;
    let p2x = ie2x, p2z = ie2z;
    let p3x = ie3x, p3z = ie3z;
    let p4x = ie4x, p4z = ie4z;
    let p5x = ie5x, p5z = ie5z;
    let py = lowerY, p3y = lowerBedY, pr = lr, pg = lg, pb = lb;

    for (let step = 1; step <= TERRACE_STEPS; step++) {
      const h   = step * H_STEP;
      const v   = Math.floor((step + 1) / 2) * V_STEP;
      const ny  = lowerY  + (upperY  - lowerY)  * v;
      const n3y = lowerBedY + (upperBedY - lowerBedY) * v;
      const ncr = lr + (ur - lr) * h, ncg = lg + (ug - lg) * h, ncb = lb + (ub - lb) * h;
      const n1x = ie1x + bx * h, n1z = ie1z + bz * h;
      const n2x = ie2x + bx * h, n2z = ie2z + bz * h;
      const n3x = ie3x + bx * h, n3z = ie3z + bz * h;
      const n4x = ie4x + bx * h, n4z = ie4z + bz * h;
      const n5x = ie5x + bx * h, n5z = ie5z + bz * h;
      addQuad(p1x, py,  p1z, pr, pg, pb,  p2x, py,  p2z, pr, pg, pb,
              n1x, ny,  n1z, ncr, ncg, ncb, n2x, ny,  n2z, ncr, ncg, ncb);
      addQuad(p2x, py,  p2z, pr, pg, pb,  p3x, p3y, p3z, pr, pg, pb,
              n2x, ny,  n2z, ncr, ncg, ncb, n3x, n3y, n3z, ncr, ncg, ncb);
      addQuad(p3x, p3y, p3z, pr, pg, pb,  p4x, py,  p4z, pr, pg, pb,
              n3x, n3y, n3z, ncr, ncg, ncb, n4x, ny,  n4z, ncr, ncg, ncb);
      addQuad(p4x, py,  p4z, pr, pg, pb,  p5x, py,  p5z, pr, pg, pb,
              n4x, ny,  n4z, ncr, ncg, ncb, n5x, ny,  n5z, ncr, ncg, ncb);
      p1x = n1x; p1z = n1z;
      p2x = n2x; p2z = n2z;
      p3x = n3x; p3z = n3z;
      p4x = n4x; p4z = n4z;
      p5x = n5x; p5z = n5z;
      py = ny; p3y = n3y; pr = ncr; pg = ncg; pb = ncb;
    }
  };


  // ---- main loop ----

  for (let row = rowStart; row < rowEnd; row++) {
    for (let col = colStart; col < colEnd; col++) {
      if (!map.inBounds(col, row)) continue;

      const ownElev = map.getElevation(col, row);
      const ownY    = cellElevY(col, row);
      const own     = TERRAIN_COLORS[map.getTerrain(col, row)];
      const or = own.r, og = own.g, ob = own.b;

      const q      = col - (row - (row & 1)) / 2;
      const center = hexToWorld(layout, { q, r: row });
      const crns   = hexCorners(layout, { q, r: row });

      const ox = crns.map(c => c.x - center.x);
      const oz = crns.map(c => c.z - center.z);

      // debug: grey solid core
      const sr = dbg ? 0.55 : or, sg = dbg ? 0.55 : og, sb = dbg ? 0.55 : ob;

      // 1. Solid core — per-direction dispatch (EdgeFan or river channel geometry)
      const ownBedY      = streamBedY(col, row);
      const hasRiverCell = map.hasRiver(col, row);

      for (let i = 0; i < 6; i++) {
        const i1  = (i + 1) % 6;
        const e1x = center.x + ox[i]  * SOLID_FACTOR, e1z = center.z + oz[i]  * SOLID_FACTOR;
        const e5x = center.x + ox[i1] * SOLID_FACTOR, e5z = center.z + oz[i1] * SOLID_FACTOR;
        const e2x = e1x + (e5x - e1x) * 0.25, e2z = e1z + (e5z - e1z) * 0.25;
        const e3x = (e1x + e5x) * 0.5,         e3z = (e1z + e5z) * 0.5;
        const e4x = e5x - (e5x - e1x) * 0.25,  e4z = e5z - (e5z - e1z) * 0.25;

        if (!hasRiverCell) {
          // Normal 4-triangle fan
          addTri(center.x, ownY, center.z, sr,sg,sb, e1x, ownY, e1z, sr,sg,sb, e2x, ownY, e2z, sr,sg,sb);
          addTri(center.x, ownY, center.z, sr,sg,sb, e2x, ownY, e2z, sr,sg,sb, e3x, ownY, e3z, sr,sg,sb);
          addTri(center.x, ownY, center.z, sr,sg,sb, e3x, ownY, e3z, sr,sg,sb, e4x, ownY, e4z, sr,sg,sb);
          addTri(center.x, ownY, center.z, sr,sg,sb, e4x, ownY, e4z, sr,sg,sb, e5x, ownY, e5z, sr,sg,sb);

        } else if (!map.hasRiverThroughEdge(col, row, i)) {
          // ---- Adjacent to river: match the center used by river directions ----
          const in1 = i1, ip = (i + 5) % 6, ip2 = (i + 4) % 6, in2 = (i + 2) % 6;
          let adjCx = center.x, adjCz = center.z;
          if (map.hasRiverThroughEdge(col, row, in1)) {
            if (map.hasRiverThroughEdge(col, row, ip)) {
              // inside of a curve — push toward solid edge middle
              adjCx += (ox[i] + ox[i1]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER;
              adjCz += (oz[i] + oz[i1]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER;
            } else if (map.hasRiverThroughEdge(col, row, ip2)) {
              // straight river, first-corner side
              adjCx += ox[i]  * SOLID_FACTOR * 0.25;
              adjCz += oz[i]  * SOLID_FACTOR * 0.25;
            }
          } else if (map.hasRiverThroughEdge(col, row, ip) && map.hasRiverThroughEdge(col, row, in2)) {
            // straight river, second-corner side
            adjCx += ox[i1] * SOLID_FACTOR * 0.25;
            adjCz += oz[i1] * SOLID_FACTOR * 0.25;
          }
          const m1x = (adjCx + e1x) * 0.5, m1z = (adjCz + e1z) * 0.5;
          const m5x = (adjCx + e5x) * 0.5, m5z = (adjCz + e5z) * 0.5;
          const m2x = m1x + (m5x - m1x) * 0.25, m2z = m1z + (m5z - m1z) * 0.25;
          const m3x = (m1x + m5x) * 0.5,         m3z = (m1z + m5z) * 0.5;
          const m4x = m5x - (m5x - m1x) * 0.25,  m4z = m5z - (m5z - m1z) * 0.25;
          // strip m → e (all at ownY, no channel)
          addQuad(m1x,ownY,m1z,sr,sg,sb, m2x,ownY,m2z,sr,sg,sb, e1x,ownY,e1z,sr,sg,sb, e2x,ownY,e2z,sr,sg,sb);
          addQuad(m2x,ownY,m2z,sr,sg,sb, m3x,ownY,m3z,sr,sg,sb, e2x,ownY,e2z,sr,sg,sb, e3x,ownY,e3z,sr,sg,sb);
          addQuad(m3x,ownY,m3z,sr,sg,sb, m4x,ownY,m4z,sr,sg,sb, e3x,ownY,e3z,sr,sg,sb, e4x,ownY,e4z,sr,sg,sb);
          addQuad(m4x,ownY,m4z,sr,sg,sb, m5x,ownY,m5z,sr,sg,sb, e4x,ownY,e4z,sr,sg,sb, e5x,ownY,e5z,sr,sg,sb);
          // fan adjCenter → m
          addTri(adjCx,ownY,adjCz,sr,sg,sb, m1x,ownY,m1z,sr,sg,sb, m2x,ownY,m2z,sr,sg,sb);
          addTri(adjCx,ownY,adjCz,sr,sg,sb, m2x,ownY,m2z,sr,sg,sb, m3x,ownY,m3z,sr,sg,sb);
          addTri(adjCx,ownY,adjCz,sr,sg,sb, m3x,ownY,m3z,sr,sg,sb, m4x,ownY,m4z,sr,sg,sb);
          addTri(adjCx,ownY,adjCz,sr,sg,sb, m4x,ownY,m4z,sr,sg,sb, m5x,ownY,m5z,sr,sg,sb);

        } else if (map.hasRiverBeginOrEnd(col, row)) {
          // ---- River begins or ends here — channel pinches to center ----
          const e3y = ownBedY;
          const m1x = (center.x + e1x) * 0.5, m1z = (center.z + e1z) * 0.5;
          const m5x = (center.x + e5x) * 0.5, m5z = (center.z + e5z) * 0.5;
          const m2x = m1x + (m5x - m1x) * 0.25, m2z = m1z + (m5z - m1z) * 0.25;
          const m3x = (m1x + m5x) * 0.5, m3y = e3y, m3z = (m1z + m5z) * 0.5;
          const m4x = m5x - (m5x - m1x) * 0.25, m4z = m5z - (m5z - m1z) * 0.25;
          // strip m → e (channel at v3)
          addQuad(m1x,ownY,m1z,sr,sg,sb, m2x,ownY,m2z,sr,sg,sb, e1x,ownY,e1z,sr,sg,sb, e2x,ownY,e2z,sr,sg,sb);
          addQuad(m2x,ownY,m2z,sr,sg,sb, m3x,m3y,m3z,sr,sg,sb, e2x,ownY,e2z,sr,sg,sb, e3x,e3y,e3z,sr,sg,sb);
          addQuad(m3x,m3y,m3z,sr,sg,sb, m4x,ownY,m4z,sr,sg,sb, e3x,e3y,e3z,sr,sg,sb, e4x,ownY,e4z,sr,sg,sb);
          addQuad(m4x,ownY,m4z,sr,sg,sb, m5x,ownY,m5z,sr,sg,sb, e4x,ownY,e4z,sr,sg,sb, e5x,ownY,e5z,sr,sg,sb);
          // fan center → m (center stays at ownY, channel is in the strip)
          addTri(center.x,ownY,center.z,sr,sg,sb, m1x,ownY,m1z,sr,sg,sb, m2x,ownY,m2z,sr,sg,sb);
          addTri(center.x,ownY,center.z,sr,sg,sb, m2x,ownY,m2z,sr,sg,sb, m3x,m3y,m3z,sr,sg,sb);
          addTri(center.x,ownY,center.z,sr,sg,sb, m3x,m3y,m3z,sr,sg,sb, m4x,ownY,m4z,sr,sg,sb);
          addTri(center.x,ownY,center.z,sr,sg,sb, m4x,ownY,m4z,sr,sg,sb, m5x,ownY,m5z,sr,sg,sb);

        } else {
          // ---- River flows through: 5 cases for straight / turns / curves ----
          const ip = (i + 5) % 6, in1 = i1, in2 = (i + 2) % 6;
          let cLx: number, cLz: number, cRx: number, cRz: number;

          if (map.hasRiverThroughEdge(col, row, (i + 3) % 6)) {
            // straight — opposite edge also has river
            cLx = center.x + ox[ip]  * SOLID_FACTOR * 0.25;
            cLz = center.z + oz[ip]  * SOLID_FACTOR * 0.25;
            cRx = center.x + ox[in2] * SOLID_FACTOR * 0.25;
            cRz = center.z + oz[in2] * SOLID_FACTOR * 0.25;
          } else if (map.hasRiverThroughEdge(col, row, in1)) {
            // sharp turn toward next edge
            cLx = center.x; cLz = center.z;
            cRx = center.x + ox[i1] * SOLID_FACTOR * (2 / 3);
            cRz = center.z + oz[i1] * SOLID_FACTOR * (2 / 3);
          } else if (map.hasRiverThroughEdge(col, row, ip)) {
            // sharp turn toward previous edge
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

          const ccx = (cLx + cRx) * 0.5, ccy = ownBedY, ccz = (cLz + cRz) * 0.5;
          const e3y = ownBedY;

          // middle edge with 1/6 outer step to avoid pinching at the center line
          const m1x = (cLx + e1x) * 0.5, m1z = (cLz + e1z) * 0.5;
          const m5x = (cRx + e5x) * 0.5, m5z = (cRz + e5z) * 0.5;
          const m2x = m1x + (m5x - m1x) / 6, m2z = m1z + (m5z - m1z) / 6;
          const m3x = (m1x + m5x) * 0.5, m3y = ownBedY, m3z = (m1z + m5z) * 0.5;
          const m4x = m5x - (m5x - m1x) / 6, m4z = m5z - (m5z - m1z) / 6;

          // strip m → e (channel at v3)
          addQuad(m1x,ownY,m1z,sr,sg,sb, m2x,ownY,m2z,sr,sg,sb, e1x,ownY,e1z,sr,sg,sb, e2x,ownY,e2z,sr,sg,sb);
          addQuad(m2x,ownY,m2z,sr,sg,sb, m3x,m3y,m3z,sr,sg,sb, e2x,ownY,e2z,sr,sg,sb, e3x,e3y,e3z,sr,sg,sb);
          addQuad(m3x,m3y,m3z,sr,sg,sb, m4x,ownY,m4z,sr,sg,sb, e3x,e3y,e3z,sr,sg,sb, e4x,ownY,e4z,sr,sg,sb);
          addQuad(m4x,ownY,m4z,sr,sg,sb, m5x,ownY,m5z,sr,sg,sb, e4x,ownY,e4z,sr,sg,sb, e5x,ownY,e5z,sr,sg,sb);
          // trapezoid centerL/R → m (center depressed to stream bed)
          addTri (cLx,ownY,cLz,sr,sg,sb, m1x,ownY,m1z,sr,sg,sb, m2x,ownY,m2z,sr,sg,sb);
          addQuad(cLx,ownY,cLz,sr,sg,sb, ccx,ccy,ccz,sr,sg,sb, m2x,ownY,m2z,sr,sg,sb, m3x,m3y,m3z,sr,sg,sb);
          addQuad(ccx,ccy,ccz,sr,sg,sb, cRx,ownY,cRz,sr,sg,sb, m3x,m3y,m3z,sr,sg,sb, m4x,ownY,m4z,sr,sg,sb);
          addTri (cRx,ownY,cRz,sr,sg,sb, m4x,ownY,m4z,sr,sg,sb, m5x,ownY,m5z,sr,sg,sb);
        }
      }

      // 2. Bridges (dirs 0–2) + corners (dirs 0–1)
      for (let i = 0; i < 3; i++) {
        const d  = edgeDirs[i];
        const nb = nbOffset(col, row, d);
        if (!map.inBounds(nb.col, nb.row)) continue;

        const nbElev  = map.getElevation(nb.col, nb.row);
        const nbY     = cellElevY(nb.col, nb.row);
        const nbColor = TERRAIN_COLORS[map.getTerrain(nb.col, nb.row)];
        const nr = nbColor.r, ng = nbColor.g, nb2 = nbColor.b;

        const i1  = (i + 1) % 6;
        const v1x = center.x + ox[i]  * SOLID_FACTOR, v1z = center.z + oz[i]  * SOLID_FACTOR;
        const v2x = center.x + ox[i1] * SOLID_FACTOR, v2z = center.z + oz[i1] * SOLID_FACTOR;
        const bx  = (ox[i] + ox[i1]) * BLEND_FACTOR;
        const bz  = (oz[i] + oz[i1]) * BLEND_FACTOR;
        const v3x = v1x + bx, v3z = v1z + bz;
        const v4x = v2x + bx, v4z = v2z + bz;

        const et = getEdgeType(ownElev, nbElev);

        // debug colours: blue=flat, green=terrace, red=cliff
        const er = dbg ? (et === 0 ? 0.2 : et === 1 ? 0.1 : 1.0) : or;
        const eg = dbg ? (et === 0 ? 0.4 : et === 1 ? 0.9 : 0.1) : og;
        const eb = dbg ? (et === 0 ? 1.0 : et === 1 ? 0.1 : 0.1) : ob;
        const er2 = dbg ? er : nr, eg2 = dbg ? eg : ng, eb2 = dbg ? eb : nb2;

        const riverEdge = map.hasRiverThroughEdge(col, row, i);
        const edgeBedOwn = riverEdge ? streamBedY(col, row)     : ownY;
        const edgeBedNb  = riverEdge ? streamBedY(nb.col, nb.row) : nbY;

        if (et === 1) {
          if (ownElev < nbElev) {
            addTerraceEdgeStrip(v1x, v1z, v2x, v2z,  bx,  bz, ownY, nbY,  er, eg, eb,  er2, eg2, eb2, edgeBedOwn, edgeBedNb);
          } else {
            addTerraceEdgeStrip(v3x, v3z, v4x, v4z, -bx, -bz, nbY,  ownY, er2, eg2, eb2, er, eg, eb, edgeBedNb, edgeBedOwn);
          }
        } else {
          addBridgeEdgeStrip(v1x, v1z, v2x, v2z, bx, bz, ownY, nbY, er, eg, eb, er2, eg2, eb2, edgeBedOwn, edgeBedNb);
        }

        // Corner triangles — dirs 0 and 1 only
        if (i < 2) {
          const nextD  = edgeDirs[i1];
          const nextNb = nbOffset(col, row, nextD);
          if (!map.inBounds(nextNb.col, nextNb.row)) continue;

          const nextNbElev  = map.getElevation(nextNb.col, nextNb.row);
          const nextNbY     = cellElevY(nextNb.col, nextNb.row);
          const nextNbColor = TERRAIN_COLORS[map.getTerrain(nextNb.col, nextNb.row)];
          const nnr = nextNbColor.r, nng = nextNbColor.g, nnb = nextNbColor.b;

          const i2  = (i + 2) % 6;
          const bnx = (ox[i1] + ox[i2]) * BLEND_FACTOR;
          const bnz = (oz[i1] + oz[i2]) * BLEND_FACTOR;
          const v5x = v2x + bnx, v5z = v2z + bnz;

          // debug: yellow corners
          const cr2 = dbg ? 1.0 : or,  cg2 = dbg ? 1.0 : og,  cb2 = dbg ? 0.0 : ob;
          const cr3 = dbg ? 1.0 : nr,  cg3 = dbg ? 1.0 : ng,  cb3 = dbg ? 0.0 : nb2;
          const cr4 = dbg ? 1.0 : nnr, cg4 = dbg ? 1.0 : nng, cb4 = dbg ? 0.0 : nnb;

          const ownCV:    CV = [v2x, ownY,    v2z, ownElev,    cr2, cg2, cb2];
          const nbCV:     CV = [v4x, nbY,     v4z, nbElev,     cr3, cg3, cb3];
          const nextNbCV: CV = [v5x, nextNbY, v5z, nextNbElev, cr4, cg4, cb4];

          if (ownElev <= nbElev) {
            if (ownElev <= nextNbElev) {
              triangulateCorner(ownCV, nbCV, nextNbCV);
            } else {
              triangulateCorner(nextNbCV, ownCV, nbCV);
            }
          } else if (nbElev <= nextNbElev) {
            triangulateCorner(nbCV, nextNbCV, ownCV);
          } else {
            triangulateCorner(nextNbCV, ownCV, nbCV);
          }
        }
      }
    }
  }

  const n   = vi / 3;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, n * 3), 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors.subarray(0, n * 3), 3));
  geo.computeVertexNormals();
  return geo;
}
