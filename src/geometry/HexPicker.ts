import * as THREE from 'three';
import type { HexLayout } from '../math/HexLayout.js';
import { pickHex, pickHexFromMeshes } from './HexPicking.js';
import { ELEVATION_SCALE } from '../map/HexCell.js';

/** Minimal map surface needed by HexPicker — HexMap satisfies it. */
export interface HexPickerSource {
  width: number;
  height: number;
  getTerrain(col: number, row: number): number;
  getElevation(col: number, row: number): number;
  getWaterSurface(col: number, row: number): number;
}

export interface HexPickerOptions {
  camera: THREE.Camera;
  domElement: HTMLElement;
  layout: HexLayout;
  /**
   * The map to pick against. Pass an accessor when the map instance can be
   * swapped at runtime (e.g. an editor loading a new map).
   */
  map: HexPickerSource | (() => HexPickerSource);
  /**
   * Terrain meshes for the primary raycast — usually
   * `() => chunkManager.terrainMeshes`. Pass an accessor so the picker sees
   * fresh meshes as chunks stream in and out.
   */
  meshes: THREE.Mesh[] | (() => THREE.Mesh[]);
  /**
   * Liquid predicate (e.g. `t => waterTerrainSet.has(t)`). When provided,
   * picks that land on a liquid cell are re-picked against that cell's
   * computed water surface plane, so the result matches the surface the user
   * actually sees instead of the seabed geometry underneath it.
   */
  isWater?: (terrain: number) => boolean;
  /** Must match the terrain geometry's `elevationScale`. Default ELEVATION_SCALE. */
  elevationScale?: number;
  /**
   * How many consecutive missed frames keep returning the last valid cell
   * before the hover drops. Prevents flicker across chunk seams and brief
   * geometry gaps. Default 4; set 0 to disable holding.
   */
  holdFrames?: number;
}

/**
 * Robust per-frame hex picking with a fallback chain:
 *
 * 1. **Mesh pick** — raycast against real terrain geometry (most accurate).
 * 2. **Flat-plane fallback** — plane pick at y=0 so hover survives the window
 *    while newly-panned-to chunks are still building.
 * 3. **Water-surface re-pick** — terrain geometry for liquid cells sits at
 *    seabed depth, so at an angle the ray maps to the wrong surface cell;
 *    re-pick against the per-cell water surface plane.
 * 4. **Last-elevation retry** — elevated tiles at the map edge sit above y=0,
 *    so the flat-plane pick can land out of bounds; retry at the last valid
 *    cell's elevation.
 * 5. **Short hold** — keep the last valid cell for a few frames while the
 *    cursor is over the canvas, so the hover doesn't flicker at chunk seams.
 *
 * Call {@link pick} once per frame with the current pointer position.
 *
 * @example
 * const picker = new HexPicker({
 *   camera, domElement: renderer.domElement, layout,
 *   map: () => api.map,
 *   meshes: () => api.chunks.terrainMeshes,
 *   isWater: t => waterTerrainSet.has(t),
 * });
 * // per frame:
 * const cell = picker.pick(mouseX, mouseY);
 */
export class HexPicker {
  private readonly camera: THREE.Camera;
  private readonly domElement: HTMLElement;
  private readonly layout: HexLayout;
  private readonly getMap: () => HexPickerSource;
  private readonly getMeshes: () => THREE.Mesh[];
  private readonly isWater?: (terrain: number) => boolean;
  private readonly elevScale: number;
  private readonly holdFrames: number;

  private last: { col: number; row: number } | null = null;
  private heldFrames = 0;

  constructor(options: HexPickerOptions) {
    this.camera     = options.camera;
    this.domElement = options.domElement;
    this.layout     = options.layout;
    this.getMap     = typeof options.map    === 'function' ? options.map    : () => options.map as HexPickerSource;
    this.getMeshes  = typeof options.meshes === 'function' ? options.meshes : () => options.meshes as THREE.Mesh[];
    this.isWater    = options.isWater;
    this.elevScale  = options.elevationScale ?? ELEVATION_SCALE;
    this.holdFrames = options.holdFrames ?? 4;
  }

  /** The most recent valid pick, or null. Survives up to `holdFrames` misses. */
  get hoveredCell(): { col: number; row: number } | null { return this.last; }

  /** Clear held state (e.g. after swapping to a new map). */
  reset(): void {
    this.last = null;
    this.heldFrames = 0;
  }

  /**
   * Run the full fallback chain for the given pointer position.
   * Returns the picked cell, or null if nothing is under the cursor.
   */
  pick(clientX: number, clientY: number): { col: number; row: number } | null {
    const map    = this.getMap();
    const meshes = this.getMeshes();

    // A held cell from a previous (larger) map may be out of bounds now.
    if (this.last && (this.last.col >= map.width || this.last.row >= map.height)) {
      this.reset();
    }

    let picked = pickHexFromMeshes(clientX, clientY, this.domElement, this.camera, this.layout, map, meshes)
      ?? pickHex(clientX, clientY, this.domElement, this.camera, this.layout, map, 0);

    if (picked && this.isWater?.(map.getTerrain(picked.col, picked.row))) {
      const surfaceY = map.getWaterSurface(picked.col, picked.row) * this.elevScale;
      picked = pickHex(clientX, clientY, this.domElement, this.camera, this.layout, map, surfaceY) ?? picked;
    }

    if (!picked && this.last) {
      const lastElev = map.getElevation(this.last.col, this.last.row) * this.elevScale;
      if (lastElev > 0.01) {
        picked = pickHex(clientX, clientY, this.domElement, this.camera, this.layout, map, lastElev) ?? null;
      }
    }

    if (picked) {
      this.last       = picked;
      this.heldFrames = 0;
    } else {
      const rect = this.domElement.getBoundingClientRect();
      const overCanvas = clientX >= rect.left && clientX <= rect.right
                      && clientY >= rect.top  && clientY <= rect.bottom;
      if (overCanvas && this.heldFrames < this.holdFrames) {
        picked = this.last;
        this.heldFrames++;
      } else {
        this.last       = null;
        this.heldFrames = 0;
      }
    }

    return picked;
  }
}
