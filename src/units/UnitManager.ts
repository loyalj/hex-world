import * as THREE from 'three';
import type { HexMap } from '../map/HexMap.js';
import type { HexLayout } from '../math/HexLayout.js';
import type { FogData } from '../geometry/FogData.js';
import { getVisibleCells } from '../pathfinding/Pathfinding.js';
import { offsetToHex, hexToOffset } from '../math/HexCoord.js';
import { HexUnit } from './HexUnit.js';
import { Emitter } from '../events/Emitter.js';

/** A unit and the cell it is standing on — the shape most unit events carry. */
export interface UnitEvent {
  unit: HexUnit;
  col: number;
  row: number;
}

/** Events emitted by {@link UnitManager.events}. */
export interface UnitManagerEventMap {
  /** A unit was registered and its Object3D added to the scene. */
  unitAdded: { unit: HexUnit; object3D: THREE.Object3D };
  /** A unit was removed from the scene and its fog contribution withdrawn. */
  unitRemoved: { unit: HexUnit; object3D: THREE.Object3D };
  /** A unit began following a new path. `col`/`row` are where it set off from. */
  unitMoveStart: UnitEvent;
  /**
   * A unit crossed into a new cell mid-path. Fires after the fog reveal for
   * that cell, so a listener reading `fogData` sees the post-move visibility.
   */
  unitCellEnter: UnitEvent;
  /**
   * A unit reached the **end of its path**. The event most turn logic wants:
   * unlike `unitMoveEnd` it does not fire for an interrupted move.
   */
  unitArrived: UnitEvent;
  /**
   * A unit stopped moving, whether it finished the path (`completed: true`) or
   * {@link HexUnit.stop} cut it short. Pair with animation state.
   */
  unitMoveEnd: UnitEvent & { completed: boolean };
}

/** The unit callbacks this manager wraps, kept so `removeUnit` can put them back. */
interface WrappedCallbacks {
  onCellEnter: HexUnit['onCellEnter'];
  onMoveStart: HexUnit['onMoveStart'];
  onMoveEnd:   HexUnit['onMoveEnd'];
}

export interface UnitManagerOptions {
  scene:    THREE.Scene;
  map:      HexMap;
  layout:   HexLayout;
  /** Optional fog-of-war data. Units with `fogRevealRange > 0` will update it as they move. */
  fogData?: FogData;
  /**
   * Hide units standing on cells that are explored but not currently visible —
   * the classic ghost state, where memory shows you the terrain you mapped but
   * not who is walking on it right now. Ignored when no `fogData` is given.
   *
   * A unit with `fogRevealRange > 0` always sees its own cell, so this only
   * ever hides units that grant no vision (enemies, neutrals). Default `true`.
   */
  hideUnitsInFog?: boolean;
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
  /**
   * Unit lifecycle and movement events. The same information the per-unit
   * `onMoveStart` / `onCellEnter` / `onMoveEnd` callbacks carry, but as a
   * broadcast: any number of subscribers, and no need to re-wire a callback
   * every time a unit is created.
   *
   * ```ts
   * unitManager.events.on('unitArrived', ({ unit, col, row }) => endTurn(unit, col, row));
   * ```
   */
  readonly events = new Emitter<UnitManagerEventMap>();

  private readonly _opts: UnitManagerOptions;
  private readonly _units = new Map<HexUnit, THREE.Object3D>();
  /** Tracks which cells each unit is currently revealing, for decreaseVisibility on move. */
  private readonly _fogCells = new Map<HexUnit, { col: number; row: number }[]>();
  /** The callbacks each managed unit had before `addUnit` wrapped them. */
  private readonly _wrapped = new Map<HexUnit, WrappedCallbacks>();
  private _hideUnitsInFog: boolean;

  constructor(opts: UnitManagerOptions) {
    this._opts = opts;
    this._hideUnitsInFog = opts.hideUnitsInFog ?? true;
  }

  /**
   * Whether units on explored-but-not-currently-visible cells are hidden.
   * While enabled, this manager owns each unit Object3D's `visible` flag —
   * turn it off to drive visibility yourself.
   */
  get hideUnitsInFog(): boolean { return this._hideUnitsInFog; }
  set hideUnitsInFog(enabled: boolean) {
    this._hideUnitsInFog = enabled;
    if (enabled) {
      this._applyUnitVisibility();
    } else {
      for (const obj of this._units.values()) obj.visible = true;
    }
  }

  /**
   * True if the unit's cell is currently within some source's sight — i.e.
   * whether it is drawn under the ghost-state rule. Always true when there is
   * no fog data.
   */
  isUnitVisible(unit: HexUnit): boolean {
    const { fogData } = this._opts;
    if (!fogData) return true;
    return fogData.isVisible(unit.col, unit.row);
  }

