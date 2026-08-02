import * as THREE from 'three';
import type { HexLayout } from '../math/HexLayout.js';
import { hexToWorld, hexCorners } from '../math/HexLayout.js';
import { HEX_DIRECTIONS } from '../math/HexCoord.js';
import type { HexMap } from '../map/HexMap.js';
import { STREAM_BED_ELEVATION_OFFSET, ELEVATION_SCALE } from '../map/HexCell.js';
import { sampleNoise } from '../math/Noise.js';
import type { TerrainDefinition } from './TerrainTypes.js';
import { DEFAULT_TERRAIN_LOOKUP } from './TerrainTypes.js';
import { RIVER_BASE_HALF_WIDTH, riverWidthScale, riverEdgeFlow } from './RiverWidth.js';

export type TerrainColorMode = 'flat' | 'splat' | 'debug';

type RGB = readonly [number, number, number];

const _fallbackColor = new THREE.Color(0x888888);
const _fallbackRoad: RGB = [0.4, 0.4, 0.4];

export interface ChunkBounds {
  colStart: number;
  colEnd: number;
  rowStart: number;
  rowEnd: number;
}

export interface ChunkGeometryOptions {
  elevationScale?: number;
  perturbStrength?: number;
  elevPerturbStrength?: number;
  noiseScale?: number;
  cliffThreshold?: number;
  colorMode?: TerrainColorMode;
  /** Terrain definitions used for vertex color and road color lookups. Defaults to the built-in six. */
  terrainDefinitions?: TerrainDefinition[];
  /**
   * Accumulated river flow per cell (cellKey → flow, from `computeRiverFlow`).
   * When provided, carved stream beds widen with flow (see RiverWidth.ts);
   * the SAME map must be passed to `buildRiverGeometry` so the water channel
   * widens in lockstep. ChunkManager injects its cached flow automatically.
   */
  riverFlow?: Map<number, number>;
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

// [x, y, z, elevation, colorR, colorG, colorB, terrainTypeIndex, cellIndex]
type CV = [number, number, number, number, number, number, number, number, number];

export interface ChunkGeometries {
  terrain: THREE.BufferGeometry;
  roads: THREE.BufferGeometry | null;
}

// ---------------------------------------------------------------------------
// Reusable scratch buffers, grown on demand and shared across builds. Worst-case
// sizing for a 32×32 chunk is ~69 MB across the four vertex arrays — allocating
// that per build (and retaining it via subarray views) dominated streaming cost.
// buildChunkGeometry is synchronous and single-threaded; the returned geometry
// copies (`.slice`) only the used range, so the scratch is free for reuse the
// moment the function returns.
// ---------------------------------------------------------------------------
let scratchVertCap      = 0;
let scratchPositions    = new Float32Array(0);
let scratchColors       = new Float32Array(0);
let scratchTerrainTypes = new Float32Array(0);
let scratchCellIndices  = new Float32Array(0);
let scratchRoadCap = 0;
let scratchRPos = new Float32Array(0);
let scratchRUV  = new Float32Array(0);
let scratchRCol = new Float32Array(0);
let scratchRCi  = new Float32Array(0);

export function buildChunkGeometry(
  map: HexMap,
  layout: HexLayout,
  bounds: ChunkBounds,
  opts: ChunkGeometryOptions = {},
): ChunkGeometries {
  const elevScale           = opts.elevationScale      ?? ELEVATION_SCALE;
  const perturbStrength     = opts.perturbStrength      ?? 0.8;
  const elevPerturbStrength = opts.elevPerturbStrength  ?? 0.2;
  const noiseScale          = opts.noiseScale           ?? 0.35;
  const cliffThreshold      = opts.cliffThreshold       ?? 2;
  const colorMode           = opts.colorMode            ?? 'splat';
  const isSplat             = colorMode === 'splat';

  // Build per-type color/road-color lookups from terrain definitions.
  const terrainLookup: Map<number, TerrainDefinition> = opts.terrainDefinitions
    ? new Map(opts.terrainDefinitions.map(d => [d.index, d]))
    : DEFAULT_TERRAIN_LOOKUP;
  const terrainColor = (t: number): THREE.Color =>
    (terrainLookup.get(t) ?? { color: _fallbackColor }).color;
  const roadColor = (t: number): RGB =>
    (terrainLookup.get(t) ?? { roadColor: _fallbackRoad }).roadColor;
  const edgeDirs  = layout.orientation.edgeDirections;
  const { colStart, colEnd, rowStart, rowEnd } = bounds;
  const hexCount  = (colEnd - colStart) * (rowEnd - rowStart);

  const maxVerts = hexCount * 1400;
  if (maxVerts > scratchVertCap) {
    scratchVertCap  = maxVerts;
    scratchPositions    = new Float32Array(maxVerts * 3);
    scratchColors       = new Float32Array(maxVerts * 3);
    scratchTerrainTypes = new Float32Array(maxVerts * 3);
    scratchCellIndices  = new Float32Array(maxVerts * 3);
  }
  const positions    = scratchPositions;
  const colors       = scratchColors;
  const terrainTypes = isSplat ? scratchTerrainTypes : null;
  const cellIndices  = scratchCellIndices;
  let vi = 0, tti = 0, cii = 0;
  let curCx = 0, curCy = 0, curCz = 0;
  const setCi = (cx: number, cy: number, cz: number) => { curCx = cx; curCy = cy; curCz = cz; };

  const maxRoadVerts = hexCount * 300;
  if (maxRoadVerts > scratchRoadCap) {
    scratchRoadCap = maxRoadVerts;
    scratchRPos = new Float32Array(maxRoadVerts * 3);
    scratchRUV  = new Float32Array(maxRoadVerts * 2);
    scratchRCol = new Float32Array(maxRoadVerts * 3);
    scratchRCi  = new Float32Array(maxRoadVerts);
  }
  const rPos = scratchRPos;
  const rUV  = scratchRUV;
  const rCol = scratchRCol;
  const rCi  = scratchRCi;
  let rvi = 0, rui = 0, rCii = 0;

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

  // ---- vertex emitters (cellIndex written from curCx/curCy/curCz closure) ----

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
    cellIndices[cii++] = curCx;
    cellIndices[cii++] = curCy;
    cellIndices[cii++] = curCz;
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
    cellIndices[cii++] = curCx;
    cellIndices[cii++] = curCy;
    cellIndices[cii++] = curCz;
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

  // ---- road vertex emitters (explicit ci per call) ----

  const addRoadVert = (x: number, y: number, z: number, u: number, r: number, g: number, b: number, ci: number) => {
    const [dx, dz] = perturb(x, z);
    rPos[rvi] = x + dx; rPos[rvi+1] = y; rPos[rvi+2] = z + dz;
    rUV[rui]  = u;       rUV[rui+1]  = 0;
    rCol[rvi] = r; rCol[rvi+1] = g; rCol[rvi+2] = b;
    rCi[rCii++] = ci;
    rvi += 3; rui += 2;
  };

  const addRoadQuad = (
    x0: number, y0: number, z0: number, u0: number,
    x1: number, y1: number, z1: number, u1: number,
    x2: number, y2: number, z2: number, u2: number,
    x3: number, y3: number, z3: number, u3: number,
    [ar, ag, ab]: RGB,
    [br, bg, bb]: RGB,
    ownCi: number, nbCi: number,
  ) => {
    addRoadVert(x0,y0,z0,u0,ar,ag,ab,ownCi); addRoadVert(x2,y2,z2,u2,br,bg,bb,nbCi); addRoadVert(x1,y1,z1,u1,ar,ag,ab,ownCi);
    addRoadVert(x1,y1,z1,u1,ar,ag,ab,ownCi); addRoadVert(x2,y2,z2,u2,br,bg,bb,nbCi); addRoadVert(x3,y3,z3,u3,br,bg,bb,nbCi);
  };

  const addRoadTri = (
    x0: number, y0: number, z0: number, u0: number,
    x1: number, y1: number, z1: number, u1: number,
    x2: number, y2: number, z2: number, u2: number,
    [r, g, b]: RGB,
    ci: number,
  ) => {
    addRoadVert(x0,y0,z0,u0,r,g,b,ci); addRoadVert(x1,y1,z1,u1,r,g,b,ci); addRoadVert(x2,y2,z2,u2,r,g,b,ci);
  };

  const triangulateRoadSegment = (
    v1x: number, v1y: number, v1z: number,
    v2x: number, v2y: number, v2z: number,
    v3x: number, v3y: number, v3z: number,
    v4x: number, v4y: number, v4z: number,
    v5x: number, v5y: number, v5z: number,
    v6x: number, v6y: number, v6z: number,
    ownColor: RGB, nbColor: RGB,
    ownCi: number, nbCi: number,
  ) => {
    addRoadQuad(v1x,v1y,v1z,0, v2x,v2y,v2z,1, v4x,v4y,v4z,0, v5x,v5y,v5z,1, ownColor, nbColor, ownCi, nbCi);
    addRoadQuad(v2x,v2y,v2z,1, v3x,v3y,v3z,0, v5x,v5y,v5z,1, v6x,v6y,v6z,0, ownColor, nbColor, ownCi, nbCi);
  };

  const triangulateRoadEdge = (
    cx: number, cy: number, cz: number,
    mLx: number, mLy: number, mLz: number,
    mRx: number, mRy: number, mRz: number,
    ownColor: RGB,
    ownCi: number,
  ) => {
    addRoadTri(cx,cy,cz,1, mLx,mLy,mLz,0, mRx,mRy,mRz,0, ownColor, ownCi);
  };

  const triangulateRoad = (
    rcx: number, rcy: number, rcz: number,
    mLx: number, mLy: number, mLz: number,
    mRx: number, mRy: number, mRz: number,
    e2x: number, e2y: number, e2z: number,
    e3x: number, e3y: number, e3z: number,
    e4x: number, e4y: number, e4z: number,
    hasRoadThroughEdge: boolean,
    ownColor: RGB, nbColor: RGB,
    ownCi: number, nbCi: number,
  ) => {
    if (hasRoadThroughEdge) {
      const mCx = (mLx + mRx) * 0.5, mCy = (mLy + mRy) * 0.5, mCz = (mLz + mRz) * 0.5;
      const edgeColor: RGB = [(ownColor[0]+nbColor[0])*0.5, (ownColor[1]+nbColor[1])*0.5, (ownColor[2]+nbColor[2])*0.5];
      triangulateRoadSegment(mLx,mLy,mLz, mCx,mCy,mCz, mRx,mRy,mRz, e2x,e2y,e2z, e3x,e3y,e3z, e4x,e4y,e4z, ownColor, edgeColor, ownCi, nbCi);
      addRoadTri(rcx,rcy,rcz,1, mLx,mLy,mLz,0, mCx,mCy,mCz,1, ownColor, ownCi);
      addRoadTri(rcx,rcy,rcz,1, mCx,mCy,mCz,1, mRx,mRy,mRz,0, ownColor, ownCi);
    } else {
      triangulateRoadEdge(rcx,rcy,rcz, mLx,mLy,mLz, mRx,mRy,mRz, ownColor, ownCi);
    }
  };

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
    setCi(begin[8], left[8], begin[8]);
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
    setCi(begin[8], left[8], right[8]);
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
    const cx = begin[8], cy = left[8], cz = right[8];
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
      setCi(cx, cy, cz);
      addVert(left[0],  left[1],  left[2],  left[4],  left[5],  left[6],  tx, ty, tz);
      addVert(right[0], right[1], right[2], right[4], right[5], right[6], tx, ty, tz);
      addVertRaw(bx, by, bz, br, bg, bb, tx, ty, tz);
    }
  };

  const triangulateCornerCliffTerraces = (begin: CV, left: CV, right: CV) => {
    const tx = begin[7], ty = left[7], tz = right[7];
    const cx = begin[8], cy = left[8], cz = right[8];
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
      setCi(cx, cy, cz);
      addVert(left[0],  left[1],  left[2],  left[4],  left[5],  left[6],  tx, ty, tz);
      addVert(right[0], right[1], right[2], right[4], right[5], right[6], tx, ty, tz);
      addVertRaw(bx, by, bz, br, bg, bb, tx, ty, tz);
    }
  };

  const triangulateCorner = (bottom: CV, left: CV, right: CV) => {
    const le = getEdgeType(bottom[3], left[3]);
    const re = getEdgeType(bottom[3], right[3]);
    const cvR = (cv: CV, r: number, g: number, b: number): CV =>
      isSplat ? [cv[0], cv[1], cv[2], cv[3], r, g, b, cv[7], cv[8]] : cv;

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
      setCi(bottom[8], left[8], right[8]);
      addTri(bottom[0], bottom[1], bottom[2], bottom[4], bottom[5], bottom[6],
             left[0],   left[1],   left[2],   left[4],   left[5],   left[6],
             right[0],  right[1],  right[2],  right[4],  right[5],  right[6],
             bottom[7], left[7], right[7]);
    }
  };

  // ---- Part 4 edge strips ----

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
    ownCi = 0, nbCi = 0,
    halfW = RIVER_BASE_HALF_WIDTH,
  ) => {
    const tx = type1, ty = type2, tz = type1;
    setCi(ownCi, nbCi, ownCi);
    const ie2x = ie1x + (ie5x - ie1x) * (0.5 - halfW), ie2z = ie1z + (ie5z - ie1z) * (0.5 - halfW);
    const ie3x = ie1x + (ie5x - ie1x) * 0.50,          ie3z = ie1z + (ie5z - ie1z) * 0.50;
    const ie4x = ie1x + (ie5x - ie1x) * (0.5 + halfW), ie4z = ie1z + (ie5z - ie1z) * (0.5 + halfW);
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
      triangulateRoadSegment(
        ie2x, ownY,    ie2z,  ie3x, ownBedY, ie3z,  ie4x, ownY,    ie4z,
        oe2x, nbY,     oe2z,  oe3x, nbBedY,  oe3z,  oe4x, nbY,     oe4z,
        roadColor(type1), roadColor(type2),
        ownCi, nbCi,
      );
    }
  };

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
    ownCi = 0, nbCi = 0,
    halfW = RIVER_BASE_HALF_WIDTH,
  ) => {
    const tx = type1, ty = type2, tz = type1;
    setCi(ownCi, nbCi, ownCi);
    const ie2x = ie1x + (ie5x - ie1x) * (0.5 - halfW), ie2z = ie1z + (ie5z - ie1z) * (0.5 - halfW);
    const ie3x = ie1x + (ie5x - ie1x) * 0.50,          ie3z = ie1z + (ie5z - ie1z) * 0.50;
    const ie4x = ie1x + (ie5x - ie1x) * (0.5 + halfW), ie4z = ie1z + (ie5z - ie1z) * (0.5 + halfW);

    let p1x = ie1x, p1z = ie1z;
    let p2x = ie2x, p2z = ie2z;
    let p3x = ie3x, p3z = ie3z;
    let p4x = ie4x, p4z = ie4z;
    let p5x = ie5x, p5z = ie5z;
    let py = lowerY, p3y = lowerBedY, pr = lr, pg = lg, pb = lb;

    const rc1 = roadColor(type1);
    const rc2 = roadColor(type2);

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
        const hPrev = (step - 1) * H_STEP;
        const stepOwnColor: RGB = [rc1[0] + (rc2[0]-rc1[0])*hPrev, rc1[1] + (rc2[1]-rc1[1])*hPrev, rc1[2] + (rc2[2]-rc1[2])*hPrev];
        const stepNbColor:  RGB = [rc1[0] + (rc2[0]-rc1[0])*h,     rc1[1] + (rc2[1]-rc1[1])*h,     rc1[2] + (rc2[2]-rc1[2])*h];
        triangulateRoadSegment(
          p2x, py,  p2z,  p3x, p3y, p3z,  p4x, py,  p4z,
          n2x, ny,  n2z,  n3x, n3y, n3z,  n4x, ny,  n4z,
          stepOwnColor, stepNbColor,
          ownCi, nbCi,
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
      const own       = terrainColor(ownTerrain);
      const or = own.r, og = own.g, ob = own.b;
      const ownCi     = row * map.width + col;

      const q      = col - (row - (row & 1)) / 2;
      const center = hexToWorld(layout, { q, r: row });
      const crns   = hexCorners(layout, { q, r: row });

      const ox = crns.map(c => c.x - center.x);
      const oz = crns.map(c => c.z - center.z);

      const sr = colorMode === 'debug' ? 0.55 : colorMode === 'splat' ? 1 : or;
      const sg = colorMode === 'debug' ? 0.55 : colorMode === 'splat' ? 0 : og;
      const sb = colorMode === 'debug' ? 0.55 : colorMode === 'splat' ? 0 : ob;

      const ownBedY      = streamBedY(col, row);
      const hasRiverCell = map.hasRiver(col, row);

      // Flow-dependent channel widening: cellW scales the channel's interior
      // flank points (one value per cell so shared interior points agree);
      // edgeHalfW gives the groove half-width at each edge from the flow
      // CROSSING that edge, so both cells of a shared edge compute the same
      // width (see RiverWidth.ts). With no flow map both stay at the fixed
      // historical values.
      const riverFlow = opts.riverFlow;
      const cellW = riverFlow && hasRiverCell
        ? riverWidthScale(riverFlow.get(ownCi) ?? 1)
        : 1;
      const edgeHalfW = (face: number): number => riverFlow
        ? RIVER_BASE_HALF_WIDTH * riverWidthScale(riverEdgeFlow(map, riverFlow, col, row, face, edgeDirs))
        : RIVER_BASE_HALF_WIDTH;

      // 3+ channels meeting in one cell (confluence): the pairwise channel
      // cases below can't tile the center — junction cells use symmetric
      // channel mouths plus a sunken basin cap emitted after the edge loop.
      let riverEdgeCount = 0;
      if (hasRiverCell) {
        for (let f = 0; f < 6; f++) if (map.hasRiverThroughEdge(col, row, f)) riverEdgeCount++;
      }
      const isJunction = riverEdgeCount >= 3 && !map.hasRiverBeginOrEnd(col, row);
      const junctionRing: Array<{ x: number; y: number; z: number }> = [];

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

      setCi(ownCi, ownCi, ownCi);

      for (let i = 0; i < 6; i++) {
        const i1  = (i + 1) % 6;
        const e1x = center.x + ox[i]  * SOLID_FACTOR, e1z = center.z + oz[i]  * SOLID_FACTOR;
        const e5x = center.x + ox[i1] * SOLID_FACTOR, e5z = center.z + oz[i1] * SOLID_FACTOR;
        // River faces use the flow-widened groove half-width for the e2/e4
        // notch points; everything else keeps the fixed 0.25/0.75 subdivision.
        const eHw = hasRiverCell && map.hasRiverThroughEdge(col, row, i) ? edgeHalfW(i) : RIVER_BASE_HALF_WIDTH;
        const e2x = e1x + (e5x - e1x) * (0.5 - eHw), e2z = e1z + (e5z - e1z) * (0.5 - eHw);
        const e3x = (e1x + e5x) * 0.5,               e3z = (e1z + e5z) * 0.5;
        const e4x = e1x + (e5x - e1x) * (0.5 + eHw), e4z = e1z + (e5z - e1z) * (0.5 + eHw);
        const tt = ownType, ot = ownType;

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

          if (map.hasRoads(col, row)) {
            const interp = getRoadInterpolators(col, row, i);
            const mLx = center.x + (e1x - center.x) * interp.l, mLz = center.z + (e1z - center.z) * interp.l;
            const mRx = center.x + (e5x - center.x) * interp.r, mRz = center.z + (e5z - center.z) * interp.r;
            const nbI = nbOffset(col, row, edgeDirs[i]);
            const nbRoadCi = map.inBounds(nbI.col, nbI.row) ? nbI.row * map.width + nbI.col : ownCi;
            const nbRoadColor = roadColor(map.inBounds(nbI.col, nbI.row) ? map.getTerrain(nbI.col, nbI.row) : ownTerrain);
            triangulateRoad(
              center.x, ownY, center.z,
              mLx, ownY, mLz,
              mRx, ownY, mRz,
              e2x, ownY, e2z,
              e3x, ownY, e3z,
              e4x, ownY, e4z,
              map.hasRoadThroughEdge(col, row, i),
              roadColor(ownTerrain), nbRoadColor,
              ownCi, nbRoadCi,
            );
          }

        } else if (isJunction && !map.hasRiverThroughEdge(col, row, i)) {
          // Junction bank wedge: flat strip from the corner chord (B_i–B_i1)
          // to the outer edge ring. Its flanks run straight down the corner
          // radials — exactly the adjacent channels' flank lines — so every
          // seam of the junction shares endpoints and is colinear (no slivers).
          const bIx = center.x + ox[i]  * SOLID_FACTOR * 0.4 * cellW, bIz = center.z + oz[i]  * SOLID_FACTOR * 0.4 * cellW;
          const bJx = center.x + ox[i1] * SOLID_FACTOR * 0.4 * cellW, bJz = center.z + oz[i1] * SOLID_FACTOR * 0.4 * cellW;
          addTri(bIx,ownY,bIz,sr,sg,sb, e1x,ownY,e1z,sr,sg,sb, e2x,ownY,e2z,sr,sg,sb, tt,ot,ot);
          addTri(bIx,ownY,bIz,sr,sg,sb, e2x,ownY,e2z,sr,sg,sb, e3x,ownY,e3z,sr,sg,sb, tt,ot,ot);
          addTri(bIx,ownY,bIz,sr,sg,sb, e3x,ownY,e3z,sr,sg,sb, bJx,ownY,bJz,sr,sg,sb, tt,ot,ot);
          addTri(bJx,ownY,bJz,sr,sg,sb, e3x,ownY,e3z,sr,sg,sb, e4x,ownY,e4z,sr,sg,sb, tt,ot,ot);
          addTri(bJx,ownY,bJz,sr,sg,sb, e4x,ownY,e4z,sr,sg,sb, e5x,ownY,e5z,sr,sg,sb, tt,ot,ot);
          junctionRing.push({ x: bIx, y: ownY, z: bIz }, { x: bJx, y: ownY, z: bJz });

        } else if (!map.hasRiverThroughEdge(col, row, i)) {
          const in1 = i1, ip = (i + 5) % 6, ip2 = (i + 4) % 6, in2 = (i + 2) % 6;
          // Bank pull-away offsets mirror the adjacent channel's flank points,
          // so they scale with the same cellW to stay seam-tight when flow
          // widens the channel.
          let adjCx = center.x, adjCz = center.z;
          if (map.hasRiverThroughEdge(col, row, in1)) {
            if (map.hasRiverThroughEdge(col, row, ip)) {
              adjCx += (ox[i] + ox[i1]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER * cellW;
              adjCz += (oz[i] + oz[i1]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER * cellW;
            } else if (map.hasRiverThroughEdge(col, row, ip2)) {
              adjCx += ox[i]  * SOLID_FACTOR * 0.25 * cellW;
              adjCz += oz[i]  * SOLID_FACTOR * 0.25 * cellW;
            }
          } else if (map.hasRiverThroughEdge(col, row, ip) && map.hasRiverThroughEdge(col, row, in2)) {
            adjCx += ox[i1] * SOLID_FACTOR * 0.25 * cellW;
            adjCz += oz[i1] * SOLID_FACTOR * 0.25 * cellW;
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

          if (map.hasRoads(col, row)) (() => {
            const prevFace = (i + 5) % 6, nextFace = i1;
            const hasRoadThrough   = map.hasRoadThroughEdge(col, row, i);
            const previousHasRiver = map.hasRiverThroughEdge(col, row, prevFace);
            const nextHasRiver     = map.hasRiverThroughEdge(col, row, nextFace);
            const interp    = getRoadInterpolators(col, row, i);
            const inDir     = map.getIncomingRiverDir(col, row);
            const outDir    = map.getOutgoingRiverDir(col, row);

            let rcx = center.x, rcz = center.z;
            let cx  = center.x, cz  = center.z;

            if (map.hasRiverBeginOrEnd(col, row)) {
              const riverDir = inDir >= 0 ? inDir : outDir;
              const oppDir   = (riverDir + 3) % 6;
              const oppI1    = (oppDir + 1) % 6;
              rcx += (ox[oppDir] + ox[oppI1]) * 0.5 * SOLID_FACTOR / 3;
              rcz += (oz[oppDir] + oz[oppI1]) * 0.5 * SOLID_FACTOR / 3;
            } else if (inDir >= 0 && outDir >= 0 && inDir === (outDir + 3) % 6) {
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
              rcx -= ox[(inDir + 1) % 6] * 0.2;
              rcz -= oz[(inDir + 1) % 6] * 0.2;
            } else if (inDir >= 0 && outDir >= 0 && inDir === (outDir + 1) % 6) {
              rcx -= ox[inDir] * 0.2;
              rcz -= oz[inDir] * 0.2;
            } else if (previousHasRiver && nextHasRiver) {
              if (!hasRoadThrough) return;
              const midX = (ox[i] + ox[i1]) * 0.5 * SOLID_FACTOR;
              const midZ = (oz[i] + oz[i1]) * 0.5 * SOLID_FACTOR;
              rcx += midX * INNER_TO_OUTER * 0.7; rcz += midZ * INNER_TO_OUTER * 0.7;
              cx  += midX * INNER_TO_OUTER * 0.5; cz  += midZ * INNER_TO_OUTER * 0.5;
            } else {
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
            const nbI = nbOffset(col, row, edgeDirs[i]);
            const nbRoadCi = map.inBounds(nbI.col, nbI.row) ? nbI.row * map.width + nbI.col : ownCi;
            const nbRoadColor = roadColor(map.inBounds(nbI.col, nbI.row) ? map.getTerrain(nbI.col, nbI.row) : ownTerrain);
            triangulateRoad(rcx,ownY,rcz, mLx,ownY,mLz, mRx,ownY,mRz,
              e2x,ownY,e2z, e3x,ownY,e3z, e4x,ownY,e4z, hasRoadThrough,
              roadColor(ownTerrain), nbRoadColor, ownCi, nbRoadCi);
            if (previousHasRiver) triangulateRoadEdge(rcx,ownY,rcz, cx,ownY,cz, mLx,ownY,mLz, roadColor(ownTerrain), ownCi);
            if (nextHasRiver)     triangulateRoadEdge(rcx,ownY,rcz, mRx,ownY,mRz, cx,ownY,cz, roadColor(ownTerrain), ownCi);
          })();

        } else if (isJunction) {
          // Junction channel edge: triangulation of the mouth polygon
          // (B_i, e1..e5, B_i1) with a groove running from a bed-depth STRIP
          // on the mouth chord (cL2..cR2, 60% of it) to the outer bed point
          // (e3). A single converging bed point would leave walls above the
          // water surface across nearly the whole mouth, pinching the channel
          // to a slit where it meets the pool. Flanks run straight down the
          // corner radials, matching the bank wedges above.
          const bIx = center.x + ox[i]  * SOLID_FACTOR * 0.4 * cellW, bIz = center.z + oz[i]  * SOLID_FACTOR * 0.4 * cellW;
          const bJx = center.x + ox[i1] * SOLID_FACTOR * 0.4 * cellW, bJz = center.z + oz[i1] * SOLID_FACTOR * 0.4 * cellW;
          const cL2x = bIx + (bJx - bIx) * 0.15, cL2z = bIz + (bJz - bIz) * 0.15;
          const cR2x = bIx + (bJx - bIx) * 0.85, cR2z = bIz + (bJz - bIz) * 0.85;
          addTri(bIx,ownY,bIz,sr,sg,sb,      e1x,ownY,e1z,sr,sg,sb,      e2x,ownY,e2z,sr,sg,sb, tt,ot,ot);
          addTri(bIx,ownY,bIz,sr,sg,sb,      e2x,ownY,e2z,sr,sg,sb,      cL2x,ownBedY,cL2z,sr,sg,sb, tt,ot,ot);
          addTri(cL2x,ownBedY,cL2z,sr,sg,sb, e2x,ownY,e2z,sr,sg,sb,      e3x,ownBedY,e3z,sr,sg,sb, tt,ot,ot);
          addTri(cL2x,ownBedY,cL2z,sr,sg,sb, e3x,ownBedY,e3z,sr,sg,sb,   cR2x,ownBedY,cR2z,sr,sg,sb, tt,ot,ot);
          addTri(cR2x,ownBedY,cR2z,sr,sg,sb, e3x,ownBedY,e3z,sr,sg,sb,   e4x,ownY,e4z,sr,sg,sb, tt,ot,ot);
          addTri(cR2x,ownBedY,cR2z,sr,sg,sb, e4x,ownY,e4z,sr,sg,sb,      bJx,ownY,bJz,sr,sg,sb, tt,ot,ot);
          addTri(bJx,ownY,bJz,sr,sg,sb,      e4x,ownY,e4z,sr,sg,sb,      e5x,ownY,e5z,sr,sg,sb, tt,ot,ot);
          junctionRing.push(
            { x: bIx,  y: ownY,    z: bIz },
            { x: cL2x, y: ownBedY, z: cL2z },
            { x: cR2x, y: ownBedY, z: cR2z },
            { x: bJx,  y: ownY,    z: bJz },
          );

        } else if (map.hasRiverBeginOrEnd(col, row)) {
          const e3y = ownBedY;
          const bHalf = Math.min(0.48, 0.25 * cellW);
          const m1x = (center.x + e1x) * 0.5, m1z = (center.z + e1z) * 0.5;
          const m5x = (center.x + e5x) * 0.5, m5z = (center.z + e5z) * 0.5;
          const m2x = m1x + (m5x - m1x) * (0.5 - bHalf), m2z = m1z + (m5z - m1z) * (0.5 - bHalf);
          const m3x = (m1x + m5x) * 0.5, m3y = e3y, m3z = (m1z + m5z) * 0.5;
          const m4x = m1x + (m5x - m1x) * (0.5 + bHalf), m4z = m1z + (m5z - m1z) * (0.5 + bHalf);
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

          // Flank factors scale with cellW; the same scaled formulas appear in
          // buildRiverGeometry so the water channel tiles the widened bed.
          if (map.hasRiverThroughEdge(col, row, (i + 3) % 6)) {
            cLx = center.x + ox[ip]  * SOLID_FACTOR * 0.25 * cellW;
            cLz = center.z + oz[ip]  * SOLID_FACTOR * 0.25 * cellW;
            cRx = center.x + ox[in2] * SOLID_FACTOR * 0.25 * cellW;
            cRz = center.z + oz[in2] * SOLID_FACTOR * 0.25 * cellW;
          } else if (map.hasRiverThroughEdge(col, row, in1)) {
            const f = Math.min(0.85, (2 / 3) * cellW);
            cLx = center.x; cLz = center.z;
            cRx = center.x + ox[i1] * SOLID_FACTOR * f;
            cRz = center.z + oz[i1] * SOLID_FACTOR * f;
          } else if (map.hasRiverThroughEdge(col, row, ip)) {
            const f = Math.min(0.85, (2 / 3) * cellW);
            cLx = center.x + ox[i] * SOLID_FACTOR * f;
            cLz = center.z + oz[i] * SOLID_FACTOR * f;
            cRx = center.x; cRz = center.z;
          } else if (map.hasRiverThroughEdge(col, row, in2)) {
            cLx = center.x; cLz = center.z;
            cRx = center.x + (ox[i1] + ox[in2]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER * cellW;
            cRz = center.z + (oz[i1] + oz[in2]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER * cellW;
          } else {
            cLx = center.x + (ox[ip] + ox[i]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER * cellW;
            cLz = center.z + (oz[ip] + oz[i]) * SOLID_FACTOR * 0.25 * INNER_TO_OUTER * cellW;
            cRx = center.x; cRz = center.z;
          }

          const ccx = (cLx + cRx) * 0.5, ccy = ownBedY, ccz = (cLz + cRz) * 0.5;
          const e3y = ownBedY;
          const mHalf = Math.min(0.48, (1 / 3) * cellW);
          const m1x = (cLx + e1x) * 0.5, m1z = (cLz + e1z) * 0.5;
          const m5x = (cRx + e5x) * 0.5, m5z = (cRz + e5z) * 0.5;
          const m2x = m1x + (m5x - m1x) * (0.5 - mHalf), m2z = m1z + (m5z - m1z) * (0.5 - mHalf);
          const m3x = (m1x + m5x) * 0.5, m3y = ownBedY, m3z = (m1z + m5z) * 0.5;
          const m4x = m1x + (m5x - m1x) * (0.5 + mHalf), m4z = m1z + (m5z - m1z) * (0.5 + mHalf);

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

      // Confluence basin: sunken pool floor under the junction. A straight fan
      // from the bed-depth center to the ring would slope up to the bank-top
      // B points and pierce the water surface across most of the pool, so the
      // basin gets a FLAT floor at bed depth out to 60% of the ring, with only
      // a narrow rim rising to the ring points — the river water surface cuts
      // the rim in a thin shoreline band, like it does on channel walls.
      if (isJunction && junctionRing.length >= 3) {
        setCi(ownCi, ownCi, ownCi);
        const RIM = 0.6;
        const inner = junctionRing.map(p => ({
          x: center.x + (p.x - center.x) * RIM,
          z: center.z + (p.z - center.z) * RIM,
        }));
        for (let k = 0; k < junctionRing.length; k++) {
          const k1 = (k + 1) % junctionRing.length;
          const a  = junctionRing[k],  b  = junctionRing[k1];
          const ai = inner[k],         bi = inner[k1];
          addTri(
            center.x, ownBedY, center.z, sr, sg, sb,
            ai.x, ownBedY, ai.z, sr, sg, sb,
            bi.x, ownBedY, bi.z, sr, sg, sb,
            ownType, ownType, ownType,
          );
          addQuad(
            ai.x, ownBedY, ai.z, sr, sg, sb,
            bi.x, ownBedY, bi.z, sr, sg, sb,
            a.x,  a.y,     a.z,  sr, sg, sb,
            b.x,  b.y,     b.z,  sr, sg, sb,
            ownType, ownType, ownType,
          );
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
        const nbColor   = terrainColor(nbTerrain);
        const nr = nbColor.r, ng = nbColor.g, nb2 = nbColor.b;
        const nbCi = nb.row * map.width + nb.col;

        const i1  = (i + 1) % 6;
        const v1x = center.x + ox[i]  * SOLID_FACTOR, v1z = center.z + oz[i]  * SOLID_FACTOR;
        const v2x = center.x + ox[i1] * SOLID_FACTOR, v2z = center.z + oz[i1] * SOLID_FACTOR;
        const bx  = (ox[i] + ox[i1]) * BLEND_FACTOR;
        const bz  = (oz[i] + oz[i1]) * BLEND_FACTOR;
        const v3x = v1x + bx, v3z = v1z + bz;
        const v4x = v2x + bx, v4z = v2z + bz;

        const et = getEdgeType(ownElev, nbElev);

        let er: number, eg: number, eb: number;
        let er2: number, eg2: number, eb2: number;
        if (colorMode === 'debug') {
          er  = et === 0 ? 0.2 : et === 1 ? 0.1 : 1.0;
          eg  = et === 0 ? 0.4 : et === 1 ? 0.9 : 0.1;
          eb  = et === 0 ? 1.0 : et === 1 ? 0.1 : 0.1;
          er2 = er; eg2 = eg; eb2 = eb;
        } else if (colorMode === 'splat') {
          er = 1; eg = 0; eb = 0;
          er2 = 0; eg2 = 1; eb2 = 0;
        } else {
          er = or; eg = og; eb = ob;
          er2 = nr; eg2 = ng; eb2 = nb2;
        }

        const riverEdge  = map.hasRiverThroughEdge(col, row, i);
        const edgeBedOwn = riverEdge ? streamBedY(col, row)       : ownY;
        const edgeBedNb  = riverEdge ? streamBedY(nb.col, nb.row) : nbY;
        const hasRoad    = !riverEdge && map.hasRoadThroughEdge(col, row, i);
        const stripHalfW = riverEdge ? edgeHalfW(i) : RIVER_BASE_HALF_WIDTH;

        if (et === 1) {
          if (ownElev < nbElev) {
            addTerraceEdgeStrip(v1x,v1z, v2x,v2z,  bx,  bz, ownY,nbY, er,eg,eb, er2,eg2,eb2,
              ownType, nbType, edgeBedOwn, edgeBedNb, hasRoad, ownCi, nbCi, stripHalfW);
          } else {
            const [loR,loG,loB, hiR,hiG,hiB] = colorMode === 'splat'
              ? [er, eg, eb, er2, eg2, eb2]
              : [er2, eg2, eb2, er, eg, eb];
            addTerraceEdgeStrip(v3x,v3z, v4x,v4z, -bx,-bz, nbY,ownY, loR,loG,loB, hiR,hiG,hiB,
              nbType, ownType, edgeBedNb, edgeBedOwn, hasRoad, nbCi, ownCi, stripHalfW);
          }
        } else {
          addBridgeEdgeStrip(v1x,v1z, v2x,v2z, bx,bz, ownY,nbY, er,eg,eb, er2,eg2,eb2,
            ownType, nbType, edgeBedOwn, edgeBedNb, hasRoad, ownCi, nbCi, stripHalfW);

          if (et === 2) {
            const WALL_DARK = 0.3;
            const diff = ownElev - nbElev;
            if (diff >= cliffThreshold) {
              const botR = colorMode === 'splat' ? er : er * WALL_DARK;
              const botG = colorMode === 'splat' ? eg : eg * WALL_DARK;
              const botB = colorMode === 'splat' ? eb : eb * WALL_DARK;
              setCi(ownCi, ownCi, ownCi);
              addQuad(
                v1x, ownY, v1z, er,   eg,   eb,
                v2x, ownY, v2z, er,   eg,   eb,
                v1x, nbY,  v1z, botR, botG, botB,
                v2x, nbY,  v2z, botR, botG, botB,
                ownType, ownType, ownType,
              );
            } else if (-diff >= cliffThreshold) {
              const botR = colorMode === 'splat' ? er2 : er2 * WALL_DARK;
              const botG = colorMode === 'splat' ? eg2 : eg2 * WALL_DARK;
              const botB = colorMode === 'splat' ? eb2 : eb2 * WALL_DARK;
              setCi(nbCi, nbCi, nbCi);
              addQuad(
                v3x, nbY,  v3z, er2,  eg2,  eb2,
                v4x, nbY,  v4z, er2,  eg2,  eb2,
                v3x, ownY, v3z, botR, botG, botB,
                v4x, ownY, v4z, botR, botG, botB,
                nbType, nbType, nbType,
              );
            }
          }
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
          const nextNbColor   = terrainColor(nextNbTerrain);
          const nnr = nextNbColor.r, nng = nextNbColor.g, nnb = nextNbColor.b;
          const nextNbCi = nextNb.row * map.width + nextNb.col;

          const i2  = (i + 2) % 6;
          const bnx = (ox[i1] + ox[i2]) * BLEND_FACTOR;
          const bnz = (oz[i1] + oz[i2]) * BLEND_FACTOR;
          const v5x = v2x + bnx, v5z = v2z + bnz;

          let cr2: number, cg2: number, cb2: number;
          let cr3: number, cg3: number, cb3: number;
          let cr4: number, cg4: number, cb4: number;
          if (colorMode === 'debug') {
            cr2 = 1; cg2 = 1; cb2 = 0;
            cr3 = 1; cg3 = 1; cb3 = 0;
            cr4 = 1; cg4 = 1; cb4 = 0;
          } else if (colorMode === 'splat') {
            cr2 = 1; cg2 = 0; cb2 = 0;
            cr3 = 0; cg3 = 1; cb3 = 0;
            cr4 = 0; cg4 = 0; cb4 = 1;
          } else {
            cr2 = or;  cg2 = og;  cb2 = ob;
            cr3 = nr;  cg3 = ng;  cb3 = nb2;
            cr4 = nnr; cg4 = nng; cb4 = nnb;
          }

          const ownCV:    CV = [v2x, ownY,    v2z, ownElev,    cr2, cg2, cb2, ownType,    ownCi];
          const nbCV:     CV = [v4x, nbY,     v4z, nbElev,     cr3, cg3, cb3, nbType,     nbCi];
          const nextNbCV: CV = [v5x, nextNbY, v5z, nextNbElev, cr4, cg4, cb4, nextNbType, nextNbCi];

          const cvRole = (cv: CV, r: number, g: number, b: number): CV =>
            isSplat ? [cv[0], cv[1], cv[2], cv[3], r, g, b, cv[7], cv[8]] : cv;

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

  // .slice (not .subarray): a subarray view would pin the entire scratch
  // allocation in memory for the lifetime of the geometry AND alias the next
  // build's writes. slice copies exactly the used range.
  const n   = vi / 3;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',   new THREE.BufferAttribute(positions.slice(0, n * 3), 3));
  geo.setAttribute('color',      new THREE.BufferAttribute(colors.slice(0, n * 3), 3));
  geo.setAttribute('cellIndex',  new THREE.BufferAttribute(cellIndices.slice(0, n * 3), 3));
  if (isSplat && terrainTypes) {
    geo.setAttribute('terrainType', new THREE.BufferAttribute(terrainTypes.slice(0, n * 3), 3));
  }
  geo.computeVertexNormals();

  let roadsGeo: THREE.BufferGeometry | null = null;
  if (rvi > 0) {
    const rn = rvi / 3;
    roadsGeo = new THREE.BufferGeometry();
    roadsGeo.setAttribute('position',  new THREE.BufferAttribute(rPos.slice(0, rvi), 3));
    roadsGeo.setAttribute('uv',        new THREE.BufferAttribute(rUV.slice(0, rui), 2));
    roadsGeo.setAttribute('color',     new THREE.BufferAttribute(rCol.slice(0, rvi), 3));
    roadsGeo.setAttribute('cellIndex', new THREE.BufferAttribute(rCi.slice(0, rn), 1));
    roadsGeo.computeVertexNormals();
  }

  return { terrain: geo, roads: roadsGeo };
}
