import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { HexMap } from '../src/map/HexMap.js';
import { createLayout, hexToWorld } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';
import { HEX_DIRECTIONS } from '../src/math/HexCoord.js';
import { ELEVATION_SCALE, FLAG_WATER } from '../src/map/HexCell.js';
import { DEFAULT_WATER_TERRAIN_INDEX } from '../src/geometry/TerrainTypes.js';
import { buildMapSkirtArrays, skirtBaseY } from '../src/geometry/MapSkirtCore.js';
import { buildChunkArrays, CHUNK_GEOMETRY_DEFAULTS, terraceFactors } from '../src/geometry/HexChunkCore.js';
import { MapSkirt } from '../src/geometry/MapSkirt.js';
import { createSkirtMaterial, configureSkirt } from '../src/geometry/SkirtMaterial.js';
import { DayNightCycle } from '../src/lighting/DayNightCycle.js';
import { configureAtmosphere } from '../src/sky/Atmosphere.js';

const layout = createLayout(POINTY_TOP, 1);

function makeMap(width = 6, height = 6, elev: (c: number, r: number) => number = () => 1): HexMap {
  const map = new HexMap({ width, height });
  map.forEach((c, r) => map.setElevation(c, r, elev(c, r)));
  return map;
}

/** Triangles as [a, b, c] world-space points. */
function triangles(positions: Float32Array): Array<THREE.Vector3[]> {
  const out: Array<THREE.Vector3[]> = [];
  for (let i = 0; i < positions.length; i += 9) {
    out.push([
      new THREE.Vector3(positions[i],     positions[i + 1], positions[i + 2]),
      new THREE.Vector3(positions[i + 3], positions[i + 4], positions[i + 5]),
      new THREE.Vector3(positions[i + 6], positions[i + 7], positions[i + 8]),
    ]);
  }
  return out;
}

/** Offset-coordinate neighbour, matching the builder's own. */
function neighbour(col: number, row: number, d: number): { col: number; row: number } {
  const q = col - (row - (row & 1)) / 2;
  const nq = q + HEX_DIRECTIONS[d].q;
  const nr = row + HEX_DIRECTIONS[d].r;
  return { col: nq + (nr - (nr & 1)) / 2, row: nr };
}

const geometricNormal = (t: THREE.Vector3[]): THREE.Vector3 =>
  new THREE.Vector3().subVectors(t[1], t[0]).cross(new THREE.Vector3().subVectors(t[2], t[0]));

