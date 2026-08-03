import type { HexMap } from '../map/HexMap.js';
import type { MapGeneratorPlugin } from './MapGeneratorPlugin.js';
import { makeRng } from '../math/Random.js';
import { TerrainType } from '../map/HexCell.js';
import { POINTY_TOP } from '../math/HexOrientation.js';
import { offsetNeighbor } from '../math/HexCoord.js';

// Lava and acid terrain indices registered in the demo's extended descriptor list.
// Cast to TerrainType — these are valid uint8 terrain indices even though they
// extend beyond the built-in enum values. ACID_DEEP shares liquidType 'acid' with
// ACID_TERRAIN, exercising the multi-index-per-liquid path.
// 6 is the built-in riverbed terrain (DEFAULT_RIVERBED_TERRAIN_INDEX), so
// showcase liquids start at 7. Consumers must define matching descriptors.
const LAVA_TERRAIN      = 7 as TerrainType;
const ACID_TERRAIN      = 8 as TerrainType;
const ACID_DEEP_TERRAIN = 9 as TerrainType;

const EDGE_DIRS = POINTY_TOP.edgeDirections;

/**
 * Traces a river downhill from (startCol, startRow) until it reaches any liquid
 * terrain (water, lava, acid, …) or negative elevation. Stops at all liquid types
 * so rivers don't accidentally pass through lava or acid pools.
 */
function traceDemoRiver(
  map: HexMap,
  startCol: number,
  startRow: number,
  maxSteps: number,
  liquidTerrains: Set<number>,
): void {
  let c = startCol, r = startRow;
  const visited = new Set<number>();

  for (let step = 0; step < maxSteps; step++) {
    if (map.getElevation(c, r) < 0 || liquidTerrains.has(map.getTerrain(c, r))) break;

    const cellKey = r * map.width + c;
    if (visited.has(cellKey)) break;
    visited.add(cellKey);

    const ownElev = map.getElevation(c, r);
    let bestEdge = -1;
    let bestElev = ownElev + 1;
    let bestNbC  = -1;
    let bestNbR  = -1;

    for (let i = 0; i < 6; i++) {
      const nb = offsetNeighbor(c, r, EDGE_DIRS[i]);
      if (!map.inBounds(nb.col, nb.row)) continue;
      if (visited.has(nb.row * map.width + nb.col)) continue;
      const nbElev = map.getElevation(nb.col, nb.row);
      if (nbElev < bestElev) {
        bestElev = nbElev;
        bestEdge = i;
        bestNbC  = nb.col;
        bestNbR  = nb.row;
      }
    }

    if (bestEdge === -1) break;

    map.setRiverOutgoing(c, r, bestEdge);
    map.setRiverIncoming(bestNbC, bestNbR, (bestEdge + 3) % 6);

    // Stop at liquid terrain OR when joining an existing river (prevents two traces
    // from trampling each other's downstream chain and causing type changes).
    if (liquidTerrains.has(map.getTerrain(bestNbC, bestNbR))) break;
    if (map.hasOutgoingRiver(bestNbC, bestNbR)) break;
    c = bestNbC;
    r = bestNbR;
  }
}

interface LiquidShowcaseConfig {
  lavaElevation: number;
  acidElevation: number;
  waterLakeElevation: number;
}

/**
 * Comprehensive liquids review map — every rendering case the liquid system
 * supports appears somewhere on this island:
 *
 * Standing bodies:
 *   - Water ocean surrounding the island (floor −1, surface 0)
 *   - Elevated lava caldera lake (floor at lavaElevation − 1)
 *   - Low acid swamp with DEEP acid cores (second terrain index sharing
 *     liquidType 'acid' — multi-index liquid + varying depth attribute)
 *   - Elevated water lake (southern plain) — same liquid as the ocean but with
 *     its own per-body surface elevation
 *
 * Liquid–liquid boundaries (southeastern coast):
 *   - Coastal lava pond and acid pool straddling the shoreline, adjacent to
 *     the ocean and to each other — all three boundary pairs (water|lava,
 *     water|acid, lava|acid) plus their three-way junctions with land,
 *     exercising the foam-priority rules
 *
 * Rivers / estuaries:
 *   - Rivers draining into water, lava, and acid (incoming estuaries at sea
 *     level and at elevated surfaces)
 *   - Water-lake OUTLET river (outgoing estuary with mirrored flow UVs)
 *     flowing down a carved gorge to the ocean, plus inlet rivers into the lake
 *   - A deliberate dead-end river that never reaches liquid (unclassified —
 *     rendered once by the default liquid)
 */
