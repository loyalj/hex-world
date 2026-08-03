import * as THREE from 'three';
import { configureTerrainClouds, setTerrainCloudsEnabled, type CloudShadowOptions } from './CloudShadows.js';
import { PrecipitationLayer, type PrecipitationOptions } from './Precipitation.js';
import type { LiquidMaterialSet } from '../geometry/LiquidTypes.js';

export type WeatherType = 'clear' | 'rain' | 'snow';

export interface WeatherOptions {
  /** Strength 0–1: scales particle density/opacity and cloud-shadow darkness. Default 1. */
  intensity?: number;
  /** Wind in world units/sec — drifts the clouds AND streaks/blows the precipitation. Default (1.6, 0.9). */
  wind?: THREE.Vector2;
  /**
   * Cloud shadows: `false` disables, `true`/omitted uses the per-type preset,
   * an options object overrides the preset.
   */
  clouds?: boolean | CloudShadowOptions;
  /**
   * Fraction of ground actually being rained/snowed on, 0–1. Kept below the
   * clouds' coverage so lighter clouds shade the ground without precipitating
   * — only the denser cores rain. Default: 55% of the cloud coverage.
   * Set to 1 to decouple precipitation from the cloud field entirely.
   */
  precipCoverage?: number;
  /** Overrides for the particle layer (count, fall speed, color, …). */
  precipitation?: Omit<PrecipitationOptions, 'type' | 'intensity' | 'wind'>;
}

/** Per-type cloud presets: rain under heavy dark cover, snow under lighter, broader cover. */
const CLOUD_PRESETS: Record<WeatherType, Required<Pick<CloudShadowOptions, 'coverage' | 'opacity' | 'scale'>> & { enabled: boolean }> = {
  clear: { enabled: false, coverage: 0.5,  opacity: 0.55, scale: 30 },
  rain:  { enabled: true,  coverage: 0.6,  opacity: 0.6,  scale: 30 },
  snow:  { enabled: true,  coverage: 0.55, opacity: 0.45, scale: 42 },
};

/**
 * One knob for the whole weather picture: drifting cloud shadows on the
 * terrain plus a matching precipitation layer, driven off a single wind and a
 * single world-space cloud field so rain visibly falls under the clouds that
 * shade the ground (and moves with them). Lighter clouds stay dry — see
 * {@link WeatherOptions.precipCoverage}.
 *
 * The cloud drift offset is integrated on the CPU each update, so changing
 * wind mid-storm turns the field smoothly instead of teleporting it.
 *
 * @example
 * const weather = new WeatherSystem({ scene, terrainMaterial });
 * weather.setWeather('rain');
 * // per frame:
 * weather.update(dt, controls.targetPosition);
 */
export class WeatherSystem {
  /** Wind in world units/sec. Mutate freely — clouds turn smoothly. */
  readonly wind = new THREE.Vector2(1.6, 0.9);

  private readonly scene: THREE.Object3D;
  private terrainMaterial: THREE.ShaderMaterial | null;
  private readonly liquidMaterials: (() => Iterable<LiquidMaterialSet>) | null;
  private readonly offset = new THREE.Vector2();
  private layer: PrecipitationLayer | null = null;
  private _type: WeatherType = 'clear';
  private _intensity = 1;
  private clouds = { ...CLOUD_PRESETS.clear };
  private precipCoverage = 0.33;

  constructor(opts: {
    scene: THREE.Object3D;
    terrainMaterial?: THREE.ShaderMaterial | null;
    /**
     * Provider for the liquid material sets so cloud shadows darken water in
     * step with the ground. A function (not a snapshot) so swapped liquid
     * materials are picked up — pass `() => world.liquidMaterials.values()`
     * style accessors.
     */
    liquidMaterials?: () => Iterable<LiquidMaterialSet>;
  }) {
    this.scene = opts.scene;
    this.terrainMaterial = opts.terrainMaterial ?? null;
    this.liquidMaterials = opts.liquidMaterials ?? null;
  }

  /** Every material that carries the shared cloud uniforms. */
  private *cloudMaterials(): Generator<THREE.ShaderMaterial> {
    if (this.terrainMaterial) yield this.terrainMaterial;
    if (!this.liquidMaterials) return;
    for (const set of this.liquidMaterials()) {
      for (const mat of [set.surface, set.shore, set.estuary, set.river]) {
        if (mat instanceof THREE.ShaderMaterial) yield mat;
      }
    }
  }

  get type(): WeatherType { return this._type; }
  get intensity(): number { return this._intensity; }
  /** The current particle layer (null when clear) — for advanced tweaking. */
  get precipitation(): PrecipitationLayer | null { return this.layer; }

  /** Switch weather. Rebuilds the particle layer; cloud shadows re-style in place. */
  setWeather(type: WeatherType, opts: WeatherOptions = {}): void {
    this._type = type;
    if (opts.wind) this.wind.copy(opts.wind);

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

    this.layer?.dispose();
    this.layer = null;
    if (type !== 'clear') {
      this.layer = new PrecipitationLayer({
        ...opts.precipitation,
        type,
        wind: this.wind,
      }).addTo(this.scene);
      // Gate particles by the cloud field only while the clouds exist and the
      // coverage leaves dry gaps (precipCoverage 1 = rain everywhere).
      this.layer.setCloudGate({
        enabled: this.clouds.enabled && this.precipCoverage < 1,
        offset:   this.offset,
        scale:    this.clouds.scale,
        coverage: this.precipCoverage,
      });
    }

    this.applyClouds();
    this.setIntensity(opts.intensity ?? 1);
  }

  /** Ramp the current weather 0–1 (particles + cloud darkness) — animate for smooth transitions. */
  setIntensity(intensity: number): void {
    this._intensity = THREE.MathUtils.clamp(intensity, 0, 1);
    this.layer?.setIntensity(this._intensity);
    this.applyClouds();
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
    this.offset.addScaledVector(this.wind, dt);
    for (const mat of this.cloudMaterials()) {
      const u = mat.uniforms;
      if ('uCloudOffset' in u) (u.uCloudOffset.value as THREE.Vector2).copy(this.offset);
    }
    if (this.layer) {
      this.layer.setCloudOffset(this.offset);
      this.layer.setWind(this.wind);
      this.layer.update(dt, center);
    }
  }

  /** Remove particles, switch off cloud shadows, free resources. */
  dispose(): void {
    this.layer?.dispose();
    this.layer = null;
    for (const mat of this.cloudMaterials()) setTerrainCloudsEnabled(mat, false);
  }
}
