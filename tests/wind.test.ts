import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Wind, setMaterialWind } from '../src/weather/Wind.js';
import {
  attachWindSway, hasWindSway, styleWindSway, setWindSwayEnabled,
  windSwayUniforms, WIND_SWAY_GLSL, WIND_SWAY_VERT_BODY,
} from '../src/weather/WindSway.js';
import { attachSnow } from '../src/season/SnowAttach.js';
import { attachAtmosphere } from '../src/sky/Atmosphere.js';
import { WeatherSystem } from '../src/weather/WeatherSystem.js';
import { PrecipitationLayer } from '../src/weather/Precipitation.js';
import { createTerrainMaterial } from '../src/geometry/TerrainMaterial.js';
import { resolveLiquidMaterials, DEFAULT_LIQUID_DESCRIPTORS } from '../src/geometry/LiquidTypes.js';

function makeTerrainMaterial(): THREE.ShaderMaterial {
  const tex = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
  return createTerrainMaterial(tex);
}

describe('Wind', () => {
  it('reads back the polar form it was given', () => {
    const wind = new Wind({ heading: Math.PI / 2, speed: 4 });
    expect(wind.speed).toBeCloseTo(4);
    expect(wind.heading).toBeCloseTo(Math.PI / 2);
    expect(wind.base.x).toBeCloseTo(0);
    expect(wind.base.y).toBeCloseTo(4);
  });

  it('surface tracks base immediately, before anything has been advanced', () => {
    // Otherwise a WeatherSystem that is never advanced would hand its
    // precipitation a zero wind and the rain would fall straight down.
    const wind = new Wind({ vector: new THREE.Vector2(3, 4) });
    expect(wind.surface.length()).toBeCloseTo(5);
    expect(wind.gust).toBe(1);
  });

  it('gusts either side of the sustained wind without ever reversing', () => {
    const wind = new Wind({ speed: 4, heading: 0, gustiness: 0.5, gustPeriod: 3, turbulence: 0 });
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < 600; i++) {
      wind.advance(1 / 60);
      min = Math.min(min, wind.gust);
      max = Math.max(max, wind.gust);
      expect(wind.gust).toBeGreaterThanOrEqual(0);
      // Sustained wind is untouched by the gust riding on it.
      expect(wind.base.length()).toBeCloseTo(4);
    }
    expect(min).toBeLessThan(0.8);
    expect(max).toBeGreaterThan(1.2);
  });

  it('gustiness 0 is a dead-steady breeze', () => {
    const wind = new Wind({ speed: 3, heading: 0, gustiness: 0, turbulence: 0 });
    for (let i = 0; i < 100; i++) wind.advance(1 / 60);
    expect(wind.gust).toBeCloseTo(1);
    expect(wind.surface.x).toBeCloseTo(3);
    expect(wind.surface.y).toBeCloseTo(0);
  });

  it('turbulence wanders the surface direction while base holds its heading', () => {
    const wind = new Wind({ speed: 4, heading: 0, gustiness: 0, turbulence: 0.3 });
    let maxSwing = 0;
    for (let i = 0; i < 900; i++) {
      wind.advance(1 / 60);
      maxSwing = Math.max(maxSwing, Math.abs(Math.atan2(wind.surface.y, wind.surface.x)));
      expect(wind.heading).toBeCloseTo(0);
    }
    expect(maxSwing).toBeGreaterThan(0.2);
    expect(maxSwing).toBeLessThanOrEqual(0.3 + 1e-6);
  });

  it('phase only ever advances, even as the wind rises and falls', () => {
    // Recovering phase as `time × rate` in the shader would run the sway
    // backwards every time the wind picked up; this is why it is integrated.
    const wind = new Wind({ speed: 1, gustiness: 0.6, gustPeriod: 2 });
    let last = wind.phase;
    for (let i = 0; i < 400; i++) {
      wind.advance(1 / 60);
      if (i === 200) wind.setPolar(0, 12); // a squall hits mid-run
      expect(wind.phase).toBeGreaterThan(last);
      last = wind.phase;
    }
  });

  it('keeps swaying on a still day, and faster in a wind', () => {
    const calm = new Wind({ speed: 0, gustiness: 0 });
    const blow = new Wind({ speed: 5, gustiness: 0, referenceSpeed: 5 });
    for (let i = 0; i < 60; i++) { calm.advance(1 / 60); blow.advance(1 / 60); }
    expect(calm.phase).toBeGreaterThan(0);          // not frozen solid
    expect(blow.phase).toBeGreaterThan(calm.phase * 2);
  });

  it('strength is speed against the reference, capped so a gale cannot fold a tree over', () => {
    const wind = new Wind({ speed: 5, gustiness: 0, turbulence: 0, referenceSpeed: 5 });
    expect(wind.strength).toBeCloseTo(1);
    wind.setPolar(0, 500);
    expect(wind.strength).toBe(2);
  });

  it('water drift integrates the surface wind rather than snapping to it', () => {
    const wind = new Wind({ heading: 0, speed: 4, gustiness: 0, turbulence: 0, waterDrift: 0.25 });
    wind.advance(1);
    expect(wind.drift.x).toBeCloseTo(1); // 4 u/s × 0.25 × 1 s
    // Turning the wind bends the trail on from where it was, never teleports it.
    wind.setPolar(Math.PI / 2, 4);
    wind.advance(1);
    expect(wind.drift.x).toBeCloseTo(1);
    expect(wind.drift.y).toBeCloseTo(1);
  });

  it('wraps phase on a whole turn, so a long session keeps float precision', () => {
    const wind = new Wind({ speed: 5 });
    for (let i = 0; i < 20000; i++) wind.advance(0.25);
    expect(wind.phase).toBeLessThan(Math.PI * 2 * 1024);
    // Wrapped on a multiple of 2π, so sin() of it is continuous across the seam.
    expect(Math.abs(wind.phase % (Math.PI * 2))).toBeLessThan(Math.PI * 2);
  });
});

