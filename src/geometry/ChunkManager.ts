import * as THREE from 'three';
import type { HexMap } from '../map/HexMap.js';
import type { HexLayout } from '../math/HexLayout.js';
import { worldToHex } from '../math/HexLayout.js';
import { HEX_DIRECTIONS } from '../math/HexCoord.js';
import { buildChunkGeometry, chunkArraysToGeometries, type ChunkBounds, type ChunkGeometryOptions, type TerrainColorMode } from './HexChunk.js';
export type { TerrainColorMode };
import { WorkerChunkBuilder, type ChunkWorkerLike } from './WorkerChunkBuilder.js';
import { buildWaterGeometry, buildRiverGeometry, computeRiverOwnership, computeRiverFlow, computeRiverElevations, type WaterGeometryOptions } from './WaterChunk.js';
import { buildShoreGeometry } from './WaterShoreChunk.js';
import { buildEstuaryGeometry } from './EstuaryChunk.js';
import { findWaterfalls, buildWaterfallFoamGeometry, buildWaterfallSprayGeometry } from './Waterfalls.js';
import { buildScatterMeshes } from './ScatterBuilder.js';
import type { HexHashGrid } from './HexHashGrid.js';
import type { ScatterDefinition } from './ScatterTypes.js';
import type { FogData } from './FogData.js';
import type { TerrainDefinition } from './TerrainTypes.js';
import { DEFAULT_TERRAIN_DEFINITIONS, buildWaterTerrainSet, buildLiquidTerrainSets } from './TerrainTypes.js';
import type { LiquidTypeDescriptor, LiquidMaterialSet } from './LiquidTypes.js';
import { DEFAULT_LIQUID_DESCRIPTORS, liquidMaterialList } from './LiquidTypes.js';
import { Emitter } from '../events/Emitter.js';

/** Payload for {@link ChunkManagerEventMap.chunkLoaded} and `chunkUnloaded`. */
export interface ChunkEvent {
  /** Chunk column index (cell column / `chunkSize`). */
  cx: number;
  /** Chunk row index (cell row / `chunkSize`). */
  cy: number;
  /** The half-open cell range this chunk covers, clamped to the map. */
  bounds: ChunkBounds;
}

/** Events emitted by {@link ChunkManager.events}. */
export interface ChunkManagerEventMap {
  /**
   * A chunk's meshes are in the scene and renderable. Fires from the same place
   * for synchronous and worker builds, so `chunkWorker: true` doesn't change
   * when (relative to the geometry existing) consumers hear about it — only how
   * many frames later. Use it to place props, spawn decorations, or drive a
   * "world loading" indicator.
   */
  chunkLoaded: ChunkEvent;
  /**
   * A chunk's meshes have been removed from the scene and disposed — because it
   * streamed out of range, or because `dispose()` / `setMap()` tore everything
   * down. Anything you parented to that chunk's region should go now.
   */
  chunkUnloaded: ChunkEvent;
}

/**
 * Explicit renderOrder for the transparent mesh layers, bottom → top.
 *
 * three.js sorts transparent objects back-to-front by bounding-sphere depth,
 * which changes with the camera. The full-hex water surface mesh overlaps the
 * shore strip, so without a fixed order it can composite OVER the shore and
 * wash out the foam for whole chunks. The liquid surface stays at the default
 * order 0; everything layered on top of it gets an explicit slot. Demo-level
 * overlays (hover, selection, …) start at 5.
 */
export const RENDER_ORDER_SHORE   = 1;
export const RENDER_ORDER_ESTUARY = 2;
export const RENDER_ORDER_RIVER   = 3;
export const RENDER_ORDER_ROADS   = 4;
/** Plunge-pool foam — above every liquid layer it churns on top of. */
export const RENDER_ORDER_WATERFALL_FOAM = 5;
/**
 * Waterfall spray — mist in the air, so it composites over the ground overlays
 * too, but stays under precipitation (10), which is nearer the camera still.
 */
