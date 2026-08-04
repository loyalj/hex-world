import * as THREE from 'three';
import type { HexLayout } from '../math/HexLayout.js';
import { hexToWorld, hexCorners } from '../math/HexLayout.js';
import { HEX_DIRECTIONS } from '../math/HexCoord.js';
import type { HexMap } from '../map/HexMap.js';
import { RIVER_SURFACE_ELEVATION_OFFSET, ELEVATION_SCALE } from '../map/HexCell.js';
import { DEFAULT_WATER_TERRAIN_INDEX } from './TerrainTypes.js';
import { sampleNoise } from '../math/Noise.js';
import type { ChunkBounds } from './HexChunk.js';
import { RIVER_BASE_HALF_WIDTH, riverWidthScale, riverEdgeFlow } from './RiverWidth.js';
import { createRiverCellFilter, type WaterGeometryOptions } from './WaterChunk.js';

/**
 * The fraction of the hex a cell's solid core occupies — the cliff lip sits on
 * this boundary and the sheet slides down the bridge strip beyond it. Must
 * stay in sync with SOLID_FACTOR in WaterChunk and HexChunkCore.
 */
const SOLID_FACTOR = 0.8;

/**
 * One rendered waterfall: the cliff edge a river channel pours over, resolved
 * to the world-space anchor its spray and plunge pool are built around.
 *
 * Produced by {@link findWaterfalls}, which mirrors the waterfall branch of
 * `buildRiverGeometry` exactly — including the terrain-matched vertex
 * perturbation — so the base point really is where the falling sheet lands.
 */
export interface WaterfallSite {
  /** Cell the water falls FROM (the lip). */
  col: number;
  row: number;
  /** Edge index (0–5) the river leaves through — the cliff edge. */
  edge: number;
  /** `row * map.width + col` of the lip cell — the fog-of-war cell index. */
  cellIndex: number;
  /** Cell index of the cell the water lands in (the lip's downstream neighbor). */
  baseCellIndex: number;
  /** World-space point where the sheet lands, centered across the channel. */
  baseX: number;
  baseY: number;
  baseZ: number;
  /** World Y of the cliff lip — the channel surface the sheet leaves from. */
  topY: number;
  /** Sheet width at the base, world units. */
  width: number;
  /** Vertical drop, world units (`topY - baseY`); always ≥ cliffThreshold × elevationScale. */
  drop: number;
  /** Unit XZ flow direction, lip → base. */
  dirX: number;
  dirZ: number;
  /** Accumulated flow at the lip cell (≥ 1); 1 when no flow map was supplied. */
  flow: number;
}

function neighborOffset(col: number, row: number, d: number): { col: number; row: number } {
  const q  = col - (row - (row & 1)) / 2;
  const nq = q  + HEX_DIRECTIONS[d].q;
  const nr = row + HEX_DIRECTIONS[d].r;
  return { col: nq + (nr - (nr & 1)) / 2, row: nr };
}

// ---------------------------------------------------------------------------
// Site detection
// ---------------------------------------------------------------------------

/**
 * Finds every waterfall this liquid renders inside `bounds`: river cells whose
 * outgoing edge drops at least `cliffThreshold` levels onto land (a drop into
 * standing water of this liquid is an estuary, not a fall, and is skipped).
 *
 * Pass the SAME {@link WaterGeometryOptions} handed to `buildRiverGeometry` —
 * the channel-ownership filter, flow-dependent widths, carved river
 * elevations, and terrain noise all have to agree, or the spray lands beside
 * the water instead of in it.
 */
