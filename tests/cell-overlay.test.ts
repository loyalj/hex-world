import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { HexMap } from '../src/map/HexMap.js';
import { createLayout } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';
import { hexRange, offsetToHex, hexToOffset } from '../src/math/HexCoord.js';
import { CellOverlayLayer } from '../src/geometry/CellOverlayLayer.js';

const WATER = 5;

function makeLayer(map: HexMap) {
  const parent = new THREE.Object3D();
  const layer = new CellOverlayLayer({
    parent,
    layout: createLayout(POINTY_TOP, 1),
    map,
    isWater: t => t === WATER,
  });
  return { parent, layer };
}

const positions = (obj: THREE.Object3D) =>
  ((obj as THREE.Mesh).geometry.getAttribute('position') as THREE.BufferAttribute);

describe('CellOverlayLayer fills', () => {
  it('builds 18 vertices per cell and skips out-of-bounds cells', () => {
    const map = new HexMap({ width: 8, height: 8 });
    const { parent, layer } = makeLayer(map);

    layer.set('hover', [{ col: 2, row: 2 }, { col: 3, row: 2 }, { col: -1, row: 0 }, { col: 8, row: 8 }]);
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0].visible).toBe(true);
    expect(positions(parent.children[0]).count).toBe(2 * 18); // 6 fan triangles per in-bounds cell

    layer.set('hover', null);
    expect(parent.children[0].visible).toBe(false);
  });

  it('places fills on the water surface for liquid cells', () => {
    const map = new HexMap({ width: 8, height: 8 });
    map.setTerrain(4, 4, WATER);
    map.setElevation(4, 4, -1); // floor at -1 → surface at 0
    for (let c = 3; c <= 5; c++) for (let r = 3; r <= 5; r++) {
      if (c === 4 && r === 4) continue;
      map.setElevation(c, r, 2);
    }
    map.computeWaterSurfaces();

    const { parent, layer } = makeLayer(map);
    layer.set('a', [{ col: 4, row: 4 }], { yOffset: 0 });
    const surfaceY = map.getWaterSurface(4, 4) * 0.5;
    expect(positions(parent.children[0]).getY(0)).toBeCloseTo(surfaceY);
    // Water surface sits above the floor elevation the terrain mesh uses.
    expect(surfaceY).toBeGreaterThan(map.getElevation(4, 4) * 0.5);
  });
});

