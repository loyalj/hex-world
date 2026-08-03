import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  configureTerrainClouds, setTerrainCloudsEnabled, advanceTerrainClouds,
} from '../src/weather/CloudShadows.js';
import { PrecipitationLayer } from '../src/weather/Precipitation.js';
import { WeatherSystem } from '../src/weather/WeatherSystem.js';
import { createTerrainMaterial } from '../src/geometry/TerrainMaterial.js';
import { resolveLiquidMaterials, DEFAULT_LIQUID_DESCRIPTORS } from '../src/geometry/LiquidTypes.js';

function makeTerrainMaterial(): THREE.ShaderMaterial {
  const tex = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
  return createTerrainMaterial(tex);
}

describe('terrain cloud shadows', () => {
  it('terrain material declares the cloud uniforms and samples the shared field', () => {
    const mat = makeTerrainMaterial();
    for (const name of ['uCloudsEnabled', 'uCloudOffset', 'uCloudScale', 'uCloudCoverage', 'uCloudOpacity']) {
      expect(mat.uniforms[name]).toBeDefined();
    }
    expect(mat.uniforms.uCloudsEnabled.value).toBe(0); // off by default
    expect(mat.fragmentShader).toContain('cloudField');
    expect(mat.fragmentShader).toContain('cloudMask');
  });

  it('configureTerrainClouds styles and enables; setTerrainCloudsEnabled flips visibility', () => {
    const mat = makeTerrainMaterial();
    configureTerrainClouds(mat, { coverage: 0.7, opacity: 0.5, scale: 60 });
    expect(mat.uniforms.uCloudsEnabled.value).toBe(1);
    expect(mat.uniforms.uCloudCoverage.value).toBeCloseTo(0.7);
    expect(mat.uniforms.uCloudOpacity.value).toBeCloseTo(0.5);
    expect(mat.uniforms.uCloudScale.value).toBe(60);
    setTerrainCloudsEnabled(mat, false);
    expect(mat.uniforms.uCloudsEnabled.value).toBe(0);
  });

  it('ignores materials without cloud uniforms instead of throwing', () => {
    const plain = new THREE.ShaderMaterial();
    expect(() => configureTerrainClouds(plain, { coverage: 0.5 })).not.toThrow();
    expect(() => setTerrainCloudsEnabled(plain, true)).not.toThrow();
    expect(() => advanceTerrainClouds(plain, new THREE.Vector2(1, 0), 1)).not.toThrow();
  });

  it('advanceTerrainClouds drifts the offset by wind · dt', () => {
    const mat = makeTerrainMaterial();
    advanceTerrainClouds(mat, new THREE.Vector2(2, -1), 0.5);
    const off = mat.uniforms.uCloudOffset.value as THREE.Vector2;
    expect(off.x).toBeCloseTo(1);
    expect(off.y).toBeCloseTo(-0.5);
  });
});

describe('PrecipitationLayer', () => {
  it('rain builds line-segment streaks (two verts per drop) with a tip attribute', () => {
    const rain = new PrecipitationLayer({ type: 'rain', count: 100 });
    expect(rain.object).toBeInstanceOf(THREE.LineSegments);
    const geo = (rain.object as THREE.LineSegments).geometry;
    expect(geo.getAttribute('position').count).toBe(200);
    expect(geo.getAttribute('aTip')).toBeDefined();
    expect(rain.object.frustumCulled).toBe(false);
    rain.dispose();
  });

  it('snow builds points with seeds but no tips', () => {
    const snow = new PrecipitationLayer({ type: 'snow', count: 150 });
    expect(snow.object).toBeInstanceOf(THREE.Points);
    const geo = (snow.object as THREE.Points).geometry;
    expect(geo.getAttribute('position').count).toBe(150);
    expect(geo.getAttribute('aSeed')).toBeDefined();
    expect(geo.getAttribute('aTip')).toBeUndefined();
    snow.dispose();
  });

  it('setIntensity scales the draw range without reallocating', () => {
    const rain = new PrecipitationLayer({ type: 'rain', count: 100 });
    const geo = (rain.object as THREE.LineSegments).geometry;
    expect(geo.drawRange.count).toBe(200);
    rain.setIntensity(0.5);
    expect(geo.drawRange.count).toBe(100); // 50 drops × 2 verts
    rain.setIntensity(0);
    expect(rain.object.visible).toBe(false);
    rain.setIntensity(1);
    expect(rain.object.visible).toBe(true);
    expect(geo.drawRange.count).toBe(200);
    rain.dispose();
  });

  it('update recenters the world-anchored volume and advances time', () => {
    const rain = new PrecipitationLayer({ type: 'rain', count: 10 });
    const mat = (rain.object as THREE.LineSegments).material as THREE.ShaderMaterial;
    rain.update(0.25, { x: 40, z: 70 });
    expect(mat.uniforms.uTime.value).toBeCloseTo(0.25);
    const center = mat.uniforms.uCenter.value as THREE.Vector3;
    expect(center.x).toBe(40);
    expect(center.z).toBe(70);
    rain.dispose();
  });

  it('cloud gate + mask hook wire into uniforms', () => {
    const snow = new PrecipitationLayer({ type: 'snow', count: 10 });
    const mat = (snow.object as THREE.Points).material as THREE.ShaderMaterial;
    snow.setCloudGate({ enabled: true, offset: new THREE.Vector2(3, 4), scale: 55, coverage: 0.3 });
    expect(mat.uniforms.uCloudGate.value).toBe(1);
    expect((mat.uniforms.uCloudOffset.value as THREE.Vector2).x).toBe(3);
    expect(mat.uniforms.uCloudScale.value).toBe(55);
    expect(mat.uniforms.uCloudCoverage.value).toBeCloseTo(0.3);

    const tex = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
    snow.setMask(tex, { x: 0, z: 0, width: 200, depth: 100 });
    expect(mat.uniforms.uMaskEnabled.value).toBe(1);
    snow.setMask(null);
    expect(mat.uniforms.uMaskEnabled.value).toBe(0);
    snow.dispose();
  });
});

