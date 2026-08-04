import * as THREE from 'three';
import { HexMap } from '../map/HexMap.js';
import type { HexOrientation } from '../math/HexOrientation.js';
import { POINTY_TOP } from '../math/HexOrientation.js';
import type { HexLayout } from '../math/HexLayout.js';
import { createLayout } from '../math/HexLayout.js';
import { ChunkManager } from '../geometry/ChunkManager.js';
import { createDefaultChunkWorker, type ChunkWorkerLike } from '../geometry/WorkerChunkBuilder.js';
import type { ChunkGeometryOptions } from '../geometry/HexChunk.js';
import type { WaterGeometryOptions } from '../geometry/WaterChunk.js';
import { HexPicker } from '../geometry/HexPicker.js';
import { CellOverlayLayer } from '../geometry/CellOverlayLayer.js';
import { HexHashGrid } from '../geometry/HexHashGrid.js';
import type { ScatterDefinition } from '../geometry/ScatterTypes.js';
import type { FogData } from '../geometry/FogData.js';
import type { TerrainDescriptor, TerrainDefinition, TerrainAssetRegistry } from '../geometry/TerrainTypes.js';
import {
  DEFAULT_TERRAIN_DESCRIPTORS, resolveTerrainDefinitions,
  buildTerrainLookup, buildWaterTerrainSet,
} from '../geometry/TerrainTypes.js';
import { buildTerrainTextureArray } from '../geometry/TerrainTextures.js';
import type { TerrainGridOptions, TerrainMaterialOptions } from '../geometry/TerrainMaterial.js';
import { configureTerrainGrid, createTerrainMaterial } from '../geometry/TerrainMaterial.js';
import type { LiquidTypeDescriptor, LiquidMaterialSet } from '../geometry/LiquidTypes.js';
import { DEFAULT_LIQUID_DESCRIPTORS, resolveLiquidMaterials, liquidMaterialList } from '../geometry/LiquidTypes.js';
import { createRoadMaterial } from '../geometry/RoadMaterial.js';
import { RtsCameraController } from '../camera/RtsCameraController.js';
import { SunShadowRig, type SunShadowOptions } from '../lighting/SunShadows.js';
import { DayNightCycle, type DayNightOptions } from '../lighting/DayNightCycle.js';
import { WeatherSystem, type WeatherType, type WeatherOptions } from '../weather/WeatherSystem.js';

export interface HexWorldCameraOptions {
  /** Vertical field of view in degrees. Default 45. */
  fov?: number;
  near?: number;
  far?: number;
  initialDistance?: number;
  initialPitch?: number;
  minPitch?: number;
  maxPitch?: number;
  minDistance?: number;
  maxDistance?: number;
}

