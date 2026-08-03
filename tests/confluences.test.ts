import { describe, it, expect } from 'vitest';
import { HexMap } from '../src/map/HexMap.js';
import { serializeMap, deserializeMap, serializeMapJSON, deserializeMapJSON } from '../src/map/MapSerializer.js';
import { generateRivers } from '../src/generators/RiverGenerator.js';
import { buildRiverGeometry, computeRiverFlow } from '../src/geometry/WaterChunk.js';
import { buildEstuaryGeometry } from '../src/geometry/EstuaryChunk.js';
import { createLayout } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';

const layout = createLayout(POINTY_TOP, 1);
const EDGE_DIRS = POINTY_TOP.edgeDirections;
const WATER = 5;
const eastEdge = EDGE_DIRS.findIndex(d => d === 0); // axial {q:1, r:0}
const westEdge = EDGE_DIRS.findIndex(d => d === 3); // axial {q:-1, r:0}

const popcount = (m: number) => {
  let n = 0;
  for (let e = 0; e < 6; e++) if (m & (1 << e)) n++;
  return n;
};

describe('multi-incoming river data model', () => {
  it('accumulates incoming edges without disturbing existing ones', () => {
    const m = new HexMap({ width: 8, height: 8 });
    m.setRiverIncoming(4, 4, 3);
    m.setRiverIncoming(4, 4, 1);
    expect(m.hasRiverIncomingThroughEdge(4, 4, 3)).toBe(true);
    expect(m.hasRiverIncomingThroughEdge(4, 4, 1)).toBe(true);
    expect(m.hasRiverThroughEdge(4, 4, 3)).toBe(true);
    expect(m.hasRiverThroughEdge(4, 4, 1)).toBe(true);
    expect(popcount(m.getIncomingRiverMask(4, 4))).toBe(2);
    expect(m.getIncomingRiverDir(4, 4)).toBe(1); // primary = lowest set edge
  });

  it('updates the primary when an incoming edge is removed', () => {
    const m = new HexMap({ width: 8, height: 8 });
    m.setRiverIncoming(4, 4, 1);
    m.setRiverIncoming(4, 4, 3);
    m.removeRiverIncoming(4, 4, 1);
    expect(m.getIncomingRiverDir(4, 4)).toBe(3);
    expect(m.hasRiverIncomingThroughEdge(4, 4, 1)).toBe(false);
    m.removeRiverIncoming(4, 4, 3);
    expect(m.hasRiver(4, 4)).toBe(false);
  });

  it('clearRiver clears the mask too, and begin/end reflects the mask', () => {
    const m = new HexMap({ width: 8, height: 8 });
    m.setRiverIncoming(4, 4, 2);
    m.setRiverIncoming(4, 4, 5);
    expect(m.hasRiverBeginOrEnd(4, 4)).toBe(true); // terminus: incoming only
    m.setRiverOutgoing(4, 4, 0);
    expect(m.hasRiverBeginOrEnd(4, 4)).toBe(false); // pass-through junction
    m.clearRiver(4, 4);
    expect(m.hasRiver(4, 4)).toBe(false);
    expect(m.getIncomingRiverMask(4, 4)).toBe(0);
  });
});

describe('serialization v2 + v1 migrations', () => {
  function confluenceMap(): HexMap {
    const m = new HexMap({ width: 10, height: 10, featureLayerCount: 1 });
    m.setRiverIncoming(5, 5, 1);
    m.setRiverIncoming(5, 5, 4);
    m.setRiverOutgoing(5, 5, 0);
    return m;
  }

  it('round-trips the incoming mask in binary and JSON', () => {
    const m = confluenceMap();
    const b = deserializeMap(serializeMap(m));
    expect(b.getIncomingRiverMask(5, 5)).toBe(m.getIncomingRiverMask(5, 5));
    const j = deserializeMapJSON(serializeMapJSON(m)).map;
    expect(j.getIncomingRiverMask(5, 5)).toBe(m.getIncomingRiverMask(5, 5));
  });

  it('migrates v1 binary files (mask derived from the packed byte)', () => {
    const m = new HexMap({ width: 10, height: 10, featureLayerCount: 1 });
    m.setRiverIncoming(5, 5, 4);
    m.setRiverOutgoing(5, 5, 0);
    const cur = serializeMap(m);
    // Reconstruct the v1 layout — header + cells + roads + features only —
    // by truncating everything later versions appended, then set version 1.
    const v1Length = 14 + m.uint8.byteLength + m.roadBits.byteLength
      + (m.featureData?.byteLength ?? 0);
    const v1 = cur.slice(0, v1Length);
    v1[4] = 1;

    const loaded = deserializeMap(v1);
    expect(loaded.getIncomingRiverDir(5, 5)).toBe(4);
    expect(loaded.getIncomingRiverMask(5, 5)).toBe(1 << 4);
    expect(loaded.getOutgoingRiverDir(5, 5)).toBe(0);
  });

  it('migrates v1 JSON files', () => {
    const m = new HexMap({ width: 10, height: 10, featureLayerCount: 1 });
    m.setRiverIncoming(5, 5, 2);
    const p = JSON.parse(serializeMapJSON(m));
    delete p.riverIn;
    p.version = 1;
    const loaded = deserializeMapJSON(JSON.stringify(p)).map;
    expect(loaded.getIncomingRiverMask(5, 5)).toBe(1 << 2);
  });
});