  /** Push the ghost-state rule onto every unit's Object3D. */
  private _applyUnitVisibility(): void {
    const { fogData } = this._opts;
    if (!fogData || !this._hideUnitsInFog) return;
    for (const [unit, obj] of this._units) {
      obj.visible = fogData.isVisible(unit.col, unit.row);
    }
  }

  /**
   * Registers a unit and adds its Object3D to the scene.
   * The unit's initial fog reveal is applied immediately if `fogRevealRange > 0`.
   *
   * The unit's own `onMoveStart` / `onCellEnter` / `onMoveEnd` callbacks are
   * wrapped, not replaced — whatever you set stays wired, and {@link removeUnit}
   * puts the originals back, so a unit can be removed and re-added without
   * stacking a second layer of fog reveals on it.
   */
  addUnit(unit: HexUnit, object3D: THREE.Object3D): void {
    if (this._units.has(unit)) return;
    this._units.set(unit, object3D);
    this._opts.scene.add(object3D);

    this._wrapped.set(unit, {
      onCellEnter: unit.onCellEnter,
      onMoveStart: unit.onMoveStart,
      onMoveEnd:   unit.onMoveEnd,
    });
    const original = this._wrapped.get(unit)!;

    // Wire fog reveal through the unit's cell-enter callback.
    // Reveal runs first so that user callbacks and event listeners see
    // up-to-date fog state.
    unit.onCellEnter = (col, row) => {
      this._revealForUnit(unit, col, row);
      original.onCellEnter?.(col, row);
      this.events.emit('unitCellEnter', { unit, col, row });
    };
    unit.onMoveStart = () => {
      original.onMoveStart?.();
      this.events.emit('unitMoveStart', { unit, col: unit.col, row: unit.row });
    };
    unit.onMoveEnd = (completed) => {
      original.onMoveEnd?.(completed);
      const at = { unit, col: unit.col, row: unit.row };
      if (completed) this.events.emit('unitArrived', at);
      this.events.emit('unitMoveEnd', { ...at, completed });
    };

    // Snap to initial position and apply initial fog reveal.
    unit.update(0, this._opts.map, this._opts.layout);
    object3D.position.set(unit.worldX, unit.worldY, unit.worldZ);
    object3D.rotation.y = unit.facing;
    this._revealForUnit(unit, unit.col, unit.row);
    if (this._opts.fogData && this._hideUnitsInFog) {
      object3D.visible = this._opts.fogData.isVisible(unit.col, unit.row);
    }
    this.events.emit('unitAdded', { unit, object3D });
  }

  /**
   * Removes a unit from the scene, withdraws its fog reveal contribution, and
   * restores the callbacks {@link addUnit} wrapped.
   */
  removeUnit(unit: HexUnit): void {
    const obj = this._units.get(unit);
    if (!obj) return;
    this._opts.scene.remove(obj);
    this._units.delete(unit);
    this._withdrawFog(unit);
    this._fogCells.delete(unit);

    const original = this._wrapped.get(unit);
    if (original) {
      unit.onCellEnter = original.onCellEnter;
      unit.onMoveStart = original.onMoveStart;
      unit.onMoveEnd   = original.onMoveEnd;
      this._wrapped.delete(unit);
    }
    this.events.emit('unitRemoved', { unit, object3D: obj });
  }

  /**
   * Call once per frame with the elapsed time in seconds.
   * Updates all unit positions and syncs their Object3Ds — including the
   * ghost-state rule when `hideUnitsInFog` is on.
   */
  update(deltaTime: number): void {
    const { map, layout, fogData } = this._opts;
    const applyFogVisibility = !!fogData && this._hideUnitsInFog;
    for (const [unit, obj] of this._units) {
      unit.update(deltaTime, map, layout);
      obj.position.set(unit.worldX, unit.worldY, unit.worldZ);
      obj.rotation.y = unit.facing;
      if (applyFogVisibility) obj.visible = fogData!.isVisible(unit.col, unit.row);
    }
  }

  /**
   * Clears and re-applies all unit fog contributions.
   * Call this after `fogData.reset()` — or after `fogData.load()` restores a
   * saved memory tier — to rebuild the live visibility tier from where the
   * units actually are.
   */
  reapplyFog(): void {
    for (const unit of this._units.keys()) {
      this._fogCells.set(unit, []);
      this._revealForUnit(unit, unit.col, unit.row);
    }
    this._applyUnitVisibility();
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
