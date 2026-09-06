import * as THREE from 'three';
import { mergeColored, fitHeight, BROADLEAF_TRUNK_COLOR, BROADLEAF_CANOPY_COLOR, BUSH_COLOR, SMOKE_COLOR } from './ScatterShapes.js';

/**
 * Scatter shapes as **data**.
 *
 * A recipe is a list of primitive parts — cones, spheres, lobes, boxes,
 * cylinders, bent segments, fronds, rocks — each with a size, an offset, a
 * colour, and a role, merged into one vertex-coloured geometry and fitted to
 * an overall height. It is what the built-in plants were already doing in
 * code (see `ScatterShapes.ts`), written down so a map builder can compose a
 * new plant in an editor, and so the shape travels in a save file or a
 * `.hexpack` alongside the descriptor that places it.
 *
 * Roles matter beyond the picture. `attachSeasonalTint` finds foliage by
 * its colour, and {@link recipeFoliageColor} hands it the first `canopy`
 * part's colour as the summer reference, which is how a recipe's broadleaf
 * turns gold in autumn while its trunk does not.
 *
 * The `repeat` modifier stamps a part around the Y axis — fronds around a
 * palm's crown, branches around a dead tree, leaves around an agave — and
 * keeps the recipe small: a sparse tier can lower the count rather than
 * scale a copy.
 */

export type ScatterPrimitive =
  | 'cone' | 'sphere' | 'lobe' | 'box' | 'cylinder' | 'segment' | 'frond' | 'rock';

export type ScatterPartRole = 'trunk' | 'canopy' | 'body';

export interface ScatterRepeat {
  /** Copies around the Y axis through the part's position. */
  count: number;
  /** Outward offset from that axis for each copy. Default 0. */
  radius?: number;
  /**
   * Tilt of each copy away from vertical, degrees: 0 points straight up,
   * 90 lies flat, more than 90 hangs. Default 0.
   */
  droop?: number;
  /** Random variation, 0–1, applied to each copy's angle, droop, and size. Deterministic per recipe. Default 0. */
  jitter?: number;
  /** Rotation of the whole ring, degrees. Default 0. */
  phase?: number;
}

export interface ScatterRecipePart {
  primitive: ScatterPrimitive;
  /**
   * Size as `[width, height, depth]` in recipe units (the recipe is fitted
   * to its `height` afterwards, so these are proportions). A single number
   * is uniform.
   */
  size: number | [number, number, number];
  /** Offset of the part's base (its lowest point on its own axis) from the recipe origin. Default `[0, 0, 0]`. */
  position?: [number, number, number];
  /** Euler rotation in degrees, applied before the position. */
  rotation?: [number, number, number];
  /** Hex colour. */
  color: number;
  role?: ScatterPartRole;
  /**
   * Detail: radial segments for cones, cylinders, and segments (default 7),
   * subdivision level for spheres and lobes (default 0).
   */
  detail?: number;
  /**
   * For `segment`: how far the piece bends over its length, degrees, leaning
   * toward +X before rotation. For `frond`: how far the tip droops below the
   * base direction, degrees. Default 0.
   */
  bend?: number;
  repeat?: ScatterRepeat;
}

export interface ScatterRecipe {
  /** Overall height in world units, base to top, after the parts are merged. */
  height: number;
  parts: ScatterRecipePart[];
  /** Seed for the deterministic jitter in `repeat`. Default 1. */
  seed?: number;
}

const DEG = Math.PI / 180;

/** Small deterministic generator so a recipe's jitter is the same on every build. */
function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function sizeOf(part: ScatterRecipePart): [number, number, number] {
  return typeof part.size === 'number' ? [part.size, part.size, part.size] : part.size;
}

/**
 * A bent cylinder: the spine is an arc of angle `bend`, leaning toward +X,
 * with the cross-section kept perpendicular to it. Built along +Y from the
 * origin like every other primitive.
 */
function makeSegment(w: number, h: number, d: number, bendDeg: number, radial: number): THREE.BufferGeometry {
  const rings = 6;
  const geometry = new THREE.CylinderGeometry(w * 0.4, w * 0.5, h, radial, rings);
  geometry.translate(0, h / 2, 0);
  geometry.scale(1, 1, d / w);
  const bend = bendDeg * DEG;
  if (Math.abs(bend) > 1e-4) {
    const R   = h / bend;
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const t     = Math.max(0, Math.min(1, y / h));
      const theta = t * bend;
      const sx = R * (1 - Math.cos(theta));
      const sy = R * Math.sin(theta);
      // Cross-section axis perpendicular to the tangent (sin θ, cos θ).
      pos.setXYZ(i, sx + x * Math.cos(theta), sy - x * Math.sin(theta), z);
    }
    pos.needsUpdate = true;
  }
  return geometry;
}

