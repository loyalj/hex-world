import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { FogData } from '../src/geometry/FogData.js';
import { HexMap } from '../src/map/HexMap.js';
import { createLayout } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';
import { HexUnit } from '../src/units/HexUnit.js';
import { UnitManager } from '../src/units/UnitManager.js';

describe('FogData memory tiers', () => {
  it('separates the visible tier from the explored tier', () => {
    const fog = new FogData(8, 8, 0);

    expect(fog.isVisible(2, 3)).toBe(false);
    expect(fog.isExplored(2, 3)).toBe(false);

    fog.increaseVisibility(2, 3);
    expect(fog.isVisible(2, 3)).toBe(true);
    expect(fog.isExplored(2, 3)).toBe(true);

    // Losing sight drops the live tier but never the memory tier.
    fog.decreaseVisibility(2, 3);
    expect(fog.isVisible(2, 3)).toBe(false);
    expect(fog.isExplored(2, 3)).toBe(true);
  });

  it('reference-counts overlapping sources', () => {
    const fog = new FogData(8, 8, 0);
    fog.increaseVisibility(1, 1);
    fog.increaseVisibility(1, 1);
    expect(fog.visibilityCount(1, 1)).toBe(2);

    fog.decreaseVisibility(1, 1);
    expect(fog.isVisible(1, 1)).toBe(true); // one source still watching

    fog.decreaseVisibility(1, 1);
    expect(fog.isVisible(1, 1)).toBe(false);
  });

  it('reads out-of-bounds cells as neither visible nor explored', () => {
    const fog = new FogData(4, 4, 0);
    expect(fog.isVisible(-1, 0)).toBe(false);
    expect(fog.isExplored(0, 99)).toBe(false);
    expect(fog.visibilityCount(4, 4)).toBe(0);
  });

  it('markExplored adds memory without granting sight', () => {
    const fog = new FogData(8, 8, 0.5);
    fog.markExplored(5, 5);

    expect(fog.isExplored(5, 5)).toBe(true);
    expect(fog.isVisible(5, 5)).toBe(false);
    // Not animated by default: a restored/scripted cell is already remembered.
    expect(fog.rawData[(5 * 8 + 5) * 4 + 2]).toBe(255);
    expect(fog.isAnimating).toBe(false);

    fog.markExplored(6, 5, true);
    expect(fog.rawData[(5 * 8 + 6) * 4 + 2]).toBe(0);
    expect(fog.isAnimating).toBe(true);
  });

  it('unexplore takes a cell back to never-seen', () => {
    const fog = new FogData(8, 8, 0.5);
    fog.markExplored(3, 3, true);
    expect(fog.isExplored(3, 3)).toBe(true);
    expect(fog.isAnimating).toBe(true);

    fog.unexplore(3, 3);
    expect(fog.isExplored(3, 3)).toBe(false);
    expect(fog.isVisible(3, 3)).toBe(false);
    // The in-flight reveal is dropped too, not left to fade a hidden cell in.
    expect(fog.isAnimating).toBe(false);
    expect(fog.rawData[(3 * 8 + 3) * 4 + 2]).toBe(0);
    expect(fog.exploredCount).toBe(0);
  });

  it('unexplore clears the visibility count that would re-reveal the cell', () => {
    const fog = new FogData(8, 8, 0);
    fog.increaseVisibility(2, 2);
    expect(fog.isVisible(2, 2)).toBe(true);

    fog.unexplore(2, 2);
    expect(fog.isVisible(2, 2)).toBe(false);
    expect(fog.visibilityCount(2, 2)).toBe(0);
    expect(fog.isExplored(2, 2)).toBe(false);
  });

  it('unexplore ignores never-seen and out-of-bounds cells', () => {
    const fog = new FogData(8, 8, 0);
    expect(() => fog.unexplore(-1, 0)).not.toThrow();
    expect(() => fog.unexplore(0, 99)).not.toThrow();
    fog.unexplore(4, 4);
    expect(fog.exploredCount).toBe(0);
  });

  it('counts explored cells', () => {
    const fog = new FogData(8, 8, 0);
    expect(fog.exploredCount).toBe(0);
    fog.increaseVisibility(0, 0);
    fog.markExplored(1, 0);
    fog.markExplored(1, 0); // idempotent
    expect(fog.exploredCount).toBe(2);
  });
});