describe('map skirt geometry', () => {
  it('walls only the perimeter — the interior is never touched', () => {
    const small = buildMapSkirtArrays(makeMap(6, 6), layout);
    const large = buildMapSkirtArrays(makeMap(12, 12), layout);
    // Doubling each side roughly doubles the face count; an O(cells) build
    // would have quadrupled it.
    expect(large.faceCount / small.faceCount).toBeLessThan(2.6);
    expect(large.faceCount).toBeGreaterThan(small.faceCount);
  });

  it('every triangle winds to match the normal it carries', () => {
    // Front faces are chosen by winding, not by the normal attribute — if the
    // two disagree, the shader lights a face the renderer has culled.
    const s = buildMapSkirtArrays(makeMap(6, 6, (c, r) => (c + r) % 4), layout);
    for (const [i, t] of triangles(s.positions).entries()) {
      const stored = new THREE.Vector3(s.normals[i * 9], s.normals[i * 9 + 1], s.normals[i * 9 + 2]);
      expect(geometricNormal(t).dot(stored), `triangle ${i}`).toBeGreaterThan(0);
    }
  });

  it('walls face out of the map and the lip faces up', () => {
    const map = makeMap(6, 6, (c, r) => (c + r) % 4);
    const s = buildMapSkirtArrays(map, layout, { perturbStrength: 0 });

    const centres: THREE.Vector2[] = [];
    map.forEach((c, r) => {
      const w = hexToWorld(layout, { q: c - (r - (r & 1)) / 2, r });
      centres.push(new THREE.Vector2(w.x, w.z));
    });

    let walls = 0, lips = 0, strictlyOutward = 0;
    for (const [i, t] of triangles(s.positions).entries()) {
      const n = new THREE.Vector3(s.normals[i * 9], s.normals[i * 9 + 1], s.normals[i * 9 + 2]);
      if (n.y > 0.5) { lips++; expect(geometricNormal(t).y).toBeGreaterThan(0); continue; }

      walls++;
      const mid = new THREE.Vector2(
        (t[0].x + t[1].x + t[2].x) / 3,
        (t[0].z + t[1].z + t[2].z) / 3,
      );
      // Measured against the cell the wall belongs to, not a map-wide average,
      // which is wrong at the corners of a hex grid.
      let nearest = centres[0], best = Infinity;
      for (const c of centres) {
        const d = c.distanceToSquared(mid);
        if (d < best) { best = d; nearest = c; }
      }
      const outward = mid.clone().sub(nearest);
      const dot = outward.x * n.x + outward.y * n.z;
      // Never *inward* — an inverted wall is see-through from outside. The
      // corner seals sit where two cells meet, so "away from a cell centre" is
      // genuinely ambiguous there and lands on zero; only the face walls have
      // an outward direction worth asserting strictly.
      expect(dot, `wall ${i}`).toBeGreaterThan(-1e-6);
      if (dot > 1e-6) strictlyOutward++;
    }
    expect(walls).toBeGreaterThan(0);
    expect(lips).toBeGreaterThan(0);
    // A global inversion — the bug this guards — would take this to zero.
    expect(strictlyOutward / walls).toBeGreaterThan(0.9);
  });

  it('the base is one flat Y, clear of the lowest ground by the requested depth', () => {
    const map = makeMap(6, 6, (c, r) => (c === 3 && r === 3 ? -4 : 5));
    const s = buildMapSkirtArrays(map, layout, { depth: 2 });

    let lowest = Infinity, lowestCount = 0;
    for (let i = 1; i < s.positions.length; i += 3) {
      if (s.positions[i] < lowest - 1e-6) { lowest = s.positions[i]; lowestCount = 1; }
      else if (Math.abs(s.positions[i] - lowest) < 1e-6) lowestCount++;
    }
    expect(lowest).toBeCloseTo(s.baseY, 6);
    expect(lowestCount).toBeGreaterThan(10); // a floor, not a single stray vertex

    // Clear of the deepest cell — which is in the *middle* of the map, so the
    // floor has to be derived from the whole map and not just its rim.
    expect(s.baseY).toBeLessThan(-4 * ELEVATION_SCALE - 2);
  });

  it('no ground can poke through the floor, anywhere on the map', () => {
    const map = makeMap(8, 8, (c, r) => ((c * 7 + r * 13) % 11) - 5);
    const baseY = skirtBaseY(map, { depth: 1 });
    // The elevation noise can subtract up to elevPerturbStrength, and a carved
    // river bed reaches lower still; the floor has to clear the worst case,
    // not the cells that happened to be sampled.
    map.forEach((c, r) => {
      expect(map.getElevation(c, r) * ELEVATION_SCALE - 0.15 - 1.75 * ELEVATION_SCALE)
        .toBeGreaterThan(baseY);
    });
  });

  it('the top follows the ground contour rather than levelling off', () => {
    const map = makeMap(6, 6, (c) => c); // a ramp across the map
    const s = buildMapSkirtArrays(map, layout, { perturbStrength: 0, elevPerturbStrength: 0 });

    const tops = new Set<number>();
    for (let i = 1; i < s.positions.length; i += 3) {
      if (s.positions[i] > s.baseY + 1e-6) tops.add(Math.round(s.positions[i] * 1000));
    }
    // Every one of the ramp's six ground heights has to be represented — a top
    // that levelled off would collapse to one. There are more heights than
    // that, because the corner seals trace the terrain's terrace steps, and
    // those treads sit between the cell heights by design.
    for (let e = 0; e <= 5; e++) {
      expect(tops.has(Math.round(e * ELEVATION_SCALE * 1000)), `elevation ${e}`).toBe(true);
    }
    expect(tops.size).toBeGreaterThan(6);
  });

  it('never rises above the ground it is holding up, or sinks below its floor', () => {
    const map = makeMap(6, 6, (c, r) => (c + r) % 3);
    const s = buildMapSkirtArrays(map, layout, { perturbStrength: 0, elevPerturbStrength: 0 });
    let lowGround = Infinity, highGround = -Infinity;
    map.forEach((c, r) => {
      const y = map.getElevation(c, r) * ELEVATION_SCALE;
      lowGround = Math.min(lowGround, y);
      highGround = Math.max(highGround, y);
    });

    for (let i = 1; i < s.positions.length; i += 3) {
      // Poking above the highest ground would show a lip of soil standing
      // proud of the terrain; dropping below the floor would break the flat
      // base. Terrace treads land strictly between cell heights, which is why
      // this is a range rather than a set membership.
      expect(s.positions[i]).toBeLessThanOrEqual(highGround + 1e-6);
      expect(s.positions[i]).toBeGreaterThanOrEqual(s.baseY - 1e-6);
    }
    expect(s.baseY).toBeLessThan(lowGround);
  });

  it('its inner edge lands exactly on the terrain\'s own boundary vertices', () => {
    // The test that matters, and the one whose absence let a wrong `noiseScale`
    // default ship: build the real terrain and the skirt from the same map with
    // the same (default) options, and require the skirt's inner ring to be
    // *coincident* with terrain vertices — not close to them.
    const map = makeMap(8, 8, (c, r) => (c * 5 + r * 3) % 4);
    const terrain = buildChunkArrays(map, layout, { colStart: 0, colEnd: 8, rowStart: 0, rowEnd: 8 });
    const skirt   = buildMapSkirtArrays(map, layout);

    const key = (x: number, y: number, z: number) => `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    const terrainVerts = new Set<string>();
    const tp = terrain.terrain.positions;
    for (let i = 0; i < tp.length; i += 3) terrainVerts.add(key(tp[i], tp[i + 1], tp[i + 2]));

    let matched = 0;
    for (let v = 0; v < skirt.depths.length; v++) {
      if (Math.abs(skirt.depths[v]) > 1e-6) continue;
      if (terrainVerts.has(key(skirt.positions[v * 3], skirt.positions[v * 3 + 1], skirt.positions[v * 3 + 2]))) {
        matched++;
      }
    }
    // Each boundary face's lip contributes twelve vertices on the terrain's own
    // inset ring (four edge segments × three), and every one has to be
    // coincident. A torn seam still lands them *near* the terrain — it is only
    // the exact count that separates "meets it" from "nearly meets it".
    expect(matched).toBeGreaterThanOrEqual(skirt.faceCount * 12);
  });

  it('seals the wedge where two rim cells at different heights meet', () => {
    // Three cells meet at every hex corner. Where one is off the map the
    // terrain skips its corner fill, and a flat per-face lip leaves an open
    // wedge between two rim cells of different elevation — sky, seen from
    // outside. Each such wedge must be bridged exactly once: twice would
    // z-fight, never would leave the hole.
    const map = makeMap(7, 7, (c, r) => (c * 3 + r * 5) % 5);
    const s = buildMapSkirtArrays(map, layout);

    let wedges = 0;
    map.forEach((c, r) => {
      for (let i = 0; i < 6; i++) {
        const out = neighbour(c, r, layout.orientation.edgeDirections[i]);
        if (map.inBounds(out.col, out.row)) continue;
        const side = neighbour(c, r, layout.orientation.edgeDirections[(i + 5) % 6]);
        if (map.inBounds(side.col, side.row)) wedges++;
      }
    });
    expect(wedges).toBeGreaterThan(0);

    // The bridge is the only surface whose three vertices are not all at one
    // height — every lip is flat and every wall is a vertical quad.
    const seen = new Map<string, number>();
    for (let t = 0; t < s.positions.length; t += 9) {
      if (s.normals[t + 1] < 0.5) continue;
      const ys = [s.positions[t + 1], s.positions[t + 4], s.positions[t + 7]];
      if (Math.abs(ys[0] - ys[1]) < 1e-9 && Math.abs(ys[1] - ys[2]) < 1e-9) continue;
      const k = [0, 1, 2]
        .map(v => `${s.positions[t + v * 3].toFixed(4)},${ys[v].toFixed(4)},${s.positions[t + v * 3 + 2].toFixed(4)}`)
        .sort().join('|');
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    expect(seen.size).toBe(wedges);
    expect([...seen.values()].filter(v => v > 1)).toEqual([]);
  });

  it('traces the terrain\'s terrace treads instead of cutting a line across them', () => {
    // Every rim neighbour differs by exactly one step, so every boundary edge
    // is a terraced slope. A terrace is a staircase; a straight seal passes
    // under every tread, and the sky shows through the gaps.
    const map = makeMap(7, 7, (c, r) => (c + r) % 2);
    // Elevation jitter off on *both* builders, so the tread heights below are
    // exact fractions rather than each cell's noise plus a third of a step.
    const flat = { elevPerturbStrength: 0 };
    const terrain = buildChunkArrays(map, layout, { colStart: 0, colEnd: 7, rowStart: 0, rowEnd: 7 }, flat);
    const skirt   = buildMapSkirtArrays(map, layout, flat);

    const key = (x: number, y: number, z: number) => `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    const terrainVerts = new Set<string>();
    const tp = terrain.terrain.positions;
    for (let i = 0; i < tp.length; i += 3) terrainVerts.add(key(tp[i], tp[i + 1], tp[i + 2]));

    let matched = 0;
    for (let v = 0; v < skirt.depths.length; v++) {
      if (Math.abs(skirt.depths[v]) > 1e-6) continue;
      if (terrainVerts.has(key(skirt.positions[v * 3], skirt.positions[v * 3 + 1], skirt.positions[v * 3 + 2]))) {
        matched++;
      }
    }
    // The lips alone account for twelve per boundary face. Anything beyond
    // that is the corner seals landing on the terrain's own terrace points —
    // a straight ramp has no intermediate points to land anywhere.
    expect(matched).toBeGreaterThan(skirt.faceCount * 12);

    // ...and the treads are at the terrain's step heights, not interpolated
    // between them. v advances on every other step, which is what makes a
    // tread flat; a linear seal would have no vertices at these heights.
    const tread = terraceFactors(2).v; // first full tread
    expect(tread).toBeCloseTo(1 / 3, 6);
    const treadY = ELEVATION_SCALE * tread;
    let onTread = 0;
    for (let i = 1; i < skirt.positions.length; i += 3) {
      if (Math.abs(skirt.positions[i] - treadY) < 1e-5) onTread++;
    }
    expect(onTread).toBeGreaterThan(0);
  });

  it('takes its geometry defaults from the terrain builder rather than copying them', () => {
    // Hand-copied defaults are what tore the seam: noiseScale had drifted to
    // 0.06 against the terrain's 0.35, so the two perturbed into different
    // worlds. Importing them makes that impossible to repeat silently.
    expect(CHUNK_GEOMETRY_DEFAULTS.noiseScale).toBe(0.35);
    const map = makeMap(6, 6);
    const implicit = buildMapSkirtArrays(map, layout);
    const explicit = buildMapSkirtArrays(map, layout, { ...CHUNK_GEOMETRY_DEFAULTS });
    expect(Array.from(implicit.positions)).toEqual(Array.from(explicit.positions));
  });

  it('matching the terrain is what the perturbation options buy — a mismatch moves the seam', () => {
    const map = makeMap(6, 6);
    const matched  = buildMapSkirtArrays(map, layout, { perturbStrength: 0.8 });
    const mismatch = buildMapSkirtArrays(map, layout, { perturbStrength: 0.2 });
    let moved = 0;
    for (let i = 0; i < matched.positions.length; i += 3) {
      if (Math.abs(matched.positions[i] - mismatch.positions[i]) > 1e-4) moved++;
    }
    expect(moved).toBeGreaterThan(0);
  });
});

