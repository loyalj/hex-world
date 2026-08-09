import * as THREE from 'three';
import type { SunShadowRig } from './SunShadows.js';
import type { LiquidMaterialSet } from '../geometry/LiquidTypes.js';
import { setLiquidLightTint } from '../geometry/WaterMaterial.js';
// Type-only (erased at compile) — both import DayNightState back.
import type { SkyDome } from '../sky/SkyDome.js';
import type { GodRays } from '../sky/GodRays.js';

export interface DayNightOptions {
  /** Starting time of day, 0–1 with 0 = midnight and 0.5 = noon. Default 0.5. */
  time?: number;
  /** Real seconds per full day/night cycle when animating. Default 120. */
  dayLength?: number;
  /** Start with time frozen (drive it via setTime). Default false. */
  paused?: boolean;
  /**
   * Degrees the sun's arc leans away from straight overhead at noon, like
   * latitude — keeps noon shadows from degenerating to points. Default 30.
   */
  latitudeTilt?: number;
  /** Midday sun color. Default 0xfff4d0 (matches the static default light). */
  sunColor?: THREE.ColorRepresentation;
  /** Color the sun blends toward near the horizon (dawn/dusk). Default 0xff8a3d. */
  dawnColor?: THREE.ColorRepresentation;
  /** DirectionalLight intensity at full day. Default 1.4. */
  sunIntensity?: number;
  /** Moonlight color. Default 0x8fa8d8 (cool blue). */
  moonColor?: THREE.ColorRepresentation;
  /** DirectionalLight intensity under the full moon. Default 0.35. */
  moonIntensity?: number;
  /** Daytime ambient color. Default 0xd0e0ff. */
  dayAmbient?: THREE.ColorRepresentation;
  /** Daytime AmbientLight intensity. Default 0.5. */
  dayAmbientIntensity?: number;
  /** Night ambient color. Default 0x2a3550. */
  nightAmbient?: THREE.ColorRepresentation;
  /** Night AmbientLight intensity. Default 0.3. */
  nightAmbientIntensity?: number;
  /** Horizon sky/background color at midday. Default 0x8fb2d9. */
  daySky?: THREE.ColorRepresentation;
  /** Sky color blended in while the sun is near the horizon. Default 0xc97a4a. */
  dawnSky?: THREE.ColorRepresentation;
  /** Horizon sky color at night. Default 0x0b0e1c. */
  nightSky?: THREE.ColorRepresentation;
  /** Color straight overhead at midday — deeper than the horizon. Default 0x3f74c0. */
  dayZenith?: THREE.ColorRepresentation;
  /** Color straight overhead at night. Default 0x05060f. */
  nightZenith?: THREE.ColorRepresentation;
}

/** Everything a renderer needs to light one moment of the cycle. All objects are reused between evaluate() calls — copy, don't keep. */
export interface DayNightState {
  /** Time of day 0–1 (0 = midnight, 0.5 = noon). */
  time: number;
  /** Unit vector toward the sun — below the horizon at night (y < 0). */
  sunDir: THREE.Vector3;
  /** Unit vector toward the moon (always opposite the sun). */
  moonDir: THREE.Vector3;
  /** Direction of the active luminary: the sun by day, the moon by night. */
  lightDir: THREE.Vector3;
  /** Color of the active luminary (warm-shifted near the horizon). */
  lightColor: THREE.Color;
  /** DirectionalLight-scale intensity of the active luminary. */
  lightIntensity: number;
  ambientColor: THREE.Color;
  ambientIntensity: number;
  /** Sky/background color for this moment — the same value as {@link skyHorizon}. */
  skyColor: THREE.Color;
  /**
   * Sky color at the horizon. A {@link SkyDome} hazes the world into this, so
   * the map edge and the sky meet in one value.
   */
  skyHorizon: THREE.Color;
  /** Sky color straight overhead — the top of the dome's gradient. */
  skyZenith: THREE.Color;
  /**
   * uLightColor value for the terrain shader (lightColor pre-scaled by
   * intensity, matching the material's static defaults at noon).
   */
  terrainLightColor: THREE.Color;
  /** uAmbient value for the terrain shader. */
  terrainAmbient: THREE.Color;
  /**
   * Multiplier for unlit liquid surfaces (see setLiquidLightTint) — white at
   * noon, dark blue at night, so lava's emissive glow carries the scene.
   */
  liquidTint: THREE.Color;
  /** 0 at night → 1 in full day (twilight ramps between). */
  daylight: number;
  /** True while the sun is below the horizon (the moon is the active light). */
  isNight: boolean;
}

