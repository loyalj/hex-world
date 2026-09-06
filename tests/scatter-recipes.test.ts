import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  buildShapeGeometry, recipeFoliageColor,
  PINE_RECIPE, BROADLEAF_RECIPE, BUSH_RECIPE, ROCK_RECIPE, SMOKE_RECIPE, PALM_RECIPE,
  type ScatterRecipe,
} from '../src/geometry/ScatterRecipes.js';
import { resolveScatterAssets, resolveScatterMaterial, NO_SNOW_KEY, type ScatterAssetDescriptor } from '../src/geometry/ScatterAssets.js';
import { resolveScatterDefinition, placementFilter, type ScatterDescriptor } from '../src/geometry/ScatterTypes.js';
import { buildScatterMeshes, FEATURE_THRESHOLDS } from '../src/geometry/ScatterBuilder.js';
import { HexHashGrid } from '../src/geometry/HexHashGrid.js';
import { HexMap } from '../src/map/HexMap.js';
import { TerrainType } from '../src/map/HexCell.js';
import { createLayout } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';
import { serializeMapJSON, deserializeMapJSON } from '../src/map/MapSerializer.js';
import { exportHexPack } from '../src/pack/HexPack.js';
import { DEFAULT_TERRAIN_DESCRIPTORS } from '../src/geometry/TerrainTypes.js';
import { unzipSync } from 'fflate';

const layout = createLayout(POINTY_TOP, 1);

function bounds(g: THREE.BufferGeometry): THREE.Box3 {
  g.computeBoundingBox();
  return g.boundingBox!;
}

