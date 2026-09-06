import * as THREE from 'three';
import { HexMap } from '../map/HexMap.js';
import type { HexOrientation } from '../math/HexOrientation.js';
import { POINTY_TOP } from '../math/HexOrientation.js';
import type { HexLayout } from '../math/HexLayout.js';
import { createLayout, hexToWorld } from '../math/HexLayout.js';
import { offsetToHex } from '../math/HexCoord.js';
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
import type { CliffStrataOptions, TerrainGridOptions, TerrainMaterialOptions } from '../geometry/TerrainMaterial.js';
import { configureCliffStrata, configureTerrainGrid, createTerrainMaterial } from '../geometry/TerrainMaterial.js';
import type { LiquidTypeDescriptor, LiquidMaterialSet } from '../geometry/LiquidTypes.js';
import { DEFAULT_LIQUID_DESCRIPTORS, resolveLiquidMaterials, liquidMaterialList } from '../geometry/LiquidTypes.js';
import { createRoadMaterial } from '../geometry/RoadMaterial.js';
import { RtsCameraController } from '../camera/RtsCameraController.js';
import { SunShadowRig, type SunShadowOptions } from '../lighting/SunShadows.js';
import { DayNightCycle, type DayNightOptions } from '../lighting/DayNightCycle.js';
import { WeatherSystem, type WeatherType, type WeatherOptions } from '../weather/WeatherSystem.js';
import { Wind, setMaterialWind, type WindOptions } from '../weather/Wind.js';
import { SkyDome, averageTerrainColor, type SkyDomeOptions } from '../sky/SkyDome.js';
import { GodRays, type GodRaysOptions } from '../sky/GodRays.js';
import { MapSkirt, type MapSkirtMeshOptions } from '../geometry/MapSkirt.js';
import { attachAtmosphere } from '../sky/Atmosphere.js';
import { ClimateData } from '../season/ClimateData.js';
import { SeasonCycle, type SeasonOptions } from '../season/SeasonCycle.js';
import {
  configureSeason, resolveSnowTerrain, resolveFoliageColor, setSeasonPhase,
  type SeasonAppearanceOptions, type FoliageTintOptions,
} from '../season/SeasonGLSL.js';
import { attachSnow } from '../season/SnowAttach.js';
import type { TemperatureModelOptions } from '../generators/TemperatureModel.js';
import { TerritoryLayer, type FactionDescriptor, type TerritoryLayerOptions } from '../gameplay/TerritoryLayer.js';
import { ResourceLayer, type ResourceLayerOptions } from '../gameplay/ResourceLayer.js';
import type { ResourceDescriptor, ResourceIconRegistry } from '../gameplay/ResourceTypes.js';
import { Emitter, type Unsubscribe } from '../events/Emitter.js';
import type { ChunkManagerEventMap } from '../geometry/ChunkManager.js';
import type { UnitManager, UnitManagerEventMap } from '../units/UnitManager.js';

/** A cell address. Cell events carry these directly rather than a wrapper object. */
export interface CellRef {
  col: number;
  row: number;
}

/** Payload for the pointer-driven cell events. */
export interface CellPointerEvent extends CellRef {
  /** `PointerEvent.button`: 0 left, 1 middle, 2 right. */
  button: number;
  /** The originating DOM event, for modifier keys and `preventDefault`. */
  pointer: PointerEvent;
}

/**
 * Everything {@link HexWorld.events} can emit. Chunk streaming and unit events
 * are re-emitted verbatim from {@link ChunkManager.events} and (once
 * {@link HexWorld.trackUnits} is wired) {@link UnitManager.events}, so one
 * subscription point covers the whole world.
 */
export interface HexWorldEventMap extends ChunkManagerEventMap, UnitManagerEventMap {
  /**
   * Once per rendered frame, after chunks, picking, and the overlay layers have
   * updated and before the draw call. The multi-subscriber form of
   * {@link HexWorld.onFrame}, which still fires first.
   */
  frame: { dt: number };
  /**
   * The cell under the pointer changed — including to and from `null` when the
   * cursor leaves the map. One subscription that always knows what's under the
   * cursor; use it for a status readout or a hover highlight that has to clear.
   */
  cellHover: { cell: CellRef | null; previous: CellRef | null };
  /** The pointer moved onto this cell. Paired with `cellLeave`. */
  cellEnter: CellRef;
  /** The pointer moved off this cell. Fires before the matching `cellEnter`. */
  cellLeave: CellRef;
  /**
   * A press and release on the same cell without dragging past
   * {@link HexWorldOptions.clickTolerance}. Fires for every button, so a
   * right-click that *isn't* a camera pan reads as the cancel gesture it is.
   */
  cellClick: CellPointerEvent;
  /**
   * A button went down over a cell. Fires synchronously from the DOM handler,
   * so `pointer.preventDefault()` still works — the hook for consuming an input
   * before the camera controller acts on it.
   */
  cellPointerDown: CellPointerEvent;
  /** {@link HexWorld.setMap} swapped the map. Chunk events for the new map follow. */
  mapChanged: { map: HexMap };
}