describe('CellOverlayLayer fill walls', () => {
  it('drapes a wall down each edge with a lower neighbor, and only those', () => {
    const map = new HexMap({ width: 8, height: 8 });
    map.setElevation(4, 4, 3); // mesa: all 6 neighbors sit at 0
    const { parent, layer } = makeLayer(map);

    layer.set('t', [{ col: 4, row: 4 }], { walls: true, yOffset: 0 });
    // 18 cap vertices + 6 walls × 6 vertices.
    const pos = positions(parent.children[0]);
    expect(pos.count).toBe(18 + 36);
    // Wall feet reach the neighbors' surface (elevation 0).
    let minY = Infinity;
    for (let i = 0; i < pos.count; i++) minY = Math.min(minY, pos.getY(i));
    expect(minY).toBeCloseTo(0);

    // A pit cell gets no walls — the higher neighbors own those faces.
    map.setElevation(4, 4, -3);
    map.computeWaterSurfaces();
    layer.set('t', [{ col: 4, row: 4 }], { walls: true, yOffset: 0 });
    expect(positions(parent.children[0]).count).toBe(18);
  });

  it('keeps the color buffer in step with wall vertices', () => {
    const map = new HexMap({ width: 8, height: 8 });
    map.setElevation(4, 4, 2);
    const { parent, layer } = makeLayer(map);

    layer.set('t', [{ col: 4, row: 4 }, { col: 4, row: 6 }], {
      walls: true,
      cellColor: (_c, i) => (i === 0 ? 0xff0000 : 0x0000ff),
    });
    const mesh   = parent.children[0] as THREE.Mesh;
    const pos    = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colors = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    expect(colors.count).toBe(pos.count);
    // The raised cell's walls (verts 18..53) wear its red tint.
    expect(colors.getX(20)).toBeGreaterThan(0.5);
    expect(colors.getZ(20)).toBeLessThan(0.01);
  });

  it('depthTest is opt-in and reverts with the option', () => {
    const map = new HexMap({ width: 8, height: 8 });
    const { parent, layer } = makeLayer(map);

    layer.set('t', [{ col: 1, row: 1 }]);
    const mat = (parent.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    expect(mat.depthTest).toBe(false);

    layer.set('t', [{ col: 1, row: 1 }], { depthTest: true });
    expect(mat.depthTest).toBe(true);

    layer.set('t', [{ col: 1, row: 1 }]);
    expect(mat.depthTest).toBe(false);
  });
});

describe('CellOverlayLayer per-cell colors', () => {
  it('tints each cell independently and switches the material to vertex colors', () => {
    const map = new HexMap({ width: 8, height: 8 });
    const { parent, layer } = makeLayer(map);

    layer.set('t', [{ col: 1, row: 1 }, { col: 2, row: 1 }], {
      cellColor: (_c, i) => (i === 0 ? 0xff0000 : 0x0000ff),
    });

    const mesh   = parent.children[0] as THREE.Mesh;
    const colors = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    expect(colors.count).toBe(2 * 18); // all 18 vertices of a cell share its tint
    expect((mesh.material as THREE.MeshBasicMaterial).vertexColors).toBe(true);

    expect(colors.getX(0)).toBeGreaterThan(0.5);  // first cell red
    expect(colors.getZ(0)).toBeLessThan(0.01);
    expect(colors.getZ(18)).toBeGreaterThan(0.5); // second cell blue
    expect(colors.getX(18)).toBeLessThan(0.01);
  });

  it('falls back to the flat color for cells the callback skips', () => {
    const map = new HexMap({ width: 8, height: 8 });
    const { parent, layer } = makeLayer(map);

    layer.set('t', [{ col: 1, row: 1 }], { color: 0x00ff00, cellColor: () => null });
    const colors = (parent.children[0] as THREE.Mesh).geometry.getAttribute('color') as THREE.BufferAttribute;
    expect(colors.getY(0)).toBeGreaterThan(0.5);
    expect(colors.getX(0)).toBeLessThan(0.01);
  });

  it('reverts to a flat color when the callback goes away', () => {
    const map = new HexMap({ width: 8, height: 8 });
    const { parent, layer } = makeLayer(map);

    layer.set('t', [{ col: 1, row: 1 }], { cellColor: () => 0xff0000 });
    layer.set('t', [{ col: 1, row: 1 }], { color: 0x00ff00 });

    const mesh = parent.children[0] as THREE.Mesh;
    expect(mesh.geometry.getAttribute('color')).toBeUndefined();
    expect((mesh.material as THREE.MeshBasicMaterial).vertexColors).toBe(false);
    expect((mesh.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0x00ff00);
  });
});

describe('CellOverlayLayer outlines', () => {
  it('draws only boundary edges of the set', () => {
    const map = new HexMap({ width: 16, height: 16 });
    const { parent, layer } = makeLayer(map);

    // Single cell: all 6 edges are boundary → 6 segments, 12 vertices.
    layer.set('sel', [{ col: 8, row: 8 }], { style: 'outline' });
    const obj = parent.children[0];
    expect(obj).toBeInstanceOf(THREE.LineSegments);
    expect(positions(obj).count).toBe(12);

    // 7-cell flower: 42 total edges − 2×12 shared internal half-edges = 18 boundary segments.
    const flower = hexRange(offsetToHex(8, 8), 1).map(hexToOffset);
    layer.set('sel', flower, { style: 'outline' });
    expect(positions(obj).count).toBe(18 * 2);
  });

  it('treats the map edge as a boundary', () => {
    const map = new HexMap({ width: 4, height: 4 });
    const { parent, layer } = makeLayer(map);
    layer.set('sel', [{ col: 0, row: 0 }], { style: 'outline' });
    expect(positions(parent.children[0]).count).toBe(12); // all 6 edges drawn
  });

  it('lineWidth > 0 builds ribbon quads instead of GL lines', () => {
    const map = new HexMap({ width: 16, height: 16 });
    const { parent, layer } = makeLayer(map);

    layer.set('sel', [{ col: 8, row: 8 }], { style: 'outline', lineWidth: 0.2 });
    const obj = parent.children[0];
    expect(obj).toBeInstanceOf(THREE.Mesh);
    expect(positions(obj).count).toBe(6 * 6); // 6 boundary edges × 2 triangles

    // The quad spans the requested width perpendicular to its edge.
    const pos = positions(obj);
    const dx = pos.getX(0) - pos.getX(5); // first vert to last vert of the edge's two triangles
    const dz = pos.getZ(0) - pos.getZ(5);
    expect(Math.hypot(dx, dz)).toBeCloseTo(0.2);
  });

  it('switching an outline between widths across zero swaps the object type', () => {
    const map = new HexMap({ width: 16, height: 16 });
    const { parent, layer } = makeLayer(map);

    layer.set('sel', [{ col: 8, row: 8 }], { style: 'outline' });
    expect(parent.children[0]).toBeInstanceOf(THREE.LineSegments);

    layer.set('sel', [{ col: 8, row: 8 }], { style: 'outline', lineWidth: 0.15 });
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]).toBeInstanceOf(THREE.Mesh);

    layer.set('sel', [{ col: 8, row: 8 }], { style: 'outline' });
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]).toBeInstanceOf(THREE.LineSegments);
  });
});

describe('CellOverlayLayer paths', () => {
  it('draws a smoothed line for paths of 2+ cells and hides otherwise', () => {
    const map = new HexMap({ width: 16, height: 16 });
    const { parent, layer } = makeLayer(map);

    layer.setPath('p', [offsetToHex(2, 2), offsetToHex(3, 2), offsetToHex(4, 2)]);
    const obj = parent.children[0];
    expect(obj).toBeInstanceOf(THREE.Line);
    expect(positions(obj).count).toBeGreaterThan(3);

    layer.setPath('p', [offsetToHex(2, 2)]);
    expect(obj.visible).toBe(false);
  });
});

describe('CellOverlayLayer lifecycle', () => {
  it('reuses one object per id, replaces on style change, and disposes cleanly', () => {
    const map = new HexMap({ width: 8, height: 8 });
    const { parent, layer } = makeLayer(map);

    layer.set('x', [{ col: 1, row: 1 }]);
    layer.set('x', [{ col: 2, row: 2 }]);
    expect(parent.children).toHaveLength(1);

    layer.set('x', [{ col: 2, row: 2 }], { style: 'outline' });
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]).toBeInstanceOf(THREE.LineSegments);

    layer.set('y', [{ col: 3, row: 3 }]);
    expect(parent.children).toHaveLength(2);

    layer.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