describe('setMaterialWind', () => {
  it('reaches sway materials and liquid materials in one pass, skipping the rest', () => {
    const plant = new THREE.MeshLambertMaterial();
    attachWindSway(plant);
    const water = resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0]).surface as THREE.ShaderMaterial;
    const terrain = makeTerrainMaterial(); // carries no wind uniforms at all
    const plain = new THREE.MeshBasicMaterial();

    const wind = new Wind({ heading: 0, speed: 5, gustiness: 0, turbulence: 0, referenceSpeed: 5 });
    wind.advance(1);
    expect(() => setMaterialWind([plant, water, terrain, plain, null], wind)).not.toThrow();

    const u = plant.userData.hexWorldWind as Record<string, THREE.IUniform>;
    expect((u.uWindDir.value as THREE.Vector2).x).toBeCloseTo(1);
    expect(u.uWindStrength.value).toBeCloseTo(1);
    expect(u.uWindPhase.value).toBe(wind.phase);
    expect(u.uWindWave.value).toBeCloseTo(wind.waveNumber);

    expect((water.uniforms.uWindDrift.value as THREE.Vector2).x).toBeCloseTo(wind.drift.x);
    expect(water.uniforms.uWindChop.value).toBeCloseTo(1);
  });

  it('direction is a unit vector — magnitude travels as strength', () => {
    const plant = new THREE.MeshLambertMaterial();
    attachWindSway(plant);
    const wind = new Wind({ heading: 0, speed: 40, gustiness: 0, turbulence: 0 });
    setMaterialWind([plant], wind);
    const dir = (plant.userData.hexWorldWind as Record<string, THREE.IUniform>).uWindDir.value as THREE.Vector2;
    expect(dir.length()).toBeCloseTo(1);
  });

  it('chop is capped at 1 even when strength runs past it into a storm', () => {
    const water = resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0]).surface as THREE.ShaderMaterial;
    const wind = new Wind({ heading: 0, speed: 100, referenceSpeed: 5 });
    setMaterialWind([water], wind);
    expect(wind.strength).toBe(2);
    expect(water.uniforms.uWindChop.value).toBe(1);
  });

  it('null stills everything rather than freezing it mid-lean', () => {
    const plant = new THREE.MeshLambertMaterial();
    attachWindSway(plant);
    const water = resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0]).surface as THREE.ShaderMaterial;
    const wind = new Wind({ heading: 0, speed: 5 });
    wind.advance(2);
    setMaterialWind([plant, water], wind);

    setMaterialWind([plant, water], null);
    expect((plant.userData.hexWorldWind as Record<string, THREE.IUniform>).uWindStrength.value).toBe(0);
    expect((water.uniforms.uWindDrift.value as THREE.Vector2).lengthSq()).toBe(0);
    expect(water.uniforms.uWindChop.value).toBe(0);
  });
});