export interface HexWorldOptions {
  /** Element the renderer canvas is appended to; sized to fit it. */
  container: HTMLElement;
  /** Existing map to render. Omit to create a blank one from width/height. */
  map?: HexMap;
  /** Blank-map dimensions when `map` is omitted. Default 100×100. */
  width?: number;
  height?: number;
  /** Feature layers for the blank map. Default 0. */
  featureLayerCount?: number;
  /** POINTY_TOP (default) or FLAT_TOP. */
  orientation?: HexOrientation;
  /** Hex radius in world units. Default 1. */
  hexSize?: number;
  /** Custom terrain set. Default DEFAULT_TERRAIN_DESCRIPTORS. */
  terrainDescriptors?: TerrainDescriptor[];
  /** Asset registry for image-textured terrain. */
  terrainAssets?: TerrainAssetRegistry;
  /** Extra options for the terrain shader material (light dir/colors, texScale). */
  terrainMaterialOptions?: TerrainMaterialOptions;
  /** Liquid types to render. Default DEFAULT_LIQUID_DESCRIPTORS. */
  liquidDescriptors?: LiquidTypeDescriptor[];
  /** Per-liquid material sets. Default: resolved from each liquid descriptor. */
  liquidMaterials?: Map<string, LiquidMaterialSet>;
  scatterDefinitions?: ScatterDefinition[];
  /** Seed for deterministic scatter placement. Default 1234. */
  scatterSeed?: number;
  fogData?: FogData;
  /** Widen river channels with accumulated flow. Default true. */
  flowWidenedRivers?: boolean;
  /** Cells per chunk side. Default 32. */
  chunkSize?: number;
  /** Chunk streaming radius. Default 5. */
  loadRadius?: number;
  geometryOptions?: ChunkGeometryOptions;
  waterGeometryOptions?: WaterGeometryOptions;
  /**
   * Build streamed-in chunk geometry on a Web Worker instead of the main
   * thread, eliminating streaming hitches on big maps. `true` uses the
   * library's bundled worker (`createDefaultChunkWorker`); pass a factory to
   * supply your own. Default false (synchronous builds).
   */
  chunkWorker?: boolean | (() => ChunkWorkerLike);
  camera?: HexWorldCameraOptions;
  /** Scene background color, or null to leave the scene transparent. Default 0x1a1a2e. */
  background?: THREE.ColorRepresentation | null;
  /** Add the default ambient + directional lights. Default true. */
  lights?: boolean;
  /**
   * Sun shadows: `true` for the tuned defaults, or a SunShadowOptions object.
   * Enables the renderer's shadow maps and replaces the default directional
   * light with a SunShadowRig whose ortho frustum re-fits the camera view each
   * frame (chunk streaming keeps working — the frustum follows the camera, not
   * the loaded set). With `lights: false` the shadow maps are still enabled so
   * a hand-wired rig works, but no rig is created. Default false.
   */
  shadows?: boolean | SunShadowOptions;
  /**
   * Animated day/night cycle: `true` for defaults (120 s days), or a
   * DayNightOptions object. Drives the sun/shadow rig direction, warm
   * dawn/dusk light tinting, a cool moonlight mode, the scene background,
   * and liquid darkening (lava's emissive glow survives the night). Also
   * creatable later via {@link HexWorld.setTimeOfDay}. Default off.
   */
  dayNight?: boolean | DayNightOptions;
  /** Start the render loop immediately. Default true. */
  autoStart?: boolean;
}

// Defaults match the reference consumer (hex-world-editor) so a bare
// HexWorld.create looks like the editor scene out of the box.
const DEFAULT_LIGHT_DIR   = new THREE.Vector3(100, 120, 80);
const DEFAULT_LIGHT_COLOR = new THREE.Color(0xfff4d0).multiplyScalar(0.7);
const DEFAULT_AMBIENT     = new THREE.Color(0xd0e0ff).multiplyScalar(0.45);

/**
 * Batteries-included entry point: renderer, camera + RTS controls, lighting,
 * terrain/liquid materials, chunk streaming, per-frame picking, and cell
 * overlays — wired the same way the à-la-carte API would be by hand. Every
 * piece stays reachable (`scene`, `camera`, `renderer`, `chunks`, `overlays`,
 * `picker`, …), so you can drop to the lower-level API at any point.
 *
 * @example
 * const world = await HexWorld.create({ container: document.body });
 * FbmPlugin.generate(world.map, FbmPlugin.defaultConfig, Date.now());
 * world.chunks.markDirtyCells([]); // or edit through world.map.edit(...)
 * world.onFrame = () => { if (world.hoveredCell) … };
 */
export class HexWorld {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly layout: HexLayout;
  readonly controls: RtsCameraController;
  readonly hashGrid: HexHashGrid;
  readonly chunks: ChunkManager;
  readonly picker: HexPicker;
  readonly overlays: CellOverlayLayer;
  /** Shadow-casting sun rig when the `shadows` option was set (and default lights are on); null otherwise. */
  readonly sunShadows: SunShadowRig | null = null;

  /** Called once per frame after chunks/picking update, before rendering. */
  onFrame: ((dt: number) => void) | null = null;

