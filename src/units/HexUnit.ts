import type { HexMap } from '../map/HexMap.js';
import type { HexLayout } from '../math/HexLayout.js';
import { hexToWorld } from '../math/HexLayout.js';
import type { HexCoord } from '../math/HexCoord.js';
import { hexToOffset, offsetToHex } from '../math/HexCoord.js';
import { cellSurfaceY, type CellSurfaceOptions } from '../map/CellSurface.js';

export interface HexUnitOptions {
  col: number;
  row: number;
  /** Cells per second. Default 4. */
  travelSpeed?: number;
  /**
   * Y offset applied above the terrain surface, in world units.
   * Set to half the model's height when the pivot is at the model center,
   * or a small value (e.g. 0.05) when the pivot is at the model's foot.
   * Default 0.
   */
  heightOffset?: number;
  /**
   * BFS fog-of-war reveal radius in cells.
   * 0 = unit does not reveal fog. Default 0.
   */
  fogRevealRange?: number;
  /**
   * Surface height parameters — pass the same values you gave the terrain
   * geometry (elevationScale, noiseScale, elevPerturbStrength) if you
   * customized them, plus an `isWater` predicate if units should ride the
   * water surface instead of the seabed. Defaults match the default terrain.
   */
  surfaceOptions?: CellSurfaceOptions;
}

export class HexUnit {
  /** Current logical cell column (updates as unit enters each new cell). */
  col: number;
  /** Current logical cell row (updates as unit enters each new cell). */
  row: number;

  readonly travelSpeed:   number;
  readonly heightOffset:  number;
  readonly fogRevealRange: number;
  readonly surfaceOptions: CellSurfaceOptions;

  /** Smoothly interpolated world-space X. Read by UnitManager each frame. */
  worldX = 0;
  /** Smoothly interpolated world-space Y (terrain elevation + heightOffset). */
  worldY = 0;
  /** Smoothly interpolated world-space Z. */
  worldZ = 0;
  /** Facing direction in radians around the Y axis. Applied to Object3D.rotation.y. */
  facing = 0;

  isMoving = false;

  /**
   * Called when the unit starts following a new path.
   * Use this to trigger a walk/run animation on your GLTF model.
   */
  onMoveStart?: () => void;
  /**
   * Called each time the unit enters a new hex cell during movement.
   * Use this to trigger footstep sounds, update fog, etc.
   */
  onCellEnter?: (col: number, row: number) => void;
  /**
   * Called when the unit stops moving — either because it walked its path to
   * the end (`completed: true`) or because {@link stop} cut the move short
   * (`completed: false`). Use this to return to an idle animation; check the
   * flag when "arrived" has to mean *arrived* (turn resolution, triggers).
   */
  onMoveEnd?: (completed: boolean) => void;

  private _path: HexCoord[] = [];
  private _segIdx  = 0;    // current segment: path[_segIdx] → path[_segIdx+1]
  private _progress = 0;   // 0–1 within current segment
  private _segNeedsLoad = false;

  private _fx = 0; private _fy = 0; private _fz = 0;
  private _tx = 0; private _ty = 0; private _tz = 0;

  constructor(opts: HexUnitOptions) {
    this.col           = opts.col;
    this.row           = opts.row;
    this.travelSpeed   = opts.travelSpeed   ?? 4;
    this.heightOffset  = opts.heightOffset  ?? 0;
    this.fogRevealRange = opts.fogRevealRange ?? 0;
    this.surfaceOptions = opts.surfaceOptions ?? {};
  }

  /**
   * Starts the unit moving along a path.
   * `path[0]` should be the unit's current position (it is used as the segment start
   * but the unit does not fire `onCellEnter` for it).
   * Pass a path returned by `findPath()`.
   */
  travel(path: HexCoord[]): void {
    if (path.length < 2) return;
    this._path = path;
    this._segIdx = 0;
    this._progress = 0;
    this._segNeedsLoad = true;
    if (!this.isMoving) {
      this.isMoving = true;
      this.onMoveStart?.();
    }
  }

  /** Immediately halts movement at the current interpolated position. */
  stop(): void {
    if (this.isMoving) {
      this.isMoving = false;
      this._path = [];
      this.onMoveEnd?.(false);
    }
  }

  /** Call once per frame. Updates worldX/Y/Z and facing. deltaTime in seconds. */
  update(dt: number, map: HexMap, layout: HexLayout): void {
    if (!this.isMoving) {
      this._snapToCell(map, layout);
      return;
    }

    if (this._segNeedsLoad) {
      this._loadSegment(this._segIdx, map, layout);
      this._segNeedsLoad = false;
    }

    this._progress += dt * this.travelSpeed;

    // Use a while loop so a fast unit can cross multiple cells in one frame.
    while (this._progress >= 1.0 && this.isMoving) {
      this._progress -= 1.0;

      const arrived = this._path[this._segIdx + 1];
      const oc = hexToOffset(arrived);
      this.col = oc.col;
      this.row = oc.row;
      this.onCellEnter?.(this.col, this.row);

      this._segIdx++;
      if (this._segIdx >= this._path.length - 1) {
        this._snapToCell(map, layout);
        this._path = [];
        this.isMoving = false;
        this.onMoveEnd?.(true);
        return;
      }
      this._loadSegment(this._segIdx, map, layout);
    }

    if (this.isMoving) {
      const t = this._progress;
      this.worldX = this._fx + (this._tx - this._fx) * t;
      this.worldY = this._fy + (this._ty - this._fy) * t + this.heightOffset;
      this.worldZ = this._fz + (this._tz - this._fz) * t;
    }
  }

  private _loadSegment(idx: number, map: HexMap, layout: HexLayout): void {
    const fromCoord = this._path[idx];
    const toCoord   = this._path[idx + 1];

    const fw = hexToWorld(layout, fromCoord);
    const tw = hexToWorld(layout, toCoord);

    const fOff = hexToOffset(fromCoord);
    const tOff = hexToOffset(toCoord);

    // Same surface formula the terrain mesh uses, so units sit on the visible
    // ground (including the per-cell noise perturbation) rather than the flat
    // elevation plane.
    this._fx = fw.x;
    this._fy = cellSurfaceY(map, layout, fOff.col, fOff.row, this.surfaceOptions);
    this._fz = fw.z;
    this._tx = tw.x;
    this._ty = cellSurfaceY(map, layout, tOff.col, tOff.row, this.surfaceOptions);
    this._tz = tw.z;

    this.facing = Math.atan2(this._tx - this._fx, this._tz - this._fz);
  }

  private _snapToCell(map: HexMap, layout: HexLayout): void {
    const wp = hexToWorld(layout, offsetToHex(this.col, this.row));
    this.worldX = wp.x;
    this.worldY = cellSurfaceY(map, layout, this.col, this.row, this.surfaceOptions) + this.heightOffset;
    this.worldZ = wp.z;
  }
}
