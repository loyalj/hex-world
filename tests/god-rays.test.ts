import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { GodRays } from '../src/sky/GodRays.js';
import { SkyDome } from '../src/sky/SkyDome.js';
import { DayNightCycle } from '../src/lighting/DayNightCycle.js';
import { WeatherSystem } from '../src/weather/WeatherSystem.js';

/** A camera looking level down -Z from the origin. */
function makeCamera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 500);
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, -1);
  return cam;
}

/**
 * Aim the camera at a world direction, so the sun lands in the middle of
 * frame. Deliberately leaves the view matrix stale — update() refreshes it
 * itself, so the rays can be read before the frame rather than after it.
 */
function lookAlong(cam: THREE.PerspectiveCamera, dir: THREE.Vector3): void {
  cam.lookAt(dir.clone().multiplyScalar(100));
}

const noonSun = () => new DayNightCycle({ time: 0.5 }).evaluate();

describe('GodRays gate', () => {
  it('opens with the sun up and in frame', () => {
    const rays = new GodRays();
    const cam = makeCamera();
    const s = noonSun();
    rays.setDayNight(s);
    lookAlong(cam, s.sunDir);
    expect(rays.update(cam)).toBeGreaterThan(0.9);
  });

  it('shuts at night — the shafts are scattered sunlight, not moonlight', () => {
    const rays = new GodRays();
    const cam = makeCamera();
    const s = new DayNightCycle({ time: 0 }).evaluate();
    rays.setDayNight(s);
    // Facing the moon, which is high overhead at midnight: the pass must still
    // stay shut, or the rays would fan out of the wrong luminary.
    lookAlong(cam, s.moonDir);
    expect(rays.update(cam)).toBe(0);
  });

  it('fades through dawn with the daylight the haze and tint use', () => {
    const cam = makeCamera();
    const strengths = [0.245, 0.25, 0.26, 0.28].map(time => {
      const rays = new GodRays();
      const s = new DayNightCycle({ time }).evaluate();
      rays.setDayNight(s);
      lookAlong(cam, s.sunDir);
      return rays.update(cam);
    });
    for (let i = 1; i < strengths.length; i++) {
      expect(strengths[i]).toBeGreaterThan(strengths[i - 1]);
    }
    expect(strengths[0]).toBeLessThan(0.05); // sun still on the horizon
    expect(strengths[strengths.length - 1]).toBeGreaterThan(0.4);
  });

  it('closes as the sun swings behind the camera instead of mirroring it', () => {
    const rays = new GodRays();
    const cam = makeCamera();
    const s = noonSun();
    rays.setDayNight(s);

    lookAlong(cam, s.sunDir);
    const facing = rays.update(cam);
    lookAlong(cam, s.sunDir.clone().negate());
    expect(rays.update(cam)).toBe(0);
    expect(facing).toBeGreaterThan(0.9);
  });

  it('fades out as the sun leaves the frame rather than popping', () => {
    const cam = makeCamera();
    const s = noonSun();
    const rays = new GodRays();
    rays.setDayNight(s);

    // Swing away from the sun in steps about an axis square to it, so each
    // step is that many degrees of real separation: the strength must fall
    // monotonically and reach zero well before the sun is behind us.
    const axis = new THREE.Vector3().crossVectors(s.sunDir, new THREE.Vector3(0, 1, 0)).normalize();
    let previous = Infinity;
    for (const deg of [0, 20, 35, 50, 70]) {
      lookAlong(cam, s.sunDir.clone().applyAxisAngle(axis, THREE.MathUtils.degToRad(deg)));
      const strength = rays.update(cam);
      expect(strength).toBeLessThanOrEqual(previous);
      previous = strength;
    }
    expect(previous).toBe(0);
  });

  it('still reads from a pitched RTS camera, whose sun sits above the frame', () => {
    // The view the library is actually built for: looking 30° down at the
    // ground with a low morning sun ahead — 40° of separation, so the sun is
    // outside a 50° frame and the shafts have to survive that or the whole
    // feature is one nobody ever sees.
    const cam = makeCamera();
    cam.lookAt(0, -Math.sin(THREE.MathUtils.degToRad(30)), -Math.cos(THREE.MathUtils.degToRad(30)));

    const rays = new GodRays();
    const elev = THREE.MathUtils.degToRad(10);
    rays.setSun(new THREE.Vector3(0, Math.sin(elev), -Math.cos(elev)), undefined, 0.89);
    expect(rays.update(cam)).toBeGreaterThan(0.4);
  });

  it('tracks the sun across the screen', () => {
    const rays = new GodRays();
    const cam = makeCamera();
    const s = noonSun();
    rays.setDayNight(s);

    lookAlong(cam, s.sunDir);
    const centred = rays.sunScreenPosition.clone();
    expect(centred.x).toBeCloseTo(0.5, 3);
    expect(centred.y).toBeCloseTo(0.5, 3);

    lookAlong(cam, s.sunDir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.2));
    rays.update(cam);
    expect(rays.sunScreenPosition.x).not.toBeCloseTo(0.5, 2);
  });
});

