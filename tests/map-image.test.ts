import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { HexMap } from '../src/map/HexMap.js';
import { createLayout } from '../src/math/HexLayout.js';
import { POINTY_TOP, FLAT_TOP } from '../src/math/HexOrientation.js';
import { hexCorners } from '../src/math/HexLayout.js';
import { offsetToHex, offsetNeighbor } from '../src/math/HexCoord.js';
import { resolveTerrainDefinitions, DEFAULT_TERRAIN_DESCRIPTORS } from '../src/geometry/TerrainTypes.js';
import { FogData } from '../src/geometry/FogData.js';
import {
  getMapWorldBounds, getMapImageTransform, drawMapImage,
  type MapImageContext,
} from '../src/map/MapImageRenderer.js';
import { cameraGroundFootprint, groundPointFromNdc } from '../src/camera/GroundProjection.js';

const layout = createLayout(POINTY_TOP, 1);
const defs   = resolveTerrainDefinitions(DEFAULT_TERRAIN_DESCRIPTORS);

// A recording stand-in for a 2D canvas context. Only the calls drawMapImage
// makes are implemented, which is exactly the surface MapImageContext names.
interface Call { op: string; args: number[] }

/** One `moveTo`→`lineTo` run: [startX, startY, ...ends]. */
type Segment = number[];

interface Stroke { color: string; width: number; segments: Segment[] }

function recorder() {
  const calls: Call[] = [];
  const fills:   string[] = [];
  const strokes: Stroke[] = [];
  let path: Segment[] = [];

  const ctx: MapImageContext = {
    fillStyle:   '',
    strokeStyle: '',
    lineWidth:   1,
    lineCap:     'butt',
    lineJoin:    'miter',
    beginPath() { calls.push({ op: 'beginPath', args: [] }); path = []; },
    moveTo(x, y) { calls.push({ op: 'moveTo', args: [x, y] }); path.push([x, y]); },
    lineTo(x, y) { calls.push({ op: 'lineTo', args: [x, y] }); path[path.length - 1]?.push(x, y); },
    closePath() { calls.push({ op: 'closePath', args: [] }); },
    fill() { calls.push({ op: 'fill', args: [] }); fills.push(String(ctx.fillStyle)); },
    stroke() {
      calls.push({ op: 'stroke', args: [] });
      strokes.push({ color: String(ctx.strokeStyle), width: ctx.lineWidth, segments: path.map(s => [...s]) });
    },
    fillRect(x, y, w, h) { calls.push({ op: 'fillRect', args: [x, y, w, h] }); fills.push(String(ctx.fillStyle)); },
    clearRect(x, y, w, h) { calls.push({ op: 'clearRect', args: [x, y, w, h] }); },
  };

  return { ctx, calls, fills, strokes };
}

describe('getMapWorldBounds', () => {
  it('matches a brute-force sweep over every corner, both orientations', () => {
    for (const orientation of [POINTY_TOP, FLAT_TOP]) {
      const lay = createLayout(orientation, 1.7, 3, -4);
      const map = new HexMap({ width: 9, height: 7 });

      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let row = 0; row < map.height; row++) {
        for (let col = 0; col < map.width; col++) {
          for (const { x, z } of hexCorners(lay, offsetToHex(col, row))) {
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
          }
        }
      }

      const b = getMapWorldBounds(map, lay);
      expect(b.minX).toBeCloseTo(minX, 10);
      expect(b.maxX).toBeCloseTo(maxX, 10);
      expect(b.minZ).toBeCloseTo(minZ, 10);
      expect(b.maxZ).toBeCloseTo(maxZ, 10);
    }
  });
});