export const RENDER_ORDER_WATERFALL_SPRAY = 9;

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
   * Widen river channels (water AND carved stream bed, in lockstep) with
   * accumulated flow from `computeRiverFlow` — tributaries joining a river
   * make it visibly wider downstream. Default true; set false for the
   * fixed-width channels of earlier versions.
   */
  flowWidenedRivers?: boolean;
  /**
   * Terrain type definitions controlling vertex colors, road colors, and water geometry.
   * Defaults to the built-in six types. Pass a merged or custom array to extend terrain.
   */
  terrainDefinitions?: TerrainDefinition[];
  /**
   * Factory for a chunk-build worker. When provided, terrain/road geometry for
   * newly streamed-in chunks is built off the main thread (liquids, scatter,
   * and dirty-chunk rebuilds stay synchronous). Pass
   * `createDefaultChunkWorker` for the library's bundled worker, or your own
   * factory (e.g. a pre-created worker pool member). The manager owns workers
   * it creates and terminates them on `dispose()`.
   */
  workerFactory?: () => ChunkWorkerLike;
}

/**
 * Manages the Three.js meshes for a `HexMap` using a chunk-based streaming system.
 *
 * The map is divided into NxN cell chunks. `update(camera)` loads chunks within
 * `loadRadius` of the camera each frame and unloads those that have moved out of
 * range. Each chunk is a single merged `BufferGeometry` draw call for terrain,
 * with optional separate meshes per liquid type for surface, shore, estuary, rivers,
 * and waterfall spray/foam, plus roads and scatter features.
 *
 * Call `markDirty(col, row)` after modifying map data to trigger a geometry rebuild
 * for the affected chunk on the next `update()`.
 */
export class ChunkManager {
  /**
   * Streaming lifecycle events — `chunkLoaded` once a chunk's meshes are in the
   * scene, `chunkUnloaded` once they're out of it and disposed.
   *
   * ```ts
   * chunks.events.on('chunkLoaded', ({ bounds }) => spawnPropsIn(bounds));
   * ```
   */
  readonly events = new Emitter<ChunkManagerEventMap>();

  private map: HexMap;
  private readonly layout: HexLayout;
  private readonly scene: THREE.Scene;
  private material: THREE.Material;
  private readonly roadMaterial:    THREE.Material | null;
  private readonly hashGrid:           HexHashGrid | null;
  private scatterDefinitions: ScatterDefinition[] | null;
  private readonly liquidMaterials:    Map<string, LiquidMaterialSet>;
  private readonly liquidDescriptors:  Map<string, LiquidTypeDescriptor>;
  private liquidTerrainSets:  Map<string, Set<number>>;
  private allWaterTerrains:   Set<number>;
  private liquidPriorityByTerrain: Map<number, number>;
  private liquidIdByTerrain:       Map<number, string>;
  private defaultRiverLiquidId:    string | null;
  /** Map-wide river ownership cache — per-liquid sets of owned river cells. Null = stale. */
  private riverCellsByLiquid: Map<string, Set<number>> | null = null;
  /** Map-wide accumulated river flow cache for flow-dependent channel widths. Null = stale. */
  private riverFlowCache: Map<number, number> | null = null;
  /** The flow map used for the currently-rendered geometry — kept (unlike the
   *  cache, which is nulled on markDirty) so a recompute can diff against it
   *  and dirty every cell whose flow changed. */
  private lastRiverFlow: Map<number, number> | null = null;
  /** Map-wide carved river elevation cache (running min along flow). Null = stale. */
  private riverElevCache: Map<number, number> | null = null;
  /** The carved-elevation map behind the currently-rendered geometry (same diffing role as lastRiverFlow). */
  private lastRiverElev: Map<number, number> | null = null;
  /**
   * `map.riverRevision` the river caches were built against. The caches are
   * dropped only when the map reports a river-relevant write, so a terrain
   * stroke across dry land keeps them — three whole-map walks saved per
   * dirty frame.
   */
  private riverCacheRevision = -1;
  /**
   * Bumped whenever terrain geometry in the scene changes: a chunk loaded,
   * unloaded, or rebuilt. Picking caches key on it — the ground under a
   * stationary cursor moves when the cell under it is raised.
   */
  private _geometryRevision = 0;
  /** True when the caller pinned geometryOptions.riverbedTerrain explicitly. */
  private readonly riverbedPinned: boolean;
  /** True when the caller pinned geometryOptions.bridgeTerrain explicitly. */
  private readonly bridgePinned: boolean;
  private readonly flowWidenedRivers: boolean;
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
  private readonly liquidFoamChunks    = new Map<string, THREE.Mesh>();
  private readonly liquidSprayChunks   = new Map<string, THREE.Points>();
  private readonly roadChunks    = new Map<string, THREE.Mesh>();
  private readonly scatterChunks = new Map<string, THREE.InstancedMesh[]>();
  /** Applied to every scatter mesh, current and future — see {@link setScatterVisible}. */
  private scatterVisible         = true;
  private readonly dirty         = new Set<string>();
  private elapsedSeconds         = 0;

