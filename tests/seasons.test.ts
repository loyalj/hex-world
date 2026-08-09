import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ClimateData } from '../src/season/ClimateData.js';
import {
  DEFAULT_LIQUID_DESCRIPTORS, resolveLiquidMaterials, liquidMaterialList,
} from '../src/geometry/LiquidTypes.js';
import { SeasonCycle, formatSeason } from '../src/season/SeasonCycle.js';
import { computeTemperature, latitudeAt } from '../src/generators/TemperatureModel.js';
import { generateMap } from '../src/generators/MapGenerator.js';
import { HexMap } from '../src/map/HexMap.js';

/** A climate whose temperature ramps 0→1 down the rows, for predictable thresholds. */
function rampClimate(width = 4, height = 16): ClimateData {
  const climate = new ClimateData(width, height);
  const field = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) field[row * width + col] = row / (height - 1);
  }
  climate.setTemperature(field);
  return climate;
}

describe('ClimateData', () => {
  it('round-trips base fields through the 8-bit texture channels', () => {
    const climate = new ClimateData(3, 2);
    const temp = new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.5]);
    const moist = new Float32Array([1, 0.75, 0.5, 0.25, 0, 0.5]);
    climate.setTemperature(temp);
    climate.setMoisture(moist);

    expect(climate.temperature(0, 0)).toBeCloseTo(0, 2);
    expect(climate.temperature(1, 0)).toBeCloseTo(0.25, 2);
    expect(climate.temperature(1, 1)).toBeCloseTo(1, 2);
    expect(climate.moisture(0, 0)).toBeCloseTo(1, 2);
    expect(climate.moisture(2, 1)).toBeCloseTo(0.5, 2);
  });

  it('clamps out-of-range values instead of wrapping', () => {
    const climate = new ClimateData(2, 1);
    climate.setTemperature(new Float32Array([-5, 5]));
    expect(climate.temperature(0, 0)).toBe(0);
    expect(climate.temperature(1, 0)).toBe(1);
  });

  it('rejects a field sized for a different map', () => {
    const climate = new ClimateData(4, 4);
    expect(() => climate.setTemperature(new Float32Array(9))).toThrow(/4×4/);
  });

  it('reads out-of-bounds cells as zero rather than throwing', () => {
    const climate = rampClimate();
    expect(climate.temperature(-1, 0)).toBe(0);
    expect(climate.snowDepth(0, 999)).toBe(0);
    expect(climate.isFrozen(999, 999)).toBe(false);
  });

  it('lays the four channels out as R=base temp G=moisture B=snow A=season temp', () => {
    const climate = new ClimateData(1, 1);
    climate.setTemperature(new Float32Array([1]));
    climate.setMoisture(new Float32Array([1]));
    climate.setSnowDepth(0, 0, 1);
    climate.setEffectiveTemperature(0, 0, 1);
    expect(Array.from(climate.rawData)).toEqual([255, 255, 255, 255]);

    climate.setSnowDepth(0, 0, 0);
    expect(climate.rawData[2]).toBe(0);
    expect(climate.rawData[0]).toBe(255); // base tier untouched
  });

  it('tracks dirtiness so update() only uploads when something changed', () => {
    const climate = new ClimateData(2, 2);
    climate.update();
    expect(climate.needsUpdate).toBe(false);

    climate.setSnowDepth(0, 0, 0.5);
    expect(climate.needsUpdate).toBe(true);
    climate.update();
    expect(climate.needsUpdate).toBe(false);

    climate.setSnowDepth(0, 0, 0.5); // same value — no re-upload
    expect(climate.needsUpdate).toBe(false);
  });
});