  private _map: HexMap;
  private _liquidDescriptors: LiquidTypeDescriptor[];
  private liquidMaterials: Map<string, LiquidMaterialSet>;
  private terrainMaterial: THREE.ShaderMaterial;
  /** Last hex-grid styling from setHexGrid — null until first use. */
  private gridOptions: TerrainGridOptions | null = null;
  private _terrainDefinitions: TerrainDefinition[];
  private _terrainLookup: Map<number, TerrainDefinition>;
  private waterTerrainSet: Set<number>;
  /** The material options used for terrain materials this world builds — reuse for `loadHexPack` so pack materials match the scene lighting. */
  readonly terrainMaterialOptions: TerrainMaterialOptions;
  private readonly resizeObserver: ResizeObserver;
  private readonly container: HTMLElement;
  private mouseX = 0;
  private mouseY = 0;
  private readonly onPointerMove = (e: PointerEvent) => {
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
  };
  private rafId: number | null = null;
  private lastFrameTime = 0;
  private hovered: { col: number; row: number } | null = null;
  private _dayNight: DayNightCycle | null = null;
  private _weather: WeatherSystem | null = null;
  /** The default lights, kept so the day/night cycle can drive them. */
  private defaultAmbient: THREE.AmbientLight | null = null;
  private defaultSun: THREE.DirectionalLight | null = null;
  /** False when the consumer opted out of a background (background: null). */
  private readonly skyFollowsCycle: boolean;

  /** The current map. Swap with {@link setMap}. */
  get map(): HexMap { return this._map; }
  /** Resolved terrain definitions currently in use. */
  get terrainDefinitions(): TerrainDefinition[] { return this._terrainDefinitions; }
  /** Liquid type descriptors currently in use. Swap with {@link setLiquidDescriptors}. */
  get liquidDescriptors(): LiquidTypeDescriptor[] { return this._liquidDescriptors; }
  /** Terrain definitions keyed by terrain index. */
  get terrainLookup(): Map<number, TerrainDefinition> { return this._terrainLookup; }
  /** Cell under the pointer, updated every frame while the loop runs. */
  get hoveredCell(): { col: number; row: number } | null { return this.hovered; }
  /** The day/night cycle, if enabled via the `dayNight` option or {@link setTimeOfDay}. */
  get dayNight(): DayNightCycle | null { return this._dayNight; }
  /** The weather system, once {@link setWeather} has been called. */
  get weather(): WeatherSystem | null { return this._weather; }

  /** True if the terrain index belongs to any liquid type. */
  isWater = (terrain: number): boolean => this.waterTerrainSet.has(terrain);

