import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ClimateData } from '../src/season/ClimateData.js';
import {
  configureSeason, setSeasonEnabled, styleSnow, resolveSnowTerrain,
} from '../src/season/SeasonGLSL.js';
import { attachSnow, hasSnow } from '../src/season/SnowAttach.js';
import { attachAtmosphere } from '../src/sky/Atmosphere.js';
import { createTerrainMaterial } from '../src/geometry/TerrainMaterial.js';
import { DEFAULT_TERRAIN_DEFINITIONS } from '../src/geometry/TerrainTypes.js';
import { PrecipitationLayer } from '../src/weather/Precipitation.js';
import { WeatherSystem } from '../src/weather/WeatherSystem.js';

function makeTerrainMaterial(): THREE.ShaderMaterial {
  const tex = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
  return createTerrainMaterial(tex);
}

describe('terrain snow', () => {
  it('declares the season uniforms and stays inert until configured', () => {
    const mat = makeTerrainMaterial();
    for (const name of ['uClimateData', 'uClimateSize', 'uSeasonEnabled', 'uSnowColor', 'uSnowTerrain']) {
      expect(mat.uniforms[name]).toBeDefined();
    }
    expect(mat.uniforms.uSeasonEnabled.value).toBe(0);
    expect(mat.uniforms.uSnowTerrain.value).toBe(-1);
  });

  it('averages all three of a triangle cells so the snowline is not hex-shaped', () => {
    const mat = makeTerrainMaterial();
    expect(mat.vertexShader).toContain('cellUV(cellIndex.x, uClimateSize)');
    expect(mat.vertexShader).toContain('cellUV(cellIndex.y, uClimateSize)');
    expect(mat.vertexShader).toContain('cellUV(cellIndex.z, uClimateSize)');
    expect(mat.vertexShader).toContain('vSnow = (c0.b + c1.b + c2.b) / 3.0;');
    expect(mat.vertexShader).toContain('vTemp = (c0.a + c1.a + c2.a) / 3.0;');
  });

  it('blends snow before lighting so it shades and shadows like ground', () => {
    const mat = makeTerrainMaterial();
    const snowAt = mat.fragmentShader.indexOf('snowCoverage(vSnow');
    const litAt  = mat.fragmentShader.indexOf('vec3 lit = c.rgb * light;');
    expect(snowAt).toBeGreaterThan(-1);
    expect(litAt).toBeGreaterThan(snowAt);
  });

  it('hazes after snow, so distance still wins over winter', () => {
    const mat = makeTerrainMaterial();
    // The call site in main(), not applyAtmosphere's definition further up.
    expect(mat.fragmentShader.indexOf('applyAtmosphere(lit '))
      .toBeGreaterThan(mat.fragmentShader.indexOf('snowCoverage(vSnow'));
  });

  it('configureSeason binds a climate, applies styling, and enables', () => {
    const mat = makeTerrainMaterial();
    const climate = new ClimateData(8, 4);
    configureSeason(mat, climate, { color: 0xff0000, slope: 0.5, noise: 0.2, snowTerrain: 2 });

    expect(mat.uniforms.uSeasonEnabled.value).toBe(1);
    expect(mat.uniforms.uClimateData.value).toBe(climate.texture);
    expect((mat.uniforms.uClimateSize.value as THREE.Vector2).x).toBe(8);
    expect((mat.uniforms.uClimateSize.value as THREE.Vector2).y).toBe(4);
    expect((mat.uniforms.uSnowColor.value as THREE.Color).getHex()).toBe(0xff0000);
    expect(mat.uniforms.uSnowSlope.value).toBeCloseTo(0.5);
    expect(mat.uniforms.uSnowNoise.value).toBeCloseTo(0.2);
    expect(mat.uniforms.uSnowTerrain.value).toBe(2);
  });

  it('detaches on a null climate and toggles without losing styling', () => {
    const mat = makeTerrainMaterial();
    configureSeason(mat, new ClimateData(4, 4), { noise: 0.3 });
    setSeasonEnabled(mat, false);
    expect(mat.uniforms.uSeasonEnabled.value).toBe(0);
    expect(mat.uniforms.uSnowNoise.value).toBeCloseTo(0.3);

    configureSeason(mat, null);
    expect(mat.uniforms.uSeasonEnabled.value).toBe(0);
  });

  it('styleSnow restyles without unbinding the climate', () => {
    const mat = makeTerrainMaterial();
    const climate = new ClimateData(4, 4);
    configureSeason(mat, climate);
    styleSnow(mat, { noise: 0.9 });
    expect(mat.uniforms.uSnowNoise.value).toBeCloseTo(0.9);
    expect(mat.uniforms.uClimateData.value).toBe(climate.texture);
    expect(mat.uniforms.uSeasonEnabled.value).toBe(1);
  });

  it('ignores materials without the uniforms instead of throwing', () => {
    const plain = new THREE.ShaderMaterial();
    expect(() => configureSeason(plain, new ClimateData(2, 2))).not.toThrow();
    expect(() => setSeasonEnabled(plain, true)).not.toThrow();
    expect(() => styleSnow(plain, { noise: 1 })).not.toThrow();
  });

  it('resolves the snow layer from the pack, and -1 when it has none', () => {
    expect(resolveSnowTerrain(DEFAULT_TERRAIN_DEFINITIONS)).toBe(2);
    expect(resolveSnowTerrain([{ id: 'grass', index: 0 }])).toBe(-1);
  });
});

