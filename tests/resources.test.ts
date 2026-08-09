import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { HexMap } from '../src/map/HexMap.js';
import { TerrainType } from '../src/map/HexCell.js';
import { createLayout } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';
import { FogData } from '../src/geometry/FogData.js';
import { ResourceLayer } from '../src/gameplay/ResourceLayer.js';
import { generateResources } from '../src/gameplay/ResourceGenerator.js';
import { hexDistance, offsetToHex } from '../src/math/HexCoord.js';
import type { ResourceDescriptor } from '../src/gameplay/ResourceTypes.js';
import { serializeMapJSON, deserializeMapJSON } from '../src/map/MapSerializer.js';

const WATER = TerrainType.Water;

const DESCRIPTORS: ResourceDescriptor[] = [
  { id: 'ore',  name: 'Ore',  color: 0xb0b6c0, placement: { allowedTerrains: [TerrainType.Rock], frequency: 1 } },
  { id: 'fish', name: 'Fish', color: 0x66ccee, placement: { requiresLiquid: true, frequency: 1 } },
];

function setup(descriptors: ResourceDescriptor[] = DESCRIPTORS, fogData?: FogData) {
  const map    = new HexMap({ width: 16, height: 16, featureLayerCount: 2 });
  const parent = new THREE.Object3D();
  const layer  = new ResourceLayer({
    parent,
    layout: createLayout(POINTY_TOP, 1),
    map,
    descriptors,
    isWater: t => t === WATER,
    ...(fogData ? { fogData } : {}),
  });
  return { map, parent, layer };
}

describe('ResourceLayer cell data', () => {
  it('places and removes resources through the metadata channel', () => {
    const { map, layer } = setup();

    layer.setResource(2, 3, 'ore');
    expect(layer.resourceAt(2, 3)).toBe('ore');
    expect(map.getCellData(2, 3, 'resource')).toBe('ore');
    expect(layer.amountAt(2, 3)).toBeNull(); // permanent deposit

    layer.removeResource(2, 3);
    expect(layer.resourceAt(2, 3)).toBeNull();
    expect(map.hasCellData(2, 3)).toBe(false);
  });

  it('tracks quantities for depletable deposits', () => {
    const { layer } = setup();
    layer.setResource(4, 4, 'ore', 10);

    expect(layer.resourceAt(4, 4)).toBe('ore');
    expect(layer.amountAt(4, 4)).toBe(10);

    expect(layer.setAmount(4, 4, 3)).toBe(3);
    expect(layer.amountAt(4, 4)).toBe(3);

    // Depleting to zero removes the deposit entirely.
    expect(layer.setAmount(4, 4, 0)).toBeNull();
    expect(layer.resourceAt(4, 4)).toBeNull();
  });

  it('ignores amount changes on empty cells and out-of-bounds writes', () => {
    const { layer } = setup();
    expect(layer.setAmount(1, 1, 5)).toBeNull();
    layer.setResource(-1, 0, 'ore');
    layer.setResource(99, 99, 'ore');
    expect(layer.allResources()).toHaveLength(0);
  });

  it('lists, counts, and clears placements', () => {
    const { layer } = setup();
    layer.setResource(1, 1, 'ore');
    layer.setResource(2, 2, 'ore', 5);
    layer.setResource(3, 3, 'fish');

    expect(layer.allResources()).toHaveLength(3);
    expect(layer.allResources('ore')).toHaveLength(2);
    expect(layer.allResources('ore').find(r => r.col === 2)!.amount).toBe(5);
    expect(layer.counts().get('ore')).toBe(2);

    layer.clear('ore');
    expect(layer.allResources()).toHaveLength(1);
    layer.clear();
    expect(layer.allResources()).toHaveLength(0);
  });

  it('leaves unrelated metadata alone when clearing', () => {
    const { map, layer } = setup();
    layer.setResource(1, 1, 'ore');
    map.setCellData(1, 1, 'owner', 'red');

    layer.clear();
    expect(layer.resourceAt(1, 1)).toBeNull();
    expect(map.getCellData(1, 1, 'owner')).toBe('red');
  });
});