  private constructor(opts: HexWorldOptions, prepared: {
    terrainMaterial: THREE.ShaderMaterial;
    terrainDefinitions: TerrainDefinition[];
  }) {
    this.container = opts.container;
    this.skyFollowsCycle = opts.background !== null;
    this._map = opts.map ?? new HexMap({
      width:  opts.width  ?? 100,
      height: opts.height ?? 100,
      featureLayerCount: opts.featureLayerCount ?? 0,
    });

    this.scene = new THREE.Scene();
    if (opts.background !== null) this.scene.background = new THREE.Color(opts.background ?? 0x1a1a2e);

    const cam = opts.camera ?? {};
    this.camera = new THREE.PerspectiveCamera(
      cam.fov ?? 45,
      opts.container.clientWidth / Math.max(1, opts.container.clientHeight),
      cam.near ?? 0.1,
      cam.far ?? 500,
    );

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.setSize(opts.container.clientWidth, opts.container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    opts.container.appendChild(this.renderer.domElement);

    if (opts.shadows) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
    }

    if (opts.lights !== false) {
      this.defaultAmbient = new THREE.AmbientLight(0xd0e0ff, 0.5);
      this.scene.add(this.defaultAmbient);
      if (opts.shadows) {
        this.sunShadows = new SunShadowRig({
          direction: DEFAULT_LIGHT_DIR,
          ...(typeof opts.shadows === 'object' ? opts.shadows : {}),
        }).addTo(this.scene);
      } else {
        this.defaultSun = new THREE.DirectionalLight(0xfff4d0, 1.4);
        this.defaultSun.position.copy(DEFAULT_LIGHT_DIR);
        this.scene.add(this.defaultSun);
      }
    }

    this.layout   = createLayout(opts.orientation ?? POINTY_TOP, opts.hexSize ?? 1);
    this.hashGrid = new HexHashGrid(opts.scatterSeed ?? 1234);

    this.terrainMaterialOptions = {
      lightDir:   DEFAULT_LIGHT_DIR,
      lightColor: DEFAULT_LIGHT_COLOR,
      ambient:    DEFAULT_AMBIENT,
      ...opts.terrainMaterialOptions,
    };
    this.terrainMaterial      = prepared.terrainMaterial;
    this._terrainDefinitions  = prepared.terrainDefinitions;
    this._terrainLookup       = buildTerrainLookup(this._terrainDefinitions);
    this.waterTerrainSet      = buildWaterTerrainSet(this._terrainDefinitions);

    this._liquidDescriptors = opts.liquidDescriptors ?? DEFAULT_LIQUID_DESCRIPTORS;
    this.liquidMaterials    = opts.liquidMaterials
      ?? new Map(this._liquidDescriptors.map(d => [d.id, resolveLiquidMaterials(d)]));

    this.chunks = new ChunkManager({
      map:                  this._map,
      layout:               this.layout,
      scene:                this.scene,
      material:             this.terrainMaterial,
      liquidMaterials:      this.liquidMaterials,
      liquidDescriptors:    this._liquidDescriptors,
      roadMaterial:         createRoadMaterial(),
      terrainDefinitions:   this._terrainDefinitions,
      chunkSize:            opts.chunkSize  ?? 32,
      loadRadius:           opts.loadRadius ?? 5,
      geometryOptions:      opts.geometryOptions,
      waterGeometryOptions: opts.waterGeometryOptions,
      workerFactory:        opts.chunkWorker === true ? createDefaultChunkWorker
                          : opts.chunkWorker || undefined,
      hashGrid:             this.hashGrid,
      scatterDefinitions:   opts.scatterDefinitions,
      fogData:              opts.fogData,
      flowWidenedRivers:    opts.flowWidenedRivers,
    });

    this.controls = new RtsCameraController({
      camera:          this.camera,
      domElement:      this.renderer.domElement,
      initialTarget:   { x: this._map.width / 2, z: this._map.height / 2 },
      initialDistance: cam.initialDistance ?? 60,
      ...(cam.initialPitch !== undefined ? { initialPitch: cam.initialPitch } : {}),
      minPitch:        cam.minPitch    ?? 30,
      maxPitch:        cam.maxPitch    ?? 66,
      minDistance:     cam.minDistance ?? 6,
      maxDistance:     cam.maxDistance ?? 80,
    });

    this.picker = new HexPicker({
      camera:     this.camera,
      domElement: this.renderer.domElement,
      layout:     this.layout,
      map:        () => this._map,
      meshes:     () => this.chunks.terrainMeshes,
      isWater:    this.isWater,
    });

    this.overlays = new CellOverlayLayer({
      parent:  this.scene,
      layout:  this.layout,
      map:     () => this._map,
      isWater: this.isWater,
    });

    this.resizeObserver = new ResizeObserver(() => {
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      this.camera.aspect = w / Math.max(1, h);
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });
    this.resizeObserver.observe(this.container);

    window.addEventListener('pointermove', this.onPointerMove);

    if (opts.dayNight) {
      this._dayNight = new DayNightCycle(typeof opts.dayNight === 'object' ? opts.dayNight : {});
      this.applyDayNight();
    }

    if (opts.autoStart !== false) this.start();
  }

  /**
   * Build a fully wired world. Async because the terrain texture atlas is
   * built from (possibly image-based) terrain descriptors.
   */
  static async create(opts: HexWorldOptions): Promise<HexWorld> {
    const descriptors = opts.terrainDescriptors ?? DEFAULT_TERRAIN_DESCRIPTORS;
    const tex = await buildTerrainTextureArray(descriptors, opts.terrainAssets);
    const material = createTerrainMaterial(tex, {
      lightDir:   DEFAULT_LIGHT_DIR,
      lightColor: DEFAULT_LIGHT_COLOR,
      ambient:    DEFAULT_AMBIENT,
      ...opts.terrainMaterialOptions,
    });
    return new HexWorld(opts, {
      terrainMaterial:    material,
      terrainDefinitions: resolveTerrainDefinitions(descriptors),
    });
  }

