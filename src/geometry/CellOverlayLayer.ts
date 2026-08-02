import * as THREE from 'three';
import type { HexLayout } from '../math/HexLayout.js';
import { hexToWorld, hexCorners } from '../math/HexLayout.js';
import type { HexCoord } from '../math/HexCoord.js';
import { offsetToHex, hexToOffset, hexNeighbor } from '../math/HexCoord.js';
import { smoothPath } from '../pathfinding/PathSmoothing.js';
import { ELEVATION_SCALE } from '../map/HexCell.js';

/** Minimal map surface needed by CellOverlayLayer — HexMap satisfies it. */
export interface OverlayMapSource {
  width: number;
  height: number;
  getTerrain(col: number, row: number): number;
  getElevation(col: number, row: number): number;
  getWaterSurface(col: number, row: number): number;
}

export type OverlayStyle = 'fill' | 'outline';

export interface OverlaySetOptions {
  /** `'fill'` draws translucent hex fans; `'outline'` draws line segments along the set's boundary edges. Default `'fill'`. */
  style?: OverlayStyle;
  /** Default white. */
  color?: THREE.ColorRepresentation;
  /** Default 0.4 for fills, 1 for outlines. */
  opacity?: number;
  /** Lift above the cell surface. Default 0.02 for fills, 0.03 for outlines. */
  yOffset?: number;
  /** three.js render order. Default 5 for fills, 6 for outlines. */
  renderOrder?: number;
}

export interface OverlayPathOptions {
  /** Default `0xffaa22`. */
  color?: THREE.ColorRepresentation;
  /** Lift above the terrain. Default 0.15. */
  yOffset?: number;
  /** Spline samples between path cells (see `smoothPath`). Default 8. */
  samplesPerSegment?: number;
  /** three.js render order. Default 6. */
  renderOrder?: number;
}

export interface CellOverlayLayerOptions {
  /** Parent to attach overlay meshes to (usually the scene). */
  parent: THREE.Object3D;
  layout: HexLayout;
  /** The map cells are measured against. Pass an accessor if the map instance can be swapped at runtime. */
  map: OverlayMapSource | (() => OverlayMapSource);
  /**
   * Liquid predicate (e.g. `t => waterTerrainSet.has(t)`). When provided,
   * overlays on liquid cells sit on the computed water surface instead of the
   * seabed floor, matching what the user sees.
   */
  isWater?: (terrain: number) => boolean;
  /** Must match the terrain geometry's `elevationScale`. Default ELEVATION_SCALE. */
  elevationScale?: number;
}

interface OverlayEntry {
  object: THREE.Mesh | THREE.LineSegments | THREE.Line;
  material: THREE.MeshBasicMaterial | THREE.LineBasicMaterial;
  style: OverlayStyle | 'path';
}

/**
 * Named per-cell overlays rendered on top of the terrain: hover highlights,
 * selected-cell outlines, movement-range tints, territory borders, and
 * smoothed path previews.
 *
 * Each overlay is identified by a string id and replaced wholesale on update —
 * call {@link set} (cells) or {@link setPath} (a path line) each time the
 * highlighted set changes, and pass `null` to hide. Overlays render with depth
 * testing off so they stay visible over perturbed terrain and water.
 *
 * @example
 * const overlays = new CellOverlayLayer({ parent: scene, layout, map, isWater });
 * overlays.set('hover', brushCells);                                  // translucent fill
 * overlays.set('selected', [cell], { style: 'outline', color: 0x44ddff });
 * overlays.set('range', reachable, { color: 0x66aaff, opacity: 0.3 });
 * overlays.setPath('preview', path, { color: 0xffaa22 });
 * overlays.set('hover', null);                                        // hide
 */
export class CellOverlayLayer {
  private readonly parent: THREE.Object3D;
  private readonly layout: HexLayout;
  private readonly getMap: () => OverlayMapSource;
  private readonly isWater?: (terrain: number) => boolean;
  private readonly elevScale: number;
  private readonly entries = new Map<string, OverlayEntry>();

  constructor(options: CellOverlayLayerOptions) {
    this.parent    = options.parent;
    this.layout    = options.layout;
    this.getMap    = typeof options.map === 'function' ? options.map : () => options.map as OverlayMapSource;
    this.isWater   = options.isWater;
    this.elevScale = options.elevationScale ?? ELEVATION_SCALE;
  }

  /** World-space Y of the visible surface at a cell (water-aware), before yOffset. */
  private surfaceY(map: OverlayMapSource, col: number, row: number): number {
    return (this.isWater?.(map.getTerrain(col, row))
      ? map.getWaterSurface(col, row)
      : map.getElevation(col, row)) * this.elevScale;
  }

