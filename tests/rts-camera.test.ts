import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { RtsCameraController, type RtsCameraOptions } from '../src/camera/RtsCameraController.js';

/** Just enough DOM for the controller to bind to, with the handlers reachable. */
function fakeElement() {
  const handlers = new Map<string, (e: never) => void>();
  return {
    handlers,
    addEventListener(type: string, fn: (e: never) => void) { handlers.set(type, fn); },
    removeEventListener(type: string) { handlers.delete(type); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 450 }),
  };
}

function makeControls(opts: Partial<RtsCameraOptions> = {}) {
  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 500);
  const el = fakeElement();
  const controls = new RtsCameraController({
    camera,
    domElement: el as unknown as HTMLElement,
    initialDistance: 60,
    ...opts,
  });
  return { camera, controls, el };
}

/** Run the controller's damping to convergence. */
const settle = (c: RtsCameraController) => { for (let i = 0; i < 400; i++) c.update(); };

/** World direction the top-centre of the frame points along. */
function topOfFrameDir(camera: THREE.PerspectiveCamera): THREE.Vector3 {
  camera.updateMatrixWorld(true);
  return new THREE.Vector3(0, 1, 0.5).unproject(camera).sub(camera.position).normalize();
}

describe('RtsCameraController yaw', () => {
  it('yaw 0 is the placement it has always had: +Z of the target, looking −Z', () => {
    const { camera, controls } = makeControls({ initialPitch: 30, initialTarget: { x: 5, z: -7 } });
    const p = THREE.MathUtils.degToRad(30);
    expect(camera.position.x).toBeCloseTo(5, 6);
    expect(camera.position.y).toBeCloseTo(Math.sin(p) * 60, 6);
    expect(camera.position.z).toBeCloseTo(-7 + Math.cos(p) * 60, 6);
    expect(controls.currentYawDeg).toBe(0);
  });

  it('swings the camera around the target while keeping it on the target', () => {
    const { camera, controls } = makeControls({ initialPitch: 30, initialTarget: { x: 0, z: 0 } });
    const height = camera.position.y;
    const radius = Math.hypot(camera.position.x, camera.position.z);

    controls.rotateTo(90);
    settle(controls);

    // A quarter turn puts the camera on the −X side (yaw is counter-clockwise
    // seen from above), at the same height and orbit radius.
    expect(controls.currentYawDeg).toBeCloseTo(90, 3);
    expect(camera.position.y).toBeCloseTo(height, 4);
    expect(Math.hypot(camera.position.x, camera.position.z)).toBeCloseTo(radius, 4);
    expect(camera.position.x).toBeCloseTo(radius, 3);
    expect(camera.position.z).toBeCloseTo(0, 3);

    // ...and it is still looking at the ground point it orbits.
    camera.updateMatrixWorld(true);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const toTarget = new THREE.Vector3().sub(camera.position).normalize();
    expect(forward.angleTo(toTarget)).toBeLessThan(1e-5);
  });

  it('rotateTo takes the short way round rather than unwinding the long one', () => {
    const { controls } = makeControls();
    controls.rotateTo(170);
    settle(controls);
    controls.rotateTo(-170);
    settle(controls);
    // 20° the short way, not 340° the long way — the unwrapped yaw proves which.
    expect(controls.currentYaw * (180 / Math.PI)).toBeCloseTo(190, 3);
    expect(controls.currentYawDeg).toBeCloseTo(-170, 3);
  });

  it('rotateBy accumulates past a full turn instead of wrapping', () => {
    const { controls } = makeControls();
    controls.rotateBy(200);
    controls.rotateBy(200);
    settle(controls);
    expect(controls.currentYaw * (180 / Math.PI)).toBeCloseTo(400, 3);
    expect(controls.currentYawDeg).toBeCloseTo(40, 3);
  });

  it('middle-drag tilts on the vertical axis and swings on the horizontal one', () => {
    const { controls, el } = makeControls({ initialPitch: 40, tiltSpeed: 0.5, yawSpeed: 0.5 });
    const down = el.handlers.get('mousedown') as (e: unknown) => void;
    const move = el.handlers.get('mousemove') as (e: unknown) => void;

    down({ button: 1, clientX: 100, clientY: 100, preventDefault() {} });
    move({ clientX: 140, clientY: 80 });
    settle(controls);

    expect(controls.currentPitchDeg).toBeCloseTo(40 + 20 * 0.5, 3); // dragged up = steeper
    expect(controls.currentYawDeg).toBeCloseTo(-40 * 0.5, 3);
  });
});

