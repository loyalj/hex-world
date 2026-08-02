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
