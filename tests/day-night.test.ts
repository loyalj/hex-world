import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { DayNightCycle, formatTimeOfDay } from '../src/lighting/DayNightCycle.js';
import { SunShadowRig } from '../src/lighting/SunShadows.js';
import { createTerrainMaterial } from '../src/geometry/TerrainMaterial.js';
import { createRoadMaterial } from '../src/geometry/RoadMaterial.js';
import { resolveLiquidMaterials, DEFAULT_LIQUID_DESCRIPTORS } from '../src/geometry/LiquidTypes.js';

function makeTerrainMaterial(): THREE.ShaderMaterial {
  const tex = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
  return createTerrainMaterial(tex);
}

describe('DayNightCycle evaluation', () => {
  it('noon is full daylight with the sun high and reproduces the static default light values', () => {
    const s = new DayNightCycle({ time: 0.5 }).evaluate();
    expect(s.isNight).toBe(false);
    expect(s.daylight).toBe(1);
    // Sun elevation at noon = cos(latitudeTilt) = cos 30°.
    expect(s.lightDir.y).toBeCloseTo(Math.cos(THREE.MathUtils.degToRad(30)), 5);
    expect(s.lightDir).toEqual(s.sunDir);
    // Terrain uniform values match the library's static defaults
    // (0xfff4d0 · 0.7 and 0xd0e0ff · 0.45) so enabling the cycle at noon
    // doesn't change the out-of-the-box look.
    const expectedLight   = new THREE.Color(0xfff4d0).multiplyScalar(0.7);
    const expectedAmbient = new THREE.Color(0xd0e0ff).multiplyScalar(0.45);
    expect(s.terrainLightColor.r).toBeCloseTo(expectedLight.r, 5);
    expect(s.terrainLightColor.g).toBeCloseTo(expectedLight.g, 5);
    expect(s.terrainAmbient.b).toBeCloseTo(expectedAmbient.b, 5);
    // Liquids essentially untinted in full day (values are linear-sRGB, so
    // "white-ish" lands just under 1.0 after color-management conversion).
    expect(s.liquidTint.r).toBeGreaterThan(0.85);
    expect(s.liquidTint.g).toBeGreaterThan(0.85);
    expect(s.liquidTint.b).toBeGreaterThan(0.8);
  });

  it('midnight is moonlight mode: dim, blue, moon overhead, dark liquids', () => {
    const s = new DayNightCycle({ time: 0 }).evaluate();
    expect(s.isNight).toBe(true);
    expect(s.daylight).toBe(0);
    // The moon is exactly opposite the sun, so it is high at midnight.
    expect(s.lightDir.y).toBeCloseTo(Math.cos(THREE.MathUtils.degToRad(30)), 5);
    expect(s.lightDir).toEqual(s.moonDir);
    expect(s.sunDir.y).toBeLessThan(0);
    // Cool light: blue channel dominates red.
    expect(s.lightColor.b).toBeGreaterThan(s.lightColor.r);
    expect(s.lightIntensity).toBeLessThan(0.5);
    // Water goes dark so emissive liquids (lava) carry the night.
    expect(s.liquidTint.r).toBeLessThan(0.35);
    expect(s.liquidTint.g).toBeLessThan(0.35);
    expect(s.liquidTint.b).toBeLessThan(0.4);
    // Night sky is near-black.
    expect(s.skyColor.r + s.skyColor.g + s.skyColor.b).toBeLessThan(0.5);
  });

  it('shortly after dawn the light is warm-tinted (dawn glow)', () => {
    const s = new DayNightCycle({ time: 0.28 }).evaluate();
    expect(s.isNight).toBe(false);
    // Warmer than the midday sun color: red dominates blue strongly.
    expect(s.lightColor.r).toBeGreaterThan(s.lightColor.b * 1.5);
    const noon = new DayNightCycle({ time: 0.5 }).evaluate();
    expect(s.lightColor.b / s.lightColor.r).toBeLessThan(noon.lightColor.b / noon.lightColor.r);
  });

  it('both luminaries are ~extinguished right at the horizon, hiding the direction swap', () => {
    for (const t of [0.25, 0.75]) {
      const before = new DayNightCycle({ time: t - 0.002 }).evaluate();
      const beforeIntensity = before.lightIntensity;
      const after = new DayNightCycle({ time: t + 0.002 }).evaluate();
      expect(beforeIntensity).toBeLessThan(0.05);
      expect(after.lightIntensity).toBeLessThan(0.05);
    }
  });

  it('advance flows time by dayLength and wraps; paused freezes it', () => {
    const c = new DayNightCycle({ time: 0.9, dayLength: 100 });
    c.advance(15); // 0.9 + 0.15 → wraps to 0.05
    expect(c.time).toBeCloseTo(0.05, 6);
    c.paused = true;
    c.advance(50);
    expect(c.time).toBeCloseTo(0.05, 6);
  });

  it('setTime wraps into 0–1 (negatives too)', () => {
    const c = new DayNightCycle();
    c.setTime(-0.25);
    expect(c.time).toBeCloseTo(0.75, 6);
    c.setTime(1.5);
    expect(c.time).toBeCloseTo(0.5, 6);
  });
});

