// ---------------------------------------------------------------------------
// Pure map-skirt geometry: the wall of earth that closes the map's open edges,
// built as plain typed arrays. Kept free of `three` imports for the same reason
// HexChunkCore is — so it can run anywhere, including a worker.
// ---------------------------------------------------------------------------
import type { HexLayout } from '../math/HexLayout.js';
import { hexToWorld, hexCorners } from '../math/HexLayout.js';
import { HEX_DIRECTIONS } from '../math/HexCoord.js';
import type { HexMap } from '../map/HexMap.js';
import { STREAM_BED_ELEVATION_OFFSET } from '../map/HexCell.js';
// Imported, never copied: these four decide where a terrain vertex lands, and
// the skirt has to place its own the same way or the seam tears end to end.
import { CHUNK_GEOMETRY_DEFAULTS, TERRACE_STEPS, terraceFactors, edgeTypeOf } from './HexChunkCore.js';
import { DEFAULT_WATER_TERRAIN_INDEX } from './TerrainTypes.js';
import { sampleNoise } from '../math/Noise.js';

/**
 * Where the terrain mesh stops. `HexChunkCore` draws each cell as an inset
 * hexagon at this fraction of the hex radius and bridges the gap to its
 * neighbours; at the map boundary there is no neighbour, so the bridge is
 * skipped and the terrain simply ends here. That exposed ring is what the
 * skirt has to meet, and the strip from it out to the full hex edge is what
 * the skirt caps. Must match `SOLID_FACTOR` in HexChunkCore.
 */
const SOLID_FACTOR = 0.8;

/**
 * Where the boundary fan subdivides its outer edge. HexChunkCore emits each
 * cell top as four triangles per face, so the exposed boundary is the
 * five-point polyline e1…e5 — and because every point is perturbed
 * independently, the midpoints do *not* lie on the line between the ends.
 * Following the same five points is what keeps the seam tight.
 */
const EDGE_FRACTIONS = [0, 0.25, 0.5, 0.75, 1] as const;

export interface MapSkirtOptions {
  /** Must match the terrain's. Defaults to the terrain's own. */
  elevationScale?: number;
  /** Must match the terrain's, or the top edge tears. Defaults to the terrain's own. */
  perturbStrength?: number;
  /** Must match the terrain's. Defaults to the terrain's own. */
  elevPerturbStrength?: number;
  /** Must match the terrain's. Defaults to the terrain's own. */
  noiseScale?: number;
  /**
   * Terrain indices that count as water, for the {@link MapSkirtOptions.waterCut}
   * band. Defaults to the built-in water terrain — pass the same set the water
   * geometry was built with, or a custom liquid palette leaves its coastlines
   * open. Water is identified by *terrain*, the way the liquid builders do it,
   * not by the cell's water flag.
   */
  waterTerrains?: Set<number>;
  /**
   * How far the base sits below the lowest ground on the map, in world units.
   * The floor is flat and shared by the whole perimeter, so this is the
   * thinnest the wall ever gets — measured at the map's deepest point.
   * Default 2.
   */
  depth?: number;
  /**
   * Base Y in world units, overriding the derived one. Use when several maps
   * must sit on one plinth; note that nothing checks the terrain clears it, so
   * too high a value pokes ground through the floor.
   */
  baseY?: number;
  /**
   * Fill the cut from the ground up to the water surface on submerged edge
   * cells. The wall itself always follows the *ground*, so without this a
   * coastal map edge keeps an open slot between the sea bed and the surface.
   * Default true.
   */
  waterCut?: boolean;
}

export interface MapSkirtArrays {
  positions: Float32Array;
  normals: Float32Array;
  /** World units below the cut line at the top of the wall — 0 along the top edge itself. */
  depths: Float32Array;
  /** 1 on the water cross-section, 0 on earth. */
  water: Float32Array;
  /** The flat Y the whole base sits at, so callers can match something to it. */
  baseY: number;
  /** Boundary faces walled, for tests and diagnostics. */
  faceCount: number;
}

/** Ground-plane point (x, z). */
type P2 = readonly [number, number];
/** World point (x, y, z). */
type P3 = readonly [number, number, number];

function nbOffset(col: number, row: number, d: number): { col: number; row: number } {
  const q  = col - (row - (row & 1)) / 2;
  const nq = q + HEX_DIRECTIONS[d].q;
  const nr = row + HEX_DIRECTIONS[d].r;
  return { col: nq + (nr - (nr & 1)) / 2, row: nr };
}

/**
 * The Y every wall drops to: below the lowest ground the map can produce, plus
 * `depth`. Derived from the elevation *range* rather than by sampling every
 * cell's perturbed height — the bounds below are exact worst cases, so no cell
 * whose noise happened to dip further than the ones sampled can poke through.
 */
