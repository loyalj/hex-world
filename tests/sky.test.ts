import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { SkyDome, averageTerrainColor } from '../src/sky/SkyDome.js';
import {
  configureAtmosphere, setAtmosphereEnabled, atmosphereUniforms, attachAtmosphere,
} from '../src/sky/Atmosphere.js';
import { createRockMaterial } from '../src/geometry/RockMaterial.js';
import { DayNightCycle } from '../src/lighting/DayNightCycle.js';
import { WeatherSystem } from '../src/weather/WeatherSystem.js';
import { createTerrainMaterial } from '../src/geometry/TerrainMaterial.js';
import { createRoadMaterial } from '../src/geometry/RoadMaterial.js';
import {
  resolveLiquidMaterials, liquidMaterialList, DEFAULT_LIQUID_DESCRIPTORS,
} from '../src/geometry/LiquidTypes.js';
import { resolveTerrainDefinitions, DEFAULT_TERRAIN_DESCRIPTORS } from '../src/geometry/TerrainTypes.js';

function makeTerrainMaterial(): THREE.ShaderMaterial {
  const tex = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
  return createTerrainMaterial(tex);
}

/** Every surface material a world hazes: terrain, road, and all six liquid layers. */
function surfaceMaterials(): THREE.Material[] {
  const mats: THREE.Material[] = [makeTerrainMaterial(), createRoadMaterial()];
  for (const d of DEFAULT_LIQUID_DESCRIPTORS) {
    for (const m of liquidMaterialList(resolveLiquidMaterials(d))) if (m) mats.push(m);
  }
  return mats;
}

const uniforms = (m: THREE.Material): Record<string, THREE.IUniform> =>
  (m as THREE.ShaderMaterial).uniforms;

describe('atmosphere uniforms', () => {
  it('every surface material carries them, and they start disabled', () => {
    for (const mat of surfaceMaterials()) {
      expect(uniforms(mat).uAtmoEnabled, mat.type).toBeDefined();
      expect(uniforms(mat).uAtmoEnabled.value).toBe(0);
    }
  });

  it('configureAtmosphere styles and enables; setAtmosphereEnabled toggles without restyling', () => {
    const mat = makeTerrainMaterial();
    configureAtmosphere(mat, { color: 0x112233, near: 10, far: 60, density: 0.5 });
    expect(mat.uniforms.uAtmoEnabled.value).toBe(1);
    expect((mat.uniforms.uAtmoColor.value as THREE.Color).getHex()).toBe(0x112233);
    expect(mat.uniforms.uAtmoNear.value).toBe(10);
    expect(mat.uniforms.uAtmoFar.value).toBe(60);
    expect(mat.uniforms.uAtmoDensity.value).toBe(0.5);

    setAtmosphereEnabled(mat, false);
    expect(mat.uniforms.uAtmoEnabled.value).toBe(0);
    expect(mat.uniforms.uAtmoNear.value).toBe(10); // styling survived the toggle
  });

  it('keeps far strictly above near, so the shader smoothstep stays defined', () => {
    const mat = makeTerrainMaterial();
    configureAtmosphere(mat, { near: 80, far: 20 });
    expect(mat.uniforms.uAtmoFar.value as number).toBeGreaterThan(mat.uniforms.uAtmoNear.value as number);
  });

  it('ignores materials without the uniforms instead of throwing', () => {
    const plain = new THREE.MeshBasicMaterial();
    expect(() => configureAtmosphere(plain, { near: 5 })).not.toThrow();
    expect(() => setAtmosphereEnabled(plain, true)).not.toThrow();
  });

  it('defaults leave the haze off, so materials look unchanged without a sky', () => {
    expect(atmosphereUniforms().uAtmoEnabled.value).toBe(0);
  });
});

