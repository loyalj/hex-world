import * as THREE from 'three';
import type { HexLayout } from '../math/HexLayout.js';
import { worldToHex } from '../math/HexLayout.js';
import { hexToOffset } from '../math/HexCoord.js';

const _raycaster = new THREE.Raycaster();
const _ndc       = new THREE.Vector2();
const _plane     = new THREE.Plane();
const _hit       = new THREE.Vector3();
const _up        = new THREE.Vector3(0, 1, 0);
const _coplanar  = new THREE.Vector3();
const _hits:     THREE.Intersection[] = [];

/**
 * Converts a mouse position to a hex cell (col, row) by raycasting against a
 * horizontal plane at `planeY` (default 0).
 *
 * Returns null if the ray misses the plane or the hit is outside the map bounds.
 *
 * Safe to call on every mousemove — no heap allocation.
 *
 * @example
 * canvas.addEventListener('pointermove', e => {
 *   const cell = pickHex(e.clientX, e.clientY, renderer.domElement, camera, layout, map);
 *   if (cell) highlight(cell.col, cell.row);
 * });
 */
/**
 * Picks a hex cell by raycasting against the actual terrain meshes.
 * More accurate than pickHex (especially at low camera angles and over elevated terrain)
 * because it hits the real geometry rather than a flat plane.
 *
 * Pass `chunkManager.terrainMeshes` as the meshes argument.
 * Returns null if the ray misses all meshes or the hit is outside the map bounds.
 *
 * Safe to call on every frame — uses a pre-allocated hit buffer.
 *
 * @example
 * const cell = pickHexFromMeshes(e.clientX, e.clientY, renderer.domElement, camera, layout, map, chunkManager.terrainMeshes);
 */
export function pickHexFromMeshes(
  clientX: number,
  clientY: number,
  domElement: HTMLElement,
  camera: THREE.Camera,
  layout: HexLayout,
  map: { width: number; height: number },
  meshes: THREE.Mesh[],
): { col: number; row: number } | null {
  if (meshes.length === 0) return null;

  const rect = domElement.getBoundingClientRect();
  _ndc.set(
     ((clientX - rect.left) / rect.width)  * 2 - 1,
    -((clientY - rect.top)  / rect.height) * 2 + 1,
  );

  _raycaster.setFromCamera(_ndc, camera);
  _hits.length = 0;
  _raycaster.intersectObjects(meshes, false, _hits);
  if (_hits.length === 0) return null;

  const { x, z } = _hits[0].point;
  const hex = worldToHex(layout, x, z);
  const { col, row } = hexToOffset(hex);
  if (col < 0 || col >= map.width || row < 0 || row >= map.height) return null;

  return { col, row };
}

export function pickHex(
  clientX: number,
  clientY: number,
  domElement: HTMLElement,
  camera: THREE.Camera,
  layout: HexLayout,
  map: { width: number; height: number },
  planeY = 0,
): { col: number; row: number } | null {
  const rect = domElement.getBoundingClientRect();
  _ndc.set(
     ((clientX - rect.left) / rect.width)  * 2 - 1,
    -((clientY - rect.top)  / rect.height) * 2 + 1,
  );

  _raycaster.setFromCamera(_ndc, camera);
  _plane.setFromNormalAndCoplanarPoint(_up, _coplanar.set(0, planeY, 0));

  if (!_raycaster.ray.intersectPlane(_plane, _hit)) return null;

  const hex = worldToHex(layout, _hit.x, _hit.z);
  const { col, row } = hexToOffset(hex);
  if (col < 0 || col >= map.width || row < 0 || row >= map.height) return null;

  return { col, row };
}
