import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { HexMap } from '../src/map/HexMap.js';
import { TerrainType } from '../src/map/HexCell.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';
import { createLayout } from '../src/math/HexLayout.js';
import { ChunkManager } from '../src/geometry/ChunkManager.js';

describe('HexMap.edit transactions', () => {
  it('snapshots and restores every channel through undo/redo', () => {
    const map = new HexMap({ width: 8, height: 8, featureLayerCount: 2 });
    map.setTerrain(2, 2, TerrainType.Desert);
    map.setElevation(2, 2, 3);
    map.setFeatureLevel(2, 2, 1, 2);
    map.setRiverIncoming(2, 2, 1);
    map.setRiverIncoming(2, 2, 4); // confluence mask
    map.setRoad(2, 2, 0, true);

    const edit = map.edit(tx => {
      tx.setTerrain(2, 2, TerrainType.Water);
      tx.setElevation(2, 2, -1);
      tx.setFeatureLevel(2, 2, 1, 0);
      tx.clearRiver(2, 2);
      tx.setRoad(2, 2, 0, false);
    });

    expect(edit.cells).toEqual([{ col: 2, row: 2 }]);

    edit.undo();
    expect(map.getTerrain(2, 2)).toBe(TerrainType.Desert);
    expect(map.getElevation(2, 2)).toBe(3);
    expect(map.getFeatureLevel(2, 2, 1)).toBe(2);
    expect(map.getIncomingRiverMask(2, 2)).toBe((1 << 1) | (1 << 4));
    expect(map.getIncomingRiverDir(2, 2)).toBe(1); // primary re-derived
    expect(map.hasRoadThroughEdge(2, 2, 0)).toBe(true);

    edit.redo();
    expect(map.getTerrain(2, 2)).toBe(TerrainType.Water);
    expect(map.getElevation(2, 2)).toBe(-1);
    expect(map.getFeatureLevel(2, 2, 1)).toBe(0);
    expect(map.getIncomingRiverMask(2, 2)).toBe(0);
    expect(map.hasRoadThroughEdge(2, 2, 0)).toBe(false);
  });

  it('snapshots and restores per-cell metadata through undo/redo', () => {
    const map = new HexMap({ width: 8, height: 8 });
    map.setCellData(2, 2, 'owner', 'clan-red');
    map.setCellData(2, 2, 'herd', { goats: 12 });

    const edit = map.edit(tx => {
      tx.setCellData(2, 2, 'owner', 'clan-blue');
      tx.setCellData(2, 2, 'herd', undefined); // delete a key
      tx.setCellData(3, 3, 'flag', true);      // create a record
      tx.clearCellData(4, 4);                  // no-op on empty cell, still touched
    });

    edit.undo();
    expect(map.getCellData(2, 2, 'owner')).toBe('clan-red');
    expect(map.getCellData(2, 2, 'herd')).toEqual({ goats: 12 });
    expect(map.hasCellData(3, 3)).toBe(false);

    edit.redo();
    expect(map.getCellData(2, 2, 'owner')).toBe('clan-blue');
    expect(map.getCellData(2, 2, 'herd')).toBeUndefined();
    expect(map.getCellData(3, 3, 'flag')).toBe(true);

    // Undo again — snapshots must not alias live records across cycles.
    edit.undo();
    expect(map.getCellData(2, 2, 'owner')).toBe('clan-red');
    map.setCellData(2, 2, 'owner', 'mutated');
    edit.redo();
    expect(map.getCellData(2, 2, 'owner')).toBe('clan-blue');
  });

  it('keeps the FIRST before-state when a cell is touched repeatedly', () => {
    const map = new HexMap({ width: 4, height: 4 });
    map.setElevation(1, 1, 5);
    const edit = map.edit(tx => {
      tx.setElevation(1, 1, 6);
      tx.setElevation(1, 1, 7);
      tx.setTerrain(1, 1, TerrainType.Rock);
    });
    edit.undo();
    expect(map.getElevation(1, 1)).toBe(5);
    expect(map.getTerrain(1, 1)).toBe(TerrainType.Grassland);
  });

  it('supports long-lived stroke transactions via beginEdit/commit', () => {
    const map = new HexMap({ width: 8, height: 8 });
    const tx = map.beginEdit();
    tx.setElevation(0, 0, 2);        // pointer event 1
    tx.setElevation(1, 0, 2);        // pointer event 2
    expect(map.getElevation(0, 0)).toBe(2); // applied live
    const edit = tx.commit();
    expect(edit.cells).toHaveLength(2);
    expect(() => tx.setElevation(2, 0, 2)).toThrow();

    edit.undo();
    expect(map.getElevation(0, 0)).toBe(0);
    expect(map.getElevation(1, 0)).toBe(0);
  });

  it('ignores out-of-bounds touches', () => {
    const map = new HexMap({ width: 4, height: 4 });
    const edit = map.edit(tx => tx.touch(-1, 99));
    expect(edit.isEmpty).toBe(true);
  });
});

