import * as THREE from 'three';
import type { HexMap } from '../map/HexMap.js';
import type { HexLayout } from '../math/HexLayout.js';
import { worldToHex } from '../math/HexLayout.js';
import { buildChunkGeometry, type ChunkBounds, type ChunkGeometryOptions, type TerrainColorMode } from './HexChunk.js';
export type { TerrainColorMode };
import { buildWaterGeometry, buildRiverGeometry, computeRiverOwnership, type WaterGeometryOptions } from './WaterChunk.js';
import { buildShoreGeometry } from './WaterShoreChunk.js';
import { buildEstuaryGeometry } from './EstuaryChunk.js';
import { buildScatterMeshes } from './ScatterBuilder.js';
import type { HexHashGrid } from './HexHashGrid.js';
import type { ScatterDefinition } from './ScatterTypes.js';
import type { FogData } from './FogData.js';
import type { TerrainDefinition } from './TerrainTypes.js';
import { DEFAULT_TERRAIN_DEFINITIONS, buildWaterTerrainSet, buildLiquidTerrainSets } from './TerrainTypes.js';
import type { LiquidTypeDescriptor, LiquidMaterialSet } from './LiquidTypes.js';
import { DEFAULT_LIQUID_DESCRIPTORS } from './LiquidTypes.js';

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
  /** If provided, roads are rendered with this material. */
  roadMaterial?: THREE.Material;
  /**
   * Per-liquid-type material sets, keyed by LiquidTypeDescriptor.id.
   * Each entry controls which mesh layers are rendered for that liquid type.
   * Omit entries for liquid types that should not be rendered.
   */
  liquidMaterials?: Map<string, LiquidMaterialSet>;
  /**
   * Liquid type descriptors that define per-type geometry overrides.
   * Defaults to DEFAULT_LIQUID_DESCRIPTORS (water, lava, acid).
   * Must include an entry for every key present in liquidMaterials.
   */
  liquidDescriptors?: LiquidTypeDescriptor[];
  /** Passed through to the water geometry builder as baseline options. */
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
 * with optional separate meshes per liquid type for surface, shore, estuary, rivers,
 * plus roads and scatter features.
 *
 * Call `markDirty(col, row)` after modifying map data to trigger a geometry rebuild
 * for the affected chunk on the next `update()`.
 */
export class ChunkManager {
  private readonly map: HexMap;
  private readonly layout: HexLayout;
  private readonly scene: THREE.Scene;
  private material: THREE.Material;
  private readonly roadMaterial:    THREE.Material | null;
  private readonly hashGrid:           HexHashGrid | null;
  private readonly scatterDefinitions: ScatterDefinition[] | null;
  private readonly liquidMaterials:    Map<string, LiquidMaterialSet>;
  private readonly liquidDescriptors:  Map<string, LiquidTypeDescriptor>;
  private readonly liquidTerrainSets:  Map<string, Set<number>>;
  private readonly allWaterTerrains:   Set<number>;
  private readonly liquidPriorityByTerrain: Map<number, number>;
  private readonly liquidIdByTerrain:       Map<number, string>;
  private readonly defaultRiverLiquidId:    string | null;
  /** Map-wide river ownership cache — per-liquid sets of owned river cells. Null = stale. */
  private riverCellsByLiquid: Map<string, Set<number>> | null = null;
  private fogData:                     FogData | null;
  private hideUnexplored            = true;
  private dimExplored               = true;
  private readonly geoOptions:      ChunkGeometryOptions;
  private readonly waterGeoOptions: WaterGeometryOptions;
  readonly chunkSize: number;
  private readonly loadRadius: number;

  private readonly chunks = new Map<string, THREE.Mesh>();
  // Liquid chunk maps use compound key: `${liquidId}|${chunkKey}`
  private readonly liquidSurfaceChunks = new Map<string, THREE.Mesh>();
  private readonly liquidShoreChunks   = new Map<string, THREE.Mesh>();
  private readonly liquidEstuaryChunks = new Map<string, THREE.Mesh>();
  private readonly liquidRiverChunks   = new Map<string, THREE.Mesh>();
  private readonly roadChunks    = new Map<string, THREE.Mesh>();
  private readonly scatterChunks = new Map<string, THREE.InstancedMesh[]>();
  private readonly dirty         = new Set<string>();
  private elapsedSeconds         = 0;

