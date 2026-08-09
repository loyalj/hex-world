import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ClimateData } from '../src/season/ClimateData.js';
import { SeasonCycle, seasonWarming } from '../src/season/SeasonCycle.js';
import {
  configureSeason, styleFoliage, setSeasonPhase, resolveFoliageColor, setSeasonEnabled,
  DEFAULT_BLOSSOM_STRENGTH,
} from '../src/season/SeasonGLSL.js';
import { attachSeasonalTint, hasSeasonalTint } from '../src/season/TintAttach.js';
import { attachSnow } from '../src/season/SnowAttach.js';
import { attachAtmosphere } from '../src/sky/Atmosphere.js';
import { createTerrainMaterial } from '../src/geometry/TerrainMaterial.js';
import { DEFAULT_TERRAIN_DEFINITIONS } from '../src/geometry/TerrainTypes.js';
import {
  createBroadleafGeometry, createBushGeometry, createPineGeometry,
  BROADLEAF_CANOPY_COLOR,
} from '../src/geometry/ScatterShapes.js';
import { HexHashGrid } from '../src/geometry/HexHashGrid.js';
import { HexMap } from '../src/map/HexMap.js';
import { generateFbmTerrain } from '../src/generators/FbmTerrainGenerator.js';
import { assignBiomes } from '../src/generators/BiomeAssigner.js';

function makeTerrainMaterial(): THREE.ShaderMaterial {
  const tex = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
  return createTerrainMaterial(tex);
}

/** Run a patched material's hook over three's real chunk sources. */
function compile(mat: THREE.Material, lib = THREE.ShaderLib.lambert) {
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
  };
  mat.onBeforeCompile(shader as never, null as never);
  return shader;
}

describe('seasonWarming', () => {
  it('separates spring from autumn, which share every temperature', () => {
    expect(seasonWarming(0.25)).toBeCloseTo(1, 5); // mid-spring: warming
    expect(seasonWarming(0.75)).toBeCloseTo(0, 5); // mid-autumn: cooling
    // Solstices are the crossover, where the mid-season color has least say.
    expect(seasonWarming(0)).toBeCloseTo(0.5, 5);
    expect(seasonWarming(0.5)).toBeCloseTo(0.5, 5);
  });

  it('is reported alongside the phase, so a HUD and the shader agree', () => {
    const cycle = new SeasonCycle({ phase: 0.25, paused: true });
    expect(cycle.evaluate().warming).toBeCloseTo(seasonWarming(0.25), 6);
    cycle.setPhase(0.75);
    expect(cycle.evaluate().warming).toBeCloseTo(seasonWarming(0.75), 6);
  });
});