export function skirtBaseY(map: HexMap, opts: MapSkirtOptions = {}): number {
  const elevScale  = opts.elevationScale ?? CHUNK_GEOMETRY_DEFAULTS.elevationScale;
  const elevJitter = opts.elevPerturbStrength ?? CHUNK_GEOMETRY_DEFAULTS.elevPerturbStrength;

  let minElev = Infinity;
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      const e = map.getElevation(col, row);
      if (e < minElev) minElev = e;
    }
  }
  if (!Number.isFinite(minElev)) minElev = 0;

  // A carved river bed is the one thing that reaches below a cell's own
  // elevation, so the deepest ground anywhere is that offset under the lowest
  // cell, less the most the elevation noise can subtract.
  const lowest = (minElev + Math.min(0, STREAM_BED_ELEVATION_OFFSET)) * elevScale - elevJitter;
  return lowest - (opts.depth ?? 2);
}

/**
 * Build the wall that closes the map's open edges: a vertical face under every
 * boundary cell, its top following the terrain's own contour and its base one
 * flat Y beneath the whole map — the map as a block of earth cut out of the
 * world with the landscape left intact on top.
 *
 * Only the perimeter is walled — `O(width + height)` faces, not `O(cells)` —
 * so this is cheap enough to rebuild outright whenever the map changes,
 * without needing the chunk machinery.
 *
 * The geometry-matching options (`perturbStrength`, `noiseScale`,
 * `elevationScale`, `elevPerturbStrength`) **must** be the values the terrain
 * was built with. They are what place the top vertices, and a mismatch shows
 * as a torn seam along the whole map edge rather than as anything subtle.
 *
 * Known gap: a river running off the map edge carves its bed below the cell
 * top, and the wall's top is flat across the face, so a river mouth exactly on
 * the rim leaves a small notch. Rivers normally terminate in a water body
 * before the edge, and closing it would mean mirroring HexChunkCore's river
 * branch here — the kind of duplication that has already bitten the waterfall
 * code — so it is left open deliberately.
 */
