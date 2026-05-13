import * as THREE from 'three';
import type { HexMap } from '../map/HexMap.js';
import type { HexLayout } from '../math/HexLayout.js';
import { worldToHex } from '../math/HexLayout.js';
import { buildChunkGeometry, type ChunkBounds, type ChunkGeometryOptions, type TerrainColorMode } from './HexChunk.js';
export type { TerrainColorMode };
import { buildWaterGeometry, buildRiverGeometry, type WaterGeometryOptions } from './WaterChunk.js';
import { buildShoreGeometry } from './WaterShoreChunk.js';
import { buildEstuaryGeometry } from './EstuaryChunk.js';
import { buildScatterMeshes } from './ScatterBuilder.js';
import type { HexHashGrid } from './HexHashGrid.js';
import type { ScatterLayerConfig } from './ScatterTypes.js';

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
  /** If provided, shore foam strips are rendered with this material. */
  shoreMaterial?: THREE.Material;
  /** If provided, estuary (river-meets-shore) regions are rendered with this material. */
  estuaryMaterial?: THREE.Material;
  /** If provided, river channels on land cells are rendered with this material. */
  riverMaterial?: THREE.Material;
  /** If provided, roads are rendered with this material. */
  roadMaterial?: THREE.Material;
  /** Passed through to the water geometry builder. */
  waterGeometryOptions?: WaterGeometryOptions;
  /** Hash grid for deterministic scatter placement. Required when scatterLayers is provided. */
  hashGrid?: HexHashGrid;
  /** One config per feature layer defined on the map. */
  scatterLayers?: ScatterLayerConfig[];
}

export class ChunkManager {
  private readonly map: HexMap;
  private readonly layout: HexLayout;
  private readonly scene: THREE.Scene;
  private material: THREE.Material;
  private readonly waterMaterial: THREE.Material | null;
  private readonly shoreMaterial:   THREE.Material | null;
  private readonly estuaryMaterial: THREE.Material | null;
  private readonly riverMaterial:   THREE.Material | null;
  private readonly roadMaterial:    THREE.Material | null;
  private readonly hashGrid:        HexHashGrid | null;
  private readonly scatterLayers:   ScatterLayerConfig[] | null;
  private readonly geoOptions: ChunkGeometryOptions;
  private readonly waterGeoOptions: WaterGeometryOptions;
  readonly chunkSize: number;
  private readonly loadRadius: number;

  private readonly chunks        = new Map<string, THREE.Mesh>();
  private readonly waterChunks   = new Map<string, THREE.Mesh>();
  private readonly shoreChunks   = new Map<string, THREE.Mesh>();
  private readonly estuaryChunks = new Map<string, THREE.Mesh>();
  private readonly riverChunks   = new Map<string, THREE.Mesh>();
  private readonly roadChunks    = new Map<string, THREE.Mesh>();
  private readonly scatterChunks = new Map<string, THREE.InstancedMesh[]>();
  private readonly dirty         = new Set<string>();

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
    this.shoreMaterial   = opts.shoreMaterial   ?? null;
    this.estuaryMaterial = opts.estuaryMaterial ?? null;
    this.riverMaterial   = opts.riverMaterial   ?? null;
    this.roadMaterial    = opts.roadMaterial    ?? null;
    this.hashGrid        = opts.hashGrid        ?? null;
    this.scatterLayers   = opts.scatterLayers   ?? null;
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
    const { terrain: geo, roads: roadsGeo } = buildChunkGeometry(this.map, this.layout, b, this.geoOptions);
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

    if (this.shoreMaterial) {
      const sGeo = buildShoreGeometry(this.map, this.layout, b, this.waterGeoOptions);
      if (sGeo) {
        const sMesh = new THREE.Mesh(sGeo, this.shoreMaterial);
        sMesh.frustumCulled = true;
        this.scene.add(sMesh);
        this.shoreChunks.set(k, sMesh);
      }
    }

    if (this.estuaryMaterial) {
      const eGeo = buildEstuaryGeometry(this.map, this.layout, b, this.waterGeoOptions);
      if (eGeo) {
        const eMesh = new THREE.Mesh(eGeo, this.estuaryMaterial);
        eMesh.frustumCulled = true;
        this.scene.add(eMesh);
        this.estuaryChunks.set(k, eMesh);
      }
    }

    if (this.riverMaterial) {
      const rGeo = buildRiverGeometry(this.map, this.layout, b, this.waterGeoOptions);
      if (rGeo) {
        const rMesh = new THREE.Mesh(rGeo, this.riverMaterial);
        rMesh.frustumCulled = true;
        rMesh.renderOrder = 1; // draw after water (equivalent to Unity Queue=Transparent+1)
        this.scene.add(rMesh);
        this.riverChunks.set(k, rMesh);
      }
    }

    if (this.roadMaterial && roadsGeo) {
      const rdMesh = new THREE.Mesh(roadsGeo, this.roadMaterial);
      rdMesh.frustumCulled = true;
      rdMesh.renderOrder = 2; // draw on top of terrain and water
      this.scene.add(rdMesh);
      this.roadChunks.set(k, rdMesh);
    }