describe('FogData persistence', () => {
  it('round-trips the explored set through serialize/load', () => {
    const fog = new FogData(16, 12, 0);
    for (let c = 3; c < 9; c++) fog.increaseVisibility(c, 4);
    fog.markExplored(0, 0);
    fog.markExplored(15, 11);
    const expected = fog.exploredCount;

    const blob = fog.serialize();

    const restored = new FogData(16, 12, 0);
    restored.load(blob);

    expect(restored.exploredCount).toBe(expected);
    for (let c = 3; c < 9; c++) expect(restored.isExplored(c, 4)).toBe(true);
    expect(restored.isExplored(0, 0)).toBe(true);
    expect(restored.isExplored(15, 11)).toBe(true);
    expect(restored.isExplored(1, 1)).toBe(false);
  });

  it('restores memory but not visibility — the live tier is rebuilt from units', () => {
    const fog = new FogData(8, 8, 0);
    fog.increaseVisibility(2, 2);

    const restored = new FogData(8, 8, 0);
    restored.load(fog.serialize());

    expect(restored.isExplored(2, 2)).toBe(true);
    expect(restored.isVisible(2, 2)).toBe(false);
    expect(restored.visibilityCount(2, 2)).toBe(0);
  });

  it('restored cells skip the reveal animation', () => {
    const fog = new FogData(8, 8, 0.5);
    fog.increaseVisibility(4, 4);
    fog.update(1); // finish the fade

    const restored = new FogData(8, 8, 0.5);
    restored.load(fog.serialize());

    expect(restored.isAnimating).toBe(false);
    expect(restored.rawData[(4 * 8 + 4) * 4 + 2]).toBe(255);
  });

  it('leaves the texture dirty so dependent layers refresh', () => {
    const fog = new FogData(8, 8, 0);
    fog.increaseVisibility(1, 1);
    const blob = fog.serialize();

    const restored = new FogData(8, 8, 0);
    restored.update(); // settle
    expect(restored.needsUpdate).toBe(false);
    restored.load(blob);
    expect(restored.needsUpdate).toBe(true);
  });

  it('round-trips through base64', () => {
    const fog = new FogData(10, 10, 0);
    fog.increaseVisibility(5, 5);
    fog.markExplored(9, 9);

    const restored = new FogData(10, 10, 0);
    restored.loadBase64(fog.toBase64());

    expect(restored.isExplored(5, 5)).toBe(true);
    expect(restored.isExplored(9, 9)).toBe(true);
    expect(restored.exploredCount).toBe(fog.exploredCount);
  });

  it('stays compact for uniform maps', () => {
    const empty = new FogData(256, 256, 0);
    // One run covering every cell — a few bytes regardless of map size.
    expect(empty.serialize().byteLength).toBeLessThan(32);

    const full = new FogData(256, 256, 0);
    for (let row = 0; row < 256; row++) {
      for (let col = 0; col < 256; col++) full.markExplored(col, row);
    }
    // Fully explored collapses to a zero-length gap plus one long run.
    expect(full.serialize().byteLength).toBeLessThan(32);
  });

  it('replaces prior state on load rather than merging', () => {
    const saved = new FogData(8, 8, 0);
    saved.markExplored(0, 0);

    const fog = new FogData(8, 8, 0);
    fog.markExplored(7, 7);
    fog.load(saved.serialize());

    expect(fog.isExplored(0, 0)).toBe(true);
    expect(fog.isExplored(7, 7)).toBe(false);
  });

  it('rejects foreign, newer, and mismatched data', () => {
    const fog = new FogData(8, 8, 0);

    expect(() => fog.load(new Uint8Array(4))).toThrow(/too short/);
    expect(() => fog.load(new Uint8Array(20))).toThrow(/magic bytes/);

    const future = fog.serialize();
    future[4] = 99;
    expect(() => fog.load(future)).toThrow(/version 99/);

    const otherSize = new FogData(16, 16, 0).serialize();
    expect(() => fog.load(otherSize)).toThrow(/16×16/);
  });
});