export interface HexWorldCameraOptions {
  /** Vertical field of view in degrees. Default 45. */
  fov?: number;
  near?: number;
  far?: number;
  initialDistance?: number;
  initialPitch?: number;
  /** Initial compass heading in degrees; 0 (the default) looks toward −Z. */
  initialYaw?: number;
  /**
   * Shallowest tilt, in degrees above the horizon. Default 6 — low enough to
   * put the horizon well inside the frame, which is what lets a sky, a sunset,
   * or {@link GodRays} be seen at all. Raise it to keep the view strictly
   * top-down.
   */
  minPitch?: number;
  maxPitch?: number;
  minDistance?: number;
  maxDistance?: number;
  /** Degrees of pitch change per pixel of vertical middle-drag. Default 0.3. */
  tiltSpeed?: number;
  /** Degrees of yaw change per pixel of horizontal middle-drag. Default 0.3. */
  yawSpeed?: number;
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
  /**
   * Gradient sky dome + matching distance haze: `true` for the tuned defaults,
   * or a SkyDomeOptions object. The dome takes its colors from the day/night
   * cycle and greys over under rain/snow, while terrain, roads, and every
   * liquid layer dissolve into its horizon color, so the map edge fades into
   * atmosphere instead of ending against the background. `groundTint` defaults
   * to the average color of the terrain palette (re-derived on terrain swaps).
   * Scatter materials get the same haze via {@link attachAtmosphere}; hand your
   * own unit/prop materials to it as well. Also creatable later via
   * {@link HexWorld.setSky}. Default off.
   */
  sky?: boolean | SkyDomeOptions;
  /**
   * Crepuscular rays fanning out from the sun past ridgelines and trees:
   * `true` for the tuned defaults, or a {@link GodRaysOptions} object. Drawn as
   * one extra low-resolution pass after the frame, so the renderer's
   * antialiasing is untouched, and skipped entirely whenever the sun is down,
   * behind the camera, or buried under cloud. Best paired with `sky` (the dome
   * supplies the disc the shafts start at and the overcast that puts them
   * out). Also creatable later via {@link HexWorld.setGodRays}. Default off.
   */
  godRays?: boolean | GodRaysOptions;
  /**
   * Close the map's open edges with a wall of cut earth: `true` for the tuned
   * defaults, or a {@link MapSkirtMeshOptions} object. The terrain is a
   * surface rather than a solid, so any camera low enough to see the horizon
   * also sees under it — the skirt gives the map a bottom and four sides,
   * banded with soil strata like a block cut out of the ground.
   *
   * Its top follows the terrain's own contour (including where that contour is
   * a sea bed), and it takes the world's `geometryOptions` automatically so the
   * seam stays tight. Also creatable later via {@link HexWorld.setSkirt}.
   * Default off.
   */
  skirt?: boolean | MapSkirtMeshOptions;
  /**
   * Seasons, snow accumulation, and freezing water: `true` for the tuned
   * defaults, or a {@link HexWorldSeasonOptions} object. Builds a
   * {@link ClimateData} for the map (or takes one you already generated),
   * advances a {@link SeasonCycle} alongside the day clock, and drives snow on
   * the terrain and scatter plus ice on every liquid whose descriptor sets a
   * `freezePoint`. Precipitation follows too — snow falls where snow lies, rain
   * everywhere else. Also creatable later via {@link HexWorld.setSeasons}.
   * Default off.
   */
  seasons?: boolean | HexWorldSeasonOptions;
  /**
   * The shared world wind: `true` for the tuned defaults, or a
   * {@link WindOptions} object. One vector, gusting on its own clock, that
   * drifts the cloud deck, slants the rain, marches the ripples across open
   * water, and bends every plant whose material carries
   * {@link attachWindSway} — which is the call that decides *which* scatter
   * answers it, since a boulder should not. Also switchable later via
   * {@link HexWorld.setWind}. Default off.
   */
  wind?: boolean | WindOptions;
  /** Start the render loop immediately. Default true. */
  autoStart?: boolean;
  /**
   * How far the pointer may travel between press and release and still count as
   * a `cellClick`, in CSS pixels. This is what keeps a right-drag pan from
   * firing a click when the button comes up. Default 5.
   */
  clickTolerance?: number;
}

/** Season options plus the rendering and wiring knobs {@link HexWorld.setSeasons} adds. */
export interface HexWorldSeasonOptions extends SeasonOptions, SeasonAppearanceOptions {
  /**
   * Options to rebuild the base temperature field with when no
   * {@link ClimateData} is supplied. Pass the same ones the map was generated
   * with — `climateData.temperatureOptions` records them — or the seasons will
   * be computed against a different climate than the biomes were.
   */
  temperature?: TemperatureModelOptions;
  /**
   * Seconds between seasonal passes over the map. The pass is O(cells), so on a
   * continent-scale map running it every frame is waste — snow does not move
   * fast enough to notice. Default 0.25.
   */
  applyInterval?: number;
  /**
   * Foliage styling for the *ground* only, applied over
   * {@link SeasonAppearanceOptions.foliage}.
   *
   * The two want to differ. Ground cover turns straw where a wood turns gold,
   * and the terrain shader ships that way already — this is for tuning it
   * without dragging every tree along, which is what setting `foliage` alone
   * would do.
   *
   * @example
   * world.setSeasons({ terrainFoliage: { autumn: 0xc9b070, strength: 0.8 } });
   */
  terrainFoliage?: FoliageTintOptions;
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

  /**
   * Typed world events — pointer/cell interaction, the frame tick, chunk
   * streaming, and (after {@link trackUnits}) unit movement. Subscribing beats
   * wiring raycasts and callbacks by hand, and unlike the single-slot
   * `onFrame` / `onCellEnter` hooks any number of systems can listen.
   *
   * ```ts
   * world.events.on('cellClick', ({ col, row, button }) => {
   *   if (button === 0) select(col, row);
   * });
   * const off = world.events.on('cellHover', ({ cell }) => showTooltip(cell));
   * off();   // unsubscribe
   * ```
   *
   * {@link dispose} drops every listener before tearing anything down, so no
   * events fire against a half-disposed world.
   */
  readonly events = new Emitter<HexWorldEventMap>();

  private _map: HexMap;
  private _liquidDescriptors: LiquidTypeDescriptor[];
  private liquidMaterials: Map<string, LiquidMaterialSet>;
  private terrainMaterial: THREE.ShaderMaterial;
  /** Last hex-grid styling from setHexGrid — null until first use. */
  private gridOptions: TerrainGridOptions | null = null;
  /** Last cliff-strata styling from setCliffStrata — null until first use (the material's own defaults stand). */
  private strataOptions: CliffStrataOptions | null = null;
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
  /** Pixels of drag still counted as a click rather than a camera pan. */
  private readonly clickTolerance: number;
  /** The in-flight press, until it resolves into a click or is disqualified as a drag. */
  private pressed: { x: number; y: number; button: number; cell: CellRef | null } | null = null;
  /** Subscriptions this world made on other emitters (chunks, tracked unit managers). */
  private readonly forwarders: Unsubscribe[] = [];

  private readonly onPointerDown = (e: PointerEvent) => {
    // A tap has no preceding pointermove, so the frame loop's hover cell is
    // stale (or null) on touch — pick at the event's own position instead.
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    const cell = this.picker.pick(e.clientX, e.clientY);
    this.pressed = { x: e.clientX, y: e.clientY, button: e.button, cell };
    if (cell) {
      this.events.emit('cellPointerDown', { col: cell.col, row: cell.row, button: e.button, pointer: e });
    }
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    const press = this.pressed;
    this.pressed = null;
    if (!press || press.button !== e.button || !press.cell) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (dx * dx + dy * dy > this.clickTolerance * this.clickTolerance) return;
    this.events.emit('cellClick', {
      col: press.cell.col, row: press.cell.row, button: e.button, pointer: e,
    });
  };

  /** A cancelled pointer (gesture takeover, focus loss) is not a click. */
  private readonly onPointerCancel = () => { this.pressed = null; };