describe('WeatherSystem', () => {
  it('rain adds a gated particle layer and enables terrain cloud shadows', () => {
    const scene = new THREE.Scene();
    const mat = makeTerrainMaterial();
    const weather = new WeatherSystem({ scene, terrainMaterial: mat });

    weather.setWeather('rain');
    expect(weather.type).toBe('rain');
    expect(weather.precipitation).not.toBeNull();
    expect(scene.children).toContain(weather.precipitation!.object);
    expect(mat.uniforms.uCloudsEnabled.value).toBe(1);
    // Rain is gated to fall only under the denser clouds: gate coverage is
    // strictly below the shadow coverage, so some clouds are just clouds.
    const layerMat = (weather.precipitation!.object as THREE.LineSegments).material as THREE.ShaderMaterial;
    expect(layerMat.uniforms.uCloudGate.value).toBe(1);
    expect(layerMat.uniforms.uCloudCoverage.value).toBeLessThan(mat.uniforms.uCloudCoverage.value);

    weather.setWeather('clear');
    expect(weather.precipitation).toBeNull();
    expect(scene.children.some(c => c instanceof THREE.LineSegments)).toBe(false);
    expect(mat.uniforms.uCloudsEnabled.value).toBe(0);
    weather.dispose();
  });

  it('update drifts one shared cloud offset into both the terrain and the particle gate', () => {
    const scene = new THREE.Scene();
    const mat = makeTerrainMaterial();
    const weather = new WeatherSystem({ scene, terrainMaterial: mat });
    weather.setWeather('snow');
    weather.wind.set(4, 2);

    weather.update(0.5, { x: 10, z: 20 });
    const terrOff  = mat.uniforms.uCloudOffset.value as THREE.Vector2;
    const layerMat = (weather.precipitation!.object as THREE.Points).material as THREE.ShaderMaterial;
    const gateOff  = layerMat.uniforms.uCloudOffset.value as THREE.Vector2;
    expect(terrOff.x).toBeCloseTo(2);
    expect(terrOff.y).toBeCloseTo(1);
    expect(gateOff.x).toBeCloseTo(terrOff.x);
    expect(gateOff.y).toBeCloseTo(terrOff.y);
    // Particle volume recentered on the camera target.
    expect((layerMat.uniforms.uCenter.value as THREE.Vector3).x).toBe(10);
    weather.dispose();
  });

  it('intensity ramps particles and cloud darkness together', () => {
    const scene = new THREE.Scene();
    const mat = makeTerrainMaterial();
    const weather = new WeatherSystem({ scene, terrainMaterial: mat });
    weather.setWeather('rain', { intensity: 1 });
    const fullOpacity = mat.uniforms.uCloudOpacity.value as number;
    weather.setIntensity(0.25);
    expect(weather.precipitation!.intensity).toBeCloseTo(0.25);
    expect(mat.uniforms.uCloudOpacity.value).toBeLessThan(fullOpacity);
    weather.dispose();
  });

  it('cloud shadows reach the liquid materials with the same field parameters', () => {
    const scene = new THREE.Scene();
    const terrain = makeTerrainMaterial();
    const liquids = new Map(DEFAULT_LIQUID_DESCRIPTORS.map(d => [d.id, resolveLiquidMaterials(d)]));
    const weather = new WeatherSystem({
      scene,
      terrainMaterial: terrain,
      liquidMaterials: () => liquids.values(),
    });

    weather.setWeather('rain');
    weather.update(0.5, { x: 0, z: 0 });
    const waterMat = liquids.get('water')!.surface as THREE.ShaderMaterial;
    expect(waterMat.uniforms.uCloudsEnabled.value).toBe(1);
    expect(waterMat.uniforms.uCloudCoverage.value).toBe(terrain.uniforms.uCloudCoverage.value);
    expect(waterMat.uniforms.uCloudScale.value).toBe(terrain.uniforms.uCloudScale.value);
    // Per-frame drift lands on the liquids too — clouds stay in step over water.
    const terrOff  = terrain.uniforms.uCloudOffset.value as THREE.Vector2;
    const waterOff = waterMat.uniforms.uCloudOffset.value as THREE.Vector2;
    expect(waterOff.x).toBeCloseTo(terrOff.x);
    expect(waterOff.y).toBeCloseTo(terrOff.y);
    // River material carries the world-position varying needed to sample the field.
    const riverMat = liquids.get('water')!.river as THREE.ShaderMaterial;
    expect(riverMat.vertexShader).toContain('vWorldXZ');
    expect(riverMat.uniforms.uCloudsEnabled.value).toBe(1);

    weather.setWeather('clear');
    expect(waterMat.uniforms.uCloudsEnabled.value).toBe(0);
    weather.dispose();
  });

  it('setTerrainMaterial migrates cloud config after a material swap', () => {
    const scene = new THREE.Scene();
    const oldMat = makeTerrainMaterial();
    const weather = new WeatherSystem({ scene, terrainMaterial: oldMat });
    weather.setWeather('rain');
    expect(oldMat.uniforms.uCloudsEnabled.value).toBe(1);

    const newMat = makeTerrainMaterial();
    weather.setTerrainMaterial(newMat);
    expect(oldMat.uniforms.uCloudsEnabled.value).toBe(0);
    expect(newMat.uniforms.uCloudsEnabled.value).toBe(1);
    expect(newMat.uniforms.uCloudCoverage.value).toBeCloseTo(0.6);
    weather.dispose();
  });
});
