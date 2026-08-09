import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { HexMap } from '../src/map/HexMap.js';
import { createLayout } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';
import { CellOverlayLayer } from '../src/geometry/CellOverlayLayer.js';
import { TerritoryLayer, type FactionDescriptor } from '../src/gameplay/TerritoryLayer.js';
import { serializeMapJSON, deserializeMapJSON, serializeMap, deserializeMap } from '../src/map/MapSerializer.js';

const FACTIONS: FactionDescriptor[] = [
  { id: 'red',  name: 'Kelmar',  color: 0xff0000 },
  { id: 'blue', name: 'Ossiran', color: 0x0000ff },
];

function setup(factions: FactionDescriptor[] = FACTIONS) {
  const map    = new HexMap({ width: 16, height: 16 });
  const parent = new THREE.Object3D();
  const overlays = new CellOverlayLayer({
    parent, layout: createLayout(POINTY_TOP, 1), map,
  });
  const territory = new TerritoryLayer({ overlays, map, factions });
  return { map, parent, overlays, territory };
}

const findObject = (parent: THREE.Object3D, predicate: (o: THREE.Object3D) => boolean) =>
  parent.children.find(predicate);

describe('TerritoryLayer ownership', () => {
  it('claims and releases cells through the metadata channel', () => {
    const { map, territory } = setup();

    territory.claim(3, 4, 'red');
    expect(territory.ownerOf(3, 4)).toBe('red');
    // Stored where the serializer will find it, under the documented key.
    expect(map.getCellData(3, 4, 'owner')).toBe('red');

    territory.release(3, 4);
    expect(territory.ownerOf(3, 4)).toBeNull();
    expect(map.hasCellData(3, 4)).toBe(false);
  });

  it('ignores out-of-bounds cells', () => {
    const { territory } = setup();
    territory.claim(-1, 0, 'red');
    territory.claim(16, 16, 'red');
    expect(territory.cellCounts().size).toBe(0);
  });

  it('resolves contested cells to the largest share', () => {
    const { territory } = setup();
    territory.setInfluence(5, 5, { red: 0.7, blue: 0.3 });

    expect(territory.ownerOf(5, 5)).toBe('red');
    const influence = territory.influenceAt(5, 5)!;
    expect(influence.red).toBeCloseTo(0.7);
    expect(influence.blue).toBeCloseTo(0.3);
  });

  it('normalizes influence weights of any scale', () => {
    const { territory } = setup();
    territory.setInfluence(5, 5, { red: 30, blue: 10 });

    const influence = territory.influenceAt(5, 5)!;
    expect(influence.red).toBeCloseTo(0.75);
    expect(influence.blue).toBeCloseTo(0.25);
  });

  it('reads an outright claim as full influence', () => {
    const { territory } = setup();
    territory.claim(2, 2, 'blue');
    expect(territory.influenceAt(2, 2)).toEqual({ blue: 1 });
  });

  it('collapses a single contender to a plain claim and drops empty influence', () => {
    const { map, territory } = setup();

    territory.setInfluence(1, 1, { red: 5, blue: 0 });
    expect(map.getCellData(1, 1, 'owner')).toBe('red'); // stored in the cheap shape

    territory.setInfluence(2, 2, { red: 0 });
    expect(territory.ownerOf(2, 2)).toBeNull();
    expect(map.hasCellData(2, 2)).toBe(false);
  });

  it('lists holdings and counts per faction', () => {
    const { territory } = setup();
    territory.claimAll([{ col: 1, row: 1 }, { col: 2, row: 1 }], 'red');
    territory.claim(5, 5, 'blue');
    territory.setInfluence(6, 5, { blue: 0.9, red: 0.1 });

    expect(territory.ownedCells('red')).toHaveLength(2);
    expect(territory.ownedCells('blue')).toHaveLength(2); // includes the contested cell it dominates

    const counts = territory.cellCounts();
    expect(counts.get('red')).toBe(2);
    expect(counts.get('blue')).toBe(2);
  });

  it('clears all ownership, or one faction, leaving other metadata alone', () => {
    const { map, territory } = setup();
    territory.claim(1, 1, 'red');
    territory.claim(2, 2, 'blue');
    map.setCellData(1, 1, 'grazing', 0.5);

    territory.clear('red');
    expect(territory.ownerOf(1, 1)).toBeNull();
    expect(territory.ownerOf(2, 2)).toBe('blue');
    expect(map.getCellData(1, 1, 'grazing')).toBe(0.5); // untouched

    territory.clear();
    expect(territory.cellCounts().size).toBe(0);
    expect(map.getCellData(1, 1, 'grazing')).toBe(0.5);
  });
});

