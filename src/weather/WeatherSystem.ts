import * as THREE from 'three';
import { configureTerrainClouds, setTerrainCloudsEnabled, type CloudShadowOptions } from './CloudShadows.js';
import { PrecipitationLayer, type PrecipitationOptions } from './Precipitation.js';
import { Wind } from './Wind.js';
import { liquidMaterialList, type LiquidMaterialSet } from '../geometry/LiquidTypes.js';

export type WeatherType = 'clear' | 'rain' | 'snow';

export interface WeatherOptions {
  /** Strength 0–1: scales particle density/opacity and cloud-shadow darkness. Default 1. */
  intensity?: number;
  /**
   * Sustained wind in world units/sec — drifts the clouds AND streaks/blows
   * the precipitation. Default (1.6, 0.9). Sets the shared {@link Wind}'s base
   * vector, so it reaches anything else that wind is driving.
   */
  wind?: THREE.Vector2;
  /**
   * Cloud shadows: `false` disables, `true`/omitted uses the per-type preset,
   * an options object overrides the preset. Every type — `clear` included —
   * has shadows on by default; `clear` just gets scattered fair-weather cover
   * instead of a storm deck.
   */
  clouds?: boolean | CloudShadowOptions;
  /**
   * Fraction of ground actually being rained/snowed on, 0–1. Kept below the
   * clouds' coverage so lighter clouds shade the ground without precipitating
   * — only the denser cores rain. Default: 55% of the cloud coverage.
   * Set to 1 to decouple precipitation from the cloud field entirely.
   */
  precipCoverage?: number;
  /**
   * How grey the sky reads under this weather, 0–1, before `intensity` scales
   * it. Default: the per-type preset (0 clear, 0.85 rain, 0.7 snow). Only has
   * an effect once a {@link SkyDome} is wired up.
   */
  overcast?: number;
  /**
   * How much of the world wind the falling particles take, 0–1. Default 0.1.
   * @see WeatherSystem.windResponse
   */
  windResponse?: number;
  /** Overrides for the particle layer (count, fall speed, color, …). */
  precipitation?: Omit<PrecipitationOptions, 'type' | 'intensity' | 'wind'>;
}

/**
 * Per-type cloud presets: rain under heavy dark cover, snow under lighter,
 * broader cover, and clear under scattered fair-weather cumulus.
 *
 * "Clear" means no precipitation, not a cloudless sky — a fair day still has
 * a few soft shadows drifting across the ground, and it is the look most
 * scenes sit in most of the time. Pass `clouds: false` for a truly empty sky.
 */
const CLOUD_PRESETS: Record<WeatherType, Required<Pick<CloudShadowOptions, 'coverage' | 'opacity' | 'scale'>> & { enabled: boolean }> = {
  clear: { enabled: true,  coverage: 0.28, opacity: 0.35, scale: 38 },
  rain:  { enabled: true,  coverage: 0.6,  opacity: 0.6,  scale: 30 },
  snow:  { enabled: true,  coverage: 0.55, opacity: 0.45, scale: 42 },
};

/**
 * How grey the sky goes per weather type. Rain sits under a near-solid deck;
 * snow falls from a lighter, higher one. These are deliberately well above the
 * cloud-shadow coverage — the shadows are individual clouds crossing the
 * ground, while this is the whole hemisphere seen edge-on from below.
 */
const OVERCAST_PRESETS: Record<WeatherType, number> = { clear: 0, rain: 0.85, snow: 0.7 };

/**
 * The sky-side of a weather change — a {@link SkyDome}, or anything that takes
 * an overcast factor. Structural, so a custom sky needs no import from here.
 */
export interface OvercastTarget {
  setOvercast(overcast: number): void;
}