describe('ClimateData persistence', () => {
  it('round-trips the seasonal tier and leaves the base tier alone', () => {
    const climate = rampClimate();
    new SeasonCycle({ phase: 0 }).apply(climate);
    const before = Array.from(climate.rawData);
    const blob = climate.toBase64();

    const restored = rampClimate();
    restored.loadBase64(blob);
    expect(Array.from(restored.rawData)).toEqual(before);
  });

  it('restores snow onto a base tier rebuilt by fromMap', () => {
    const map = new HexMap({ width: 24, height: 24 });
    generateMap(map, {}, 7);
    const climate = ClimateData.fromMap(map, { jitterChannel: 2 });
    new SeasonCycle({ phase: 0 }).apply(climate);
    const blob = climate.toBase64();

    // The load path: rebuild the base tier from the saved options, then
    // replay the seasonal tier over it.
    const reloaded = ClimateData.fromMap(map, climate.temperatureOptions ?? {});
    reloaded.loadBase64(blob);
    expect(Array.from(reloaded.rawData)).toEqual(Array.from(climate.rawData));
  });

  it('run-length encodes a bare summer map to a few bytes', () => {
    const climate = rampClimate(64, 64);
    climate.clearSeasonal();
    expect(climate.serialize().byteLength).toBeLessThan(32);
  });

  it('clearSeasonal wipes the seasonal tier but keeps temperature and moisture', () => {
    const climate = rampClimate();
    new SeasonCycle({ phase: 0 }).apply(climate);
    const temp = climate.temperature(0, 5);
    climate.clearSeasonal();
    expect(climate.snowDepth(0, 5)).toBe(0);
    expect(climate.effectiveTemperature(0, 5)).toBe(0);
    expect(climate.temperature(0, 5)).toBe(temp);
  });

  it('rejects foreign, future-version, and wrong-sized blobs', () => {
    const climate = new ClimateData(4, 4);
    expect(() => climate.load(new Uint8Array(4))).toThrow(/too short/);
    expect(() => climate.load(new Uint8Array(20))).toThrow(/magic bytes/);

    const future = climate.serialize();
    future[4] = 99;
    expect(() => climate.load(future)).toThrow(/version 99/);

    const other = new ClimateData(8, 8).serialize();
    expect(() => climate.load(other)).toThrow(/8×8 map/);
  });
});

describe('SeasonCycle clock', () => {
  it('runs 0 = midwinter to 0.5 = midsummer, matching the day clock convention', () => {
    const seasons = new SeasonCycle({ phase: 0 });
    expect(seasons.evaluate().winter).toBeCloseTo(1);
    expect(seasons.evaluate().name).toBe('winter');

    seasons.setPhase(0.5);
    expect(seasons.evaluate().winter).toBeCloseTo(0);
    expect(seasons.evaluate().name).toBe('summer');

    seasons.setPhase(0.25);
    expect(seasons.evaluate().winter).toBeCloseTo(0.5);
    expect(seasons.evaluate().name).toBe('spring');
  });

  it('advance(dt) walks a year in dayLength · daysPerYear seconds', () => {
    const seasons = new SeasonCycle({ phase: 0, dayLength: 10, daysPerYear: 4 });
    seasons.advance(20); // half a year
    expect(seasons.phase).toBeCloseTo(0.5);
    expect(seasons.year).toBe(0);
    seasons.advance(20); // wraps
    expect(seasons.phase).toBeCloseTo(0, 5);
    expect(seasons.year).toBe(1);
  });

  it('advanceDays is the turn-based entry point', () => {
    const seasons = new SeasonCycle({ phase: 0, daysPerYear: 8 });
    seasons.advanceDays(2);
    expect(seasons.phase).toBeCloseTo(0.25);
    seasons.advanceDays(8);
    expect(seasons.phase).toBeCloseTo(0.25);
    expect(seasons.year).toBe(1);
  });

  it('respects paused and wraps negative phases', () => {
    const seasons = new SeasonCycle({ phase: 0.3, paused: true, dayLength: 10, daysPerYear: 1 });
    seasons.advance(100);
    expect(seasons.phase).toBeCloseTo(0.3);
    seasons.setPhase(-0.25);
    expect(seasons.phase).toBeCloseTo(0.75);
  });

  it('formatSeason centres each season on its solstice', () => {
    expect(formatSeason(0)).toBe('Mid winter');
    expect(formatSeason(0.5)).toBe('Mid summer');
    expect(formatSeason(0.75)).toBe('Mid autumn');
  });
});

