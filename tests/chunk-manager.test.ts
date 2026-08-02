import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { HexMap } from '../src/map/HexMap.js';
import {
  ChunkManager,
  RENDER_ORDER_SHORE, RENDER_ORDER_ESTUARY, RENDER_ORDER_RIVER,
} from '../src/geometry/ChunkManager.js';
import { createLayout } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';
import { resolveLiquidMaterials, DEFAULT_LIQUID_DESCRIPTORS } from '../src/geometry/LiquidTypes.js';
import { resolveTerrainDefinitions } from '../src/geometry/TerrainTypes.js';

const EDGE_DIRS = POINTY_TOP.edgeDirections;
const WATER = 5;
const eastEdge = EDGE_DIRS.findIndex(d => d === 0); // HEX_DIRECTIONS[0] = {q:1, r:0}

/** Paint a pond at (pondCol, row) and a 3-cell river flowing east into it. */
function paintRiver(map: HexMap, row: number): void {
  const pondCol = 10;
  map.setTerrain(pondCol, row, WATER);
  map.setElevation(pondCol, row, -1);
  for (let c = pondCol - 3; c < pondCol; c++) {
    map.setElevation(c, row, pondCol - c);
    map.setRiverOutgoing(c, row, eastEdge);
    map.setRiverIncoming(c + 1, row, (eastEdge + 3) % 6);
  }
  map.computeWaterSurfaces();
}

// River meshes are the only ones ChunkManager adds at RENDER_ORDER_RIVER.
const riverMeshCount = (scene: THREE.Scene) =>
  scene.children.filter(o => o.renderOrder === RENDER_ORDER_RIVER).length;

describe('ChunkManager river ownership cache', () => {
  it('renders rivers from the current map after dispose + reload (regenerate flow)', () => {
    const scene  = new THREE.Scene();
    const map    = new HexMap({ width: 16, height: 16 });
    const layout = createLayout(POINTY_TOP, 1);
    const cm = new ChunkManager({
      map, layout, scene,
      material: new THREE.MeshBasicMaterial(),
      liquidMaterials: new Map([['water', resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0])]]),
      chunkSize: 16,
    });

    paintRiver(map, 4);
    cm.loadAll();
    expect(riverMeshCount(scene)).toBeGreaterThan(0);

    // Regenerate in place exactly like the demo: clear + rebuild elsewhere,
    // then dispose and reload — no markDirty. The ownership cache must not
    // serve the old map's river cells.
    map.clear();
    paintRiver(map, 11);
    cm.dispose();
    cm.loadAll();
    expect(riverMeshCount(scene)).toBeGreaterThan(0);
  });
});

describe('ChunkManager flow-width staleness', () => {
  it('rebuilds downstream chunks when an upstream edit changes accumulated flow', () => {
    const scene  = new THREE.Scene();
    const map    = new HexMap({ width: 32, height: 16 }); // chunks (0,0) and (1,0)
    const layout = createLayout(POINTY_TOP, 1);
    const cm = new ChunkManager({
      map, layout, scene,
      material: new THREE.MeshBasicMaterial(),
      liquidMaterials: new Map([['water', resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0])]]),
      chunkSize: 16,
    });

    // River spanning both chunks, flowing east.
    for (let c = 6; c < 28; c++) {
      map.setRiverOutgoing(c, 8, eastEdge);
      map.setRiverIncoming(c + 1, 8, (eastEdge + 3) % 6);
    }
    map.computeWaterSurfaces();
    cm.loadAll();
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(16, 20, 8);
    cm.update(camera);
    const downstreamBefore = cm.terrainMeshes[1].geometry.uuid;

    // Extend the river upstream — edits touch ONLY chunk (0,0), but every
    // downstream cell's accumulated flow (and channel width) changes.
    for (let c = 2; c < 6; c++) {
      map.setRiverOutgoing(c, 8, eastEdge);
      map.setRiverIncoming(c + 1, 8, (eastEdge + 3) % 6);
      cm.markDirty(c, 8);
    }
    cm.markDirty(6, 8);
    cm.update(camera);

    expect(cm.terrainMeshes[1].geometry.uuid).not.toBe(downstreamBefore);
  });
});

