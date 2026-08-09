import * as THREE from 'three';
import type { HexMap } from '../map/HexMap.js';
import type { HexLayout } from '../math/HexLayout.js';
import { hexToWorld } from '../math/HexLayout.js';
import { offsetToHex } from '../math/HexCoord.js';
import { ELEVATION_SCALE } from '../map/HexCell.js';
import type { FogData } from '../geometry/FogData.js';
import { FOG_VERT_DECL, FOG_VERT_BODY, FOG_FRAG_DECL, fogUniforms } from '../geometry/FogGLSL.js';
import type {
  ResourceDescriptor,
  ResourceIconRegistry,
  ResourceValue,
  PlacedResource,
} from './ResourceTypes.js';

const DEFAULT_SIZE     = 0.55;
const DEFAULT_Y_OFFSET = 0.8;

/**
 * Placeholder bound to `uMap` when a resource has no icon texture, so the
 * sampler is never left incomplete (the shader branches around it via
 * `uUseMap`, but drivers still object to an unbound sampler).
 */
let _blankIcon: THREE.DataTexture | null = null;
function blankIcon(): THREE.DataTexture {
  if (!_blankIcon) {
    _blankIcon = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    _blankIcon.needsUpdate = true;
  }
  return _blankIcon;
}

/**
 * Camera-facing icon material for one resource type.
 *
 * The quad is billboarded in view space — the instance matrix contributes only
 * its translation, and the corners are pushed out along the view axes — so
 * icons stay legible from every camera angle without any per-frame CPU work.
 *
 * Fog is read from the same `FogData` texture the terrain samples, through a
 * per-instance `cellIndex` attribute, so an icon follows the memory tiers its
 * ground does: hidden while unexplored, dimmed once explored but out of sight,
 * full strength while visible.
 */
export function createResourceIconMaterial(
  descriptor: ResourceDescriptor,
  icon?: THREE.Texture,
): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite:  false,
    uniforms: {
      uColor:   { value: new THREE.Color(descriptor.color) },
      uSize:    { value: descriptor.size ?? DEFAULT_SIZE },
      uMap:     { value: icon ?? blankIcon() },
      uUseMap:  { value: icon ? 1 : 0 },
      ...fogUniforms(),
    },
    vertexShader: /* glsl */`
      uniform float uSize;
      varying vec2 vUv;
      ${FOG_VERT_DECL}

      void main() {
        vUv = uv;
        ${FOG_VERT_BODY}
        // Billboard: place the instance's origin in view space, then spread the
        // quad's corners along the view axes so it always faces the camera.
        vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        center.xy += position.xy * uSize;
        gl_Position = projectionMatrix * center;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3      uColor;
      uniform sampler2D uMap;
      uniform float     uUseMap;
      varying vec2 vUv;
      ${FOG_FRAG_DECL}

      void main() {
        vec4 icon;
        if (uUseMap > 0.5) {
          icon = texture2D(uMap, vUv);
          icon.rgb *= uColor;
        } else {
          // No texture: a soft disc with a darker rim, which reads as a marker
          // at any zoom without needing an asset pipeline.
          float d    = length(vUv - 0.5) * 2.0;
          float disc = 1.0 - smoothstep(0.86, 1.0, d);
          float rim  = smoothstep(0.62, 0.88, d);
          vec3  body = mix(uColor, uColor * 0.45, rim);
          // Slight top-down lift so the disc reads as a rounded token, not a sticker.
          body += (1.0 - vUv.y) * 0.12 * (1.0 - rim);
          icon = vec4(body, disc);
        }

        if (icon.a < 0.01) discard;
        gl_FragColor = vec4(icon.rgb * vVisibility, icon.a * vExplored);
      }
    `,
  });
  return material;
}