export const LiquidShowcasePlugin: MapGeneratorPlugin<LiquidShowcaseConfig> = {
  id:   'liquid-showcase',
  name: 'Liquid Showcase',
  defaultConfig: { lavaElevation: 7, acidElevation: 1, waterLakeElevation: 4 },

  generate(map: HexMap, config: LiquidShowcaseConfig, seed: number): void {
    const rand = makeRng(seed);
    const w = map.width;
    const h = map.height;

    // Volcanic caldera (lava lake) — northern half of the island
    const lavaCX = w * 0.5;
    const lavaCZ = h * 0.35;
    const lavaFloor = config.lavaElevation - 1;
    const lavaElev  = config.lavaElevation;
    const rimElev   = lavaElev + 4;

    const lavaLakeR  = Math.min(w, h) * 0.09;
    const lavaRimR   = lavaLakeR * 2.2;
    const lavaSlopeR = lavaRimR * 1.7;

    // Acid swamp — southwestern interior. Kept clear of both the coast (so its
    // elevated body never merges with the ocean and lifts the sea surface) and
    // the lava outer slope (which would clip it).
    const acidCX = w * 0.33;
    const acidCZ = h * 0.64;
    const acidFloor = config.acidElevation - 1;
    const acidR1    = Math.min(w, h) * 0.08;
    const acidR2    = Math.min(w, h) * 0.055;

    const coastR = Math.min(w, h) * 0.48;

    // Coastal vents — a lava pond and an acid pool straddling the shoreline,
    // overlapping each other. Their floors sit at -1 like the ocean, so all
    // three liquid-liquid boundary pairs (water|lava, water|acid, lava|acid)
    // meet at the same surface level, plus three-way junctions with land.
    const pondCX = w * 0.5 + coastR * 0.80, pondCZ = h * 0.5 + coastR * 0.60;
    const poolCX = w * 0.5 + coastR * 0.66, poolCZ = h * 0.5 + coastR * 0.75;
    const pondR  = Math.min(w, h) * 0.05;
    const poolR  = Math.min(w, h) * 0.06;

    // Elevated water lake — southern plain, clear of the lava outer slope.
    // Same liquid type as the ocean but a separate body, so it gets its own
    // computed surface elevation.
    const wlakeCX      = w * 0.5;
    const wlakeCZ      = h * 0.8;
    const wlakeSurface = config.waterLakeElevation;
    const wlakeFloor   = wlakeSurface - 1;
    const wlakeR       = Math.min(w, h) * 0.045;
    const wlakeRimR    = wlakeR * 2.0;
    const wlakeSlopeR  = wlakeRimR * 1.5;

    map.forEach((col, row) => {
      const jitter = (rand() - 0.5) * 2.5;

      const dlava  = Math.hypot(col - lavaCX, row - lavaCZ);
      const dacid1 = Math.hypot(col - acidCX, row - acidCZ);
      const dacid2 = Math.hypot(col - (acidCX + 2), row - (acidCZ + 7));
      const dCoast = Math.hypot(col - w * 0.5, row - h * 0.5);
      const dpond  = Math.hypot(col - pondCX, row - pondCZ);
      const dpool  = Math.hypot(col - poolCX, row - poolCZ);
      const dwlake = Math.hypot(col - wlakeCX, row - wlakeCZ);

      // Coastal vents come before the ocean so they can replace shoreline cells.
      if (dpond < pondR + jitter) {
        map.setTerrain(col, row, LAVA_TERRAIN);
        map.setElevation(col, row, -1);
        return;
      }
      if (dpool < poolR + jitter) {
        map.setTerrain(col, row, ACID_TERRAIN);
        map.setElevation(col, row, -1);
        return;
      }

      if (dCoast > coastR + jitter) {
        map.setTerrain(col, row, TerrainType.Water);
        map.setElevation(col, row, -1);
        return;
      }

      if (dlava < lavaLakeR + jitter) {
        map.setTerrain(col, row, LAVA_TERRAIN);
        map.setElevation(col, row, lavaFloor);
        return;
      }

      if (dlava < lavaRimR + jitter) {
        const t = (dlava - lavaLakeR) / (lavaRimR - lavaLakeR);
        const elev = Math.round(lavaElev + (rimElev - lavaElev) * Math.sin(t * Math.PI));
        map.setTerrain(col, row, TerrainType.Rock);
        map.setElevation(col, row, Math.max(lavaElev, elev));
        return;
      }

      if (dlava < lavaSlopeR + jitter) {
        const t = (dlava - lavaRimR) / (lavaSlopeR - lavaRimR);
        const elev = Math.round(lavaElev * (1 - t * t));
        const terrain = elev > lavaElev - 1 ? TerrainType.Rock
                      : elev > 2            ? TerrainType.Grassland
                      :                       TerrainType.Mud;
        map.setTerrain(col, row, terrain);
        map.setElevation(col, row, Math.max(0, elev));
        return;
      }

      // Elevated water lake: floor one below the surface, gentle rim, outer slope.
      if (dwlake < wlakeR + jitter) {
        map.setTerrain(col, row, TerrainType.Water);
        map.setElevation(col, row, wlakeFloor);
        return;
      }
      if (dwlake < wlakeRimR + jitter) {
        const t = (dwlake - wlakeR) / (wlakeRimR - wlakeR);
        const elev = Math.round(wlakeSurface + Math.sin(t * Math.PI) * 2);
        map.setTerrain(col, row, TerrainType.Grassland);
        map.setElevation(col, row, Math.max(wlakeSurface, elev));
        return;
      }
      if (dwlake < wlakeSlopeR + jitter) {
        // Blend down to the surrounding plain's grade (not below it) so the
        // outlet river isn't trapped in a moat around the lake.
        const t = (dwlake - wlakeRimR) / (wlakeSlopeR - wlakeRimR);
        const plainElev = Math.max(0, Math.round((1 - dCoast / coastR) * 3));
        const elev = Math.max(plainElev, Math.round(wlakeSurface * (1 - t)));
        map.setTerrain(col, row, TerrainType.Grassland);
        map.setElevation(col, row, elev);
        return;
      }

      if (dacid1 < acidR1 + jitter || dacid2 < acidR2 + jitter) {
        // Deep cores use a second terrain index sharing liquidType 'acid':
        // multi-index liquid (no internal foam line) with a deeper floor, so
        // the depth attribute actually varies across the pool.
        const deep = dacid1 < acidR1 * 0.45 || dacid2 < acidR2 * 0.45;
        map.setTerrain(col, row, deep ? ACID_DEEP_TERRAIN : ACID_TERRAIN);
        map.setElevation(col, row, deep ? acidFloor - 2 : acidFloor);
        return;
      }

      const distFromCenter = Math.hypot(col - w * 0.5, row - h * 0.5);
      const t = distFromCenter / coastR;
      const elev = Math.round((1 - t) * 3);
      const terrain = elev > 0 ? TerrainType.Grassland : TerrainType.Mud;
      map.setTerrain(col, row, terrain);
      map.setElevation(col, row, Math.max(0, elev));
    });

    // --- Rivers ---
    // traceDemoRiver stops at any liquid terrain (water, lava, acid) and also
    // stops when merging into an already-traced river to keep chains consistent.
    const liquidTerrains = new Set<number>([
      TerrainType.Water as number,
      LAVA_TERRAIN      as number,
      ACID_TERRAIN      as number,
      ACID_DEEP_TERRAIN as number,
    ]);

    // Lava rivers — inner crater wall, distance 1.1–1.25 × lavaLakeR from center.
    // At this distance the terrain reliably slopes inward toward the lava lake,
    // so the trace flows down into the caldera and terminates at lava terrain.
    const numLavaRivers = 2 + Math.floor(rand() * 3);
    const lavaAngle0 = rand() * Math.PI * 2;
    for (let i = 0; i < numLavaRivers; i++) {
      const angle = lavaAngle0 + (i / numLavaRivers) * Math.PI * 2 + (rand() - 0.5) * 0.4;
      const dist  = lavaLakeR * 1.1 + rand() * lavaLakeR * 0.15;
      const col = Math.round(lavaCX + Math.cos(angle) * dist);
      const row = Math.round(lavaCZ + Math.sin(angle) * dist);
      if (map.inBounds(col, row)) traceDemoRiver(map, col, row, 100, liquidTerrains);
    }

    // Outer slope rivers — scattered around the whole caldera at distance
    // just beyond the rim. Terrain determines the destination: seeds facing
    // the ocean become water rivers; seeds facing the acid swamp become acid.
    const numSlopeRivers = 4 + Math.floor(rand() * 4);
    const slopeAngle0 = rand() * Math.PI * 2;
    for (let i = 0; i < numSlopeRivers; i++) {
      const angle = slopeAngle0 + (i / numSlopeRivers) * Math.PI * 2 + (rand() - 0.5) * 0.5;
      const dist  = lavaRimR + rand() * (lavaSlopeR - lavaRimR) * 0.6;
      const col = Math.round(lavaCX + Math.cos(angle) * dist);
      const row = Math.round(lavaCZ + Math.sin(angle) * dist);
      if (map.inBounds(col, row)) traceDemoRiver(map, col, row, 100, liquidTerrains);
    }

    // Acid perimeter — dedicated seeds around the acid pool to guarantee
    // some acid rivers regardless of how the slope seeds happen to face.
    const numAcidRivers = 2 + Math.floor(rand() * 2);
    const acidAngle0 = rand() * Math.PI * 2;
    for (let i = 0; i < numAcidRivers; i++) {
      const angle = acidAngle0 + (i / numAcidRivers) * Math.PI * 2 + (rand() - 0.5) * 0.5;
      const dist  = acidR1 * 1.2 + rand() * acidR1 * 0.5;
      const col = Math.round(acidCX + Math.cos(angle) * dist);
      const row = Math.round(acidCZ + Math.sin(angle) * dist);
      if (map.inBounds(col, row)) traceDemoRiver(map, col, row, 100, liquidTerrains);
    }

    // Water-lake inlets — seeds on the inner west rim flow downhill into the
    // lake, giving incoming estuaries at an elevated water surface. Seeds must
    // sit INSIDE the rim's elevation crest (~1.5 × lake radius) or they drain
    // outward instead; angles are spread so traces don't collide.
    const numLakeInlets = 2 + Math.floor(rand() * 2);
    for (let i = 0; i < numLakeInlets; i++) {
      const angle = Math.PI + (i / numLakeInlets - 0.5) * 1.2 + (rand() - 0.5) * 0.4;
      const dist  = wlakeR * (1.3 + rand() * 0.15);
      const col = Math.round(wlakeCX + Math.cos(angle) * dist);
      const row = Math.round(wlakeCZ + Math.sin(angle) * dist);
      if (map.inBounds(col, row)) traceDemoRiver(map, col, row, 100, liquidTerrains);
    }

    // Water-lake OUTLET — carve a descending gorge eastward through the rim and
    // hand-connect the first river segment from the lake-edge water cell, so the
    // lake cell has an OUTGOING river (outgoing-estuary case, mirrored flow UVs).
    {
      const row = Math.round(wlakeCZ);
      let col = Math.round(wlakeCX);
      while (map.inBounds(col + 1, row) && map.getTerrain(col, row) === (TerrainType.Water as number)) col++;
      // col is the first land cell east of the lake; (col - 1, row) is the lake edge.
      // Carve descending, holding at 0 through the rim, until the gorge floor
      // meets terrain at or below it — so the tracer is never left in a pit.
      const chain: [number, number][] = [[col - 1, row]];
      for (let k = 0; map.inBounds(col, row) && k < 30; k++, col++) {
        const existing = map.getElevation(col, row);
        if (liquidTerrains.has(map.getTerrain(col, row)) || existing < 0) break; // reached open water
        const carveElev = Math.max(0, wlakeFloor - k);
        if (existing <= carveElev) break; // gorge merged with the plain grade
        map.setTerrain(col, row, TerrainType.Mud);
        map.setElevation(col, row, carveElev);
        chain.push([col, row]);
      }

      const edgeToward = (c: number, r: number, tc: number, tr: number): number => {
        for (let i = 0; i < 6; i++) {
          const nb = offsetNeighbor(c, r, EDGE_DIRS[i]);
          if (nb.col === tc && nb.row === tr) return i;
        }
        return -1;
      };
      for (let k = 0; k < chain.length - 1; k++) {
        const [c0, r0] = chain[k];
        const [c1, r1] = chain[k + 1];
        const e = edgeToward(c0, r0, c1, r1);
        if (e < 0) break;
        map.setRiverOutgoing(c0, r0, e);
        map.setRiverIncoming(c1, r1, (e + 3) % 6);
      }
      // Let the greedy tracer carry the river from the gorge mouth to the ocean.
      if (chain.length > 1) {
        const [lc, lr] = chain[chain.length - 1];
        traceDemoRiver(map, lc, lr, 100, liquidTerrains);
      }
    }

    // Deliberate dead-end river on the southern plain — never reaches a liquid,
    // exercising the unclassified-river path (rendered once, by the default liquid).
    traceDemoRiver(map, Math.round(w * 0.38), Math.round(h * 0.80), 5, liquidTerrains);

    map.computeWaterSurfaces(t => liquidTerrains.has(t));
  },
};