describe('getMapImageTransform', () => {
  it('sizes the image from the bounds, scale, and padding', () => {
    const map = new HexMap({ width: 10, height: 10 });
    const t   = getMapImageTransform(map, layout, { scale: 3, padding: 5 });
    const b   = getMapWorldBounds(map, layout);

    expect(t.width).toBe(Math.ceil((b.maxX - b.minX) * 3) + 10);
    expect(t.height).toBe(Math.ceil((b.maxZ - b.minZ) * 3) + 10);
    expect(t.scale).toBe(3);
    expect(t.padding).toBe(5);
  });

  it('defaults to scale 4 and padding 2', () => {
    const map = new HexMap({ width: 4, height: 4 });
    const t   = getMapImageTransform(map, layout);
    expect(t.scale).toBe(4);
    expect(t.padding).toBe(2);
  });

  it('puts the top-left of the bounds at the padding corner', () => {
    const map = new HexMap({ width: 6, height: 6 });
    const t   = getMapImageTransform(map, layout, { scale: 2, padding: 4 });
    const p   = t.worldToImage(t.bounds.minX, t.bounds.minZ);
    expect(p.x).toBeCloseTo(4);
    expect(p.y).toBeCloseTo(4);
  });

  it('round-trips world → image → world', () => {
    const map = new HexMap({ width: 12, height: 8 });
    const t   = getMapImageTransform(map, layout, { scale: 2.5, padding: 3 });
    for (const [x, z] of [[0, 0], [4.5, -2.25], [-7, 11]]) {
      const px = t.worldToImage(x, z);
      const w  = t.imageToWorld(px.x, px.y);
      expect(w.x).toBeCloseTo(x, 10);
      expect(w.z).toBeCloseTo(z, 10);
    }
  });

  it('writes into the caller-supplied out object when given one', () => {
    const map = new HexMap({ width: 4, height: 4 });
    const t   = getMapImageTransform(map, layout);
    const out = { x: 0, y: 0 };
    expect(t.worldToImage(1, 2, out)).toBe(out);
    const outW = { x: 0, z: 0 };
    expect(t.imageToWorld(out.x, out.y, outW)).toBe(outW);
    expect(outW.x).toBeCloseTo(1, 10);
    expect(outW.z).toBeCloseTo(2, 10);
  });
});

