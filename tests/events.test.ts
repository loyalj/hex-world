import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { Emitter } from '../src/events/Emitter.js';
import { HexMap } from '../src/map/HexMap.js';
import { ChunkManager } from '../src/geometry/ChunkManager.js';
import { UnitManager } from '../src/units/UnitManager.js';
import { HexUnit } from '../src/units/HexUnit.js';
import { FogData } from '../src/geometry/FogData.js';
import { createLayout } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';
import { offsetToHex } from '../src/math/HexCoord.js';

interface TestEvents {
  ping: { n: number };
  pong: string;
}

describe('Emitter', () => {
  it('delivers a typed payload and unsubscribes through the returned function', () => {
    const events = new Emitter<TestEvents>();
    const seen: number[] = [];

    const off = events.on('ping', e => seen.push(e.n));
    events.emit('ping', { n: 1 });
    off();
    events.emit('ping', { n: 2 });

    expect(seen).toEqual([1]);
    expect(events.listenerCount('ping')).toBe(0);
  });

  it('reports whether anyone was listening, so callers can skip building a payload', () => {
    const events = new Emitter<TestEvents>();
    expect(events.emit('pong', 'nobody')).toBe(false);
    events.on('pong', () => {});
    expect(events.emit('pong', 'someone')).toBe(true);
  });

  it('never delivers the same event twice to one listener', () => {
    const events = new Emitter<TestEvents>();
    const fn = vi.fn();
    events.on('ping', fn);
    events.on('ping', fn);
    events.emit('ping', { n: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fires a `once` listener exactly one time', () => {
    const events = new Emitter<TestEvents>();
    const fn = vi.fn();
    events.once('ping', fn);
    events.emit('ping', { n: 1 });
    events.emit('ping', { n: 2 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ n: 1 });
    expect(events.listenerCount('ping')).toBe(0);
  });

  it('cancels a `once` subscription through off() with the original listener', () => {
    const events = new Emitter<TestEvents>();
    const fn = vi.fn();
    events.once('ping', fn);
    events.off('ping', fn);
    events.emit('ping', { n: 1 });
    expect(fn).not.toHaveBeenCalled();
  });

  // The reason emit() iterates a copy: a listener that unsubscribes during
  // dispatch would otherwise make the live iterator skip the next one.
  it('still delivers to listeners a mid-dispatch unsubscribe would have skipped', () => {
    const events = new Emitter<TestEvents>();
    const seen: string[] = [];

    const first = (): void => { seen.push('first'); events.off('ping', first); };
    events.on('ping', first);
    events.on('ping', () => seen.push('second'));
    events.on('ping', () => seen.push('third'));

    events.emit('ping', { n: 1 });
    expect(seen).toEqual(['first', 'second', 'third']);

    seen.length = 0;
    events.emit('ping', { n: 2 });
    expect(seen).toEqual(['second', 'third']);
  });

  it('does not deliver the in-flight event to a listener added during dispatch', () => {
    const events = new Emitter<TestEvents>();
    const late = vi.fn();
    events.on('ping', () => events.on('ping', late));

    events.emit('ping', { n: 1 });
    expect(late).not.toHaveBeenCalled();

    events.emit('ping', { n: 2 });
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('keeps delivering after a listener throws, and routes the error to onError', () => {
    const events = new Emitter<TestEvents>();
    const boom = new Error('listener bug');
    const errors: unknown[] = [];
    events.onError = (err) => errors.push(err);

    const after = vi.fn();
    events.on('ping', () => { throw boom; });
    events.on('ping', after);

    events.emit('ping', { n: 1 });

    expect(after).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([boom]);
  });

  it('clears one event type or all of them', () => {
    const events = new Emitter<TestEvents>();
    events.on('ping', () => {});
    events.on('pong', () => {});

    events.removeAllListeners('ping');
    expect(events.listenerCount('ping')).toBe(0);
    expect(events.listenerCount('pong')).toBe(1);

    events.removeAllListeners();
    expect(events.listenerCount('pong')).toBe(0);
  });
});

describe('ChunkManager streaming events', () => {
  const makeManager = (map: HexMap, scene: THREE.Scene) => new ChunkManager({
    map,
    layout: createLayout(POINTY_TOP, 1),
    scene,
    material: new THREE.MeshBasicMaterial(),
    chunkSize: 8,
  });

  it('emits chunkLoaded per chunk with the cell range it covers', () => {
    const scene = new THREE.Scene();
    const map   = new HexMap({ width: 16, height: 8 });
    const cm    = makeManager(map, scene);

    const loaded: { cx: number; cy: number }[] = [];
    cm.events.on('chunkLoaded', e => {
      loaded.push({ cx: e.cx, cy: e.cy });
      // Bounds are the half-open cell range, clamped to the map.
      expect(e.bounds.colStart).toBe(e.cx * 8);
      expect(e.bounds.colEnd).toBe(Math.min((e.cx + 1) * 8, map.width));
      expect(e.bounds.rowStart).toBe(e.cy * 8);
      expect(e.bounds.rowEnd).toBe(Math.min((e.cy + 1) * 8, map.height));
    });

    cm.loadAll();

    // 16x8 map at chunkSize 8 = two chunks side by side.
    expect(loaded).toHaveLength(2);
    expect(loaded.map(c => `${c.cx},${c.cy}`).sort()).toEqual(['0,0', '1,0']);
  });

  it('emits chunkUnloaded when chunks are torn down', () => {
    const scene = new THREE.Scene();
    const map   = new HexMap({ width: 16, height: 8 });
    const cm    = makeManager(map, scene);

    const unloaded: string[] = [];
    cm.events.on('chunkUnloaded', e => unloaded.push(`${e.cx},${e.cy}`));

    cm.loadAll();
    expect(unloaded).toHaveLength(0);

    cm.dispose();
    expect(unloaded.sort()).toEqual(['0,0', '1,0']);
  });

  it('fires chunkLoaded only after the chunk mesh is in the scene', () => {
    const scene = new THREE.Scene();
    const map   = new HexMap({ width: 8, height: 8 });
    const cm    = makeManager(map, scene);

    let meshCountAtEmit = -1;
    cm.events.on('chunkLoaded', () => { meshCountAtEmit = scene.children.length; });
    cm.loadAll();

    expect(meshCountAtEmit).toBeGreaterThan(0);
  });
});

describe('UnitManager events', () => {
  const layout = createLayout(POINTY_TOP, 1);

  /** A unit walking a straight three-cell path, plus everything to drive it. */
  function scenario(opts: { fog?: FogData } = {}) {
    const scene = new THREE.Scene();
    const map   = new HexMap({ width: 16, height: 16 });
    const manager = new UnitManager({ scene, map, layout, fogData: opts.fog });
    const unit = new HexUnit({ col: 2, row: 2, travelSpeed: 4, fogRevealRange: opts.fog ? 2 : 0 });
    const object3D = new THREE.Object3D();
    const path = [offsetToHex(2, 2), offsetToHex(3, 2), offsetToHex(4, 2)];

    /** Run the manager far enough to walk the whole path. */
    const run = (): void => { for (let i = 0; i < 20; i++) manager.update(0.1); };

    return { scene, map, manager, unit, object3D, path, run };
  }

  it('emits unitAdded and unitRemoved with the unit and its Object3D', () => {
    const { manager, unit, object3D } = scenario();
    const added: unknown[] = [];
    const removed: unknown[] = [];
    manager.events.on('unitAdded',   e => added.push(e));
    manager.events.on('unitRemoved', e => removed.push(e));

    manager.addUnit(unit, object3D);
    expect(added).toEqual([{ unit, object3D }]);

    manager.removeUnit(unit);
    expect(removed).toEqual([{ unit, object3D }]);
  });

  it('emits moveStart, a cellEnter per crossed cell, and arrived at the end of the path', () => {
    const { manager, unit, object3D, path, run } = scenario();
    manager.addUnit(unit, object3D);

    const order: string[] = [];
    const entered: string[] = [];
    manager.events.on('unitMoveStart', () => order.push('start'));
    manager.events.on('unitCellEnter', e => { order.push('enter'); entered.push(`${e.col},${e.row}`); });
    manager.events.on('unitArrived',   e => order.push(`arrived:${e.col},${e.row}`));

    unit.travel(path);
    run();

    // path[0] is where the unit already stands, so only the two steps fire.
    expect(entered).toEqual(['3,2', '4,2']);
    expect(order).toEqual(['start', 'enter', 'enter', 'arrived:4,2']);
  });

  it('distinguishes arriving from being stopped short', () => {
    const { manager, unit, object3D, path } = scenario();
    manager.addUnit(unit, object3D);

    const arrived = vi.fn();
    const ended   = vi.fn();
    manager.events.on('unitArrived', arrived);
    manager.events.on('unitMoveEnd', ended);

    unit.travel(path);
    manager.update(0.1);   // part-way through the first segment
    unit.stop();

    expect(arrived).not.toHaveBeenCalled();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0][0]).toMatchObject({ unit, completed: false });
  });

  it('emits unitMoveEnd with completed: true alongside unitArrived', () => {
    const { manager, unit, object3D, path, run } = scenario();
    manager.addUnit(unit, object3D);

    const ended = vi.fn();
    manager.events.on('unitMoveEnd', ended);

    unit.travel(path);
    run();

    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0][0]).toMatchObject({ completed: true, col: 4, row: 2 });
  });

  it('wraps the unit\'s own callbacks rather than replacing them', () => {
    const { manager, unit, object3D, path, run } = scenario();
    const ownStart = vi.fn();
    const ownEnter = vi.fn();
    const ownEnd   = vi.fn();
    unit.onMoveStart = ownStart;
    unit.onCellEnter = ownEnter;
    unit.onMoveEnd   = ownEnd;

    manager.addUnit(unit, object3D);
    unit.travel(path);
    run();

    expect(ownStart).toHaveBeenCalledTimes(1);
    expect(ownEnter).toHaveBeenCalledTimes(2);
    expect(ownEnd).toHaveBeenCalledWith(true);
  });

  it('restores the original callbacks on removeUnit, so re-adding does not stack fog reveals', () => {
    const fog = new FogData(16, 16);
    const { manager, unit, object3D, path, run } = scenario({ fog });
    const own = vi.fn();
    unit.onCellEnter = own;

    manager.addUnit(unit, object3D);
    manager.removeUnit(unit);
    expect(unit.onCellEnter).toBe(own);

    // Re-add and walk: a double-wrapped unit would raise each cell's visibility
    // count twice and leave it lit after the unit moves on.
    manager.addUnit(unit, object3D);
    unit.travel(path);
    run();
    manager.removeUnit(unit);

    for (let row = 0; row < 16; row++) {
      for (let col = 0; col < 16; col++) {
        expect(fog.isVisible(col, row)).toBe(false);
      }
    }
  });
});
