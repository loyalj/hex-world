import { latitudeAt } from '../generators/TemperatureModel.js';
import type { ClimateData } from './ClimateData.js';

/**
 * How much world one map covers, which decides whether a season is something
 * that *moves across* it or something that happens *to* it.
 *
 * `'continental'` — the map spans a range of climates. Winter's bite scales
 * with latitude and the generator's elevation cooling is already in the field,
 * so the snowline descends the map through autumn and peaks keep year-round
 * caps. The right model when the map is a subcontinent.
 *
 * `'local'` — the map is one place, small enough to share a season. Every cell
 * turns together, with only a slight stagger, so a hard winter means the whole
 * map is under snow and spring means all of it blooms. The right model when the
 * map is a valley: at that scale a snowline crawling across the view is not
 * epic, it's just wrong.
 */
export type SeasonScope = 'continental' | 'local';

export interface SeasonOptions {
  /** Starting phase, 0–1 with 0 = midwinter and 0.5 = midsummer. Default 0.25 (spring). */
  phase?: number;
  /**
   * Whether the map spans a range of climates or sits inside one. Default
   * `'continental'`. See {@link SeasonScope} — this picks which set of options
   * below has any effect.
   */
  scope?: SeasonScope;
  /** Days in a year — how many day/night cycles the phase takes to come around. Default 8. */
  daysPerYear?: number;
  /** Real seconds per day, matching `DayNightOptions.dayLength`, for {@link SeasonCycle.advance}. Default 120. */
  dayLength?: number;
  /** Start with the phase frozen (drive it via setPhase). Default false. */
  paused?: boolean;
  /**
   * How far midwinter drags the temperature down at the poles, in
   * temperature-field units (the same 0–1 scale `computeTemperature` writes).
   * Default 0.55.
   */
  polarAmplitude?: number;
  /**
   * The same swing at the equator. Much smaller than {@link polarAmplitude} on
   * purpose — that gap is what makes the snowline *descend the map* through
   * autumn rather than the whole world fading white at once. Default 0.08.
   */
  equatorAmplitude?: number;
  /** Which map edge is the equator. Must match the map's `TemperatureModelOptions`. Default 'both'. */
  hemisphere?: 'both' | 'north' | 'south';
  /**
   * Local scope: the temperature the whole map sits at in high summer. Wants to
   * be clear of the foliage tint's `greenTemp` (0.5) so midsummer is unambiguous
   * everywhere. Default 0.78.
   */
  localSummer?: number;
  /**
   * Local scope: how far midwinter pulls that down. Wants to carry the map past
   * every threshold that matters — `bareTemp` (0.26), `snowThreshold` (0.22),
   * water's `freezePoint` (0.12) — or winter never fully arrives. Default 0.72.
   */
  localAmplitude?: number;
  /**
   * Local scope: how much the map's own temperature field staggers the turn,
   * so the whole map doesn't flip on one frame. The field is reused as the
   * stagger rather than as the climate — scaled this far down, its latitude ramp
   * reads as a few cells turning first, and its elevation cooling as the high
   * ground leading, which is exactly the variation a valley should show.
   *
   * Deliberately small: the stagger has to be narrower than the swing, or the
   * promise that a hard winter strips *every* tree stops holding. Default 0.1.
   */
  localVariation?: number;
  /** Effective temperature at or below which snow lies. Default 0.22. */
  snowThreshold?: number;
  /** Width of the soft edge on the snow threshold. Larger = a hazier snowline. Default 0.1. */
  band?: number;
  /** Snow depth gained per second when {@link SeasonCycle.apply} is given a dt. Default 0.35. */
  accumulationRate?: number;
  /** Snow depth lost per second when melting. Faster than it falls, as thaws go. Default 0.5. */
  meltRate?: number;
}

/** A moment in the year, as {@link SeasonCycle.evaluate} reports it. */
export interface SeasonState {
  /** Phase 0–1 (0 = midwinter, 0.5 = midsummer). */
  phase: number;
  /** 0 in high summer → 1 at the depth of winter. */
  winter: number;
  /** 0 while the year cools → 1 while it warms. See {@link seasonWarming}. */
  warming: number;
  /** Nearest named season, for HUDs. */
  name: 'winter' | 'spring' | 'summer' | 'autumn';
  /** Whole years elapsed since construction. */
  year: number;
}

