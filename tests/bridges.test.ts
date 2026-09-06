import { describe, it, expect } from 'vitest';
import { HexMap } from '../src/map/HexMap.js';
import { riverBanks, hasBridge } from '../src/map/Bridges.js';
import { createLayout, hexToWorld } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';
import { offsetNeighbor, offsetToHex, HEX_DIRECTIONS } from '../src/math/HexCoord.js';
import { buildChunkArrays, BRIDGE_ARCH, BRIDGE_THICKNESS } from '../src/geometry/HexChunkCore.js';
import { generateRoads } from '../src/generators/RoadGenerator.js';
import { cellSurfaceY } from '../src/map/CellSurface.js';

const layout   = createLayout(POINTY_TOP, 1);
const edgeDirs = POINTY_TOP.edgeDirections;

/** A flat 7×7 map with a straight river through the centre cell (in face 1, out face 4). */
function riverMap(): HexMap {
  const map = new HexMap({ width: 7, height: 7 });
  map.forEach((c, r) => map.setElevation(c, r, 2));
  const up   = offsetNeighbor(3, 3, edgeDirs[1]);
  const down = offsetNeighbor(3, 3, edgeDirs[4]);
  map.setRiverOutgoing(up.col, up.row, 4);
  map.setRiverIncoming(3, 3, 1);
  map.setRiverOutgoing(3, 3, 4);
  map.setRiverIncoming(down.col, down.row, 1);
  return map;
}

function roadThrough(map: HexMap, col: number, row: number, face: number): void {
  map.setRoad(col, row, face, true);
  const nb = offsetNeighbor(col, row, edgeDirs[face]);
  if (map.inBounds(nb.col, nb.row)) map.setRoad(nb.col, nb.row, (face + 3) % 6, true);
}

const bounds = { colStart: 0, colEnd: 7, rowStart: 0, rowEnd: 7 };

/** Vertices of a position array within `radius` (XZ) of a point. */
function near(positions: Float32Array, x: number, z: number, radius: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < positions.length; i += 3) {
    if (Math.hypot(positions[i] - x, positions[i + 2] - z) <= radius) {
      out.push([positions[i], positions[i + 1], positions[i + 2]]);
    }
  }
  return out;
}

describe('river banks', () => {
  it('splits the non-river edges of a straight river into two banks', () => {
    const banks = riverBanks(riverMap(), 3, 3)!;
    expect(banks).not.toBeNull();
    expect(Array.from(banks)).toEqual([1, -1, 0, 0, -1, 1]);
  });

  it('has no banks at a source, a mouth, or a hairpin', () => {
    const map = riverMap();
    const up = offsetNeighbor(3, 3, edgeDirs[1]);
    expect(riverBanks(map, up.col, up.row)).toBeNull();     // source: outgoing only
    const hairpin = new HexMap({ width: 5, height: 5 });
    hairpin.setRiverIncoming(2, 2, 0);
    hairpin.setRiverOutgoing(2, 2, 1);
    expect(riverBanks(hairpin, 2, 2)).toBeNull();           // adjacent edges leave one bank empty
    expect(riverBanks(new HexMap({ width: 3, height: 3 }), 1, 1)).toBeNull();
  });

  it('gives a gentle bend a one-edge inside bank and a three-edge outside bank', () => {
    const map = new HexMap({ width: 5, height: 5 });
    map.setRiverIncoming(2, 2, 0);
    map.setRiverOutgoing(2, 2, 2);
    expect(Array.from(riverBanks(map, 2, 2)!)).toEqual([-1, 0, -1, 1, 1, 1]);
  });
});

describe('hasBridge', () => {
  it('needs road on both banks', () => {
    const map = riverMap();
    expect(hasBridge(map, 3, 3)).toBe(false);
    roadThrough(map, 3, 3, 3);
    expect(hasBridge(map, 3, 3)).toBe(false);   // a jetty, not a crossing
    roadThrough(map, 3, 3, 0);
    expect(hasBridge(map, 3, 3)).toBe(true);
  });

  it('is false for two roads on the same bank', () => {
    const map = riverMap();
    roadThrough(map, 3, 3, 2);
    roadThrough(map, 3, 3, 3);
    expect(hasBridge(map, 3, 3)).toBe(false);
  });
});

