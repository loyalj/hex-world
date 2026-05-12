import * as THREE from 'three';
import type { HexLayout } from '../math/HexLayout.js';
import { hexToWorld, hexCorners } from '../math/HexLayout.js';
import { HEX_DIRECTIONS } from '../math/HexCoord.js';
import type { HexMap } from '../map/HexMap.js';
import { TerrainType, STREAM_BED_ELEVATION_OFFSET } from '../map/HexCell.js';
import { sampleNoise } from '../math/Noise.js';

/**
 * Controls what the vertex color buffer contains:
 *   'flat'  — per-terrain RGB (works with MeshPhongMaterial vertexColors)
 *   'splat' — R/G/B splat weights for TerrainMaterial + emits terrainType attribute
 *   'debug' — edge-type debug colors (grey/blue/green/red/yellow)
 */
export type TerrainColorMode = 'flat' | 'splat' | 'debug';

export const TERRAIN_COLORS: Record<TerrainType, THREE.Color> = {
  [TerrainType.Grassland]: new THREE.Color(0x86b888),  // muted sage green
  [TerrainType.Desert]:    new THREE.Color(0xc8bea0),  // neutral sandy beige
  [TerrainType.Snow]:      new THREE.Color(0xd5e6f5),  // icy blue-white
  [TerrainType.Mud]:       new THREE.Color(0xa08870),  // warm taupe
  [TerrainType.Rock]:      new THREE.Color(0xa3adb5),  // soft blue-grey
  [TerrainType.Water]:     new THREE.Color(0x4a8fb5),  // mid desaturated blue
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
  /** Noise sampling scale. Default 0.03. */
  noiseScale?: number;
  /** Minimum elevation difference to draw a cliff wall. Default 2. */
  cliffThreshold?: number;
  /**
   * Vertex color output mode. Default 'splat'.
   * Use 'flat' or 'debug' with MeshPhongMaterial({ vertexColors: true }).
   * Use 'splat' with TerrainMaterial (requires terrainType attribute).
   */
  colorMode?: TerrainColorMode;
}

const SOLID_FACTOR  = 0.8;
const BLEND_FACTOR  = 1 - SOLID_FACTOR;
const INNER_TO_OUTER = 1 / 0.866025404;

const TERRACES_PER_SLOPE = 2;
const TERRACE_STEPS      = TERRACES_PER_SLOPE * 2 + 1;
const H_STEP             = 1 / TERRACE_STEPS;
const V_STEP             = 1 / (TERRACES_PER_SLOPE + 1);

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

// [x, y, z, elevation, colorR, colorG, colorB, terrainTypeIndex]
type CV = [number, number, number, number, number, number, number, number];

export interface ChunkGeometries {
  terrain: THREE.BufferGeometry;
  roads: THREE.BufferGeometry | null;
}