describe('GodRays overcast', () => {
  it('a solid deck puts the shafts out', () => {
    const rays = new GodRays();
    const cam = makeCamera();
    const s = noonSun();
    rays.setDayNight(s);
    lookAlong(cam, s.sunDir);
    const clear = rays.update(cam);

    rays.setOvercast(1);
    expect(rays.update(cam)).toBeLessThan(clear * 0.1);
  });

  it('takes overcast from an attached dome, so weather reaches it unwired', () => {
    const sky = new SkyDome();
    const rays = new GodRays({ sky });
    const cam = makeCamera();
    const s = noonSun();
    rays.setDayNight(s);
    lookAlong(cam, s.sunDir);
    const clear = rays.update(cam);

    const weather = new WeatherSystem({ scene: new THREE.Object3D(), sky });
    weather.setWeather('rain');
    expect(sky.overcast).toBeGreaterThan(0.5);
    expect(rays.update(cam)).toBeLessThan(clear * 0.5);
  });

});

describe('GodRays configuration', () => {
  it('normalises the gain by the decay series, so intensity stays "brightness at the sun"', () => {
    const cam = makeCamera();
    const s = noonSun();
    /** What a pixel with a clear line to the sun accumulates: gain × Σ decay^i. */
    const peak = (decay: number, samples: number) => {
      const rays = new GodRays({ decay, samples, intensity: 0.5 });
      rays.setDayNight(s);
      lookAlong(cam, s.sunDir);
      rays.update(cam);
      let series = 0;
      for (let i = 0, d = 1; i < samples; i++, d *= decay) series += d;
      return (rays.material.uniforms.uGain.value as number) * series;
    };
    // A short flare and a long throw land the same brightness at the disc —
    // decay changes the shafts' reach, not how bright the sun's foot is.
    expect(peak(0.93, 28)).toBeCloseTo(0.5, 5);
    expect(peak(0.98, 64)).toBeCloseTo(0.5, 5);
  });

  it('rebuilds the shader only when the sample count actually changes', () => {
    const rays = new GodRays({ samples: 24 });
    expect(rays.material.fragmentShader).toContain('#define SAMPLES 24');
    // needsUpdate is write-only; the recompile shows up as a version bump.
    const version = rays.material.version;
    rays.configure({ samples: 24 });
    expect(rays.material.version).toBe(version);
    rays.configure({ samples: 40 });
    expect(rays.material.fragmentShader).toContain('#define SAMPLES 40');
    expect(rays.material.version).toBeGreaterThan(version);
  });

  it('adds in the frame\'s own space: additive, depth-blind, and un-converted', () => {
    const rays = new GodRays();
    expect(rays.material.blending).toBe(THREE.AdditiveBlending);
    expect(rays.material.depthTest).toBe(false);
    expect(rays.material.depthWrite).toBe(false);
    // A colorspace conversion here would double-encode an already-final frame.
    expect(rays.material.fragmentShader).not.toContain('colorspace_fragment');
  });

  it('follows the sun color unless given one, so dawn shafts go orange', () => {
    const cam = makeCamera();
    const dawn = new DayNightCycle({ time: 0.28 }).evaluate();
    lookAlong(cam, dawn.sunDir);
    const color = (r: GodRays) => r.material.uniforms.uColor.value as THREE.Color;

    const rays = new GodRays();
    rays.setDayNight(dawn);
    rays.update(cam);
    expect(color(rays).r).toBeGreaterThan(color(rays).b * 1.5); // warm, like the light

    const noon = noonSun();
    rays.setDayNight(noon);
    rays.update(cam);
    expect(color(rays).getHex()).toBe(noon.lightColor.getHex());

    rays.configure({ color: 0x00ff00 });
    rays.update(cam);
    expect(color(rays).getHex()).toBe(0x00ff00);
    rays.configure({ color: null }); // back to following the sun
    rays.update(cam);
    expect(color(rays).getHex()).toBe(noon.lightColor.getHex());
  });

  it('clamps the knobs that would break the march', () => {
    const rays = new GodRays({ decay: 5, resolutionScale: 4, samples: 1 });
    expect(rays.material.uniforms.uDecay.value as number).toBeLessThan(1);
    expect(rays.resolutionScale).toBe(1);
    expect(rays.material.fragmentShader).toContain('#define SAMPLES 4');
    rays.configure({ resolutionScale: 0 });
    expect(rays.resolutionScale).toBeGreaterThan(0);
  });

  it('disabled parks the strength at zero', () => {
    const rays = new GodRays();
    const cam = makeCamera();
    const s = noonSun();
    rays.setDayNight(s);
    lookAlong(cam, s.sunDir);
    expect(rays.update(cam)).toBeGreaterThan(0);
    rays.setEnabled(false);
    expect(rays.enabled).toBe(false);
    expect(rays.strength).toBe(0);
  });
});