describe('terrain foliage tint', () => {
  it('declares the foliage uniforms and reads the temperature channel', () => {
    const mat = makeTerrainMaterial();
    for (const name of ['uFoliageSummer', 'uFoliageAutumn', 'uFoliageBareTemp', 'uFoliageWarming']) {
      expect(mat.uniforms[name]).toBeDefined();
    }
    expect(mat.vertexShader).toContain('vTemp = (c0.a + c1.a + c2.a) / 3.0;');
    expect(mat.fragmentShader).toContain('seasonalFoliage(c.rgb, vTemp');
  });

  it('turns the grass before it snows on it, and lights both', () => {
    const mat = makeTerrainMaterial();
    const tintAt = mat.fragmentShader.indexOf('seasonalFoliage(c.rgb');
    const snowAt = mat.fragmentShader.indexOf('snowCoverage(vSnow');
    const litAt  = mat.fragmentShader.indexOf('vec3 lit = c.rgb * light;');
    expect(tintAt).toBeGreaterThan(-1);
    expect(snowAt).toBeGreaterThan(tintAt); // snow lies on autumn leaves
    expect(litAt).toBeGreaterThan(snowAt);
  });

  it('reads warm while seasons are off, so grass does not turn by default', () => {
    const mat = makeTerrainMaterial();
    expect(mat.uniforms.uSeasonEnabled.value).toBe(0);
    expect(mat.vertexShader).toContain('vTemp = 1.0;');
  });

  it('styleFoliage restyles the palette in place', () => {
    const mat = makeTerrainMaterial();
    styleFoliage(mat, { autumn: 0xff0000, bareTemp: 0.4, strength: 0.5, select: 0, variance: 0 });
    expect((mat.uniforms.uFoliageAutumn.value as THREE.Color).getHex()).toBe(0xff0000);
    expect(mat.uniforms.uFoliageBareTemp.value).toBe(0.4);
    expect(mat.uniforms.uFoliageStrength.value).toBe(0.5);
    expect(mat.uniforms.uFoliageSelect.value).toBe(0);
    expect(mat.uniforms.uFoliageVariance.value).toBe(0);
  });

  it('turns straw rather than rust — ground cover is not a canopy', () => {
    const ground = makeTerrainMaterial().uniforms.uFoliageAutumn.value as THREE.Color;
    const canopy = new THREE.Color();
    const tree = new THREE.MeshLambertMaterial({ color: 0x6f9c3a });
    attachSeasonalTint(tree);
    canopy.copy((tree.userData.hexWorldFoliage as Record<string, THREE.IUniform>).uFoliageAutumn.value as THREE.Color);

    expect(ground.getHex()).not.toBe(canopy.getHex());
    // Straw is the paler, less saturated of the two — a hillside going as
    // orange as a wood reads as the map being recolored, not as a season.
    const saturation = (c: THREE.Color): number => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
    expect(saturation(ground)).toBeLessThan(saturation(canopy));
  });

  it('takes a ground-only override that leaves the trees alone', () => {
    const terrain = makeTerrainMaterial();
    const tree    = new THREE.MeshLambertMaterial({ color: 0x6f9c3a });
    attachSeasonalTint(tree);

    // What HexWorld.applySeasonMaterials composes: foliage for everything that
    // turns, terrainFoliage layered over it for the ground alone.
    const foliage = { autumn: 0xd2601a };
    styleFoliage(tree,    foliage);
    styleFoliage(terrain, { ...foliage, ...{ autumn: 0xc9b070 } });

    const hexOf = (m: THREE.Material, u = (m as THREE.ShaderMaterial).uniforms
      ?? m.userData.hexWorldFoliage as Record<string, THREE.IUniform>): number =>
      (u.uFoliageAutumn.value as THREE.Color).getHex();
    expect(hexOf(terrain)).toBe(0xc9b070);
    expect(hexOf(tree)).toBe(0xd2601a);
  });

  it('takes its summer reference through configureSeason', () => {
    const mat = makeTerrainMaterial();
    configureSeason(mat, new ClimateData(4, 4), { foliage: { summer: 0x123456 } });
    expect((mat.uniforms.uFoliageSummer.value as THREE.Color).getHex()).toBe(0x123456);
    expect(mat.uniforms.uSeasonEnabled.value).toBe(1);
  });
});

describe('resolveFoliageColor', () => {
  it('finds the pack grassland', () => {
    expect(resolveFoliageColor(DEFAULT_TERRAIN_DEFINITIONS).getHex())
      .toBe(new THREE.Color(0x86b888).getHex());
  });

  it('falls back to the greenest terrain when a pack renames its grass', () => {
    const defs = [
      { id: 'sand',   color: new THREE.Color(0xc8bea0) },
      { id: 'steppe', color: new THREE.Color(0x7fae55) },
      { id: 'stone',  color: new THREE.Color(0xa3adb5) },
    ];
    expect(resolveFoliageColor(defs).getHex()).toBe(new THREE.Color(0x7fae55).getHex());
  });

  it('falls back to a mid green when nothing is green at all', () => {
    const defs = [{ id: 'ash', color: new THREE.Color(0x555555) }];
    expect(resolveFoliageColor(defs).getHex()).toBe(new THREE.Color(0x86b888).getHex());
  });
});