describe('generator confluences', () => {
  it('greedy tracing merges into existing channels, forming multi-incoming cells', () => {
    // V-shaped valley draining south: two seeds on opposite slopes converge.
    const m = new HexMap({ width: 32, height: 32 });
    for (let r = 0; r < 32; r++) {
      for (let c = 0; c < 32; c++) {
        m.setElevation(c, r, Math.abs(c - 8) + (31 - r));
      }
    }
    generateRivers(m, { gridSpacing: 8, minSeedElevation: 20, maxSteps: 100 });

    let confluences = 0;
    let mismatched = 0;
    m.forEach((c, r) => {
      if (popcount(m.getIncomingRiverMask(c, r)) >= 2) confluences++;
      const out = m.getOutgoingRiverDir(c, r);
      if (out !== -1) {
        // Chain consistency: downstream cell must record our edge in its mask.
        const d = EDGE_DIRS[out];
        // offset neighbor
        const q = c - (r - (r & 1)) / 2;
        const HEX = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }][d];
        const nr = r + HEX.r;
        const nc = (q + HEX.q) + (nr - (nr & 1)) / 2;
        if (nc >= 0 && nc < 32 && nr >= 0 && nr < 32) {
          if (!m.hasRiverIncomingThroughEdge(nc, nr, (out + 3) % 6)) mismatched++;
        }
      }
    });
    expect(confluences).toBeGreaterThan(0);
    expect(mismatched).toBe(0);
  });
});

describe('junction geometry and estuaries', () => {
  it('emits a center cap for 3-way junctions without crashing', () => {
    const twoWay = new HexMap({ width: 12, height: 12 });
    twoWay.setElevation(8, 6, 1);
    twoWay.setRiverIncoming(8, 6, westEdge); // in from the west...
    twoWay.setRiverOutgoing(8, 6, eastEdge); // ...out to the east

    const threeWay = new HexMap({ width: 12, height: 12 });
    threeWay.setElevation(8, 6, 1);
    threeWay.setRiverIncoming(8, 6, westEdge);
    threeWay.setRiverIncoming(8, 6, (eastEdge + 1) % 6); // second tributary
    threeWay.setRiverOutgoing(8, 6, eastEdge);

    const bounds = { colStart: 0, colEnd: 12, rowStart: 0, rowEnd: 12 };
    const g2 = buildRiverGeometry(twoWay, layout, bounds, {})!;
    const g3 = buildRiverGeometry(threeWay, layout, bounds, {})!;
    expect(g3.getAttribute('position').count).toBeGreaterThan(g2.getAttribute('position').count);
  });

  it('renders an estuary per incoming edge on multi-tributary water cells', () => {
    const one = new HexMap({ width: 12, height: 12 });
    one.setTerrain(6, 6, WATER); one.setElevation(6, 6, -1);
    one.setRiverIncoming(6, 6, westEdge);
    one.computeWaterSurfaces();

    const two = new HexMap({ width: 12, height: 12 });
    two.setTerrain(6, 6, WATER); two.setElevation(6, 6, -1);
    two.setRiverIncoming(6, 6, westEdge);
    two.setRiverIncoming(6, 6, eastEdge);
    two.computeWaterSurfaces();

    const bounds = { colStart: 0, colEnd: 12, rowStart: 0, rowEnd: 12 };
    const e1 = buildEstuaryGeometry(one, layout, bounds, {})!;
    const e2 = buildEstuaryGeometry(two, layout, bounds, {})!;
    expect(e2.getAttribute('position').count).toBe(e1.getAttribute('position').count * 2);
  });
});

describe('computeRiverFlow', () => {
  it('sums tributaries at confluences', () => {
    // Two sources merge at (8,6), then continue east to (9,6).
    const m = new HexMap({ width: 16, height: 16 });
    // Source A: (7,6) → east into (8,6)
    m.setRiverOutgoing(7, 6, eastEdge);
    m.setRiverIncoming(8, 6, (eastEdge + 3) % 6);
    // Source B: (9,7)-ish — use a neighbor with a known edge: (9,6)? No — B flows
    // west from (9,5) area. Simpler: B at (9,6) flows WEST into (8,6)? That would
    // collide with the outflow. Use the cell west-adjacent on another edge:
    // B: from the east-side neighbor across edge (eastEdge+1)%6.
    const inEdgeB = (eastEdge + 1) % 6;
    // Find B's coordinates: the neighbor of (8,6) across edge inEdgeB.
    const d = EDGE_DIRS[inEdgeB];
    const HEX = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }][d];
    const q = 8 - (6 - (6 & 1)) / 2;
    const br = 6 + HEX.r;
    const bc = (q + HEX.q) + (br - (br & 1)) / 2;
    m.setRiverOutgoing(bc, br, (inEdgeB + 3) % 6);
    m.setRiverIncoming(8, 6, inEdgeB);
    // Junction continues east.
    m.setRiverOutgoing(8, 6, eastEdge);
    m.setRiverIncoming(9, 6, (eastEdge + 3) % 6);

    const flow = computeRiverFlow(m, EDGE_DIRS);
    expect(flow.get(6 * 16 + 7)).toBe(1);        // source A
    expect(flow.get(br * 16 + bc)).toBe(1);      // source B
    expect(flow.get(6 * 16 + 8)).toBe(3);        // junction: 1 + 1 + 1
    expect(flow.get(6 * 16 + 9)).toBe(4);        // downstream of junction
  });
});