describe('RtsCameraController mode switching', () => {
  /** What an app's "RTS" and "Free" presets are made of. */
  const rts  = (c: RtsCameraController) => { c.setPitchLimits(30, 66); c.setYawEnabled(false); };
  const free = (c: RtsCameraController) => { c.setPitchLimits(6, 80);  c.setYawEnabled(true);  };

  it('locking the yaw returns the heading to 0 and ignores further turns', () => {
    const { camera, controls } = makeControls({ initialPitch: 40 });
    free(controls);
    controls.rotateTo(120);
    settle(controls);
    expect(controls.currentYawDeg).toBeCloseTo(120, 3);

    rts(controls);
    settle(controls);
    expect(controls.yawEnabled).toBe(false);
    expect(controls.currentYawDeg).toBeCloseTo(0, 3);
    // Back on the +Z side, exactly where the constrained view has always sat.
    expect(camera.position.x).toBeCloseTo(0, 4);
    expect(camera.position.z).toBeGreaterThan(0);

    controls.rotateTo(90);
    controls.rotateBy(45);
    settle(controls);
    expect(controls.currentYawDeg).toBeCloseTo(0, 3);
  });

  it('unwinds the short way when locking, rather than spinning the long way home', () => {
    const { controls } = makeControls();
    free(controls);
    controls.rotateBy(350); // nearly all the way round
    settle(controls);
    rts(controls);
    settle(controls);
    // Forward 10° to 360, not backward 350° through where it came from.
    expect(controls.currentYaw * (180 / Math.PI)).toBeCloseTo(360, 3);
    expect(controls.currentYawDeg).toBeCloseTo(0, 3);
  });

  it('a locked yaw still tilts — only the heading is pinned', () => {
    const { controls, el } = makeControls({ initialPitch: 40, tiltSpeed: 0.5, yawSpeed: 0.5 });
    rts(controls);
    const down = el.handlers.get('mousedown') as (e: unknown) => void;
    const move = el.handlers.get('mousemove') as (e: unknown) => void;
    down({ button: 1, clientX: 100, clientY: 100, preventDefault() {} });
    move({ clientX: 200, clientY: 80 });
    settle(controls);
    expect(controls.currentPitchDeg).toBeCloseTo(50, 3);
    expect(controls.currentYawDeg).toBeCloseTo(0, 3);
  });

  it('tightening the limits glides the current tilt back inside them', () => {
    const { controls } = makeControls({ initialPitch: 40 });
    free(controls);
    controls.tiltTo(6);
    settle(controls);
    expect(controls.currentPitchDeg).toBeCloseTo(6, 3);

    rts(controls); // 6° is below the RTS floor of 30°
    expect(controls.minPitchDeg).toBeCloseTo(30, 6);
    settle(controls);
    expect(controls.currentPitchDeg).toBeCloseTo(30, 3);
  });

  it('switching back to free restores the freedom, from wherever RTS left it', () => {
    const { controls } = makeControls({ initialPitch: 40 });
    rts(controls);
    settle(controls);
    free(controls);
    expect(controls.yawEnabled).toBe(true);
    controls.rotateTo(-75);
    controls.tiltTo(6);
    settle(controls);
    expect(controls.currentYawDeg).toBeCloseTo(-75, 3);
    expect(controls.currentPitchDeg).toBeCloseTo(6, 3);
  });

  it('takes reversed pitch limits in either order instead of trapping the tilt', () => {
    const { controls } = makeControls({ initialPitch: 40 });
    controls.setPitchLimits(70, 20);
    expect(controls.minPitchDeg).toBeCloseTo(20, 6);
    expect(controls.maxPitchDeg).toBeCloseTo(70, 6);
  });
});

describe('RtsCameraController pitch limits', () => {
  it('tiltTo clamps to the controller\'s own limits', () => {
    const { controls } = makeControls({ minPitch: 6, maxPitch: 66 });
    controls.tiltTo(90);
    settle(controls);
    expect(controls.currentPitchDeg).toBeCloseTo(66, 3);
    controls.tiltTo(-30);
    settle(controls);
    expect(controls.currentPitchDeg).toBeCloseTo(6, 3);
  });

  it('the default floor puts the horizon inside the frame', () => {
    // The whole point of the 6° default: at the old 30°, with a 45° vertical
    // FOV, the top edge of the frame sat 7.5° *below* horizontal — no sky ever
    // reached the screen, so the sky dome, sunsets, and god rays were all
    // looking at something the camera could not be pointed at.
    const { camera, controls } = makeControls();
    controls.tiltTo(controls.minPitchDeg);
    settle(controls);
    expect(controls.minPitchDeg).toBeLessThan(45 / 2);
    expect(topOfFrameDir(camera).y).toBeGreaterThan(0.1); // well above horizontal

    const steep = makeControls({ minPitch: 30 });
    steep.controls.tiltTo(30);
    settle(steep.controls);
    expect(topOfFrameDir(steep.camera).y).toBeLessThan(0); // the old floor: no sky
  });
});
