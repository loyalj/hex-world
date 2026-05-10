import * as THREE from 'three';
import type { HexLayout } from '../math/HexLayout.js';
import { hexToWorld, hexCorners } from '../math/HexLayout.js';
import type { HexCoord } from '../math/HexCoord.js';

/**
 * Builds a BufferGeometry for a single flat hex (no elevation).
 * 6 triangles from center — 18 vertices (not indexed, for simplicity).
 */
export function buildHexGeometry(layout: HexLayout, hex: HexCoord): THREE.BufferGeometry {
  const center = hexToWorld(layout, hex);
  const corners = hexCorners(layout, hex);

  // 6 tris × 3 verts × 3 components (x,y,z)
  const positions = new Float32Array(6 * 3 * 3);
  const normals   = new Float32Array(6 * 3 * 3);

  for (let i = 0; i < 6; i++) {
    const c0 = corners[i];
    const c1 = corners[(i + 1) % 6];
    const base = i * 9;

    positions[base + 0] = center.x; positions[base + 1] = 0; positions[base + 2] = center.z;
    positions[base + 3] = c1.x;     positions[base + 4] = 0; positions[base + 5] = c1.z;
    positions[base + 6] = c0.x;     positions[base + 7] = 0; positions[base + 8] = c0.z;

    // All normals point up
    normals[base + 1] = 1; normals[base + 4] = 1; normals[base + 7] = 1;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return geo;
}