describe('map skirt water cut', () => {
  /** A map whose whole rim is submerged: bed at 0, surface two steps up. */
  function drownedRim(): HexMap {
    const map = makeMap(6, 6, () => 0);
    map.forEach((c, r) => {
      // Water is identified by *terrain*, the way the liquid builders do it —
      // keying off the cell's water flag instead is what left every coastline
      // open on a real map.
      map.setTerrain(c, r, DEFAULT_WATER_TERRAIN_INDEX);
      map.waterSurfaces[r * map.width + c] = 2;
    });
    return map;
  }

  it('is keyed to water terrain, not the cell flag', () => {
    const flagged = makeMap(6, 6, () => 0);
    flagged.forEach((c, r) => {
      flagged.setFlag(c, r, FLAG_WATER);
      flagged.waterSurfaces[r * flagged.width + c] = 2;
    });
    expect(buildMapSkirtArrays(flagged, layout).water.every(v => v === 0)).toBe(true);
    expect(buildMapSkirtArrays(drownedRim(), layout).water.some(v => v > 0)).toBe(true);
  });

  it('honours a custom liquid palette through waterTerrains', () => {
    const map = makeMap(6, 6, () => 0);
    const LAVA = 9;
    map.forEach((c, r) => {
      map.setTerrain(c, r, LAVA);
      map.waterSurfaces[r * map.width + c] = 2;
    });
    expect(buildMapSkirtArrays(map, layout).water.every(v => v === 0)).toBe(true);
    expect(buildMapSkirtArrays(map, layout, { waterTerrains: new Set([LAVA]) })
      .water.some(v => v > 0)).toBe(true);
  });

  it('fills from the bed up to the surface, above the ground line', () => {
    // Elevation jitter off: this is about where the band sits relative to the
    // ground, and the noise would put the exact heights out by up to 0.15.
    const s = buildMapSkirtArrays(drownedRim(), layout,
      { perturbStrength: 0, elevPerturbStrength: 0 });
    let waterVerts = 0, maxWaterY = -Infinity, maxEarthY = -Infinity;
    for (let v = 0; v < s.water.length; v++) {
      const y = s.positions[v * 3 + 1];
      if (s.water[v] > 0.5) { waterVerts++; maxWaterY = Math.max(maxWaterY, y); }
      else maxEarthY = Math.max(maxEarthY, y);
    }
    expect(waterVerts).toBeGreaterThan(0);
    // Earth stops at the sea bed (elevation 0); the water sits above it.
    expect(maxEarthY).toBeCloseTo(0, 6);
    expect(maxWaterY).toBeCloseTo(2 * ELEVATION_SCALE, 6);
  });

  it('waterCut: false leaves the slot open, and dry maps never fill', () => {
    expect(buildMapSkirtArrays(drownedRim(), layout, { waterCut: false }).water)
      .toSatisfy((w: Float32Array) => w.every(v => v === 0));
    expect(buildMapSkirtArrays(makeMap(6, 6), layout).water)
      .toSatisfy((w: Float32Array) => w.every(v => v === 0));
  });

  it('a water surface at or below the bed adds nothing — no zero-height band', () => {
    const map = makeMap(6, 6, () => 3);
    map.forEach((c, r) => {
      map.setFlag(c, r, FLAG_WATER);
      map.setTerrain(c, r, DEFAULT_WATER_TERRAIN_INDEX);
      map.waterSurfaces[r * map.width + c] = 3; // level with the ground
    });
    // With the jitter on, a cell the noise dips below its own surface really
    // does hold a hairline of water — correct, but not what this pins.
    const s = buildMapSkirtArrays(map, layout, { elevPerturbStrength: 0 });
    expect(s.water.every(v => v === 0)).toBe(true);
  });
});