  /** Total number of chunks across the map width */
  readonly chunksX: number;
  /** Total number of chunks across the map height */
  readonly chunksY: number;

  constructor(opts: ChunkManagerOptions) {
    this.map          = opts.map;
    this.layout       = opts.layout;
    this.scene        = opts.scene;
    this.material     = opts.material;
    this.roadMaterial = opts.roadMaterial ?? null;
    this.hashGrid           = opts.hashGrid           ?? null;
    this.scatterDefinitions = opts.scatterDefinitions ?? null;
    this.fogData            = opts.fogData            ?? null;

    const terrainDefs       = opts.terrainDefinitions ?? DEFAULT_TERRAIN_DEFINITIONS;
    this.liquidTerrainSets  = buildLiquidTerrainSets(terrainDefs);
    this.allWaterTerrains   = buildWaterTerrainSet(terrainDefs);

    this.liquidMaterials   = opts.liquidMaterials ?? new Map();
    const descriptorList   = opts.liquidDescriptors ?? DEFAULT_LIQUID_DESCRIPTORS;
    this.liquidDescriptors = new Map(descriptorList.map(d => [d.id, d]));

    // Liquid-level priorities: every terrain index of a liquid shares the liquid's
    // lowest index, so multi-index liquids resolve boundaries consistently.
    this.liquidPriorityByTerrain = new Map();
    for (const set of this.liquidTerrainSets.values()) {
      const p = Math.min(...set);
      for (const idx of set) this.liquidPriorityByTerrain.set(idx, p);
    }

    this.liquidIdByTerrain = new Map();
    for (const [id, set] of this.liquidTerrainSets) {
      for (const idx of set) this.liquidIdByTerrain.set(idx, id);
    }

    // Unclassified rivers (drainage target unknown) are rendered by exactly one
    // liquid: the highest-priority one that has a river material.
    let defaultRiver: string | null = null;
    let bestPriority = Infinity;
    for (const [id, mats] of this.liquidMaterials) {
      if (!mats.river) continue;
      const set = this.liquidTerrainSets.get(id);
      if (!set || set.size === 0) continue;
      const p = Math.min(...set);
      if (p < bestPriority) { bestPriority = p; defaultRiver = id; }
    }
    this.defaultRiverLiquidId = defaultRiver;

    this.geoOptions      = { ...opts.geometryOptions, terrainDefinitions: terrainDefs };
    this.waterGeoOptions = { ...opts.waterGeometryOptions };

    this.chunkSize  = opts.chunkSize  ?? 32;
    this.loadRadius = opts.loadRadius ?? 4;
    this.chunksX    = Math.ceil(opts.map.width  / this.chunkSize);
    this.chunksY    = Math.ceil(opts.map.height / this.chunkSize);
  }

  /** Merge global water geometry options with per-liquid overrides and inject the terrain set. */
  private liquidOpts(liquidId: string): WaterGeometryOptions {
    const desc = this.liquidDescriptors.get(liquidId);
    return {
      ...this.waterGeoOptions,
      ...(desc?.noiseScale      !== undefined ? { noiseScale:      desc.noiseScale }      : {}),
      ...(desc?.perturbStrength !== undefined ? { perturbStrength: desc.perturbStrength } : {}),
      ...(desc?.surfaceLift     !== undefined ? { surfaceLift:     desc.surfaceLift }     : {}),
      // Terrain noise parameters so land-side liquid vertices track the terrain mesh.
      ...(this.geoOptions.noiseScale          !== undefined ? { terrainNoiseScale:          this.geoOptions.noiseScale }          : {}),
      ...(this.geoOptions.perturbStrength     !== undefined ? { terrainPerturbStrength:     this.geoOptions.perturbStrength }     : {}),
      ...(this.geoOptions.elevPerturbStrength !== undefined ? { terrainElevPerturbStrength: this.geoOptions.elevPerturbStrength } : {}),
      ...(this.geoOptions.cliffThreshold      !== undefined ? { cliffThreshold:             this.geoOptions.cliffThreshold }      : {}),
      waterTerrains:    this.liquidTerrainSets.get(liquidId) ?? new Set(),
      allLiquidTerrains: this.allWaterTerrains,
      liquidPriorityByTerrain: this.liquidPriorityByTerrain,
      ownsUnclassifiedRivers:  liquidId === this.defaultRiverLiquidId,
      riverCells: this.riverCellsFor(liquidId),
    };
  }