describe('attachSeasonalTint (stock three materials)', () => {
  it('tints diffuseColor, so autumn is lit rather than painted on', () => {
    const mat = new THREE.MeshLambertMaterial({ color: 0x6f9c3a });
    attachSeasonalTint(mat);
    expect(hasSeasonalTint(mat)).toBe(true);

    const shader = compile(mat);
    expect(shader.fragmentShader).toContain('diffuseColor.rgb = seasonalFoliage(diffuseColor.rgb, vSeasonTemp, vSeasonSeed)');
    expect(shader.fragmentShader.indexOf('seasonalFoliage'))
      .toBeLessThan(shader.fragmentShader.indexOf('#include <dithering_fragment>'));
    expect(shader.uniforms.uFoliageSummer).toBeDefined();
  });

  it('defaults its summer reference to the material own color, so summer is a no-op', () => {
    const mat = new THREE.MeshLambertMaterial({ color: 0x6f9c3a });
    attachSeasonalTint(mat);
    const u = mat.userData.hexWorldFoliage as Record<string, THREE.IUniform>;
    expect((u.uFoliageSummer.value as THREE.Color).getHex()).toBe(0x6f9c3a);
  });

  it('takes an explicit summer for a vertexColors material, whose own color is useless', () => {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    attachSeasonalTint(mat, { summer: BROADLEAF_CANOPY_COLOR });
    const u = mat.userData.hexWorldFoliage as Record<string, THREE.IUniform>;
    expect((u.uFoliageSummer.value as THREE.Color).getHex()).toBe(BROADLEAF_CANOPY_COLOR);
  });

  it('is idempotent — a second call restyles instead of unbinding', () => {
    const mat = new THREE.MeshLambertMaterial({ color: 0x6f9c3a });
    const climate = new ClimateData(4, 4);
    configureSeason(mat, climate);
    attachSeasonalTint(mat);
    configureSeason(mat, climate);
    attachSeasonalTint(mat, { variance: 0.1 });

    const u = mat.userData.hexWorldFoliage as Record<string, THREE.IUniform>;
    expect(u.uFoliageVariance.value).toBeCloseTo(0.1);
    expect(u.uClimateData.value).toBe(climate.texture);
    expect(u.uSeasonEnabled.value).toBe(1);
  });

  it('keeps an existing onBeforeCompile working and does not share its program', () => {
    let priorRan = false;
    const mat = new THREE.MeshLambertMaterial();
    mat.onBeforeCompile = () => { priorRan = true; };
    attachSeasonalTint(mat);
    compile(mat);
    expect(priorRan).toBe(true);
    expect(mat.customProgramCacheKey()).toContain('hex-world-foliage');
  });

  it('composes with attachAtmosphere in either order', () => {
    for (const order of [0, 1]) {
      const mat = new THREE.MeshLambertMaterial();
      if (order === 0) { attachSeasonalTint(mat); attachAtmosphere(mat); }
      else             { attachAtmosphere(mat); attachSeasonalTint(mat); }
      const shader = compile(mat);
      // The tint is part of the surface; haze sits between the eye and it.
      expect(shader.fragmentShader.indexOf('seasonalFoliage'))
        .toBeLessThan(shader.fragmentShader.indexOf('gl_FragColor.rgb = applyAtmosphere('));
    }
  });
});