/**
 * One knob for the whole weather picture: drifting cloud shadows on the
 * terrain plus a matching precipitation layer, driven off a single wind and a
 * single world-space cloud field so rain visibly falls under the clouds that
 * shade the ground (and moves with them). Lighter clouds stay dry — see
 * {@link WeatherOptions.precipCoverage}. Give it a sky dome and it greys that
 * out too, so a storm doesn't fall out of a clear blue sky.
 *
 * The cloud drift offset is integrated on the CPU each update, so changing
 * wind mid-storm turns the field smoothly instead of teleporting it.
 *
 * @example
 * const weather = new WeatherSystem({ scene, terrainMaterial, sky });
 * weather.setWeather('rain');
 * // per frame:
 * weather.update(dt, controls.targetPosition);
 */
export class WeatherSystem {
  private readonly _wind: Wind;
  /** True when this system created its own wind and must therefore advance it. */
  private readonly ownsWind: boolean;

  /**
   * The sustained wind in world units/sec. Mutate freely — clouds turn
   * smoothly, because the drift offset is integrated rather than recomputed.
   *
   * This is {@link windField}'s `base` vector, so writing here is writing to
   * the shared wind the whole world reads.
   */
  get wind(): THREE.Vector2 { return this._wind.base; }

  /**
   * The full shared {@link Wind} — gusts, sway phase, water drift — of which
   * {@link wind} is the sustained vector. Hand the same one to a `HexWorld`
   * (or let it hand you one) and the trees bend to the weather that is falling
   * on them.
   */
  get windField(): Wind { return this._wind; }

  /**
   * How much of the world wind the falling particles take, 0–1. Default 0.1.
   *
   * Deliberately far below 1. The wind that bends a tree is measured against
   * the tree standing still, but rain is *already moving* — it is falling at
   * several times the wind's own speed, and it only spends a second or two in
   * the air. Handing the particles the full ground wind slants the fall as hard
   * as a gale and makes every gust visible as a lurch across the whole sky,
   * which reads as the camera moving rather than as weather. A tenth is enough
   * to see the rain lean the way the trees do without either of those.
   *
   * It scales the drift and the streak angle together, so raising it tilts the
   * fall and lengthens the sideways travel as one thing.
   */
  windResponse = 0.1;

  /** Reused scratch: the wind the particles actually get. */
  private readonly precipWind = new THREE.Vector2();

  private readonly scene: THREE.Object3D;
  private terrainMaterial: THREE.ShaderMaterial | null;
  private readonly roadMaterial: THREE.ShaderMaterial | null;
  private readonly liquidMaterials: (() => Iterable<LiquidMaterialSet>) | null;
  private readonly offset = new THREE.Vector2();
  private layer: PrecipitationLayer | null = null;
  private _type: WeatherType = 'clear';
  private _intensity = 1;
  private clouds = { ...CLOUD_PRESETS.clear };
  private precipCoverage = 0.33;
  private overcastBase = OVERCAST_PRESETS.clear;
  private sky: OvercastTarget | null;
  /** Kept here, not on the layer, because setWeather rebuilds the layer. */
  private mask: {
    texture: THREE.Texture;
    rect?: { x: number; z: number; width: number; depth: number };
  } | null = null;

  constructor(opts: {
    scene: THREE.Object3D;
    terrainMaterial?: THREE.ShaderMaterial | null;
    /**
     * Road overlay material, so a cloud passing overhead dims the road with
     * the ground it sits on rather than sliding over a bright ribbon.
     */
    roadMaterial?: THREE.ShaderMaterial | null;
    /** Sky dome to grey out under rain/snow. Also settable later via {@link setSky}. */
    sky?: OvercastTarget | null;
    /**
     * Provider for the liquid material sets so cloud shadows darken water in
     * step with the ground. A function (not a snapshot) so swapped liquid
     * materials are picked up — pass `() => world.liquidMaterials.values()`
     * style accessors.
     */
    liquidMaterials?: () => Iterable<LiquidMaterialSet>;
    /**
     * The world's shared {@link Wind}. Omit and this system keeps a private one
     * (and advances it itself); pass one — as `HexWorld` does — and the clouds
     * and rain answer the same wind that bends the trees.
     */
    wind?: Wind;
  }) {
    this._wind   = opts.wind ?? new Wind();
    this.ownsWind = !opts.wind;
    this.scene = opts.scene;
    this.terrainMaterial = opts.terrainMaterial ?? null;
    this.roadMaterial    = opts.roadMaterial ?? null;
    this.liquidMaterials = opts.liquidMaterials ?? null;
    this.sky             = opts.sky ?? null;
    // A fresh system already reports type 'clear' — push that state to the
    // materials so it is true on screen too, rather than leaving the scene
    // cloudless until the first setWeather call.
    this.applyClouds();
    this.sky?.setOvercast(this.overcast);
  }