describe('buildShapeGeometry', () => {
  it('fits every built-in recipe to its height and seats it on the ground', () => {
    for (const recipe of [PINE_RECIPE, BROADLEAF_RECIPE, BUSH_RECIPE, ROCK_RECIPE, SMOKE_RECIPE, PALM_RECIPE]) {
      const g  = buildShapeGeometry(recipe);
      const bb = bounds(g);
      expect(bb.min.y).toBeCloseTo(0, 5);
      expect(bb.max.y).toBeCloseTo(recipe.height, 4);
      expect(g.getAttribute('color')).toBeDefined();
      expect(g.getAttribute('normal')).toBeDefined();
      expect(g.index).toBeNull();
    }
  });

  it('scales with the scale argument', () => {
    const g = buildShapeGeometry(PINE_RECIPE, 0.5);
    expect(bounds(g).max.y).toBeCloseTo(PINE_RECIPE.height * 0.5, 4);
  });

  it('is deterministic, jitter included', () => {
    const a = buildShapeGeometry(PALM_RECIPE).getAttribute('position').array;
    const b = buildShapeGeometry(PALM_RECIPE).getAttribute('position').array;
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('stamps a repeated part count times around the axis', () => {
    const one: ScatterRecipe = { height: 1, parts: [{ primitive: 'box', size: [0.1, 0.5, 0.1], color: 0xffffff }] };
    const ring: ScatterRecipe = { height: 1, parts: [{ primitive: 'box', size: [0.1, 0.5, 0.1], color: 0xffffff, repeat: { count: 6, radius: 0.3 } }] };
    const single = buildShapeGeometry(one).getAttribute('position').count;
    const six    = buildShapeGeometry(ring).getAttribute('position').count;
    expect(six).toBe(single * 6);
    // The copies sit out at the radius, not stacked on the axis.
    const bb = bounds(buildShapeGeometry(ring));
    expect(bb.max.x - bb.min.x).toBeGreaterThan(0.5);
  });

  it('bends a segment toward +X and droops a frond toward +Z', () => {
    const straight = bounds(buildShapeGeometry({ height: 1, parts: [{ primitive: 'segment', size: [0.1, 1, 0.1], color: 0 }] }));
    const bent     = bounds(buildShapeGeometry({ height: 1, parts: [{ primitive: 'segment', size: [0.1, 1, 0.1], bend: 45, color: 0 }] }));
    expect(bent.max.x).toBeGreaterThan(straight.max.x + 0.2);
    const flat    = bounds(buildShapeGeometry({ height: 1, parts: [{ primitive: 'frond', size: [0.2, 1, 1], color: 0 }] }));
    const drooped = bounds(buildShapeGeometry({ height: 1, parts: [{ primitive: 'frond', size: [0.2, 1, 1], bend: 60, color: 0 }] }));
    expect(drooped.max.z).toBeGreaterThan(flat.max.z + 0.2);
  });

  it('paints parts with their own colours and names the canopy colour as summer', () => {
    const g = buildShapeGeometry(BROADLEAF_RECIPE);
    const colors = g.getAttribute('color');
    const seen = new Set<string>();
    for (let i = 0; i < colors.count; i++) seen.add(`${colors.getX(i).toFixed(3)},${colors.getY(i).toFixed(3)}`);
    expect(seen.size).toBeGreaterThanOrEqual(2);
    expect(recipeFoliageColor(BROADLEAF_RECIPE)).toBe(BROADLEAF_RECIPE.parts[1].color);
    expect(recipeFoliageColor(ROCK_RECIPE)).toBeUndefined();
  });
});

describe('resolveScatterMaterial', () => {
  it('reads vertex colours for shapes and flat colour for models', () => {
    const shape = resolveScatterMaterial({}, PINE_RECIPE) as THREE.MeshLambertMaterial;
    expect(shape.vertexColors).toBe(true);
    const model = resolveScatterMaterial({ color: 0x112233 }) as THREE.MeshLambertMaterial;
    expect(model.vertexColors).toBe(false);
    expect(model.color.getHex()).toBe(0x112233);
  });

  it('turns opacity, sidedness, and the snow opt-out into material state', () => {
    const smoke = resolveScatterMaterial({ opacity: 0.6, doubleSide: true, snow: false }) as THREE.MeshLambertMaterial;
    expect(smoke.transparent).toBe(true);
    expect(smoke.depthWrite).toBe(false);
    expect(smoke.side).toBe(THREE.DoubleSide);
    expect(smoke.userData[NO_SNOW_KEY]).toBe(true);
    expect(resolveScatterMaterial({}).userData[NO_SNOW_KEY]).toBeUndefined();
  });

  it('attaches wind, seasons, and texture only when asked', () => {
    const plain = resolveScatterMaterial({}, PINE_RECIPE);
    const full  = resolveScatterMaterial({ windSway: true, seasonalTint: true, scatterTexture: 0.5 }, BROADLEAF_RECIPE);
    const attachedKeys = (m: THREE.Material) => Object.keys(m.userData).filter(k => k.startsWith('hexWorld'));
    expect(attachedKeys(plain)).toEqual([]);
    expect(attachedKeys(full).length).toBeGreaterThanOrEqual(2);
  });
});

describe('resolveScatterAssets + resolveScatterDefinition', () => {
  const assets: ScatterAssetDescriptor[] = [
    { id: 'palm', type: 'shape', recipe: PALM_RECIPE, material: { doubleSide: true, windSway: true } },
    { id: 'rock', type: 'shape', recipe: ROCK_RECIPE, material: { rock: true } },
  ];

  it('builds a registry from shape descriptors with no model loader', () => {
    const registry = resolveScatterAssets(assets);
    expect(registry.size).toBe(2);
    expect(bounds(registry.get('palm')!.geometry).max.y).toBeCloseTo(PALM_RECIPE.height, 4);
  });

  it('refuses a model asset without its geometry, and fits one to its height when given', () => {
    expect(() => resolveScatterAssets([{ id: 'm', type: 'model', height: 2 }])).toThrow(/no model geometry/);
    const models = new Map([['m', new THREE.BoxGeometry(1, 4, 1)]]);
    const reg = resolveScatterAssets([{ id: 'm', type: 'model', height: 2 }], models);
    expect(bounds(reg.get('m')!.geometry).max.y).toBeCloseTo(2, 4);
  });

  it('scales tiers from one asset and keeps the registry geometry untouched', () => {
    const registry = resolveScatterAssets(assets);
    const desc: ScatterDescriptor = {
      id: 'palms', name: 'Palms', layerIndex: 0,
      tiers: [[{ assetId: 'palm', yOffset: 0 }], [{ assetId: 'palm', yOffset: 0, scale: 0.75 }], [{ assetId: 'palm', yOffset: 0, scale: 0.5 }]],
    };
    const def = resolveScatterDefinition(desc, registry);
    expect(bounds(def.tiers[0][0].geometry).max.y).toBeCloseTo(PALM_RECIPE.height, 4);
    expect(bounds(def.tiers[1][0].geometry).max.y).toBeCloseTo(PALM_RECIPE.height * 0.75, 4);
    expect(bounds(def.tiers[2][0].geometry).max.y).toBeCloseTo(PALM_RECIPE.height * 0.5, 4);
    expect(bounds(registry.get('palm')!.geometry).max.y).toBeCloseTo(PALM_RECIPE.height, 4);
    expect(def.tiers[0][0].material).toBe(def.tiers[2][0].material);
  });

  it('turns placement rules into a spawn filter', () => {
    const map = new HexMap({ width: 6, height: 6, featureLayerCount: 1 });
    map.forEach((c, r) => { map.setTerrain(c, r, c >= 4 ? TerrainType.Water : TerrainType.Grassland); map.setElevation(c, r, r); });
    map.setRiverOutgoing(1, 1, 0);
    const shore = placementFilter({ shore: true })!;
    expect(shore(map, 3, 2)).toBe(true);
    expect(shore(map, 0, 2)).toBe(false);
    const band = placementFilter({ minElevation: 2, maxElevation: 3, avoidRivers: true })!;
    expect(band(map, 0, 1)).toBe(false);
    expect(band(map, 0, 2)).toBe(true);
    expect(band(map, 0, 4)).toBe(false);
    expect(band(map, 1, 1)).toBe(false);
    expect(placementFilter(undefined)).toBeUndefined();
    expect(placementFilter({})).toBeUndefined();
    const isLava = (t: number) => t === 7;
    map.setTerrain(5, 0, 7);
    expect(placementFilter({ shore: true }, isLava)!(map, 4, 0)).toBe(true);
  });

  it('honours a definition\'s own threshold table', () => {
    const map = new HexMap({ width: 8, height: 8, featureLayerCount: 1 });
    map.forEach((c, r) => map.setFeatureLevel(c, r, 0, 1));
    const registry = resolveScatterAssets(assets);
    const base: ScatterDescriptor = { id: 'r', name: 'r', layerIndex: 0, tiers: [[{ assetId: 'rock', yOffset: 0 }], [{ assetId: 'rock', yOffset: 0 }], [{ assetId: 'rock', yOffset: 0 }]] };
    const count = (desc: ScatterDescriptor): number => {
      const meshes = buildScatterMeshes(map, layout, { colStart: 0, colEnd: 8, rowStart: 0, rowEnd: 8 }, new HexHashGrid(5), [resolveScatterDefinition(desc, registry)]);
      return meshes.reduce((n, m) => n + m.count, 0);
    };
    const normal = count(base);
    const dense  = count({ ...base, thresholds: [[0.9, 0.95, 1.0], [0.9, 0.95, 1.0], [0.9, 0.95, 1.0]] });
    const none   = count({ ...base, thresholds: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] });
    expect(normal).toBeGreaterThan(0);
    expect(dense).toBeGreaterThan(normal);
    expect(none).toBe(0);
    expect(FEATURE_THRESHOLDS[0][2]).toBe(0.4);
  });
});

describe('scatter assets in saves and packs', () => {
  const assets: ScatterAssetDescriptor[] = [
    { id: 'palm', name: 'Palm', type: 'shape', recipe: PALM_RECIPE, material: { doubleSide: true, windSway: true } },
  ];
  const descriptors: ScatterDescriptor[] = [{
    id: 'palms', name: 'Palms', layerIndex: 0, placement: { shore: true },
    tiers: [[{ assetId: 'palm', yOffset: 0 }], [{ assetId: 'palm', yOffset: 0, scale: 0.75 }], [{ assetId: 'palm', yOffset: 0, scale: 0.5 }]],
  }];

  it('round-trips through the map JSON', () => {
    const map = new HexMap({ width: 4, height: 4, featureLayerCount: 1 });
    const json = serializeMapJSON(map, {}, { scatterDescriptors: descriptors, scatterAssets: assets });
    const back = deserializeMapJSON(json);
    expect(back.scatterAssets).toEqual(assets);
    expect(back.scatterDescriptors).toEqual(descriptors);
    // A save without assets reads back as an empty list, not undefined.
    expect(deserializeMapJSON(serializeMapJSON(map)).scatterAssets).toEqual([]);
  });

  it('travels in a .hexpack manifest beside the descriptors', async () => {
    // loadHexPack builds the terrain atlas, which needs a DOM, so the pack is
    // read back at the zip level here; the resolve path it then takes is the
    // one the registry tests above cover.
    const map = new HexMap({ width: 4, height: 4, featureLayerCount: 1 });
    const blob = await exportHexPack({
      terrainDescriptors: DEFAULT_TERRAIN_DESCRIPTORS,
      scatterDescriptors: descriptors,
      scatterAssets: assets,
      maps: [{ id: 'm', map, format: 'json' }],
    });
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    expect(manifest.scatterAssets).toEqual(assets);
    expect(manifest.scatterDescriptors).toEqual(descriptors);
    const mapJson = JSON.parse(new TextDecoder().decode(files['maps/m.json']));
    expect(mapJson.scatterAssets).toEqual(assets);
  });
});