describe('drawMapImage', () => {
  it('fills the background then one hex path per cell', () => {
    const map = new HexMap({ width: 3, height: 3 });
    const { ctx, calls } = recorder();

    const t = drawMapImage(ctx, map, layout, defs, { scale: 2, background: '#123456' });

    expect(calls[0]).toEqual({ op: 'fillRect', args: [0, 0, t.width, t.height] });
    // 6 corners per hex: one moveTo + five lineTo, closed and filled.
    expect(calls.filter(c => c.op === 'closePath')).toHaveLength(9);
    expect(calls.filter(c => c.op === 'lineTo')).toHaveLength(9 * 5);
  });

  it('clears instead of filling when transparent', () => {
    const map = new HexMap({ width: 2, height: 2 });
    const { ctx, calls } = recorder();
    const t = drawMapImage(ctx, map, layout, defs, { transparent: true });
    expect(calls[0]).toEqual({ op: 'clearRect', args: [0, 0, t.width, t.height] });
    expect(calls.some(c => c.op === 'fillRect')).toBe(false);
  });

  it('returns the same transform getMapImageTransform would build', () => {
    const map = new HexMap({ width: 5, height: 4 });
    const { ctx } = recorder();
    const drawn    = drawMapImage(ctx, map, layout, defs, { scale: 3, padding: 1 });
    const standalone = getMapImageTransform(map, layout, { scale: 3, padding: 1 });
    expect(drawn.width).toBe(standalone.width);
    expect(drawn.height).toBe(standalone.height);
    expect(drawn.bounds).toEqual(standalone.bounds);
  });

  it('skips cells whose terrain index has no definition', () => {
    const map = new HexMap({ width: 2, height: 1 });
    map.setTerrain(1, 0, 200); // not in DEFAULT_TERRAIN_DESCRIPTORS
    const { ctx, calls } = recorder();
    drawMapImage(ctx, map, layout, defs);
    expect(calls.filter(c => c.op === 'closePath')).toHaveLength(1);
  });

  it('paints the cellTint over the terrain fill, per cell', () => {
    const map = new HexMap({ width: 2, height: 2 });
    const { ctx, fills } = recorder();

    drawMapImage(ctx, map, layout, defs, {
      background: '#000000',
      cellTint: (col, row) => (col === 0 && row === 0 ? 'rgba(255,0,0,0.5)' : null),
    });

    // background + 4 terrain fills + 1 tint
    expect(fills).toHaveLength(6);
    expect(fills.filter(f => f === 'rgba(255,0,0,0.5)')).toHaveLength(1);
    // The tint lands immediately after that cell's terrain fill.
    expect(fills[2]).toBe('rgba(255,0,0,0.5)');
  });

  it('strokes one spoke per river edge, meeting at the shared edge midpoint', () => {
    const map = new HexMap({ width: 3, height: 3 });
    // A river crossing edge 0 of (1,1), paired on both sides as the generators write it.
    const nb = offsetNeighbor(1, 1, POINTY_TOP.edgeDirections[0]);
    map.setRiverOutgoing(1, 1, 0);
    map.setRiverIncoming(nb.col, nb.row, 3);
    const { ctx, strokes } = recorder();

    const t = drawMapImage(ctx, map, layout, defs, { scale: 4, rivers: true });

    // Two cells carry a river bit — one stroke each, one spoke apiece.
    expect(strokes).toHaveLength(2);
    expect(strokes.every(s => s.segments.length === 1)).toBe(true);
    expect(strokes.every(s => s.color === '#4d8ecb')).toBe(true);

    // Both spokes end on the same point: the midpoint of the shared edge.
    const [a, b] = strokes.map(s => s.segments[0]);
    expect(a[2]).toBeCloseTo(b[2], 8);
    expect(a[3]).toBeCloseTo(b[3], 8);
    // ...and start from their own cell centers, which differ.
    expect(a[0] !== b[0] || a[1] !== b[1]).toBe(true);
    expect(t.scale).toBe(4);
  });

  it('honours river and road style overrides and draws roads under rivers', () => {
    const map = new HexMap({ width: 2, height: 2 });
    map.setRiverOutgoing(0, 0, 0);
    map.setRoad(0, 0, 2, true);
    const { ctx, strokes } = recorder();

    drawMapImage(ctx, map, layout, defs, {
      scale:  2,
      rivers: { color: '#ff0000', width: 7 },
      roads:  { color: '#00ff00', width: 3 },
    });

    const first = strokes.findIndex(s => s.color === '#00ff00');
    const river = strokes.findIndex(s => s.color === '#ff0000');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(river).toBeGreaterThan(first);
    expect(strokes[first].width).toBe(3);
    expect(strokes[river].width).toBe(7);
  });

  it('draws no strokes when rivers and roads are off', () => {
    const map = new HexMap({ width: 2, height: 2 });
    map.setRiverOutgoing(0, 0, 0);
    map.setRoad(0, 0, 2, true);
    const { ctx, strokes } = recorder();
    drawMapImage(ctx, map, layout, defs);
    expect(strokes).toHaveLength(0);
  });

  it('dims unseen cells and skips unexplored ones entirely', () => {
    const map = new HexMap({ width: 2, height: 2 });
    const fog = new FogData(2, 2);
    fog.markExplored(0, 0);
    fog.markExplored(1, 0);

    const { ctx, fills } = recorder();
    drawMapImage(ctx, map, layout, defs, {
      background: '#000000',
      fog,
      fogDimOpacity:     0.4,
      fogHideUnexplored: true,
    });

    // Only the two explored cells draw at all.
    expect(fills.filter(f => f.startsWith('rgb('))).toHaveLength(2);
    // Explored but not currently visible → dimmed.
    expect(fills.filter(f => f === 'rgba(0,0,0,0.4)')).toHaveLength(2);
  });

  it('shades cells by elevation when asked', () => {
    const map = new HexMap({ width: 2, height: 1 });
    map.setElevation(1, 0, 4);
    const { ctx, fills } = recorder();
    drawMapImage(ctx, map, layout, defs, { elevationShading: 0.1 });

    const parse = (s: string) => s.match(/\d+/g)!.map(Number);
    const flat  = parse(fills[1]);
    const high  = parse(fills[2]);
    expect(high[0]).toBeGreaterThan(flat[0]);
  });
});

