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
import type { ScatterDefinition } from './ScatterTypes.js';
import type { FogData } from './FogData.js';
import type { TerrainDefinition } from './TerrainTypes.js';
import { DEFAULT_TERRAIN_DEFINITIONS, buildWaterTerrainSet } from './TerrainTypes.js';

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
  /** Hash grid for deterministic scatter placement. Required when scatterDefinitions is provided. */
  hashGrid?: HexHashGrid;
  /** One definition per scatter layer. Each definition declares its own layerIndex. */
  scatterDefinitions?: ScatterDefinition[];
  /** If provided, fog-of-war uniforms are set on all shader materials. */
  fogData?: FogData;
  /**
   * Terrain type definitions controlling vertex colors, road colors, and water geometry.
   * Defaults to the built-in six types. Pass a merged or custom array to extend terrain.
   */
  terrainDefinitions?: TerrainDefinition[];
}

/**
 * Manages the Three.js meshes for a `HexMap` using a chunk-based streaming system.
 *
 * The map is divided into NxN cell chunks. `update(camera)` loads chunks within
 * `loadRadius` of the camera each frame and unloads those that have moved out of
 * range. Each chunk is a single merged `BufferGeometry` draw call for terrain,
 * with optional separate meshes for water, shore, estuary, rivers, roads, and
 * scatter features.
 *
 * Call `markDirty(col, row)` after modifying map data to trigger a geometry rebuild
 * for the affected chunk on the next `update()`.
 */
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
  private readonly hashGrid:           HexHashGrid | null;
  private readonly scatterDefinitions: ScatterDefinition[] | null;
  private readonly waterTerrains:      Set<number>;
  private fogData:                     FogData | null;
  private hideUnexplored            = true;
  private dimExplored               = true;
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
    this.hashGrid           = opts.hashGrid           ?? null;
    this.scatterDefinitions = opts.scatterDefinitions ?? null;
    this.fogData            = opts.fogData            ?? null;
    const terrainDefs    = opts.terrainDefinitions ?? DEFAULT_TERRAIN_DEFINITIONS;
    this.waterTerrains   = buildWaterTerrainSet(terrainDefs);
    this.geoOptions      = { ...opts.geometryOptions,      terrainDefinitions: terrainDefs };
    this.waterGeoOptions = { ...opts.waterGeometryOptions, waterTerrains: this.waterTerrains };
    this.chunkSize  = opts.chunkSize  ?? 32;
    this.loadRadius = opts.loadRadius ?? 4;
    this.chunksX    = Math.ceil(opts.map.width  / this.chunkSize);
    this.chunksY    = Math.ceil(opts.map.height / this.chunkSize);
  }

  private applyFogToScatterMeshes(meshes: THREE.InstancedMesh[]): void {
    if (!this.fogData) return;
    const raw   = this.fogData.rawData;
    const color = new THREE.Color();
    const mat   = new THREE.Matrix4();
    const ZERO  = new THREE.Matrix4().set(0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,1);
    for (const mesh of meshes) {
      const ci   = mesh.userData.fogCellIndices   as Int32Array   | undefined;
      const orig = mesh.userData.originalMatrices as Float32Array | undefined;
      if (!ci) continue;
      for (let i = 0; i < ci.length; i++) {
        const r = raw[ci[i] * 4]     / 255;
        const b = raw[ci[i] * 4 + 2] / 255; // B channel = reveal animation progress 0→1
        const hidden = this.hideUnexplored && b < 0.01;
        const revealFactor = this.hideUnexplored ? b : 1.0;
        const brightness = hidden ? 0 : revealFactor * (this.dimExplored ? (0.25 + 0.75 * r) : 1.0);
        color.setScalar(brightness);
        mesh.setColorAt(i, color);
        if (orig) {
          if (hidden) {
            mesh.setMatrixAt(i, ZERO);
          } else {
            mat.fromArray(orig, i * 16);
            mesh.setMatrixAt(i, mat);
          }
        }
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      if (orig) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Update instance colors on all loaded scatter chunks to reflect current fog. */
  private updateScatterFog(): void {
    for (const meshes of this.scatterChunks.values()) {
      this.applyFogToScatterMeshes(meshes);
    }
  }

  /** Push fog-of-war uniforms onto a ShaderMaterial that supports them. */
  private applyFog(mat: THREE.Material | null): void {
    if (!mat || !this.fogData || !(mat instanceof THREE.ShaderMaterial)) return;
    const u = mat.uniforms;
    if (!u || !('uFogEnabled' in u)) return;
    u.uFogData.value     = this.fogData.texture;
    u.uFogDataSize.value = new THREE.Vector2(this.map.width, this.map.height);
    u.uFogEnabled.value  = 1;
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
    this.applyFog(this.material);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = true;
    this.scene.add(mesh);
    this.chunks.set(k, mesh);

    if (this.waterMaterial) {
      this.applyFog(this.waterMaterial);
      const wGeo = buildWaterGeometry(this.map, this.layout, b, this.waterGeoOptions);
      if (wGeo) {
        const wMesh = new THREE.Mesh(wGeo, this.waterMaterial);
        wMesh.frustumCulled = true;
        this.scene.add(wMesh);
        this.waterChunks.set(k, wMesh);
      }
    }

    if (this.shoreMaterial) {
      this.applyFog(this.shoreMaterial);
      const sGeo = buildShoreGeometry(this.map, this.layout, b, this.waterGeoOptions);
      if (sGeo) {
        const sMesh = new THREE.Mesh(sGeo, this.shoreMaterial);
        sMesh.frustumCulled = true;
        this.scene.add(sMesh);
        this.shoreChunks.set(k, sMesh);
      }
    }

    if (this.estuaryMaterial) {
      this.applyFog(this.estuaryMaterial);
      const eGeo = buildEstuaryGeometry(this.map, this.layout, b, this.waterGeoOptions);
      if (eGeo) {
        const eMesh = new THREE.Mesh(eGeo, this.estuaryMaterial);
        eMesh.frustumCulled = true;
        this.scene.add(eMesh);
        this.estuaryChunks.set(k, eMesh);
      }
    }

    if (this.riverMaterial) {
      this.applyFog(this.riverMaterial);
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
      this.applyFog(this.roadMaterial);
      const rdMesh = new THREE.Mesh(roadsGeo, this.roadMaterial);
      rdMesh.frustumCulled = true;
      rdMesh.renderOrder = 2; // draw on top of terrain and water
      this.scene.add(rdMesh);
      this.roadChunks.set(k, rdMesh);
    }

    if (this.hashGrid && this.scatterDefinitions && this.scatterDefinitions.length > 0) {
      const scMeshes = buildScatterMeshes(this.map, this.layout, b, this.hashGrid, this.scatterDefinitions, this.waterTerrains);
      if (scMeshes.length > 0) {
        for (const m of scMeshes) this.scene.add(m);
        this.scatterChunks.set(k, scMeshes);
        if (this.fogData) this.applyFogToScatterMeshes(scMeshes);
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
  update(camera: THREE.Camera, dt = 0): void {
    if (this.fogData) {
      const scatterNeedsRefresh = this.fogData.needsUpdate || this.fogData.isAnimating;
      this.fogData.update(dt);
      if (scatterNeedsRefresh) this.updateScatterFog();
    }

    // Recompute water surfaces before any chunk rebuilds so geometry is correct.
    if (this.dirty.size > 0) {
      this.map.computeWaterSurfaces(t => this.waterTerrains.has(t));
    }

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
      } else if (this.riverMaterial) {
        const rGeo = buildRiverGeometry(this.map, this.layout, b, this.waterGeoOptions);
        if (rGeo) {
          this.applyFog(this.riverMaterial);
          const newRMesh = new THREE.Mesh(rGeo, this.riverMaterial);
          newRMesh.frustumCulled = true;
          newRMesh.renderOrder = 1;
          this.scene.add(newRMesh);
          this.riverChunks.set(k, newRMesh);
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
      if (this.hashGrid && this.scatterDefinitions && this.scatterDefinitions.length > 0) {
        const newScMeshes = buildScatterMeshes(this.map, this.layout, b, this.hashGrid, this.scatterDefinitions);
        if (newScMeshes.length > 0) {
          for (const m of newScMeshes) this.scene.add(m);
          this.scatterChunks.set(k, newScMeshes);
          if (this.fogData) this.applyFogToScatterMeshes(newScMeshes);
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

  /**
   * Attach or detach fog-of-war at runtime.
   * Pass `null` to disable (vVisibility → 1.0 everywhere).
   */
  setFogData(fog: FogData | null): void {
    this.fogData = fog;
    const mats = [
      this.material,
      this.waterMaterial,
      this.shoreMaterial,
      this.estuaryMaterial,
      this.riverMaterial,
      this.roadMaterial,
    ];
    for (const mat of mats) {
      if (!mat || !(mat instanceof THREE.ShaderMaterial)) continue;
      const u = mat.uniforms;
      if (!u || !('uFogEnabled' in u)) continue;
      if (fog) {
        u.uFogData.value     = fog.texture;
        u.uFogDataSize.value = new THREE.Vector2(this.map.width, this.map.height);
        u.uFogEnabled.value  = 1;
      } else {
        u.uFogEnabled.value = 0;
      }
    }

    if (fog) {
      this.updateScatterFog();
    } else {
      // Fog disabled: restore all instances to white + original matrices.
      const white = new THREE.Color(1, 1, 1);
      const mat   = new THREE.Matrix4();
      for (const meshes of this.scatterChunks.values()) {
        for (const mesh of meshes) {
          const ci   = mesh.userData.fogCellIndices   as Int32Array   | undefined;
          const orig = mesh.userData.originalMatrices as Float32Array | undefined;
          if (!ci) continue;
          for (let i = 0; i < ci.length; i++) {
            mesh.setColorAt(i, white);
            if (orig) { mat.fromArray(orig, i * 16); mesh.setMatrixAt(i, mat); }
          }
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
          if (orig) mesh.instanceMatrix.needsUpdate = true;
        }
      }
    }
  }

  /** Toggle whether unexplored cells are hidden. Independent of dimming. */
  setHideUnexplored(enabled: boolean): void {
    this.hideUnexplored = enabled;
    this._pushFogUniform('uHideUnexplored', enabled ? 1 : 0);
    if (this.fogData) this.updateScatterFog();
  }

  /** Toggle whether explored-but-not-visible cells are dimmed. Independent of hide. */
  setDimExplored(enabled: boolean): void {
    this.dimExplored = enabled;
    this._pushFogUniform('uDimExplored', enabled ? 1 : 0);
    if (this.fogData) this.updateScatterFog();
  }

  private _pushFogUniform(name: string, value: number): void {
    const mats = [
      this.material,
      this.waterMaterial,
      this.shoreMaterial,
      this.estuaryMaterial,
      this.riverMaterial,
      this.roadMaterial,
    ];
    for (const mat of mats) {
      if (!mat || !(mat instanceof THREE.ShaderMaterial)) continue;
      const u = mat.uniforms;
      if (u && name in u) u[name].value = value;
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

  /** Number of shore foam meshes currently in the scene. */
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
