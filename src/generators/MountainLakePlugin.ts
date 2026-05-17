import type { HexMap } from '../map/HexMap.js';
import type { MapGeneratorPlugin } from './MapGeneratorPlugin.js';
import { makeRng } from '../math/Random.js';
import { TerrainType } from '../map/HexCell.js';

interface MountainLakeConfig {
  lakeElevation: number;
}

export const MountainLakePlugin: MapGeneratorPlugin<MountainLakeConfig> = {
  id:   'mountain-lake',
  name: 'Mountain Lake',
  defaultConfig: { lakeElevation: 6 },

  generate(map: HexMap, config: MountainLakeConfig, seed: number): void {
    const rand = makeRng(seed);
    const w = map.width;
    const h = map.height;
    const cx = w / 2;
    const cz = h / 2;

    // lakeElevation is the water SURFACE elevation.
    // Lake floor cells are at lakeElevation - 1 so computeWaterSurfaces
    // produces surface = (lakeElevation - 1) + 1 = lakeElevation, matching
    // the ocean convention (cells at -1 → surface at 0).
    const lakeFloor = config.lakeElevation - 1;
    const lakeElev  = config.lakeElevation;   // shore / rim base level
    const rimElev   = lakeElev + 3;           // volcano rim peak

    const lakeR    = Math.min(w, h) * 0.10;
    const rimR     = lakeR * 2.1;
    const plateauR = rimR * 1.6;
    const coastR   = Math.min(w, h) * 0.46;

    map.forEach((col, row) => {
      const dx = col - cx;
      const dz = row - cz;
      const d  = Math.hypot(dx, dz);
      const jitter = (rand() - 0.5) * 2.0;

      if (d < lakeR + jitter) {
        // Caldera lake — floor one step below surface so water renders above terrain
        map.setTerrain(col, row, TerrainType.Water);
        map.setElevation(col, row, lakeFloor);
      } else if (d < rimR + jitter) {
        // Volcanic rim — starts at lakeElev at the inner edge so the shore
        // has a proper slope, peaks at rimElev in the middle
        const t = (d - lakeR) / (rimR - lakeR);
        const elev = Math.round(lakeElev + (rimElev - lakeElev) * Math.sin(t * Math.PI));
        map.setTerrain(col, row, TerrainType.Rock);
        map.setElevation(col, row, Math.max(lakeElev, elev));
      } else if (d < plateauR + jitter) {
        // Outer slope descending from the rim base to coastal plain
        const t = (d - rimR) / (plateauR - rimR);
        const elev = Math.round(lakeElev * (1 - t * t));
        const terrain = elev > lakeElev - 1 ? TerrainType.Snow
                      : elev > 2            ? TerrainType.Grassland
                      :                       TerrainType.Mud;
        map.setTerrain(col, row, terrain);
        map.setElevation(col, row, Math.max(0, elev));
      } else if (d < coastR + jitter) {
        // Coastal lowland
        const t = (d - plateauR) / (coastR - plateauR);
        const elev = Math.round((1 - t) * 2);
        map.setTerrain(col, row, TerrainType.Grassland);
        map.setElevation(col, row, Math.max(0, elev));
      } else {
        // Ocean — elevation -1 surfaces at 0 via (−1)+1=0
        map.setTerrain(col, row, TerrainType.Water);
        map.setElevation(col, row, -1);
      }
    });

    map.computeWaterSurfaces();
  },
};
