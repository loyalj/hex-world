import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { HexMap } from '../src/map/HexMap.js';
import { ChunkManager } from '../src/geometry/ChunkManager.js';
import { createLayout } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';
import { resolveLiquidMaterials, DEFAULT_LIQUID_DESCRIPTORS } from '../src/geometry/LiquidTypes.js';

const EDGE_DIRS = POINTY_TOP.edgeDirections;
const WATER = 5;
const eastEdge = EDGE_DIRS.findIndex(d => d === 0);

/** A 3-cell river flowing east along `row` into a pond at column 10. */
function paintRiver(map: HexMap, row: number): void {
  const pondCol = 10;
  map.setTerrain(pondCol, row, WATER);
  map.setElevation(pondCol, row, -1);
  for (let c = pondCol - 3; c < pondCol; c++) {
    map.setElevation(c, row, pondCol - c);
    map.setRiverOutgoing(c, row, eastEdge);
    map.setRiverIncoming(c + 1, row, (eastEdge + 3) % 6);
  }
  map.computeWaterSurfaces();
}

describe('HexMap.riverRevision', () => {
  it('bumps on every river edge write', () => {
    const map = new HexMap({ width: 8, height: 8 });
    let rev = map.riverRevision;
    const step = (fn: () => void): void => { fn(); expect(map.riverRevision).toBeGreaterThan(rev); rev = map.riverRevision; };
    step(() => map.setRiverOutgoing(2, 2, eastEdge));
    step(() => map.setRiverIncoming(3, 2, (eastEdge + 3) % 6));
    step(() => map.removeRiverIncoming(3, 2, (eastEdge + 3) % 6));
    step(() => map.removeRiverOutgoing(2, 2));
    step(() => map.clearRiver(2, 2));
    step(() => map.clear());
    step(() => map.bumpRiverRevision());
  });

  it('ignores terrain and elevation writes on dry cells, counts them on river cells', () => {
    const map = new HexMap({ width: 8, height: 8 });
    paintRiver(map, 4);
    const rev = map.riverRevision;

    map.setTerrain(1, 1, 2);
    map.setElevation(1, 1, 3);
    map.setTerrain(1, 1, 2); // no-op rewrite
    expect(map.riverRevision).toBe(rev);

    map.setTerrain(8, 4, 2); // a river cell's ground changes what it drains through
    expect(map.riverRevision).toBe(rev + 1);
    map.setElevation(8, 4, 6); // and its level carves differently
    expect(map.riverRevision).toBe(rev + 2);
    map.setElevation(8, 4, 6); // unchanged value: no bump
    expect(map.riverRevision).toBe(rev + 2);
  });

  it('undo and redo bump only when a touched cell carries a river on either side', () => {
    const map = new HexMap({ width: 8, height: 8 });
    paintRiver(map, 4);

    const dry = map.beginEdit();
    dry.setTerrain(1, 1, 2);
    const dryEdit = dry.commit();
    const rev = map.riverRevision;
    dryEdit.undo();
    dryEdit.redo();
    expect(map.riverRevision).toBe(rev);

    // Extend the river one cell west, then undo: the restore writes raw bytes,
    // so the transaction itself has to report the change.
    const wet = map.beginEdit();
    wet.setRiverOutgoing(6, 4, eastEdge);
    wet.setRiverIncoming(7, 4, (eastEdge + 3) % 6);
    const wetEdit = wet.commit();
    const afterWrite = map.riverRevision;
    expect(afterWrite).toBeGreaterThan(rev);
    wetEdit.undo();
    expect(map.riverRevision).toBeGreaterThan(afterWrite);
    expect(map.hasRiver(6, 4)).toBe(false);
    const afterUndo = map.riverRevision;
    wetEdit.redo();
    expect(map.riverRevision).toBeGreaterThan(afterUndo);
    expect(map.hasRiver(6, 4)).toBe(true);
  });
});

describe('ChunkManager river caches', () => {
  function build(): { map: HexMap; cm: ChunkManager; caches: () => [unknown, unknown, unknown] } {
    const scene  = new THREE.Scene();
    const map    = new HexMap({ width: 16, height: 16 });
    const layout = createLayout(POINTY_TOP, 1);
    const cm = new ChunkManager({
      map, layout, scene,
      material: new THREE.MeshBasicMaterial(),
      liquidMaterials: new Map([['water', resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0])]]),
      chunkSize: 16,
    });
    paintRiver(map, 4);
    cm.loadAll();
    // Private fields, read for the test: the three map-wide river caches.
    const p = cm as unknown as { riverFlowCache: unknown; riverElevCache: unknown; riverCellsByLiquid: unknown };
    return { map, cm, caches: () => [p.riverFlowCache, p.riverElevCache, p.riverCellsByLiquid] };
  }

  it('keeps the caches through a terrain edit on dry land', () => {
    const { map, cm, caches } = build();
    const before = caches();
    expect(before.every(c => c !== null)).toBe(true);

    map.setTerrain(2, 12, 2);
    cm.markDirty(2, 12);
    cm.update(new THREE.PerspectiveCamera());
    expect(caches()).toEqual(before); // same objects, never rebuilt
  });

  it('rebuilds them after a river edit, and after undoing one', () => {
    const { map, cm, caches } = build();
    const before = caches();

    const tx = map.beginEdit();
    tx.setRiverOutgoing(6, 4, eastEdge);
    tx.setRiverIncoming(7, 4, (eastEdge + 3) % 6);
    const edit = tx.commit();
    cm.markDirtyCells(edit.cells);
    cm.update(new THREE.PerspectiveCamera());
    const after = caches();
    expect(after.every(c => c !== null)).toBe(true);
    for (let i = 0; i < 3; i++) expect(after[i]).not.toBe(before[i]);

    edit.undo();
    cm.markDirtyCells(edit.cells);
    cm.update(new THREE.PerspectiveCamera());
    const undone = caches();
    for (let i = 0; i < 3; i++) expect(undone[i]).not.toBe(after[i]);
  });

  it('starts fresh after dispose and reload of a rewritten map', () => {
    const { map, cm, caches } = build();
    map.clear();
    paintRiver(map, 11);
    cm.dispose();
    cm.loadAll();
    const flow = caches()[0] as Map<number, number>;
    expect(flow.size).toBeGreaterThan(0);
    expect([...flow.keys()].every(k => Math.floor(k / map.width) === 11)).toBe(true);
  });
});