describe('attachWindSway (stock three materials)', () => {
  /** Run a patched material's hook over three's real chunk sources. */
  const compile = (mat: THREE.Material, lib = THREE.ShaderLib.lambert) => {
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: lib.vertexShader,
      fragmentShader: lib.fragmentShader,
    };
    mat.onBeforeCompile(shader as never, null as never);
    return shader;
  };

  it('bends transformed after <begin_vertex>, ahead of everything that reads it', () => {
    // The chunk we splice against must still exist in this three version.
    expect(THREE.ShaderLib.lambert.vertexShader).toContain('#include <begin_vertex>');

    const mat = new THREE.MeshLambertMaterial();
    attachWindSway(mat);
    expect(hasWindSway(mat)).toBe(true);
    const shader = compile(mat);

    expect(shader.vertexShader).toContain('transformed += offset;');
    const beginAt   = shader.vertexShader.indexOf('#include <begin_vertex>');
    const swayAt    = shader.vertexShader.indexOf('transformed += offset;');
    const projectAt = shader.vertexShader.indexOf('#include <project_vertex>');
    expect(swayAt).toBeGreaterThan(beginAt);
    expect(swayAt).toBeLessThan(projectAt);
    // Untouched fragment side: a sway is geometry, not shading.
    expect(shader.fragmentShader).toBe(THREE.ShaderLib.lambert.fragmentShader);
  });

  it('folds the instance basis in, so a rotated tree still bends downwind', () => {
    const mat = new THREE.MeshLambertMaterial();
    attachWindSway(mat);
    const shader = compile(mat);
    // Scatter instances carry a random Y rotation; the world wind has to come
    // back through it. `v * m` is the transpose, which for a rotation is the
    // inverse — and avoids an inverse() the GLSL1 path does not have.
    expect(shader.vertexShader).toContain('swayBasis   = swayBasis * mat3(instanceMatrix);');
    expect(shader.vertexShader).toContain('vec3 windObj = vec3(uWindDir.x, 0.0, uWindDir.y) * swayBasis;');
    expect(shader.vertexShader).toContain('#ifdef USE_INSTANCING');
  });

  it('phases the gust off the plant position projected on the wind, so the wave travels', () => {
    const mat = new THREE.MeshLambertMaterial();
    attachWindSway(mat);
    const shader = compile(mat);
    expect(shader.vertexShader).toContain('uWindPhase - dot(swayOrigin.xz, uWindDir) * uWindWave');
    // Height above the base drives the bend, so the trunk stays planted.
    expect(shader.vertexShader).toContain('pow(rel, max(uSwayStiffness, 1e-3))');
  });

  it('exposes every uniform the injected code reads', () => {
    const mat = new THREE.MeshLambertMaterial();
    attachWindSway(mat);
    const shader = compile(mat);
    for (const name of [
      'uWindDir', 'uWindStrength', 'uWindPhase', 'uWindWave',
      'uSwayEnabled', 'uSwayAmplitude', 'uSwayStiffness', 'uSwayHeight', 'uSwayFlutter',
    ]) {
      expect(shader.uniforms[name], name).toBeDefined();
      // Bound on the JS side is only half of it — an undeclared uniform is a
      // compile error, and a declared-but-unbound one silently reads zero.
      expect(shader.vertexShader, name).toMatch(new RegExp(`uniform\\s+\\w+\\s+${name};`));
    }
  });

  it('declares and binds every uniform the body actually reads', () => {
    // A uniform used but not declared is a compile error; one declared but not
    // bound silently reads zero and the wind quietly stops. Neither shows up in
    // a splice test, so check the body against itself.
    const used = new Set(WIND_SWAY_VERT_BODY.match(/\bu(?:Wind|Sway)[A-Za-z]+\b/g) ?? []);
    expect(used.size).toBeGreaterThan(4);
    const declared = windSwayUniforms();
    for (const name of used) {
      expect(WIND_SWAY_GLSL, `${name} declared`).toMatch(new RegExp(`uniform\\s+\\w+\\s+${name};`));
      expect(declared[name], `${name} bound`).toBeDefined();
    }
  });

  it('keeps an existing onBeforeCompile working and does not share its program', () => {
    let priorRan = false;
    const mat = new THREE.MeshLambertMaterial();
    mat.onBeforeCompile = () => { priorRan = true; };
    attachWindSway(mat);
    compile(mat);
    expect(priorRan).toBe(true);

    const other = new THREE.MeshLambertMaterial();
    attachWindSway(other);
    expect(mat.customProgramCacheKey()).not.toBe(other.customProgramCacheKey());
    expect(mat.customProgramCacheKey()).toContain('hex-world-wind-sway');
  });

  it('composes with snow and haze on one material without either losing its patch', () => {
    const mat = new THREE.MeshLambertMaterial({ color: 0x5e8c2a });
    attachWindSway(mat, { height: 1.9 });
    attachSnow(mat);
    attachAtmosphere(mat);
    const shader = compile(mat);

    expect(shader.vertexShader).toContain('transformed += offset;');       // sway
    expect(shader.vertexShader).toContain('attribute float cellIndex;');   // snow
    expect(shader.vertexShader).toContain('vAtmoWorldXZ');                 // haze
    expect(shader.uniforms.uSwayAmplitude).toBeDefined();
    expect(shader.uniforms.uSnowColor).toBeDefined();
    expect(shader.uniforms.uAtmoEnabled).toBeDefined();
    // Three distinct patches, one program key.
    const key = mat.customProgramCacheKey();
    expect(key).toContain('hex-world-wind-sway');
    expect(key).toContain('hex-world-snow');
    expect(key).toContain('hex-world-atmosphere');
  });

  it('is idempotent — a second call restyles instead of rebinding', () => {
    const mat = new THREE.MeshLambertMaterial();
    attachWindSway(mat, { amplitude: 0.1 });
    const u = mat.userData.hexWorldWind as Record<string, THREE.IUniform>;
    attachWindSway(mat, { amplitude: 0.4 });
    expect(mat.userData.hexWorldWind).toBe(u); // same objects, still bound
    expect(u.uSwayAmplitude.value).toBeCloseTo(0.4);
  });

  it('styling and the enable gate survive the per-frame wind push', () => {
    const mat = new THREE.MeshLambertMaterial();
    attachWindSway(mat);
    styleWindSway(mat, { amplitude: 0.2, stiffness: 3, height: 4, flutter: 0.1 });
    const u = mat.userData.hexWorldWind as Record<string, THREE.IUniform>;
    expect(u.uSwayAmplitude.value).toBeCloseTo(0.2);
    expect(u.uSwayHeight.value).toBe(4);

    setWindSwayEnabled(mat, false);
    const wind = new Wind({ speed: 5 });
    wind.advance(1);
    setMaterialWind([mat], wind);
    // The gate is its own uniform precisely so the push can't undo it.
    expect(u.uSwayEnabled.value).toBe(0);
    expect(u.uSwayAmplitude.value).toBeCloseTo(0.2);
    setWindSwayEnabled(mat, true);
    expect(u.uSwayEnabled.value).toBe(1);
  });

  it('styling a material that never got the patch is a no-op, not a throw', () => {
    const rock = new THREE.MeshLambertMaterial();
    expect(hasWindSway(rock)).toBe(false);
    expect(() => styleWindSway(rock, { amplitude: 0.5 })).not.toThrow();
    expect(() => setWindSwayEnabled(rock, false)).not.toThrow();
  });
});

