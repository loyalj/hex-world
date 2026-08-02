import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { HexMap } from '../src/map/HexMap.js';
import { ChunkManager } from '../src/geometry/ChunkManager.js';
import { createLayout } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';
import { resolveLiquidMaterials, DEFAULT_LIQUID_DESCRIPTORS } from '../src/geometry/LiquidTypes.js';

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

// River meshes are the only ones ChunkManager adds with renderOrder 1.
const riverMeshCount = (scene: THREE.Scene) =>
  scene.children.filter(o => o.renderOrder === 1).length;

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
