import * as THREE from 'three';
import type { HexLayout } from '../math/HexLayout.js';
import type { HexMap } from '../map/HexMap.js';
import { buildMapSkirtArrays, skirtBaseY, type MapSkirtOptions } from './MapSkirtCore.js';
import { createSkirtMaterial, configureSkirt, type SkirtMaterialOptions } from './SkirtMaterial.js';

export interface MapSkirtMeshOptions extends MapSkirtOptions, SkirtMaterialOptions {
  /**
   * Use this material instead of building one. It must accept the `aDepth`
   * and `aWater` attributes the geometry carries; easiest is to start from
   * {@link createSkirtMaterial}.
   */
  material?: THREE.ShaderMaterial;
}

/**
 * The wall of earth that closes the map's open edges — the map as a block cut
 * out of the world, landscape intact on top, soil strata down the sides.
 *
 * Without one, a camera low enough to see the horizon also sees *under* the
 * map: the terrain is a surface, not a solid, and its edges are simply where
 * the triangles stop. The skirt gives it a bottom and four sides.
 *
 * The top follows the terrain's own contour, sharing the exact perturbation
 * the chunk builder uses, so it meets the ground with no seam — which is why
 * the geometry options must match the ones the terrain was built with. The
 * base is a single flat Y under the entire map, deep enough that the lowest
 * ground still has {@link MapSkirtOptions.depth} of soil beneath it.
 *
 * It follows the **ground**, including where the ground is a sea bed, so the
 * cut shows a coastline honestly: soil up to the bed, then the water's own
 * cross-section above it.
 *
 * Only the perimeter is built, so this is `O(width + height)` and cheap to
 * rebuild outright — there is no chunked or streamed version and none is
 * needed.
 *
 * @example
 * const skirt = new MapSkirt(map, layout, { depth: 3 }).addTo(scene);
 * // after editing elevations near the edge:
 * skirt.rebuild();
 */
export class MapSkirt {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  private _map: HexMap;
  private readonly layout: HexLayout;
  private options: MapSkirtMeshOptions;
  private _baseY: number;

  constructor(map: HexMap, layout: HexLayout, options: MapSkirtMeshOptions = {}) {
    this._map    = map;
    this.layout  = layout;
    this.options = { ...options };
    this.material = options.material ?? createSkirtMaterial(options);

    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = 'MapSkirt';
    // The wall stands where nothing else does, and is a closed ring around
    // everything — culling it per-frame costs more than it ever saves.
    this.mesh.frustumCulled = false;
    this._baseY = skirtBaseY(map, options);
    this.rebuild();
  }

  /** Add to a scene (or any Object3D). Returns this for chaining. */
  addTo(parent: THREE.Object3D): this {
    parent.add(this.mesh);
    return this;
  }

  /** The flat Y the base sits at — below every piece of ground on the map. */
  get baseY(): number { return this._baseY; }

  /** The map currently walled. Swap with {@link MapSkirt.setMap}. */
  get map(): HexMap { return this._map; }

  /** Show or hide the wall. */
  setEnabled(enabled: boolean): void {
    this.mesh.visible = enabled;
  }

  /** Point at a different map and rebuild (the base Y is re-derived from it). */
  setMap(map: HexMap): void {
    this._map = map;
    this.rebuild();
  }

  /**
   * Restyle, and rebuild if anything geometric changed. Options accumulate
   * across calls, like the sky's.
   */
  configure(options: MapSkirtMeshOptions): void {
    const geometryChanged =
      options.depth               !== undefined ||
      options.baseY               !== undefined ||
      options.waterCut            !== undefined ||
      options.elevationScale      !== undefined ||
      options.perturbStrength     !== undefined ||
      options.elevPerturbStrength !== undefined ||
      options.noiseScale          !== undefined;

    this.options = { ...this.options, ...options };
    configureSkirt(this.material, options);
    if (geometryChanged) this.rebuild();
  }

  /**
   * Rebuild from the current map. Call after editing elevations, water, or
   * the map's size — the perimeter is small, so this is cheap enough to do on
   * every brush stroke rather than tracking which edge cells moved.
   */
  rebuild(): void {
    const arrays = buildMapSkirtArrays(this._map, this.layout, this.options);
    this._baseY = arrays.baseY;

    const geo = this.mesh.geometry;
    geo.setAttribute('position', new THREE.BufferAttribute(arrays.positions, 3));
    geo.setAttribute('normal',   new THREE.BufferAttribute(arrays.normals, 3));
    geo.setAttribute('aDepth',    new THREE.BufferAttribute(arrays.depths, 1));
    geo.setAttribute('aWater',    new THREE.BufferAttribute(arrays.water, 1));
    geo.computeBoundingSphere();
  }

  /** Detach and free the geometry (and the material, unless one was supplied). */
  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    if (!this.options.material) this.material.dispose();
  }
}