    if (this.hashGrid && this.scatterLayers && this.scatterLayers.length > 0) {
      const scMeshes = buildScatterMeshes(this.map, this.layout, b, this.hashGrid, this.scatterLayers);
      if (scMeshes.length > 0) {
        for (const m of scMeshes) this.scene.add(m);
        this.scatterChunks.set(k, scMeshes);
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

    const sMesh = this.shoreChunks.get(k);
    if (sMesh) {
      this.scene.remove(sMesh);
      sMesh.geometry.dispose();
      this.shoreChunks.delete(k);
    }

    const eMesh = this.estuaryChunks.get(k);
    if (eMesh) {
      this.scene.remove(eMesh);
      eMesh.geometry.dispose();
      this.estuaryChunks.delete(k);
    }

    const rMesh = this.riverChunks.get(k);
    if (rMesh) {
      this.scene.remove(rMesh);
      rMesh.geometry.dispose();
      this.riverChunks.delete(k);
    }

    const rdMesh = this.roadChunks.get(k);
    if (rdMesh) {
      this.scene.remove(rdMesh);
      rdMesh.geometry.dispose();
      this.roadChunks.delete(k);
    }

    const scMeshes = this.scatterChunks.get(k);
    if (scMeshes) {
      for (const m of scMeshes) {
        this.scene.remove(m);
        m.dispose();
      }
      this.scatterChunks.delete(k);
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
      const { terrain: newGeo, roads: newRoadsGeo } = buildChunkGeometry(this.map, this.layout, b, this.geoOptions);
      mesh.geometry = newGeo;

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

      const sMesh = this.shoreChunks.get(k);
      if (sMesh) {
        sMesh.geometry.dispose();
        const sGeo = buildShoreGeometry(this.map, this.layout, b, this.waterGeoOptions);
        if (sGeo) {
          sMesh.geometry = sGeo;
        } else {
          this.scene.remove(sMesh);
          this.shoreChunks.delete(k);
        }
      }

      const eMesh = this.estuaryChunks.get(k);
      if (eMesh) {
        eMesh.geometry.dispose();
        const eGeo = buildEstuaryGeometry(this.map, this.layout, b, this.waterGeoOptions);
        if (eGeo) {
          eMesh.geometry = eGeo;
        } else {
          this.scene.remove(eMesh);
          this.estuaryChunks.delete(k);
        }
      }

      const rMesh = this.riverChunks.get(k);
      if (rMesh) {
        rMesh.geometry.dispose();
        const rGeo = buildRiverGeometry(this.map, this.layout, b, this.waterGeoOptions);
        if (rGeo) {
          rMesh.geometry = rGeo;
        } else {
          this.scene.remove(rMesh);
          this.riverChunks.delete(k);
        }
      }

      const rdMesh = this.roadChunks.get(k);
      if (rdMesh) {
        rdMesh.geometry.dispose();
        if (newRoadsGeo) {
          rdMesh.geometry = newRoadsGeo;
        } else {
          this.scene.remove(rdMesh);
          this.roadChunks.delete(k);
        }
      } else if (newRoadsGeo && this.roadMaterial) {
        const newRdMesh = new THREE.Mesh(newRoadsGeo, this.roadMaterial);
        newRdMesh.frustumCulled = true;
        newRdMesh.renderOrder = 2;
        this.scene.add(newRdMesh);
        this.roadChunks.set(k, newRdMesh);
      }

      const oldScMeshes = this.scatterChunks.get(k);
      if (oldScMeshes) {
        for (const m of oldScMeshes) { this.scene.remove(m); m.dispose(); }
        this.scatterChunks.delete(k);
      }
      if (this.hashGrid && this.scatterLayers && this.scatterLayers.length > 0) {
        const newScMeshes = buildScatterMeshes(this.map, this.layout, b, this.hashGrid, this.scatterLayers);
        if (newScMeshes.length > 0) {
          for (const m of newScMeshes) this.scene.add(m);
          this.scatterChunks.set(k, newScMeshes);
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

  /**
   * Switch the terrain color mode at runtime.
   * Updates the material on all loaded terrain meshes and rebuilds geometry.
   * Use 'flat' or 'debug' with MeshPhongMaterial({ vertexColors: true }),
   * or 'splat' with a TerrainMaterial.
   */
  setColorMode(mode: TerrainColorMode, material: THREE.Material): void {
    this.material = material;
    this.geoOptions.colorMode = mode;
    for (const mesh of this.chunks.values()) {
      mesh.material = material;
    }
    for (const k of this.chunks.keys()) {
      this.dirty.add(k);
    }
  }

  /** Total number of water/river meshes currently in the scene. */
  get loadedWaterChunkCount(): number {
    return this.waterChunks.size;
  }

  get loadedShoreChunkCount(): number {
    return this.shoreChunks.size;
  }

  get loadedChunkCount(): number {
    return this.chunks.size;
  }

  /** Currently loaded terrain meshes — pass to pickHexFromMeshes for accurate raycasting. */
  get terrainMeshes(): THREE.Mesh[] {
    return [...this.chunks.values()];
  }
}