describe('attachAtmosphere (stock three materials)', () => {
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

  it('injects the same haze into a stock material, after tone mapping and encoding', () => {
    const mat = new THREE.MeshLambertMaterial({ color: 0x5e8c2a });
    attachAtmosphere(mat);
    const shader = compile(mat);

    // The chunks we splice against must still exist in this three version.
    expect(THREE.ShaderLib.lambert.vertexShader).toContain('#include <project_vertex>');
    expect(THREE.ShaderLib.lambert.fragmentShader).toContain('#include <dithering_fragment>');

    expect(shader.vertexShader).toContain('varying vec2 vAtmoWorldXZ;');
    expect(shader.vertexShader).toContain('vAtmoWorldXZ = (modelMatrix * atmoWorld).xz;');
    expect(shader.vertexShader).toContain('instanceMatrix * atmoWorld'); // scatter is instanced
    expect(shader.fragmentShader).toContain('vec3 applyAtmosphere(vec3');
    // Last thing main() does, so it lands in the same space our own shaders write.
    const applyAt = shader.fragmentShader.indexOf('gl_FragColor.rgb = applyAtmosphere(');
    expect(applyAt).toBeGreaterThan(shader.fragmentShader.indexOf('#include <colorspace_fragment>'));
    expect(shader.uniforms.uAtmoColor).toBeDefined();
  });

  it('drives the injected uniforms like any other hazed material', () => {
    const mat = new THREE.MeshLambertMaterial();
    attachAtmosphere(mat, { near: 12, far: 40 });
    const shader = compile(mat);
    expect(shader.uniforms.uAtmoEnabled.value).toBe(1);
    expect(shader.uniforms.uAtmoNear.value).toBe(12);

    // The shader holds the same uniform objects, so later config reaches the GPU.
    configureAtmosphere(mat, { color: 0x445566 });
    expect((shader.uniforms.uAtmoColor.value as THREE.Color).getHex()).toBe(0x445566);
    setAtmosphereEnabled(mat, false);
    expect(shader.uniforms.uAtmoEnabled.value).toBe(0);
  });

  it('keeps an existing onBeforeCompile working, and does not share its program', () => {
    const rock = createRockMaterial();   // patches vertex positions in its own hook
    const tree = new THREE.MeshLambertMaterial();
    attachAtmosphere(rock);
    attachAtmosphere(tree);

    const rockShader = compile(rock);
    expect(rockShader.vertexShader).toContain('_rockScale');            // original hook ran
    expect(rockShader.vertexShader).toContain('vAtmoWorldXZ');          // ours ran too
    expect(compile(tree).vertexShader).not.toContain('_rockScale');
    // Identical patch functions would otherwise collide on the default cache
    // key (onBeforeCompile.toString()) and reuse one compiled program.
    expect(rock.customProgramCacheKey()).not.toBe(tree.customProgramCacheKey());
  });

  it('is idempotent — a second call restyles instead of double-patching', () => {
    const mat = new THREE.MeshLambertMaterial();
    attachAtmosphere(mat, { near: 10 });
    attachAtmosphere(mat, { near: 25 });
    const shader = compile(mat);
    expect(shader.uniforms.uAtmoNear.value).toBe(25);
    expect(shader.fragmentShader.split('vec3 applyAtmosphere(vec3').length - 1).toBe(1);
  });

  it('leaves the library shaders alone — they already declare the uniforms', () => {
    const mat = makeTerrainMaterial();
    attachAtmosphere(mat, { near: 33 });
    expect(mat.uniforms.uAtmoNear.value).toBe(33);
    expect(mat.userData.__hexWorldAtmosphere).toBeUndefined();
  });
});

