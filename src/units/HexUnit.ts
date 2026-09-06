import type { HexMap } from '../map/HexMap.js';
import type { HexLayout } from '../math/HexLayout.js';
import { hexToWorld } from '../math/HexLayout.js';
import type { HexCoord } from '../math/HexCoord.js';
import { hexToOffset, offsetToHex } from '../math/HexCoord.js';
import { cellSurfaceY, type CellSurfaceOptions } from '../map/CellSurface.js';
import type { MovementDomain } from '../pathfinding/MovementDomains.js';

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
  /**
   * Where this unit can go — see {@link MovementDomain}. Informational on the
   * unit itself (the cost function you hand `findPath` is what enforces it —
   * build one with `createDomainCost`), but it is what a game reads to pick
   * that cost function, and what the editor and save files carry. Default 'land'.
   */
  domain?: MovementDomain;
  /**
   * Which terrains are liquid, for embark/disembark detection and for riding
   * the water surface: when set and `surfaceOptions.isWater` is not, it is
   * used as that predicate too, so a ship floats at the surface instead of
   * standing on the sea bed. `HexWorld.isWater` is the usual value.
   */
  isLiquid?: (terrain: number) => boolean;
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
  readonly domain: MovementDomain;
  readonly isLiquid: ((terrain: number) => boolean) | null;

  /**
   * True while the unit stands on a liquid cell — afloat. Set from the start
   * cell on the first {@link update} and flipped as the unit crosses a
   * shoreline, with {@link onEmbark} / {@link onDisembark} fired at the
   * crossing. Always false for a unit with no `isLiquid` predicate.
   */
  embarked = false;
  private _embarkedKnown = false;

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
  /**
   * Called when the unit steps from land onto a liquid cell — swap the
   * walker for the boat here. Fires before `onCellEnter` for that cell.
   */
  onEmbark?: (col: number, row: number) => void;
  /** Called when the unit steps from a liquid cell onto land. Fires before `onCellEnter`. */
  onDisembark?: (col: number, row: number) => void;

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
    this.domain         = opts.domain ?? 'land';
    this.isLiquid       = opts.isLiquid ?? null;
    const surface = opts.surfaceOptions ?? {};
    // A unit that knows what floats rides the surface of it by default.
    this.surfaceOptions = opts.isLiquid && !surface.isWater ? { ...surface, isWater: opts.isLiquid } : surface;
  }

  /**
   * Bring `embarked` in line with the cell the unit is on. The first call
   * (spawn) sets it silently; later ones fire the transition callbacks.
   */
  private _syncEmbarked(map: HexMap): void {
    if (!this.isLiquid) return;
    const afloat = this.isLiquid(map.getTerrain(this.col, this.row));
    if (!this._embarkedKnown) {
      this._embarkedKnown = true;
      this.embarked = afloat;
      return;
    }
    if (afloat === this.embarked) return;
    this.embarked = afloat;
    if (afloat) this.onEmbark?.(this.col, this.row);
    else        this.onDisembark?.(this.col, this.row);
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
      this._syncEmbarked(map);
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
      this._syncEmbarked(map);
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
