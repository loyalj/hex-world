import * as THREE from 'three';
import type { HexMap } from '../map/HexMap.js';
import type { HexLayout } from '../math/HexLayout.js';
import type { FogData } from '../geometry/FogData.js';
import { getVisibleCells } from '../pathfinding/Pathfinding.js';
import { offsetToHex, hexToOffset } from '../math/HexCoord.js';
import { HexUnit } from './HexUnit.js';

export interface UnitManagerOptions {
  scene:    THREE.Scene;
  map:      HexMap;
  layout:   HexLayout;
  /** Optional fog-of-war data. Units with `fogRevealRange > 0` will update it as they move. */
  fogData?: FogData;
}

/**
 * Manages a collection of HexUnits — updates their world positions each frame
 * and syncs their attached Three.js Object3Ds.
 *
 * Usage:
 * ```ts
 * const unitManager = new UnitManager({ scene, map, layout, fogData });
 *
 * const unit = new HexUnit({ col: 10, row: 10, travelSpeed: 4, fogRevealRange: 3 });
 * unit.onMoveStart = () => mixer.clipAction(walkClip).play();
 * unit.onMoveEnd   = () => mixer.clipAction(idleClip).play();
 *
 * unitManager.addUnit(unit, gltf.scene);
 * unit.travel(path);
 *
 * // In your render loop:
 * unitManager.update(deltaTime);
 * ```
 */
export class UnitManager {
  private readonly _opts: UnitManagerOptions;
  private readonly _units = new Map<HexUnit, THREE.Object3D>();
  /** Tracks which cells each unit is currently revealing, for decreaseVisibility on move. */
  private readonly _fogCells = new Map<HexUnit, { col: number; row: number }[]>();

  constructor(opts: UnitManagerOptions) {
    this._opts = opts;
  }

  /**
   * Registers a unit and adds its Object3D to the scene.
   * The unit's initial fog reveal is applied immediately if `fogRevealRange > 0`.
   */
  addUnit(unit: HexUnit, object3D: THREE.Object3D): void {
    if (this._units.has(unit)) return;
    this._units.set(unit, object3D);
    this._opts.scene.add(object3D);

    // Wire fog reveal through the unit's cell-enter callback.
    // Reveal runs first so that user callbacks see up-to-date fog state.
    const existingCellEnter = unit.onCellEnter;
    unit.onCellEnter = (col, row) => {
      this._revealForUnit(unit, col, row);
      existingCellEnter?.(col, row);
    };

    // Snap to initial position and apply initial fog reveal.
    unit.update(0, this._opts.map, this._opts.layout);
    object3D.position.set(unit.worldX, unit.worldY, unit.worldZ);
    object3D.rotation.y = unit.facing;
    this._revealForUnit(unit, unit.col, unit.row);
  }

  /**
   * Removes a unit from the scene and withdraws its fog reveal contribution.
   */
  removeUnit(unit: HexUnit): void {
    const obj = this._units.get(unit);
    if (!obj) return;
    this._opts.scene.remove(obj);
    this._units.delete(unit);
    this._withdrawFog(unit);
    this._fogCells.delete(unit);
  }

  /**
   * Call once per frame with the elapsed time in seconds.
   * Updates all unit positions and syncs their Object3Ds.
   */
  update(deltaTime: number): void {
    const { map, layout } = this._opts;
    for (const [unit, obj] of this._units) {
      unit.update(deltaTime, map, layout);
      obj.position.set(unit.worldX, unit.worldY, unit.worldZ);
      obj.rotation.y = unit.facing;
    }
  }

  /**
   * Clears and re-applies all unit fog contributions.
   * Call this after `fogData.reset()` to restore each unit's reveal radius.
   */
  reapplyFog(): void {
    for (const unit of this._units.keys()) {
      this._fogCells.set(unit, []);
      this._revealForUnit(unit, unit.col, unit.row);
    }
  }

  /** Removes all units from the scene. */
  dispose(): void {
    for (const unit of this._units.keys()) {
      this.removeUnit(unit);
    }
  }

  private _revealForUnit(unit: HexUnit, col: number, row: number): void {
    const { fogData, map } = this._opts;
    if (!fogData || unit.fogRevealRange <= 0) return;

    this._withdrawFog(unit);

    const center = offsetToHex(col, row);
    const cells  = getVisibleCells(center, unit.fogRevealRange, map);
    const granted: { col: number; row: number }[] = [];

    for (const c of cells) {
      const oc = hexToOffset(c);
      if (map.inBounds(oc.col, oc.row)) {
        fogData.increaseVisibility(oc.col, oc.row);
        granted.push(oc);
      }
    }
    this._fogCells.set(unit, granted);
  }

  private _withdrawFog(unit: HexUnit): void {
    const { fogData } = this._opts;
    if (!fogData) return;
    const cells = this._fogCells.get(unit);
    if (cells) {
      for (const c of cells) fogData.decreaseVisibility(c.col, c.row);
    }
    this._fogCells.set(unit, []);
  }
}