/**
 * A tapered leaf blade growing along +Y from the origin, `w` wide at the
 * base and pointed at the tip, drooping toward +Z by `bend` degrees over its
 * length. Two-sided by nature: pair it with a `doubleSide` material.
 */
function makeFrond(w: number, h: number, bendDeg: number): THREE.BufferGeometry {
  const segs = 5;
  const bend = bendDeg * DEG;
  const positions: number[] = [];
  const rings: [number, number, number][][] = [];
  let y = 0, z = 0;
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    // Width swells a little past the base, then tapers to a point.
    const half = w * 0.5 * Math.sin(Math.min(1, t * 1.15 + 0.15) * Math.PI) ;
    rings.push([[-half, y, z], [half, y, z]]);
    // Advance along the drooping direction for the next ring.
    const ang = bend * (s + 0.5) / segs;
    y += (h / segs) * Math.cos(ang);
    z += (h / segs) * Math.sin(ang);
  }
  for (let s = 0; s < segs; s++) {
    const [l0, r0] = rings[s], [l1, r1] = rings[s + 1];
    positions.push(...l0, ...r0, ...l1, ...r0, ...r1, ...l1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  return geometry;
}

function makePrimitive(part: ScatterRecipePart): THREE.BufferGeometry {
  const [w, h, d] = sizeOf(part);
  const radial = part.detail ?? 7;
  const sub    = Math.max(0, Math.min(2, Math.round(part.detail ?? 0)));
  let g: THREE.BufferGeometry;
  switch (part.primitive) {
    case 'cone':
      g = new THREE.ConeGeometry(0.5, 1, radial); g.translate(0, 0.5, 0); g.scale(w, h, d); break;
    case 'sphere':
      g = new THREE.IcosahedronGeometry(0.5, sub); g.translate(0, 0.5, 0); g.scale(w, h, d); break;
    case 'lobe':
      // A sphere squashed to a bush lobe; a plain number size gives the 62% flattening the built-in bush uses.
      g = new THREE.IcosahedronGeometry(0.5, sub); g.translate(0, 0.5, 0);
      g.scale(w, typeof part.size === 'number' ? h * 0.62 : h, d); break;
    case 'box':
      g = new THREE.BoxGeometry(w, h, d); g.translate(0, h / 2, 0); break;
    case 'cylinder':
      g = new THREE.CylinderGeometry(w * 0.4, w * 0.5, h, radial); g.translate(0, h / 2, 0); g.scale(1, 1, d / w); break;
    case 'segment':
      g = makeSegment(w, h, d, part.bend ?? 0, radial); break;
    case 'frond':
      g = makeFrond(w, h, part.bend ?? 0); break;
    case 'rock':
      g = new THREE.DodecahedronGeometry(0.5, 0); g.translate(0, 0.5, 0); g.scale(w, h, d); break;
  }
  if (part.rotation) {
    const [rx, ry, rz] = part.rotation;
    g.rotateX(rx * DEG); g.rotateY(ry * DEG); g.rotateZ(rz * DEG);
  }
  return g;
}

/**
 * Build a recipe into one merged, vertex-coloured, ground-seated geometry
 * fitted to `recipe.height × scale`. Deterministic: the same recipe gives
 * the same vertices every time, which the chunk streamer relies on.
 */
export function buildShapeGeometry(recipe: ScatterRecipe, scale = 1): THREE.BufferGeometry {
  const rand = lcg(recipe.seed ?? 1);
  const pieces: { geometry: THREE.BufferGeometry; color: THREE.Color }[] = [];

  for (const part of recipe.parts) {
    const base  = makePrimitive(part);
    const color = new THREE.Color(part.color);
    const [px, py, pz] = part.position ?? [0, 0, 0];

    if (!part.repeat || part.repeat.count <= 1) {
      base.translate(px, py, pz);
      pieces.push({ geometry: base, color });
      continue;
    }

    const rep    = part.repeat;
    const jitter = rep.jitter ?? 0;
    const step   = (Math.PI * 2) / rep.count;
    for (let i = 0; i < rep.count; i++) {
      const copy  = base.clone();
      const j     = (rand() - 0.5) * 2 * jitter;
      const droop = ((rep.droop ?? 0) + j * 25) * DEG;
      const angle = (rep.phase ?? 0) * DEG + i * step + j * step * 0.5;
      const s     = 1 + j * 0.35;
      copy.scale(s, s, s);
      // Tilt the part's +Y toward +Z by the droop, then swing it round the
      // axis and push it out by the radius along the same bearing.
      copy.rotateX(droop);
      copy.rotateY(-angle);
      const r = rep.radius ?? 0;
      copy.translate(px + Math.sin(angle) * r, py, pz + Math.cos(angle) * r);
      pieces.push({ geometry: copy, color: color.clone().multiplyScalar(1 + j * 0.15) });
    }
    base.dispose();
  }

  const merged = mergeColored(pieces);
  for (const p of pieces) p.geometry.dispose();
  return fitHeight(merged, recipe.height * scale);
}

/** The colour `attachSeasonalTint` should treat as summer for this recipe: its first canopy part's. */
export function recipeFoliageColor(recipe: ScatterRecipe): number | undefined {
  return recipe.parts.find(p => p.role === 'canopy')?.color;
}

// ---------------------------------------------------------------------------
// Built-in recipes — the shapes `ScatterShapes.ts` draws in code, as data.
// ---------------------------------------------------------------------------

export const PINE_RECIPE: ScatterRecipe = {
  height: 2,
  parts: [{ primitive: 'cone', size: [0.42, 1, 0.42], color: 0x2f6b3a, role: 'canopy', detail: 7 }],
};

export const BROADLEAF_RECIPE: ScatterRecipe = {
  height: 1.8,
  parts: [
    { primitive: 'cylinder', size: [0.13, 0.47, 0.13], color: BROADLEAF_TRUNK_COLOR, role: 'trunk', detail: 5 },
    { primitive: 'sphere', size: [0.68, 0.58, 0.68], position: [0, 0.4, 0],       color: BROADLEAF_CANOPY_COLOR, role: 'canopy' },
    { primitive: 'sphere', size: [0.42, 0.42, 0.42], position: [0.14, 0.58, -0.07], color: BROADLEAF_CANOPY_COLOR, role: 'canopy' },
  ],
};

export const BUSH_RECIPE: ScatterRecipe = {
  height: 0.42,
  parts: [
    { primitive: 'lobe', size: 0.68, position: [0, 0, 0],          color: BUSH_COLOR, role: 'canopy' },
    { primitive: 'lobe', size: 0.49, position: [0.17, 0, 0.07],    color: BUSH_COLOR, role: 'canopy' },
    { primitive: 'lobe', size: 0.45, position: [-0.14, 0, -0.13],  color: BUSH_COLOR, role: 'canopy' },
  ],
};

export const ROCK_RECIPE: ScatterRecipe = {
  height: 0.5,
  parts: [{ primitive: 'rock', size: [0.56, 0.5, 0.56], color: 0x888880, role: 'body' }],
};

export const SMOKE_RECIPE: ScatterRecipe = {
  height: 2.4,
  parts: [0.55, 0.75, 0.95, 1.15, 1.3].map((s, i) => ({
    primitive: 'sphere' as const,
    size: [0.17 * s, 0.136 * s, 0.17 * s] as [number, number, number],
    position: [[0, 0.04, 0.11, 0.2, 0.31][i], [0.06, 0.24, 0.46, 0.7, 0.92][i], [0, -0.02, 0.03, -0.04, 0.05][i]] as [number, number, number],
    color: new THREE.Color(SMOKE_COLOR).multiplyScalar([0.55, 0.68, 0.82, 0.94, 1][i]).getHex(),
    role: 'body' as const,
    detail: 1,
  })),
};

/**
 * A palm: a trunk bent 25° with a crown of eight drooping fronds at its tip
 * and a few coconuts under them. The crown position is the arc's endpoint
 * for that bend (R = h / θ; x = R(1 − cos θ), y = R sin θ).
 */
export const PALM_RECIPE: ScatterRecipe = {
  height: 2.6,
  seed: 7,
  parts: [
    { primitive: 'segment', size: [0.11, 0.62, 0.11], bend: 25, color: 0x8a6a48, role: 'trunk', detail: 6 },
    { primitive: 'frond', size: [0.16, 0.46, 1], bend: 40, color: 0x4f9a3c, role: 'canopy',
      position: [0.133, 0.58, 0], repeat: { count: 8, radius: 0.03, droop: 42, jitter: 0.25 } },
    { primitive: 'sphere', size: 0.07, color: 0x5a3d22, role: 'trunk',
      position: [0.133, 0.55, 0], repeat: { count: 3, radius: 0.05, droop: 100, jitter: 0.3 } },
  ],
};