describe('MapSkirt mesh', () => {
  it('carries the attributes the shader reads, one value per vertex', () => {
    const skirt = new MapSkirt(makeMap(), layout);
    const geo = skirt.mesh.geometry;
    const count = geo.getAttribute('position').count;
    expect(geo.getAttribute('normal').count).toBe(count);
    expect(geo.getAttribute('aDepth').count).toBe(count);
    expect(geo.getAttribute('aWater').count).toBe(count);
    expect(geo.boundingSphere).not.toBeNull();
  });

  it('depth is 0 along the cut and grows downward, for the topsoil line', () => {
    const skirt = new MapSkirt(makeMap(6, 6, () => 4), layout,
      { depth: 2, elevPerturbStrength: 0 });
    const pos = skirt.mesh.geometry.getAttribute('position');
    const dep = skirt.mesh.geometry.getAttribute('aDepth');
    let maxDepth = 0;
    for (let i = 0; i < pos.count; i++) {
      // The attribute must track the drop from the cut line, or the topsoil
      // band would float at a fixed Y instead of hugging the ground.
      expect(dep.getX(i)).toBeCloseTo(4 * ELEVATION_SCALE - pos.getY(i), 5);
      maxDepth = Math.max(maxDepth, dep.getX(i));
    }
    expect(maxDepth).toBeGreaterThan(2);
  });

  it('rebuilds when the map changes shape under it', () => {
    const map = makeMap(6, 6, () => 1);
    const skirt = new MapSkirt(map, layout);
    const before = skirt.baseY;
    map.setElevation(3, 3, -8);
    skirt.rebuild();
    expect(skirt.baseY).toBeLessThan(before);

    skirt.setMap(makeMap(10, 10, () => 1));
    expect(skirt.baseY).toBeCloseTo(before, 6);
  });

  it('restyling does not rebuild, but re-cutting does', () => {
    const skirt = new MapSkirt(makeMap(), layout);
    const geo = skirt.mesh.geometry.getAttribute('position');
    skirt.configure({ soilDeep: 0x112233 });
    expect(skirt.mesh.geometry.getAttribute('position')).toBe(geo); // untouched
    expect((skirt.material.uniforms.uSoilDeep.value as THREE.Color).getHex()).toBe(0x112233);

    skirt.configure({ depth: 9 });
    expect(skirt.mesh.geometry.getAttribute('position')).not.toBe(geo);
    expect(skirt.baseY).toBeLessThan(-9);
  });

  it('setEnabled hides it, and dispose detaches it', () => {
    const scene = new THREE.Scene();
    const skirt = new MapSkirt(makeMap(), layout).addTo(scene);
    expect(skirt.mesh.parent).toBe(scene);
    skirt.setEnabled(false);
    expect(skirt.mesh.visible).toBe(false);
    skirt.dispose();
    expect(skirt.mesh.parent).toBeNull();
  });
});

