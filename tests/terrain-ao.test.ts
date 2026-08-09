import { describe, it, expect } from 'vitest';
import { HexMap } from '../src/map/HexMap.js';
import { buildChunkArrays } from '../src/geometry/HexChunkCore.js';
import { buildChunkGeometry } from '../src/geometry/HexChunk.js';
import { createLayout } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';

const layout = createLayout(POINTY_TOP, 1);
const bounds = { colStart: 0, colEnd: 16, rowStart: 0, rowEnd: 16 };

/** Uniform elevation everywhere — nothing occludes anything. */
function flatMap(elev = 2): HexMap {
  const m = new HexMap({ width: 16, height: 16 });
  for (let r = 0; r < 16; r++) for (let c = 0; c < 16; c++) m.setElevation(c, r, elev);
  return m;
}

/** A single north-south cliff: columns < 8 at the bottom, columns >= 8 on top. */
function cliffMap(low = 0, high = 4): HexMap {
  const m = new HexMap({ width: 16, height: 16 });
  for (let r = 0; r < 16; r++) for (let c = 0; c < 16; c++) m.setElevation(c, r, c < 8 ? low : high);
  return m;
}

const occlusionOf = (map: HexMap, opts = {}): Float32Array =>
  buildChunkArrays(map, layout, bounds, opts).terrain.occlusion;

describe('baked terrain ambient occlusion', () => {
  it('leaves level ground completely open', () => {
    // The elevation jitter perturbs every vertex a little; the bake subtracts
    // that amplitude precisely so flat terrain reads as a clean zero rather
    // than a faint per-vertex mottle.
    const ao = occlusionOf(flatMap());
    expect(ao.length).toBeGreaterThan(0);
    expect(Math.max(...ao)).toBe(0);
  });

  it('occludes the base of a cliff', () => {
    const ao = occlusionOf(cliffMap());
    expect(Math.max(...ao)).toBeGreaterThan(0.2);
  });

  it('darkens the foot of the cliff face and leaves its top open', () => {
    const arrays = buildChunkArrays(cliffMap(), layout, bounds, {});
    const pos = arrays.terrain.positions;
    const ao  = arrays.terrain.occlusion;

    // Vertices on the cliff face itself, sampled by height rather than by
    // which cell they belong to: the face spans the seam between the two
    // cells, so cell membership is exactly what should NOT matter here.
    let lowSum = 0, lowCount = 0, highSum = 0, highCount = 0;
    for (let i = 0; i < ao.length; i++) {
      const y = pos[i * 3 + 1];
      if (y < 0.3)      { lowSum  += ao[i]; lowCount++;  }
      else if (y > 1.7) { highSum += ao[i]; highCount++; }
    }
    expect(lowCount).toBeGreaterThan(0);
    expect(highCount).toBeGreaterThan(0);
    expect(lowSum / lowCount).toBeGreaterThan(highSum / highCount);
  });

  it('scales with the strength option and switches off entirely', () => {
    const base   = occlusionOf(cliffMap(), { ambientOcclusion: { strength: 0.4 } });
    const strong = occlusionOf(cliffMap(), { ambientOcclusion: { strength: 0.8 } });
    const off    = occlusionOf(cliffMap(), { ambientOcclusion: false });

    expect(Math.max(...strong)).toBeCloseTo(Math.max(...base) * 2, 5);
    expect(Math.max(...off)).toBe(0);
    // Disabled still emits the attribute, so the geometry layout never varies.
    expect(off.length).toBe(base.length);
  });

  it('spreads occlusion further up the face with a wider range', () => {
    const tight = occlusionOf(cliffMap(0, 8), { ambientOcclusion: { range: 2 } });
    const wide  = occlusionOf(cliffMap(0, 8), { ambientOcclusion: { range: 12 } });
    // A wider saturation distance means a given rise produces LESS occlusion,
    // trading peak darkness for a longer gradient.
    expect(Math.max(...wide)).toBeLessThan(Math.max(...tight));
  });

  it('is a defaults-on option', () => {
    expect(occlusionOf(cliffMap(), {})).toEqual(occlusionOf(cliffMap(), { ambientOcclusion: true }));
  });
});

describe('occlusion attribute plumbing', () => {
  it('rides its own attribute, not the vertex colors', () => {
    // Regression guard: folding occlusion into vertex color is a no-op in the
    // default splat mode, because those colors ARE the blend weights and the
    // fragment shader normalizes by their sum. Interior-fan vertices must
    // carry the untouched (1, 0, 0) weight.
    const arrays = buildChunkArrays(cliffMap(), layout, bounds, {});
    const colors = arrays.terrain.colors;
    const ao     = arrays.terrain.occlusion;

    let checked = 0;
    for (let i = 0; i < ao.length; i++) {
      if (ao[i] <= 0) continue;
      const r = colors[i * 3], g = colors[i * 3 + 1], b = colors[i * 3 + 2];
      // Bed/blend vertices legitimately carry other weights; the pure
      // single-terrain weight must never be scaled down by occlusion.
      if (g === 0 && b === 0 && r > 0) { expect(r).toBe(1); checked++; }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('sets a 1-float-per-vertex occlusion attribute on the terrain geometry', () => {
    const geo  = buildChunkGeometry(cliffMap(), layout, bounds, {}).terrain;
    const occ  = geo.getAttribute('occlusion');
    const posn = geo.getAttribute('position');
    expect(occ.itemSize).toBe(1);
    expect(occ.count).toBe(posn.count);
  });

  it('gives road geometry the matching attribute', () => {
    const map = cliffMap();
    for (let c = 1; c < 15; c++) map.setRoadEdge(c, 8, 0, true, POINTY_TOP);

    const geos = buildChunkGeometry(map, layout, bounds, {}).roads;
    expect(geos).not.toBeNull();
    const occ = geos!.getAttribute('occlusion');
    expect(occ.itemSize).toBe(1);
    expect(occ.count).toBe(geos!.getAttribute('position').count);
    // The road crosses the cliff, so some of it must sit in the shade.
    expect(Math.max(...(occ.array as Float32Array))).toBeGreaterThan(0);
  });
});