describe('SkyDome haze', () => {
  it('enables the haze on every surface material and locks its color to the horizon', () => {
    const mats = surfaceMaterials();
    const sky = new SkyDome({ materials: () => mats, horizonColor: 0x8fb2d9 });

    for (const mat of mats) {
      expect(uniforms(mat).uAtmoEnabled.value).toBe(1);
      expect((uniforms(mat).uAtmoColor.value as THREE.Color).getHex())
        .toBe(sky.horizonColor.getHex());
    }

    sky.setColors({ horizon: 0xff0000 });
    for (const mat of mats) {
      expect((uniforms(mat).uAtmoColor.value as THREE.Color).getHex())
        .toBe(sky.horizonColor.getHex());
    }
  });

  it('setEnabled(false) puts out the dome and the haze together; re-enabling restores both', () => {
    const mats = surfaceMaterials();
    const sky = new SkyDome({ materials: () => mats });

    sky.setEnabled(false);
    expect(sky.mesh.visible).toBe(false);
    for (const mat of mats) expect(uniforms(mat).uAtmoEnabled.value).toBe(0);

    sky.setEnabled(true);
    expect(sky.mesh.visible).toBe(true);
    for (const mat of mats) expect(uniforms(mat).uAtmoEnabled.value).toBe(1);
  });

  it('picks up materials added after construction (provider, not snapshot)', () => {
    const mats: THREE.Material[] = [makeTerrainMaterial()];
    const sky = new SkyDome({ materials: () => mats });
    const late = createRoadMaterial();
    mats.push(late);
    expect(uniforms(late).uAtmoEnabled.value).toBe(0);

    sky.refresh();
    expect(uniforms(late).uAtmoEnabled.value).toBe(1);
    expect((uniforms(late).uAtmoColor.value as THREE.Color).getHex()).toBe(sky.horizonColor.getHex());
  });

  it('never touches scene.fog — three fogs in a different color space than our shaders', () => {
    const scene = new THREE.Scene();
    const sky = new SkyDome({ materials: surfaceMaterials, fog: { near: 30, far: 90 } }).addTo(scene);
    expect(scene.fog).toBeNull();
    sky.dispose();
    expect(scene.fog).toBeNull();
    expect(sky.mesh.parent).toBeNull();
  });

  it('dispose switches the surface haze back off', () => {
    const mats = surfaceMaterials();
    const sky = new SkyDome({ materials: () => mats });
    sky.dispose();
    for (const mat of mats) expect(uniforms(mat).uAtmoEnabled.value).toBe(0);
  });

  it('fog: false leaves the materials alone (dome only)', () => {
    const mats = surfaceMaterials();
    new SkyDome({ materials: () => mats, fog: false });
    for (const mat of mats) expect(uniforms(mat).uAtmoEnabled.value).toBe(0);
  });
});

describe('SkyDome gradient', () => {
  it('rides the camera and scales inside its far plane', () => {
    const sky = new SkyDome({ radiusScale: 0.4 });
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    camera.position.set(12, 30, -7);
    sky.update(camera, 0.5);
    expect(sky.mesh.position.toArray()).toEqual([12, 30, -7]);
    expect(sky.mesh.scale.x).toBe(80);
    expect(sky.mesh.scale.x).toBeLessThan(camera.far);
    expect(sky.material.uniforms.uTime.value).toBeCloseTo(0.5, 6);
  });

  it('derives the below-horizon color from the horizon unless one is given', () => {
    const sky = new SkyDome({ horizonColor: 0x808080, groundDarken: 0.5, groundTintStrength: 0 });
    const ground = sky.material.uniforms.uGround.value as THREE.Color;
    expect(ground.r).toBeCloseTo(sky.horizonColor.r * 0.5, 6);

    const explicit = new SkyDome({ horizonColor: 0x808080, groundColor: 0x00ff00 });
    expect((explicit.material.uniforms.uGround.value as THREE.Color).getHex()).toBe(0x00ff00);
  });

  it('leans the horizon toward the biome tint, leaving the zenith alone', () => {
    const plain  = new SkyDome({ horizonColor: 0x8fb2d9, zenithColor: 0x3f74c0 });
    const tinted = new SkyDome({
      horizonColor: 0x8fb2d9, zenithColor: 0x3f74c0,
      groundTint: 0xc8a060, groundTintStrength: 0.5,
    });
    expect(tinted.horizonColor.r).toBeGreaterThan(plain.horizonColor.r);
    const zenith = (s: SkyDome) => (s.material.uniforms.uZenith.value as THREE.Color).getHex();
    expect(zenith(tinted)).toBe(zenith(plain));
  });

  it('fades the biome tint out with the light, so midnight horizons stay dark', () => {
    const opts = { horizonColor: 0x8fb2d9, groundTint: 0xc8a060, groundTintStrength: 0.5 };
    const noon  = new SkyDome(opts);
    const night = new SkyDome(opts);
    noon.setDayNight(new DayNightCycle({ time: 0.5 }).evaluate());
    night.setDayNight(new DayNightCycle({ time: 0 }).evaluate());
    // Untinted the night horizon is 0x0b0e1c; a tint that survived the dark
    // would haul it up into a visible dusty band (and drag the haze with it).
    const bare = new THREE.Color(0x0b0e1c);
    expect(night.horizonColor.r).toBeCloseTo(bare.r, 5);
    expect(noon.horizonColor.r).toBeGreaterThan(night.horizonColor.r * 5);
  });

  it('sinks the luminary glow below the horizon rather than dragging it through the dome', () => {
    const sky = new SkyDome();
    sky.setSun(new THREE.Vector3(0, 1, 0));
    const high = sky.material.uniforms.uSunGlow.value as number;
    expect(high).toBeGreaterThan(0);
    sky.setSun(new THREE.Vector3(1, -0.4, 0));
    expect(sky.material.uniforms.uSunGlow.value as number).toBe(0);
  });
});