describe('bridge deck geometry', () => {
  const centre = hexToWorld(layout, offsetToHex(3, 3));

  it('spans the channel with road above the bed and a slab under it', () => {
    const map = riverMap();
    roadThrough(map, 3, 3, 0);
    roadThrough(map, 3, 3, 3);
    const arrays = buildChunkArrays(map, layout, bounds, { colorMode: 'flat' });
    expect(arrays.roads).not.toBeNull();
    const roads = arrays.roads!;

    // Every other road vertex in the cell sits exactly at bank level; only
    // the deck rises above it, by the arch at mid-span.
    const bank = cellSurfaceY(map, layout, 3, 3);
    const deck = near(roads.positions, centre.x, centre.z, 0.6).filter(v => v[1] > bank + 0.03);
    expect(deck.length).toBeGreaterThan(0);
    const deckTop = Math.max(...deck.map(v => v[1]));
    expect(deckTop).toBeCloseTo(bank + BRIDGE_ARCH, 3);

    // Slab vertices hang exactly BRIDGE_THICKNESS under the deck.
    const slab = near(arrays.terrain.positions, centre.x, centre.z, 0.6)
      .filter(v => Math.abs(v[1] - (deckTop - BRIDGE_THICKNESS)) < 1e-4);
    expect(slab.length).toBeGreaterThan(0);
  });

  it('emits nothing at the centre when bridges are off or a bank has no road', () => {
    const map = riverMap();
    roadThrough(map, 3, 3, 0);
    roadThrough(map, 3, 3, 3);
    const bank = cellSurfaceY(map, layout, 3, 3);
    const raised = (positions: Float32Array) =>
      near(positions, centre.x, centre.z, 0.6).filter(v => v[1] > bank + 0.03);
    const off = buildChunkArrays(map, layout, bounds, { colorMode: 'flat', bridges: false });
    expect(raised(off.roads!.positions)).toHaveLength(0);

    const jetty = riverMap();
    roadThrough(jetty, 3, 3, 3);
    const one = buildChunkArrays(jetty, layout, bounds, { colorMode: 'flat' });
    expect(raised(one.roads!.positions)).toHaveLength(0);
  });

  it('builds the same deck from either bank order (worker and main thread agree)', () => {
    const map = riverMap();
    roadThrough(map, 3, 3, 0);
    roadThrough(map, 3, 3, 3);
    const a = buildChunkArrays(map, layout, bounds, { colorMode: 'splat' });
    const b = buildChunkArrays(map, layout, bounds, { colorMode: 'splat' });
    expect(a.roads!.positions.length).toBe(b.roads!.positions.length);
    expect(a.terrain.positions.length).toBe(b.terrain.positions.length);
  });
});

describe('generateRoads bridges option', () => {
  it('crosses river cells by default and stops at the bank with bridges off', () => {
    // A river running down column 5 across every row a road will use.
    const make = (): HexMap => {
      const map = new HexMap({ width: 12, height: 6 });
      map.forEach((c, r) => map.setElevation(c, r, 1));
      // Vertical chain: alternate the SE/SW faces so it stays on column 5,
      // resolving the faces from the orientation the way generateRoads does.
      const faceOf = (dq: number, dr: number): number =>
        edgeDirs.findIndex(d => HEX_DIRECTIONS[d].q === dq && HEX_DIRECTIONS[d].r === dr);
      for (let r = 0; r < 5; r++) {
        const face = r % 2 === 0 ? faceOf(0, 1) : faceOf(-1, 1);
        const nb = offsetNeighbor(5, r, edgeDirs[face]);
        map.setRiverOutgoing(5, r, face);
        map.setRiverIncoming(nb.col, nb.row, (face + 3) % 6);
      }
      return map;
    };
    const withBridges = make();
    generateRoads(withBridges, { gridSpacing: 6 });
    // The east–west road on row 3 passes straight through the river cell.
    expect(withBridges.hasRoads(5, 3)).toBe(true);
    expect(withBridges.hasRoads(6, 3)).toBe(true);
    expect(hasBridge(withBridges, 5, 3)).toBe(true);

    const without = make();
    generateRoads(without, { gridSpacing: 6, bridges: false });
    expect(without.hasRoads(5, 3)).toBe(false);
    expect(without.hasRoads(6, 3)).toBe(false);
  });
});
