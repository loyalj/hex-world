import * as THREE from 'three';
import type { HexMap } from '../map/HexMap.js';
import type { HexLayout } from '../math/HexLayout.js';
import { worldToHex } from '../math/HexLayout.js';
import { buildChunkGeometry, type ChunkBounds, type ChunkGeometryOptions } from './HexChunk.js';
import { buildWaterGeometry, type WaterGeometryOptions } from './WaterChunk.js';

export interface ChunkManagerOptions {
  map: HexMap;
  layout: HexLayout;
  scene: THREE.Scene;
  material: THREE.Material;
  /** Cells per chunk side. Default 32. */
  chunkSize?: number;
  /** How many chunks in each direction around the camera to keep loaded. Default 4. */
  loadRadius?: number;
  /** Passed through to each chunk's terrain geometry builder. */
  geometryOptions?: ChunkGeometryOptions;
  /** If provided, water and river surfaces are rendered with this material. */
  waterMaterial?: THREE.Material;
  /** Passed through to the water geometry builder. */
  waterGeometryOptions?: WaterGeometryOptions;
}

export class ChunkManager {
  private readonly map: HexMap;
  private readonly layout: HexLayout;
  private readonly scene: THREE.Scene;
  private readonly material: THREE.Material;
  private readonly waterMaterial: THREE.Material | null;
  private readonly geoOptions: ChunkGeometryOptions;
  private readonly waterGeoOptions: WaterGeometryOptions;
  readonly chunkSize: number;
  private readonly loadRadius: number;

  private readonly chunks      = new Map<string, THREE.Mesh>();
  private readonly waterChunks = new Map<string, THREE.Mesh>();
  private readonly dirty       = new Set<string>();

  /** Total number of chunks across the map width */
  readonly chunksX: number;
  /** Total number of chunks across the map height */
  readonly chunksY: number;

  constructor(opts: ChunkManagerOptions) {
    this.map             = opts.map;
    this.layout          = opts.layout;
    this.scene           = opts.scene;
    this.material        = opts.material;
    this.waterMaterial   = opts.waterMaterial ?? null;
    this.geoOptions      = opts.geometryOptions      ?? {};
    this.waterGeoOptions = opts.waterGeometryOptions ?? {};
    this.chunkSize  = opts.chunkSize  ?? 32;
    this.loadRadius = opts.loadRadius ?? 4;
    this.chunksX    = Math.ceil(opts.map.width  / this.chunkSize);
    this.chunksY    = Math.ceil(opts.map.height / this.chunkSize);
  }

  private key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  private bounds(cx: number, cy: number): ChunkBounds {
    const cs = this.chunkSize;
    return {
      colStart: cx * cs,
      colEnd:   Math.min((cx + 1) * cs, this.map.width),
      rowStart: cy * cs,
      rowEnd:   Math.min((cy + 1) * cs, this.map.height),
    };
  }

  private loadChunk(cx: number, cy: number): void {
    const k = this.key(cx, cy);
    if (this.chunks.has(k)) return;

    const b    = this.bounds(cx, cy);
    const geo  = buildChunkGeometry(this.map, this.layout, b, this.geoOptions);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = true;
    this.scene.add(mesh);
    this.chunks.set(k, mesh);

    if (this.waterMaterial) {
      const wGeo = buildWaterGeometry(this.map, this.layout, b, this.waterGeoOptions);
      if (wGeo) {
        const wMesh = new THREE.Mesh(wGeo, this.waterMaterial);
        wMesh.frustumCulled = true;
        this.scene.add(wMesh);
        this.waterChunks.set(k, wMesh);
      }
    }
  }

  private unloadChunk(k: string): void {
    const mesh = this.chunks.get(k);
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    this.chunks.delete(k);

    const wMesh = this.waterChunks.get(k);
    if (wMesh) {
      this.scene.remove(wMesh);
      wMesh.geometry.dispose();
      this.waterChunks.delete(k);
    }

    this.dirty.delete(k);
  }

  /**
   * Call every frame with the current camera.
   * Loads chunks within loadRadius, unloads those outside.
   */
  update(camera: THREE.Camera): void {
    // Rebuild any dirty chunks first
    for (const k of this.dirty) {
      const mesh = this.chunks.get(k);
      if (!mesh) { this.dirty.delete(k); continue; }
      const [cx, cy] = k.split(',').map(Number);
      const b = this.bounds(cx, cy);
      mesh.geometry.dispose();
      mesh.geometry = buildChunkGeometry(this.map, this.layout, b, this.geoOptions);

      const wMesh = this.waterChunks.get(k);
      if (wMesh) {
        wMesh.geometry.dispose();
        const wGeo = buildWaterGeometry(this.map, this.layout, b, this.waterGeoOptions);
        if (wGeo) {
          wMesh.geometry = wGeo;
        } else {
          this.scene.remove(wMesh);
          this.waterChunks.delete(k);
        }
      }

      this.dirty.delete(k);
    }

    // Determine which chunk the camera is over
    const pos  = new THREE.Vector3();
    camera.getWorldPosition(pos);
    const hex  = worldToHex(this.layout, pos.x, pos.z);
    // Convert cube coord to offset col/row
    const camRow = hex.r;
    const camCol = hex.q + (hex.r - (hex.r & 1)) / 2;
    const camCX  = Math.floor(camCol / this.chunkSize);
    const camCY  = Math.floor(camRow / this.chunkSize);

    const r = this.loadRadius;

    // Load chunks in radius
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = camCX + dx;
        const cy = camCY + dy;
        if (cx < 0 || cy < 0 || cx >= this.chunksX || cy >= this.chunksY) continue;
        this.loadChunk(cx, cy);
      }
    }

    // Unload chunks outside radius + 1 (hysteresis prevents thrashing)
    const unloadRadius = r + 1;
    for (const [k, _mesh] of this.chunks) {
      const [cx, cy] = k.split(',').map(Number);
      if (
        Math.abs(cx - camCX) > unloadRadius ||
        Math.abs(cy - camCY) > unloadRadius
      ) {
        this.unloadChunk(k);
      }
    }
  }

  /**
   * Mark the chunk containing cell (col, row) as needing a geometry rebuild.
   * Call after modifying map cell data.
   */
  markDirty(col: number, row: number): void {
    const cx = Math.floor(col / this.chunkSize);
    const cy = Math.floor(row / this.chunkSize);
    this.dirty.add(this.key(cx, cy));
  }

  /** Force-load all chunks (use for small maps or offline baking). */
  loadAll(): void {
    for (let cy = 0; cy < this.chunksY; cy++) {
      for (let cx = 0; cx < this.chunksX; cx++) {
        this.loadChunk(cx, cy);
      }
    }
  }

  /** Dispose all loaded chunks and clear the scene. */
  dispose(): void {
    for (const k of [...this.chunks.keys()]) {
      this.unloadChunk(k);
    }
  }

  /** Total number of water/river meshes currently in the scene. */
  get loadedWaterChunkCount(): number {
    return this.waterChunks.size;
  }

  get loadedChunkCount(): number {
    return this.chunks.size;
  }
}