describe("SeasonCycle scope: 'local'", () => {
  /** Season-adjusted temperature across every cell, at a given phase. */
  const temps = (climate: ClimateData, seasons: SeasonCycle, phase: number): number[] => {
    seasons.setPhase(phase);
    seasons.apply(climate);
    const out: number[] = [];
    for (let row = 0; row < climate.height; row++) {
      for (let col = 0; col < climate.width; col++) out.push(climate.effectiveTemperature(col, row));
    }
    return out;
  };

  it('gives the whole map one season, where continental scope spreads it out', () => {
    const climate = rampClimate(1, 64);
    const spring  = temps(climate, new SeasonCycle({ scope: 'local' }), 0.25);
    const spread  = Math.max(...spring) - Math.min(...spring);

    const wide = temps(rampClimate(1, 64), new SeasonCycle({}), 0.25);
    const wideSpread = Math.max(...wide) - Math.min(...wide);

    // The map's own field is demoted to a stagger, so what was the climate is
    // now a rounding error beside it.
    expect(spread).toBeLessThan(0.15);
    expect(wideSpread).toBeGreaterThan(spread * 3);
  });

  it('strips every tree by midwinter and greens every one by midsummer', () => {
    const climate = rampClimate(1, 64);
    const seasons = new SeasonCycle({ scope: 'local' });

    // The thresholds the foliage tint uses (FOLIAGE_GLSL defaults).
    const BARE = 0.26, GREEN = 0.5;
    expect(Math.max(...temps(climate, seasons, 0))).toBeLessThan(BARE);
    expect(Math.min(...temps(climate, seasons, 0.5))).toBeGreaterThan(GREEN);
  });

  it('buries the whole map in snow at midwinter and clears all of it by midsummer', () => {
    const climate = rampClimate(1, 64);
    const seasons = new SeasonCycle({ scope: 'local' });

    seasons.setPhase(0);
    seasons.apply(climate);
    for (let row = 0; row < 64; row++) expect(climate.snowDepth(0, row)).toBeGreaterThan(0.9);

    seasons.setPhase(0.5);
    seasons.apply(climate);
    for (let row = 0; row < 64; row++) expect(climate.snowDepth(0, row)).toBe(0);
  });

  it('still staggers the turn, so the map does not flip on one frame', () => {
    const climate = rampClimate(1, 64);
    // Mid-autumn, partway through the turn — where a stagger is visible at all.
    const mid = temps(climate, new SeasonCycle({ scope: 'local' }), 0.72);
    expect(Math.max(...mid) - Math.min(...mid)).toBeGreaterThan(0.02);

    // …and none at all when asked for none.
    const flat = temps(rampClimate(1, 64), new SeasonCycle({ scope: 'local', localVariation: 0 }), 0.72);
    expect(Math.max(...flat) - Math.min(...flat)).toBeCloseTo(0, 2);
  });

  it('turns a map with no temperature field at all, where continental scope cannot', () => {
    // Nothing has written the base field — every cell reads 0.
    const bare = new ClimateData(4, 4);
    const seasons = new SeasonCycle({ scope: 'local' });
    seasons.setPhase(0.5);
    seasons.apply(bare);
    expect(bare.effectiveTemperature(0, 0)).toBeGreaterThan(0.5); // summer
    expect(bare.snowDepth(0, 0)).toBe(0);

    // Continental scope reads that empty field as a frozen world, correctly —
    // it has no other source of truth.
    const same = new ClimateData(4, 4);
    new SeasonCycle({ phase: 0.5 }).apply(same);
    expect(same.snowDepth(0, 0)).toBeGreaterThan(0.9);
  });

  it('reports the same offset at every latitude, unlike continental scope', () => {
    const local = new SeasonCycle({ scope: 'local', phase: 0 });
    expect(local.temperatureOffsetAt(0)).toBeCloseTo(local.temperatureOffsetAt(1), 6);

    const wide = new SeasonCycle({ phase: 0 });
    expect(wide.temperatureOffsetAt(0)).toBeGreaterThan(wide.temperatureOffsetAt(1));
  });
});