  private rafId: number | null = null;
  private lastFrameTime = 0;
  private hovered: { col: number; row: number } | null = null;
  /**
   * What the last hover pick was computed from. A pick raycasts every loaded
   * terrain chunk — several milliseconds against dense geometry — so it runs
   * only when one of these has changed: the pointer, the camera, the terrain
   * meshes, or the map itself.
   */
  private readonly hoverInputs = {
    mouseX: NaN, mouseY: NaN,
    camera: new THREE.Matrix4(), projection: new THREE.Matrix4(),
    geometry: -1,
    map: null as HexMap | null,
  };
  private _dayNight: DayNightCycle | null = null;
  private _weather: WeatherSystem | null = null;
  private _sky: SkyDome | null = null;
  private _godRays: GodRays | null = null;
  private _skirt: MapSkirt | null = null;
  private _seasons: SeasonCycle | null = null;
  /**
   * The world's one wind. Built eagerly and shared with the
   * {@link WeatherSystem} whenever that is created, so the two can never
   * disagree about which way the weather is going regardless of the order they
   * are switched on in. Inert — and not even advanced — until
   * {@link setWind}.
   */
  private readonly _wind = new Wind();
  private windEnabled = false;
  private _climate: ClimateData | null = null;
  /** True only when this world built the climate itself, and so may dispose it. */
  private ownsClimate = false;
  private seasonOptions: HexWorldSeasonOptions = {};
  private seasonApplyAccum = 0;
  private _territory: TerritoryLayer | null = null;
  private _resources: ResourceLayer | null = null;
  /** Kept so gameplay layers built later can share the world's fog. */
  private _fogData: FogData | null;
  /** Last sky styling, so a terrain swap can rebuild the dome's biome tint. */
  private skyOptions: SkyDomeOptions | null = null;
  /**
   * Kept so the sky's distance haze, the day/night light, and the cloud
   * shadows all reach the road overlay too. Built in the constructor, once the
   * terrain's light options are known, so the decal matches the ground.
   */
  private readonly roadMaterial: THREE.ShaderMaterial;
  /** Scatter definitions this world streams, so their materials can be hazed too. */
  private readonly scatterDefinitions: ScatterDefinition[];
  /** Kept so a skirt built later matches the terrain's perturbation exactly. */
  private readonly geometryOptions: ChunkGeometryOptions | undefined;
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
  /**
   * The world's shared wind — the one vector behind cloud drift, rain slant,
   * plant sway, and the ripples marching across open water. Always present, so
   * it can be configured before or after anything that reads it; switch it on
   * with {@link setWind}.
   *
   * `world.wind.base` is the same `THREE.Vector2` as `world.weather.wind`.
   */
  get wind(): Wind { return this._wind; }
  /** The sky dome, if enabled via the `sky` option or {@link setSky}. */
  get sky(): SkyDome | null { return this._sky; }
  /** The god-ray pass, if enabled via the `godRays` option or {@link setGodRays}. */
  get godRays(): GodRays | null { return this._godRays; }
  /** The map skirt, if enabled via the `skirt` option or {@link setSkirt}. */
  get skirt(): MapSkirt | null { return this._skirt; }
  /** The season cycle, if enabled via the `seasons` option or {@link setSeasons}. */
  get seasons(): SeasonCycle | null { return this._seasons; }
  /**
   * Per-cell climate once seasons are on — the same bytes the shaders sample,
   * so `climate.snowDepth(col, row)` is exactly what the player can see.
   */
  get climate(): ClimateData | null { return this._climate; }
  /** The fog-of-war state this world renders with, if the `fogData` option was set. */
  get fog(): FogData | null { return this._fogData; }
  /** The territory layer, once {@link setFactions} has been called. */
  get territory(): TerritoryLayer | null { return this._territory; }
  /** The resource layer, once {@link setResourceTypes} has been called. */
  get resources(): ResourceLayer | null { return this._resources; }

  /** True if the terrain index belongs to any liquid type. */
  isWater = (terrain: number): boolean => this.waterTerrainSet.has(terrain);