  private entryFor(id: string, style: OverlayStyle | 'path', opts: { color?: THREE.ColorRepresentation; opacity?: number; renderOrder?: number }): OverlayEntry {
    let entry = this.entries.get(id);
    if (entry && entry.style !== style) {
      this.remove(id);
      entry = undefined;
    }
    if (!entry) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
      let object: OverlayEntry['object'];
      let material: OverlayEntry['material'];
      if (style === 'fill') {
        material = new THREE.MeshBasicMaterial({
          transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
        });
        object = new THREE.Mesh(geometry, material);
      } else {
        material = new THREE.LineBasicMaterial({ transparent: true, depthWrite: false, depthTest: false });
        object = style === 'outline'
          ? new THREE.LineSegments(geometry, material)
          : new THREE.Line(geometry, material);
      }
      object.frustumCulled = false;
      this.parent.add(object);
      entry = { object, material, style };
      this.entries.set(id, entry);
    }
    entry.material.color.set(opts.color ?? (style === 'path' ? 0xffaa22 : 0xffffff));
    entry.material.opacity = opts.opacity ?? (style === 'fill' ? 0.4 : 1);
    entry.object.renderOrder = opts.renderOrder ?? (style === 'fill' ? 5 : 6);
    return entry;
  }

  /**
   * Show (or replace) a named cell overlay. Pass `null` or an empty set to hide it.
   * Cells outside the map bounds are skipped.
   */
  set(id: string, cells: Iterable<{ col: number; row: number }> | null, opts: OverlaySetOptions = {}): void {
    const style = opts.style ?? 'fill';
    const list = cells
      ? [...cells].filter(c => {
          const map = this.getMap();
          return c.col >= 0 && c.col < map.width && c.row >= 0 && c.row < map.height;
        })
      : [];
    if (list.length === 0) {
      const entry = this.entries.get(id);
      if (entry) entry.object.visible = false;
      return;
    }

    const map     = this.getMap();
    const entry   = this.entryFor(id, style, opts);
    const yOffset = opts.yOffset ?? (style === 'fill' ? 0.02 : 0.03);
    const verts: number[] = [];

    if (style === 'fill') {
      for (const { col, row } of list) {
        const hex    = offsetToHex(col, row);
        const y      = this.surfaceY(map, col, row) + yOffset;
        const center = hexToWorld(this.layout, hex);
        const cs     = hexCorners(this.layout, hex);
        for (let i = 0; i < 6; i++) {
          const c1 = cs[i], c2 = cs[(i + 1) % 6];
          verts.push(center.x, y, center.z, c1.x, y, c1.z, c2.x, y, c2.z);
        }
      }
    } else {
      // Outline: draw only edges whose neighbor is not part of the set.
      const inSet = new Set(list.map(c => c.row * map.width + c.col));
      const edgeDirs = this.layout.orientation.edgeDirections;
      for (const { col, row } of list) {
        const hex = offsetToHex(col, row);
        const y   = this.surfaceY(map, col, row) + yOffset;
        const cs  = hexCorners(this.layout, hex);
        for (let i = 0; i < 6; i++) {
          const n = hexToOffset(hexNeighbor(hex, edgeDirs[i]));
          const inside = n.col >= 0 && n.col < map.width && n.row >= 0 && n.row < map.height
            && inSet.has(n.row * map.width + n.col);
          if (inside) continue;
          const c1 = cs[i], c2 = cs[(i + 1) % 6];
          verts.push(c1.x, y, c1.z, c2.x, y, c2.z);
        }
      }
    }

    entry.object.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    entry.object.visible = true;
  }

  /**
   * Show (or replace) a named smoothed path line (see `smoothPath`).
   * Pass `null` or a path shorter than 2 cells to hide it.
   */
  setPath(id: string, path: HexCoord[] | null, opts: OverlayPathOptions = {}): void {
    if (!path || path.length < 2) {
      const entry = this.entries.get(id);
      if (entry) entry.object.visible = false;
      return;
    }
    const map     = this.getMap();
    const entry   = this.entryFor(id, 'path', opts);
    const yOffset = opts.yOffset ?? 0.15;
    const pts     = smoothPath(path, this.layout, map, opts.samplesPerSegment);
    const positions = new Float32Array(pts.length * 3);
    pts.forEach((p, i) => {
      positions[i * 3]     = p.x;
      positions[i * 3 + 1] = p.y + yOffset;
      positions[i * 3 + 2] = p.z;
    });
    entry.object.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    entry.object.visible = true;
  }

  /** Hide an overlay without destroying its resources (cheap to re-show). */
  hide(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.object.visible = false;
  }

  /** Remove an overlay and free its GPU resources. */
  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.parent.remove(entry.object);
    entry.object.geometry.dispose();
    entry.material.dispose();
    this.entries.delete(id);
  }

  /** Remove all overlays and free their GPU resources. */
  dispose(): void {
    for (const id of [...this.entries.keys()]) this.remove(id);
  }
}
