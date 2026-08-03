import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createLayout, hexToWorld, hexCorner } from '../src/math/HexLayout.js';
import { POINTY_TOP, FLAT_TOP } from '../src/math/HexOrientation.js';
import {
  createTerrainMaterial, configureTerrainGrid, setTerrainGridEnabled,
} from '../src/geometry/TerrainMaterial.js';

function makeMaterial(): THREE.ShaderMaterial {
  const tex = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
  return createTerrainMaterial(tex);
}

/**
 * JS mirror of the shader's hexGridLine lattice math (up to the AA smoothstep):
 * returns the world-space distance from p to the nearest hex border, given the
 * uGridFwd/uGridInv/uGridOrigin uniform values.
 */
function edgeDistance(u: Record<string, { value: any }>, px: number, pz: number): number {
  const fwd = u.uGridFwd.value as THREE.Vector4;
  const inv = u.uGridInv.value as THREE.Vector4;
  const org = u.uGridOrigin.value as THREE.Vector2;

  const lx = px - org.x, lz = pz - org.y;
  const q  = inv.x * lx + inv.y * lz;
  const r  = inv.z * lx + inv.w * lz;

  // cube round
  const y = -q - r;
  let rq = Math.round(q); const ry = Math.round(y); let rr = Math.round(r);
  const dq = Math.abs(rq - q), dy = Math.abs(ry - y), dr = Math.abs(rr - r);
  if (dq > dy && dq > dr) rq = -ry - rr;
  else if (dr > dy)       rr = -rq - ry;

  const cx = fwd.x * rq + fwd.y * rr + org.x;
  const cz = fwd.z * rq + fwd.w * rr + org.y;
  const ox = px - cx, oz = pz - cz;

  const axes = [
    [fwd.x, fwd.z],                   // axial (1, 0)
    [fwd.y, fwd.w],                   // axial (0, 1)
    [fwd.x - fwd.y, fwd.z - fwd.w],   // axial (1, -1)
  ];
  let d = 0;
  for (const [ax, az] of axes) {
    const len = Math.hypot(ax, az);
    d = Math.max(d, Math.abs((ox * ax + oz * az) / len));
  }
  const apothem = 0.5 * Math.hypot(fwd.x, fwd.z);
  return apothem - d;
}

describe('terrain hex grid overlay', () => {
  it('starts disabled with all grid uniforms present', () => {
    const mat = makeMaterial();
    expect(mat.uniforms.uGridEnabled.value).toBe(0);
    for (const name of ['uGridFwd', 'uGridInv', 'uGridOrigin', 'uGridColor',
                        'uGridOpacity', 'uGridLineWidth', 'uGridFadeStart', 'uGridFadeEnd']) {
      expect(mat.uniforms[name]).toBeDefined();
    }
  });

  it('configureTerrainGrid enables and applies styling; setTerrainGridEnabled toggles', () => {
    const mat    = makeMaterial();
    const layout = createLayout(POINTY_TOP, 1);
    configureTerrainGrid(mat, layout, { color: 0xff0000, opacity: 0.2, lineWidth: 0.1, fadeStart: 10, fadeEnd: 40 });
    expect(mat.uniforms.uGridEnabled.value).toBe(1);
    expect(mat.uniforms.uGridOpacity.value).toBe(0.2);
    expect(mat.uniforms.uGridLineWidth.value).toBe(0.1);
    expect(mat.uniforms.uGridFadeStart.value).toBe(10);
    expect(mat.uniforms.uGridFadeEnd.value).toBe(40);
    setTerrainGridEnabled(mat, false);
    expect(mat.uniforms.uGridEnabled.value).toBe(0);
    setTerrainGridEnabled(mat, true);
    expect(mat.uniforms.uGridEnabled.value).toBe(1);
  });

  describe.each([
    ['pointy-top', POINTY_TOP],
    ['flat-top',   FLAT_TOP],
  ] as const)('lattice math (%s)', (_name, orientation) => {
    it('cell centers are apothem-deep, edge midpoints on the border, for offset layouts too', () => {
      const mat    = makeMaterial();
      const layout = createLayout(orientation, 2, 5, -3);
      configureTerrainGrid(mat, layout);
      const u = mat.uniforms;

      const apothem = Math.sqrt(3) / 2 * layout.size;

      for (const h of [{ q: 0, r: 0 }, { q: 3, r: -1 }, { q: -2, r: 4 }]) {
        const c = hexToWorld(layout, h);
        expect(edgeDistance(u, c.x, c.z)).toBeCloseTo(apothem, 5);

        // Midpoint of each edge (between consecutive corners) lies on the border.
        for (let corner = 0; corner < 6; corner++) {
          const a = hexCorner(layout, h, corner);
          const b = hexCorner(layout, h, (corner + 1) % 6);
          const d = edgeDistance(u, (a.x + b.x) / 2, (a.z + b.z) / 2);
          expect(Math.abs(d)).toBeLessThan(1e-6);
        }
      }
    });

    it('the edge-distance field is continuous across the border between two cells', () => {
      const mat    = makeMaterial();
      const layout = createLayout(orientation, 1.5);
      configureTerrainGrid(mat, layout);
      const u = mat.uniforms;

      // Walk across an edge midpoint along the center-to-center axis: distance
      // should shrink to 0 at the border and grow again on the far side.
      const a = hexToWorld(layout, { q: 0, r: 0 });
      const b = hexToWorld(layout, { q: 1, r: 0 });
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      const step = { x: (b.x - a.x) / 100, z: (b.z - a.z) / 100 };

      const before = edgeDistance(u, mid.x - step.x, mid.z - step.z);
      const at     = edgeDistance(u, mid.x, mid.z);
      const after  = edgeDistance(u, mid.x + step.x, mid.z + step.z);
      expect(at).toBeLessThan(before);
      expect(at).toBeLessThan(after);
      expect(Math.abs(before - after)).toBeLessThan(1e-6); // symmetric across the border
    });
  });
});