  private constructor(opts: HexWorldOptions, prepared: {
    terrainMaterial: THREE.ShaderMaterial;
    terrainDefinitions: TerrainDefinition[];
  }) {
    this.container = opts.container;
    this.clickTolerance = opts.clickTolerance ?? 5;
    this.skyFollowsCycle = opts.background !== null;
    this.scatterDefinitions = opts.scatterDefinitions ?? [];
    this._fogData = opts.fogData ?? null;
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
    this.roadMaterial         = createRoadMaterial(this.terrainMaterialOptions);
    this.terrainMaterial      = prepared.terrainMaterial;
    this._terrainDefinitions  = prepared.terrainDefinitions;
    this._terrainLookup       = buildTerrainLookup(this._terrainDefinitions);
    this.waterTerrainSet      = buildWaterTerrainSet(this._terrainDefinitions);

    this._liquidDescriptors = opts.liquidDescriptors ?? DEFAULT_LIQUID_DESCRIPTORS;
    this.liquidMaterials    = opts.liquidMaterials
      ?? new Map(this._liquidDescriptors.map(d => [d.id, resolveLiquidMaterials(d)]));

    this.geometryOptions = opts.geometryOptions;
    this.chunks = new ChunkManager({
      map:                  this._map,
      layout:               this.layout,
      scene:                this.scene,
      material:             this.terrainMaterial,
      liquidMaterials:      this.liquidMaterials,
      liquidDescriptors:    this._liquidDescriptors,
      roadMaterial:         this.roadMaterial,
      terrainDefinitions:   this._terrainDefinitions,
      chunkSize:            opts.chunkSize  ?? 32,
      loadRadius:           opts.loadRadius ?? 5,
      geometryOptions:      this.geometryOptions,
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
      ...(cam.initialYaw   !== undefined ? { initialYaw:   cam.initialYaw   } : {}),
      ...(cam.tiltSpeed    !== undefined ? { tiltSpeed:    cam.tiltSpeed    } : {}),
      ...(cam.yawSpeed     !== undefined ? { yawSpeed:     cam.yawSpeed     } : {}),
      // 6°, not the old 30°: above ~22° (half the default vertical FOV) the
      // horizon never enters the frame at all, which silently made the sky
      // dome's best hours and the god rays impossible to look at.
      minPitch:        cam.minPitch    ?? 6,
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
    // Canvas-scoped: a press that begins on surrounding UI is that UI's, and a
    // release outside the canvas after a drag was never a click anyway.
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown',   this.onPointerDown);
    canvas.addEventListener('pointerup',     this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);

    // One subscription point for the whole world: chunk streaming events reach
    // `world.events` without the consumer having to know about `world.chunks`.
    this.forwarders.push(
      this.chunks.events.on('chunkLoaded',   e => this.events.emit('chunkLoaded', e)),
      this.chunks.events.on('chunkUnloaded', e => this.events.emit('chunkUnloaded', e)),
    );

    // The sky is built before the first applyDayNight so it takes the opening
    // time of day rather than a frame of default blue. The rays follow it, so
    // they find the dome to take their overcast from.
    // Before the sky, so the dome's first haze pass already includes the wall.
    if (opts.skirt) this.setSkirt(typeof opts.skirt === 'object' ? opts.skirt : {});
    if (opts.sky) this.setSky(typeof opts.sky === 'object' ? opts.sky : {});
    if (opts.godRays) this.setGodRays(typeof opts.godRays === 'object' ? opts.godRays : {});

    if (opts.dayNight) {
      this._dayNight = new DayNightCycle(typeof opts.dayNight === 'object' ? opts.dayNight : {});
      this.applyDayNight();
    }

    // After the day clock, so the season cycle can inherit its dayLength.
    if (opts.seasons) this.setSeasons(typeof opts.seasons === 'object' ? opts.seasons : {});

    if (opts.wind) this.setWind(typeof opts.wind === 'object' ? opts.wind : {});

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
      this.advanceSeasons(dt);
      // Ahead of the weather, so the cloud drift and the rain slant this frame
      // are the gust the trees are already bending to. Advanced unconditionally
      // — it is two dozen scalar ops, and it is what makes a shower gust
      // whether or not anything on the ground has been wired up to answer it.
      // `setWind` gates only the push out to the materials.
      this._wind.advance(dt);
      if (this.windEnabled) this.applyWind();
      this._sky?.update(this.camera, dt);
      this._weather?.update(dt, this.controls.targetPosition);
      this.sunShadows?.update(this.camera);
      this.chunks.update(this.camera, dt);
      // No-ops unless a claim/placement changed since the last frame.
      this._territory?.update();
      this._resources?.update();
      this.updateHover();
      this.onFrame?.(dt);
      this.events.emit('frame', { dt });
      this.renderer.render(this.scene, this.camera);
      if (this._godRays) {
        // With a dome the rays read overcast off it; without one nothing else
        // is carrying the weather to them.
        if (!this._sky && this._weather) this._godRays.setOvercast(this._weather.overcast);
        this._godRays.render(this.renderer, this.scene, this.camera);
      }
    };
    tick();
  }

  /**
   * Re-pick under the cursor and turn the change into events. The picker
   * returns a fresh object per pick, so cells are compared by value — identity
   * would report a change every frame.
   */
  private updateHover(): void {
    const inputs = this.hoverInputs;
    const changed =
      inputs.mouseX !== this.mouseX || inputs.mouseY !== this.mouseY ||
      inputs.geometry !== this.chunks.geometryRevision ||
      inputs.map !== this._map ||
      !inputs.camera.equals(this.camera.matrixWorld) ||
      !inputs.projection.equals(this.camera.projectionMatrix);
    // While the picker is holding a cell over a miss, keep picking so the
    // hold runs out on schedule instead of freezing until the next move.
    if (!changed && !this.picker.holding) return;
    inputs.mouseX = this.mouseX;
    inputs.mouseY = this.mouseY;
    inputs.geometry = this.chunks.geometryRevision;
    inputs.map = this._map;
    inputs.camera.copy(this.camera.matrixWorld);
    inputs.projection.copy(this.camera.projectionMatrix);

    const previous = this.hovered;
    const cell = this.picker.pick(this.mouseX, this.mouseY);
    this.hovered = cell;

    if (previous?.col === cell?.col && previous?.row === cell?.row) return;

    // Leave before enter, so a highlight handler can clear the old cell and
    // paint the new one in that order without tracking the previous itself.
    if (previous) this.events.emit('cellLeave', { col: previous.col, row: previous.row });
    if (cell)     this.events.emit('cellEnter', { col: cell.col, row: cell.row });
    this.events.emit('cellHover', { cell, previous });
  }

  /**
   * Re-emit a {@link UnitManager}'s events through {@link events}, so unit
   * movement arrives alongside cell and chunk events instead of on a second
   * emitter the rest of the game has to know about. Returns an unsubscribe
   * function; {@link dispose} also drops every forward this world set up.
   *
   * `HexWorld` does not own the manager — construct it as usual and hand it
   * over:
   *
   * ```ts
   * const units = new UnitManager({ scene: world.scene, map: world.map, layout: world.layout, fogData: world.fog ?? undefined });
   * world.trackUnits(units);
   * world.events.on('unitArrived', ({ unit }) => endTurn(unit));
   * ```
   */
  trackUnits(manager: UnitManager): Unsubscribe {
    const types = [
      'unitAdded', 'unitRemoved', 'unitMoveStart', 'unitCellEnter', 'unitArrived', 'unitMoveEnd',
    ] as const;
    const offs = types.map(type =>
      // Each `type` is a literal here, so the payload types line up per event.
      manager.events.on(type, (payload) => { this.events.emit(type, payload as never); }),
    );
    const off = (): void => { for (const o of offs) o(); };
    this.forwarders.push(off);
    return off;
  }

  /** Stop the render loop (state is kept; call start() to resume). */
  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  /** Swap in a different map; chunks rebuild, climate re-derives, camera recenters. */
  setMap(map: HexMap): void {
    this.chunks.setMap(map);
    this._map = map;
    // The wall is cut to one map's edges and floored under its lowest ground —
    // both change with the map, so it is rebuilt rather than carried over.
    this._skirt?.setMap(map);
    this.picker.reset();
    this.controls.snapTo(map.width / 2, map.height / 2);
    // Territory and resources live in the new map's metadata channel — redraw
    // from it rather than leaving the old map's borders and icons on screen.
    this._territory?.refresh();
    this._resources?.refresh();
    // Climate belongs to the map it was computed from, in both its values and
    // its dimensions — see refreshClimateForMap.
    this.refreshClimateForMap();
    // After the layers refresh, so a listener that reads them sees the new map's
    // borders and icons rather than the outgoing map's.
    this.events.emit('mapChanged', { map });
  }

  /**
   * Re-derive the climate for the current map, and re-point everything reading
   * it. No-op unless seasons are running.
   *
   * A climate is not merely *about* a map, it is shaped like one: temperature
   * comes from that map's latitudes and elevations, and the texture is sized to
   * its cell count. Carry one across a map swap and it isn't stale so much as
   * misaddressed — every `cellIndex` lookup lands somewhere arbitrary in the old
   * map's field, which is why a summer map can come up buried in snow. The
   * precipitation mask goes the same way, since it maps the texture onto a world
   * rect that just changed size.
   *
   * A caller-supplied climate is left alone — it's theirs, and silently
   * replacing it would throw away campaign snow. If it no longer fits the map,
   * say so rather than rendering nonsense.
   */
  private refreshClimateForMap(): void {
    if (!this._seasons || !this._climate) return;

    if (!this.ownsClimate) {
      if (this._climate.width !== this._map.width || this._climate.height !== this._map.height) {
        console.warn(
          `HexWorld.setMap: the ClimateData you supplied is ${this._climate.width}×${this._climate.height} ` +
          `but the new map is ${this._map.width}×${this._map.height}. Seasons will read the wrong cells ` +
          `until you call setSeasons() with a climate built for this map.`,
        );
      }
      return;
    }

    this.releaseClimate();
    this._climate    = ClimateData.fromMap(this._map, this.seasonOptions.temperature ?? {});
    this.ownsClimate = true;

    this.applySeasonMaterials();
    this.refreshPrecipitationMask();
    // Paint the current phase straight away rather than leaving a bare map
    // until the next apply interval elapses.
    this._seasons.apply(this._climate);
    this._climate.update();
    this.seasonApplyAccum = 0;
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
    this.reapplyCliffStrata();
    this._weather?.setTerrainMaterial(this.terrainMaterial);
    this.applyDayNight();
    this.refreshSky();
    this.applySeasonMaterials();
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
    this.reapplyCliffStrata();
    this._weather?.setTerrainMaterial(material);
    this.applyDayNight();
    this.refreshSky();
    this.applySeasonMaterials();
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
   * Toggle or restyle the sedimentary bedding the terrain shader draws on bare
   * rock — horizontal layers picking out every cliff face, terrace and carved
   * channel side. On by default; `false` turns it off, an options object
   * restyles (and enables unless `enabled: false`). Survives terrain material
   * swaps.
   *
   * @example
   * world.setCliffStrata({ scale: 5, seam: 0.3 });  // finer, sharper beds
   * world.setCliffStrata(false);
   */
  setCliffStrata(options: CliffStrataOptions | boolean = true): void {
    if (typeof options === 'boolean') {
      this.strataOptions = { ...this.strataOptions, enabled: options };
    } else {
      this.strataOptions = { ...this.strataOptions, ...options, enabled: options.enabled ?? true };
    }
    this.reapplyCliffStrata();
  }

  /** Strata styling survives terrain material swaps — re-push it onto the current material. */
  private reapplyCliffStrata(): void {
    if (!this.strataOptions) return;
    configureCliffStrata(this.terrainMaterial, this.strataOptions);
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
    for (const mat of [this.terrainMaterial, this.roadMaterial]) {
      const u = mat.uniforms;
      if (u && 'uLightDir' in u) u.uLightDir.value.copy(dirTowardSun).normalize();
    }
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
      roadMaterial:    this.roadMaterial,
      liquidMaterials: this.liquidMaterials.values(),
      scene:           this.skyFollowsCycle ? this.scene : undefined,
      sky:             this._sky ?? undefined,
      godRays:         this._godRays ?? undefined,
      // The skirt borrows the terrain's light uniforms, so it darkens at dusk
      // with the ground it holds up rather than glowing after dark.
      lightMaterials:  this._skirt ? [this._skirt.material] : undefined,
    });
  }