describe('HexMap.setRoadEdge pairing', () => {
  it('sets both half-edges so both cells agree', () => {
    const map = new HexMap({ width: 8, height: 8 });
    const affected = map.setRoadEdge(3, 3, 0, true, POINTY_TOP);
    expect(affected).toHaveLength(2);
    const [a, b] = affected;
    expect(map.hasRoadThroughEdge(a.col, a.row, 0)).toBe(true);
    // The neighbour must report a road through its own shared edge.
    const n = map.roadEdgeNeighbor(3, 3, 0, POINTY_TOP)!;
    expect(n.col).toBe(b.col);
    expect(n.row).toBe(b.row);
    expect(map.hasRoadThroughEdge(n.col, n.row, n.edge)).toBe(true);

    map.setRoadEdge(3, 3, 0, false, POINTY_TOP);
    expect(map.hasRoads(a.col, a.row)).toBe(false);
    expect(map.hasRoads(b.col, b.row)).toBe(false);
  });

  it('the neighbour relation is symmetric', () => {
    const map = new HexMap({ width: 8, height: 8 });
    for (let e = 0; e < 6; e++) {
      const n = map.roadEdgeNeighbor(4, 4, e, POINTY_TOP);
      expect(n).not.toBeNull();
      const back = map.roadEdgeNeighbor(n!.col, n!.row, n!.edge, POINTY_TOP);
      expect(back).toEqual({ col: 4, row: 4, edge: e });
    }
  });

  it('affects only one cell at the map edge', () => {
    const map = new HexMap({ width: 4, height: 4 });
    let single = 0;
    for (let e = 0; e < 6; e++) {
      if (map.setRoadEdge(0, 0, e, true, POINTY_TOP).length === 1) single++;
    }
    expect(single).toBeGreaterThan(0); // corner cell has off-map neighbours
  });

  it('transaction setRoadEdge snapshots both cells for undo', () => {
    const map = new HexMap({ width: 8, height: 8 });
    const edit = map.edit(tx => tx.setRoadEdge(3, 3, 0, true, POINTY_TOP));
    expect(edit.cells).toHaveLength(2);
    edit.undo();
    for (const c of edit.cells) expect(map.hasRoads(c.col, c.row)).toBe(false);
  });
});

describe('ChunkManager neighbor-aware markDirty', () => {
  function makeManager(map: HexMap, scene: THREE.Scene) {
    return new ChunkManager({
      map,
      layout: createLayout(POINTY_TOP, 1),
      scene,
      material: new THREE.MeshBasicMaterial(),
      chunkSize: 16,
    });
  }

  it('rebuilds the adjacent chunk when a border cell is edited', () => {
    const scene = new THREE.Scene();
    const map = new HexMap({ width: 32, height: 16 }); // chunks (0,0) and (1,0)
    const cm  = makeManager(map, scene);
    cm.loadAll();

    const camera = new THREE.PerspectiveCamera();
    camera.position.set(16, 20, 8);
    cm.update(camera);

    const geosBefore = cm.terrainMeshes.map(m => m.geometry.uuid);
    expect(geosBefore).toHaveLength(2);

    // Edit the last column of chunk (0,0): chunk (1,0) geometry samples it.
    map.setElevation(15, 8, 4);
    cm.markDirty(15, 8);
    cm.update(camera);

    const geosAfter = cm.terrainMeshes.map(m => m.geometry.uuid);
    expect(geosAfter).toHaveLength(2);
    for (let i = 0; i < geosBefore.length; i++) {
      expect(geosAfter[i]).not.toBe(geosBefore[i]); // BOTH chunks rebuilt
    }
  });

  it('rebuilds only the owning chunk for interior cells', () => {
    const scene = new THREE.Scene();
    const map = new HexMap({ width: 32, height: 16 });
    const cm  = makeManager(map, scene);
    cm.loadAll();

    const camera = new THREE.PerspectiveCamera();
    camera.position.set(16, 20, 8);
    cm.update(camera);
    const geosBefore = cm.terrainMeshes.map(m => m.geometry.uuid);

    map.setElevation(8, 8, 4); // interior of chunk (0,0)
    cm.markDirty(8, 8);
    cm.update(camera);

    const geosAfter = cm.terrainMeshes.map(m => m.geometry.uuid);
    const changed = geosAfter.filter((g, i) => g !== geosBefore[i]);
    expect(changed).toHaveLength(1);
  });
});