describe('DayNightCycle.applyTo', () => {
  it('pushes state onto rig, lights, terrain uniforms, liquid tints, and sky', () => {
    const cycle = new DayNightCycle({ time: 0 }); // midnight
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);
    const rig = new SunShadowRig().addTo(scene);
    const ambient = new THREE.AmbientLight(0xd0e0ff, 0.5);
    const terrain = makeTerrainMaterial();
    const liquids = new Map(DEFAULT_LIQUID_DESCRIPTORS.map(d => [d.id, resolveLiquidMaterials(d)]));

    const s = cycle.applyTo({
      sunRig: rig,
      ambientLight: ambient,
      terrainMaterial: terrain,
      liquidMaterials: liquids.values(),
      scene,
    });

    // Rig follows the moon.
    expect(rig.direction.y).toBeCloseTo(s.lightDir.y, 5);
    expect(rig.light.intensity).toBeCloseTo(s.lightIntensity, 5);
    // Terrain uniforms took the night values.
    expect(terrain.uniforms.uLightDir.value.y).toBeCloseTo(s.lightDir.y, 5);
    expect(terrain.uniforms.uAmbient.value.r).toBeCloseTo(s.terrainAmbient.r, 5);
    // Every liquid material set got the dark tint.
    for (const set of liquids.values()) {
      for (const mat of [set.surface, set.shore, set.estuary, set.river]) {
        const tint = (mat as THREE.ShaderMaterial).uniforms.uLightTint.value as THREE.Color;
        expect(tint.r).toBeLessThan(0.35);
      }
    }
    // Sky went to night.
    expect((scene.background as THREE.Color).getHex()).toBe(s.skyColor.getHex());
    // Ambient light dimmed below the daytime default.
    expect(ambient.intensity).toBeLessThan(0.5);
  });

  it('roads take the same light uniforms as the terrain, so they go dark at night', () => {
    const road = createRoadMaterial();
    const noon = new DayNightCycle({ time: 0.5 }).applyTo({ roadMaterial: road });
    const dayAmbient = (road.uniforms.uAmbient.value as THREE.Color).clone();
    expect((road.uniforms.uLightColor.value as THREE.Color).r).toBeCloseTo(noon.terrainLightColor.r, 5);

    const midnight = new DayNightCycle({ time: 0 }).applyTo({ roadMaterial: road });
    expect(road.uniforms.uLightDir.value.y).toBeCloseTo(midnight.lightDir.y, 5);
    // Night light is a fraction of the day's — the road can no longer read
    // near-white while everything around it is moonlit.
    expect((road.uniforms.uLightColor.value as THREE.Color).r).toBeLessThan(noon.terrainLightColor.r * 0.5);
    expect((road.uniforms.uAmbient.value as THREE.Color).r).toBeLessThan(dayAmbient.r);
  });

  it('liquid tint is white by default, so scenes without a cycle look unchanged', () => {
    const set = resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0]);
    const tint = (set.surface as THREE.ShaderMaterial).uniforms.uLightTint.value as THREE.Color;
    expect(tint.getHex()).toBe(0xffffff);
  });
});

describe('formatTimeOfDay', () => {
  it('formats and wraps', () => {
    expect(formatTimeOfDay(0)).toBe('00:00');
    expect(formatTimeOfDay(0.5)).toBe('12:00');
    expect(formatTimeOfDay(0.75)).toBe('18:00');
    expect(formatTimeOfDay(1.25)).toBe('06:00');
    expect(formatTimeOfDay(-0.25)).toBe('18:00');
  });
});