  /**
   * Every material the sky hazes into its horizon color: terrain, roads, each
   * liquid layer, and the scatter materials (which {@link setSky} runs through
   * `attachAtmosphere`, since stock three materials have no haze of their own).
   * Hand it to a SkyDome you build yourself, or to `configureAtmosphere` for
   * distance haze without a dome.
   */
  *hazeMaterials(): Generator<THREE.Material> {
    yield this.terrainMaterial;
    yield this.roadMaterial;
    // The wall stands at the very edge of the map — the first thing that has
    // to dissolve into the horizon rather than ending against it.
    if (this._skirt) yield this._skirt.material;
    for (const set of this.liquidMaterials.values()) {
      for (const mat of liquidMaterialList(set)) if (mat) yield mat;
    }
    for (const mat of this.scatterMaterials()) yield mat;
  }

  /** Distinct materials across every scatter definition's tiers. */
  private *scatterMaterials(): Generator<THREE.Material> {
    const seen = new Set<THREE.Material>();
    for (const def of this.scatterDefinitions) {
      for (const tier of def.tiers) {
        for (const part of tier) {
          if (!seen.has(part.material)) { seen.add(part.material); yield part.material; }
        }
      }
    }
  }

  /**
   * Enable, restyle, or (with `false`) remove the gradient sky dome and its
   * matching distance haze. Options accumulate across calls, and the dome
   * immediately picks up the current time of day and weather.
   *
   * `groundTint` defaults to the terrain palette's average color so the horizon
   * haze matches the biome — pass it explicitly to override. Scatter materials
   * are patched with the same shader haze so they recede with the terrain;
   * do the same for your own unit and prop materials with `attachAtmosphere`.
   *
   * @example
   * world.setSky(true);
   * world.setSky({ fog: { near: 40, far: 120 }, stars: false });
   * world.setSky(false);
   */
  setSky(options: SkyDomeOptions | boolean = true): SkyDome | null {
    this._sky?.dispose();
    this._sky = null;
    if (options === false) {
      this._weather?.setSky(null);
      this._godRays?.attachSky(null);
      return null;
    }
    if (typeof options === 'object') this.skyOptions = { ...this.skyOptions, ...options };
    else this.skyOptions ??= {};

    // Stock three materials fog in a different color space than the library's
    // shaders, so they get the library's haze injected instead of scene.fog.
    for (const mat of this.scatterMaterials()) attachAtmosphere(mat);

    this._sky = new SkyDome({
      groundTint: averageTerrainColor(this._terrainDefinitions),
      ...this.skyOptions,
      materials:  this.skyOptions.materials ?? (() => this.hazeMaterials()),
    }).addTo(this.scene);
    this._sky.update(this.camera);
    this._weather?.setSky(this._sky);
    this._godRays?.attachSky(this._sky);
    this.applyDayNight();
    return this._sky;
  }

  /**
   * Enable, restyle, or (with `false`) remove the crepuscular rays — shafts of
   * light fanning out from the sun wherever the terrain breaks its edge.
   *
   * They cost one extra render of the scene per frame at a quarter of the
   * canvas resolution, with every material replaced by flat black, and only
   * while the sun is up, in front of the camera, and not buried under cloud —
   * outside that the pass is skipped and costs nothing at all. `decay` is the
   * knob to reach for first: it sets how far the shafts throw.
   *
   * With a sky dome present the rays take their overcast from it, so weather
   * puts out the shafts and the sun disc together, and the dome itself is kept
   * out of the occlusion pass.
   *
   * @example
   * world.setGodRays(true);
   * world.setGodRays({ intensity: 0.8, decay: 0.96 }); // long, strong shafts
   * world.setGodRays(false);
   */
  /**
   * Enable, restyle, or (with `false`) remove the map skirt — the wall of cut
   * earth that gives the map a bottom and four sides instead of ending where
   * its triangles stop.
   *
   * The geometry options that have to agree with the terrain
   * (`perturbStrength`, `noiseScale`, `elevationScale`,
   * `elevPerturbStrength`) are taken from the world's own `geometryOptions`
   * unless you override them — pass them by hand only if you are also building
   * terrain by hand, since a mismatch tears the seam along the entire edge.
   *
   * @example
   * world.setSkirt(true);
   * world.setSkirt({ depth: 4, bandScale: 2.4 });  // deeper block, finer strata
   * world.setSkirt(false);
   */
  setSkirt(options: MapSkirtMeshOptions | boolean = true): MapSkirt | null {
    if (options === false) {
      this._skirt?.dispose();
      this._skirt = null;
      this.refreshSky(); // drop it from the hazed material list
      return null;
    }
    const opts = typeof options === 'object' ? options : {};
    if (this._skirt) {
      this._skirt.configure(opts);
      return this._skirt;
    }
    const geo = this.skirtGeometryOptions;
    this._skirt = new MapSkirt(this._map, this.layout, { ...geo, ...opts }).addTo(this.scene);
    // Picked up by the sky's material list and the day/night light, so the
    // wall hazes and darkens with the ground above it from the first frame.
    this.refreshSky();
    this.applyDayNight();
    return this._skirt;
  }