export function findWaterfalls(
  map: HexMap,
  layout: HexLayout,
  bounds: ChunkBounds,
  opts: WaterGeometryOptions = {},
): WaterfallSite[] {
  const noiseScale     = opts.terrainNoiseScale      ?? 0.35;
  const perturbStr     = opts.terrainPerturbStrength ?? 0.8;
  const elevScale      = opts.elevationScale         ?? ELEVATION_SCALE;
  const cliffThreshold = opts.cliffThreshold         ?? 2;
  const riverElevs     = opts.riverElevations;
  const riverFlow      = opts.riverFlow;
  const edgeDirs       = layout.orientation.edgeDirections;
  const waterTerrains  = opts.waterTerrains ?? new Set([DEFAULT_WATER_TERRAIN_INDEX]);
  const rendersChannel = createRiverCellFilter(map, layout, opts);

  /** The same terrain-matched perturbation buildRiverGeometry applies to every channel vertex. */
  const perturbed = (x: number, z: number): [number, number] => {
    const n = sampleNoise(x * noiseScale, z * noiseScale);
    return [x + (n[0] * 2 - 1) * perturbStr, z + (n[2] * 2 - 1) * perturbStr];
  };

  const sites: WaterfallSite[] = [];
  const { colStart, colEnd, rowStart, rowEnd } = bounds;

  for (let row = rowStart; row < rowEnd; row++) {
    for (let col = colStart; col < colEnd; col++) {
      if (!map.inBounds(col, row)) continue;
      if (!rendersChannel(col, row)) continue;

      const edge = map.getOutgoingRiverDir(col, row);
      if (edge === -1 || !map.hasRiverThroughEdge(col, row, edge)) continue;

      const nb = neighborOffset(col, row, edgeDirs[edge]);
      if (!map.inBounds(nb.col, nb.row)) continue;
      // Falling into this liquid's own standing water is an estuary mouth —
      // buildRiverGeometry blends down to the body surface instead of
      // dropping a sheet, so there is nothing to spray.
      if (waterTerrains.has(map.getTerrain(nb.col, nb.row))) continue;

      const cellIndex     = row * map.width + col;
      const baseCellIndex = nb.row * map.width + nb.col;
      const ownElev = riverElevs?.get(cellIndex)     ?? map.getElevation(col, row);
      const nbElev  = riverElevs?.get(baseCellIndex) ?? map.getElevation(nb.col, nb.row);
      const topY  = (ownElev + RIVER_SURFACE_ELEVATION_OFFSET) * elevScale;
      const baseY = (nbElev  + RIVER_SURFACE_ELEVATION_OFFSET) * elevScale;
      if (topY - baseY < cliffThreshold * elevScale * 0.999) continue;

      // Channel span across the cliff edge, then the lip/base points of the
      // sheet — the same construction as the waterfall branch in
      // buildRiverGeometry (solid-hex boundary + bridge-strip translation).
      const q      = col - (row - (row & 1)) / 2;
      const center = hexToWorld(layout, { q, r: row });
      const crns   = hexCorners(layout, { q, r: row });
      const e1     = (edge + 1) % 6;

      const hw = riverFlow
        ? RIVER_BASE_HALF_WIDTH * riverWidthScale(riverEdgeFlow(map, riverFlow, col, row, edge, edgeDirs))
        : RIVER_BASE_HALF_WIDTH;
      const eLx = crns[edge].x + (crns[e1].x - crns[edge].x) * (0.5 - hw);
      const eLz = crns[edge].z + (crns[e1].z - crns[edge].z) * (0.5 - hw);
      const eRx = crns[edge].x + (crns[e1].x - crns[edge].x) * (0.5 + hw);
      const eRz = crns[edge].z + (crns[e1].z - crns[edge].z) * (0.5 + hw);

      const wLx = center.x + (eLx - center.x) * SOLID_FACTOR, wLz = center.z + (eLz - center.z) * SOLID_FACTOR;
      const wRx = center.x + (eRx - center.x) * SOLID_FACTOR, wRz = center.z + (eRz - center.z) * SOLID_FACTOR;
      const bwx = (crns[edge].x - center.x + crns[e1].x - center.x) * (1 - SOLID_FACTOR);
      const bwz = (crns[edge].z - center.z + crns[e1].z - center.z) * (1 - SOLID_FACTOR);

      const [lipLx, lipLz] = perturbed(wLx, wLz);
      const [lipRx, lipRz] = perturbed(wRx, wRz);
      const [basLx, basLz] = perturbed(wLx + bwx, wLz + bwz);
      const [basRx, basRz] = perturbed(wRx + bwx, wRz + bwz);

      const baseX = (basLx + basRx) * 0.5, baseZ = (basLz + basRz) * 0.5;
      const lipX  = (lipLx + lipRx) * 0.5, lipZ  = (lipLz + lipRz) * 0.5;

      let dirX = baseX - lipX, dirZ = baseZ - lipZ;
      let len  = Math.hypot(dirX, dirZ);
      if (len < 1e-6) { dirX = bwx; dirZ = bwz; len = Math.hypot(dirX, dirZ) || 1; }
      dirX /= len; dirZ /= len;

      sites.push({
        col, row, edge, cellIndex, baseCellIndex,
        baseX, baseY, baseZ,
        topY,
        width: Math.hypot(basRx - basLx, basRz - basLz),
        drop:  topY - baseY,
        dirX, dirZ,
        flow: riverFlow?.get(cellIndex) ?? 1,
      });
    }
  }

  return sites;
}