export interface ResourceLayerOptions {
  /** Parent for the icon meshes — usually the scene. */
  parent: THREE.Object3D;
  layout: HexLayout;
  /** The map resources are stored on. Pass an accessor if the map can be swapped at runtime. */
  map: HexMap | (() => HexMap);
  descriptors?: ResourceDescriptor[];
  /** Icon textures keyed by `ResourceDescriptor.iconAssetId`. */
  icons?: ResourceIconRegistry;
  /**
   * Metadata channel key resources are stored under. Default `'resource'`.
   * Change it only to avoid a collision with your own per-cell data.
   */
  dataKey?: string;
  /**
   * Fog of war. Icons then hide on unexplored cells and dim on explored ones,
   * matching the terrain underneath. Attach later with {@link setFogData}.
   */
  fogData?: FogData;
  /**
   * Liquid predicate (e.g. `world.isWater`). Icons on liquid cells then sit on
   * the water surface instead of the seabed floor.
   */
  isWater?: (terrain: number) => boolean;
  /** Must match the terrain geometry's `elevationScale`. Default ELEVATION_SCALE. */
  elevationScale?: number;
  /** three.js render order for the icon meshes. Default 7. */
  renderOrder?: number;
}

/**
 * Per-cell resources — ore, fish, forest yield — stored in the map's metadata
 * channel and drawn as instanced camera-facing icons, one draw call per
 * resource type.
 *
 * Like {@link TerritoryLayer}, the layer holds no cell state of its own: the
 * data lives in `HexMap.cellData`, so it serializes with the map through
 * `serializeMap` / `serializeMapJSON` / `.hexpack` with no companion file. The
 * types themselves are descriptor-driven, so a pack can carry resources this
 * library has never heard of.
 *
 * Rebuilds walk the sparse metadata store rather than the map, so cost scales
 * with the number of deposits, not the size of the world. Mutations mark the
 * layer dirty; call {@link update} once per frame or {@link refresh} straight
 * after a batch.
 *
 * @example
 * const resources = new ResourceLayer({
 *   parent: world.scene, layout: world.layout, map: () => world.map,
 *   descriptors: DEFAULT_RESOURCE_DESCRIPTORS,
 *   isWater: world.isWater, fogData,
 * });
 * generateResources(world.map, DEFAULT_RESOURCE_DESCRIPTORS, seed, { isWater: world.isWater });
 * resources.refresh();
 */
export class ResourceLayer {
  private readonly parent: THREE.Object3D;
  private readonly layout: HexLayout;
  private readonly getMap: () => HexMap;
  private readonly dataKey: string;
  private readonly icons: ResourceIconRegistry;
  private readonly isWater?: (terrain: number) => boolean;
  private readonly elevScale: number;
  private readonly renderOrder: number;

  private _descriptors: ResourceDescriptor[];
  private descriptorsById = new Map<string, ResourceDescriptor>();
  private readonly materials = new Map<string, THREE.ShaderMaterial>();
  private readonly meshes = new Map<string, THREE.InstancedMesh>();
  private fogData: FogData | null;
  private dirty = true;
  private _visible = true;

  constructor(options: ResourceLayerOptions) {
    this.parent      = options.parent;
    this.layout      = options.layout;
    this.getMap      = typeof options.map === 'function' ? options.map : () => options.map as HexMap;
    this.dataKey     = options.dataKey ?? 'resource';
    this.icons       = options.icons ?? new Map();
    this.isWater     = options.isWater;
    this.elevScale   = options.elevationScale ?? ELEVATION_SCALE;
    this.renderOrder = options.renderOrder ?? 7;
    this.fogData     = options.fogData ?? null;
    this._descriptors = options.descriptors ?? [];
    this.rebuildDescriptorIndex();
  }

  /** The resource types currently in use. */
  get descriptors(): ResourceDescriptor[] { return this._descriptors; }

  /** The metadata channel key resources are stored under. */
  get resourceKey(): string { return this.dataKey; }

  /** Whether the icons are currently drawn. */
  get visible(): boolean { return this._visible; }

  private rebuildDescriptorIndex(): void {
    this.descriptorsById = new Map(this._descriptors.map(d => [d.id, d]));
  }

  /**
   * Swap the resource set at runtime (a loaded pack, edited icons). Cell data
   * is untouched — deposits whose type is not in the new set simply stop
   * drawing until a matching descriptor comes back.
   */
  setDescriptors(descriptors: ResourceDescriptor[], icons?: ResourceIconRegistry): void {
    this._descriptors = descriptors;
    this.rebuildDescriptorIndex();
    if (icons) {
      this.icons.clear();
      for (const [id, tex] of icons) this.icons.set(id, tex);
    }
    // Materials bake in color/size/icon, so they cannot survive a descriptor swap.
    this.disposeMeshes();
    for (const mat of this.materials.values()) mat.dispose();
    this.materials.clear();
    this.dirty = true;
  }