describe('liquid materials under wind', () => {
  it('every liquid layer declares the wind uniforms and sits at zero until driven', () => {
    const set = resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0]);
    for (const mat of [set.surface, set.shore, set.estuary, set.river]) {
      const m = mat as THREE.ShaderMaterial;
      expect((m.uniforms.uWindDrift.value as THREE.Vector2).lengthSq()).toBe(0);
      expect(m.uniforms.uWindChop.value).toBe(0);
    }
  });

  it('open water drifts and roughens; the river leaves both alone', () => {
    const set = resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0]);
    const surface = set.surface as THREE.ShaderMaterial;
    const shore   = set.shore   as THREE.ShaderMaterial;
    const river   = set.river   as THREE.ShaderMaterial;

    expect(surface.fragmentShader).toContain('(vWorldXZ + uWindDrift)');
    expect(surface.fragmentShader).toContain('uWindChop');
    expect(shore.fragmentShader).toContain('(vWorldXZ + uWindDrift)');
    // A river's direction is its channel's — a wind must never run it backwards
    // uphill, so the flow term never sees the drift. (It still *declares* the
    // uniform, via the shared appearance block; what matters is that nothing
    // samples against it.)
    expect(river.fragmentShader).not.toContain('+ uWindDrift');
    expect(river.fragmentShader).toContain('River(vUv, uTime * uFlowSpeed)');
  });

  it('drift stays under the water\'s own wave animation, not an order over it', () => {
    // The coupling that made lakes look like rapids: the drift is added to
    // worldXZ *before* the shader's frequency multiplier, so one world unit of
    // drift carries the pattern across that many noise features. Tuning
    // waterDrift without accounting for it is how 0.15 ended up running ~11×
    // the water's own animation. Both constants are read off the real shader so
    // this stays honest if either is retuned.
    const src = resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0]).surface as THREE.ShaderMaterial;
    const freq = Number(/\+ uWindDrift\) \* ([\d.]+) \* uWaveScale/.exec(src.fragmentShader)?.[1]);
    const base = Number(/uTime \* uFlowSpeed \* ([\d.]+)/.exec(src.fragmentShader)?.[1]);
    expect(freq).toBeGreaterThan(0);
    expect(base).toBeGreaterThan(0);

    const wind = new Wind({ heading: 0, speed: 8, gustiness: 0, turbulence: 0 }); // slider maximum
    wind.advance(1);
    const driftRate = wind.drift.length() * freq;   // noise units per second
    expect(driftRate).toBeLessThan(base * 4);
  });

  it('every chop term is 1.0 + k·chop, so a windless scene is bit-identical', () => {
    // The invariant that matters more than the constants: whatever k is tuned
    // to, chop 0 has to multiply by exactly 1 or switching wind on retunes
    // every lake in every existing scene.
    const set = resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0]);
    for (const mat of [set.surface, set.shore]) {
      const src = (mat as THREE.ShaderMaterial).fragmentShader;
      // `* uWindChop` is every place it actually scales something — skipping
      // its declaration and the comments that name it.
      const uses = src.match(/\* uWindChop/g) ?? [];
      const guarded = src.match(/\(1\.0 \+ [\d.]+ \* uWindChop\)/g) ?? [];
      expect(guarded.length, src).toBe(uses.length);
    }
  });

  it('shore foam thickens with the wind but stays anchored to the shoreline', () => {
    const shore = resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0]).shore as THREE.ShaderMaterial;
    // Chop scales it; drift does not move it, or the surf band would walk off
    // the beach it breaks on.
    expect(shore.fragmentShader).toContain('Foam(shore, vWorldXZ, t) * uFoamIntensity * (1.0 + 0.07 * uWindChop)');
  });
});

