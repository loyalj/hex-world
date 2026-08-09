import * as THREE from 'three';

/** A camera that can unproject — perspective or orthographic. */
export type ProjectingCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

export interface GroundFootprintOptions {
  /** Height of the ground plane. Default: 0. */
  y?: number;
  /**
   * How far from the camera a corner may land before it is clamped, in world
   * units. Corners near or above the horizon project to enormous distances (or
   * miss the plane entirely) — clamping keeps the footprint a usable shape
   * instead of dropping it. Default: the camera's far plane.
   */
  maxDistance?: number;
}

const _near   = new THREE.Vector3();
const _far    = new THREE.Vector3();
const _dir    = new THREE.Vector3();
const _camPos = new THREE.Vector3();

/** Screen corners in NDC, clockwise from top-left. */
const NDC_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-1,  1],
  [ 1,  1],
  [ 1, -1],
  [-1, -1],
];

/**
 * Projects a normalized-device-coordinate point (−1…1 on both axes, +Y up)
 * through the camera onto a horizontal plane.
 *
 * Returns `null` when the ray is parallel to the plane or points away from it —
 * i.e. the pixel shows sky, not ground.
 *
 * @example
 * const ndcX = (event.offsetX / rect.width)  * 2 - 1;
 * const ndcY = (event.offsetY / rect.height) * -2 + 1;
 * const hit  = groundPointFromNdc(camera, ndcX, ndcY);
 */
export function groundPointFromNdc(
  camera: ProjectingCamera,
  ndcX:   number,
  ndcY:   number,
  y      = 0,
  out    = new THREE.Vector3(),
): THREE.Vector3 | null {
  _near.set(ndcX, ndcY, -1).unproject(camera);
  _far .set(ndcX, ndcY,  1).unproject(camera);
  _dir .copy(_far).sub(_near);
  if (Math.abs(_dir.y) < 1e-9) return null;
  const t = (y - _near.y) / _dir.y;
  if (t < 0) return null;
  return out.copy(_dir).multiplyScalar(t).add(_near);
}

/**
 * Returns the four ground-plane points the camera's view frustum covers, in
 * screen order: top-left, top-right, bottom-right, bottom-left.
 *
 * This is the shape to outline on a minimap to show "what you are looking at".
 * Corners that would land past `maxDistance` (or above the horizon) are clamped
 * along their own ray, so the polygon stays well-formed at shallow pitches
 * rather than vanishing.
 *
 * Returns `null` when the camera is at or below the ground plane, where a
 * footprint is meaningless.
 *
 * @example
 * const quad = cameraGroundFootprint(world.camera);
 * if (quad) for (const p of quad) transform.worldToImage(p.x, p.z);
 */
export function cameraGroundFootprint(
  camera:   ProjectingCamera,
  options?: GroundFootprintOptions,
  out?:     THREE.Vector3[],
): THREE.Vector3[] | null {
  const y = options?.y ?? 0;
  camera.getWorldPosition(_camPos);
  if (_camPos.y <= y) return null;

  const maxDistance = options?.maxDistance ?? camera.far;
  const points = out && out.length === 4 ? out : [
    new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
  ];

  for (let i = 0; i < 4; i++) {
    const [nx, ny] = NDC_CORNERS[i];
    const p = points[i];
    if (groundPointFromNdc(camera, nx, ny, y, p) && _camPos.distanceTo(p) <= maxDistance) continue;

    // Missed, or landed too far to be useful: walk maxDistance along the ray
    // and drop the result onto the plane, keeping the corner's direction.
    _near.set(nx, ny, -1).unproject(camera);
    _far .set(nx, ny,  1).unproject(camera);
    _dir .copy(_far).sub(_near).normalize();
    p.copy(_dir).multiplyScalar(maxDistance).add(_camPos);
    p.y = y;
  }

  return points;
}
