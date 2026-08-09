import * as THREE from 'three';

const TWO_PI = Math.PI * 2;

/** How the world's wind blows. Unset fields keep their current value. */
export interface WindOptions {
  /** Sustained wind in world units/sec, as an XZ vector. Default (1.6, 0.9). */
  vector?: THREE.Vector2;
  /**
   * Sustained wind as a heading in radians, measured from +X toward +Z.
   * Applied with {@link WindOptions.speed}; either may be given alone.
   */
  heading?: number;
  /** Sustained wind speed in world units/sec. Applied with {@link WindOptions.heading}. */
  speed?: number;
  /**
   * How far gusts swing the surface wind either side of the sustained value,
   * as a fraction of it. 0 is a dead-steady breeze. Default 0.35.
   */
  gustiness?: number;
  /** Seconds between gust peaks. Default 7. */
  gustPeriod?: number;
  /**
   * How far, in radians, gusts swing the surface wind's *direction* either
   * side of the sustained heading. Default 0.12 (about 7°).
   */
  turbulence?: number;
  /**
   * The speed that counts as a full wind — the one {@link Wind.strength}
   * reports as 1, and that a sway amplitude is authored against. Default 5.
   */
  referenceSpeed?: number;
  /** Sway oscillation rate in radians/sec at the reference speed. Default 2.6. */
  swayRate?: number;
  /**
   * Distance in world units between successive gust crests as they travel
   * downwind. Sets how big a patch of wood leans together. Default 26.
   */
  waveLength?: number;
  /**
   * Fraction of the wind speed at which a water surface's ripple pattern
   * marches downwind. Default 0.02.
   *
   * Tiny, and for a reason worth knowing before raising it: the liquid shaders
   * sample their surface noise at `worldXZ * 4.5`, so one world unit of drift
   * carries the pattern across *four and a half* noise features. The water's
   * own wave animation runs at 0.2 noise-units/sec, and anything much past
   * that stops reading as a breeze over a lake and starts reading as a river
   * in spate. At this default a stiff wind adds roughly a third of a feature
   * per second — a visible march that still sits under the water's own motion.
   */
  waterDrift?: number;
}

/**
 * One wind for the whole world: the vector that drifts the cloud deck, slants
 * the rain, bends the trees, and marches the ripples across a lake.
 *
 * Nothing here draws anything. It is a handful of numbers advanced once a frame
 * and read by every system that should agree about which way the weather is
 * going — which is the entire point, because four effects each animating on
 * their own clock is what makes a scene read as four animations instead of as
 * one place with weather in it.
 *
 * ### Sustained versus surface
 *
 * {@link base} is the sustained wind: mutate it freely, and it is what the
 * cloud deck drifts by. {@link surface} is what a gust is doing *right now* —
 * `base` swung in speed by {@link gustiness} and in direction by
 * {@link turbulence} — and it is what the rain and the plants follow. A whole
 * overcast deck does not surge in a two-second gust; the hedge under it does,
 * and having both available is what lets each take the one that is true of it.
 *
 * ### Why phase is integrated
 *
 * {@link phase} accumulates on the CPU rather than being recovered in a shader
 * as `time × rate`. Multiplying a shared clock by a changing rate rewinds the
 * wave's phase every time the wind picks up, which reads as the trees briefly
 * swaying backwards. The same reasoning keeps the cloud offset and
 * {@link drift} on the CPU.
 *
 * @example
 * const wind = new Wind({ heading: Math.PI * 0.25, speed: 4 });
 * // per frame:
 * wind.advance(dt);
 * setMaterialWind(myMaterials, wind);
 */
export class Wind {
  /**
   * The sustained wind in world units/sec. Mutate freely — everything derived
   * from it turns smoothly, because the offsets that consume it are integrated
   * rather than recomputed from a clock.
   */
  readonly base = new THREE.Vector2(1.6, 0.9);

  /**
   * The wind at ground level this instant: {@link base} with the current gust
   * and direction wander folded in. Recomputed by {@link advance}; treat as
   * read-only.
   */
  readonly surface = new THREE.Vector2();

  /**
   * How far a water surface's ripple pattern has travelled downwind, in world
   * units. Integrated, so a change of wind turns the pattern instead of
   * teleporting it.
   */
  readonly drift = new THREE.Vector2();

  /** @see WindOptions.gustiness */
  gustiness = 0.35;
  /** @see WindOptions.gustPeriod */
  gustPeriod = 7;
  /** @see WindOptions.turbulence */
  turbulence = 0.12;
  /** @see WindOptions.referenceSpeed */
  referenceSpeed = 5;
  /** @see WindOptions.swayRate */
  swayRate = 2.6;
  /** @see WindOptions.waveLength */
  waveLength = 26;
  /** @see WindOptions.waterDrift */
  waterDrift = 0.02;

  private clock = 0;
  private _gust = 1;
  private _phase = 0;

  constructor(opts: WindOptions = {}) {
    this.configure(opts);
  }

  /** Apply an options bag; unset fields keep their current value. */
  configure(opts: WindOptions = {}): void {
    if (opts.vector) this.base.copy(opts.vector);
    if (opts.heading !== undefined || opts.speed !== undefined) {
      this.setPolar(opts.heading ?? this.heading, opts.speed ?? this.speed);
    }
    if (opts.gustiness      !== undefined) this.gustiness      = Math.max(0, opts.gustiness);
    if (opts.gustPeriod     !== undefined) this.gustPeriod     = Math.max(1e-3, opts.gustPeriod);
    if (opts.turbulence     !== undefined) this.turbulence     = opts.turbulence;
    if (opts.referenceSpeed !== undefined) this.referenceSpeed = Math.max(1e-3, opts.referenceSpeed);
    if (opts.swayRate       !== undefined) this.swayRate       = opts.swayRate;
    if (opts.waveLength     !== undefined) this.waveLength     = Math.max(1e-3, opts.waveLength);
    if (opts.waterDrift     !== undefined) this.waterDrift     = opts.waterDrift;
    this.refreshSurface();
  }