describe('SeasonCycle.apply', () => {
  it('lays snow on cold cells and leaves warm ones bare', () => {
    const climate = rampClimate();
    new SeasonCycle({ phase: 0.5 }).apply(climate); // midsummer: no seasonal drop

    expect(climate.snowDepth(0, 0)).toBeCloseTo(1, 1);   // coldest row
    expect(climate.snowDepth(0, 15)).toBe(0);            // warmest row
  });

  it('drives the snowline toward the equator as winter deepens', () => {
    const climate = rampClimate(1, 64);
    const seasons = new SeasonCycle({ hemisphere: 'south' });

    const snowline = (): number => {
      for (let row = 0; row < 64; row++) if (climate.snowDepth(0, row) < 0.5) return row;
      return 64;
    };

    seasons.setPhase(0.5); seasons.apply(climate);
    const summer = snowline();
    seasons.setPhase(0.25); seasons.apply(climate);
    const spring = snowline();
    seasons.setPhase(0); seasons.apply(climate);
    const winter = snowline();

    expect(summer).toBeLessThan(spring);
    expect(spring).toBeLessThan(winter);
  });

  it('swings the poles far more than the equator', () => {
    const climate = new ClimateData(1, 3);
    // Equal base temperature at three latitudes; only the amplitude differs.
    climate.setTemperature(new Float32Array([0.5, 0.5, 0.5]));
    const seasons = new SeasonCycle({ phase: 0, hemisphere: 'south', snowThreshold: 0.5, band: 0.5 });
    seasons.apply(climate);

    // hemisphere 'south': row 0 is the pole, row 2 the equator.
    expect(climate.snowDepth(0, 0)).toBeGreaterThan(climate.snowDepth(0, 2));
  });

  it('writes the season-adjusted temperature, clamped at zero', () => {
    const climate = rampClimate(1, 8);
    const seasons = new SeasonCycle({ phase: 0, hemisphere: 'south' });
    seasons.apply(climate);

    for (let row = 0; row < 8; row++) {
      const base = climate.temperature(0, row);
      const drop = seasons.temperatureOffsetAt(latitudeAt(row, 8, 'south'));
      expect(climate.effectiveTemperature(0, row))
        .toBeCloseTo(Math.max(0, base - drop), 1);
    }
  });

  it('cools every cell in winter and restores it in summer', () => {
    const climate = rampClimate(1, 8);
    const seasons = new SeasonCycle({ hemisphere: 'south' });

    seasons.setPhase(0.5); seasons.apply(climate);
    const summer = climate.effectiveTemperature(0, 6);
    seasons.setPhase(0); seasons.apply(climate);
    const winter = climate.effectiveTemperature(0, 6);

    expect(winter).toBeLessThan(summer);
    // Midsummer applies no drop at all, so it reads back as the base field.
    expect(summer).toBeCloseTo(climate.temperature(0, 6), 2);
  });

  it('snaps without a dt and eases with one', () => {
    const snap = rampClimate();
    const eased = rampClimate();
    const seasons = new SeasonCycle({ phase: 0, accumulationRate: 0.1 });

    seasons.apply(snap);
    seasons.apply(eased, 1); // one second at 0.1/s

    expect(snap.snowDepth(0, 0)).toBeCloseTo(1, 1);
    expect(eased.snowDepth(0, 0)).toBeCloseTo(0.1, 1);
  });

  it('melts faster than it accumulates, and settles at the target', () => {
    const climate = rampClimate();
    const seasons = new SeasonCycle({ phase: 0, accumulationRate: 0.25, meltRate: 0.5 });
    // Row 5 is mid-latitude: buried in winter, bare in summer. Row 0 is cold
    // enough to hold its snow year-round, which is the point of the model but
    // makes it useless for watching a thaw.
    for (let i = 0; i < 20; i++) seasons.apply(climate, 1);
    const deep = climate.snowDepth(0, 5);
    expect(deep).toBeCloseTo(1, 1); // settles at the target, doesn't overshoot

    seasons.setPhase(0.5);
    seasons.apply(climate, 1);
    expect(climate.snowDepth(0, 5)).toBeLessThan(deep - 0.4); // 0.5/s melt, not 0.25
  });

  it('keeps snow on the coldest ground through high summer', () => {
    const climate = rampClimate();
    new SeasonCycle({ phase: 0.5 }).apply(climate);
    expect(climate.snowDepth(0, 0)).toBeCloseTo(1, 1);
    expect(climate.snowDepth(0, 5)).toBe(0);
  });

  it('marks the texture dirty so a caller only has to run update()', () => {
    const climate = rampClimate();
    climate.update();
    new SeasonCycle({ phase: 0 }).apply(climate);
    expect(climate.needsUpdate).toBe(true);
  });

  it('temperatureOffsetAt agrees with the field the pass writes', () => {
    const climate = new ClimateData(1, 2);
    climate.setTemperature(new Float32Array([0.5, 0.5]));
    const seasons = new SeasonCycle({ phase: 0, hemisphere: 'south', snowThreshold: 1, band: 1 });
    seasons.apply(climate);

    for (const row of [0, 1]) {
      const lat = latitudeAt(row, 2, 'south');
      const effective = 0.5 - seasons.temperatureOffsetAt(lat);
      // band 1, threshold 1 → smoothstep(1, 0, effective), the pass's formula.
      const t = Math.min(Math.max(effective, 0), 1);
      const expected = 1 - (t * t * (3 - 2 * t));
      expect(climate.snowDepth(0, row)).toBeCloseTo(expected, 1);
    }
  });
});

