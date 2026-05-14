import type { HexCoord } from '../math/HexCoord.js';
import type { HexLayout } from '../math/HexLayout.js';
import { hexToWorld } from '../math/HexLayout.js';
import { hexToOffset } from '../math/HexCoord.js';

const ELEV_SCALE = 0.5;

type Pt3 = { x: number; y: number; z: number };

/**
 * Converts a hex cell path into a dense array of world-space points following a
 * smooth Catmull-Rom spline through the cell centres.
 *
 * Use this to draw a curved path preview line instead of straight segments
 * between cell centres. The returned points include the Y elevation of each
 * cell so the curve follows the terrain surface.
 *
 * Pass the result directly to a `THREE.BufferGeometry` `position` attribute to
 * render a `THREE.Line`, or feed it into your own tube/ribbon builder.
 *
 * @param path               - `HexCoord[]` path, e.g. from `findPath()`.
 * @param layout             - The same `HexLayout` used for rendering.
 * @param map                - Any object with a `getElevation(col, row)` method.
 * @param samplesPerSegment  - Control-point samples between each pair of cells. Default 8.
 *
 * @example
 * const pts = smoothPath(path, layout, map);
 * const positions = new Float32Array(pts.length * 3);
 * pts.forEach((p, i) => {
 *   positions[i * 3]     = p.x;
 *   positions[i * 3 + 1] = p.y + 0.15;  // float above terrain
 *   positions[i * 3 + 2] = p.z;
 * });
 * const geo = new THREE.BufferGeometry();
 * geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
 * const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffaa22 }));
 */
export function smoothPath(
  path: HexCoord[],
  layout: HexLayout,
  map: { getElevation(col: number, row: number): number },
  samplesPerSegment = 8,
): Array<{ x: number; y: number; z: number }> {
  if (path.length < 2) return [];

  const pts: Pt3[] = path.map(h => {
    const w   = hexToWorld(layout, h);
    const off = hexToOffset(h);
    return { x: w.x, y: map.getElevation(off.col, off.row) * ELEV_SCALE, z: w.z };
  });

  // Ghost end-points mirror the first and last real points so the spline
  // passes exactly through both endpoints.
  const p0g = mirror(pts[1], pts[0]);
  const png = mirror(pts[pts.length - 2], pts[pts.length - 1]);
  const all = [p0g, ...pts, png];

  const out: Pt3[] = [];
  for (let i = 1; i < all.length - 2; i++) {
    const p0 = all[i - 1], p1 = all[i], p2 = all[i + 1], p3 = all[i + 2];
    for (let s = 0; s < samplesPerSegment; s++) {
      out.push(catmullRom(p0, p1, p2, p3, s / samplesPerSegment));
    }
  }
  out.push(pts[pts.length - 1]);

  return out;
}

function mirror(a: Pt3, b: Pt3): Pt3 {
  return { x: 2 * b.x - a.x, y: 2 * b.y - a.y, z: 2 * b.z - a.z };
}

function catmullRom(p0: Pt3, p1: Pt3, p2: Pt3, p3: Pt3, t: number): Pt3 {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * ((2*p1.x) + (-p0.x+p2.x)*t + (2*p0.x-5*p1.x+4*p2.x-p3.x)*t2 + (-p0.x+3*p1.x-3*p2.x+p3.x)*t3),
    y: 0.5 * ((2*p1.y) + (-p0.y+p2.y)*t + (2*p0.y-5*p1.y+4*p2.y-p3.y)*t2 + (-p0.y+3*p1.y-3*p2.y+p3.y)*t3),
    z: 0.5 * ((2*p1.z) + (-p0.z+p2.z)*t + (2*p0.z-5*p1.z+4*p2.z-p3.z)*t2 + (-p0.z+3*p1.z-3*p2.z+p3.z)*t3),
  };
}