describe('ChunkManager in-place swaps', () => {
  it('setMap swaps maps without recreating the manager', () => {
    const scene  = new THREE.Scene();
    const layout = createLayout(POINTY_TOP, 1);
    const mapA   = new HexMap({ width: 16, height: 16 });
    const cm = new ChunkManager({
      map: mapA, layout, scene,
      material: new THREE.MeshBasicMaterial(),
      liquidMaterials: new Map([['water', resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0])]]),
      chunkSize: 16,
    });
    paintRiver(mapA, 4);
    cm.loadAll();
    expect(cm.loadedChunkCount).toBe(1);
    expect(riverMeshCount(scene)).toBeGreaterThan(0);

    const mapB = new HexMap({ width: 32, height: 32 }); // different size
    paintRiver(mapB, 20);
    cm.setMap(mapB);
    expect(cm.loadedChunkCount).toBe(0); // old meshes gone
    expect(cm.chunksX).toBe(2);          // chunk grid follows the new map
    cm.loadAll();
    expect(cm.loadedChunkCount).toBe(4);
    expect(riverMeshCount(scene)).toBeGreaterThan(0);
  });

  it('setLiquids swaps liquid material sets in place', () => {
    const scene  = new THREE.Scene();
    const layout = createLayout(POINTY_TOP, 1);
    const map    = new HexMap({ width: 16, height: 16 });
    const cm = new ChunkManager({
      map, layout, scene,
      material: new THREE.MeshBasicMaterial(),
      liquidMaterials: new Map([['water', resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0])]]),
      chunkSize: 16,
    });
    paintRiver(map, 4);
    cm.loadAll();
    expect(riverMeshCount(scene)).toBeGreaterThan(0);

    // Swap to a set with no river material: surfaces stay, river meshes go.
    const surfaceOnly = { surface: resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0]).surface };
    cm.setLiquids(DEFAULT_LIQUID_DESCRIPTORS, new Map([['water', surfaceOnly]]));
    cm.loadAll();
    expect(riverMeshCount(scene)).toBe(0);
    expect(cm.loadedWaterChunkCount).toBeGreaterThan(0);
  });

  it('setTerrainDefinitions changes liquid membership in place', () => {
    const scene  = new THREE.Scene();
    const layout = createLayout(POINTY_TOP, 1);
    const map    = new HexMap({ width: 16, height: 16 });
    const CUSTOM_WATER = 7;
    // Pond painted with a custom terrain index that the default defs treat as land.
    map.setTerrain(8, 8, CUSTOM_WATER);
    map.setElevation(8, 8, -1);
    map.computeWaterSurfaces(t => t === CUSTOM_WATER);

    const cm = new ChunkManager({
      map, layout, scene,
      material: new THREE.MeshBasicMaterial(),
      liquidMaterials: new Map([['water', resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0])]]),
      chunkSize: 16,
    });
    cm.loadAll();
    expect(cm.loadedWaterChunkCount).toBe(0); // index 7 is land under default defs

    cm.setTerrainDefinitions(resolveTerrainDefinitions([
      { index: 0, id: 'grass', name: 'Grass', color: 0x86b888, texture: { type: 'procedural' } },
      { index: CUSTOM_WATER, id: 'custom-water', name: 'Custom Water', color: 0x4a8fb5, liquidType: 'water', texture: { type: 'procedural' } },
    ]));
    cm.loadAll();
    expect(cm.loadedWaterChunkCount).toBeGreaterThan(0); // now renders as liquid
  });
});

describe('ChunkManager transparent layering', () => {
  it('renders shore above the surface and below estuary/river (fixed renderOrder)', () => {
    const scene  = new THREE.Scene();
    const map    = new HexMap({ width: 16, height: 16 });
    const layout = createLayout(POINTY_TOP, 1);
    const cm = new ChunkManager({
      map, layout, scene,
      material: new THREE.MeshBasicMaterial(),
      liquidMaterials: new Map([['water', resolveLiquidMaterials(DEFAULT_LIQUID_DESCRIPTORS[0])]]),
      chunkSize: 16,
    });

    // Pond with land all around plus an incoming river: produces surface,
    // shore, estuary, and river meshes in one load.
    paintRiver(map, 4);
    cm.loadAll();

    const orders = new Set(scene.children.map(o => o.renderOrder));
    // The full-hex surface mesh (default order 0) overlaps the shore strip, so
    // the shore must be forced above it — bounding-sphere depth sorting alone
    // flips with the camera and washes out the foam.
    expect(orders.has(RENDER_ORDER_SHORE)).toBe(true);
    expect(orders.has(RENDER_ORDER_ESTUARY)).toBe(true);
    expect(orders.has(RENDER_ORDER_RIVER)).toBe(true);
    expect(RENDER_ORDER_SHORE).toBeGreaterThan(0);
    expect(RENDER_ORDER_ESTUARY).toBeGreaterThan(RENDER_ORDER_SHORE);
  });
});