  /** Every material that carries the shared cloud uniforms. */
  private *cloudMaterials(): Generator<THREE.ShaderMaterial> {
    if (this.terrainMaterial) yield this.terrainMaterial;
    if (this.roadMaterial) yield this.roadMaterial;
    if (!this.liquidMaterials) return;
    for (const set of this.liquidMaterials()) {
      for (const mat of liquidMaterialList(set)) {
        if (mat instanceof THREE.ShaderMaterial) yield mat;
      }
    }
  }

  get type(): WeatherType { return this._type; }
  get intensity(): number { return this._intensity; }
  /**
   * How grey the sky should read right now, 0–1 — the weather's contribution
   * to a {@link SkyDome}. Scales with intensity, so a storm ramping up greys
   * the sky as it comes in.
   */
  get overcast(): number { return this.overcastBase * this._intensity; }
  /** The current particle layer (null when clear) — for advanced tweaking. */
  get precipitation(): PrecipitationLayer | null { return this.layer; }

  /** Switch weather. Rebuilds the particle layer; cloud shadows re-style in place. */
  setWeather(type: WeatherType, opts: WeatherOptions = {}): void {
    this._type = type;
    if (opts.wind) this.wind.copy(opts.wind);
    if (opts.windResponse !== undefined) this.windResponse = Math.max(0, opts.windResponse);

    const preset = CLOUD_PRESETS[type];
    this.clouds = {
      enabled: opts.clouds === undefined ? preset.enabled : opts.clouds !== false,
      coverage: preset.coverage,
      opacity:  preset.opacity,
      scale:    preset.scale,
    };
    if (typeof opts.clouds === 'object') {
      if (opts.clouds.coverage !== undefined) this.clouds.coverage = opts.clouds.coverage;
      if (opts.clouds.opacity  !== undefined) this.clouds.opacity  = opts.clouds.opacity;
      if (opts.clouds.scale    !== undefined) this.clouds.scale    = opts.clouds.scale;
      if (opts.clouds.enabled  !== undefined) this.clouds.enabled  = opts.clouds.enabled;
    }
    this.precipCoverage = opts.precipCoverage ?? this.clouds.coverage * 0.55;
    this.overcastBase = opts.overcast ?? OVERCAST_PRESETS[type];

    this.layer?.dispose();
    this.layer = null;
    if (type !== 'clear') {
      this.layer = new PrecipitationLayer({
        ...opts.precipitation,
        type,
        wind: this.particleWind(),
      }).addTo(this.scene);
      // Gate particles by the cloud field only while the clouds exist and the
      // coverage leaves dry gaps (precipCoverage 1 = rain everywhere).
      this.layer.setCloudGate({
        enabled: this.clouds.enabled && this.precipCoverage < 1,
        offset:   this.offset,
        scale:    this.clouds.scale,
        coverage: this.precipCoverage,
      });
      this.applyPrecipitationMask();
    }

    this.applyClouds();
    this.setIntensity(opts.intensity ?? 1);
  }

  /** Ramp the current weather 0–1 (particles + cloud darkness + sky greying) — animate for smooth transitions. */
  setIntensity(intensity: number): void {
    this._intensity = THREE.MathUtils.clamp(intensity, 0, 1);
    this.layer?.setIntensity(this._intensity);
    this.applyClouds();
    this.sky?.setOvercast(this.overcast);
  }