/**
 * Enough of a WebGLRenderer to drive the pass headlessly, recording the state
 * each render() call saw — which is the only way to check that the occlusion
 * pass borrows the scene and hands it back exactly as it found it.
 */
class FakeRenderer {
  autoClear = true;
  shadowMap = { autoUpdate: true };
  clearColor = new THREE.Color(0x102030);
  clearAlpha = 1;
  private target: THREE.WebGLRenderTarget | null = null;
  readonly calls: {
    target: THREE.WebGLRenderTarget | null;
    override: THREE.Material | null;
    background: unknown;
    autoClear: boolean;
    shadowAutoUpdate: boolean;
    clearColor: number;
    hidden: boolean[];
  }[] = [];
  /** Explicit clear()s, as [color, depth] pairs with the color in force. */
  readonly clears: { color: boolean; depth: boolean; hex: number }[] = [];

  constructor(private readonly watch: THREE.Object3D[] = []) {}

  getRenderTarget() { return this.target; }
  setRenderTarget(t: THREE.WebGLRenderTarget | null) { this.target = t; }
  getClearColor(out: THREE.Color) { return out.copy(this.clearColor); }
  getClearAlpha() { return this.clearAlpha; }
  setClearColor(c: THREE.ColorRepresentation, a: number) {
    this.clearColor = new THREE.Color(c);
    this.clearAlpha = a;
  }
  getDrawingBufferSize(out: THREE.Vector2) { return out.set(800, 600); }
  clear(color: boolean, depth: boolean) {
    this.clears.push({ color, depth, hex: this.clearColor.getHex() });
  }
  render(scene: THREE.Scene) {
    this.calls.push({
      target: this.target,
      override: scene.overrideMaterial,
      background: scene.background,
      autoClear: this.autoClear,
      shadowAutoUpdate: this.shadowMap.autoUpdate,
      clearColor: this.clearColor.getHex(),
      hidden: this.watch.map(o => !o.visible),
    });
  }
}

const asRenderer = (r: FakeRenderer) => r as unknown as THREE.WebGLRenderer;