describe('ResourceLayer rendering', () => {
  it('builds one instanced mesh per resource type', () => {
    const { parent, layer } = setup();
    layer.setResource(1, 1, 'ore');
    layer.setResource(2, 1, 'ore');
    layer.setResource(3, 3, 'fish');
    layer.refresh();

    const meshes = parent.children as THREE.InstancedMesh[];
    expect(meshes).toHaveLength(2);
    const counts = meshes.map(m => m.count).sort();
    expect(counts).toEqual([1, 2]);
  });

  it('gives each instance its cell index so the fog shader can look it up', () => {
    const { map, parent, layer } = setup();
    layer.setResource(5, 6, 'ore');
    layer.refresh();

    const mesh = parent.children[0] as THREE.InstancedMesh;
    const cellIndex = mesh.geometry.getAttribute('cellIndex') as THREE.InstancedBufferAttribute;
    expect(cellIndex.isInstancedBufferAttribute).toBe(true);
    expect(cellIndex.getX(0)).toBe(6 * map.width + 5);
  });

  it('sits icons on the water surface over liquid cells', () => {
    const { map, parent, layer } = setup();
    map.setTerrain(4, 4, WATER);
    map.setElevation(4, 4, -1);
    for (let c = 3; c <= 5; c++) for (let r = 3; r <= 5; r++) {
      if (c === 4 && r === 4) continue;
      map.setElevation(c, r, 2);
    }
    map.computeWaterSurfaces(t => t === WATER);

    layer.setResource(4, 4, 'fish');
    layer.refresh();

    const mesh = parent.children[0] as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(0, matrix);
    const y = new THREE.Vector3().setFromMatrixPosition(matrix).y;

    // On the surface (plus the icon's lift), not down on the seabed floor.
    expect(y).toBeGreaterThan(map.getElevation(4, 4) * 0.5);
    expect(y).toBeCloseTo(map.getWaterSurface(4, 4) * 0.5 + 0.8);
  });

  it('skips deposits whose type has no descriptor', () => {
    const { parent, layer } = setup();
    layer.setResource(1, 1, 'ore');
    layer.setResource(2, 2, 'unobtainium');
    layer.refresh();

    expect(parent.children).toHaveLength(1);
    expect((parent.children[0] as THREE.InstancedMesh).count).toBe(1);
  });

  it('rebuilds on update only when something changed', () => {
    const { parent, layer } = setup();
    layer.setResource(1, 1, 'ore');
    layer.update();
    const mesh = parent.children[0];

    layer.update();
    expect(parent.children[0]).toBe(mesh); // clean — no rebuild

    layer.setResource(2, 2, 'ore');
    layer.update();
    expect((parent.children[0] as THREE.InstancedMesh).count).toBe(2);
  });

  it('wires fog uniforms into the icon materials', () => {
    const fog = new FogData(16, 16, 0);
    const { parent, layer } = setup(DESCRIPTORS, fog);
    layer.setResource(1, 1, 'ore');
    layer.refresh();

    const material = (parent.children[0] as THREE.InstancedMesh).material as THREE.ShaderMaterial;
    expect(material.uniforms.uFogEnabled.value).toBe(1);
    expect(material.uniforms.uFogData.value).toBe(fog.texture);
    expect(material.uniforms.uFogDataSize.value.x).toBe(16);

    layer.setHideUnexplored(false);
    expect(material.uniforms.uHideUnexplored.value).toBe(0);
    layer.setDimExplored(false);
    expect(material.uniforms.uDimExplored.value).toBe(0);

    layer.setFogData(null);
    expect(material.uniforms.uFogEnabled.value).toBe(0);
  });

  it('hides and restores without losing placements', () => {
    const { parent, layer } = setup();
    layer.setResource(1, 1, 'ore');
    layer.refresh();

    layer.setVisible(false);
    expect(parent.children.every(o => !o.visible)).toBe(true);
    layer.setVisible(true);
    expect(parent.children.some(o => o.visible)).toBe(true);
    expect(layer.resourceAt(1, 1)).toBe('ore');
  });

  it('disposes meshes without touching map data', () => {
    const { map, parent, layer } = setup();
    layer.setResource(1, 1, 'ore');
    layer.refresh();

    layer.dispose();
    expect(parent.children).toHaveLength(0);
    expect(map.getCellData(1, 1, 'resource')).toBe('ore');
  });

  it('survives a JSON map round-trip with its descriptors', () => {
    const { map, layer } = setup();
    layer.setResource(3, 3, 'ore', 4);

    const json = serializeMapJSON(map, {}, { resourceDescriptors: DESCRIPTORS });
    const { map: loaded, resourceDescriptors } = deserializeMapJSON(json);

    expect(resourceDescriptors).toEqual(DESCRIPTORS);
    expect(loaded.getCellData(3, 3, 'resource')).toEqual({ type: 'ore', amount: 4 });
  });
});

