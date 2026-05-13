/** A rectangular spawn region — chunk centers are constrained here, but chunks can grow outside it. */
export interface MapRegion {
  colMin: number;
  colMax: number; // exclusive
  rowMin: number;
  rowMax: number; // exclusive
}

export interface RegionLayoutOptions {
  /** Water-buffer cells on left/right edges. Default 5. */
  mapBorderX?: number;
  /** Water-buffer cells on top/bottom edges. Default 5. */
  mapBorderZ?: number;
  /** Gap between adjacent region spawn zones (each side). Default 5. */
  regionBorder?: number;
  /** Number of independent spawn regions (1–4). Default 1. */
  regionCount?: number;
}

/**
 * Returns spawn regions for map generation.
 * Only the seed cells for each chunk are constrained to these regions;
 * the BFS expansion can reach anywhere on the map.
 */
export function createRegions(
  mapWidth: number,
  mapHeight: number,
  opts: RegionLayoutOptions,
  rand: () => number,
): MapRegion[] {
  const bx = opts.mapBorderX   ?? 5;
  const bz = opts.mapBorderZ   ?? 5;
  const rb = opts.regionBorder ?? 5;
  const n  = opts.regionCount  ?? 1;

  const hx = Math.floor(mapWidth  / 2);
  const hz = Math.floor(mapHeight / 2);

  const regions: MapRegion[] = [];

  switch (n) {
    default: // 1 region — full map minus border
      regions.push({ colMin: bx, colMax: mapWidth - bx, rowMin: bz, rowMax: mapHeight - bz });
      break;

    case 2:
      if (rand() < 0.5) {
        // vertical split
        regions.push({ colMin: bx,      colMax: hx - rb,          rowMin: bz, rowMax: mapHeight - bz });
        regions.push({ colMin: hx + rb, colMax: mapWidth - bx,     rowMin: bz, rowMax: mapHeight - bz });
      } else {
        // horizontal split
        regions.push({ colMin: bx, colMax: mapWidth - bx, rowMin: bz,      rowMax: hz - rb          });
        regions.push({ colMin: bx, colMax: mapWidth - bx, rowMin: hz + rb, rowMax: mapHeight - bz   });
      }
      break;

    case 3: {
      // vertical thirds
      const t1 = Math.floor(mapWidth / 3);
      const t2 = Math.floor(mapWidth * 2 / 3);
      regions.push({ colMin: bx,       colMax: t1 - rb,       rowMin: bz, rowMax: mapHeight - bz });
      regions.push({ colMin: t1 + rb,  colMax: t2 - rb,       rowMin: bz, rowMax: mapHeight - bz });
      regions.push({ colMin: t2 + rb,  colMax: mapWidth - bx, rowMin: bz, rowMax: mapHeight - bz });
      break;
    }

    case 4:
      // quad split
      regions.push({ colMin: bx,      colMax: hx - rb,      rowMin: bz,      rowMax: hz - rb          });
      regions.push({ colMin: hx + rb, colMax: mapWidth - bx, rowMin: bz,      rowMax: hz - rb          });
      regions.push({ colMin: bx,      colMax: hx - rb,      rowMin: hz + rb, rowMax: mapHeight - bz   });
      regions.push({ colMin: hx + rb, colMax: mapWidth - bx, rowMin: hz + rb, rowMax: mapHeight - bz   });
      break;
  }

  // Drop degenerate regions (can happen when map is too small for the chosen borders)
  return regions.filter(r => r.colMax > r.colMin && r.rowMax > r.rowMin);
}