describe('SkyDome overcast', () => {
  it('greys the gradient, dims the sun, and puts out the stars', () => {
    const sky = new SkyDome({ horizonColor: 0x8fb2d9, zenithColor: 0x3f74c0, groundTintStrength: 0 });
    sky.setDayNight(new DayNightCycle({ time: 0.5 }).evaluate());
    const clearHorizon = sky.horizonColor.clone();
    const clearZenith  = (sky.material.uniforms.uZenith.value as THREE.Color).clone();
    const clearGlow    = sky.material.uniforms.uSunGlow.value as number;

    sky.setOvercast(1);
    expect(sky.overcast).toBe(1);
    // Blue drains out of both bands as they collapse toward grey...
    const overcastZenith = sky.material.uniforms.uZenith.value as THREE.Color;
    expect(overcastZenith.b - overcastZenith.r).toBeLessThan(clearZenith.b - clearZenith.r);
    expect(sky.horizonColor.b - sky.horizonColor.r).toBeLessThan(clearHorizon.b - clearHorizon.r);
    // ...and the sun stops burning through.
    expect(sky.material.uniforms.uSunGlow.value as number).toBeLessThan(clearGlow * 0.15);
    expect(sky.material.uniforms.uStars.value).toBe(0);
  });

  it('a solid deck at midnight stays dark — overcast grey scales with the hour', () => {
    const day   = new SkyDome({ groundTintStrength: 0 });
    const night = new SkyDome({ groundTintStrength: 0 });
    day.setDayNight(new DayNightCycle({ time: 0.5 }).evaluate());
    night.setDayNight(new DayNightCycle({ time: 0 }).evaluate());
    day.setOvercast(1);
    night.setOvercast(1);
    const lum = (c: THREE.Color) => c.r + c.g + c.b;
    expect(lum(night.horizonColor)).toBeLessThan(lum(day.horizonColor) * 0.4);
  });

  it('the haze follows the sky grey, so distant terrain matches an overcast horizon', () => {
    const mats = surfaceMaterials();
    const sky = new SkyDome({ materials: () => mats });
    sky.setOvercast(0.9);
    for (const mat of mats) {
      expect((uniforms(mat).uAtmoColor.value as THREE.Color).getHex()).toBe(sky.horizonColor.getHex());
    }
  });

  it('stars fade in with the night and out under cloud', () => {
    const sky = new SkyDome();
    sky.setDayNight(new DayNightCycle({ time: 0.5 }).evaluate());
    expect(sky.material.uniforms.uStars.value).toBe(0);
    sky.setDayNight(new DayNightCycle({ time: 0 }).evaluate());
    expect(sky.material.uniforms.uStars.value).toBe(1);
    sky.setOvercast(0.6);
    expect(sky.material.uniforms.uStars.value).toBeCloseTo(0.4, 6);
  });

  it('stars: false keeps the night sky bare', () => {
    const sky = new SkyDome({ stars: false });
    sky.setDayNight(new DayNightCycle({ time: 0 }).evaluate());
    expect(sky.material.uniforms.uStars.value).toBe(0);
  });
});

describe('DayNightCycle sky output', () => {
  it('splits the sky into a horizon band and a deeper zenith; skyColor stays the horizon', () => {
    const s = new DayNightCycle({ time: 0.5 }).evaluate();
    expect(s.skyColor.getHex()).toBe(s.skyHorizon.getHex());
    // Noon: the zenith is the deeper blue — less red, more blue-vs-red contrast.
    expect(s.skyZenith.r).toBeLessThan(s.skyHorizon.r);
    expect(s.skyZenith.b / s.skyZenith.r).toBeGreaterThan(s.skyHorizon.b / s.skyHorizon.r);
  });

  it('dawn warms the horizon far more than the zenith', () => {
    const s = new DayNightCycle({ time: 0.25 }).evaluate();
    const warmth = (c: THREE.Color) => c.r / Math.max(c.b, 1e-6);
    expect(warmth(s.skyHorizon)).toBeGreaterThan(warmth(s.skyZenith) * 1.5);
  });

  it('night darkens both bands', () => {
    const s = new DayNightCycle({ time: 0 }).evaluate();
    expect(s.skyZenith.r + s.skyZenith.g + s.skyZenith.b).toBeLessThan(0.2);
    expect(s.skyHorizon.r + s.skyHorizon.g + s.skyHorizon.b).toBeLessThan(0.5);
  });

  it('applyTo feeds a sky dome the colors and the active luminary', () => {
    const sky = new SkyDome({ groundTintStrength: 0 });
    const cycle = new DayNightCycle({ time: 0 }); // midnight — moon is the light
    const s = cycle.applyTo({ sky });

    expect(sky.horizonColor.getHex()).toBe(s.skyHorizon.getHex());
    expect((sky.material.uniforms.uZenith.value as THREE.Color).getHex()).toBe(s.skyZenith.getHex());
    const dir = sky.material.uniforms.uSunDir.value as THREE.Vector3;
    expect(dir.y).toBeCloseTo(s.moonDir.y, 5);
    expect(sky.material.uniforms.uStars.value).toBe(1);
  });
});