  /** The subset of the world's chunk geometry options the skirt must match. */
  private get skirtGeometryOptions(): MapSkirtMeshOptions {
    const g = this.geometryOptions ?? {};
    return {
      ...(g.elevationScale      !== undefined ? { elevationScale:      g.elevationScale } : {}),
      ...(g.perturbStrength     !== undefined ? { perturbStrength:     g.perturbStrength } : {}),
      ...(g.elevPerturbStrength !== undefined ? { elevPerturbStrength: g.elevPerturbStrength } : {}),
      ...(g.noiseScale          !== undefined ? { noiseScale:          g.noiseScale } : {}),
    };
  }

  setGodRays(options: GodRaysOptions | boolean = true): GodRays | null {
    if (options === false) {
      this._godRays?.dispose();
      this._godRays = null;
      return null;
    }
    const opts = typeof options === 'object' ? options : {};
    if (this._godRays) {
      this._godRays.configure(opts);
      return this._godRays;
    }
    this._godRays = new GodRays({ ...opts, sky: opts.sky !== undefined ? opts.sky : this._sky });
    // Without a cycle driving it there is no sun to follow, so it takes the
    // static default light — the same direction the terrain is lit from.
    if (this._dayNight) this.applyDayNight();
    else this._godRays.setSun(DEFAULT_LIGHT_DIR);
    return this._godRays;
  }

  /**
   * Every material that renders seasonal snow or ice: terrain, each liquid
   * layer, and the scatter materials (which {@link setSeasons} runs through
   * {@link attachSnow}, since stock three materials have no snow of their own).
   *
   * Roads are deliberately absent — a road under snow is a road you can't see,
   * and hiding the network the player routes on is worse than the realism is
   * worth. Hand your own prop materials to `attachSnow` if you want them white.
   *
   * The seasonal *foliage tint* is not attached here either, and that is the
   * point: whether a plant turns in autumn is what tells a broadleaf from a
   * pine. Call `attachSeasonalTint` on the scatter materials that should turn —
   * before or after `setSeasons`, since both effects share one climate binding.
   */
  *seasonMaterials(): Generator<THREE.Material> {
    yield this.terrainMaterial;
    for (const set of this.liquidMaterials.values()) {
      for (const mat of liquidMaterialList(set)) if (mat) yield mat;
    }
    for (const mat of this.scatterMaterials()) yield mat;
  }

  /**
   * Enable, restyle, or (with `false`) remove seasons: a year clock, snow that
   * accumulates and melts, and liquids that freeze at their own
   * `freezePoint`. Options accumulate across calls.
   *
   * Supply `climate` when the map was generated with a `climateData` sink —
   * that field is the one the biomes were assigned from. Without it the base
   * temperature is rebuilt via {@link ClimateData.fromMap}, which matches only
   * if you pass the same `temperature` options the generator used.
   *
   * The cycle advances with the day clock and re-applies every
   * {@link HexWorldSeasonOptions.applyInterval} seconds; scrub it directly with
   * {@link setSeason}.
   *
   * @example
   * // Generated map: hand over the field the biomes came from.
   * const climate = new ClimateData(map.width, map.height);
   * generateMap(map, { climateData: climate }, seed);
   * world.setSeasons({ daysPerYear: 8 }, climate);
   *
   * @example
   * world.setSeasons({ noise: 0.2, snowThreshold: 0.3 }); // restyle
   * world.setSeasons(false);                              // off
   *
   * @example
   * // Grass and any tinted scatter turn through the year; tune the palette.
   * world.setSeasons({ foliage: { autumn: 0xd2601a, bareTemp: 0.3 } });
   */
  setSeasons(
    options: HexWorldSeasonOptions | boolean = true,
    climate?: ClimateData,
  ): SeasonCycle | null {
    if (options === false) {
      this._seasons = null;
      for (const mat of this.seasonMaterials()) configureSeason(mat, null);
      this._weather?.setPrecipitationMask(null);
      this.releaseClimate();
      return null;
    }
    // Read before the merge: only a phase given in *this* call is an
    // instruction to jump the year. One left over in the accumulated options
    // from some earlier call is not.
    const explicit = typeof options === 'object' ? options : {};
    if (typeof options === 'object') this.seasonOptions = { ...this.seasonOptions, ...options };

    if (climate && this._climate !== climate) {
      // A caller-supplied climate is theirs to keep — only ours gets freed.
      this.releaseClimate();
      this._climate = climate;
      this.ownsClimate = false;
    }
    if (!this._climate) {
      this._climate = ClimateData.fromMap(this._map, this.seasonOptions.temperature ?? {});
      this.ownsClimate = true;
    }

    // Restyling rebuilds the cycle, so carry its live state across. Where it is
    // in the year and whether it's running are things the world is *doing*, not
    // configuration — changing the snow colour or the map scope shouldn't rewind
    // the calendar to spring or start a paused year moving.
    const running = this._seasons;
    // Match the day clock unless told otherwise, so one turn of the sun is one
    // day of the year rather than two clocks drifting apart.
    this._seasons = new SeasonCycle({
      dayLength: this._dayNight?.dayLength,
      ...this.seasonOptions,
      phase:       explicit.phase       ?? running?.phase       ?? this.seasonOptions.phase,
      paused:      explicit.paused      ?? running?.paused      ?? this.seasonOptions.paused,
      // Mutable on the cycle, so the live value can have moved on from whatever
      // the options last said.
      daysPerYear: explicit.daysPerYear ?? running?.daysPerYear ?? this.seasonOptions.daysPerYear,
    });

    // Stock three materials have no snow path of their own, so inject one.
    for (const mat of this.scatterMaterials()) attachSnow(mat);
    this.applySeasonMaterials();
    this.refreshPrecipitationMask();

    // Paint the opening season immediately rather than showing a bare summer
    // map until the first interval elapses.
    this._seasons.apply(this._climate);
    this._climate.update();
    this.seasonApplyAccum = 0;
    return this._seasons;
  }

