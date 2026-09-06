import type { HexMap } from '../map/HexMap.js';
import { TerrainType } from '../map/HexCell.js';
import type { TerrainDescriptor } from '../geometry/TerrainTypes.js';
import { offsetToHex, hexToOffset, hexDistance, hexRange } from '../math/HexCoord.js';

export interface VolcanoOptions {
  /** Number of volcanoes to raise. Default 0 (off). */
  volcanoes?: number;
  /** Radius of the cone in cells, rim crest to the foot of the flanks. Default 4. */
  volcanoRadius?: number;
  /** Rim height above the ground the cone is built on, in elevation steps. Default 5. */
  volcanoHeight?: number;
  /**
   * Terrain index for the caldera pool. Should belong to a liquid type (the
   * built-in lava is the obvious one) so the pool renders as a surface;
   * omit for a dry crater floored with {@link VolcanoOptions.volcanoAshTerrain}.
   */
  volcanoLavaTerrain?: number;
  /**
   * Terrain index for the cone and the ash apron around it. Default Rock
   * (4); pass {@link VOLCANIC_ASH_TERRAIN_DESCRIPTOR}'s index for a dark
   * ash field.
   */
  volcanoAshTerrain?: number;
  /** How far past the foot of the cone ash falls, feathering out. Default 1.5 × radius. */
  volcanoAshRadius?: number;
  /**
   * Feature layer to write smoke density into: 2 on the rim (about half its
   * slots, at the middle and small tiers), nothing elsewhere — fumaroles, not
   * a wall of cloud. Omit to leave every layer alone. Pair it with a scatter
   * definition on that layer (see `createSmokeGeometry`).
   */
  volcanoSmokeLayer?: number;
  /** Elevation cap. Default 12. */
  elevationMax?: number;
}

/**
 * A dark ash terrain for volcanic slopes, at index 10 so it clears the
 * built-in seven and the showcase liquids. Spread it into a terrain
 * descriptor list and pass its index as `volcanoAshTerrain`.
 */
export const VOLCANIC_ASH_TERRAIN_DESCRIPTOR: TerrainDescriptor = {
  index: 10, id: 'ash', name: 'Volcanic Ash', color: 0x74706d,
  roadColor: [0.30, 0.28, 0.27], roadCost: 3,
  texture: { type: 'procedural', noiseFrequency: 96, secondaryColor: 0x4f4b49, patchFrequency: 30 },
};

/** Land samples competed per placement; the highest wins so cones sit on the ranges. */
const SITE_TRIES = 40;
/** Placements retried when a site lands too close to an earlier cone. */
const PLACE_TRIES = 12;

function randomLandCell(map: HexMap, rand: () => number): { col: number; row: number } | null {
  for (let t = 0; t < SITE_TRIES; t++) {
    const col = Math.floor(rand() * map.width);
    const row = Math.floor(rand() * map.height);
    if (map.getElevation(col, row) >= 0) return { col, row };
  }
  return null;
}

/**
 * Raises volcanic cones over an already-generated, already-biomed landmass:
 * each is a caldera pool ringed by a rim crest, with flanks falling to the
 * ground the cone stands on and an apron of ash feathering out beyond them.
 *
 * Runs **after** biomes so the ash survives the biome pass (which paints
 * every land cell) and **before** rivers, which are told to stop at the pool
 * — a river channel carved across a lava lake is the tell that the order was
 * wrong. Sites prefer high ground, so cones tend to crown the mountain ranges
 * rather than stand on a plain, and the rim is always at least one step above
 * the pool surface so the liquid is contained under the water-surface
 * convention (floor = surface − 1, see `computeWaterSurfaces`).
 *
 * Elevation only ever rises: the cone is laid over the terrain with `max`, so
 * a volcano on a ridge keeps the ridge. The caldera is the one exception —
 * it is dug to exactly two steps below the rim whatever was there.
 *
 * Deterministic for a given map, options, and `rand`; consumes no randomness
 * when `volcanoes` is 0 or unset.
 */