export function buildChunkGeometry(
  map: HexMap,
  layout: HexLayout,
  bounds: ChunkBounds,
  opts: ChunkGeometryOptions = {},
): ChunkGeometries {
  const elevScale           = opts.elevationScale      ?? 0.5;
  const perturbStrength     = opts.perturbStrength      ?? 0.8;
  const elevPerturbStrength = opts.elevPerturbStrength  ?? 0.2;
  const noiseScale          = opts.noiseScale           ?? 0.35;
  const colorMode           = opts.colorMode            ?? 'splat';
  const isSplat             = colorMode === 'splat';
  const edgeDirs  = layout.orientation.edgeDirections;
  const { colStart, colEnd, rowStart, rowEnd } = bounds;
  const hexCount  = (colEnd - colStart) * (rowEnd - rowStart);

  const maxVerts  = hexCount * 1400;
  const positions = new Float32Array(maxVerts * 3);
  const colors    = new Float32Array(maxVerts * 3);
  const terrainTypes = isSplat ? new Float32Array(maxVerts * 3) : null;
  let vi = 0, tti = 0;

  // Road geometry — separate position + UV buffers, same perturbation as terrain
  const maxRoadVerts = hexCount * 300;
  const rPos = new Float32Array(maxRoadVerts * 3);
  const rUV  = new Float32Array(maxRoadVerts * 2);
  let rvi = 0, rui = 0;

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

  const streamBedY = (c: number, r: number): number =>
    (map.getElevation(c, r) + STREAM_BED_ELEVATION_OFFSET) * elevScale;

  // ---- vertex emitters ----

  const addVert = (
    x: number, y: number, z: number,
    r: number, g: number, b: number,
    tx: number, ty: number, tz: number,
  ) => {
    const [dx, dz] = perturb(x, z);
    positions[vi] = x + dx; positions[vi+1] = y; positions[vi+2] = z + dz;
    colors[vi]    = r; colors[vi+1]    = g; colors[vi+2]    = b;
    vi += 3;
    if (isSplat) {
      terrainTypes![tti++] = tx;
      terrainTypes![tti++] = ty;
      terrainTypes![tti++] = tz;
    }
  };

  const addVertRaw = (
    x: number, y: number, z: number,
    r: number, g: number, b: number,
    tx: number, ty: number, tz: number,
  ) => {
    positions[vi] = x; positions[vi+1] = y; positions[vi+2] = z;
    colors[vi]    = r; colors[vi+1]    = g; colors[vi+2]    = b;
    vi += 3;
    if (isSplat) {
      terrainTypes![tti++] = tx;
      terrainTypes![tti++] = ty;
      terrainTypes![tti++] = tz;
    }
  };

  const addTri = (
    x0: number, y0: number, z0: number, r0: number, g0: number, b0: number,
    x1: number, y1: number, z1: number, r1: number, g1: number, b1: number,
    x2: number, y2: number, z2: number, r2: number, g2: number, b2: number,
    tx: number, ty: number, tz: number,
  ) => {
    addVert(x0, y0, z0, r0, g0, b0, tx, ty, tz);
    addVert(x1, y1, z1, r1, g1, b1, tx, ty, tz);
    addVert(x2, y2, z2, r2, g2, b2, tx, ty, tz);
  };

  // Tutorial winding: (v0,v2,v1),(v1,v2,v3) → normals face up
  const addQuad = (
    x0: number, y0: number, z0: number, r0: number, g0: number, b0: number,
    x1: number, y1: number, z1: number, r1: number, g1: number, b1: number,
    x2: number, y2: number, z2: number, r2: number, g2: number, b2: number,
    x3: number, y3: number, z3: number, r3: number, g3: number, b3: number,
    tx: number, ty: number, tz: number,
  ) => {
    addVert(x0, y0, z0, r0, g0, b0, tx, ty, tz);
    addVert(x2, y2, z2, r2, g2, b2, tx, ty, tz);
    addVert(x1, y1, z1, r1, g1, b1, tx, ty, tz);
    addVert(x1, y1, z1, r1, g1, b1, tx, ty, tz);
    addVert(x2, y2, z2, r2, g2, b2, tx, ty, tz);
    addVert(x3, y3, z3, r3, g3, b3, tx, ty, tz);
  };

  // ---- road vertex emitters ----

  const addRoadVert = (x: number, y: number, z: number, u: number) => {
    const [dx, dz] = perturb(x, z);
    rPos[rvi] = x + dx; rPos[rvi+1] = y; rPos[rvi+2] = z + dz;
    rUV[rui]  = u;       rUV[rui+1]  = 0;
    rvi += 3; rui += 2;
  };

  // Tutorial winding: (v0,v2,v1),(v1,v2,v3)
  const addRoadQuad = (
    x0: number, y0: number, z0: number, u0: number,
    x1: number, y1: number, z1: number, u1: number,
    x2: number, y2: number, z2: number, u2: number,
    x3: number, y3: number, z3: number, u3: number,
  ) => {
    addRoadVert(x0,y0,z0,u0); addRoadVert(x2,y2,z2,u2); addRoadVert(x1,y1,z1,u1);
    addRoadVert(x1,y1,z1,u1); addRoadVert(x2,y2,z2,u2); addRoadVert(x3,y3,z3,u3);
  };

  const addRoadTri = (
    x0: number, y0: number, z0: number, u0: number,
    x1: number, y1: number, z1: number, u1: number,
    x2: number, y2: number, z2: number, u2: number,
  ) => {
    addRoadVert(x0,y0,z0,u0); addRoadVert(x1,y1,z1,u1); addRoadVert(x2,y2,z2,u2);
  };

  // v1-v3 = inner edge row, v4-v6 = outer edge row; U=1 at v2/v5 (center), U=0 at sides
  const triangulateRoadSegment = (
    v1x: number, v1y: number, v1z: number,
    v2x: number, v2y: number, v2z: number,
    v3x: number, v3y: number, v3z: number,
    v4x: number, v4y: number, v4z: number,
    v5x: number, v5y: number, v5z: number,
    v6x: number, v6y: number, v6z: number,
  ) => {
    addRoadQuad(v1x,v1y,v1z,0, v2x,v2y,v2z,1, v4x,v4y,v4z,0, v5x,v5y,v5z,1);
    addRoadQuad(v2x,v2y,v2z,1, v3x,v3y,v3z,0, v5x,v5y,v5z,1, v6x,v6y,v6z,0);
  };

  // Single triangle fill for road edge (center is at road middle, mL/mR at sides)
  const triangulateRoadEdge = (
    cx: number, cy: number, cz: number,
    mLx: number, mLy: number, mLz: number,
    mRx: number, mRy: number, mRz: number,
  ) => {
    addRoadTri(cx,cy,cz,1, mLx,mLy,mLz,0, mRx,mRy,mRz,0);
  };

  // Full road wedge from roadCenter toward edge (or just an edge fill if no road through edge)
  const triangulateRoad = (
    rcx: number, rcy: number, rcz: number,
    mLx: number, mLy: number, mLz: number,
    mRx: number, mRy: number, mRz: number,
    e2x: number, e2y: number, e2z: number,
    e3x: number, e3y: number, e3z: number,
    e4x: number, e4y: number, e4z: number,
    hasRoadThroughEdge: boolean,
  ) => {
    if (hasRoadThroughEdge) {
      const mCx = (mLx + mRx) * 0.5, mCy = (mLy + mRy) * 0.5, mCz = (mLz + mRz) * 0.5;
      triangulateRoadSegment(mLx,mLy,mLz, mCx,mCy,mCz, mRx,mRy,mRz, e2x,e2y,e2z, e3x,e3y,e3z, e4x,e4y,e4z);
      addRoadTri(rcx,rcy,rcz,1, mLx,mLy,mLz,0, mCx,mCy,mCz,1);
      addRoadTri(rcx,rcy,rcz,1, mCx,mCy,mCz,1, mRx,mRy,mRz,0);
    } else {
      triangulateRoadEdge(rcx,rcy,rcz, mLx,mLy,mLz, mRx,mRy,mRz);
    }
  };

  // Returns interpolation factors for left/right middle verts (0.5 = halfway, 0.25 = quarter)
  const getRoadInterpolators = (col: number, row: number, faceIdx: number): { l: number; r: number } => {
    if (map.hasRoadThroughEdge(col, row, faceIdx)) return { l: 0.5, r: 0.5 };
    return {
      l: map.hasRoadThroughEdge(col, row, (faceIdx + 5) % 6) ? 0.5 : 0.25,
      r: map.hasRoadThroughEdge(col, row, (faceIdx + 1) % 6) ? 0.5 : 0.25,
    };
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

  const triangulateBoundaryTriangle = (
    begin: CV, left: CV,
    bx: number, by: number, bz: number, br: number, bg: number, bb: number,
    tx: number, ty: number, tz: number,
  ) => {
    let [p1x, p1y, p1z] = tlPos(begin, left, 1);
    let [p1r, p1g, p1b] = tlCol(begin, left, 1);
    addVert(begin[0], begin[1], begin[2], begin[4], begin[5], begin[6], tx, ty, tz);
    addVert(p1x, p1y, p1z, p1r, p1g, p1b, tx, ty, tz);
    addVertRaw(bx, by, bz, br, bg, bb, tx, ty, tz);

    for (let i = 2; i < TERRACE_STEPS; i++) {
      const [q1x, q1y, q1z] = tlPos(begin, left, i);
      const [q1r, q1g, q1b] = tlCol(begin, left, i);
      addVert(p1x, p1y, p1z, p1r, p1g, p1b, tx, ty, tz);
      addVert(q1x, q1y, q1z, q1r, q1g, q1b, tx, ty, tz);
      addVertRaw(bx, by, bz, br, bg, bb, tx, ty, tz);
      p1x = q1x; p1y = q1y; p1z = q1z; p1r = q1r; p1g = q1g; p1b = q1b;
    }

    addVert(p1x, p1y, p1z, p1r, p1g, p1b, tx, ty, tz);
    addVert(left[0], left[1], left[2], left[4], left[5], left[6], tx, ty, tz);
    addVertRaw(bx, by, bz, br, bg, bb, tx, ty, tz);
  };

  const triangulateCornerTerraces = (begin: CV, left: CV, right: CV) => {
    const tx = begin[7], ty = left[7], tz = right[7];
    let [v3x, v3y, v3z] = tlPos(begin, left,  1);
    let [v3r, v3g, v3b] = tlCol(begin, left,  1);
    let [v4x, v4y, v4z] = tlPos(begin, right, 1);
    let [v4r, v4g, v4b] = tlCol(begin, right, 1);

    addTri(begin[0], begin[1], begin[2], begin[4], begin[5], begin[6],
           v3x, v3y, v3z, v3r, v3g, v3b,
           v4x, v4y, v4z, v4r, v4g, v4b, tx, ty, tz);

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
              v4x, v4y, v4z, v4r, v4g, v4b, tx, ty, tz);
    }

    addQuad(v3x, v3y, v3z, v3r, v3g, v3b,
            v4x, v4y, v4z, v4r, v4g, v4b,
            left[0],  left[1],  left[2],  left[4],  left[5],  left[6],
            right[0], right[1], right[2], right[4], right[5], right[6], tx, ty, tz);
  };

  const triangulateCornerTerracesCliff = (begin: CV, left: CV, right: CV) => {
    const tx = begin[7], ty = left[7], tz = right[7];
    const b  = Math.abs(1 / (right[3] - begin[3]));
    const [bdx, bdz] = perturb(begin[0], begin[2]);
    const [rdx, rdz] = perturb(right[0], right[2]);
    const bx = (begin[0] + bdx) + ((right[0] + rdx) - (begin[0] + bdx)) * b;
    const by = begin[1] + (right[1] - begin[1]) * b;
    const bz = (begin[2] + bdz) + ((right[2] + rdz) - (begin[2] + bdz)) * b;
    const br = begin[4] + (right[4] - begin[4]) * b;
    const bg = begin[5] + (right[5] - begin[5]) * b;
    const bb = begin[6] + (right[6] - begin[6]) * b;
    triangulateBoundaryTriangle(begin, left, bx, by, bz, br, bg, bb, tx, ty, tz);
    if (getEdgeType(left[3], right[3]) === 1) {
      triangulateBoundaryTriangle(left, right, bx, by, bz, br, bg, bb, tx, ty, tz);
    } else {
      addVert(left[0],  left[1],  left[2],  left[4],  left[5],  left[6],  tx, ty, tz);
      addVert(right[0], right[1], right[2], right[4], right[5], right[6], tx, ty, tz);
      addVertRaw(bx, by, bz, br, bg, bb, tx, ty, tz);
    }
  };

  const triangulateCornerCliffTerraces = (begin: CV, left: CV, right: CV) => {
    const tx = begin[7], ty = left[7], tz = right[7];
    const b  = Math.abs(1 / (left[3] - begin[3]));
    const [bdx, bdz] = perturb(begin[0], begin[2]);
    const [ldx, ldz] = perturb(left[0], left[2]);
    const bx = (begin[0] + bdx) + ((left[0] + ldx) - (begin[0] + bdx)) * b;
    const by = begin[1] + (left[1] - begin[1]) * b;
    const bz = (begin[2] + bdz) + ((left[2] + ldz) - (begin[2] + bdz)) * b;
    const br = begin[4] + (left[4] - begin[4]) * b;
    const bg = begin[5] + (left[5] - begin[5]) * b;
    const bb = begin[6] + (left[6] - begin[6]) * b;
    triangulateBoundaryTriangle(right, begin, bx, by, bz, br, bg, bb, tx, ty, tz);
    if (getEdgeType(left[3], right[3]) === 1) {
      triangulateBoundaryTriangle(left, right, bx, by, bz, br, bg, bb, tx, ty, tz);
    } else {
      addVert(left[0],  left[1],  left[2],  left[4],  left[5],  left[6],  tx, ty, tz);
      addVert(right[0], right[1], right[2], right[4], right[5], right[6], tx, ty, tz);
      addVertRaw(bx, by, bz, br, bg, bb, tx, ty, tz);
    }
  };

  const triangulateCorner = (bottom: CV, left: CV, right: CV) => {
    const le = getEdgeType(bottom[3], left[3]);
    const re = getEdgeType(bottom[3], right[3]);
    // Re-assign role colors when sub-functions receive args in a different positional order.
    // Each sub-function expects: 1st arg=(1,0,0), 2nd=(0,1,0), 3rd=(0,0,1).
    const cvR = (cv: CV, r: number, g: number, b: number): CV =>
      isSplat ? [cv[0], cv[1], cv[2], cv[3], r, g, b, cv[7]] : cv;

    if (le === 1) {
      if      (re === 1) triangulateCornerTerraces(bottom, left, right);
      else if (re === 0) triangulateCornerTerraces(cvR(left,1,0,0), cvR(right,0,1,0), cvR(bottom,0,0,1));
      else               triangulateCornerTerracesCliff(bottom, left, right);
    } else if (re === 1) {
      if      (le === 0) triangulateCornerTerraces(cvR(right,1,0,0), cvR(bottom,0,1,0), cvR(left,0,0,1));
      else               triangulateCornerCliffTerraces(bottom, left, right);
    } else if (getEdgeType(left[3], right[3]) === 1) {
      if (left[3] < right[3]) triangulateCornerCliffTerraces(cvR(right,1,0,0), cvR(bottom,0,1,0), cvR(left,0,0,1));
      else                    triangulateCornerTerracesCliff(cvR(left,1,0,0), cvR(right,0,1,0), cvR(bottom,0,0,1));
    } else {
      addTri(bottom[0], bottom[1], bottom[2], bottom[4], bottom[5], bottom[6],
             left[0],   left[1],   left[2],   left[4],   left[5],   left[6],
             right[0],  right[1],  right[2],  right[4],  right[5],  right[6],
             bottom[7], left[7], right[7]);
    }
  };

  // ---- Part 4 edge strips ----

  // type1 = own/first side, type2 = neighbor/second side.
  // Tutorial convention: types.x = types.z = type1, types.y = type2.
  const addBridgeEdgeStrip = (
    ie1x: number, ie1z: number,
    ie5x: number, ie5z: number,
    bx: number, bz: number,
    ownY: number, nbY: number,
    or: number, og: number, ob: number,
    nr: number, ng: number, nb2: number,
    type1: number,
    type2: number,
    ownBedY = ownY, nbBedY = nbY,
    hasRoad = false,
  ) => {
    const tx = type1, ty = type2, tz = type1;
    const ie2x = ie1x + (ie5x - ie1x) * 0.25, ie2z = ie1z + (ie5z - ie1z) * 0.25;
    const ie3x = ie1x + (ie5x - ie1x) * 0.50, ie3z = ie1z + (ie5z - ie1z) * 0.50;
    const ie4x = ie1x + (ie5x - ie1x) * 0.75, ie4z = ie1z + (ie5z - ie1z) * 0.75;
    const oe1x = ie1x + bx, oe1z = ie1z + bz;
    const oe2x = ie2x + bx, oe2z = ie2z + bz;
    const oe3x = ie3x + bx, oe3z = ie3z + bz;
    const oe4x = ie4x + bx, oe4z = ie4z + bz;
    const oe5x = ie5x + bx, oe5z = ie5z + bz;
    addQuad(ie1x, ownY,    ie1z, or,og,ob,  ie2x, ownY,    ie2z, or,og,ob,
            oe1x, nbY,     oe1z, nr,ng,nb2, oe2x, nbY,     oe2z, nr,ng,nb2, tx,ty,tz);
    addQuad(ie2x, ownY,    ie2z, or,og,ob,  ie3x, ownBedY, ie3z, or,og,ob,
            oe2x, nbY,     oe2z, nr,ng,nb2, oe3x, nbBedY,  oe3z, nr,ng,nb2, tx,ty,tz);
    addQuad(ie3x, ownBedY, ie3z, or,og,ob,  ie4x, ownY,    ie4z, or,og,ob,
            oe3x, nbBedY,  oe3z, nr,ng,nb2, oe4x, nbY,     oe4z, nr,ng,nb2, tx,ty,tz);
    addQuad(ie4x, ownY,    ie4z, or,og,ob,  ie5x, ownY,    ie5z, or,og,ob,
            oe4x, nbY,     oe4z, nr,ng,nb2, oe5x, nbY,     oe5z, nr,ng,nb2, tx,ty,tz);
    if (hasRoad) {
      // Reuse exact terrain vertex positions — no Y mismatch possible
      triangulateRoadSegment(
        ie2x, ownY,    ie2z,  ie3x, ownBedY, ie3z,  ie4x, ownY,    ie4z,
        oe2x, nbY,     oe2z,  oe3x, nbBedY,  oe3z,  oe4x, nbY,     oe4z,
      );
    }
  };

  // type1 = lower/begin side, type2 = upper/end side.
  const addTerraceEdgeStrip = (
    ie1x: number, ie1z: number,
    ie5x: number, ie5z: number,
    bx: number, bz: number,
    lowerY: number, upperY: number,
    lr: number, lg: number, lb: number,
    ur: number, ug: number, ub: number,
    type1: number,
    type2: number,
    lowerBedY = lowerY, upperBedY = upperY,
    hasRoad = false,
  ) => {
    const tx = type1, ty = type2, tz = type1;
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
      addQuad(p1x, py,  p1z, pr,pg,pb,  p2x, py,  p2z, pr,pg,pb,
              n1x, ny,  n1z, ncr,ncg,ncb, n2x, ny,  n2z, ncr,ncg,ncb, tx,ty,tz);
      addQuad(p2x, py,  p2z, pr,pg,pb,  p3x, p3y, p3z, pr,pg,pb,
              n2x, ny,  n2z, ncr,ncg,ncb, n3x, n3y, n3z, ncr,ncg,ncb, tx,ty,tz);
      addQuad(p3x, p3y, p3z, pr,pg,pb,  p4x, py,  p4z, pr,pg,pb,
              n3x, n3y, n3z, ncr,ncg,ncb, n4x, ny,  n4z, ncr,ncg,ncb, tx,ty,tz);
      addQuad(p4x, py,  p4z, pr,pg,pb,  p5x, py,  p5z, pr,pg,pb,
              n4x, ny,  n4z, ncr,ncg,ncb, n5x, ny,  n5z, ncr,ncg,ncb, tx,ty,tz);
      if (hasRoad) {
        triangulateRoadSegment(
          p2x, py,  p2z,  p3x, p3y, p3z,  p4x, py,  p4z,
          n2x, ny,  n2z,  n3x, n3y, n3z,  n4x, ny,  n4z,
        );
      }
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

      const ownElev   = map.getElevation(col, row);
      const ownY      = cellElevY(col, row);
      const ownTerrain = map.getTerrain(col, row);
      const ownType   = ownTerrain as number;
      const own       = TERRAIN_COLORS[ownTerrain];
      const or = own.r, og = own.g, ob = own.b;

      const q      = col - (row - (row & 1)) / 2;
      const center = hexToWorld(layout, { q, r: row });
      const crns   = hexCorners(layout, { q, r: row });

      const ox = crns.map(c => c.x - center.x);
      const oz = crns.map(c => c.z - center.z);

      // Solid-core color per mode
      const sr = colorMode === 'debug' ? 0.55 : colorMode === 'splat' ? 1 : or;
      const sg = colorMode === 'debug' ? 0.55 : colorMode === 'splat' ? 0 : og;
      const sb = colorMode === 'debug' ? 0.55 : colorMode === 'splat' ? 0 : ob;

      // 1. Solid core — per-direction dispatch
      const ownBedY      = streamBedY(col, row);
      const hasRiverCell = map.hasRiver(col, row);

      // Baked AO: darken vertices at the base of cliffs from higher neighbors
      const AO_STRENGTH = 0.4;
      const faceAO: number[] = [];
      for (let f = 0; f < 6; f++) {
        const nf   = nbOffset(col, row, edgeDirs[f]);
        const diff = map.inBounds(nf.col, nf.row)
          ? map.getElevation(nf.col, nf.row) - ownElev
          : 0;
        faceAO.push(diff > 0 ? Math.min(1, diff / 4) * AO_STRENGTH : 0);
      }
      const centAO = (faceAO[0]+faceAO[1]+faceAO[2]+faceAO[3]+faceAO[4]+faceAO[5]) / 6;

      for (let i = 0; i < 6; i++) {
        const i1  = (i + 1) % 6;
        const e1x = center.x + ox[i]  * SOLID_FACTOR, e1z = center.z + oz[i]  * SOLID_FACTOR;
        const e5x = center.x + ox[i1] * SOLID_FACTOR, e5z = center.z + oz[i1] * SOLID_FACTOR;
        const e2x = e1x + (e5x - e1x) * 0.25, e2z = e1z + (e5z - e1z) * 0.25;
        const e3x = (e1x + e5x) * 0.5,         e3z = (e1z + e5z) * 0.5;
        const e4x = e5x - (e5x - e1x) * 0.25,  e4z = e5z - (e5z - e1z) * 0.25;
        const tt = ownType, ot = ownType; // all interior tris use own type for all 3 slots

        if (!hasRiverCell) {
          const aoE1 = (faceAO[(i+5)%6] + faceAO[i]) * 0.5;
          const aoE5 = (faceAO[i] + faceAO[i1]) * 0.5;
          const aoE2 = aoE1 * 0.75 + aoE5 * 0.25;
          const aoE3 = (aoE1 + aoE5) * 0.5;
          const aoE4 = aoE1 * 0.25 + aoE5 * 0.75;
          const cC  = 1 - centAO;
          const cE1 = 1 - aoE1, cE2 = 1 - aoE2, cE3 = 1 - aoE3, cE4 = 1 - aoE4, cE5 = 1 - aoE5;
          addTri(center.x,ownY,center.z,sr*cC,sg*cC,sb*cC, e1x,ownY,e1z,sr*cE1,sg*cE1,sb*cE1, e2x,ownY,e2z,sr*cE2,sg*cE2,sb*cE2, tt,ot,ot);
          addTri(center.x,ownY,center.z,sr*cC,sg*cC,sb*cC, e2x,ownY,e2z,sr*cE2,sg*cE2,sb*cE2, e3x,ownY,e3z,sr*cE3,sg*cE3,sb*cE3, tt,ot,ot);
          addTri(center.x,ownY,center.z,sr*cC,sg*cC,sb*cC, e3x,ownY,e3z,sr*cE3,sg*cE3,sb*cE3, e4x,ownY,e4z,sr*cE4,sg*cE4,sb*cE4, tt,ot,ot);
          addTri(center.x,ownY,center.z,sr*cC,sg*cC,sb*cC, e4x,ownY,e4z,sr*cE4,sg*cE4,sb*cE4, e5x,ownY,e5z,sr*cE5,sg*cE5,sb*cE5, tt,ot,ot);

          // TriangulateWithoutRiver road logic (tutorial section 3)
          if (map.hasRoads(col, row)) {
            const interp = getRoadInterpolators(col, row, i);
            const mLx = center.x + (e1x - center.x) * interp.l, mLz = center.z + (e1z - center.z) * interp.l;
            const mRx = center.x + (e5x - center.x) * interp.r, mRz = center.z + (e5z - center.z) * interp.r;
            triangulateRoad(
              center.x, ownY, center.z,
              mLx, ownY, mLz,
              mRx, ownY, mRz,
              e2x, ownY, e2z,
              e3x, ownY, e3z,
              e4x, ownY, e4z,
              map.hasRoadThroughEdge(col, row, i),
            );
          }

        } else if (!map.hasRiverThroughEdge(col, row, i)) {
          const in1 = i1, ip = (i + 5) % 6, ip2 = (i + 4) % 6, in2 = (i + 2) % 6;
          let adjCx = center.x, adjCz = center.z;
          if (map.hasRiverThroughEdge(col, row, in1)) {
            if (map.hasRiverThroughEdge(col, row, ip)) {
              adjCx += (ox[i] + ox[i1]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER;
              adjCz += (oz[i] + oz[i1]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER;
            } else if (map.hasRiverThroughEdge(col, row, ip2)) {
              adjCx += ox[i]  * SOLID_FACTOR * 0.25;
              adjCz += oz[i]  * SOLID_FACTOR * 0.25;
            }
          } else if (map.hasRiverThroughEdge(col, row, ip) && map.hasRiverThroughEdge(col, row, in2)) {
            adjCx += ox[i1] * SOLID_FACTOR * 0.25;
            adjCz += oz[i1] * SOLID_FACTOR * 0.25;
          }
          const m1x = (adjCx + e1x) * 0.5, m1z = (adjCz + e1z) * 0.5;
          const m5x = (adjCx + e5x) * 0.5, m5z = (adjCz + e5z) * 0.5;
          const m2x = m1x + (m5x - m1x) * 0.25, m2z = m1z + (m5z - m1z) * 0.25;
          const m3x = (m1x + m5x) * 0.5,         m3z = (m1z + m5z) * 0.5;
          const m4x = m5x - (m5x - m1x) * 0.25,  m4z = m5z - (m5z - m1z) * 0.25;
          addQuad(m1x,ownY,m1z,sr,sg,sb, m2x,ownY,m2z,sr,sg,sb, e1x,ownY,e1z,sr,sg,sb, e2x,ownY,e2z,sr,sg,sb, tt,ot,ot);
          addQuad(m2x,ownY,m2z,sr,sg,sb, m3x,ownY,m3z,sr,sg,sb, e2x,ownY,e2z,sr,sg,sb, e3x,ownY,e3z,sr,sg,sb, tt,ot,ot);
          addQuad(m3x,ownY,m3z,sr,sg,sb, m4x,ownY,m4z,sr,sg,sb, e3x,ownY,e3z,sr,sg,sb, e4x,ownY,e4z,sr,sg,sb, tt,ot,ot);
          addQuad(m4x,ownY,m4z,sr,sg,sb, m5x,ownY,m5z,sr,sg,sb, e4x,ownY,e4z,sr,sg,sb, e5x,ownY,e5z,sr,sg,sb, tt,ot,ot);
          addTri(adjCx,ownY,adjCz,sr,sg,sb, m1x,ownY,m1z,sr,sg,sb, m2x,ownY,m2z,sr,sg,sb, tt,ot,ot);
          addTri(adjCx,ownY,adjCz,sr,sg,sb, m2x,ownY,m2z,sr,sg,sb, m3x,ownY,m3z,sr,sg,sb, tt,ot,ot);
          addTri(adjCx,ownY,adjCz,sr,sg,sb, m3x,ownY,m3z,sr,sg,sb, m4x,ownY,m4z,sr,sg,sb, tt,ot,ot);
          addTri(adjCx,ownY,adjCz,sr,sg,sb, m4x,ownY,m4z,sr,sg,sb, m5x,ownY,m5z,sr,sg,sb, tt,ot,ot);

          // TriangulateRoadAdjacentToRiver (tutorial section 4)
          if (map.hasRoads(col, row)) (() => {
            const prevFace = (i + 5) % 6, nextFace = i1;
            const hasRoadThrough   = map.hasRoadThroughEdge(col, row, i);
            const previousHasRiver = map.hasRiverThroughEdge(col, row, prevFace);
            const nextHasRiver     = map.hasRiverThroughEdge(col, row, nextFace);
            const interp    = getRoadInterpolators(col, row, i);
            const inDir     = map.getIncomingRiverDir(col, row);
            const outDir    = map.getOutgoingRiverDir(col, row);

            let rcx = center.x, rcz = center.z;  // road center (adjusted per river type)
            let cx  = center.x, cz  = center.z;  // actual center (adjusted for straight/inside-curve)

            if (map.hasRiverBeginOrEnd(col, row)) {
              const riverDir = inDir >= 0 ? inDir : outDir;
              const oppDir   = (riverDir + 3) % 6;
              const oppI1    = (oppDir + 1) % 6;
              rcx += (ox[oppDir] + ox[oppI1]) * 0.5 * SOLID_FACTOR / 3;
              rcz += (oz[oppDir] + oz[oppI1]) * 0.5 * SOLID_FACTOR / 3;
            } else if (inDir >= 0 && outDir >= 0 && inDir === (outDir + 3) % 6) {
              // Straight river — split road to either side; prune if nothing on this side
              if (previousHasRiver) {
                if (!hasRoadThrough && !map.hasRoadThroughEdge(col, row, nextFace)) return;
                const cornerX = ox[i1] * SOLID_FACTOR, cornerZ = oz[i1] * SOLID_FACTOR;
                rcx += cornerX * 0.5; rcz += cornerZ * 0.5;
                cx  += cornerX * 0.25; cz  += cornerZ * 0.25;
              } else {
                if (!hasRoadThrough && !map.hasRoadThroughEdge(col, row, prevFace)) return;
                const cornerX = ox[i] * SOLID_FACTOR, cornerZ = oz[i] * SOLID_FACTOR;
                rcx += cornerX * 0.5; rcz += cornerZ * 0.5;
                cx  += cornerX * 0.25; cz  += cornerZ * 0.25;
              }
            } else if (inDir >= 0 && outDir >= 0 && inDir === (outDir + 5) % 6) {
              // Zigzag A
              rcx -= ox[(inDir + 1) % 6] * 0.2;
              rcz -= oz[(inDir + 1) % 6] * 0.2;
            } else if (inDir >= 0 && outDir >= 0 && inDir === (outDir + 1) % 6) {
              // Zigzag B
              rcx -= ox[inDir] * 0.2;
              rcz -= oz[inDir] * 0.2;
            } else if (previousHasRiver && nextHasRiver) {
              // Inside of curve — prune if no road through this edge
              if (!hasRoadThrough) return;
              const midX = (ox[i] + ox[i1]) * 0.5 * SOLID_FACTOR;
              const midZ = (oz[i] + oz[i1]) * 0.5 * SOLID_FACTOR;
              rcx += midX * INNER_TO_OUTER * 0.7; rcz += midZ * INNER_TO_OUTER * 0.7;
              cx  += midX * INNER_TO_OUTER * 0.5; cz  += midZ * INNER_TO_OUTER * 0.5;
            } else {
              // Outside of curve — find middle direction, prune if no roads near it
              let mid: number;
              if (previousHasRiver)  mid = nextFace;
              else if (nextHasRiver) mid = prevFace;
              else                   mid = i;
              const mI1 = (mid + 1) % 6;
              if (!map.hasRoadThroughEdge(col, row, mid) &&
                  !map.hasRoadThroughEdge(col, row, (mid + 5) % 6) &&
                  !map.hasRoadThroughEdge(col, row, mI1)) return;
              rcx += (ox[mid] + ox[mI1]) * 0.5 * SOLID_FACTOR * 0.25;
              rcz += (oz[mid] + oz[mI1]) * 0.5 * SOLID_FACTOR * 0.25;
            }

            const mLx = rcx + (e1x - rcx) * interp.l, mLz = rcz + (e1z - rcz) * interp.l;
            const mRx = rcx + (e5x - rcx) * interp.r, mRz = rcz + (e5z - rcz) * interp.r;
            triangulateRoad(rcx,ownY,rcz, mLx,ownY,mLz, mRx,ownY,mRz,
              e2x,ownY,e2z, e3x,ownY,e3z, e4x,ownY,e4z, hasRoadThrough);
            if (previousHasRiver) triangulateRoadEdge(rcx,ownY,rcz, cx,ownY,cz, mLx,ownY,mLz);
            if (nextHasRiver)     triangulateRoadEdge(rcx,ownY,rcz, mRx,ownY,mRz, cx,ownY,cz);
          })();

        } else if (map.hasRiverBeginOrEnd(col, row)) {
          const e3y = ownBedY;
          const m1x = (center.x + e1x) * 0.5, m1z = (center.z + e1z) * 0.5;
          const m5x = (center.x + e5x) * 0.5, m5z = (center.z + e5z) * 0.5;
          const m2x = m1x + (m5x - m1x) * 0.25, m2z = m1z + (m5z - m1z) * 0.25;
          const m3x = (m1x + m5x) * 0.5, m3y = e3y, m3z = (m1z + m5z) * 0.5;
          const m4x = m5x - (m5x - m1x) * 0.25, m4z = m5z - (m5z - m1z) * 0.25;
          addQuad(m1x,ownY,m1z,sr,sg,sb, m2x,ownY,m2z,sr,sg,sb, e1x,ownY,e1z,sr,sg,sb, e2x,ownY,e2z,sr,sg,sb, tt,ot,ot);
          addQuad(m2x,ownY,m2z,sr,sg,sb, m3x,m3y,m3z,sr,sg,sb, e2x,ownY,e2z,sr,sg,sb, e3x,e3y,e3z,sr,sg,sb, tt,ot,ot);
          addQuad(m3x,m3y,m3z,sr,sg,sb, m4x,ownY,m4z,sr,sg,sb, e3x,e3y,e3z,sr,sg,sb, e4x,ownY,e4z,sr,sg,sb, tt,ot,ot);
          addQuad(m4x,ownY,m4z,sr,sg,sb, m5x,ownY,m5z,sr,sg,sb, e4x,ownY,e4z,sr,sg,sb, e5x,ownY,e5z,sr,sg,sb, tt,ot,ot);
          addTri(center.x,ownY,center.z,sr,sg,sb, m1x,ownY,m1z,sr,sg,sb, m2x,ownY,m2z,sr,sg,sb, tt,ot,ot);
          addTri(center.x,ownY,center.z,sr,sg,sb, m2x,ownY,m2z,sr,sg,sb, m3x,m3y,m3z,sr,sg,sb, tt,ot,ot);
          addTri(center.x,ownY,center.z,sr,sg,sb, m3x,m3y,m3z,sr,sg,sb, m4x,ownY,m4z,sr,sg,sb, tt,ot,ot);
          addTri(center.x,ownY,center.z,sr,sg,sb, m4x,ownY,m4z,sr,sg,sb, m5x,ownY,m5z,sr,sg,sb, tt,ot,ot);

        } else {
          const ip = (i + 5) % 6, in1 = i1, in2 = (i + 2) % 6;
          let cLx: number, cLz: number, cRx: number, cRz: number;

          if (map.hasRiverThroughEdge(col, row, (i + 3) % 6)) {
            cLx = center.x + ox[ip]  * SOLID_FACTOR * 0.25;
            cLz = center.z + oz[ip]  * SOLID_FACTOR * 0.25;
            cRx = center.x + ox[in2] * SOLID_FACTOR * 0.25;
            cRz = center.z + oz[in2] * SOLID_FACTOR * 0.25;
          } else if (map.hasRiverThroughEdge(col, row, in1)) {
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

          const ccx = (cLx + cRx) * 0.5, ccy = ownBedY, ccz = (cLz + cRz) * 0.5;
          const e3y = ownBedY;
          const m1x = (cLx + e1x) * 0.5, m1z = (cLz + e1z) * 0.5;
          const m5x = (cRx + e5x) * 0.5, m5z = (cRz + e5z) * 0.5;
          const m2x = m1x + (m5x - m1x) / 6, m2z = m1z + (m5z - m1z) / 6;
          const m3x = (m1x + m5x) * 0.5, m3y = ownBedY, m3z = (m1z + m5z) * 0.5;
          const m4x = m5x - (m5x - m1x) / 6, m4z = m5z - (m5z - m1z) / 6;

          addQuad(m1x,ownY,m1z,sr,sg,sb, m2x,ownY,m2z,sr,sg,sb, e1x,ownY,e1z,sr,sg,sb, e2x,ownY,e2z,sr,sg,sb, tt,ot,ot);
          addQuad(m2x,ownY,m2z,sr,sg,sb, m3x,m3y,m3z,sr,sg,sb, e2x,ownY,e2z,sr,sg,sb, e3x,e3y,e3z,sr,sg,sb, tt,ot,ot);
          addQuad(m3x,m3y,m3z,sr,sg,sb, m4x,ownY,m4z,sr,sg,sb, e3x,e3y,e3z,sr,sg,sb, e4x,ownY,e4z,sr,sg,sb, tt,ot,ot);
          addQuad(m4x,ownY,m4z,sr,sg,sb, m5x,ownY,m5z,sr,sg,sb, e4x,ownY,e4z,sr,sg,sb, e5x,ownY,e5z,sr,sg,sb, tt,ot,ot);
          addTri (cLx,ownY,cLz,sr,sg,sb, m1x,ownY,m1z,sr,sg,sb, m2x,ownY,m2z,sr,sg,sb, tt,ot,ot);
          addQuad(cLx,ownY,cLz,sr,sg,sb, ccx,ccy,ccz,sr,sg,sb, m2x,ownY,m2z,sr,sg,sb, m3x,m3y,m3z,sr,sg,sb, tt,ot,ot);
          addQuad(ccx,ccy,ccz,sr,sg,sb, cRx,ownY,cRz,sr,sg,sb, m3x,m3y,m3z,sr,sg,sb, m4x,ownY,m4z,sr,sg,sb, tt,ot,ot);
          addTri (cRx,ownY,cRz,sr,sg,sb, m4x,ownY,m4z,sr,sg,sb, m5x,ownY,m5z,sr,sg,sb, tt,ot,ot);
        }
      }

      // 2. Bridges (dirs 0–2) + corners (dirs 0–1)
      for (let i = 0; i < 3; i++) {
        const d  = edgeDirs[i];
        const nb = nbOffset(col, row, d);
        if (!map.inBounds(nb.col, nb.row)) continue;

        const nbElev    = map.getElevation(nb.col, nb.row);
        const nbY       = cellElevY(nb.col, nb.row);
        const nbTerrain = map.getTerrain(nb.col, nb.row);
        const nbType    = nbTerrain as number;
        const nbColor   = TERRAIN_COLORS[nbTerrain];
        const nr = nbColor.r, ng = nbColor.g, nb2 = nbColor.b;

        const i1  = (i + 1) % 6;
        const v1x = center.x + ox[i]  * SOLID_FACTOR, v1z = center.z + oz[i]  * SOLID_FACTOR;
        const v2x = center.x + ox[i1] * SOLID_FACTOR, v2z = center.z + oz[i1] * SOLID_FACTOR;
        const bx  = (ox[i] + ox[i1]) * BLEND_FACTOR;
        const bz  = (oz[i] + oz[i1]) * BLEND_FACTOR;
        const v3x = v1x + bx, v3z = v1z + bz;
        const v4x = v2x + bx, v4z = v2z + bz;

        const et = getEdgeType(ownElev, nbElev);

        // Bridge colors per mode
        let er: number, eg: number, eb: number;
        let er2: number, eg2: number, eb2: number;
        if (colorMode === 'debug') {
          er  = et === 0 ? 0.2 : et === 1 ? 0.1 : 1.0;
          eg  = et === 0 ? 0.4 : et === 1 ? 0.9 : 0.1;
          eb  = et === 0 ? 1.0 : et === 1 ? 0.1 : 0.1;
          er2 = er; eg2 = eg; eb2 = eb;
        } else if (colorMode === 'splat') {
          er = 1; eg = 0; eb = 0;   // own = red
          er2 = 0; eg2 = 1; eb2 = 0; // nb = green
        } else {
          er = or; eg = og; eb = ob;
          er2 = nr; eg2 = ng; eb2 = nb2;
        }

        const riverEdge  = map.hasRiverThroughEdge(col, row, i);
        const edgeBedOwn = riverEdge ? streamBedY(col, row)       : ownY;
        const edgeBedNb  = riverEdge ? streamBedY(nb.col, nb.row) : nbY;
        const hasRoad    = !riverEdge && map.hasRoadThroughEdge(col, row, i);

        if (et === 1) {
          if (ownElev < nbElev) {
            // own is lower: lower=(1,0,0)/ownType, upper=(0,1,0)/nbType
            addTerraceEdgeStrip(v1x,v1z, v2x,v2z,  bx,  bz, ownY,nbY, er,eg,eb, er2,eg2,eb2,
              ownType, nbType, edgeBedOwn, edgeBedNb, hasRoad);
          } else {
            // nb is lower: lower must still be (1,0,0) in splat; flat uses actual cell colors
            const [loR,loG,loB, hiR,hiG,hiB] = colorMode === 'splat'
              ? [er, eg, eb, er2, eg2, eb2]     // splat: color1=(1,0,0) for lower, color2 for upper
              : [er2, eg2, eb2, er, eg, eb];    // flat/debug: nb color for lower, own for upper
            addTerraceEdgeStrip(v3x,v3z, v4x,v4z, -bx,-bz, nbY,ownY, loR,loG,loB, hiR,hiG,hiB,
              nbType, ownType, edgeBedNb, edgeBedOwn, hasRoad);
          }
        } else {
          addBridgeEdgeStrip(v1x,v1z, v2x,v2z, bx,bz, ownY,nbY, er,eg,eb, er2,eg2,eb2,
            ownType, nbType, edgeBedOwn, edgeBedNb, hasRoad);
        }

        // Corner triangles — dirs 0 and 1 only
        if (i < 2) {
          const nextD  = edgeDirs[i1];
          const nextNb = nbOffset(col, row, nextD);
          if (!map.inBounds(nextNb.col, nextNb.row)) continue;

          const nextNbElev    = map.getElevation(nextNb.col, nextNb.row);
          const nextNbY       = cellElevY(nextNb.col, nextNb.row);
          const nextNbTerrain = map.getTerrain(nextNb.col, nextNb.row);
          const nextNbType    = nextNbTerrain as number;
          const nextNbColor   = TERRAIN_COLORS[nextNbTerrain];
          const nnr = nextNbColor.r, nng = nextNbColor.g, nnb = nextNbColor.b;

          const i2  = (i + 2) % 6;
          const bnx = (ox[i1] + ox[i2]) * BLEND_FACTOR;
          const bnz = (oz[i1] + oz[i2]) * BLEND_FACTOR;
          const v5x = v2x + bnx, v5z = v2z + bnz;

          // Corner colors per mode
          let cr2: number, cg2: number, cb2: number;
          let cr3: number, cg3: number, cb3: number;
          let cr4: number, cg4: number, cb4: number;
          if (colorMode === 'debug') {
            cr2 = 1; cg2 = 1; cb2 = 0;
            cr3 = 1; cg3 = 1; cb3 = 0;
            cr4 = 1; cg4 = 1; cb4 = 0;
          } else if (colorMode === 'splat') {
            cr2 = 1; cg2 = 0; cb2 = 0; // own  = red
            cr3 = 0; cg3 = 1; cb3 = 0; // nb   = green
            cr4 = 0; cg4 = 0; cb4 = 1; // next = blue
          } else {
            cr2 = or;  cg2 = og;  cb2 = ob;
            cr3 = nr;  cg3 = ng;  cb3 = nb2;
            cr4 = nnr; cg4 = nng; cb4 = nnb;
          }

          const ownCV:    CV = [v2x, ownY,    v2z, ownElev,    cr2, cg2, cb2, ownType];
          const nbCV:     CV = [v4x, nbY,     v4z, nbElev,     cr3, cg3, cb3, nbType];
          const nextNbCV: CV = [v5x, nextNbY, v5z, nextNbElev, cr4, cg4, cb4, nextNbType];

          // In splat mode the bottom vertex must get (1,0,0), left (0,1,0), right (0,0,1)
          // regardless of which cell (own/nb/nextNb) occupies each role after elevation-sorting.
          // Override the color channels based on role; leave flat/debug mode unchanged.
          const cvRole = (cv: CV, r: number, g: number, b: number): CV =>
            isSplat ? [cv[0], cv[1], cv[2], cv[3], r, g, b, cv[7]] : cv;

          if (ownElev <= nbElev) {
            if (ownElev <= nextNbElev) {
              triangulateCorner(cvRole(ownCV,1,0,0), cvRole(nbCV,0,1,0), cvRole(nextNbCV,0,0,1));
            } else {
              triangulateCorner(cvRole(nextNbCV,1,0,0), cvRole(ownCV,0,1,0), cvRole(nbCV,0,0,1));
            }
          } else if (nbElev <= nextNbElev) {
            triangulateCorner(cvRole(nbCV,1,0,0), cvRole(nextNbCV,0,1,0), cvRole(ownCV,0,0,1));
          } else {
            triangulateCorner(cvRole(nextNbCV,1,0,0), cvRole(ownCV,0,1,0), cvRole(nbCV,0,0,1));
          }
        }
      }
    }
  }

  const n   = vi / 3;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, n * 3), 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors.subarray(0, n * 3), 3));
  if (isSplat && terrainTypes) {
    geo.setAttribute('terrainType', new THREE.BufferAttribute(terrainTypes.subarray(0, n * 3), 3));
  }
  geo.computeVertexNormals();

  let roadsGeo: THREE.BufferGeometry | null = null;
  if (rvi > 0) {
    roadsGeo = new THREE.BufferGeometry();
    roadsGeo.setAttribute('position', new THREE.BufferAttribute(rPos.subarray(0, rvi), 3));
    roadsGeo.setAttribute('uv',       new THREE.BufferAttribute(rUV.subarray(0, rui), 2));
    roadsGeo.computeVertexNormals();
  }

  return { terrain: geo, roads: roadsGeo };
}