describe('GodRays pass', () => {
  /** A lit noon scene with a sky dome and one occluder, aimed at the sun. */
  function makeScene() {
    const sky = new SkyDome();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x8fb2d9);
    sky.addTo(scene);
    const hill = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    scene.add(hill);

    const rays = new GodRays({ sky });
    const cam = makeCamera();
    const s = noonSun();
    rays.setDayNight(s);
    lookAlong(cam, s.sunDir);
    return { sky, scene, hill, rays, cam };
  }

  it('renders the mask into its own target, then composites onto the live frame', () => {
    const { sky, scene, rays, cam } = makeScene();
    const renderer = new FakeRenderer([sky.mesh]);
    rays.render(asRenderer(renderer), scene, cam);

    expect(renderer.calls).toHaveLength(2);
    const [mask, composite] = renderer.calls;

    // Mask: off-screen, every material replaced by flat black on a white
    // clear, with the sky's own background out of the way.
    expect(mask.target).not.toBeNull();
    expect((mask.override as THREE.MeshBasicMaterial).color.getHex()).toBe(0x000000);
    expect(mask.background).toBeNull();
    expect(mask.clearColor).toBe(0xffffff);
    // Wiped by hand, colour and depth, rather than through autoClear — a
    // consumer may have switched autoClearColor or autoClearDepth off.
    expect(mask.autoClear).toBe(false);
    expect(renderer.clears).toEqual([{ color: true, depth: true, hex: 0xffffff }]);
    // The dome is the light the shafts are made of, not something blocking it.
    expect(mask.hidden).toEqual([true]);
    // The frame's shadow maps are already drawn; redoing them here would
    // double the scene's shadow cost for a pass that ignores shading.
    expect(mask.shadowAutoUpdate).toBe(false);

    // Composite: back to the screen, adding to what is already there.
    expect(composite.target).toBeNull();
    expect(composite.autoClear).toBe(false);
    expect(composite.override).toBeNull();
  });

  it('hands the scene and the renderer back exactly as it found them', () => {
    const { sky, scene, rays, cam } = makeScene();
    const renderer = new FakeRenderer([sky.mesh]);
    const target = new THREE.WebGLRenderTarget(4, 4);
    renderer.setRenderTarget(target); // a consumer already rendering off-screen

    rays.render(asRenderer(renderer), scene, cam);

    expect(renderer.getRenderTarget()).toBe(target);
    expect(renderer.autoClear).toBe(true);
    expect(renderer.shadowMap.autoUpdate).toBe(true);
    expect(renderer.clearColor.getHex()).toBe(0x102030);
    expect(scene.overrideMaterial).toBeNull();
    expect((scene.background as THREE.Color).getHex()).toBe(0x8fb2d9);
    expect(sky.mesh.visible).toBe(true);
    // ...and the composite went back to the caller's target, not the canvas.
    expect(renderer.calls[1].target).toBe(target);
  });

  it('sizes the mask to a fraction of the drawing buffer', () => {
    const { scene, rays, cam } = makeScene();
    rays.configure({ resolutionScale: 0.25 });
    const renderer = new FakeRenderer();
    rays.render(asRenderer(renderer), scene, cam);

    const mask = renderer.calls[0].target!;
    expect([mask.width, mask.height]).toEqual([200, 150]);
    expect(rays.material.uniforms.uOcclusion.value).toBe(mask.texture);
  });

  it('skips the whole pass when the gate is shut, so night frames cost nothing', () => {
    const { scene, rays, cam } = makeScene();
    rays.setDayNight(new DayNightCycle({ time: 0 }).evaluate());
    const renderer = new FakeRenderer();
    rays.render(asRenderer(renderer), scene, cam);
    expect(renderer.calls).toHaveLength(0);

    rays.setDayNight(noonSun());
    rays.setEnabled(false);
    rays.render(asRenderer(renderer), scene, cam);
    expect(renderer.calls).toHaveLength(0);
  });

  it('restores an excluded object to whatever visibility it already had', () => {
    const { sky, scene, hill, rays, cam } = makeScene();
    rays.exclude(hill);
    hill.visible = false; // already hidden by the consumer
    const renderer = new FakeRenderer([sky.mesh, hill]);

    rays.render(asRenderer(renderer), scene, cam);
    expect(renderer.calls[0].hidden).toEqual([true, true]);
    expect(hill.visible).toBe(false);

    hill.visible = true;
    rays.include(hill);
    rays.render(asRenderer(renderer), scene, cam);
    // calls 0–1 were the first pass's mask and composite; this is the second.
    expect(renderer.calls[2].hidden).toEqual([true, false]); // occludes again
    expect(hill.visible).toBe(true);
  });
});

describe('DayNightCycle god-ray target', () => {
  it('applyTo drives the rays from the same state the dome takes', () => {
    const sky = new SkyDome();
    const rays = new GodRays({ sky });
    const cam = makeCamera();
    const cycle = new DayNightCycle({ time: 0.5 });
    const s = cycle.applyTo({ sky, godRays: rays });

    lookAlong(cam, s.sunDir);
    expect(rays.update(cam)).toBeGreaterThan(0.9);

    // ...and midnight shuts both: no stars-and-shafts sky.
    const night = new DayNightCycle({ time: 0 }).applyTo({ sky, godRays: rays });
    lookAlong(cam, night.sunDir);
    expect(rays.update(cam)).toBe(0);
    expect(sky.material.uniforms.uStars.value).toBe(1);
  });
});