// ---------------------------------------------------------------------------
// Plunge-pool foam
// ---------------------------------------------------------------------------

export interface WaterfallFoamOptions {
  /** Lift above the receiving water surface, world units. Default 0.04. */
  lift?: number;
  /**
   * Uniform multiplier on the pool footprint — the per-liquid knob
   * (`LiquidTypeDescriptor.poolScale`). Applied on top of `widthScale` and
   * `lengthScale`, so a liquid can tighten or spread its churn without
   * restating the shape. Default 1.
   */
  scale?: number;
  /** Pool half-span across the flow, as a multiple of the sheet width. Default 0.8. */
  widthScale?: number;
  /** Pool half-span along the flow, as a multiple of the sheet width. Default 1.2. */
  lengthScale?: number;
  /** How far downstream of the impact point the pool is centered, × sheet width. Default 0.45. */
  offset?: number;
  /** Radial segments per pool. Default 14. */
  segments?: number;
}

/**
 * Builds the churning foam pool at the foot of each fall: a flat elliptical
 * fan hugging the receiving channel, wider across than the sheet and stretched
 * downstream, lying just above the water it lands in.
 *
 * UVs carry the polar coordinates the foam shader animates in — `u` is the
 * angle around the impact point, `v` the normalised radius (0 at the impact
 * point, 1 at the rim, where alpha reaches zero). World-space, like every
 * other chunk geometry.
 */