describe('spring blossom', () => {
  it('switches on for a plant and stays off for the terrain', () => {
    const tree = new THREE.MeshLambertMaterial({ color: 0x6f9c3a });
    attachSeasonalTint(tree);
    const u = tree.userData.hexWorldFoliage as Record<string, THREE.IUniform>;
    expect(u.uBlossomStrength.value).toBeCloseTo(DEFAULT_BLOSSOM_STRENGTH);
    // Short of full coverage, so some canopy shows through the petals.
    expect(DEFAULT_BLOSSOM_STRENGTH).toBeGreaterThan(0);
    expect(DEFAULT_BLOSSOM_STRENGTH).toBeLessThan(1);

    // Same uniform set shape, but a hillside must not flower.
    expect(makeTerrainMaterial().uniforms.uBlossomStrength.value).toBe(0);
  });

  it('lets an explicit setting win, so an evergreen shrub can opt out', () => {
    const shrub = new THREE.MeshLambertMaterial({ color: 0x4a7a30 });
    attachSeasonalTint(shrub, { blossomStrength: 0 });
    const u = shrub.userData.hexWorldFoliage as Record<string, THREE.IUniform>;
    expect(u.uBlossomStrength.value).toBe(0);
  });

  it('styles the petal range and how many plants carry it', () => {
    const mat = new THREE.MeshLambertMaterial({ color: 0x6f9c3a });
    attachSeasonalTint(mat);
    styleFoliage(mat, { blossom: 0xff00ff, blossomAlt: 0x0000ff, blossomShare: 0.25 });
    const u = mat.userData.hexWorldFoliage as Record<string, THREE.IUniform>;
    expect((u.uBlossomColor.value as THREE.Color).getHex()).toBe(0xff00ff);
    expect((u.uBlossomAlt.value   as THREE.Color).getHex()).toBe(0x0000ff);
    expect(u.uBlossomShare.value).toBe(0.25);
  });

  it('mixes petals over the turned canopy rather than into the palette ratio', () => {
    const mat = new THREE.MeshLambertMaterial({ color: 0x6f9c3a });
    attachSeasonalTint(mat);
    const shader = compile(mat);
    // Green cannot reach pink through a ratio without running past its clamp,
    // so the bloom has to be the last word.
    expect(shader.fragmentShader).toContain('mix(turned, blossomHue(seed), blossomFall(stage, seed) * mask)');
    expect(shader.fragmentShader.indexOf('vec3 turned ='))
      .toBeLessThan(shader.fragmentShader.indexOf('blossomHue(seed), blossomFall'));
  });

  it('gates the bloom on the year warming, which is what keeps autumn flowerless', () => {
    const mat = new THREE.MeshLambertMaterial({ color: 0x6f9c3a });
    attachSeasonalTint(mat);
    expect(compile(mat).fragmentShader)
      .toContain('float spring = smoothstep(0.55, 0.95, uFoliageWarming);');

    // The uniform behind that gate: full in mid-spring, shut in mid-autumn.
    setSeasonPhase(mat, 0.25);
    const u = mat.userData.hexWorldFoliage as Record<string, THREE.IUniform>;
    expect(u.uFoliageWarming.value as number).toBeGreaterThan(0.95);
    setSeasonPhase(mat, 0.75);
    expect(u.uFoliageWarming.value as number).toBeLessThan(0.55);
  });
});

describe('snow and tint on one material', () => {
  it('turns the leaves before the snow settles on them, attached either way round', () => {
    for (const order of [0, 1]) {
      const mat = new THREE.MeshLambertMaterial({ color: 0x6f9c3a });
      if (order === 0) { attachSnow(mat); attachSeasonalTint(mat); }
      else             { attachSeasonalTint(mat); attachSnow(mat); }

      const shader = compile(mat);
      expect(shader.fragmentShader.indexOf('seasonalFoliage'))
        .toBeLessThan(shader.fragmentShader.indexOf('uSnowColor, snowAmt'));
    }
  });

  it('declares the shared climate lookup exactly once', () => {
    const mat = new THREE.MeshLambertMaterial({ color: 0x6f9c3a });
    attachSnow(mat);
    attachSeasonalTint(mat);
    const shader = compile(mat);
    // A second copy would be a redeclaration, and would not compile.
    expect(shader.vertexShader.split('attribute float cellIndex;').length - 1).toBe(1);
    expect(shader.vertexShader.split('uniform sampler2D uClimateData;').length - 1).toBe(1);
    expect(shader.fragmentShader.split('varying float vSeasonTemp;').length - 1).toBe(1);
  });

  it('shares one climate binding, so configureSeason reaches both effects', () => {
    const mat = new THREE.MeshLambertMaterial({ color: 0x6f9c3a });
    attachSnow(mat);
    attachSeasonalTint(mat);

    const snow    = mat.userData.hexWorldSnow    as Record<string, THREE.IUniform>;
    const foliage = mat.userData.hexWorldFoliage as Record<string, THREE.IUniform>;
    // Identity, not equality: three keeps one uniform object per name, so two
    // independently-built sets would leave one of them bound to nothing.
    expect(snow.uSeasonEnabled).toBe(foliage.uSeasonEnabled);
    expect(snow.uClimateData).toBe(foliage.uClimateData);

    const climate = new ClimateData(8, 4);
    configureSeason(mat, climate);
    expect(snow.uClimateData.value).toBe(climate.texture);
    expect(foliage.uSeasonEnabled.value).toBe(1);

    setSeasonEnabled(mat, false);
    expect(snow.uSeasonEnabled.value).toBe(0);
    expect(foliage.uSeasonEnabled.value).toBe(0);
  });

  it('a conifer takes snow and no tint — that is the whole difference', () => {
    const pine = new THREE.MeshLambertMaterial({ color: 0x3f6b2c });
    attachSnow(pine);
    expect(hasSeasonalTint(pine)).toBe(false);
    const shader = compile(pine);
    expect(shader.fragmentShader).toContain('snowCoverage');
    expect(shader.fragmentShader).not.toContain('seasonalFoliage');
  });
});