describe('per-liquid freezing', () => {
  /** A single cell sitting at a known season-adjusted temperature. */
  function atTemperature(t: number): ClimateData {
    const climate = new ClimateData(1, 1);
    climate.setEffectiveTemperature(0, 0, t);
    return climate;
  }

  it('lets each liquid freeze at its own point', () => {
    const climate = atTemperature(0.08);
    // Cold enough for water (0.12) but not for a liquid that only seizes at 0.03.
    expect(climate.isFrozen(0, 0, 0.12)).toBe(true);
    expect(climate.isFrozen(0, 0, 0.03)).toBe(false);
  });

  it('never freezes a liquid without a freeze point', () => {
    const climate = atTemperature(0);
    expect(climate.isFrozen(0, 0, undefined)).toBe(false);
    expect(climate.isFrozen(0, 0, -1)).toBe(false);
  });

  it('gives water a freeze point and leaves lava and acid without one', () => {
    const byId = new Map(DEFAULT_LIQUID_DESCRIPTORS.map(d => [d.id, d]));
    expect(byId.get('water')!.freezePoint).toBeGreaterThan(0);
    expect(byId.get('lava')!.freezePoint).toBeUndefined();
    expect(byId.get('acid')!.freezePoint).toBeUndefined();
  });

  it('carries the freeze point onto every material in the set', () => {
    const water = resolveLiquidMaterials(
      DEFAULT_LIQUID_DESCRIPTORS.find(d => d.id === 'water')!,
    );
    for (const mat of liquidMaterialList(water)) {
      const u = (mat as THREE.ShaderMaterial | undefined)?.uniforms;
      expect(u?.uFreezePoint?.value).toBeCloseTo(0.12);
      expect(u?.uSeasonEnabled?.value).toBe(0); // inert until configureSeason
    }
  });

  it('marks lava and acid materials as never freezing', () => {
    for (const id of ['lava', 'acid']) {
      const set = resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS.find(d => d.id === id)!);
      for (const mat of liquidMaterialList(set)) {
        const u = (mat as THREE.ShaderMaterial | undefined)?.uniforms;
        expect(u?.uFreezePoint?.value).toBeLessThan(0);
      }
    }
  });

  it('honours a custom freeze point, band, and ice styling', () => {
    const set = resolveLiquidMaterials({
      id: 'brine', name: 'Brine',
      freezePoint: 0.4, freezeBand: 0.2, iceColor: 0x112233, iceOpacity: 0.5,
    });
    const u = (set.surface as THREE.ShaderMaterial).uniforms;
    expect(u.uFreezePoint.value).toBeCloseTo(0.4);
    expect(u.uFreezeBand.value).toBeCloseTo(0.2);
    expect(u.uIceOpacity.value).toBeCloseTo(0.5);
    expect((u.uIceColor.value as THREE.Color).getHex()).toBe(0x112233);
  });

  it('derives ice in the shader from the temperature and the freeze point', () => {
    const set = resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0]);
    const surface = set.surface as THREE.ShaderMaterial;
    // The freeze decision lives in the vertex stage, against the A channel…
    expect(surface.vertexShader).toContain('uFreezePoint');
    expect(surface.vertexShader).toContain('_cd.a');
    // …and the result reaches the shared output path.
    expect(surface.fragmentShader).toContain('liquidOutput(color, vVisibility, vExplored, vWorldXZ, vIce)');
  });

  it('keeps the pre-seasons liquidOutput signature compiling', () => {
    const surface = resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0]).surface as THREE.ShaderMaterial;
    expect(surface.fragmentShader)
      .toContain('vec4 liquidOutput(vec3 color, float visibility, float explored, vec2 worldXZ) {');
  });
});