describe('WeatherSystem sharing one wind', () => {
  it('exposes the same vector through wind and windField.base', () => {
    const weather = new WeatherSystem({ scene: new THREE.Scene() });
    expect(weather.wind).toBe(weather.windField.base);
    weather.wind.set(3, 4);
    expect(weather.windField.speed).toBeCloseTo(5);
    weather.dispose();
  });

  it('advances a wind it owns, and never one it was handed', () => {
    const own = new WeatherSystem({ scene: new THREE.Scene() });
    own.update(1, { x: 0, z: 0 });
    expect(own.windField.phase).toBeGreaterThan(0);
    own.dispose();

    const shared = new Wind();
    const borrower = new WeatherSystem({ scene: new THREE.Scene(), wind: shared });
    borrower.update(1, { x: 0, z: 0 });
    // Whoever owns it advances it — double-advancing would run the world's
    // clock at twice speed the moment a HexWorld and its weather both did.
    expect(shared.phase).toBe(0);
    borrower.dispose();
  });

  it('hands the particles only windResponse of the surface wind', () => {
    const scene = new THREE.Scene();
    const weather = new WeatherSystem({ scene });
    weather.windField.configure({ heading: 0, speed: 10, gustiness: 0, turbulence: 0 });
    weather.setWeather('rain');
    weather.update(1 / 60, { x: 0, z: 0 });

    const mat = (weather.precipitation!.object as THREE.LineSegments).material as THREE.ShaderMaterial;
    // Rain is already falling several times faster than the wind and is only
    // airborne a second or two — the full ground wind slants it like a gale.
    expect(weather.windResponse).toBe(0.1);
    expect((mat.uniforms.uWind.value as THREE.Vector2).x).toBeCloseTo(1);

    weather.setWeather('rain', { windResponse: 0.5 });
    weather.update(1 / 60, { x: 0, z: 0 });
    const mat2 = (weather.precipitation!.object as THREE.LineSegments).material as THREE.ShaderMaterial;
    expect((mat2.uniforms.uWind.value as THREE.Vector2).x).toBeCloseTo(5);
    weather.dispose();
  });

  it('drifts the cloud deck by the sustained wind and slants the rain by the gust', () => {
    const scene = new THREE.Scene();
    const terrain = makeTerrainMaterial();
    const weather = new WeatherSystem({ scene, terrainMaterial: terrain });
    weather.windField.configure({ heading: 0, speed: 4, gustiness: 0.9, gustPeriod: 2, turbulence: 0 });
    weather.setWeather('rain');

    // Long enough for the gust to be somewhere other than its neutral value.
    for (let i = 0; i < 30; i++) weather.update(1 / 60, { x: 0, z: 0 });

    const deck = terrain.uniforms.uCloudOffset.value as THREE.Vector2;
    expect(deck.x).toBeCloseTo(4 * 0.5, 1);   // sustained: exactly speed × time
    expect(weather.windField.gust).not.toBeCloseTo(1);

    const layerMat = (weather.precipitation!.object as THREE.LineSegments).material as THREE.ShaderMaterial;
    const rain = layerMat.uniforms.uWind.value as THREE.Vector2;
    // Gusted, not sustained — scaled by windResponse, but tracking `surface`.
    expect(rain.x).toBeCloseTo(weather.windField.surface.x * weather.windResponse);
    expect(rain.x).not.toBeCloseTo(weather.windField.base.x * weather.windResponse);
    weather.dispose();
  });
});