describe('setSeasonPhase', () => {
  it('pushes the year direction to tinted materials and skips the rest', () => {
    const broadleaf = new THREE.MeshLambertMaterial({ color: 0x6f9c3a });
    attachSeasonalTint(broadleaf);
    const pine = new THREE.MeshLambertMaterial({ color: 0x3f6b2c });
    attachSnow(pine);

    setSeasonPhase(broadleaf, 0.75);
    setSeasonPhase(pine, 0.75); // no foliage uniforms — must not throw

    const u = broadleaf.userData.hexWorldFoliage as Record<string, THREE.IUniform>;
    expect(u.uFoliageWarming.value).toBeCloseTo(seasonWarming(0.75), 6);
  });

  it('reaches a ShaderMaterial terrain too', () => {
    const mat = makeTerrainMaterial();
    setSeasonPhase(mat, 0.25);
    expect(mat.uniforms.uFoliageWarming.value).toBeCloseTo(1, 5);
  });
});

describe('scatter shapes', () => {
  const lowestY = (g: THREE.BufferGeometry): number => {
    g.computeBoundingBox();
    return g.boundingBox!.min.y;
  };

  it('seats every plant on the ground, so yOffset stays 0 across tiers', () => {
    for (const g of [createPineGeometry(2), createBroadleafGeometry(1.8), createBushGeometry(0.7)]) {
      expect(lowestY(g)).toBeCloseTo(0, 5);
    }
  });

  it('makes height mean height, whatever the crown geometry does', () => {
    for (const h of [1.0, 1.8, 2.6]) {
      const tree = createBroadleafGeometry(h);
      tree.computeBoundingBox();
      expect(tree.boundingBox!.max.y).toBeCloseTo(h, 5);

      const pine = createPineGeometry(h);
      pine.computeBoundingBox();
      expect(pine.boundingBox!.max.y).toBeCloseTo(h, 5);
    }
  });

  it('sizes a bush by its width, which is what a low sprawling thing has', () => {
    const g = createBushGeometry(0.8);
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    expect(bb.max.x - bb.min.x).toBeLessThanOrEqual(0.8);
    expect(bb.max.y).toBeLessThan(0.8 * 0.7); // low scrub, not a sapling
  });

  it('gives the broadleaf a brown trunk and a green canopy in one buffer', () => {
    const g = createBroadleafGeometry();
    const color = g.getAttribute('color');
    expect(color).toBeDefined();
    expect(g.index).toBeNull(); // merged parts must not share an index

    const hexes = new Set<number>();
    const c = new THREE.Color();
    for (let i = 0; i < color.count; i++) {
      c.setRGB(color.getX(i), color.getY(i), color.getZ(i));
      hexes.add(c.getHex());
    }
    expect(hexes.size).toBe(2);

    // The trunk is what the tint's green test has to reject, in the same linear
    // space the shader compares them in.
    const trunk = new THREE.Color(0x6b4b30);
    const leaf  = new THREE.Color(BROADLEAF_CANOPY_COLOR);
    expect(trunk.g - Math.max(trunk.r, trunk.b)).toBeLessThan(0);
    expect(leaf.g  - Math.max(leaf.r,  leaf.b)).toBeGreaterThan(0.1);
  });

  it('gives the bush a single foliage color', () => {
    const g = createBushGeometry();
    const color = g.getAttribute('color');
    const hexes = new Set<number>();
    const c = new THREE.Color();
    for (let i = 0; i < color.count; i++) {
      c.setRGB(color.getX(i), color.getY(i), color.getZ(i));
      hexes.add(c.getHex());
    }
    expect(hexes.size).toBe(1);
  });

  it('recomputes normals, since the parts are non-uniformly scaled', () => {
    const g = createBushGeometry();
    const n = g.getAttribute('normal');
    expect(n).toBeDefined();
    const len = Math.hypot(n.getX(0), n.getY(0), n.getZ(0));
    expect(len).toBeCloseTo(1, 3);
  });
});