  /**
   * Jump the year clock and repaint immediately — the turn-based entry point
   * ("day 214 of the migration"). Creates a paused cycle if the `seasons`
   * option wasn't set, so a game that drives its own calendar never needs the
   * real-time clock at all.
   */
  setSeason(phase: number): void {
    if (!this._seasons) {
      this.setSeasons({ paused: true });
    }
    this._seasons!.setPhase(phase);
    if (this._climate) {
      this._seasons!.apply(this._climate);
      this._climate.update();
    }
    this.applySeasonPhase();
    this.seasonApplyAccum = 0;
  }

  /**
   * Advance the year and repaint the climate texture, throttled to
   * `applyInterval`. The pass touches every cell, so running it per frame on a
   * continent map would cost far more than snow that moves this slowly is
   * worth; the accumulated dt is handed on so the melt rate stays wall-clock
   * accurate regardless of the interval.
   */
  private advanceSeasons(dt: number): void {
    if (!this._seasons || !this._climate) return;
    if (!this._seasons.paused) this._seasons.advance(dt);

    this.seasonApplyAccum += dt;
    const interval = this.seasonOptions.applyInterval ?? 0.25;
    if (this.seasonApplyAccum < interval) return;

    this._seasons.apply(this._climate, this.seasonApplyAccum);
    this._climate.update();
    this.applySeasonPhase();
    this.seasonApplyAccum = 0;
  }

  /** Drop the current climate, disposing it only if this world created it. */
  private releaseClimate(): void {
    if (this.ownsClimate) this._climate?.dispose();
    this._climate = null;
    this.ownsClimate = false;
  }

  /** Point every season-aware material at the current climate and styling. */
  private applySeasonMaterials(): void {
    if (!this._climate) return;
    const snowTerrain = resolveSnowTerrain(this._terrainDefinitions);
    // The foliage palette is applied relative to each surface's own summer
    // green, so the terrain's reference comes from the pack while a scatter
    // material keeps whatever `attachSeasonalTint` read off its own color. An
    // explicit option still wins for both.
    //
    // Precedence runs material default → `foliage` (everything that turns) →
    // `terrainFoliage` (the ground alone), so the terrain shader's straw autumn
    // survives unless something actually asks otherwise.
    const terrainFoliage = {
      summer: resolveFoliageColor(this._terrainDefinitions),
      ...this.seasonOptions.foliage,
      ...this.seasonOptions.terrainFoliage,
    };
    for (const mat of this.seasonMaterials()) {
      const foliage = mat === this.terrainMaterial ? terrainFoliage : this.seasonOptions.foliage;
      configureSeason(mat, this._climate, { ...this.seasonOptions, snowTerrain, foliage });
    }
    this.applySeasonPhase();
  }

  /**
   * Tell every seasonal material which way the year is going — the one input
   * the foliage tint cannot read out of the climate texture, because spring and
   * autumn pass through identical temperatures in opposite directions.
   */
  private applySeasonPhase(): void {
    if (!this._seasons) return;
    const phase = this._seasons.phase;
    for (const mat of this.seasonMaterials()) setSeasonPhase(mat, phase);
  }

  /**
   * Gate precipitation on the snow channel: snow falls where snow is lying,
   * rain everywhere else. Complementary by construction, so no hex gets both.
   */
  private refreshPrecipitationMask(): void {
    if (!this._weather || !this._climate) return;
    this._weather.setPrecipitationMask(this._climate.texture, this.mapWorldRect());
  }