export function buildMapSkirtArrays(
  map: HexMap,
  layout: HexLayout,
  opts: MapSkirtOptions = {},
): MapSkirtArrays {
  const elevScale  = opts.elevationScale      ?? CHUNK_GEOMETRY_DEFAULTS.elevationScale;
  const perturbAmt = opts.perturbStrength     ?? CHUNK_GEOMETRY_DEFAULTS.perturbStrength;
  const elevJitter = opts.elevPerturbStrength ?? CHUNK_GEOMETRY_DEFAULTS.elevPerturbStrength;
  const noiseScale = opts.noiseScale          ?? CHUNK_GEOMETRY_DEFAULTS.noiseScale;
  const waterCut   = opts.waterCut !== false;
  const waterTerrains = opts.waterTerrains ?? new Set([DEFAULT_WATER_TERRAIN_INDEX]);
  const baseY      = opts.baseY ?? skirtBaseY(map, opts);
  const edgeDirs   = layout.orientation.edgeDirections;

  // The same displacement the terrain applies to every vertex it emits. It is
  // a pure function of world XZ, so a corner shared by two boundary cells
  // lands in one place from both — the wall is watertight for free.
  const perturbed = (x: number, z: number): [number, number] => {
    const n = sampleNoise(x * noiseScale, z * noiseScale);
    return [x + (n[0] * 2 - 1) * perturbAmt, z + (n[2] * 2 - 1) * perturbAmt];
  };

  const cellElevY = (c: number, r: number): number => {
    const qq = c - (r - (r & 1)) / 2;
    const wc = hexToWorld(layout, { q: qq, r });
    const n  = sampleNoise(wc.x * noiseScale, wc.z * noiseScale);
    return map.getElevation(c, r) * elevScale + (n[1] * 2 - 1) * elevJitter;
  };

  const pos: number[] = [];
  const nrm: number[] = [];
  const dep: number[] = [];
  const wat: number[] = [];
  let faceCount = 0;

  /**
   * One flat-shaded triangle, **wound to match the normal it is given** rather
   * than trusting the caller to order its vertices. Front faces are chosen by
   * winding, so a disagreement between the two shows up as a hole you can see
   * the sky through — and the hex corner order is not obvious enough to get
   * right by reasoning about it (both the lip and the wall were inside-out on
   * the first attempt). Enforcing it here makes that class of bug impossible.
   *
   * `cutY` is the ground line this vertex hangs below, feeding the topsoil
   * band; pass null for surfaces that sit *on* the cut.
   */
  const addTri = (
    p0: P3, p1: P3, p2: P3,
    nx: number, ny: number, nz: number,
    cutY: number | null, isWater: number,
  ) => {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    // Two cells at exactly the same height leave a zero-area riser. Emitting it
    // costs three vertices and gives the winding check nothing to work with.
    if (gx * gx + gy * gy + gz * gz < 1e-18) return;
    const flip = gx * nx + gy * ny + gz * nz < 0;
    const order: P3[] = flip ? [p0, p2, p1] : [p0, p1, p2];
    for (const p of order) {
      pos.push(p[0], p[1], p[2]);
      nrm.push(nx, ny, nz);
      dep.push(cutY === null ? 0 : cutY - p[1]);
      wat.push(isWater);
    }
  };

  /** Outward horizontal normal of a wall running from `a` to `b`. */
  const outwardNormal = (a: P2, b: P2): [number, number] => {
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const len = Math.hypot(ex, ez) || 1;
    return [ez / len, -ex / len];
  };

  /** One vertical quad between two ground-plane points, facing out of the map. */
  const addWall = (
    a: P2, b: P2, topY: number, bottomY: number, cutY: number, isWater: number,
    normal?: readonly [number, number],
  ) => {
    const [nx, nz] = normal ?? outwardNormal(a, b);
    const at: P3 = [a[0], topY, a[1]],    bt: P3 = [b[0], topY, b[1]];
    const ab: P3 = [a[0], bottomY, a[1]], bb: P3 = [b[0], bottomY, b[1]];
    addTri(at, bt, ab, nx, 0, nz, cutY, isWater);
    addTri(bt, bb, ab, nx, 0, nz, cutY, isWater);
  };

  /** Flat cap over the strip the terrain leaves bare, at ground height. */
  const addLip = (inA: P2, inB: P2, outA: P2, outB: P2, y: number) => {
    const a: P3 = [inA[0], y, inA[1]],  b: P3 = [inB[0], y, inB[1]];
    const c: P3 = [outA[0], y, outA[1]], d: P3 = [outB[0], y, outB[1]];
    addTri(a, b, c, 0, 1, 0, null, 0);
    addTri(b, d, c, 0, 1, 0, null, 0);
  };

  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      // Only cells on the rectangle's rim can have a missing neighbour — every
      // neighbour offset moves at most one column and one row — so the
      // interior never runs the six-way test.
      if (col > 0 && col < map.width - 1 && row > 0 && row < map.height - 1) continue;

      const q      = col - (row - (row & 1)) / 2;
      const center = hexToWorld(layout, { q, r: row });
      const crns   = hexCorners(layout, { q, r: row });
      const ox = crns.map(c => c.x - center.x);
      const oz = crns.map(c => c.z - center.z);

      const topY   = cellElevY(col, row);
      const waterY = map.getWaterSurface(col, row) * elevScale;
      const submerged = waterCut && waterTerrains.has(map.getTerrain(col, row)) && waterY > topY;

      for (let i = 0; i < 6; i++) {
        const nb = nbOffset(col, row, edgeDirs[i]);
        if (map.inBounds(nb.col, nb.row)) continue;
        faceCount++;

        const i1 = (i + 1) % 6;
        // Two rings: the inset one the terrain actually ends on, and the full
        // hex edge the wall's face lives on.
        const in1x  = center.x + ox[i]  * SOLID_FACTOR, in1z  = center.z + oz[i]  * SOLID_FACTOR;
        const in5x  = center.x + ox[i1] * SOLID_FACTOR, in5z  = center.z + oz[i1] * SOLID_FACTOR;
        const out1x = center.x + ox[i],  out1z = center.z + oz[i];
        const out5x = center.x + ox[i1], out5z = center.z + oz[i1];

        for (let s = 0; s < EDGE_FRACTIONS.length - 1; s++) {
          const t0 = EDGE_FRACTIONS[s], t1 = EDGE_FRACTIONS[s + 1];
          const inA  = perturbed(in1x  + (in5x  - in1x)  * t0, in1z  + (in5z  - in1z)  * t0);
          const inB  = perturbed(in1x  + (in5x  - in1x)  * t1, in1z  + (in5z  - in1z)  * t1);
          const outA = perturbed(out1x + (out5x - out1x) * t0, out1z + (out5z - out1z) * t0);
          const outB = perturbed(out1x + (out5x - out1x) * t1, out1z + (out5z - out1z) * t1);

          addLip(inA, inB, outA, outB, topY);
          addWall(outA, outB, topY, baseY, topY, 0);
          // The water cross-section sits on top of the earth: the ground line
          // is still the top of the *wall*, this is the pond cut open above it.
          if (submerged) addWall(outA, outB, waterY, topY, waterY, 1);
        }

        // ---- corner seal ----
        // Three cells meet at each hex corner. Where one of them is off the
        // map, the terrain skips the corner fill that would have joined the
        // other two, and this face's lip is flat at its own cell's height —
        // so between two rim cells at different elevations there is an open
        // wedge looking straight through to the sky. Bridge it.
        //
        // Only the face's *starting* corner is sealed, and only when the cell
        // sharing it is on the map: taking one corner per boundary face visits
        // each such wedge exactly once, and a corner between two off-map
        // neighbours has no height change to bridge — this cell owns both its
        // faces there and its own lip already closes it.
        const prevFace = (i + 5) % 6;
        const side = nbOffset(col, row, edgeDirs[prevFace]);
        if (!map.inBounds(side.col, side.row)) continue;

        const sideTopY = cellElevY(side.col, side.row);
        const sq = side.col - (side.row - (side.row & 1)) / 2;
        const sc = hexToWorld(layout, { q: sq, r: side.row });

        // The wedge's plan-view corners: the shared hex corner, and the two
        // cells' inset ring points reaching toward it. Kept *unperturbed*
        // because the terrain interpolates along this line before displacing
        // each result — interpolating displaced endpoints instead would drift
        // off the terrain's own points.
        const cornerX = center.x + ox[i], cornerZ = center.z + oz[i];
        const iaX = center.x + ox[i] * SOLID_FACTOR, iaZ = center.z + oz[i] * SOLID_FACTOR;
        const isX = sc.x + (cornerX - sc.x) * SOLID_FACTOR;
        const isZ = sc.z + (cornerZ - sc.z) * SOLID_FACTOR;
        const P = perturbed(cornerX, cornerZ);

        // The open end of the bridge between these two cells, traced with the
        // terrain's own profile. A terraced slope is a staircase, and a
        // straight line across it passes *under* every tread — which is
        // exactly the sky showing through between the steps. Flat and cliff
        // edges really are straight, so those stay two points.
        const terraced = edgeTypeOf(
          map.getElevation(col, row), map.getElevation(side.col, side.row),
        ) === 1;
        const steps = terraced ? TERRACE_STEPS : 1;
        const edge: P3[] = [];
        for (let s = 0; s <= steps; s++) {
          const { h, v } = terraced ? terraceFactors(s) : { h: s, v: s };
          const p = perturbed(iaX + (isX - iaX) * h, iaZ + (isZ - iaZ) * h);
          edge.push([p[0], topY + (sideTopY - topY) * v, p[1]]);
        }

        // Fan the wedge from the shared corner across that staircase. The
        // fan's first edge is this cell's lip edge and its last reaches the
        // neighbour's ring point, so both ends are already shared.
        const pPA: P3 = [P[0], topY, P[1]];
        for (let s = 0; s < edge.length - 1; s++) {
          addTri(pPA, edge[s], edge[s + 1], 0, 1, 0, null, 0);
        }

        // The shared corner exists at *both* cells' heights — each one's lip
        // reaches it — so the step between them is a genuinely vertical riser
        // and needs a horizontal normal. Shading it as ground would light a
        // wall as though it were a floor, and its geometric normal is
        // perpendicular to the up vector, which leaves the winding undecidable.
        const last = edge[edge.length - 1];
        const rdx = last[0] - P[0], rdz = last[2] - P[1];
        const rl  = Math.hypot(rdx, rdz) || 1;
        let rnx = -rdz / rl, rnz = rdx / rl;
        // Point it away from the two cells it sits between.
        if (rnx * (P[0] - (center.x + sc.x) * 0.5) + rnz * (P[1] - (center.z + sc.z) * 0.5) < 0) {
          rnx = -rnx; rnz = -rnz;
        }
        addTri(pPA, [P[0], sideTopY, P[1]], last, rnx, 0, rnz, null, 0);

        // Soil under the whole staircase, down to the floor — the backstop
        // that keeps any residual mismatch showing earth rather than sky.
        const mx = (iaX + isX) * 0.5, mz = (iaZ + isZ) * 0.5;
        const tx = cornerX - mx, tz = cornerZ - mz;
        const tl = Math.hypot(tx, tz) || 1;
        for (let s = 0; s < edge.length - 1; s++) {
          const a: P2 = [edge[s][0], edge[s][2]], b: P2 = [edge[s + 1][0], edge[s + 1][2]];
          const top = Math.min(edge[s][1], edge[s + 1][1]);
          addWall(a, b, top, baseY, top, 0, [tx / tl, tz / tl]);
        }
      }
    }
  }

  return {
    positions: new Float32Array(pos),
    normals:   new Float32Array(nrm),
    depths:    new Float32Array(dep),
    water:     new Float32Array(wat),
    baseY,
    faceCount,
  };
}