export function buildWaterfallFoamGeometry(
  sites: readonly WaterfallSite[],
  opts: WaterfallFoamOptions = {},
): THREE.BufferGeometry | null {
  if (sites.length === 0) return null;

  const lift    = opts.lift        ?? 0.04;
  const scale   = Math.max(0, opts.scale ?? 1);
  const across  = (opts.widthScale  ?? 0.8) * scale;
  const along   = (opts.lengthScale ?? 1.2) * scale;
  const offset  = (opts.offset      ?? 0.45) * scale;
  const segs    = Math.max(6, Math.round(opts.segments ?? 14));

  // Center + two rings (mid, rim); center fan plus a ring-to-ring band.
  const vertsPerSite   = 1 + segs * 2;
  const indicesPerSite = segs * 3 * 3;
  const vertCount      = sites.length * vertsPerSite;

  const positions   = new Float32Array(vertCount * 3);
  const uvs         = new Float32Array(vertCount * 2);
  const cellIndices = new Float32Array(vertCount);
  const indices     = vertCount > 65535
    ? new Uint32Array(sites.length * indicesPerSite)
    : new Uint16Array(sites.length * indicesPerSite);

  let vi = 0, uvi = 0, cii = 0, ii = 0, base = 0;

  for (const s of sites) {
    const fx = s.dirX, fz = s.dirZ;      // downstream
    const rx = -s.dirZ, rz = s.dirX;     // across the channel
    const cx = s.baseX + fx * s.width * offset;
    const cz = s.baseZ + fz * s.width * offset;
    const y  = s.baseY + lift;

    const push = (x: number, z: number, u: number, v: number): void => {
      positions[vi++] = x; positions[vi++] = y; positions[vi++] = z;
      uvs[uvi++] = u; uvs[uvi++] = v;
      cellIndices[cii++] = s.baseCellIndex;
    };

    push(cx, cz, 0.5, 0);
    for (const ring of [0.5, 1.0]) {
      for (let k = 0; k < segs; k++) {
        const a  = (k / segs) * Math.PI * 2;
        const lx = Math.cos(a) * across * s.width * ring;
        const lz = Math.sin(a) * along  * s.width * ring;
        push(cx + rx * lx + fx * lz, cz + rz * lx + fz * lz, k / segs, ring);
      }
    }

    const mid = base + 1;
    const rim = base + 1 + segs;
    for (let k = 0; k < segs; k++) {
      const k1 = (k + 1) % segs;
      indices[ii++] = base;      indices[ii++] = mid + k1;  indices[ii++] = mid + k;
      indices[ii++] = mid + k;   indices[ii++] = mid + k1;  indices[ii++] = rim + k1;
      indices[ii++] = mid + k;   indices[ii++] = rim + k1;  indices[ii++] = rim + k;
    }
    base += vertsPerSite;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',  new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv',        new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('cellIndex', new THREE.BufferAttribute(cellIndices, 1));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

// ---------------------------------------------------------------------------
// Spray / mist particles
// ---------------------------------------------------------------------------

export interface WaterfallSprayOptions {
  /** Density multiplier; 0 emits nothing. Default 1. */
  intensity?: number;
  /** Particles emitted by an average fall at intensity 1. Default 26. */
  particlesPerSite?: number;
  /** Hard cap per fall, so a huge river doesn't blow the budget. Default 128. */
  maxPerSite?: number;
}

/**
 * Integer hash → [0,1). Spray seeds are derived from the cell, the cliff edge,
 * and the particle index rather than `Math.random`, so a chunk rebuilt after
 * an edit re-emits the identical cloud instead of reshuffling it.
 */
function hash01(n: number): number {
  let x = n | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = x ^ (x >>> 16);
  return (x >>> 0) / 4294967296;
}

/**
 * Builds the mist cloud for a set of falls as a single `THREE.Points`
 * geometry. Every particle is a seed plus its fall's parameters; the whole
 * animation (spawn point, ballistic arc, growth, fade) runs in the spray
 * material's vertex shader from one time uniform, so there is no per-frame CPU
 * cost and no CPU-side particle state to keep in sync with chunk streaming.
 *
 * Attributes: `position` (the impact point), `aSeed`, `aSite`
 * (flow direction xz, channel half-width, drop height), and `cellIndex` for
 * fog-of-war. The bounding sphere is inflated to cover the shader's
 * displacement so frustum culling stays honest.
 */
export function buildWaterfallSprayGeometry(
  sites: readonly WaterfallSite[],
  opts: WaterfallSprayOptions = {},
): THREE.BufferGeometry | null {
  const intensity = opts.intensity ?? 1;
  if (sites.length === 0 || intensity <= 0) return null;

  const per = opts.particlesPerSite ?? 26;
  const cap = opts.maxPerSite       ?? 128;

  // Bigger falls throw more water: scale with the drop and the channel width.
  const countFor = (s: WaterfallSite): number => {
    const n = per * intensity * (0.55 + 0.3 * s.drop) * (0.7 + s.width);
    return Math.min(cap, Math.max(4, Math.round(n)));
  };

  let total = 0;
  for (const s of sites) total += countFor(s);
  if (total === 0) return null;

  const positions   = new Float32Array(total * 3);
  const seeds       = new Float32Array(total);
  const params      = new Float32Array(total * 4);
  const cellIndices = new Float32Array(total);

  let p = 0;
  for (const s of sites) {
    const n = countFor(s);
    for (let i = 0; i < n; i++) {
      positions[p * 3]     = s.baseX;
      positions[p * 3 + 1] = s.baseY;
      positions[p * 3 + 2] = s.baseZ;
      seeds[p] = hash01(Math.imul(s.cellIndex * 6 + s.edge, 2654435761) + i * 40503);
      params[p * 4]     = s.dirX;
      params[p * 4 + 1] = s.dirZ;
      params[p * 4 + 2] = s.width * 0.5;
      params[p * 4 + 3] = s.drop;
      cellIndices[p]    = s.baseCellIndex;
      p++;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',  new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSeed',     new THREE.BufferAttribute(seeds, 1));
  geo.setAttribute('aSite',     new THREE.BufferAttribute(params, 4));
  geo.setAttribute('cellIndex', new THREE.BufferAttribute(cellIndices, 1));

  // Particles climb the cliff face and arc above the impact point; widen the
  // sphere by the tallest fall so a visible cloud is never culled with its
  // (much smaller) emitter footprint.
  geo.computeBoundingSphere();
  if (geo.boundingSphere) {
    let maxDrop = 0;
    for (const s of sites) maxDrop = Math.max(maxDrop, s.drop);
    geo.boundingSphere.radius += maxDrop + 1.5;
  }
  return geo;
}
