import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { SunShadowRig } from '../src/lighting/SunShadows.js';
import { createTerrainMaterial } from '../src/geometry/TerrainMaterial.js';
import { createRoadMaterial } from '../src/geometry/RoadMaterial.js';

/** Straight-down camera hovering `height` above ground point (x, z). */
function topDownCamera(x: number, z: number, height: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  cam.position.set(x, height, z);
  cam.lookAt(x, 0, z);
  cam.updateMatrixWorld(true);
  return cam;
}

describe('SunShadowRig', () => {
  it('creates a shadow-casting directional light with tuned defaults', () => {
    const rig = new SunShadowRig();
    expect(rig.light.castShadow).toBe(true);
    expect(rig.light.shadow.mapSize.x).toBe(2048);
    expect(rig.light.shadow.normalBias).toBeGreaterThan(0);
    expect(rig.enabled).toBe(true);
    rig.setEnabled(false);
    expect(rig.light.castShadow).toBe(false);
  });

  it('addTo adds both the light and its target', () => {
    const scene = new THREE.Scene();
    const rig = new SunShadowRig().addTo(scene);
    expect(scene.children).toContain(rig.light);
    expect(scene.children).toContain(rig.light.target);
  });

  it('normalizes the sun direction', () => {
    const rig = new SunShadowRig();
    rig.setDirection(new THREE.Vector3(0, 10, 0));
    expect(rig.direction.length()).toBeCloseTo(1);
    expect(rig.direction.y).toBeCloseTo(1);
  });

  it('fits the ortho frustum around a top-down camera footprint', () => {
    const rig = new SunShadowRig();
    const cam = topDownCamera(50, 50, 30);
    rig.update(cam);

    // Ground footprint of a 45° fov, aspect-1 camera at height 30 is a square
    // with half-size 30·tan(22.5°) ≈ 12.4 centered on (50, 50).
    const half = 30 * Math.tan(THREE.MathUtils.degToRad(22.5));
    const t = rig.light.target.position;
    expect(t.x).toBeCloseTo(50, 0);
    expect(t.z).toBeCloseTo(50, 0);

    // The window must cover the footprint diagonal but stay in the same order
    // of magnitude (no world-sized frustum).
    const diag = Math.hypot(half, half);
    expect(rig.light.shadow.camera.right).toBeGreaterThanOrEqual(diag);
    expect(rig.light.shadow.camera.right).toBeLessThan(diag * 3);

    // Light sits up-sun of the target.
    const toLight = rig.light.position.clone().sub(t).normalize();
    expect(toLight.dot(rig.direction)).toBeCloseTo(1, 5);

    // Depth range spans the fitted volume.
    const shadowCam = rig.light.shadow.camera;
    expect(shadowCam.far).toBeGreaterThan(rig.light.position.distanceTo(t));
  });

  it('clamps the frustum at shallow pitches instead of chasing the horizon', () => {
    const rig = new SunShadowRig({ maxDistance: 90 });
    const cam = new THREE.PerspectiveCamera(45, 2, 0.1, 500);
    cam.position.set(0, 10, 0);
    cam.lookAt(0, 8, -100); // nearly horizontal — far corners never hit the ground
    cam.updateMatrixWorld(true);
    rig.update(cam);
    // Everything is clamped to maxDistance of the camera, so the fitted radius
    // is bounded by it (plus height/padding slack).
    expect(rig.light.shadow.camera.right).toBeLessThanOrEqual(90 + 14 + 2);
    expect(Number.isFinite(rig.light.shadow.camera.far)).toBe(true);
  });

  it('snaps the shadow window to whole texels as the camera pans', () => {
    const rig = new SunShadowRig();
    const before = new THREE.Vector3();
    const after  = new THREE.Vector3();

    rig.update(topDownCamera(50, 50, 30));
    before.copy(rig.light.target.position);
    const radius = rig.light.shadow.camera.right;

    // A sub-texel pan: same footprint shape, so same radius and texel size.
    rig.update(topDownCamera(50.013, 50, 30));
    after.copy(rig.light.target.position);
    expect(rig.light.shadow.camera.right).toBeCloseTo(radius, 6);

    const texel = (2 * radius) / rig.light.shadow.mapSize.x;
    const delta = after.sub(before);
    // Movement happens in whole-texel steps in the light's frame — either the
    // window held still or it stepped by exact texel multiples.
    const UP = new THREE.Vector3(0, 1, 0);
    const xAxis = new THREE.Vector3().crossVectors(UP, rig.direction).normalize();
    const yAxis = new THREE.Vector3().crossVectors(rig.direction, xAxis);
    for (const axis of [xAxis, yAxis]) {
      const steps = delta.dot(axis) / texel;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-4);
    }
  });

  it('skips fitting while disabled', () => {
    const rig = new SunShadowRig();
    rig.setEnabled(false);
    const posBefore = rig.light.position.clone();
    rig.update(topDownCamera(50, 50, 30));
    expect(rig.light.position.equals(posBefore)).toBe(true);
  });
});

describe('terrain material shadow support', () => {
  function makeMaterial(): THREE.ShaderMaterial {
    const tex = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
    return createTerrainMaterial(tex);
  }

  it('opts into the renderer light state and declares the shadow chunks', () => {
    const mat = makeMaterial();
    expect(mat.lights).toBe(true);
    expect(mat.vertexShader).toContain('#include <shadowmap_pars_vertex>');
    expect(mat.vertexShader).toContain('#include <shadowmap_vertex>');
    expect(mat.fragmentShader).toContain('#include <shadowmap_pars_fragment>');
    expect(mat.fragmentShader).toContain('getShadowMask()');
  });

  it('merges the lights uniform lib without clobbering the hand-rolled lighting', () => {
    const mat = makeMaterial();
    // Renderer-filled shadow uniforms exist (lights: true upload targets;
    // the shadow map sampler itself is program-direct in modern three)…
    for (const name of ['directionalLightShadows', 'directionalShadowMatrix', 'ambientLightColor']) {
      expect(mat.uniforms[name]).toBeDefined();
    }
    // …and the custom lighting uniforms survived the merge.
    for (const name of ['uLightDir', 'uLightColor', 'uAmbient', 'uTerrainTex']) {
      expect(mat.uniforms[name]).toBeDefined();
    }
  });
});

describe('road material shadow support', () => {
  it('runs the terrain lighting model so the decal shades with the ground', () => {
    const mat = createRoadMaterial();
    expect(mat.lights).toBe(true);
    for (const name of ['uLightDir', 'uLightColor', 'uAmbient', 'directionalLightShadows']) {
      expect(mat.uniforms[name]).toBeDefined();
    }
    expect(mat.vertexShader).toContain('#include <shadowmap_vertex>');
    expect(mat.fragmentShader).toContain('getShadowMask()');
  });

  it('takes the terrain material options so both agree without a day/night cycle', () => {
    const mat = createRoadMaterial({
      lightDir:   new THREE.Vector3(0, 2, 0),
      lightColor: new THREE.Color(0x804020),
      ambient:    new THREE.Color(0x101010),
    });
    expect((mat.uniforms.uLightDir.value as THREE.Vector3).y).toBeCloseTo(1, 6); // normalized
    expect((mat.uniforms.uLightColor.value as THREE.Color).getHex()).toBe(0x804020);
    expect((mat.uniforms.uAmbient.value as THREE.Color).getHex()).toBe(0x101010);
  });
});