describe('UnitManager fog ghosting', () => {
  function setup(hideUnitsInFog?: boolean) {
    const map    = new HexMap({ width: 16, height: 16 });
    const layout = createLayout(POINTY_TOP, 1);
    const scene  = new THREE.Scene();
    const fogData = new FogData(16, 16, 0);
    const manager = new UnitManager({
      scene, map, layout, fogData,
      ...(hideUnitsInFog === undefined ? {} : { hideUnitsInFog }),
    });
    return { map, layout, scene, fogData, manager };
  }

  it('hides a unit that grants no vision until something sees it', () => {
    const { fogData, manager } = setup();

    // fogRevealRange 0 — an enemy scout nobody is watching.
    const enemy = new HexUnit({ col: 8, row: 8, fogRevealRange: 0 });
    const mesh  = new THREE.Mesh();
    manager.addUnit(enemy, mesh);
    expect(mesh.visible).toBe(false);

    // Someone looks at that hex: the unit appears.
    fogData.increaseVisibility(8, 8);
    manager.update(0);
    expect(mesh.visible).toBe(true);

    // Sight is lost — the terrain stays remembered, the unit does not.
    fogData.decreaseVisibility(8, 8);
    manager.update(0);
    expect(mesh.visible).toBe(false);
    expect(fogData.isExplored(8, 8)).toBe(true);
  });

  it('keeps units that see for themselves visible', () => {
    const { manager } = setup();
    const scout = new HexUnit({ col: 4, row: 4, fogRevealRange: 2 });
    const mesh  = new THREE.Mesh();
    manager.addUnit(scout, mesh);

    expect(mesh.visible).toBe(true);
    manager.update(0);
    expect(mesh.visible).toBe(true);
  });

  it('can be turned off, restoring visibility control to the caller', () => {
    const { manager } = setup(false);
    const enemy = new HexUnit({ col: 8, row: 8, fogRevealRange: 0 });
    const mesh  = new THREE.Mesh();
    manager.addUnit(enemy, mesh);

    expect(mesh.visible).toBe(true);
    manager.update(0);
    expect(mesh.visible).toBe(true);

    // Toggling it on applies the rule immediately…
    manager.hideUnitsInFog = true;
    expect(mesh.visible).toBe(false);
    // …and toggling it back off hands every unit back, shown.
    manager.hideUnitsInFog = false;
    expect(mesh.visible).toBe(true);
  });

  it('reapplyFog rebuilds the live tier and unit visibility after a load', () => {
    const { fogData, manager } = setup();
    const scout = new HexUnit({ col: 4, row: 4, fogRevealRange: 2 });
    const enemy = new HexUnit({ col: 12, row: 12, fogRevealRange: 0 });
    const scoutMesh = new THREE.Mesh();
    const enemyMesh = new THREE.Mesh();
    manager.addUnit(scout, scoutMesh);
    manager.addUnit(enemy, enemyMesh);

    // A save/load cycle: memory survives, visibility does not.
    const blob = fogData.serialize();
    fogData.load(blob);
    expect(fogData.isVisible(4, 4)).toBe(false);

    manager.reapplyFog();
    expect(fogData.isVisible(4, 4)).toBe(true);
    expect(scoutMesh.visible).toBe(true);
    expect(enemyMesh.visible).toBe(false);
  });

  it('reports per-unit visibility', () => {
    const { fogData, manager } = setup();
    const enemy = new HexUnit({ col: 3, row: 3, fogRevealRange: 0 });
    manager.addUnit(enemy, new THREE.Mesh());

    expect(manager.isUnitVisible(enemy)).toBe(false);
    fogData.increaseVisibility(3, 3);
    expect(manager.isUnitVisible(enemy)).toBe(true);
  });
});