describe('WeatherSystem overcast', () => {
  const makeWeather = (sky?: SkyDome) => new WeatherSystem({
    scene: new THREE.Object3D(),
    terrainMaterial: makeTerrainMaterial(),
    sky,
  });

  it('clear skies contribute nothing; rain and snow grey the sky', () => {
    const w = makeWeather();
    w.setWeather('clear');
    expect(w.overcast).toBe(0);
    w.setWeather('rain');
    expect(w.overcast).toBeGreaterThan(0.5);
    const rain = w.overcast;
    w.setWeather('snow');
    expect(w.overcast).toBeLessThan(rain); // snow falls from a lighter deck
    expect(w.overcast).toBeGreaterThan(0.5);
  });

  it('scales with intensity, so a storm greys the sky as it ramps in', () => {
    const w = makeWeather();
    w.setWeather('rain', { intensity: 0.5 });
    const half = w.overcast;
    w.setIntensity(1);
    expect(w.overcast).toBeCloseTo(half * 2, 6);
    w.setIntensity(0);
    expect(w.overcast).toBe(0);
  });

  it('pushes to an attached sky on every weather and intensity change', () => {
    const sky = new SkyDome();
    const w = makeWeather(sky);
    w.setWeather('rain');
    expect(sky.overcast).toBeCloseTo(w.overcast, 6);
    w.setIntensity(0.4);
    expect(sky.overcast).toBeCloseTo(w.overcast, 6);
    w.setWeather('clear');
    expect(sky.overcast).toBe(0);
  });

  it('setSky attaches an existing storm to a sky built later, and dispose clears it', () => {
    const sky = new SkyDome();
    const w = makeWeather();
    w.setWeather('rain');
    expect(sky.overcast).toBe(0);
    w.setSky(sky);
    expect(sky.overcast).toBeCloseTo(w.overcast, 6);
    w.dispose();
    expect(sky.overcast).toBe(0);
  });

  it('the overcast option overrides the per-type preset', () => {
    const w = makeWeather();
    w.setWeather('rain', { overcast: 0.25 });
    expect(w.overcast).toBeCloseTo(0.25, 6);
  });
});

describe('averageTerrainColor', () => {
  it('averages the solid terrain and skips liquids', () => {
    const defs = [
      { color: new THREE.Color(1, 0, 0), isWater: false },
      { color: new THREE.Color(0, 1, 0), isWater: false },
      { color: new THREE.Color(0, 0, 1), isWater: true }, // a big lake must not pull the sky blue
    ];
    const avg = averageTerrainColor(defs);
    expect(avg.r).toBeCloseTo(0.5, 6);
    expect(avg.g).toBeCloseTo(0.5, 6);
    expect(avg.b).toBeCloseTo(0, 6);
  });

  it('falls back to a neutral haze when everything is liquid', () => {
    const avg = averageTerrainColor([{ color: new THREE.Color(0, 0, 1), isWater: true }]);
    expect(avg.getHex()).toBe(0x8a8f7a);
  });

  it('produces a usable tint from the built-in palette', () => {
    const avg = averageTerrainColor(resolveTerrainDefinitions(DEFAULT_TERRAIN_DESCRIPTORS));
    for (const ch of [avg.r, avg.g, avg.b]) {
      expect(ch).toBeGreaterThan(0);
      expect(ch).toBeLessThanOrEqual(1);
    }
  });
});