describe('attachSnow (stock three materials)', () => {
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

  it('injects snow into diffuseColor, so the cap is lit rather than painted on', () => {
    // The chunks we splice against must still exist in this three version.
    expect(THREE.ShaderLib.lambert.fragmentShader).toContain('#include <color_fragment>');
    expect(THREE.ShaderLib.lambert.vertexShader).toContain('#include <beginnormal_vertex>');

    const mat = new THREE.MeshLambertMaterial({ color: 0x5e8c2a });
    attachSnow(mat);
    expect(hasSnow(mat)).toBe(true);
    const shader = compile(mat);

    expect(shader.fragmentShader).toContain('diffuseColor.rgb = mix(diffuseColor.rgb, uSnowColor, snowAmt)');
    // Before tone mapping and encoding — unlike atmosphere haze, which is after.
    expect(shader.fragmentShader.indexOf('snowCoverage'))
      .toBeLessThan(shader.fragmentShader.indexOf('#include <dithering_fragment>'));
    expect(shader.vertexShader).toContain('attribute float cellIndex;');
    expect(shader.vertexShader).toContain('mat3(instanceMatrix) * seasonN'); // scatter is instanced
    expect(shader.uniforms.uSeasonEnabled).toBeDefined();
    expect(shader.uniforms.uSnowColor).toBeDefined();
  });

  it('keeps an existing onBeforeCompile working and does not share its program', () => {
    let priorRan = false;
    const mat = new THREE.MeshLambertMaterial();
    mat.onBeforeCompile = () => { priorRan = true; };
    attachSnow(mat);
    compile(mat);
    expect(priorRan).toBe(true);

    const other = new THREE.MeshLambertMaterial();
    attachSnow(other);
    expect(mat.customProgramCacheKey()).not.toBe(other.customProgramCacheKey());
    expect(mat.customProgramCacheKey()).toContain('hex-world-snow');
  });

  it('is idempotent — a second call restyles instead of unbinding', () => {
    const mat = new THREE.MeshLambertMaterial();
    attachSnow(mat);
    const climate = new ClimateData(4, 4);
    configureSeason(mat, climate);
    attachSnow(mat, { noise: 0.15 });

    const u = mat.userData.hexWorldSnow as Record<string, THREE.IUniform>;
    expect(u.uSnowNoise.value).toBeCloseTo(0.15);
    expect(u.uClimateData.value).toBe(climate.texture); // still bound
    expect(u.uSeasonEnabled.value).toBe(1);
  });

  it('composes with attachAtmosphere in either order', () => {
    const a = new THREE.MeshLambertMaterial();
    attachSnow(a); attachAtmosphere(a);
    const b = new THREE.MeshLambertMaterial();
    attachAtmosphere(b); attachSnow(b);

    for (const mat of [a, b]) {
      const shader = compile(mat);
      expect(shader.fragmentShader).toContain('snowCoverage');
      // Snow into the lit surface, haze after tone mapping — order preserved.
      expect(shader.fragmentShader.indexOf('snowCoverage'))
        .toBeLessThan(shader.fragmentShader.indexOf('gl_FragColor.rgb = applyAtmosphere('));
      expect(shader.uniforms.uSeasonEnabled).toBeDefined();
      expect(shader.uniforms.uAtmoColor).toBeDefined();
    }
  });
});

describe('precipitation mask', () => {
  it('selects a channel and a polarity', () => {
    const tex  = new ClimateData(4, 4).texture;
    const snow = new PrecipitationLayer({ type: 'snow', count: 10 });
    snow.setMask(tex, { x: 0, z: 0, width: 10, depth: 10 }, { channel: 'b' });

    const u = snow.material.uniforms;
    expect(u.uMaskEnabled.value).toBe(1);
    expect((u.uMaskChannel.value as THREE.Vector4).toArray()).toEqual([0, 0, 1, 0]);
    expect(u.uMaskInvert.value).toBe(0);

    const rain = new PrecipitationLayer({ type: 'rain', count: 10 });
    rain.setMask(tex, { x: 0, z: 0, width: 10, depth: 10 }, { channel: 'b', invert: true });
    expect(rain.material.uniforms.uMaskInvert.value).toBe(1);
  });

  it('defaults to the R channel, preserving the pre-seasons behaviour', () => {
    const layer = new PrecipitationLayer({ type: 'rain', count: 10 });
    layer.setMask(new ClimateData(2, 2).texture, { x: 0, z: 0, width: 1, depth: 1 });
    expect((layer.material.uniforms.uMaskChannel.value as THREE.Vector4).toArray()).toEqual([1, 0, 0, 0]);
  });

  it('gates snow and rain on complementary polarities, surviving a layer rebuild', () => {
    const climate = new ClimateData(4, 4);
    const weather = new WeatherSystem({ scene: new THREE.Scene() });
    weather.setPrecipitationMask(climate.texture, { x: 0, z: 0, width: 8, depth: 8 });

    const layerOf = (w: WeatherSystem): PrecipitationLayer =>
      (w as unknown as { layer: PrecipitationLayer }).layer;

    weather.setWeather('snow');
    expect(layerOf(weather).material.uniforms.uMaskEnabled.value).toBe(1);
    expect(layerOf(weather).material.uniforms.uMaskInvert.value).toBe(0);

    // setWeather rebuilds the particle layer — the mask has to survive that.
    weather.setWeather('rain');
    expect(layerOf(weather).material.uniforms.uMaskEnabled.value).toBe(1);
    expect(layerOf(weather).material.uniforms.uMaskInvert.value).toBe(1);
  });

  it('clears cleanly', () => {
    const weather = new WeatherSystem({ scene: new THREE.Scene() });
    weather.setWeather('snow');
    weather.setPrecipitationMask(new ClimateData(2, 2).texture, { x: 0, z: 0, width: 4, depth: 4 });
    weather.setPrecipitationMask(null);
    const layer = (weather as unknown as { layer: PrecipitationLayer }).layer;
    expect(layer.material.uniforms.uMaskEnabled.value).toBe(0);
  });
});
