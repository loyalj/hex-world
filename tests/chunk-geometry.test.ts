import { describe, it, expect } from 'vitest';
import { HexMap } from '../src/map/HexMap.js';
import { buildChunkGeometry } from '../src/geometry/HexChunk.js';
import { createLayout, hexToWorld } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';
import { offsetToHex } from '../src/math/HexCoord.js';

describe('buildChunkGeometry scratch buffer reuse', () => {
  const layout = createLayout(POINTY_TOP, 1);

  function makeMap(): HexMap {
    const m = new HexMap({ width: 16, height: 16 });
    for (let r = 0; r < 16; r++) for (let c = 0; c < 16; c++) m.setElevation(c, r, (c + r) % 4);
    return m;
  }
  const bounds = { colStart: 0, colEnd: 16, rowStart: 0, rowEnd: 16 };

  it('returns right-sized attribute buffers (no retained scratch view)', () => {
    const g = buildChunkGeometry(makeMap(), layout, bounds, {});
    const pos = g.terrain.getAttribute('position');
    expect(pos.array.buffer.byteLength).toBe((pos.array as Float32Array).byteLength);
  });

  // Every junction configuration must fully tile the cell when projected to
  // 2D — no coverage holes (see-through stars) and no reversed winding.
  it.each([
    { name: 'Y junction',        ins: [3, 5],       out: 0 },
    { name: 'adjacent inflows',  ins: [2, 3],       out: 0 },
    { name: 'T junction',        ins: [2, 4],       out: 0 },
    { name: '4-way junction',    ins: [1, 3, 5],    out: 0 },
    { name: '5-way junction',    ins: [1, 2, 3, 4], out: 0 },
  ])('tiles the cell without holes: $name', ({ ins, out }) => {
    const m = new HexMap({ width: 16, height: 16 });
    for (let r = 0; r < 16; r++) for (let c = 0; c < 16; c++) m.setElevation(c, r, 2);
    for (const e of ins) m.setRiverIncoming(8, 8, e);
    m.setRiverOutgoing(8, 8, out);

    const geo = buildChunkGeometry(m, layout, { colStart: 0, colEnd: 16, rowStart: 0, rowEnd: 16 }, {});
    const pos = geo.terrain.getAttribute('position').array as Float32Array;
    const center = hexToWorld(layout, offsetToHex(8, 8));

    // Triangles near the junction cell, projected to XZ.
    type V = { x: number; y: number; z: number };
    const tris: V[][] = [];
    for (let t = 0; t < pos.length / 9; t++) {
      const v: V[] = [];
      let near = true;
      for (let k = 0; k < 3; k++) {
        const x = pos[t * 9 + k * 3], y = pos[t * 9 + k * 3 + 1], z = pos[t * 9 + k * 3 + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new Error('NaN vertex');
        if (Math.hypot(x - center.x, z - center.z) > 1.6) near = false;
        v.push({ x, y, z });
      }
      if (near) tris.push(v);
    }

    let reversed = 0;
    for (const v of tris) {
      const cx = (v[1].x - v[0].x) * (v[2].z - v[0].z) - (v[1].z - v[0].z) * (v[2].x - v[0].x);
      if (cx < -1e-9) reversed++;
    }
    expect(reversed).toBe(0);

    const EPS = 1e-7;
    const inside = (px: number, pz: number, v: V[]) => {
      const s = (a: V, b: V) => (b.x - a.x) * (pz - a.z) - (b.z - a.z) * (px - a.x);
      const d1 = s(v[0], v[1]), d2 = s(v[1], v[2]), d3 = s(v[2], v[0]);
      return !(((d1 < -EPS) || (d2 < -EPS) || (d3 < -EPS)) && ((d1 > EPS) || (d2 > EPS) || (d3 > EPS)));
    };
    let holes = 0;
    for (let a = 0; a < 360; a += 4) {
      for (let rr = 0.02; rr < 0.75; rr += 0.03) {
        const px = center.x + Math.cos(a * Math.PI / 180) * rr;
        const pz = center.z + Math.sin(a * Math.PI / 180) * rr;
        if (!tris.some(v => inside(px, pz, v))) holes++;
      }
    }
    expect(holes).toBe(0);
  });

  it('keeps earlier builds independent of later ones', () => {
    const m = makeMap();
    const g1 = buildChunkGeometry(m, layout, bounds, {});
    const p1 = g1.terrain.getAttribute('position').array as Float32Array;
    const snapshot = p1.slice(0, 60);

    m.setElevation(0, 0, 3);
    const g2 = buildChunkGeometry(m, layout, bounds, {});

    expect(Array.from(p1.slice(0, 60))).toEqual(Array.from(snapshot));
    expect(g2.terrain.getAttribute('position').count).toBeGreaterThan(0);
  });
});