  /** Look up a resource descriptor by id. */
  getDescriptor(id: string): ResourceDescriptor | undefined {
    return this.descriptorsById.get(id);
  }

  // --- Cell data ---

  /** Raw stored value for a cell — a type id, a `{ type, amount }` record, or `null`. */
  private rawAt(col: number, row: number): ResourceValue | null {
    const map = this.getMap();
    if (!map.inBounds(col, row)) return null;
    const value = map.getCellData(col, row, this.dataKey);
    if (typeof value === 'string') return value;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)
      && typeof (value as { type?: unknown }).type === 'string') {
      return value as { type: string; amount?: number };
    }
    return null;
  }

  /** The resource type id on a cell, or `null` if it has none. */
  resourceAt(col: number, row: number): string | null {
    const value = this.rawAt(col, row);
    if (value === null) return null;
    return typeof value === 'string' ? value : value.type;
  }

  /**
   * The remaining quantity on a cell, or `null` when the cell has no resource
   * or stores no amount (an undepletable deposit).
   */
  amountAt(col: number, row: number): number | null {
    const value = this.rawAt(col, row);
    if (value === null || typeof value === 'string') return null;
    return value.amount ?? null;
  }

  /**
   * Place a resource on a cell. Pass an `amount` for deposits that deplete;
   * omit it for permanent ones. Out-of-bounds cells are skipped.
   */
  setResource(col: number, row: number, type: string, amount?: number): void {
    const map = this.getMap();
    if (!map.inBounds(col, row)) return;
    map.setCellData(col, row, this.dataKey, amount === undefined ? type : { type, amount });
    this.dirty = true;
  }

  /**
   * Change a cell's remaining quantity, removing the deposit when it runs out.
   * No-op on cells with no resource. Returns the new amount, or `null` if the
   * deposit was removed or the cell had nothing to deplete.
   */
  setAmount(col: number, row: number, amount: number): number | null {
    const type = this.resourceAt(col, row);
    if (type === null) return null;
    if (amount <= 0) {
      this.removeResource(col, row);
      return null;
    }
    this.getMap().setCellData(col, row, this.dataKey, { type, amount });
    this.dirty = true;
    return amount;
  }

  /** Remove the resource from a cell. */
  removeResource(col: number, row: number): void {
    const map = this.getMap();
    if (!map.inBounds(col, row)) return;
    map.setCellData(col, row, this.dataKey, undefined);
    this.dirty = true;
  }

  /** Every placed resource on the map, optionally filtered to one type. */
  allResources(type?: string): PlacedResource[] {
    const map = this.getMap();
    const out: PlacedResource[] = [];
    for (const [ci, record] of map.cellData) {
      if (record[this.dataKey] === undefined) continue;
      const col = ci % map.width;
      const row = (ci / map.width) | 0;
      const value = this.rawAt(col, row);
      if (value === null) continue;
      const placed: PlacedResource = typeof value === 'string'
        ? { col, row, type: value }
        : { col, row, type: value.type, ...(value.amount !== undefined ? { amount: value.amount } : {}) };
      if (type === undefined || placed.type === type) out.push(placed);
    }
    return out;
  }

  /** Deposit counts per resource type id. */
  counts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const r of this.allResources()) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
    return counts;
  }

  /** Remove every resource from the map, optionally limited to one type. */
  clear(type?: string): void {
    const map = this.getMap();
    // Snapshot first — setCellData deletes records, mutating cellData mid-iteration.
    const placed = this.allResources(type);
    for (const { col, row } of placed) map.setCellData(col, row, this.dataKey, undefined);
    this.dirty = true;
  }

  // --- Fog ---

  /**
   * Attach or detach fog of war. Icons then hide on unexplored cells and dim on
   * explored-but-unseen ones, exactly as the terrain and scatter beneath them do.
   */
  setFogData(fog: FogData | null): void {
    this.fogData = fog;
    const map = this.getMap();
    for (const mat of this.materials.values()) {
      const u = mat.uniforms;
      if (fog) {
        u.uFogData.value     = fog.texture;
        u.uFogDataSize.value = new THREE.Vector2(map.width, map.height);
        u.uFogEnabled.value  = 1;
      } else {
        u.uFogEnabled.value = 0;
      }
    }
  }

  /** Match `ChunkManager.setHideUnexplored` so icons and ground agree. */
  setHideUnexplored(enabled: boolean): void {
    for (const mat of this.materials.values()) mat.uniforms.uHideUnexplored.value = enabled ? 1 : 0;
  }

  /** Match `ChunkManager.setDimExplored` so icons and ground agree. */
  setDimExplored(enabled: boolean): void {
    for (const mat of this.materials.values()) mat.uniforms.uDimExplored.value = enabled ? 1 : 0;
  }

  // --- Rendering ---

  /** Show or hide the whole layer without discarding resource data. */
  setVisible(visible: boolean): void {
    this._visible = visible;
    for (const mesh of this.meshes.values()) mesh.visible = visible;
    if (visible) this.update();
  }

  /** Rebuild only if something changed since the last build. Cheap to call every frame. */
  update(): void {
    if (this.dirty && this._visible) this.refresh();
  }

  /** World-space Y of the visible surface at a cell (water-aware). */
  private surfaceY(map: HexMap, col: number, row: number): number {
    return (this.isWater?.(map.getTerrain(col, row))
      ? map.getWaterSurface(col, row)
      : map.getElevation(col, row)) * this.elevScale;
  }

  private materialFor(descriptor: ResourceDescriptor): THREE.ShaderMaterial {
    let material = this.materials.get(descriptor.id);
    if (!material) {
      const icon = descriptor.iconAssetId ? this.icons.get(descriptor.iconAssetId) : undefined;
      material = createResourceIconMaterial(descriptor, icon);
      this.materials.set(descriptor.id, material);
      // A material built after setFogData still needs the current fog state.
      const map = this.getMap();
      if (this.fogData) {
        material.uniforms.uFogData.value     = this.fogData.texture;
        material.uniforms.uFogDataSize.value = new THREE.Vector2(map.width, map.height);
        material.uniforms.uFogEnabled.value  = 1;
      }
    }
    return material;
  }

  /** Rebuild the icon meshes from the map's metadata channel. */
  refresh(): void {
    this.dirty = false;
    this.disposeMeshes();
    if (!this._visible) return;

    const map = this.getMap();

    // Group placements by type so each type becomes one instanced draw call.
    const byType = new Map<string, PlacedResource[]>();
    for (const placed of this.allResources()) {
      if (!this.descriptorsById.has(placed.type)) continue; // no descriptor → nothing to draw
      const list = byType.get(placed.type);
      if (list) list.push(placed); else byType.set(placed.type, [placed]);
    }

    const matrix = new THREE.Matrix4();
    for (const [type, placements] of byType) {
      const descriptor = this.descriptorsById.get(type)!;
      const material   = this.materialFor(descriptor);
      // Unit quad — the vertex shader scales it by uSize and faces it at the camera.
      const geometry   = new THREE.PlaneGeometry(1, 1);
      const mesh       = new THREE.InstancedMesh(geometry, material, placements.length);
      const cellIndices = new Float32Array(placements.length);
      const yOffset    = descriptor.yOffset ?? DEFAULT_Y_OFFSET;

      for (let i = 0; i < placements.length; i++) {
        const { col, row } = placements[i];
        const world = hexToWorld(this.layout, offsetToHex(col, row));
        matrix.makeTranslation(world.x, this.surfaceY(map, col, row) + yOffset, world.z);
        mesh.setMatrixAt(i, matrix);
        cellIndices[i] = row * map.width + col;
      }
      mesh.instanceMatrix.needsUpdate = true;
      // Per-instance fog lookup, the same channel the scatter meshes use.
      geometry.setAttribute('cellIndex', new THREE.InstancedBufferAttribute(cellIndices, 1));
      // Billboarding happens in view space, so three's world-space bounds are wrong.
      mesh.frustumCulled = false;
      mesh.renderOrder   = this.renderOrder;
      mesh.visible       = this._visible;

      this.parent.add(mesh);
      this.meshes.set(type, mesh);
    }
  }

  private disposeMeshes(): void {
    for (const mesh of this.meshes.values()) {
      this.parent.remove(mesh);
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.meshes.clear();
  }

  /**
   * Remove the icon meshes and free their GPU resources. Resource data on the
   * map, and any icon textures you supplied, are left alone.
   */
  dispose(): void {
    this.disposeMeshes();
    for (const mat of this.materials.values()) mat.dispose();
    this.materials.clear();
  }
}