  // --- Async (worker) chunk building ---
  private readonly workerFactory: (() => ChunkWorkerLike) | null;
  private worker: WorkerChunkBuilder | null = null;
  /** Worker snapshot freshness — false forces a re-upload before the next async build. */
  private workerMapSynced = false;
  /** Bumped whenever map data or build options change; stale async results are dropped. */
  private buildGeneration = 0;
  /** In-flight async builds: chunk key → generation at request time. */
  private readonly pendingBuilds = new Map<string, number>();

  /** Total number of chunks across the map width */
  get chunksX(): number { return Math.ceil(this.map.width / this.chunkSize); }
  /** Total number of chunks across the map height */
  get chunksY(): number { return Math.ceil(this.map.height / this.chunkSize); }

  constructor(opts: ChunkManagerOptions) {
    this.map          = opts.map;
    this.layout       = opts.layout;
    this.scene        = opts.scene;
    this.material     = opts.material;
    this.roadMaterial = opts.roadMaterial ?? null;
    this.hashGrid           = opts.hashGrid           ?? null;
    this.scatterDefinitions = opts.scatterDefinitions ?? null;
    this.fogData            = opts.fogData            ?? null;

    this.liquidMaterials   = opts.liquidMaterials ?? new Map();
    const descriptorList   = opts.liquidDescriptors ?? DEFAULT_LIQUID_DESCRIPTORS;
    this.liquidDescriptors = new Map(descriptorList.map(d => [d.id, d]));

    this.geoOptions      = { ...opts.geometryOptions };
    this.waterGeoOptions = { ...opts.waterGeometryOptions };
    this.riverbedPinned  = opts.geometryOptions?.riverbedTerrain !== undefined;
    this.bridgePinned    = opts.geometryOptions?.bridgeTerrain !== undefined;

    // Definite assignment happens in applyTerrainDefinitions; these initializers
    // keep the compiler satisfied without duplicating the derivation.
    this.liquidTerrainSets       = new Map();
    this.allWaterTerrains        = new Set();
    this.liquidPriorityByTerrain = new Map();
    this.liquidIdByTerrain       = new Map();
    this.defaultRiverLiquidId    = null;
    this.applyTerrainDefinitions(opts.terrainDefinitions ?? DEFAULT_TERRAIN_DEFINITIONS);

    this.chunkSize  = opts.chunkSize  ?? 32;
    this.loadRadius = opts.loadRadius ?? 4;
    this.flowWidenedRivers = opts.flowWidenedRivers ?? true;
    this.workerFactory     = opts.workerFactory ?? null;
  }

  /** Lazily (re)create the worker builder — dispose() terminates it, the next request revives it. */
  private ensureWorker(): WorkerChunkBuilder | null {
    if (!this.workerFactory) return null;
    if (!this.worker) {
      this.worker = new WorkerChunkBuilder(this.workerFactory());
      this.workerMapSynced = false;
    }
    return this.worker;
  }

  /** Invalidate all in-flight and future async builds against the current worker snapshot. */
  private invalidateAsyncBuilds(): void {
    this.buildGeneration++;
    this.workerMapSynced = false;
    this.pendingBuilds.clear();
  }

  /**
   * Lazily computes the map-wide accumulated flow used for flow-dependent
   * channel widths. Invalidated by markDirty alongside the ownership cache.
   */
  /** Drop the river caches if the map's river data changed since they were built. */
  private syncRiverCaches(): void {
    const rev = this.map.riverRevision;
    if (rev === this.riverCacheRevision) return;
    this.riverCacheRevision = rev;
    this.riverCellsByLiquid = null;
    this.riverFlowCache     = null;
    this.riverElevCache     = null;
  }

  private riverFlow(): Map<number, number> | undefined {
    if (!this.flowWidenedRivers) return undefined;
    this.syncRiverCaches();
    if (!this.riverFlowCache) {
      this.riverFlowCache = computeRiverFlow(this.map, this.layout.orientation.edgeDirections);
      this.lastRiverFlow  = this.riverFlowCache;
    }
    return this.riverFlowCache;
  }