describe('TerritoryLayer rendering', () => {
  it('draws one blended fill plus a border per faction', () => {
    const { parent, territory } = setup();
    territory.claimAll([{ col: 1, row: 1 }, { col: 2, row: 1 }], 'red');
    territory.claim(8, 8, 'blue');
    territory.refresh();

    const meshes = parent.children.filter(o => (o as THREE.Mesh).isMesh);
    const lines  = parent.children.filter(o => (o as THREE.LineSegments).isLineSegments);
    expect(meshes).toHaveLength(1); // one vertex-colored fill for every owned cell
    expect(lines).toHaveLength(2);  // one outline per faction

    const fill = meshes[0] as THREE.Mesh;
    expect(fill.geometry.getAttribute('position').count).toBe(3 * 18);
    expect((fill.material as THREE.MeshBasicMaterial).vertexColors).toBe(true);
  });

  it('tints each cell with its owner and blends contested cells between them', () => {
    const { parent, territory } = setup();
    territory.claim(1, 1, 'red');
    territory.claim(2, 1, 'blue');
    territory.setInfluence(3, 1, { red: 0.5, blue: 0.5 });
    territory.refresh();

    const fill = parent.children.find(o => (o as THREE.Mesh).isMesh) as THREE.Mesh;
    const colors = fill.geometry.getAttribute('color') as THREE.BufferAttribute;
    expect(colors.count).toBe(3 * 18);

    // Cells come back in metadata-store order, so identify them by their tint.
    const cellColors: THREE.Color[] = [];
    for (let cell = 0; cell < 3; cell++) {
      const i = cell * 18;
      cellColors.push(new THREE.Color(colors.getX(i), colors.getY(i), colors.getZ(i)));
    }

    const pureRed  = cellColors.find(c => c.r > 0.5 && c.b < 0.01)!;
    const pureBlue = cellColors.find(c => c.b > 0.5 && c.r < 0.01)!;
    const blended  = cellColors.find(c => c.r > 0.01 && c.b > 0.01)!;

    expect(pureRed).toBeDefined();
    expect(pureBlue).toBeDefined();
    // The contested cell sits between the two, not on either.
    expect(blended.r).toBeCloseTo(pureRed.r / 2, 4);
    expect(blended.b).toBeCloseTo(pureBlue.b / 2, 4);
  });

  it('drops a faction border once it loses its last cell', () => {
    const { parent, territory } = setup();
    territory.claim(1, 1, 'red');
    territory.claim(8, 8, 'blue');
    territory.refresh();

    const blueBorder = parent.children.filter(o => (o as THREE.LineSegments).isLineSegments)[1];
    expect(blueBorder.visible).toBe(true);

    territory.release(8, 8);
    territory.refresh();
    expect(blueBorder.visible).toBe(false);
  });

  it('skips cells whose factions are all off the roster', () => {
    const { parent, territory } = setup();
    territory.claim(1, 1, 'red');
    territory.claim(2, 2, 'ghosts'); // no descriptor
    territory.refresh();

    const fill = parent.children.find(o => (o as THREE.Mesh).isMesh) as THREE.Mesh;
    expect(fill.geometry.getAttribute('position').count).toBe(1 * 18);
  });

  it('rebuilds on update only when something changed', () => {
    const { parent, territory } = setup();
    territory.claim(1, 1, 'red');
    territory.update();

    const fill = parent.children.find(o => (o as THREE.Mesh).isMesh) as THREE.Mesh;
    const before = fill.geometry.getAttribute('position');
    territory.update(); // clean — must not rebuild
    expect(fill.geometry.getAttribute('position')).toBe(before);

    territory.claim(2, 1, 'red');
    territory.update();
    expect(fill.geometry.getAttribute('position')).not.toBe(before);
    expect(fill.geometry.getAttribute('position').count).toBe(2 * 18);
  });

  it('hides and restores the whole layer without losing ownership', () => {
    const { parent, territory } = setup();
    territory.claim(1, 1, 'red');
    territory.refresh();

    territory.setVisible(false);
    expect(parent.children.every(o => !o.visible)).toBe(true);
    expect(territory.ownerOf(1, 1)).toBe('red');

    territory.setVisible(true);
    expect(parent.children.some(o => o.visible)).toBe(true);
  });

  it('recolors when the roster changes', () => {
    const { parent, territory } = setup();
    territory.claim(1, 1, 'red');
    territory.refresh();

    territory.setFactions([{ id: 'red', name: 'Kelmar', color: 0x00ff00 }]);
    territory.update();

    const fill = parent.children.find(o => (o as THREE.Mesh).isMesh) as THREE.Mesh;
    const colors = fill.geometry.getAttribute('color') as THREE.BufferAttribute;
    expect(colors.getY(0)).toBeGreaterThan(0.5); // now green
    expect(colors.getX(0)).toBeLessThan(0.01);
  });

  it('disposes its overlays without touching map data', () => {
    const { map, parent, territory } = setup();
    territory.claim(1, 1, 'red');
    territory.refresh();

    territory.dispose();
    expect(parent.children).toHaveLength(0);
    expect(map.getCellData(1, 1, 'owner')).toBe('red');
  });
});

describe('TerritoryLayer persistence', () => {
  it('survives a JSON map round-trip, factions included', () => {
    const { map, territory } = setup();
    territory.claim(3, 3, 'red');
    territory.setInfluence(4, 3, { red: 0.6, blue: 0.4 });

    const json = serializeMapJSON(map, { name: 'border war' }, { factions: FACTIONS });
    const { map: loaded, factions } = deserializeMapJSON(json);

    expect(factions).toEqual(FACTIONS);

    const { overlays } = setup();
    const restored = new TerritoryLayer({ overlays, map: loaded, factions });
    expect(restored.ownerOf(3, 3)).toBe('red');
    expect(restored.influenceAt(4, 3)!.blue).toBeCloseTo(0.4);
  });

  it('survives a binary map round-trip', () => {
    const { map, territory } = setup();
    territory.claim(7, 7, 'blue');

    const loaded = deserializeMap(serializeMap(map));
    const { overlays } = setup();
    const restored = new TerritoryLayer({ overlays, map: loaded, factions: FACTIONS });

    expect(restored.ownerOf(7, 7)).toBe('blue');
  });
});