  /**
   * World-space span of the whole map — the rect a map-sized data texture maps
   * onto. Derived from the four corner cells and padded by a hex, so the odd-row
   * stagger stays inside it.
   */
  private mapWorldRect(): { x: number; z: number; width: number; depth: number } {
    const w = this._map.width, h = this._map.height;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [col, row] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]] as const) {
      const p = hexToWorld(this.layout, offsetToHex(col, row));
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    const pad = this.layout.size;
    return {
      x:     minX - pad,
      z:     minZ - pad,
      width: (maxX - minX) + pad * 2,
      depth: (maxZ - minZ) + pad * 2,
    };
  }

  /**
   * Re-point the sky at swapped materials and re-derive its biome tint from
   * the current terrain palette. Called for you on every terrain/liquid swap.
   */
  private refreshSky(): void {
    if (!this._sky) return;
    if (this.skyOptions?.groundTint === undefined) {
      this._sky.setGroundTint(averageTerrainColor(this._terrainDefinitions));
    }
    this._sky.refresh();
  }

  /**
   * Set the weather: drifting cloud shadows on the terrain plus a matching
   * rain/snow layer that falls under the denser clouds and follows the
   * camera (world-anchored — panning doesn't drag the rain). Creates the
   * WeatherSystem on first use; returns it for fine-grained control
   * (intensity ramps, wind changes).
   *
   * `'clear'` means no precipitation, not an empty sky: it keeps scattered
   * fair-weather cloud shadows drifting over the ground. Pass
   * `{ clouds: false }` for a cloudless one.
   *
   * @example
   * world.setWeather('rain');
   * world.setWeather('snow', { intensity: 0.6 });
   * world.setWeather('clear');                  // sun and drifting cloud shadows
   * world.setWeather('clear', { clouds: false }); // nothing in the sky at all
   */
  setWeather(type: WeatherType, options: WeatherOptions = {}): WeatherSystem {
    this._weather ??= new WeatherSystem({
      scene:           this.scene,
      terrainMaterial: this.terrainMaterial,
      roadMaterial:    this.roadMaterial,
      liquidMaterials: () => this.liquidMaterials.values(),
      sky:             this._sky,
      // The world's wind, not one of its own — so `setWind` and `setWeather`
      // compose in either order, and the rain slants the way the trees lean.
      // Ownership stays here: this world advances it, so the weather must not.
      wind:            this._wind,
    });
    // Re-pushed here, not just from setSeasons, so the order the two are
    // enabled in doesn't matter — weather created after seasons still gets the
    // climate gate, and setWeather's rebuilt particle layer keeps it.
    this.refreshPrecipitationMask();
    this._weather.setWeather(type, options);
    return this._weather;
  }

  /**
   * Every material the wind can move: each liquid layer, and the scatter
   * materials. Materials that carry none of the wind uniforms are skipped by
   * {@link setMaterialWind}, so this can be handed out whole.
   *
   * The terrain is absent because a hillside does not move, and the road with
   * it. What lives here is water — which drifts and roughens — and whichever
   * plants have been given {@link attachWindSway}.
   */
  *windMaterials(): Generator<THREE.Material> {
    for (const set of this.liquidMaterials.values()) {
      for (const mat of liquidMaterialList(set)) if (mat) yield mat;
    }
    for (const mat of this.scatterMaterials()) yield mat;
  }

  /**
   * Enable, restyle, or (with `false`) still the world's wind: one vector that
   * drifts the cloud deck, slants the rain, bends the plants, and marches the
   * ripples across open water. Options accumulate across calls; returns the
   * shared {@link Wind} for direct control (`world.wind.setPolar(…)` mid-storm).
   *
   * **Which plants bend is yours to say.** This drives every material that
   * carries {@link attachWindSway} and attaches the patch to none of them — the
   * same division as the seasonal foliage tint, and for the same reason: that a
   * hedge answers the wind and a boulder does not is a fact about your scatter,
   * not about the renderer. Water needs no such call; every liquid material
   * already carries the uniforms and sits at zero until this is switched on.
   *
   * The wind itself exists and advances from the first frame either way, which
   * is why a shower gusts before anything on the ground is wired up to it.
   *
   * @example
   * attachWindSway(broadleafMat, { height: 1.9 });
   * attachWindSway(bushMat, { height: 0.5, stiffness: 1.2, amplitude: 0.16 });
   * world.setWind({ heading: Math.PI * 0.25, speed: 4 });
   *
   * @example
   * world.setWind({ gustiness: 0.7, gustPeriod: 4 });  // squally
   * world.setWind(false);                              // dead calm
   */
  setWind(options: WindOptions | boolean = true): Wind {
    if (options === false) {
      this.windEnabled = false;
      // Push the stilling out once rather than leaving every material holding
      // the last frame's gust — a plant frozen mid-lean is worse than no wind.
      setMaterialWind(this.windMaterials(), null);
      return this._wind;
    }
    if (typeof options === 'object') this._wind.configure(options);
    this.windEnabled = true;
    this.applyWind();
    return this._wind;
  }

  /** Push the current wind onto everything that answers it. */
  private applyWind(): void {
    setMaterialWind(this.windMaterials(), this._wind);
  }

  /**
   * Set the faction roster and start drawing per-cell ownership: translucent
   * faction tints with an outline around each faction's holdings. Creates the
   * {@link TerritoryLayer} on first use and returns it for the claim/release
   * calls; later calls just re-colour with the new roster.
   *
   * Ownership is stored in the map's metadata channel, so it serializes with
   * the map — no companion file, and `world.map` round-trips through
   * `serializeMapJSON` with the borders intact.
   *
   * @example
   * const territory = world.setFactions([
   *   { id: 'red',  name: 'Kelmar',  color: 0xdd4433 },
   *   { id: 'blue', name: 'Ossiran', color: 0x3377dd },
   * ]);
   * territory.claim(10, 10, 'red');
   */
  setFactions(factions: FactionDescriptor[], options: Partial<TerritoryLayerOptions> = {}): TerritoryLayer {
    if (this._territory) {
      this._territory.setFactions(factions);
      return this._territory;
    }
    this._territory = new TerritoryLayer({
      overlays: this.overlays,
      map:      () => this._map,
      ...options,
      factions,
    });
    return this._territory;
  }

  /**
   * Set the resource types and start drawing per-cell deposits as instanced
   * camera-facing icons — one draw call per type. Creates the
   * {@link ResourceLayer} on first use and returns it for placement calls;
   * later calls swap the type set.
   *
   * The world's fog (the `fogData` option) is wired in automatically, so icons
   * hide on unexplored cells and dim on remembered ones along with the ground
   * beneath them. Placement data lives in the map's metadata channel and
   * serializes with the map.
   *
   * @example
   * const resources = world.setResourceTypes(DEFAULT_RESOURCE_DESCRIPTORS);
   * generateResources(world.map, DEFAULT_RESOURCE_DESCRIPTORS, seed, { isWater: world.isWater });
   */
  setResourceTypes(
    descriptors: ResourceDescriptor[],
    icons?: ResourceIconRegistry,
    options: Partial<ResourceLayerOptions> = {},
  ): ResourceLayer {
    if (this._resources) {
      this._resources.setDescriptors(descriptors, icons);
      return this._resources;
    }
    this._resources = new ResourceLayer({
      parent:  this.scene,
      layout:  this.layout,
      map:     () => this._map,
      isWater: this.isWater,
      fogData: this._fogData ?? undefined,
      ...options,
      descriptors,
      ...(icons ? { icons } : {}),
    });
    return this._resources;
  }

  /**
   * Attach or detach fog of war at runtime, across every layer that reads it —
   * terrain, liquids, roads, scatter, and resource icons.
   */
  setFogData(fog: FogData | null): void {
    this._fogData = fog;
    this.chunks.setFogData(fog);
    this._resources?.setFogData(fog);
  }

  /**
   * Hide unexplored cells (the fog's memory tier boundary), across terrain and
   * resource icons alike. Independent of {@link setDimExplored}.
   */
  setHideUnexplored(enabled: boolean): void {
    this.chunks.setHideUnexplored(enabled);
    this._resources?.setHideUnexplored(enabled);
  }

  /**
   * Dim explored-but-not-currently-visible cells — the remembered tier's ghost
   * look — across terrain and resource icons alike.
   */
  setDimExplored(enabled: boolean): void {
    this.chunks.setDimExplored(enabled);
    this._resources?.setDimExplored(enabled);
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
    // current time of day, weather, and sky haze so they match the scene.
    this.applyDayNight();
    this._weather?.refresh();
    this.refreshSky();
    if (this.windEnabled) this.applyWind();
  }

  /** Stop the loop and free everything this world created. */
  dispose(): void {
    this.stop();
    // First: tearing down chunks fires `chunkUnloaded` for every loaded chunk,
    // and a listener has no way to tell that from ordinary streaming. Nothing
    // should be told about a world that is already half gone.
    this.events.removeAllListeners();
    for (const off of this.forwarders) off();
    this.forwarders.length = 0;

    window.removeEventListener('pointermove', this.onPointerMove);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown',   this.onPointerDown);
    canvas.removeEventListener('pointerup',     this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.resizeObserver.disconnect();
    this._resources?.dispose();
    this._territory?.dispose();
    this.overlays.dispose();
    this.chunks.dispose();
    this.controls.dispose();
    this._weather?.dispose();
    this._godRays?.dispose();
    this._skirt?.dispose();
    this._sky?.dispose();
    this.releaseClimate();
    this.sunShadows?.dispose();
    this.terrainMaterial.dispose();
    this.roadMaterial.dispose();
    for (const set of this.liquidMaterials.values()) {
      for (const m of liquidMaterialList(set)) m?.dispose();
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