/** What applyTo pushes the evaluated state onto. Every field optional — supply what your scene has. */
export interface DayNightTargets {
  /** Shadow-casting sun: direction, color, and intensity follow the cycle. */
  sunRig?: SunShadowRig;
  /** Plain directional light alternative to the rig (position is set along lightDir). */
  sunLight?: THREE.DirectionalLight;
  ambientLight?: THREE.AmbientLight;
  /** Terrain shader material — uLightDir / uLightColor / uAmbient follow the cycle. */
  terrainMaterial?: THREE.ShaderMaterial;
  /**
   * Road overlay material — takes the same light uniforms as the terrain, so
   * roads darken with the ground they sit on instead of glowing after dark.
   */
  roadMaterial?: THREE.ShaderMaterial;
  /**
   * Any other materials using the same hand-rolled light uniforms
   * (`uLightDir` / `uLightColor` / `uAmbient`) — the map skirt, and your own
   * shaders that borrowed the trio. Materials without them are skipped.
   */
  lightMaterials?: Iterable<THREE.ShaderMaterial | undefined | null>;
  /** Liquid material sets to tint (water darkens at night; emissive is unaffected). */
  liquidMaterials?: Iterable<LiquidMaterialSet>;
  /** Scene whose background color tracks the sky. */
  scene?: THREE.Scene;
  /** Gradient sky dome — takes the horizon/zenith colors and the luminary glow. */
  sky?: SkyDome;
  /**
   * Crepuscular rays — take the sun's direction and color, and fade out with
   * the daylight, so the shafts fan from the same disc the dome draws.
   */
  godRays?: GodRays;
}

/**
 * Push the cycle's light onto one hand-rolled-lighting shader material (terrain
 * or roads — both use these uniform names). Materials without them are skipped,
 * so a custom material can opt out simply by not declaring them.
 */