describe('scatter layers past the third', () => {
  it('gets a hash uncorrelated with layer 0, so the two actually compete', () => {
    const grid = new HexHashGrid(1234);
    let layer3Wins = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const x = (i % 50) * 0.7, z = Math.floor(i / 50) * 0.7;
      // Layer 0 reads channel a; layer 3 takes a fresh stream (layerIndex + 2).
      if (grid.channel(x, z, 5) < grid.sample(x, z).a) layer3Wins++;
    }
    // An offset of channel A used to put this near 85%.
    expect(layer3Wins / N).toBeGreaterThan(0.42);
    expect(layer3Wins / N).toBeLessThan(0.58);
  });

  it('is stable for the same position and seed', () => {
    const grid = new HexHashGrid(99);
    expect(grid.channel(3.3, -4.1, 7)).toBe(grid.channel(3.3, -4.1, 7));
    expect(grid.channel(3.3, -4.1, 5)).not.toBe(grid.channel(3.3, -4.1, 6));
  });

  it('matches sample() on the five channels it already publishes', () => {
    const grid = new HexHashGrid(7);
    const h = grid.sample(2.5, 6.25);
    expect(grid.channel(2.5, 6.25, 0)).toBe(h.a);
    expect(grid.channel(2.5, 6.25, 2)).toBe(h.c);
  });
});

describe('generators fill the new plant layers', () => {
  const levels = (map: HexMap, layer: number): number[] => {
    const out: number[] = [];
    map.forEach((col, row) => out.push(map.getFeatureLevel(col, row, layer)));
    return out;
  };

  it('generateFbmTerrain writes broadleaf and bush layers when the map has them', () => {
    const map = new HexMap({ width: 64, height: 64, featureLayerCount: 4 });
    generateFbmTerrain(map, {});
    expect(Math.max(...levels(map, 2))).toBeGreaterThan(0);
    expect(Math.max(...levels(map, 3))).toBeGreaterThan(0);
  });

  it('gives rocks more than one density, so more than one size can spawn', () => {
    // A single level draws a single scatter tier (see FEATURE_THRESHOLDS), so a
    // binary "is this rock terrain" put the same boulder at the same spacing
    // over every scree slope on the map.
    const map = new HexMap({ width: 96, height: 96, featureLayerCount: 2 });
    generateFbmTerrain(map, {});
    const distinct = new Set(levels(map, 1).filter(l => l > 0));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('leaves a two-layer map exactly as it was', () => {
    const two  = new HexMap({ width: 64, height: 64, featureLayerCount: 2 });
    const four = new HexMap({ width: 64, height: 64, featureLayerCount: 4 });
    generateFbmTerrain(two, {});
    generateFbmTerrain(four, {});
    expect(levels(two, 0)).toEqual(levels(four, 0));
    expect(levels(two, 1)).toEqual(levels(four, 1));
  });

  it('assignBiomes puts broadleaf in the warm wet bands and scrub in the dry ones', () => {
    const map = new HexMap({ width: 32, height: 32, featureLayerCount: 4 });
    const n = map.width * map.height;
    const temperature = new Float32Array(n);
    const moisture    = new Float32Array(n);
    map.forEach((col, row) => {
      map.setElevation(col, row, 1);
      // Rows ramp temperature, columns ramp moisture.
      temperature[row * map.width + col] = row / (map.height - 1);
      moisture[row * map.width + col]    = col / (map.width - 1);
    });
    assignBiomes(map, temperature, moisture);

    // Hot and wet: broadleaf country.
    expect(map.getFeatureLevel(map.width - 1, map.height - 1, 2)).toBeGreaterThan(0);
    // Cold: no broadleaf at any moisture.
    expect(map.getFeatureLevel(map.width - 1, 0, 2)).toBe(0);
    // Warm and dry: scrub without a canopy.
    expect(map.getFeatureLevel(1, map.height - 1, 3)).toBeGreaterThan(0);
  });
});