function rtsCamera(distance = 20, pitchDeg = 45): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 500);
  const p   = (pitchDeg * Math.PI) / 180;
  cam.position.set(0, Math.sin(p) * distance, Math.cos(p) * distance);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

describe('groundPointFromNdc', () => {
  it('hits the plane at the screen center under a tilted camera', () => {
    const cam = rtsCamera();
    const hit = groundPointFromNdc(cam, 0, 0)!;
    expect(hit).not.toBeNull();
    expect(hit.y).toBeCloseTo(0, 6);
    expect(hit.x).toBeCloseTo(0, 6);
    expect(hit.z).toBeCloseTo(0, 6);
  });

  it('honours a non-zero plane height', () => {
    const cam = rtsCamera();
    const hit = groundPointFromNdc(cam, 0, 0, 3)!;
    expect(hit.y).toBeCloseTo(3, 6);
  });

  it('returns null for rays that never reach the plane', () => {
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
    cam.position.set(0, 5, 0);
    cam.lookAt(0, 50, -10); // aimed at the sky
    cam.updateMatrixWorld(true);
    expect(groundPointFromNdc(cam, 0, 0)).toBeNull();
  });
});

describe('cameraGroundFootprint', () => {
  it('returns four ground points ordered TL, TR, BR, BL', () => {
    const cam  = rtsCamera();
    const quad = cameraGroundFootprint(cam)!;

    expect(quad).toHaveLength(4);
    for (const p of quad) expect(p.y).toBeCloseTo(0, 6);

    // Screen-top corners sit further from the camera (deeper into the scene, -Z here).
    expect(quad[0].z).toBeLessThan(quad[3].z);
    expect(quad[1].z).toBeLessThan(quad[2].z);
    // Screen-left corners sit at smaller X.
    expect(quad[0].x).toBeLessThan(quad[1].x);
    expect(quad[3].x).toBeLessThan(quad[2].x);
  });

  it('returns null when the camera is not above the plane', () => {
    const cam = rtsCamera();
    cam.position.y = -1;
    cam.updateMatrixWorld(true);
    expect(cameraGroundFootprint(cam)).toBeNull();
  });

  it('clamps corners that shoot past maxDistance instead of dropping them', () => {
    // A shallow pitch throws the top corners toward the horizon.
    const cam  = rtsCamera(20, 12);
    const near = cameraGroundFootprint(cam)!;
    const far  = cameraGroundFootprint(cam, { maxDistance: 40 })!;

    expect(far).toHaveLength(4);
    for (const p of far) {
      expect(p.y).toBeCloseTo(0, 6);
      expect(cam.position.distanceTo(p)).toBeLessThanOrEqual(40.001);
    }
    // The unclamped run reaches further out than the clamped one.
    expect(Math.abs(near[0].z)).toBeGreaterThan(Math.abs(far[0].z));
  });

  it('reuses a caller-supplied array', () => {
    const cam = rtsCamera();
    const out = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    expect(cameraGroundFootprint(cam, undefined, out)).toBe(out);
  });
});

describe('minimap overlay round trip', () => {
  it('places a world point at the pixel the transform reports', () => {
    const map = new HexMap({ width: 20, height: 20 });
    const t   = getMapImageTransform(map, layout, { scale: 2, padding: 2 });

    // Center of the map bounds lands at the center of the image.
    const midX = (t.bounds.minX + t.bounds.maxX) / 2;
    const midZ = (t.bounds.minZ + t.bounds.maxZ) / 2;
    const p    = t.worldToImage(midX, midZ);
    expect(p.x).toBeCloseTo(t.width  / 2, 0);
    expect(p.y).toBeCloseTo(t.height / 2, 0);
  });

  it('keeps a THREE.Vector3 footprint convertible without extra math', () => {
    const map = new HexMap({ width: 8, height: 8 });
    const t   = getMapImageTransform(map, layout, { scale: 2 });
    const v   = new THREE.Vector3(3, 7, -2);
    const p   = t.worldToImage(v.x, v.z);
    const w   = t.imageToWorld(p.x, p.y);
    expect(w.x).toBeCloseTo(3, 10);
    expect(w.z).toBeCloseTo(-2, 10);
  });
});