function applyLightUniforms(material: THREE.ShaderMaterial | undefined, s: DayNightState): void {
  const u = material?.uniforms;
  if (!u || !('uLightDir' in u)) return;
  u.uLightDir.value.copy(s.lightDir);
  u.uLightColor.value.copy(s.terrainLightColor);
  u.uAmbient.value.copy(s.terrainAmbient);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * Time-of-day model: an animated clock mapped to sun/moon direction, light and
 * ambient colors with warm dawn/dusk tinting, a cool moonlight mode at night,
 * and matching sky + liquid tints. Pure state machine — pair it with
 * {@link DayNightTargets} via {@link applyTo} to drive a scene, or read
 * {@link evaluate} and push the values yourself.
 *
 * One directional light plays both roles: while the sun is up it *is* the sun;
 * at night it swaps to the moon's direction (exactly opposite) with a dim blue
 * color. The swap happens at the horizon, where both intensities are zero, so
 * it is never visible.
 *
 * @example
 * const cycle = new DayNightCycle({ dayLength: 180 });
 * // per frame:
 * cycle.advance(dt);
 * cycle.applyTo({ sunRig, ambientLight, terrainMaterial, liquidMaterials, scene });
 */
export class DayNightCycle {
  /** Real seconds per full cycle when animating. */
  dayLength: number;
  /** Freeze/unfreeze the clock (setTime still works while paused). */
  paused: boolean;

  private _time: number;
  private readonly tilt: number;
  private readonly sunColor: THREE.Color;
  private readonly dawnColor: THREE.Color;
  private readonly sunIntensity: number;
  private readonly moonColor: THREE.Color;
  private readonly moonIntensity: number;
  private readonly dayAmbient: THREE.Color;
  private readonly dayAmbientIntensity: number;
  private readonly nightAmbient: THREE.Color;
  private readonly nightAmbientIntensity: number;
  private readonly daySky: THREE.Color;
  private readonly dawnSky: THREE.Color;
  private readonly nightSky: THREE.Color;
  private readonly dayZenith: THREE.Color;
  private readonly nightZenith: THREE.Color;

  // Reused output state (evaluate() is called per frame).
  private readonly state: DayNightState = {
    time: 0.5,
    sunDir:  new THREE.Vector3(0, 1, 0),
    moonDir: new THREE.Vector3(0, -1, 0),
    lightDir: new THREE.Vector3(0, 1, 0),
    lightColor: new THREE.Color(),
    lightIntensity: 1,
    ambientColor: new THREE.Color(),
    ambientIntensity: 0.5,
    skyColor: new THREE.Color(),
    skyHorizon: new THREE.Color(),
    skyZenith: new THREE.Color(),
    terrainLightColor: new THREE.Color(),
    terrainAmbient: new THREE.Color(),
    liquidTint: new THREE.Color(1, 1, 1),
    daylight: 1,
    isNight: false,
  };
  private readonly _scratch = new THREE.Color();

  constructor(opts: DayNightOptions = {}) {
    this._time    = DayNightCycle.wrapTime(opts.time ?? 0.5);
    this.dayLength = opts.dayLength ?? 120;
    this.paused    = opts.paused ?? false;
    this.tilt      = THREE.MathUtils.degToRad(opts.latitudeTilt ?? 30);
    this.sunColor  = new THREE.Color(opts.sunColor  ?? 0xfff4d0);
    this.dawnColor = new THREE.Color(opts.dawnColor ?? 0xff8a3d);
    this.sunIntensity  = opts.sunIntensity ?? 1.4;
    this.moonColor     = new THREE.Color(opts.moonColor ?? 0x8fa8d8);
    this.moonIntensity = opts.moonIntensity ?? 0.35;
    this.dayAmbient    = new THREE.Color(opts.dayAmbient   ?? 0xd0e0ff);
    this.nightAmbient  = new THREE.Color(opts.nightAmbient ?? 0x2a3550);
    this.dayAmbientIntensity   = opts.dayAmbientIntensity   ?? 0.5;
    this.nightAmbientIntensity = opts.nightAmbientIntensity ?? 0.3;
    this.daySky   = new THREE.Color(opts.daySky   ?? 0x8fb2d9);
    this.dawnSky  = new THREE.Color(opts.dawnSky  ?? 0xc97a4a);
    this.nightSky = new THREE.Color(opts.nightSky ?? 0x0b0e1c);
    this.dayZenith   = new THREE.Color(opts.dayZenith   ?? 0x3f74c0);
    this.nightZenith = new THREE.Color(opts.nightZenith ?? 0x05060f);
  }

  /** Current time of day, 0–1 (0 = midnight, 0.5 = noon). */
  get time(): number { return this._time; }

  /** Jump the clock (value wraps into 0–1). */
  setTime(time: number): void {
    this._time = DayNightCycle.wrapTime(time);
  }

  /** Advance the clock by dt real seconds (no-op while paused). */
  advance(dt: number): void {
    if (this.paused || this.dayLength <= 0) return;
    this._time = DayNightCycle.wrapTime(this._time + dt / this.dayLength);
  }

  private static wrapTime(t: number): number {
    return ((t % 1) + 1) % 1;
  }

  /**
   * Compute the lighting state for the current time. The returned object and
   * its vectors/colors are reused across calls — copy anything you keep.
   */
  evaluate(): DayNightState {
    const s = this.state;
    const theta = (this._time - 0.25) * Math.PI * 2; // 0 at sunrise, π/2 at noon
    const cosTilt = Math.cos(this.tilt);
    const sinTilt = Math.sin(this.tilt);

    // The sun rides a circle tilted off vertical by latitudeTilt; the moon is
    // pinned exactly opposite so one of them is always above the horizon.
    s.sunDir.set(Math.cos(theta), Math.sin(theta) * cosTilt, Math.sin(theta) * sinTilt);
    s.moonDir.copy(s.sunDir).negate();

    const h = s.sunDir.y; // sun height, in [-cosTilt, cosTilt]
    s.time     = this._time;
    s.daylight = smoothstep(-0.12, 0.25, h);
    s.isNight  = h < 0;

    // Both luminaries fade to zero at the horizon, hiding the direction swap.
    const sunUp   = smoothstep(0, 0.18, h);
    const moonUp  = smoothstep(0, 0.18, -h);
    // Warm horizon glow, strongest with the sun right at the horizon.
    const horizonGlow = 1 - smoothstep(0, 0.38, Math.abs(h));

    if (s.isNight) {
      s.lightDir.copy(s.moonDir);
      s.lightColor.copy(this.moonColor);
      s.lightIntensity = this.moonIntensity * moonUp;
    } else {
      s.lightDir.copy(s.sunDir);
      s.lightColor.copy(this.sunColor).lerp(this.dawnColor, horizonGlow);
      s.lightIntensity = this.sunIntensity * sunUp;
    }

    s.ambientColor.copy(this.nightAmbient).lerp(this.dayAmbient, s.daylight);
    // A touch of dawn color keeps twilight ambient from reading flat grey.
    s.ambientColor.lerp(this.dawnColor, horizonGlow * 0.15);
    s.ambientIntensity = this.nightAmbientIntensity
      + (this.dayAmbientIntensity - this.nightAmbientIntensity) * s.daylight;

    s.skyHorizon.copy(this.nightSky).lerp(this.daySky, s.daylight);
    s.skyHorizon.lerp(this.dawnSky, horizonGlow * 0.85);
    // The zenith takes only a third of the dawn wash — the warm band belongs
    // near the ground, and keeping the top cool is what makes it read as depth.
    s.skyZenith.copy(this.nightZenith).lerp(this.dayZenith, s.daylight);
    s.skyZenith.lerp(this.dawnSky, horizonGlow * 0.3);
    // The flat scene background stands in for the whole sky, so it stays the
    // horizon value — that is what a sky-less scene's edges fade against.
    s.skyColor.copy(s.skyHorizon);

    // Terrain shader values, scaled the same way the static defaults are
    // (uLightColor = color · intensity/2, uAmbient = ambient · intensity · 0.9),
    // so noon reproduces the out-of-the-box look exactly.
    s.terrainLightColor.copy(s.lightColor).multiplyScalar(s.lightIntensity * 0.5);
    s.terrainAmbient.copy(s.ambientColor).multiplyScalar(s.ambientIntensity * 0.9);

    // Liquids are unlit — approximate the light a horizontal surface receives
    // (ambient + direct · lightDir.y) and clamp so full day stays untinted.
    const diff = Math.max(s.lightDir.y, 0);
    this._scratch.copy(s.terrainLightColor).multiplyScalar(diff);
    s.liquidTint.copy(s.terrainAmbient).add(this._scratch);
    s.liquidTint.r = Math.min(s.liquidTint.r, 1);
    s.liquidTint.g = Math.min(s.liquidTint.g, 1);
    s.liquidTint.b = Math.min(s.liquidTint.b, 1);

    return s;
  }

  /**
   * Evaluate and push the state onto scene objects: sun rig (or plain light),
   * ambient light, terrain material uniforms, liquid tints, scene background,
   * the sky dome, and its god rays. Returns the applied state.
   */
  applyTo(targets: DayNightTargets): DayNightState {
    const s = this.evaluate();

    if (targets.sunRig) {
      targets.sunRig.setDirection(s.lightDir);
      targets.sunRig.light.color.copy(s.lightColor);
      targets.sunRig.light.intensity = s.lightIntensity;
    }
    if (targets.sunLight) {
      targets.sunLight.position.copy(s.lightDir).multiplyScalar(150);
      targets.sunLight.color.copy(s.lightColor);
      targets.sunLight.intensity = s.lightIntensity;
    }
    if (targets.ambientLight) {
      targets.ambientLight.color.copy(s.ambientColor);
      targets.ambientLight.intensity = s.ambientIntensity;
    }
    applyLightUniforms(targets.terrainMaterial, s);
    applyLightUniforms(targets.roadMaterial, s);
    if (targets.lightMaterials) {
      for (const mat of targets.lightMaterials) applyLightUniforms(mat ?? undefined, s);
    }
    if (targets.liquidMaterials) setLiquidLightTint(targets.liquidMaterials, s.liquidTint);
    if (targets.scene?.background instanceof THREE.Color) {
      targets.scene.background.copy(s.skyColor);
    }
    targets.sky?.setDayNight(s);
    targets.godRays?.setDayNight(s);

    return s;
  }
}

/** Format a 0–1 time of day as "HH:MM" for HUDs. */
export function formatTimeOfDay(time: number): string {
  const t = ((time % 1) + 1) % 1;
  const minutes = Math.floor(t * 24 * 60);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}