describe('precipitation drift under a changing wind', () => {
  it('integrates the drift instead of recomputing it as wind × time', () => {
    // The bug this guards: `position.xz + uWind * uTime` in the shader jumps by
    // (change in wind) × (elapsed time) the instant the wind moves, so a gust
    // an hour into a session teleports the whole field. It only showed up once
    // the wind started gusting — with a constant wind the product is fine.
    const layer = new PrecipitationLayer({ type: 'rain', count: 10 });
    const u = (layer.object as THREE.LineSegments).material.uniforms;
    expect(u.uWindOffset).toBeDefined();

    layer.setWind(new THREE.Vector2(2, 0));
    for (let i = 0; i < 100; i++) layer.update(0.1, { x: 0, z: 0 });
    const before = (u.uWindOffset.value as THREE.Vector2).x;

    // Ten seconds of drift at 2 u/s, wrapped into the volume.
    const area = u.uArea.value as number;
    expect(before).toBeCloseTo((2 * 10) % area, 4);

    // Now reverse the wind. A `wind × time` field would leap by 2 × elapsed;
    // an integrated one just starts travelling the other way.
    layer.setWind(new THREE.Vector2(-2, 0));
    layer.update(0.1, { x: 0, z: 0 });
    expect((u.uWindOffset.value as THREE.Vector2).x).toBeCloseTo(before - 0.2, 4);

    layer.dispose();
  });

  it('the shader drifts off the integrated offset, and aims the streak off the live wind', () => {
    const rain = new PrecipitationLayer({ type: 'rain', count: 4 });
    const src = ((rain.object as THREE.LineSegments).material as THREE.ShaderMaterial).vertexShader;
    expect(src).toContain('vec2 xz = position.xz + uWindOffset;');
    // The old form, which is what the comment above that line warns against.
    expect(src).not.toContain('position.xz + uWind *');
    // A streak is a direction, so reading the live wind there is correct.
    expect(src).toContain('normalize(vec3(uWind.x, -speed, uWind.y))');
    rain.dispose();
  });

  it('keeps the offset bounded so float32 holds sub-unit precision overnight', () => {
    const layer = new PrecipitationLayer({ type: 'snow', count: 4 });
    const u = (layer.object as THREE.LineSegments).material.uniforms;
    layer.setWind(new THREE.Vector2(8, 8));
    for (let i = 0; i < 20000; i++) layer.update(0.25, { x: 0, z: 0 });
    const off = u.uWindOffset.value as THREE.Vector2;
    const area = u.uArea.value as number;
    // Wrapped on the volume period the shader already folds the field into, so
    // the modulo is invisible on screen.
    expect(Math.abs(off.x)).toBeLessThanOrEqual(area);
    expect(Math.abs(off.y)).toBeLessThanOrEqual(area);
    layer.dispose();
  });
});