/**
 * Which way the year is going: 1 at mid-spring, 0 at mid-autumn, 0.5 at both
 * solstices.
 *
 * {@link SeasonState.winter} says how cold it is; this says whether the cold is
 * arriving or leaving — and that is the whole difference between spring and
 * autumn, which pass through identical temperatures in opposite directions. The
 * foliage tint needs it to know whether a half-cooled leaf should be fresh green
 * or gold (see `FOLIAGE_GLSL`).
 *
 * It's a sine rather than a step so nothing pops at the solstices — and the
 * crossover lands exactly where the mid-season color has the least influence,
 * because at midsummer and midwinter the foliage is at one end of its range
 * anyway.
 */
export function seasonWarming(phase: number): number {
  return 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

function approach(current: number, target: number, maxStep: number): number {
  if (target > current) return Math.min(target, current + maxStep);
  return Math.max(target, current - maxStep);
}

/**
 * The year clock, and the pass that turns it into snow on the ground.
 *
 * Deliberately shaped like {@link DayNightCycle} one level up: a 0–1 phase
 * where 0 is the darkest/coldest point and 0.5 the brightest/warmest,
 * `advance(dt)` to run it, `setPhase` to scrub it, `paused` to freeze it.
 *
 * ### The model
 *
 * Seasons don't recompute climate — they *bias* it. The generator's temperature
 * field already folds latitude, elevation, and noise into one 0–1 number per
 * cell, so a season is a single subtraction against it:
 *
 * ```
 * effective = base − amplitude(latitude) · winter
 * ```
 *
 * with `amplitude` interpolating from {@link SeasonOptions.polarAmplitude} at
 * the poles to {@link SeasonOptions.equatorAmplitude} at the equator. Snow lies
 * where `effective` falls under {@link SeasonOptions.snowThreshold}; ice is left
 * to each liquid's own `freezePoint`, since water and acid do not give up at the
 * same cold. Because elevation cooling is already baked into `base`, mountains
 * cross those thresholds first and keep their caps year-round, and the snowline
 * walks down the map through autumn without a line of latitude appearing
 * anywhere in the code.
 *
 * ### …and the other model
 *
 * That is `scope: 'continental'`, and it is right exactly when the map is big
 * enough for one end to have a different climate from the other. On a valley it
 * isn't: a snowline creeping across a few kilometres reads as a bug. So
 * {@link SeasonOptions.scope} `'local'` inverts which term dominates —
 *
 * ```
 * effective = localSummer − localAmplitude · winter + (base − 0.5) · localVariation
 * ```
 *
 * — and the map's own field, which *was* the climate, becomes a small stagger on
 * top of a season the whole map shares. Every cell crosses each threshold within
 * a few days of every other, so a hard winter strips every tree and spring
 * blooms all of them, while the high ground still leads by a little.
 *
 * Nothing downstream knows which model ran. Snow, per-liquid ice, the foliage
 * tint, blossom, precipitation and `climate.snowDepth` all read the same two
 * bytes; the scope only changes what gets written into them.
 *
 * ### Two ways to run it
 *
 * `apply(climate)` snaps every cell to the phase's target — deterministic, and
 * what a turn-based game wants, where one turn is one day. `apply(climate, dt)`
 * eases toward it at {@link SeasonOptions.accumulationRate} and
 * {@link SeasonOptions.meltRate}, so snow builds and thaws over real seconds
 * instead of popping between frames.
 *
 * @example
 * // Real-time: rides the day clock.
 * const seasons = new SeasonCycle({ daysPerYear: 8, dayLength: 120 });
 * seasons.advance(dt);
 * seasons.apply(climate, dt);
 *
 * @example
 * // Turn-based: one hex per day, winter chasing you.
 * seasons.setPhase(dayNumber / DAYS_IN_YEAR);
 * seasons.apply(climate);
 *
 * @example
 * // One valley, one season: the whole map turns together.
 * const seasons = new SeasonCycle({ scope: 'local' });
 */
export class SeasonCycle {
  /** Days in a full year. */
  daysPerYear: number;
  /** Real seconds per day — the day clock's `dayLength`. */
  dayLength: number;
  /** Freeze/unfreeze the phase (setPhase still works while paused). */
  paused: boolean;

  private _phase: number;
  private _year = 0;
  private readonly scope: SeasonScope;
  private readonly polarAmplitude: number;
  private readonly equatorAmplitude: number;
  private readonly localSummer: number;
  private readonly localAmplitude: number;
  private readonly localVariation: number;
  private readonly hemisphere: 'both' | 'north' | 'south';
  private readonly snowThreshold: number;
  private readonly band: number;
  private readonly accumulationRate: number;
  private readonly meltRate: number;

  // Reused output state (evaluate() may be called per frame).
  private readonly state: SeasonState = { phase: 0, winter: 0, warming: 0, name: 'winter', year: 0 };

  constructor(opts: SeasonOptions = {}) {
    this._phase           = SeasonCycle.wrapPhase(opts.phase ?? 0.25);
    this.daysPerYear      = opts.daysPerYear      ?? 8;
    this.dayLength        = opts.dayLength        ?? 120;
    this.paused           = opts.paused           ?? false;
    this.scope            = opts.scope            ?? 'continental';
    this.polarAmplitude   = opts.polarAmplitude   ?? 0.55;
    this.equatorAmplitude = opts.equatorAmplitude ?? 0.08;
    this.localSummer      = opts.localSummer      ?? 0.78;
    this.localAmplitude   = opts.localAmplitude   ?? 0.72;
    this.localVariation   = opts.localVariation   ?? 0.1;
    this.hemisphere       = opts.hemisphere       ?? 'both';
    this.snowThreshold    = opts.snowThreshold    ?? 0.22;
    this.band             = opts.band             ?? 0.1;
    this.accumulationRate = opts.accumulationRate ?? 0.35;
    this.meltRate         = opts.meltRate         ?? 0.5;
  }

  /** Current phase, 0–1 (0 = midwinter, 0.5 = midsummer). */
  get phase(): number { return this._phase; }

  /** Whole years elapsed since construction — incremented as the phase wraps. */
  get year(): number { return this._year; }

  /** Jump the year clock (value wraps into 0–1). Does not touch the year count. */
  setPhase(phase: number): void {
    this._phase = SeasonCycle.wrapPhase(phase);
  }

  /** Advance the phase by whole days — the turn-based entry point. */
  advanceDays(days: number): void {
    if (this.daysPerYear <= 0) return;
    this.step(days / this.daysPerYear);
  }

  /**
   * Advance by dt real seconds, at `dayLength` seconds per day and
   * `daysPerYear` days per year (no-op while paused). Feed it the same dt the
   * {@link DayNightCycle} gets and the two clocks stay locked together.
   */
  advance(dt: number): void {
    if (this.paused || this.dayLength <= 0 || this.daysPerYear <= 0) return;
    this.step(dt / (this.dayLength * this.daysPerYear));
  }

  private step(delta: number): void {
    const next = this._phase + delta;
    this._year += Math.floor(next);
    this._phase = SeasonCycle.wrapPhase(next);
  }

  private static wrapPhase(t: number): number {
    return ((t % 1) + 1) % 1;
  }

  /**
   * The current moment in the year. The returned object is reused across
   * calls — copy anything you keep.
   */
  evaluate(): SeasonState {
    const s = this.state;
    s.phase = this._phase;
    s.year  = this._year;
    // 1 at phase 0 (midwinter), 0 at phase 0.5 (midsummer).
    s.winter  = (Math.cos(this._phase * Math.PI * 2) + 1) * 0.5;
    s.warming = seasonWarming(this._phase);
    s.name = this._phase < 0.125 || this._phase >= 0.875 ? 'winter'
      : this._phase < 0.375 ? 'spring'
      : this._phase < 0.625 ? 'summer'
      : 'autumn';
    return s;
  }

  /**
   * How far the current phase pulls temperature down at a given normalized
   * latitude (0 = pole, 1 = equator). Exposed because gameplay that wants to
   * ask "how cold will it be there in three weeks" should use the same curve
   * the renderer does.
   *
   * Under `'local'` scope the latitude is ignored, which is the whole point of
   * that scope — one map, one season.
   */
  temperatureOffsetAt(latitude: number): number {
    const winter = this.evaluate().winter;
    if (this.scope === 'local') return this.localAmplitude * winter;
    const amplitude = this.polarAmplitude + (this.equatorAmplitude - this.polarAmplitude) * latitude;
    return amplitude * winter;
  }

  /**
   * Rewrites every cell's snow depth and season-adjusted temperature from its
   * base temperature and the current phase, then marks the texture for upload.
   *
   * Snow is eased because it accumulates; temperature is always written exact,
   * because it is a reading rather than a quantity that piles up. Ice is not
   * written at all — each liquid derives its own from the temperature against
   * its `freezePoint`, which is how water can skin over while acid beside it
   * stays liquid.
   *
   * @param dt Real seconds since the last call. Omit to snap the snow straight
   *   to its target (deterministic — the turn-based path). Supply it to ease
   *   toward the target at {@link SeasonOptions.accumulationRate} /
   *   {@link SeasonOptions.meltRate}, so a thaw reads as a thaw.
   */
  apply(climate: ClimateData, dt?: number): void {
    const { winter } = this.evaluate();
    const data   = climate.rawData;
    const width  = climate.width;
    const height = climate.height;
    const band   = Math.max(this.band, 1e-4);

    const eased    = dt !== undefined && dt > 0;
    const snowStep = eased ? this.accumulationRate * dt : 0;
    const meltStep = eased ? this.meltRate * dt : 0;

    const local = this.scope === 'local';
    // Local scope: one temperature for the entire map, swung by the year rather
    // than read off the terrain. The cell's own field is demoted from *the*
    // climate to a stagger on when it turns, so a valley reads as one place
    // having one winter — with a few trees going first.
    const localBase = this.localSummer - this.localAmplitude * winter;

    for (let row = 0; row < height; row++) {
      const latitude  = local ? 0 : latitudeAt(row, height, this.hemisphere);
      const amplitude = this.polarAmplitude + (this.equatorAmplitude - this.polarAmplitude) * latitude;
      const drop      = amplitude * winter;
      const rowBase   = row * width;

      for (let col = 0; col < width; col++) {
        const i    = (rowBase + col) * 4;
        const temp = data[i] / 255;
        // Staggered around the field's midpoint rather than the map's own mean,
        // so the offset is a fixed, predictable ±localVariation/2 — a map with
        // no temperature field at all still turns, uniformly.
        const effective = local
          ? localBase + (temp - 0.5) * this.localVariation
          : temp - drop;

        // Colder than the threshold → deeper snow. smoothstep runs "backwards"
        // (high edge first) so falling temperature raises the value.
        const snowTarget = smoothstep(this.snowThreshold, this.snowThreshold - band, effective);

        if (eased) {
          const snow = data[i + 2] / 255;
          data[i + 2] = Math.round(255 * approach(snow, snowTarget, snowTarget > snow ? snowStep : meltStep));
        } else {
          data[i + 2] = Math.round(snowTarget * 255);
        }

        // Clamped, not wrapped — a hard winter can push the poles below zero.
        data[i + 3] = Math.round(Math.min(Math.max(effective, 0), 1) * 255);
      }
    }

    climate.markDirty();
  }
}

/** Format a 0–1 season phase as a readable label for HUDs, e.g. "Late autumn". */
export function formatSeason(phase: number): string {
  const p = ((phase % 1) + 1) % 1;
  const names = ['winter', 'spring', 'summer', 'autumn'] as const;
  // Each season spans a quarter centred on its solstice/equinox, so shift by an
  // eighth before slicing — midwinter (0) should read as mid-winter, not as the
  // boundary between two seasons.
  const shifted = (p + 0.125) % 1;
  const season  = names[Math.floor(shifted * 4)];
  const within  = (shifted * 4) % 1;
  const stage   = within < 1 / 3 ? 'Early' : within < 2 / 3 ? 'Mid' : 'Late';
  return `${stage} ${season}`;
}