  /** Sustained speed in world units/sec. */
  get speed(): number { return this.base.length(); }
  /** Sustained heading in radians, from +X toward +Z. */
  get heading(): number { return Math.atan2(this.base.y, this.base.x); }

  /** Point the sustained wind, in radians from +X toward +Z. */
  setPolar(heading: number, speed: number): void {
    this.base.set(Math.cos(heading) * speed, Math.sin(heading) * speed);
    this.refreshSurface();
  }

  /** The current gust multiplier on {@link base}: 1 is the sustained wind. */
  get gust(): number { return this._gust; }

  /** Accumulated sway phase in radians. @see Wind — why this is integrated. */
  get phase(): number { return this._phase; }

  /**
   * Surface wind as a fraction of {@link referenceSpeed}: 0 calm, 1 a full
   * wind, above 1 a storm (capped at 2 so a wild `base` cannot fold a tree
   * through the ground). This is the number the shaders scale by.
   */
  get strength(): number {
    return Math.min(this.surface.length() / this.referenceSpeed, 2);
  }

  /** Radians of gust phase per world unit travelled downwind. */
  get waveNumber(): number { return TWO_PI / this.waveLength; }

  /**
   * Advance the gust, the sway phase, and the water drift by one frame. Call
   * once per frame from whoever owns this wind — `HexWorld` does it for the
   * wind it shares with its {@link WeatherSystem}.
   */
  advance(dt: number): void {
    this.clock += dt;

    // Two rates whose periods don't divide into each other: a single sine is a
    // metronome, and a wood that breathes in exact time is the tell that gives
    // the whole effect away.
    const w = TWO_PI / this.gustPeriod;
    const swell = Math.sin(w * this.clock) * 0.6
                + Math.sin(w * this.clock / 0.37 + 1.7) * 0.4;
    // Floored at zero rather than allowed negative: a gust that reverses is a
    // different weather event, not a strong one.
    this._gust = Math.max(0, 1 + this.gustiness * swell);
    this.refreshSurface();

    // Plants move a little on a still day, so the rate keeps a floor at 30% of
    // its full value instead of freezing the wood solid whenever the air drops.
    this._phase += this.swayRate * (0.3 + 0.7 * this.strength) * dt;
    // Wrapped on a whole number of turns, so the sines the shader takes of it
    // are continuous across the wrap and float precision stays useful in a
    // session left running overnight.
    if (this._phase > TWO_PI * 1024) this._phase -= TWO_PI * 1024;

    this.drift.addScaledVector(this.surface, dt * this.waterDrift);
  }

  /** Re-derive {@link surface} from {@link base}, the gust, and the wander. */
  private refreshSurface(): void {
    // Direction wanders on its own slow rate rather than with the gust — a
    // squall that always veers as it strengthens reads as one moving object.
    const wander = this.turbulence * Math.sin(this.clock * 0.41 + 0.9);
    const c = Math.cos(wander), s = Math.sin(wander);
    this.surface
      .set(this.base.x * c - this.base.y * s, this.base.x * s + this.base.y * c)
      .multiplyScalar(this._gust);
  }
}

/** The wind uniforms of a material, however it got them (inline or attached). */
function windUniformsOf(material: THREE.Material): Record<string, THREE.IUniform> | null {
  const own = (material as THREE.ShaderMaterial).uniforms;
  const attached = material.userData?.hexWorldWind as Record<string, THREE.IUniform> | undefined;
  if (own && ('uWindStrength' in own || 'uWindDrift' in own)) return own;
  return attached ?? null;
}

const _dir = new THREE.Vector2();

/**
 * Push a {@link Wind} onto a whole material list — the per-frame call that
 * makes one wind reach everything at once.
 *
 * Writes whichever of the two uniform families a material carries and skips the
 * rest, so a mixed list of scatter materials, liquid materials and anything
 * else can be fanned out in one pass:
 *
 * - **sway** (`uWindDir`, `uWindStrength`, `uWindPhase`, `uWindWave`) — on
 *   stock materials given {@link attachWindSway}.
 * - **water** (`uWindDrift`, `uWindChop`) — declared inline by every liquid
 *   material, and both zero until this is called, so a scene with no wind looks
 *   exactly as it always did.
 *
 * Pass `null` to still the wind: everything goes to zero, which leaves plants
 * standing upright and water back on its own clock rather than freezing the
 * animation mid-lean.
 */
export function setMaterialWind(
  materials: Iterable<THREE.Material | null | undefined>,
  wind: Wind | null,
): void {
  const strength = wind ? wind.strength : 0;
  if (wind) {
    // Direction only — the magnitude travels separately as `strength`, so a
    // material can scale by it without renormalizing in the shader.
    _dir.copy(wind.surface);
    if (_dir.lengthSq() > 1e-8) _dir.normalize(); else _dir.set(1, 0);
  }

  for (const mat of materials) {
    const u = mat ? windUniformsOf(mat) : null;
    if (!u) continue;
    if (u.uWindStrength) {
      if (wind) {
        (u.uWindDir.value as THREE.Vector2).copy(_dir);
        u.uWindPhase.value = wind.phase;
        u.uWindWave.value  = wind.waveNumber;
      }
      u.uWindStrength.value = strength;
    }
    if (u.uWindDrift) {
      if (wind) (u.uWindDrift.value as THREE.Vector2).copy(wind.drift);
      else      (u.uWindDrift.value as THREE.Vector2).set(0, 0);
      u.uWindChop.value = Math.min(strength, 1);
    }
  }
}