  /**
   * Lazily computes the map-wide river ownership cache: which liquid renders
   * each river cell's channel. Unclassified chains go to the default liquid.
   * Invalidated by markDirty; rebuilt once per edit batch instead of re-traced
   * per chunk × per liquid.
   */
  private riverCellsFor(liquidId: string): Set<number> | undefined {
    if (!this.riverCellsByLiquid) {
      const ownership = computeRiverOwnership(
        this.map, this.layout.orientation.edgeDirections, this.liquidIdByTerrain,
      );
      const sets = new Map<string, Set<number>>();
      for (const id of this.liquidMaterials.keys()) sets.set(id, new Set());
      for (const [cell, owner] of ownership) {
        if (owner !== null) sets.get(owner)?.add(cell);
        else if (this.defaultRiverLiquidId) sets.get(this.defaultRiverLiquidId)?.add(cell);
      }
      this.riverCellsByLiquid = sets;
    }
    return this.riverCellsByLiquid.get(liquidId);
  }

  /** Collect all materials currently in use (for fog uniform propagation). */
  private allMaterials(): THREE.Material[] {
    const mats: THREE.Material[] = [this.material];
    if (this.roadMaterial) mats.push(this.roadMaterial);
    for (const ms of this.liquidMaterials.values()) {
      if (ms.surface) mats.push(ms.surface);
      if (ms.shore)   mats.push(ms.shore);
      if (ms.estuary) mats.push(ms.estuary);
      if (ms.river)   mats.push(ms.river);
    }
    return mats;
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
        const b = raw[ci[i] * 4 + 2] / 255;
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

  private updateScatterFog(): void {
    for (const meshes of this.scatterChunks.values()) {
      this.applyFogToScatterMeshes(meshes);
    }
  }

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

    for (const [liquidId, mats] of this.liquidMaterials) {
      const lk   = `${liquidId}|${k}`;
      const opts = this.liquidOpts(liquidId);

      if (mats.surface) {
        this.applyFog(mats.surface);
        const wGeo = buildWaterGeometry(this.map, this.layout, b, opts);
        if (wGeo) {
          const m = new THREE.Mesh(wGeo, mats.surface);
          m.frustumCulled = true;
          this.scene.add(m);
          this.liquidSurfaceChunks.set(lk, m);
        }
      }

      if (mats.shore) {
        this.applyFog(mats.shore);
        const sGeo = buildShoreGeometry(this.map, this.layout, b, opts);
        if (sGeo) {
          const m = new THREE.Mesh(sGeo, mats.shore);
          m.frustumCulled = true;
          this.scene.add(m);
          this.liquidShoreChunks.set(lk, m);
        }
      }

      if (mats.estuary) {
        this.applyFog(mats.estuary);
        const eGeo = buildEstuaryGeometry(this.map, this.layout, b, opts);
        if (eGeo) {
          const m = new THREE.Mesh(eGeo, mats.estuary);
          m.frustumCulled = true;
          this.scene.add(m);
          this.liquidEstuaryChunks.set(lk, m);
        }
      }

      if (mats.river) {
        this.applyFog(mats.river);
        const rGeo = buildRiverGeometry(this.map, this.layout, b, opts);
        if (rGeo) {
          const m = new THREE.Mesh(rGeo, mats.river);
          m.frustumCulled = true;
          m.renderOrder = 1;
          this.scene.add(m);
          this.liquidRiverChunks.set(lk, m);
        }
      }
    }

    if (this.roadMaterial && roadsGeo) {
      this.applyFog(this.roadMaterial);
      const rdMesh = new THREE.Mesh(roadsGeo, this.roadMaterial);
      rdMesh.frustumCulled = true;
      rdMesh.renderOrder = 2;
      this.scene.add(rdMesh);
      this.roadChunks.set(k, rdMesh);
    }

    if (this.hashGrid && this.scatterDefinitions && this.scatterDefinitions.length > 0) {
      const scMeshes = buildScatterMeshes(this.map, this.layout, b, this.hashGrid, this.scatterDefinitions, this.allWaterTerrains);
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

    for (const liquidId of this.liquidMaterials.keys()) {
      const lk = `${liquidId}|${k}`;

      const wm = this.liquidSurfaceChunks.get(lk);
      if (wm) { this.scene.remove(wm); wm.geometry.dispose(); this.liquidSurfaceChunks.delete(lk); }

      const sm = this.liquidShoreChunks.get(lk);
      if (sm) { this.scene.remove(sm); sm.geometry.dispose(); this.liquidShoreChunks.delete(lk); }

      const em = this.liquidEstuaryChunks.get(lk);
      if (em) { this.scene.remove(em); em.geometry.dispose(); this.liquidEstuaryChunks.delete(lk); }

      const rm = this.liquidRiverChunks.get(lk);
      if (rm) { this.scene.remove(rm); rm.geometry.dispose(); this.liquidRiverChunks.delete(lk); }
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
    // Wrapped so the float32 uTime uniform never loses enough precision to
    // degrade shader animation in long sessions (one sub-frame pop per ~4.5 h).
    this.elapsedSeconds = (this.elapsedSeconds + dt) % 16384;
    for (const ms of this.liquidMaterials.values()) {
      for (const mat of [ms.surface, ms.shore, ms.estuary, ms.river]) {
        // Guarded so custom ShaderMaterials without a uTime uniform don't throw.
        if (mat instanceof THREE.ShaderMaterial && mat.uniforms.uTime) {
          mat.uniforms.uTime.value = this.elapsedSeconds;
        }
      }
    }

    if (this.fogData) {
      const scatterNeedsRefresh = this.fogData.needsUpdate || this.fogData.isAnimating;
      this.fogData.update(dt);
      if (scatterNeedsRefresh) this.updateScatterFog();
    }

    if (this.dirty.size > 0) {
      // Incremental: only water bodies intersecting the dirty chunks (expanded
      // by one cell so bodies merely adjacent to an edit re-seed) are re-flooded.
      const regions = [...this.dirty].map(k => {
        const [cx, cy] = k.split(',').map(Number);
        const b = this.bounds(cx, cy);
        return {
          colStart: b.colStart - 1, colEnd: b.colEnd + 1,
          rowStart: b.rowStart - 1, rowEnd: b.rowEnd + 1,
        };
      });
      this.map.computeWaterSurfaces(t => this.allWaterTerrains.has(t), regions);
    }

    for (const k of this.dirty) {
      const mesh = this.chunks.get(k);
      if (!mesh) { this.dirty.delete(k); continue; }
      const [cx, cy] = k.split(',').map(Number);
      const b = this.bounds(cx, cy);
      mesh.geometry.dispose();
      const { terrain: newGeo, roads: newRoadsGeo } = buildChunkGeometry(this.map, this.layout, b, this.geoOptions);
      mesh.geometry = newGeo;

      for (const [liquidId, mats] of this.liquidMaterials) {
        const lk   = `${liquidId}|${k}`;
        const opts = this.liquidOpts(liquidId);

        const wm = this.liquidSurfaceChunks.get(lk);
        if (wm) {
          wm.geometry.dispose();
          const wGeo = buildWaterGeometry(this.map, this.layout, b, opts);
          if (wGeo) { wm.geometry = wGeo; }
          else { this.scene.remove(wm); this.liquidSurfaceChunks.delete(lk); }
        } else if (mats.surface) {
          const wGeo = buildWaterGeometry(this.map, this.layout, b, opts);
          if (wGeo) {
            this.applyFog(mats.surface);
            const m = new THREE.Mesh(wGeo, mats.surface);
            m.frustumCulled = true;
            this.scene.add(m);
            this.liquidSurfaceChunks.set(lk, m);
          }
        }

        const sm = this.liquidShoreChunks.get(lk);
        if (sm) {
          sm.geometry.dispose();
          const sGeo = buildShoreGeometry(this.map, this.layout, b, opts);
          if (sGeo) { sm.geometry = sGeo; }
          else { this.scene.remove(sm); this.liquidShoreChunks.delete(lk); }
        } else if (mats.shore) {
          const sGeo = buildShoreGeometry(this.map, this.layout, b, opts);
          if (sGeo) {
            this.applyFog(mats.shore);
            const m = new THREE.Mesh(sGeo, mats.shore);
            m.frustumCulled = true;
            this.scene.add(m);
            this.liquidShoreChunks.set(lk, m);
          }
        }

        const em = this.liquidEstuaryChunks.get(lk);
        if (em) {
          em.geometry.dispose();
          const eGeo = buildEstuaryGeometry(this.map, this.layout, b, opts);
          if (eGeo) { em.geometry = eGeo; }
          else { this.scene.remove(em); this.liquidEstuaryChunks.delete(lk); }
        } else if (mats.estuary) {
          const eGeo = buildEstuaryGeometry(this.map, this.layout, b, opts);
          if (eGeo) {
            this.applyFog(mats.estuary);
            const m = new THREE.Mesh(eGeo, mats.estuary);
            m.frustumCulled = true;
            this.scene.add(m);
            this.liquidEstuaryChunks.set(lk, m);
          }
        }

        const rm = this.liquidRiverChunks.get(lk);
        if (rm) {
          rm.geometry.dispose();
          const rGeo = buildRiverGeometry(this.map, this.layout, b, opts);
          if (rGeo) { rm.geometry = rGeo; }
          else { this.scene.remove(rm); this.liquidRiverChunks.delete(lk); }
        } else if (mats.river) {
          const rGeo = buildRiverGeometry(this.map, this.layout, b, opts);
          if (rGeo) {
            this.applyFog(mats.river);
            const m = new THREE.Mesh(rGeo, mats.river);
            m.frustumCulled = true;
            m.renderOrder = 1;
            this.scene.add(m);
            this.liquidRiverChunks.set(lk, m);
          }
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
        const newScMeshes = buildScatterMeshes(this.map, this.layout, b, this.hashGrid, this.scatterDefinitions, this.allWaterTerrains);
        if (newScMeshes.length > 0) {
          for (const m of newScMeshes) this.scene.add(m);
          this.scatterChunks.set(k, newScMeshes);
          if (this.fogData) this.applyFogToScatterMeshes(newScMeshes);
        }
      }

      this.dirty.delete(k);
    }

    const pos  = new THREE.Vector3();
    camera.getWorldPosition(pos);
    const hex  = worldToHex(this.layout, pos.x, pos.z);
    const camRow = hex.r;
    const camCol = hex.q + (hex.r - (hex.r & 1)) / 2;
    const camCX  = Math.floor(camCol / this.chunkSize);
    const camCY  = Math.floor(camRow / this.chunkSize);

    const r = this.loadRadius;

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = camCX + dx;
        const cy = camCY + dy;
        if (cx < 0 || cy < 0 || cx >= this.chunksX || cy >= this.chunksY) continue;
        this.loadChunk(cx, cy);
      }
    }

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
    this.riverCellsByLiquid = null; // river ownership may have changed
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
    for (const mat of this.allMaterials()) {
      if (!(mat instanceof THREE.ShaderMaterial)) continue;
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
    for (const mat of this.allMaterials()) {
      if (!(mat instanceof THREE.ShaderMaterial)) continue;
      const u = mat.uniforms;
      if (u && name in u) u[name].value = value;
    }
  }

  /**
   * Dispose all loaded chunk meshes and their geometries, removing them from
   * the scene.
   *
   * Does NOT dispose resources the caller passed in and still owns: the
   * terrain material and its texture array, road material, liquid materials,
   * scatter geometries/materials, and any FogData texture. Dispose those
   * yourself when tearing down the scene for good.
   */
  dispose(): void {
    for (const k of [...this.chunks.keys()]) {
      this.unloadChunk(k);
    }
    // Dispose-and-reload is the documented way to refresh after regenerating
    // the map in place, so every map-derived cache must reset here too.
    this.riverCellsByLiquid = null;
  }

  /**
   * Switch the terrain color mode at runtime.
   * Updates the material on all loaded terrain meshes and rebuilds geometry.
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

  /** Total number of liquid surface meshes currently in the scene (all types combined). */
  get loadedWaterChunkCount(): number {
    return this.liquidSurfaceChunks.size;
  }

  /** Number of shore foam meshes currently in the scene (all liquid types combined). */
  get loadedShoreChunkCount(): number {
    return this.liquidShoreChunks.size;
  }

  get loadedChunkCount(): number {
    return this.chunks.size;
  }

  /** Currently loaded terrain meshes — pass to pickHexFromMeshes for accurate raycasting. */
  get terrainMeshes(): THREE.Mesh[] {
    return [...this.chunks.values()];
  }
}
