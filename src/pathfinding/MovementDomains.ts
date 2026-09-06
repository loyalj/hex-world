import type { HexMap } from '../map/HexMap.js';
import { hexToOffset, type HexCoord } from '../math/HexCoord.js';
import type { MoveCostFn } from './Pathfinding.js';
import { isPort, type LiquidPredicate } from '../gameplay/Ports.js';

/**
 * Where a unit can go.
 *
 * - `land` — solid ground only. The default, and what every unit was before
 *   liquids had movement rules.
 * - `naval` — liquid cells only, plus port cells to dock in.
 * - `amphibious` — both, switching between them at the shore (or only at
 *   ports, see {@link DomainCostOptions.embarkAt}) for an extra
 *   {@link DomainCostOptions.embarkCost}.
 */
export type MovementDomain = 'land' | 'naval' | 'amphibious';

export interface DomainCostOptions {
  map: HexMap;
  /** Which terrains float a ship. `HexWorld.isWater` or a `buildWaterTerrainSet` lookup. */
  isLiquid: LiquidPredicate;
  domain: MovementDomain;
  /**
   * Cost of a step onto a land cell, given the destination and the origin.
   * Return `Infinity` for impassable. Default 1 everywhere — the place for
   * terrain, slope, road, and river-ford rules.
   */
  landCost?: (col: number, row: number, from: { col: number; row: number }) => number;
  /** Cost of a step onto a liquid cell. Default 1. Shallow/deep, current, and ice rules go here. */
  navalCost?: (col: number, row: number, from: { col: number; row: number }) => number;
  /**
   * Added to a step that changes domain — land to liquid or back. Default 1.
   * Amphibious units only; ships pay `navalCost` to dock.
   */
  embarkCost?: number;
  /**
   * Where an amphibious unit may cross the shoreline: any shore (`'shore'`,
   * the default) or only through a port cell (`'ports'`).
   */
  embarkAt?: 'shore' | 'ports';
  /** Whether ships may enter port cells. Default true. */
  dockAtPorts?: boolean;
}

/** Whether a cell is liquid or land, as the domain rules see it. */
export function cellDomain(map: HexMap, isLiquid: LiquidPredicate, col: number, row: number): 'liquid' | 'land' {
  return isLiquid(map.getTerrain(col, row)) ? 'liquid' : 'land';
}

/**
 * Build a {@link MoveCostFn} that enforces a movement domain, delegating the
 * per-cell prices to `landCost` / `navalCost`. The returned function is what
 * `findPath`, `getMovementRange`, and `computeFlowField` all take, so one
 * unit type's rules are written once and shared by every search.
 *
 * ```ts
 * const shipCost = createDomainCost({ map, isLiquid: world.isWater, domain: 'naval' });
 * const path = findPath(from, to, shipCost, map);
 * ```
 */
export function createDomainCost(opts: DomainCostOptions): MoveCostFn {
  const { map, isLiquid, domain } = opts;
  const landCost   = opts.landCost  ?? (() => 1);
  const navalCost  = opts.navalCost ?? (() => 1);
  const embarkCost = opts.embarkCost ?? 1;
  const embarkAt   = opts.embarkAt ?? 'shore';
  const docking    = opts.dockAtPorts ?? true;

  return (from: HexCoord, to: HexCoord): number => {
    const t = hexToOffset(to);
    if (!map.inBounds(t.col, t.row)) return Infinity;
    const f = hexToOffset(from);
    const toLiquid   = isLiquid(map.getTerrain(t.col, t.row));
    const fromLiquid = map.inBounds(f.col, f.row) && isLiquid(map.getTerrain(f.col, f.row));

    switch (domain) {
      case 'land':
        return toLiquid ? Infinity : landCost(t.col, t.row, f);

      case 'naval':
        if (toLiquid) return navalCost(t.col, t.row, f);
        // Docking: a ship enters a port cell but goes no further inland, and
        // a docked ship may only put back out to sea.
        if (docking && isPort(map, t.col, t.row) && fromLiquid) return navalCost(t.col, t.row, f);
        return Infinity;

      case 'amphibious': {
        const base = toLiquid ? navalCost(t.col, t.row, f) : landCost(t.col, t.row, f);
        if (toLiquid === fromLiquid) return base;
        if (embarkAt === 'ports') {
          // The land side of the crossing has to be the port.
          const land = toLiquid ? f : t;
          if (!isPort(map, land.col, land.row)) return Infinity;
        }
        return base + embarkCost;
      }
    }
  };
}

/** True when a step from `from` to `to` leaves land for liquid. */
export function isEmbarkStep(map: HexMap, isLiquid: LiquidPredicate, from: { col: number; row: number }, to: { col: number; row: number }): boolean {
  return !isLiquid(map.getTerrain(from.col, from.row)) && isLiquid(map.getTerrain(to.col, to.row));
}

/** True when a step from `from` to `to` leaves liquid for land. */
export function isDisembarkStep(map: HexMap, isLiquid: LiquidPredicate, from: { col: number; row: number }, to: { col: number; row: number }): boolean {
  return isLiquid(map.getTerrain(from.col, from.row)) && !isLiquid(map.getTerrain(to.col, to.row));
}