  /** Start the render loop (no-op if already running). */
  start(): void {
    if (this.rafId !== null) return;
    this.lastFrameTime = performance.now();
    const tick = (): void => {
      this.rafId = requestAnimationFrame(tick);
      const now = performance.now();
      const dt  = (now - this.lastFrameTime) / 1000;
      this.lastFrameTime = now;

      this.controls.update();
      if (this._dayNight && !this._dayNight.paused) {
        this._dayNight.advance(dt);
        this.applyDayNight();
      }
      this._weather?.update(dt, this.controls.targetPosition);
      this.sunShadows?.update(this.camera);
      this.chunks.update(this.camera, dt);
      this.hovered = this.picker.pick(this.mouseX, this.mouseY);
      this.onFrame?.(dt);
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  /** Stop the render loop (state is kept; call start() to resume). */
  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  /** Swap in a different map; chunks rebuild and the camera recenters. */
  setMap(map: HexMap): void {
    this.chunks.setMap(map);
    this._map = map;
    this.picker.reset();
    this.controls.snapTo(map.width / 2, map.height / 2);
  }

  /**
   * Swap the terrain set at runtime (custom terrain, loaded pack): rebuilds
   * the texture atlas + terrain material and re-derives all lookups. The
   * previous terrain material is disposed unless you pass `keepOldMaterial`.
   */
  async setTerrainDescriptors(
    descriptors: TerrainDescriptor[],
    registry?: TerrainAssetRegistry,
    keepOldMaterial = false,
  ): Promise<void> {
    const tex    = await buildTerrainTextureArray(descriptors, registry);
    const oldMat = this.terrainMaterial;
    this.terrainMaterial     = createTerrainMaterial(tex, this.terrainMaterialOptions);
    this._terrainDefinitions = resolveTerrainDefinitions(descriptors);
    this._terrainLookup      = buildTerrainLookup(this._terrainDefinitions);
    this.waterTerrainSet     = buildWaterTerrainSet(this._terrainDefinitions);
    this.chunks.setTerrainDefinitions(this._terrainDefinitions, this.terrainMaterial);
    this.reapplyHexGrid();
    this._weather?.setTerrainMaterial(this.terrainMaterial);
    this.applyDayNight();
    if (!keepOldMaterial) oldMat.dispose();
  }

  /**
   * Adopt already-resolved terrain state (e.g. from `loadHexPack`, which
   * builds its own material). Returns the previous material WITHOUT disposing
   * it — the caller decides, since it may be shared.
   */
  applyTerrainDefinitions(definitions: TerrainDefinition[], material: THREE.ShaderMaterial): THREE.ShaderMaterial {
    const oldMat = this.terrainMaterial;
    this.terrainMaterial     = material;
    this._terrainDefinitions = definitions;
    this._terrainLookup      = buildTerrainLookup(definitions);
    this.waterTerrainSet     = buildWaterTerrainSet(definitions);
    this.chunks.setTerrainDefinitions(definitions, material);
    this.reapplyHexGrid();
    this._weather?.setTerrainMaterial(material);
    this.applyDayNight();
    return oldMat;
  }

  /**
   * Toggle or restyle the shader hex grid overlay drawn by the terrain
   * material — crisp anti-aliased cell borders that fade with camera distance.
   * `true`/`false` toggles with current styling; an options object restyles
   * (and enables unless `enabled: false`). Survives terrain material swaps.
   *
   * @example
   * world.setHexGrid(true);
   * world.setHexGrid({ color: 0xffffff, opacity: 0.25, fadeEnd: 120 });
   * world.setHexGrid(false);
   */
  setHexGrid(options: TerrainGridOptions | boolean = true): void {
    if (typeof options === 'boolean') {
      this.gridOptions = { ...this.gridOptions, enabled: options };
    } else {
      this.gridOptions = { ...this.gridOptions, ...options, enabled: options.enabled ?? true };
    }
    this.reapplyHexGrid();
  }

  /** Grid styling survives terrain material swaps — re-push it onto the current material. */
  private reapplyHexGrid(): void {
    if (!this.gridOptions) return;
    configureTerrainGrid(this.terrainMaterial, this.layout, this.gridOptions);
  }

  /**
   * Point the sun (day/night hook): updates the shadow rig AND the terrain
   * material's hand-rolled light direction in one call so shading and shadows
   * never disagree. `dirTowardSun` points from the scene toward the sun.
   * Survives terrain material swaps.
   */
  setSunDirection(dirTowardSun: THREE.Vector3): void {
    this.sunShadows?.setDirection(dirTowardSun);
    // Future materials (setTerrainDescriptors / loadHexPack) pick it up too.
    this.terrainMaterialOptions.lightDir = dirTowardSun.clone();
    const u = this.terrainMaterial.uniforms;
    if (u && 'uLightDir' in u) u.uLightDir.value.copy(dirTowardSun).normalize();
  }

  /**
   * Jump the world clock to a time of day (0 = midnight, 0.5 = noon) and
   * relight the scene. Creates a paused DayNightCycle on first use if the
   * `dayNight` option wasn't set — unpause via `world.dayNight.paused = false`
   * to let time flow.
   */
  setTimeOfDay(time: number): void {
    if (!this._dayNight) {
      this._dayNight = new DayNightCycle({ time, paused: true });
    } else {
      this._dayNight.setTime(time);
    }
    this.applyDayNight();
  }

  /** Push the current day/night state onto the lights, materials, and sky. */
  private applyDayNight(): void {
    this._dayNight?.applyTo({
      sunRig:          this.sunShadows ?? undefined,
      sunLight:        this.defaultSun ?? undefined,
      ambientLight:    this.defaultAmbient ?? undefined,
      terrainMaterial: this.terrainMaterial,
      liquidMaterials: this.liquidMaterials.values(),
      scene:           this.skyFollowsCycle ? this.scene : undefined,
    });
  }

  /**
   * Set the weather: drifting cloud shadows on the terrain plus a matching
   * rain/snow layer that falls under the denser clouds and follows the
   * camera (world-anchored — panning doesn't drag the rain). Creates the
   * WeatherSystem on first use; returns it for fine-grained control
   * (intensity ramps, wind changes).
   *
   * @example
   * world.setWeather('rain');
   * world.setWeather('snow', { intensity: 0.6 });
   * world.setWeather('clear');
   */
  setWeather(type: WeatherType, options: WeatherOptions = {}): WeatherSystem {
    this._weather ??= new WeatherSystem({
      scene:           this.scene,
      terrainMaterial: this.terrainMaterial,
      liquidMaterials: () => this.liquidMaterials.values(),
    });
    this._weather.setWeather(type, options);
    return this._weather;
  }

  /**
   * Swap the liquid types at runtime (edited appearance, new custom liquid).
   * Materials are resolved from the descriptors unless provided; previous
   * liquid materials this world held are disposed unless still referenced by
   * the new set.
   */
  setLiquidDescriptors(
    descriptors: LiquidTypeDescriptor[],
    materials?: Map<string, LiquidMaterialSet>,
  ): void {
    const newMats = materials ?? new Map(descriptors.map(d => [d.id, resolveLiquidMaterials(d)]));
    const reused  = new Set([...newMats.values()]);
    for (const set of this.liquidMaterials.values()) {
      if (reused.has(set)) continue;
      for (const m of liquidMaterialList(set)) m?.dispose();
    }
    this._liquidDescriptors = descriptors;
    this.liquidMaterials    = newMats;
    this.chunks.setLiquids(descriptors, newMats);
    // Fresh materials default to an untinted, cloudless look — re-push the
    // current time of day and weather so they match the scene.
    this.applyDayNight();
    this._weather?.refresh();
  }

  /** Stop the loop and free everything this world created. */
  dispose(): void {
    this.stop();
    window.removeEventListener('pointermove', this.onPointerMove);
    this.resizeObserver.disconnect();
    this.overlays.dispose();
    this.chunks.dispose();
    this.controls.dispose();
    this._weather?.dispose();
    this.sunShadows?.dispose();
    this.terrainMaterial.dispose();
    for (const set of this.liquidMaterials.values()) {
      for (const m of liquidMaterialList(set)) m?.dispose();
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