describe('skirt material', () => {
  it('takes the terrain\'s light uniforms, so a cycle drives it with the ground', () => {
    const mat = createSkirtMaterial();
    const s = new DayNightCycle({ time: 0 }).applyTo({ lightMaterials: [mat] });
    expect((mat.uniforms.uLightColor.value as THREE.Color).getHex())
      .toBe(s.terrainLightColor.getHex());
    expect((mat.uniforms.uLightDir.value as THREE.Vector3).y).toBeCloseTo(s.lightDir.y, 5);
  });

  it('carries the shared distance haze, so the map edge dissolves like the ground', () => {
    const mat = createSkirtMaterial();
    expect(mat.uniforms.uAtmoEnabled).toBeDefined();
    configureAtmosphere(mat, { color: 0x8fb2d9, near: 20 });
    expect(mat.uniforms.uAtmoEnabled.value).toBe(1);
    expect(mat.uniforms.uAtmoNear.value).toBe(20);
    expect(mat.fragmentShader).toContain('applyAtmosphere');
  });

  it('bands off world Y, so a layer holds its level around every corner', () => {
    // Keying off a per-face coordinate would restart the strata on each wall
    // and the block would read as four painted panels.
    const mat = createSkirtMaterial();
    expect(mat.vertexShader).toContain('vY       = worldPos.y;');
    expect(mat.fragmentShader).toContain('float b    = (vY + wobble) * uBandScale;');
  });

  it('is opaque and single-sided — a closed shell only ever seen from outside', () => {
    const mat = createSkirtMaterial();
    expect(mat.side).toBe(THREE.FrontSide);
    expect(mat.transparent).toBe(false);
  });

  it('configureSkirt restyles in place and clamps what would break the bands', () => {
    const mat = createSkirtMaterial();
    configureSkirt(mat, { soilTop: 0x445566, bandScale: 0, grain: 5, deepen: -1 });
    expect((mat.uniforms.uSoilTop.value as THREE.Color).getHex()).toBe(0x445566);
    expect(mat.uniforms.uBandScale.value as number).toBeGreaterThan(0); // floor(x*0) = one band
    expect(mat.uniforms.uGrain.value).toBe(1);
    expect(mat.uniforms.uDeepen.value).toBe(0);
  });

  it('ignores materials that are not skirts instead of throwing', () => {
    expect(() => configureSkirt(new THREE.ShaderMaterial(), { soilTop: 0xff0000 })).not.toThrow();
  });
});
