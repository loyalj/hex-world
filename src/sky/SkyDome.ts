import * as THREE from 'three';
import { configureAtmosphere, setAtmosphereEnabled, type AtmosphereOptions } from './Atmosphere.js';
// Type-only (erased at compile) — DayNightCycle imports this module back for
// its `sky` target, so a value import here would close a runtime cycle.
import type { DayNightState } from '../lighting/DayNightCycle.js';

const vertexShader = /* glsl */`
  varying vec3 vDir;
  void main() {
    // The dome is uniformly scaled and never rotated, so the object-space
    // position doubles as the world-space view direction.
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  varying vec3 vDir;

  uniform vec3  uZenith;
  uniform vec3  uHorizon;
  uniform vec3  uGround;
  uniform float uHorizonFalloff;
  uniform float uGroundFalloff;
  uniform vec3  uSunDir;
  uniform vec3  uSunColor;
  uniform float uSunGlow;
  uniform float uSunSize;
  uniform float uStars;
  uniform float uStarDensity;
  uniform float uTime;

  float sky_hash(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  // One candidate star per cell of a lattice sampled along the view direction,
  // kept only for the top ~2.5% of hashes. Anchored to direction rather than
  // screen space, so the field holds still while the camera turns, and it costs
  // a handful of instructions instead of a texture.
  float starField(vec3 d) {
    vec3 p  = d * uStarDensity;
    vec3 id = floor(p);
    float r = sky_hash(id);
    if (r < 0.975) return 0.0;
    vec3  jitter = vec3(sky_hash(id + 1.7), sky_hash(id + 4.3), sky_hash(id + 9.1)) - 0.5;
    float dist   = length(fract(p) - 0.5 - jitter * 0.7);
    float twinkle = 0.6 + 0.4 * sin(uTime * 1.7 + r * 137.0);
    return (1.0 - smoothstep(0.0, 0.11, dist)) * twinkle * (r - 0.975) * 40.0;
  }

  void main() {
    vec3  d = normalize(vDir);
    float h = d.y;

    // Horizon → zenith above, horizon → ground below. The band around h = 0 is
    // the color the terrain hazes into, so the map edge and the sky meet in the
    // same value from either side.
    vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), uHorizonFalloff));
    col = mix(col, uGround, smoothstep(0.0, uGroundFalloff, -h));

    if (uStars > 0.002) {
      col += vec3(starField(d)) * uStars * smoothstep(-0.02, 0.18, h);
    }

    // Whichever luminary is up (uSunDir follows the active light): a tight
    // disc, a bright near-halo, and a wide soft bloom that carries the dawn.
    float cosA = max(dot(d, uSunDir), 0.0);
    float halo = pow(cosA, 220.0) * 0.85 + pow(cosA, 7.0) * 0.13;
    float disc = smoothstep(1.0 - uSunSize, 1.0 - uSunSize * 0.35, cosA);
    col += uSunColor * (halo + disc) * uSunGlow;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export interface SkyDomeOptions {
  /** Longitudinal sphere segments (half as many latitudinal). Default 32. */
  segments?: number;
  /** Dome radius as a fraction of the camera's far plane. Default 0.45. */
  radiusScale?: number;

  /** Color straight overhead. Default 0x3f74c0 (a deeper blue than the horizon). */
  zenithColor?: THREE.ColorRepresentation;
  /** Color at the horizon — also the color terrain hazes into. Default 0x8fb2d9. */
  horizonColor?: THREE.ColorRepresentation;
  /**
   * Color below the horizon. Omit to derive it from the horizon color darkened
   * by {@link SkyDomeOptions.groundDarken}, which keeps the two in step as the
   * day/night cycle recolors the sky.
   */
  groundColor?: THREE.ColorRepresentation;
  /** Multiplier for the derived below-horizon color. Default 0.7. */
  groundDarken?: number;

  /**
   * Exponent shaping the horizon→zenith ramp. Below 1 the horizon band is
   * wide and hazy; above 1 the deep sky reaches almost down to the ground.
   * Default 0.62.
   */
  horizonFalloff?: number;
  /** How far below the horizon the ground color takes over. Default 0.35. */
  groundFalloff?: number;

  /**
   * Haze color the horizon band is blended toward — the biome's own palette,
   * so a desert map hazes sandy and a tundra map hazes pale grey. Derive one
   * with {@link averageTerrainColor}. Default: none.
   */
  groundTint?: THREE.ColorRepresentation;
  /** How much of {@link SkyDomeOptions.groundTint} reaches the horizon. Default 0.28. */
  groundTintStrength?: number;

  /** Sun halo/disc strength in full day. Default 0.5. */
  sunGlow?: number;
  /** Moon halo/disc strength at night. Default 0.2. */
  moonGlow?: number;
  /** Angular size of the sun disc (1 − cos θ). Default 0.0022 (~3.8°). */
  sunSize?: number;
  /** Angular size of the moon disc. Default 0.0012 (~2.8°). */
  moonSize?: number;

  /** Draw the star field at night. Default true. */
  stars?: boolean;
  /** Star lattice frequency — higher is denser and finer. Default 220. */
  starDensity?: number;

  /** Flat color an overcast sky collapses toward. Default 0x9aa3ad. */
  overcastColor?: THREE.ColorRepresentation;

  /**
   * Distance haze on the world's surface materials, matched to the horizon
   * color every time the sky recolors. `false` disables it (dome only); an
   * options object overrides near/far/density. Requires
   * {@link SkyDomeOptions.materials}.
   */
  fog?: AtmosphereOptions | false;
  /**
   * Provider for the materials that carry the atmosphere uniforms — the
   * library's own surface shaders (terrain, roads, every liquid layer) plus any
   * stock material you ran through {@link attachAtmosphere}. A function, not a
   * snapshot, so swapped materials are picked up — pass
   * `() => world.hazeMaterials()` style accessors and call
   * {@link SkyDome.refresh} after a swap.
   *
   * Note there is deliberately no `scene.fog` hook: three's fog mixes before
   * tone mapping and output encoding, which lands the same haze color far
   * brighter than the library's shaders do. {@link attachAtmosphere} is the
   * way to bring a stock material in.
   */
  materials?: () => Iterable<THREE.Material | undefined | null>;
}

/**
 * Gradient sky dome that closes the world: a zenith→horizon→ground ramp with a
 * sun/moon glow and a night star field, plus the matching distance haze on the
 * ground materials so the map edge dissolves into the same color the sky shows
 * at the horizon.
 *
 * It is a sink, not a clock — feed it a {@link DayNightState} (directly, or by
 * naming it as a {@link DayNightCycle} target) for time of day, and an overcast
 * factor from a {@link WeatherSystem} for rain and snow, which flattens the
 * gradient toward grey and puts out the sun and stars.
 *
 * The mesh rides the camera and never writes or tests depth, so its radius only
 * has to stay inside the far plane — {@link SkyDome.update} rescales it to
 * match whatever camera it is handed.
 *
 * @example
 * const sky = new SkyDome({ materials: () => world.hazeMaterials() }).addTo(scene);
 * // per frame:
 * cycle.applyTo({ sunRig, terrainMaterial, sky });
 * sky.setOvercast(weather.overcast);
 * sky.update(camera, dt);
 */
export class SkyDome {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  private readonly radiusScale: number;
  private readonly groundDarken: number;
  private readonly explicitGround: THREE.Color | null;
  private groundTint: THREE.Color | null;
  private readonly groundTintStrength: number;
  private readonly overcastColor: THREE.Color;
  private readonly sunGlow: number;
  private readonly moonGlow: number;
  private readonly sunSize: number;
  private readonly moonSize: number;
  private readonly starsEnabled: boolean;
  private readonly materials: (() => Iterable<THREE.Material | undefined | null>) | null;

  /** Un-tinted, un-overcast base colors — what the day/night cycle supplies. */
  private readonly baseZenith  = new THREE.Color();
  private readonly baseHorizon = new THREE.Color();
  /** The color the world hazes into: the final, post-tint horizon band. */
  private readonly _horizon = new THREE.Color();
  private readonly _zenith  = new THREE.Color();
  private readonly _scratch = new THREE.Color();

  private fogOptions: AtmosphereOptions | null;
  private _overcast = 0;
  private daylight  = 1;
  private isNight   = false;
  private sunHeight = 1;
  private _enabled  = true;

  constructor(opts: SkyDomeOptions = {}) {
    const seg = opts.segments ?? 32;
    this.radiusScale        = opts.radiusScale ?? 0.45;
    this.groundDarken       = opts.groundDarken ?? 0.7;
    this.explicitGround     = opts.groundColor !== undefined ? new THREE.Color(opts.groundColor) : null;
    this.groundTint         = opts.groundTint  !== undefined ? new THREE.Color(opts.groundTint)  : null;
    this.groundTintStrength = opts.groundTintStrength ?? 0.28;
    this.overcastColor      = new THREE.Color(opts.overcastColor ?? 0x9aa3ad);
    this.sunGlow      = opts.sunGlow  ?? 0.5;
    this.moonGlow     = opts.moonGlow ?? 0.2;
    this.sunSize      = opts.sunSize  ?? 0.0022;
    this.moonSize     = opts.moonSize ?? 0.0012;
    this.starsEnabled = opts.stars !== false;
    this.materials    = opts.materials ?? null;
    this.fogOptions   = opts.fog === false ? null : { ...(opts.fog ?? {}) };

    this.baseZenith.set(opts.zenithColor  ?? 0x3f74c0);
    this.baseHorizon.set(opts.horizonColor ?? 0x8fb2d9);

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uZenith:         { value: this._zenith },
        uHorizon:        { value: this._horizon },
        uGround:         { value: new THREE.Color() },
        uHorizonFalloff: { value: opts.horizonFalloff ?? 0.62 },
        uGroundFalloff:  { value: opts.groundFalloff  ?? 0.35 },
        uSunDir:         { value: new THREE.Vector3(0, 1, 0) },
        uSunColor:       { value: new THREE.Color(0xfff4d0) },
        uSunGlow:        { value: this.sunGlow },
        uSunSize:        { value: this.sunSize },
        uStars:          { value: 0 },
        uStarDensity:    { value: opts.starDensity ?? 220 },
        uTime:           { value: 0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      // Never occluded and never occluding: drawn first, testing nothing, so
      // the dome's radius is free to be whatever fits inside the far plane.
      depthTest: false,
      fog: false,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, seg, Math.max(2, seg >> 1)), this.material);
    this.mesh.name = 'SkyDome';
    this.mesh.renderOrder   = -1000;
    this.mesh.frustumCulled = false;

    this.recolor();
  }

  /** Add the dome to a scene (or any Object3D). Returns this for chaining. */
  addTo(parent: THREE.Object3D): this {
    parent.add(this.mesh);
    return this;
  }

  /** Whether the sky and its matching distance haze are drawn. */
  get enabled(): boolean { return this._enabled; }

  /** Current overcast factor, 0 (clear) – 1 (solid grey). */
  get overcast(): number { return this._overcast; }

  /**
   * The color the world dissolves into: the horizon band after biome tinting
   * and overcast. Reused between calls — copy anything you keep.
   */
  get horizonColor(): THREE.Color { return this._horizon; }

  /** Show or hide the whole sky system — dome mesh and surface haze together. */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
    this.mesh.visible = enabled;
    this.recolor(); // applyFog switches the surface haze with it
  }

  /**
   * Set the gradient directly — the standalone path for scenes without a
   * day/night cycle. Unset fields keep their current value.
   */
  setColors(colors: {
    zenith?: THREE.ColorRepresentation;
    horizon?: THREE.ColorRepresentation;
  }): void {
    if (colors.zenith  !== undefined) this.baseZenith.set(colors.zenith);
    if (colors.horizon !== undefined) this.baseHorizon.set(colors.horizon);
    this.recolor();
  }

  /**
   * Re-point the biome haze tint the horizon band leans toward (null clears
   * it) — call after swapping the terrain palette, since a new palette means a
   * new average. See {@link averageTerrainColor}.
   */
  setGroundTint(tint: THREE.ColorRepresentation | null): void {
    if (tint === null) this.groundTint = null;
    else (this.groundTint ??= new THREE.Color()).set(tint);
    this.recolor();
  }

  /**
   * Point the sun/moon glow. `dirTowardLight` points from the scene toward the
   * luminary; the glow fades out as it sinks below the horizon.
   */
  setSun(dirTowardLight: THREE.Vector3, color?: THREE.Color, night = false): void {
    (this.material.uniforms.uSunDir.value as THREE.Vector3).copy(dirTowardLight).normalize();
    if (color) (this.material.uniforms.uSunColor.value as THREE.Color).copy(color);
    this.isNight   = night;
    this.sunHeight = dirTowardLight.y;
    this.recolor();
  }

  /**
   * Adopt one moment of a {@link DayNightCycle}: gradient colors, the active
   * luminary's direction and color, and the star fade. Named as the cycle's
   * `sky` target this is called for you every frame.
   */
  setDayNight(state: DayNightState): void {
    this.baseHorizon.copy(state.skyHorizon);
    this.baseZenith.copy(state.skyZenith);
    (this.material.uniforms.uSunDir.value as THREE.Vector3).copy(state.lightDir).normalize();
    (this.material.uniforms.uSunColor.value as THREE.Color).copy(state.lightColor);
    this.daylight  = state.daylight;
    this.isNight   = state.isNight;
    this.sunHeight = state.lightDir.y;
    this.recolor();
  }

  /**
   * How overcast the sky reads, 0–1 — a {@link WeatherSystem}'s `overcast`.
   * Flattens the gradient toward grey, dims the horizon haze to match, and
   * puts out the sun disc and the stars, so rain and snow stop happening under
   * a clear blue sky.
   */
  setOvercast(overcast: number): void {
    const next = THREE.MathUtils.clamp(overcast, 0, 1);
    if (next === this._overcast) return;
    this._overcast = next;
    this.recolor();
  }

  /** Restyle the distance haze (near/far/density). `false` switches it off. */
  setFog(fog: AtmosphereOptions | false): void {
    this.fogOptions = fog === false ? null : { ...this.fogOptions, ...fog };
    this.applyFog();
  }

  /**
   * Re-push the haze onto the current material list — call after swapping
   * terrain or liquid materials (HexWorld does this for you).
   */
  refresh(): void {
    this.applyFog();
  }

  /** Recompute the final colors from base + biome tint + overcast, and publish them. */
  private recolor(): void {
    // Overcast greys the sky at whatever brightness the hour allows: a solid
    // deck at midnight is a dark slate, not a daytime cloud.
    const grey = this._scratch.copy(this.overcastColor)
      .multiplyScalar(THREE.MathUtils.lerp(0.18, 1, this.daylight));

    this._horizon.copy(this.baseHorizon);
    // The biome tint is sunlight bouncing off the land, so it fades with the
    // light: at full strength after dark it would hang a bright dusty band
    // around a midnight horizon and haze distant terrain to the same.
    if (this.groundTint) this._horizon.lerp(this.groundTint, this.groundTintStrength * this.daylight);
    this._zenith.copy(this.baseZenith);
    if (this._overcast > 0) {
      // The horizon keeps a little more of its own color than the zenith —
      // that residual gradient is what stops an overcast sky reading as a wall.
      this._horizon.lerp(grey, this._overcast * 0.75);
      this._zenith.lerp(grey, this._overcast);
    }

    const ground = this.material.uniforms.uGround.value as THREE.Color;
    if (this.explicitGround) ground.copy(this.explicitGround);
    else ground.copy(this._horizon).multiplyScalar(this.groundDarken);

    // Both luminaries set behind the horizon rather than sinking through the
    // dome, and neither burns through a solid cloud deck.
    const above = THREE.MathUtils.smoothstep(this.sunHeight, -0.05, 0.1);
    const clear = 1 - this._overcast * 0.92;
    this.material.uniforms.uSunGlow.value = (this.isNight ? this.moonGlow : this.sunGlow) * above * clear;
    this.material.uniforms.uSunSize.value = this.isNight ? this.moonSize : this.sunSize;
    this.material.uniforms.uStars.value   = this.starsEnabled
      ? (1 - this.daylight) * (1 - this._overcast) : 0;

    this.applyFog();
  }

  /** Push haze config + the live horizon color onto the surface materials. */
  private applyFog(): void {
    if (!this.materials) return;
    const on = this._enabled && this.fogOptions !== null;
    for (const mat of this.materials()) {
      if (mat) configureAtmosphere(mat, { ...this.fogOptions, enabled: on, color: this._horizon });
    }
  }

  /**
   * Ride the camera and advance the twinkle. `dt` may be omitted for a static
   * star field. Call once per frame, before rendering.
   */
  update(camera: THREE.Camera, dt = 0): void {
    this.mesh.position.copy(camera.position);
    const far = (camera as THREE.PerspectiveCamera).far || 1000;
    this.mesh.scale.setScalar(far * this.radiusScale);
    if (dt > 0) this.material.uniforms.uTime.value = (this.material.uniforms.uTime.value as number) + dt;
  }

  /** Detach the dome, free its geometry/material, and switch the surface haze back off. */
  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    if (this.materials) {
      for (const mat of this.materials()) {
        if (mat) setAtmosphereEnabled(mat, false);
      }
    }
  }
}

/**
 * Mean color of the solid terrain in a palette — the biome haze color to hand
 * {@link SkyDomeOptions.groundTint}, so a desert map's horizon goes sandy and a
 * tundra map's goes pale. Liquids are skipped: a big lake shouldn't pull the
 * whole sky blue.
 */
export function averageTerrainColor(
  terrain: Iterable<{ color: THREE.Color; isWater?: boolean }>,
): THREE.Color {
  const out = new THREE.Color(0, 0, 0);
  let n = 0;
  for (const t of terrain) {
    if (t.isWater) continue;
    out.r += t.color.r;
    out.g += t.color.g;
    out.b += t.color.b;
    n++;
  }
  return n > 0 ? out.multiplyScalar(1 / n) : new THREE.Color(0x8a8f7a);
}