export function applyVolcanoes(map: HexMap, opts: VolcanoOptions, rand: () => number): void {
  const count = opts.volcanoes ?? 0;
  if (count <= 0) return;
  const radius    = Math.max(2, Math.round(opts.volcanoRadius ?? 4));
  const height    = Math.max(2, Math.round(opts.volcanoHeight ?? 5));
  const elevMax   = opts.elevationMax ?? 12;
  const ashIdx    = opts.volcanoAshTerrain ?? TerrainType.Rock;
  const lavaIdx   = opts.volcanoLavaTerrain;
  const ashRadius = Math.max(radius, Math.round(opts.volcanoAshRadius ?? radius * 1.5));
  const smoke     = opts.volcanoSmokeLayer;
  // Caldera radius: a single cell for small cones, growing with the radius.
  const calderaR  = Math.max(1, Math.floor(radius / 3));

  const placed: { col: number; row: number }[] = [];

  for (let v = 0; v < count; v++) {
    // Site: the highest of a handful of land samples, kept clear of earlier cones.
    let site: { col: number; row: number } | null = null;
    for (let attempt = 0; attempt < PLACE_TRIES && !site; attempt++) {
      let best: { col: number; row: number } | null = null;
      let bestElev = -1;
      for (let k = 0; k < 6; k++) {
        const c = randomLandCell(map, rand);
        if (!c) continue;
        const e = map.getElevation(c.col, c.row);
        if (e > bestElev) { bestElev = e; best = c; }
      }
      if (!best) return; // no land at all
      const h = offsetToHex(best.col, best.row);
      const clear = placed.every(p => hexDistance(offsetToHex(p.col, p.row), h) > ashRadius + radius);
      if (clear) site = best;
    }
    if (!site) continue;
    placed.push(site);

    const centre = offsetToHex(site.col, site.row);
    const base   = Math.max(0, map.getElevation(site.col, site.row));
    const rim    = Math.min(elevMax, base + height);
    // Pool surface sits one step under the rim; its floor one under that.
    const poolFloor = rim - 2;

    for (const h of hexRange(centre, ashRadius)) {
      const off = hexToOffset(h);
      if (!map.inBounds(off.col, off.row)) continue;
      const { col, row } = off;
      const d = hexDistance(h, centre);
      const existing = map.getElevation(col, row);
      // Never build into the sea: the apron stops at the coast and the cone
      // does not raise the sea bed. (A caldera at the coast is still dug.)
      if (existing < 0 && d > calderaR) continue;

      if (d <= calderaR) {
        map.setTerrain(col, row, lavaIdx ?? ashIdx);
        map.setElevation(col, row, poolFloor);
        clearFeatures(map, col, row, smoke);
        if (smoke !== undefined) map.setFeatureLevel(col, row, smoke, 0);
        continue;
      }

      if (d === calderaR + 1) {
        // Rim crest: the one ring whose height is exact, not a max.
        map.setTerrain(col, row, ashIdx);
        map.setElevation(col, row, Math.max(existing, rim));
        clearFeatures(map, col, row, smoke);
        if (smoke !== undefined) map.setFeatureLevel(col, row, smoke, 2);
        continue;
      }

      if (d <= radius) {
        // Flanks: a convex profile from the crest down to the base — steep
        // near the top, easing out at the foot, which is the shape scree makes.
        const t    = (d - calderaR - 1) / Math.max(1, radius - calderaR - 1);
        const elev = Math.round(base + (rim - base) * Math.pow(1 - t, 1.6));
        map.setTerrain(col, row, ashIdx);
        map.setElevation(col, row, Math.max(existing, elev));
        clearFeatures(map, col, row, smoke);
        if (smoke !== undefined) map.setFeatureLevel(col, row, smoke, 0);
        continue;
      }

      // Ash apron: terrain only, feathered by distance so the fall-out has a
      // ragged edge rather than a circle. Consumes one draw per cell in a
      // fixed order, so the pattern is seeded.
      const p = 1 - (d - radius) / Math.max(1, ashRadius - radius + 1);
      if (rand() < p) {
        map.setTerrain(col, row, ashIdx);
        clearFeatures(map, col, row, smoke);
      }
    }
  }
}

/** Nothing grows on fresh ash: zero every feature layer except the smoke one. */
function clearFeatures(map: HexMap, col: number, row: number, keep: number | undefined): void {
  for (let layer = 0; layer < map.featureLayerCount; layer++) {
    if (layer === keep) continue;
    map.setFeatureLevel(col, row, layer, 0);
  }
}
