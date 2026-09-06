import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { HexMap } from '../src/map/HexMap.js';
import { HexPicker } from '../src/geometry/HexPicker.js';
import { createLayout } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';

/** A stand-in canvas: 200×100 CSS pixels at the page origin. */
const domElement = {
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }),
} as unknown as HTMLElement;

function makePicker(holdFrames: number): { picker: HexPicker; camera: THREE.PerspectiveCamera } {
  const map    = new HexMap({ width: 20, height: 20 });
  const layout = createLayout(POINTY_TOP, 1);
  // Level camera a little above the ground: the lower half of the view shows
  // terrain (a downward ray at the bottom edge lands around row 12 of 20),
  // the upper half sky.
  const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 500);
  camera.position.set(15, 3, 25);
  camera.lookAt(15, 3, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const picker = new HexPicker({ camera, domElement, layout, map, meshes: [], holdFrames });
  return { picker, camera };
}

describe('HexPicker.holding', () => {
  it('is set only while a miss is being bridged by a held cell, and clears when the hold runs out', () => {
    const { picker } = makePicker(2);
    expect(picker.holding).toBe(false);

    const hit = picker.pick(100, 90); // low on screen: ground
    expect(hit).not.toBeNull();
    expect(picker.holding).toBe(false);

    // Up at the sky: the miss is bridged for two frames, then released.
    expect(picker.pick(100, 5)).toEqual(hit);
    expect(picker.holding).toBe(true);
    expect(picker.pick(100, 5)).toEqual(hit);
    expect(picker.holding).toBe(true);
    expect(picker.pick(100, 5)).toBeNull();
    expect(picker.holding).toBe(false);
  });

  it('a fresh hit ends the hold', () => {
    const { picker } = makePicker(4);
    const hit = picker.pick(100, 90);
    picker.pick(100, 5);
    expect(picker.holding).toBe(true);
    expect(picker.pick(100, 90)).toEqual(hit);
    expect(picker.holding).toBe(false);
  });
});