describe('generateResources', () => {
  /** A map split into rock highlands (left) and water (right), with a forest strip. */
  function makeMap(): HexMap {
    const map = new HexMap({ width: 24, height: 24, featureLayerCount: 2 });
    map.forEach((col, row) => {
      if (col < 12) {
        map.setTerrain(col, row, TerrainType.Rock);
        map.setElevation(col, row, 5);
      } else {
        map.setTerrain(col, row, WATER);
        map.setElevation(col, row, -1);
      }
    });
    map.computeWaterSurfaces(t => t === WATER);
    return map;
  }

  const isWater = (t: number) => t === WATER;

  it('respects terrain rules and never puts land resources on water', () => {
    const map = makeMap();
    const placed = generateResources(map, DESCRIPTORS, 1234, { isWater });

    expect(placed.length).toBeGreaterThan(0);
    for (const r of placed) {
      if (r.type === 'ore')  expect(map.getTerrain(r.col, r.row)).toBe(TerrainType.Rock);
      if (r.type === 'fish') expect(map.getTerrain(r.col, r.row)).toBe(WATER);
    }
  });

  // frequency 1 fills every eligible cell, which would look identical under any
  // seed — the RNG only shows up at partial frequencies.
  const SPARSE: ResourceDescriptor[] = [
    { id: 'ore',  name: 'Ore',  color: 0, placement: { allowedTerrains: [TerrainType.Rock], frequency: 0.2 } },
    { id: 'fish', name: 'Fish', color: 0, placement: { requiresLiquid: true, frequency: 0.2 } },
  ];

  it('is deterministic for a seed, and different across seeds', () => {
    const a = generateResources(makeMap(), SPARSE, 42, { isWater });
    const b = generateResources(makeMap(), SPARSE, 42, { isWater });
    const c = generateResources(makeMap(), SPARSE, 43, { isWater });

    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('gives each type its own stream, so adding one does not reshuffle the others', () => {
    const oreOnly = generateResources(makeMap(), [SPARSE[0]], 7, { isWater });
    const both    = generateResources(makeMap(), SPARSE, 7, { isWater });

    expect(oreOnly.length).toBeGreaterThan(0);
    expect(both.filter(r => r.type === 'ore')).toEqual(oreOnly);
  });

  it('honours minSpacing between deposits of one type', () => {
    const map = makeMap();
    const spaced: ResourceDescriptor[] = [
      { id: 'ore', name: 'Ore', color: 0, placement: { allowedTerrains: [TerrainType.Rock], frequency: 1, minSpacing: 3 } },
    ];
    const placed = generateResources(map, spaced, 99, { isWater });

    expect(placed.length).toBeGreaterThan(1);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const d = hexDistance(
          offsetToHex(placed[i].col, placed[i].row),
          offsetToHex(placed[j].col, placed[j].row),
        );
        expect(d).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('places at most one resource per cell', () => {
    const map = makeMap();
    const greedy: ResourceDescriptor[] = [
      { id: 'a', name: 'A', color: 0, placement: { allowedTerrains: [TerrainType.Rock], frequency: 1 } },
      { id: 'b', name: 'B', color: 0, placement: { allowedTerrains: [TerrainType.Rock], frequency: 1 } },
    ];
    const placed = generateResources(map, greedy, 5, { isWater });

    const seen = new Set(placed.map(r => r.row * map.width + r.col));
    expect(seen.size).toBe(placed.length);
    // The first descriptor takes every contested cell.
    expect(placed.every(r => r.type === 'a')).toBe(true);
  });

  it('applies elevation, river, coast, and feature-level rules', () => {
    const map = makeMap();
    map.setElevation(3, 3, 9);
    map.setRiverOutgoing(4, 4, 0);
    for (let row = 0; row < 24; row++) map.setFeatureLevel(5, row, 0, 3);

    const highOnly = generateResources(map, [
      { id: 'peak', name: 'Peak', color: 0, placement: { minElevation: 9, frequency: 1 } },
    ], 3, { isWater, clearExisting: true });
    expect(highOnly.every(r => map.getElevation(r.col, r.row) >= 9)).toBe(true);
    expect(highOnly.length).toBeGreaterThan(0);

    const riverOnly = generateResources(map, [
      { id: 'mill', name: 'Mill', color: 0, placement: { requiresRiver: true, frequency: 1 } },
    ], 3, { isWater, clearExisting: true });
    expect(riverOnly.every(r => map.hasRiver(r.col, r.row))).toBe(true);
    expect(riverOnly.length).toBeGreaterThan(0);

    const coastOnly = generateResources(map, [
      { id: 'salt', name: 'Salt', color: 0, placement: { requiresCoast: true, frequency: 1 } },
    ], 3, { isWater, clearExisting: true });
    expect(coastOnly.length).toBeGreaterThan(0);
    // Coastal = a land cell touching water, so only the column beside the sea.
    expect(coastOnly.every(r => r.col === 11)).toBe(true);

    const forestOnly = generateResources(map, [
      { id: 'game', name: 'Game', color: 0, placement: { minFeatureLevel: { layer: 0, level: 2 }, frequency: 1 } },
    ], 3, { isWater, clearExisting: true });
    expect(forestOnly.length).toBeGreaterThan(0);
    expect(forestOnly.every(r => r.col === 5)).toBe(true);
  });

  it('filters by the climate fields when they are supplied', () => {
    const map = makeMap();
    const n = map.width * map.height;
    const temperature = new Float32Array(n);
    const moisture    = new Float32Array(n);
    // Only the top half is warm and wet.
    map.forEach((col, row) => {
      const i = row * map.width + col;
      temperature[i] = row < 12 ? 0.9 : 0.1;
      moisture[i]    = row < 12 ? 0.8 : 0.2;
    });

    const tropical: ResourceDescriptor[] = [
      { id: 'spice', name: 'Spice', color: 0, placement: { frequency: 1, minTemperature: 0.5, minMoisture: 0.5 } },
    ];
    const placed = generateResources(map, tropical, 11, { isWater, temperature, moisture });

    expect(placed.length).toBeGreaterThan(0);
    expect(placed.every(r => r.row < 12)).toBe(true);
  });

  it('clears prior placements by default and can keep them', () => {
    const map = makeMap();
    generateResources(map, DESCRIPTORS, 1, { isWater });
    const afterRegen = generateResources(map, DESCRIPTORS, 2, { isWater });
    // A fresh pass replaced the old deposits rather than layering on them.
    const stored = [...map.cellData.values()].filter(r => r.resource !== undefined);
    expect(stored).toHaveLength(afterRegen.length);

    const kept = generateResources(map, DESCRIPTORS, 3, { isWater, clearExisting: false });
    // Existing cells are occupied, so a keep-pass can only fill the gaps.
    expect(kept.length).toBeLessThan(afterRegen.length);
  });

  it('writes starting amounts when asked', () => {
    const map = makeMap();
    const placed = generateResources(map, DESCRIPTORS, 8, { isWater, amount: 12 });

    expect(placed.every(r => r.amount === 12)).toBe(true);
    expect(map.getCellData(placed[0].col, placed[0].row, 'resource'))
      .toEqual({ type: placed[0].type, amount: 12 });
  });
});