  /**
   * Attach (or detach, with null) the sky dome this weather greys out. Every
   * later weather/intensity change pushes to it automatically.
   */
  setSky(sky: OvercastTarget | null): void {
    this.sky = sky;
    sky?.setOvercast(this.overcast);
  }

  /**
   * Gate precipitation on a per-cell mask — a `ClimateData` texture, in
   * practice. Snow is masked to where snow is lying and rain to the inverse,
   * so a single climate texture splits the map into the two cleanly and no hex
   * receives both.
   *
   * Held across weather changes: `setWeather` rebuilds the particle layer, and
   * the mask is re-applied to the new one, so callers set it once.
   */
  setPrecipitationMask(
    texture: THREE.Texture | null,
    rect?: { x: number; z: number; width: number; depth: number },
  ): void {
    this.mask = texture ? { texture, rect } : null;
    this.applyPrecipitationMask();
  }

  private applyPrecipitationMask(): void {
    if (!this.layer) return;
    if (!this.mask) {
      this.layer.setMask(null);
      return;
    }
    // Snow reads the snow channel directly; rain takes its complement.
    this.layer.setMask(this.mask.texture, this.mask.rect, {
      channel: 'b',
      invert:  this._type === 'rain',
    });
  }

  /** Re-point at a new terrain material after a swap (setTerrainDescriptors / loadHexPack). */
  setTerrainMaterial(material: THREE.ShaderMaterial | null): void {
    if (this.terrainMaterial && this.terrainMaterial !== material) {
      setTerrainCloudsEnabled(this.terrainMaterial, false);
    }
    this.terrainMaterial = material;
    this.applyClouds();
  }

  /** Re-push cloud config onto the current materials (call after swapping liquid materials). */
  refresh(): void {
    this.applyClouds();
  }

  private applyClouds(): void {
    for (const mat of this.cloudMaterials()) {
      configureTerrainClouds(mat, {
        enabled:  this.clouds.enabled && this._intensity > 0,
        coverage: this.clouds.coverage,
        scale:    this.clouds.scale,
        // Intensity fades the shadows with the rain so transitions feel whole.
        opacity:  this.clouds.opacity * (0.4 + 0.6 * this._intensity),
      });
    }
  }

  /**
   * Advance the weather one frame: drift the shared cloud field by wind and
   * update the particle layer. `center` is the camera's ground target.
   */
  update(dt: number, center: { x: number; y?: number; z: number }): void {
    if (this.ownsWind) this._wind.advance(dt);

    // The deck drifts by the SUSTAINED wind, not the gusted one: a two-second
    // gust moves the hedge below, and an overcast sky that surged with it would
    // read as the whole world sliding.
    this.offset.addScaledVector(this._wind.base, dt);
    for (const mat of this.cloudMaterials()) {
      const u = mat.uniforms;
      if ('uCloudOffset' in u) (u.uCloudOffset.value as THREE.Vector2).copy(this.offset);
    }
    if (this.layer) {
      this.layer.setCloudOffset(this.offset);
      // Falling rain is in the surface layer, so it takes the gust — the same
      // surge that is bending the trees it is landing on, at windResponse of
      // its strength.
      this.layer.setWind(this.particleWind());
      this.layer.update(dt, center);
    }
  }

  /** The surface wind scaled to what falling particles should answer to. */
  private particleWind(): THREE.Vector2 {
    return this.precipWind.copy(this._wind.surface).multiplyScalar(this.windResponse);
  }

  /** Remove particles, switch off cloud shadows, clear the sky, free resources. */
  dispose(): void {
    this.layer?.dispose();
    this.layer = null;
    for (const mat of this.cloudMaterials()) setTerrainCloudsEnabled(mat, false);
    this.sky?.setOvercast(0);
  }
}