  /**
   * Lazily computes the map-wide carved river elevations (running minimum
   * along flow) so uphill river stretches hold a level water surface and
   * carve a gorge instead of climbing. Invalidated by markDirty.
   */
  private riverElevations(): Map<number, number> {
    this.syncRiverCaches();
    if (!this.riverElevCache) {
      this.riverElevCache = computeRiverElevations(this.map, this.layout.orientation.edgeDirections);
      this.lastRiverElev  = this.riverElevCache;
    }
    return this.riverElevCache;
  }

  /**
   * Flow and carved elevation are MAP-WIDE properties: one edit can change
   * the accumulated flow — and therefore the rendered channel width — or the
   * carried water level of every cell downstream, far outside the edited
   * chunk. After an edit invalidates the caches, recompute and mark every
   * cell whose value changed, so downstream chunks rebuild instead of keeping
   * stale widths/levels (visible as abrupt channel steps at chunk borders and
   * mismatched confluences).
   */
  private refreshRiverCachesAndMarkChanged(): void {
    const w = this.map.width;
    const diffAndMark = (next: Map<number, number>, prev: Map<number, number> | null) => {
      if (!prev) return;
      for (const [k, v] of next) {
        if (prev.get(k) !== v) this.markDirty(k % w, (k / w) | 0);
      }
      for (const k of prev.keys()) {
        if (!next.has(k)) this.markDirty(k % w, (k / w) | 0);
      }
    };

    const nextFlow = this.flowWidenedRivers
      ? computeRiverFlow(this.map, this.layout.orientation.edgeDirections)
      : null;
    const nextElev = computeRiverElevations(this.map, this.layout.orientation.edgeDirections);
    if (nextFlow) diffAndMark(nextFlow, this.lastRiverFlow);
    diffAndMark(nextElev, this.lastRiverElev);

    if (nextFlow) {
      this.riverFlowCache = nextFlow;
      this.lastRiverFlow  = nextFlow;
    }
    this.riverElevCache = nextElev;
    this.lastRiverElev  = nextElev;
  }

  /** Recompute every terrain-definition-derived lookup. */
  private applyTerrainDefinitions(terrainDefs: TerrainDefinition[]): void {
    this.liquidTerrainSets = buildLiquidTerrainSets(terrainDefs);
    this.allWaterTerrains  = buildWaterTerrainSet(terrainDefs);

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

    this.computeDefaultRiverLiquid();

    this.geoOptions.terrainDefinitions = terrainDefs;
    // Carved stream beds blend toward the pack's 'riverbed' terrain, unless
    // the caller pinned (or disabled) the target via geometryOptions.
    if (!this.riverbedPinned) {
      this.geoOptions.riverbedTerrain = terrainDefs.find(d => d.id === 'riverbed')?.index;
    }
    // Bridge slabs are cut stone: the pack's 'rock' terrain, same rule.
    if (!this.bridgePinned) {
      this.geoOptions.bridgeTerrain = terrainDefs.find(d => d.id === 'rock')?.index;
    }
    this.riverCellsByLiquid = null;
  }