describe('generator integration', () => {
  it('fills a ClimateData handed to generateMap, and records how to rebuild it', () => {
    const map = new HexMap({ width: 32, height: 32 });
    const climate = new ClimateData(32, 32);
    generateMap(map, { climateData: climate }, 42);

    expect(climate.temperatureOptions).not.toBeNull();
    expect(climate.temperatureOptions!.jitterChannel).toBeGreaterThanOrEqual(0);
    expect(climate.temperatureOptions!.jitterChannel).toBeLessThan(4);

    // Base tier is populated and varies across the map.
    const values = new Set<number>();
    for (let row = 0; row < 32; row++) values.add(climate.temperature(0, row));
    expect(values.size).toBeGreaterThan(1);

    // Seasonal tier is untouched by generation.
    expect(climate.snowDepth(0, 0)).toBe(0);
    expect(climate.effectiveTemperature(0, 0)).toBe(0);
  });

  it('recomputes the identical field from the recorded options', () => {
    const map = new HexMap({ width: 24, height: 24 });
    const climate = new ClimateData(24, 24);
    generateMap(map, { climateData: climate }, 99);

    const rebuilt = ClimateData.fromMap(map, climate.temperatureOptions!);
    for (let row = 0; row < 24; row++) {
      for (let col = 0; col < 24; col++) {
        expect(rebuilt.temperature(col, row)).toBe(climate.temperature(col, row));
      }
    }
  });

  it('does not change generated maps for callers that ignore climate', () => {
    const withClimate = new HexMap({ width: 24, height: 24 });
    const without = new HexMap({ width: 24, height: 24 });
    generateMap(withClimate, { climateData: new ClimateData(24, 24) }, 1234);
    generateMap(without, {}, 1234);

    for (let row = 0; row < 24; row++) {
      for (let col = 0; col < 24; col++) {
        expect(withClimate.getTerrain(col, row)).toBe(without.getTerrain(col, row));
        expect(withClimate.getElevation(col, row)).toBe(without.getElevation(col, row));
      }
    }
  });
});

describe('latitudeAt', () => {
  it('agrees with the temperature field it feeds', () => {
    // A flat sea-level map with no jitter: temperature IS latitude.
    const map = new HexMap({ width: 2, height: 9 });
    const temp = computeTemperature(map, { temperatureJitter: 0, hemisphere: 'both' });
    for (let row = 0; row < 9; row++) {
      expect(temp[row * 2]).toBeCloseTo(latitudeAt(row, 9, 'both'), 5);
    }
  });

  it('places the equator per hemisphere', () => {
    expect(latitudeAt(0, 10, 'south')).toBeCloseTo(0);   // top = pole
    expect(latitudeAt(9, 10, 'south')).toBeCloseTo(0.9); // bottom = equator
    expect(latitudeAt(0, 10, 'north')).toBeCloseTo(1);   // top = equator
    expect(latitudeAt(5, 10, 'both')).toBeCloseTo(1);    // centre = equator
  });
});