  /**
   * Unclassified rivers (drainage target unknown) are rendered by exactly one
   * liquid: the highest-priority one that has a river material.
   */
  private computeDefaultRiverLiquid(): void {
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
      riverFlow:  this.riverFlow(),
      riverElevations: this.riverElevations(),
    };
  }

  /**
   * Lazily computes the map-wide river ownership cache: which liquid renders
   * each river cell's channel. Unclassified chains go to the default liquid.
   * Invalidated by markDirty; rebuilt once per edit batch instead of re-traced
   * per chunk × per liquid.
   */
  private riverCellsFor(liquidId: string): Set<number> | undefined {
    this.syncRiverCaches();
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
      for (const m of liquidMaterialList(ms)) if (m) mats.push(m);
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
    this.geoOptions.riverFlow       = this.riverFlow();
    this.geoOptions.riverElevations = this.riverElevations();
    const { terrain: geo, roads: roadsGeo } = buildChunkGeometry(this.map, this.layout, b, this.geoOptions);
    this.attachChunkMeshes(k, b, geo, roadsGeo);
  }

  /**
   * Request an off-main-thread build for a chunk that isn't loaded yet. The
   * worker builds terrain/road arrays from its map snapshot; liquids and
   * scatter are still built here when the result lands (they're a fraction of
   * the terrain cost). Stale results — superseded by an edit, an unload, or a
   * dispose — are dropped; the regular update loop re-requests as needed.
   */
  private requestChunkAsync(cx: number, cy: number): void {
    const k = this.key(cx, cy);
    if (this.chunks.has(k) || this.pendingBuilds.has(k)) return;

    const worker = this.ensureWorker();
    if (!worker) { this.loadChunk(cx, cy); return; }

    if (!this.workerMapSynced) {
      this.geoOptions.riverFlow       = this.riverFlow();
      this.geoOptions.riverElevations = this.riverElevations();
      worker.syncMap(this.map, this.layout, this.geoOptions);
      this.workerMapSynced = true;
    }

    const generation = this.buildGeneration;
    const b = this.bounds(cx, cy);
    this.pendingBuilds.set(k, generation);
    void worker.build(b).then(arrays => {
      if (this.pendingBuilds.get(k) === generation) this.pendingBuilds.delete(k);
      if (!arrays || this.buildGeneration !== generation || this.chunks.has(k)) return;
      const { terrain, roads } = chunkArraysToGeometries(arrays);
      this.attachChunkMeshes(k, b, terrain, roads);
    });
  }

  /** Wrap finished terrain/road geometry in meshes and build the chunk's liquids and scatter. */
  private attachChunkMeshes(
    k: string,
    b: ChunkBounds,
    geo: THREE.BufferGeometry,
    roadsGeo: THREE.BufferGeometry | null,
  ): void {
    this.applyFog(this.material);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = true;
    // Free when the renderer has shadows off; lets mountains shadow valleys
    // (and receive from scatter/units) as soon as a shadow-casting sun exists.
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.chunks.set(k, mesh);
    this._geometryRevision++;

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
          m.renderOrder = RENDER_ORDER_SHORE;
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
          m.renderOrder = RENDER_ORDER_ESTUARY;
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
          m.renderOrder = RENDER_ORDER_RIVER;
          this.scene.add(m);
          this.liquidRiverChunks.set(lk, m);
        }
      }

      this.rebuildWaterfalls(liquidId, mats, lk, b, opts);
    }

    if (this.roadMaterial && roadsGeo) {
      this.applyFog(this.roadMaterial);
      const rdMesh = new THREE.Mesh(roadsGeo, this.roadMaterial);
      rdMesh.frustumCulled = true;
      // Roads don't cast (they lie flush on the ground) but they receive, so a
      // tree's shadow crosses the road instead of stopping at its edge.
      rdMesh.receiveShadow = true;
      rdMesh.renderOrder = RENDER_ORDER_ROADS;
      this.scene.add(rdMesh);
      this.roadChunks.set(k, rdMesh);
    }

    if (this.hashGrid && this.scatterDefinitions && this.scatterDefinitions.length > 0) {
      const scMeshes = buildScatterMeshes(this.map, this.layout, b, this.hashGrid, this.scatterDefinitions, this.allWaterTerrains);
      if (scMeshes.length > 0) {
        for (const m of scMeshes) { m.visible = this.scatterVisible; this.scene.add(m); }
        this.scatterChunks.set(k, scMeshes);
        if (this.fogData) this.applyFogToScatterMeshes(scMeshes);
      }
    }

    // Last, so a listener that walks the chunk's meshes sees the complete set —
    // terrain, every liquid layer, roads, and scatter.
    this.emitChunkEvent('chunkLoaded', k, b);
  }

  /**
   * (Re)build one chunk's waterfall layers for one liquid: the mist particles
   * thrown up where each fall lands, and the churning plunge pool under it.
   *
   * Both come from the same site list as the channel geometry (identical
   * ownership filter, flow widths, and carved elevations), so they track the
   * water exactly and vanish with it. Cliff-edge rivers are rare, so a chunk
   * without one allocates nothing and the layers are rebuilt whole rather than
   * patched in place.
   */
  private rebuildWaterfalls(
    liquidId: string,
    mats: LiquidMaterialSet,
    lk: string,
    b: ChunkBounds,
    opts: WaterGeometryOptions,
  ): void {
    const oldFoam = this.liquidFoamChunks.get(lk);
    if (oldFoam) {
      this.scene.remove(oldFoam);
      oldFoam.geometry.dispose();
      this.liquidFoamChunks.delete(lk);
    }
    const oldSpray = this.liquidSprayChunks.get(lk);
    if (oldSpray) {
      this.scene.remove(oldSpray);
      oldSpray.geometry.dispose();
      this.liquidSprayChunks.delete(lk);
    }

    if (!mats.waterfallFoam && !mats.waterfallSpray) return;
    const sites = findWaterfalls(this.map, this.layout, b, opts);
    if (sites.length === 0) return;

    // Density and footprint are geometry, not shading, so they come from the
    // descriptor here rather than from the material set.
    const desc = this.liquidDescriptors.get(liquidId);

    if (mats.waterfallFoam) {
      const geo = buildWaterfallFoamGeometry(sites, { scale: desc?.poolScale });
      if (geo) {
        this.applyFog(mats.waterfallFoam);
        const m = new THREE.Mesh(geo, mats.waterfallFoam);
        m.frustumCulled = true;
        m.renderOrder = RENDER_ORDER_WATERFALL_FOAM;
        this.scene.add(m);
        this.liquidFoamChunks.set(lk, m);
      }
    }

    if (mats.waterfallSpray) {
      const geo = buildWaterfallSprayGeometry(sites, { intensity: desc?.sprayIntensity });
      if (geo) {
        this.applyFog(mats.waterfallSpray);
        const pts = new THREE.Points(geo, mats.waterfallSpray);
        pts.frustumCulled = true;
        pts.renderOrder = RENDER_ORDER_WATERFALL_SPRAY;
        this.scene.add(pts);
        this.liquidSprayChunks.set(lk, pts);
      }
    }
  }

  /** Build a {@link ChunkEvent} from a chunk key, but only if anyone is listening. */
  private emitChunkEvent(type: keyof ChunkManagerEventMap, k: string, bounds?: ChunkBounds): void {
    if (this.events.listenerCount(type) === 0) return;
    const [cx, cy] = k.split(',').map(Number);
    this.events.emit(type, { cx, cy, bounds: bounds ?? this.bounds(cx, cy) });
  }

  private unloadChunk(k: string): void {
    const mesh = this.chunks.get(k);
    if (!mesh) return;
    // Captured before the map can be swapped out from under a listener —
    // `bounds()` clamps to the current map, and setMap() unloads then re-points.
    const bounds = this.events.listenerCount('chunkUnloaded') > 0
      ? this.bounds(...(k.split(',').map(Number) as [number, number]))
      : undefined;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    this.chunks.delete(k);
    this._geometryRevision++;

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

      const fm = this.liquidFoamChunks.get(lk);
      if (fm) { this.scene.remove(fm); fm.geometry.dispose(); this.liquidFoamChunks.delete(lk); }

      const pm = this.liquidSprayChunks.get(lk);
      if (pm) { this.scene.remove(pm); pm.geometry.dispose(); this.liquidSprayChunks.delete(lk); }
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
        // buildScatterMeshes gives each mesh its own clone of the definition's
        // geometry so it can carry per-instance cellIndex values. That clone is
        // owned by this mesh (InstancedMesh.dispose only frees the instance
        // buffers), so it has to go too — the definition's original is
        // untouched and stays reusable.
        m.geometry.dispose();
      }
      this.scatterChunks.delete(k);
    }

    this.dirty.delete(k);
    this.emitChunkEvent('chunkUnloaded', k, bounds);
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
      for (const mat of liquidMaterialList(ms)) {
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

    // Widen/narrow downstream channels whose accumulated flow changed, and
    // re-level ones whose carved elevation changed, BEFORE snapshotting dirty
    // regions, so their chunks join this frame's rebuild. Only after a
    // river-relevant write — syncRiverCaches leaves the caches alone (and
    // this branch idle) for edits on dry land.
    this.syncRiverCaches();
    if (this.dirty.size > 0 && (this.riverFlowCache === null || this.riverElevCache === null)) {
      this.refreshRiverCachesAndMarkChanged();
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
      this.geoOptions.riverFlow       = this.riverFlow();
      this.geoOptions.riverElevations = this.riverElevations();
      const { terrain: newGeo, roads: newRoadsGeo } = buildChunkGeometry(this.map, this.layout, b, this.geoOptions);
      mesh.geometry = newGeo;
      this._geometryRevision++;

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
            m.renderOrder = RENDER_ORDER_SHORE;
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
            m.renderOrder = RENDER_ORDER_ESTUARY;
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
            m.renderOrder = RENDER_ORDER_RIVER;
            this.scene.add(m);
            this.liquidRiverChunks.set(lk, m);
          }
        }

        this.rebuildWaterfalls(liquidId, mats, lk, b, opts);
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
        newRdMesh.receiveShadow = true;
        newRdMesh.renderOrder = RENDER_ORDER_ROADS;
        this.scene.add(newRdMesh);
        this.roadChunks.set(k, newRdMesh);
      }

      const oldScMeshes = this.scatterChunks.get(k);
      if (oldScMeshes) {
        // geometry.dispose() too — see the note in the unload path; each mesh
        // owns its clone of the definition's geometry.
        for (const m of oldScMeshes) { this.scene.remove(m); m.dispose(); m.geometry.dispose(); }
        this.scatterChunks.delete(k);
      }
      if (this.hashGrid && this.scatterDefinitions && this.scatterDefinitions.length > 0) {
        const newScMeshes = buildScatterMeshes(this.map, this.layout, b, this.hashGrid, this.scatterDefinitions, this.allWaterTerrains);
        if (newScMeshes.length > 0) {
          for (const m of newScMeshes) { m.visible = this.scatterVisible; this.scene.add(m); }
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
        if (this.workerFactory) this.requestChunkAsync(cx, cy);
        else this.loadChunk(cx, cy);
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
   *
   * Cells on a chunk border also mark the adjacent chunk(s): their shore
   * strips, skirts, bridges, and road geometry sample this cell, so rebuilding
   * only the edited cell's chunk would leave the neighbour's geometry stale.
   */
  markDirty(col: number, row: number): void {
    const cs = this.chunkSize;
    this.dirty.add(this.key(Math.floor(col / cs), Math.floor(row / cs)));
    // The river caches are not dropped here: `update()` compares the map's
    // river revision and drops them only when a river-relevant write happened.
    this.invalidateAsyncBuilds();   // worker snapshot no longer matches the map

    // Interior cells can't affect another chunk's geometry.
    const lc = col % cs, lr = row % cs;
    if (lc > 0 && lc < cs - 1 && lr > 0 && lr < cs - 1) return;

    const q = col - (row - (row & 1)) / 2;
    for (let d = 0; d < 6; d++) {
      const nq = q   + HEX_DIRECTIONS[d].q;
      const nr = row + HEX_DIRECTIONS[d].r;
      const nc = nq  + (nr - (nr & 1)) / 2;
      if (nc < 0 || nc >= this.map.width || nr < 0 || nr >= this.map.height) continue;
      this.dirty.add(this.key(Math.floor(nc / cs), Math.floor(nr / cs)));
    }
  }

  /** `markDirty` for a batch of cells — pairs with `MapEdit.cells` after undo/redo. */
  markDirtyCells(cells: Iterable<{ col: number; row: number }>): void {
    for (const c of cells) this.markDirty(c.col, c.row);
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

  /**
   * Show or hide every scatter feature (trees, rocks, bushes) without touching
   * the underlying feature layers. Streaming and dirty rebuilds keep honoring
   * the flag, so chunks loaded while hidden come in hidden too.
   */
  /**
   * Replace the scatter definitions and rebuild every loaded chunk's scatter
   * in place — terrain, liquids, and roads are untouched. This is what an
   * editor's scatter builder calls on every change, so it has to be cheap
   * relative to a full chunk rebuild, and it is: instanced meshes only.
   */
  setScatterDefinitions(definitions: ScatterDefinition[]): void {
    this.scatterDefinitions = definitions;
    for (const [k, meshes] of this.scatterChunks) {
      for (const m of meshes) { this.scene.remove(m); m.dispose(); m.geometry.dispose(); }
      this.scatterChunks.delete(k);
    }
    if (!this.hashGrid || definitions.length === 0) return;
    for (const k of this.chunks.keys()) {
      const [cx, cy] = k.split(',').map(Number);
      const b = this.bounds(cx, cy);
      const meshes = buildScatterMeshes(this.map, this.layout, b, this.hashGrid, definitions, this.allWaterTerrains);
      if (meshes.length === 0) continue;
      for (const m of meshes) { m.visible = this.scatterVisible; this.scene.add(m); }
      this.scatterChunks.set(k, meshes);
      if (this.fogData) this.applyFogToScatterMeshes(meshes);
    }
  }

  setScatterVisible(visible: boolean): void {
    this.scatterVisible = visible;
    for (const meshes of this.scatterChunks.values()) {
      for (const m of meshes) m.visible = visible;
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
    this.riverFlowCache     = null;
    this.lastRiverFlow      = null;
    this.riverElevCache     = null;
    this.lastRiverElev      = null;
    // A replacement map starts its own revision count; force the first sync.
    this.riverCacheRevision = -1;
    // Terminate the chunk worker; the next async request recreates it from
    // the factory, so dispose-and-reload keeps working with workers enabled.
    this.invalidateAsyncBuilds();
    this.worker?.dispose();
    this.worker = null;
  }

  /**
   * Swap in a different `HexMap` without recreating the manager: all loaded
   * chunks are unloaded and chunks for the new map stream in on the next
   * `update()` (or `loadAll()`). Materials, terrain definitions, and options
   * are kept. Water surfaces are recomputed so the new map renders correctly
   * even if it was edited without a `computeWaterSurfaces` call.
   */
  setMap(map: HexMap): void {
    this.dispose();
    this.dirty.clear();
    this.map = map;
    map.computeWaterSurfaces(t => this.allWaterTerrains.has(t));
  }

  /**
   * Swap terrain definitions (and optionally the terrain material) in place —
   * e.g. after the user defines custom terrain or loads a pack. All loaded
   * chunks are unloaded and rebuilt with the new definitions on the next
   * `update()` / `loadAll()`; water surfaces are recomputed because liquid
   * terrain membership may have changed.
   *
   * The caller keeps ownership of the previous material (dispose it yourself
   * if it is no longer used elsewhere).
   */
  setTerrainDefinitions(terrainDefs: TerrainDefinition[], material?: THREE.Material): void {
    this.dispose();
    this.dirty.clear();
    this.applyTerrainDefinitions(terrainDefs);
    if (material) this.material = material;
    this.map.computeWaterSurfaces(t => this.allWaterTerrains.has(t));
  }

  /**
   * Swap the liquid types (descriptors + material sets) in place — e.g. after
   * the user edits a liquid's appearance or defines a new one. All loaded
   * chunks are unloaded and rebuilt with the new liquids on the next
   * `update()` / `loadAll()`.
   *
   * The caller keeps ownership of the previous materials (dispose the ones
   * that are no longer used).
   */
  setLiquids(descriptors: LiquidTypeDescriptor[], materials: Map<string, LiquidMaterialSet>): void {
    this.dispose();
    this.dirty.clear();
    const entries = [...materials]; // snapshot first — caller may pass the map we already hold
    this.liquidMaterials.clear();
    for (const [id, m] of entries) this.liquidMaterials.set(id, m);
    this.liquidDescriptors.clear();
    for (const d of descriptors) this.liquidDescriptors.set(d.id, d);
    this.computeDefaultRiverLiquid();
  }

  /**
   * Switch the terrain color mode at runtime.
   * Updates the material on all loaded terrain meshes and rebuilds geometry.
   */
  setColorMode(mode: TerrainColorMode, material: THREE.Material): void {
    this.material = material;
    this.geoOptions.colorMode = mode;
    this.invalidateAsyncBuilds(); // worker options snapshot is stale
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

  /** Number of waterfall plunge-pool meshes currently in the scene (all liquid types combined). */
  get loadedWaterfallFoamChunkCount(): number {
    return this.liquidFoamChunks.size;
  }

  /** Number of waterfall spray particle systems currently in the scene (all liquid types combined). */
  get loadedWaterfallSprayChunkCount(): number {
    return this.liquidSprayChunks.size;
  }

  get loadedChunkCount(): number {
    return this.chunks.size;
  }

  /** Currently loaded terrain meshes — pass to pickHexFromMeshes for accurate raycasting. */
  get terrainMeshes(): THREE.Mesh[] {
    return [...this.chunks.values()];
  }

  /** Changes whenever a terrain chunk is loaded, unloaded, or rebuilt. */
  get geometryRevision(): number {
    return this._geometryRevision;
  }
}
