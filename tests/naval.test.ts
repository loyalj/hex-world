import { describe, it, expect } from 'vitest';
import { HexMap } from '../src/map/HexMap.js';
import { TerrainType } from '../src/map/HexCell.js';
import { createLayout } from '../src/math/HexLayout.js';
import { POINTY_TOP } from '../src/math/HexOrientation.js';
import { offsetToHex, hexToOffset } from '../src/math/HexCoord.js';
import { findPath } from '../src/pathfinding/Pathfinding.js';
import { createDomainCost, isEmbarkStep, isDisembarkStep } from '../src/pathfinding/MovementDomains.js';
import { setPort, isPort, isShoreCell, shoreLiquidNeighbors, listPorts, PORT_KEY } from '../src/gameplay/Ports.js';
import { HexUnit } from '../src/units/HexUnit.js';
import { serializeMap, deserializeMap } from '../src/map/MapSerializer.js';

const isLiquid = (t: number) => t === TerrainType.Water;
const layout   = createLayout(POINTY_TOP, 1);

/**
 * 10×6: columns 0–3 land, columns 4–9 water, except a land island at (8, 2).
 * Row 2 is the lane every straight east–west path uses.
 */
function coast(): HexMap {
  const map = new HexMap({ width: 10, height: 6 });
  map.forEach((c, r) => {
    const land = c <= 3 || (c === 8 && r === 2);
    map.setTerrain(c, r, land ? TerrainType.Grassland : TerrainType.Water);
    map.setElevation(c, r, land ? 1 : -1);
  });
  map.computeWaterSurfaces();
  return map;
}

describe('ports', () => {
  it('only sits on shore', () => {
    const map = coast();
    expect(isShoreCell(map, 3, 2, isLiquid)).toBe(true);
    expect(isShoreCell(map, 0, 2, isLiquid)).toBe(false);   // inland
    expect(isShoreCell(map, 5, 2, isLiquid)).toBe(false);   // water itself
    expect(setPort(map, 0, 2, true, isLiquid)).toBe(false);
    expect(isPort(map, 0, 2)).toBe(false);
    expect(setPort(map, 3, 2, true, isLiquid)).toBe(true);
    expect(isPort(map, 3, 2)).toBe(true);
    expect(shoreLiquidNeighbors(map, 3, 2, isLiquid).length).toBeGreaterThan(0);
    expect(listPorts(map)).toEqual([{ col: 3, row: 2 }]);
    setPort(map, 3, 2, false, isLiquid);
    expect(isPort(map, 3, 2)).toBe(false);
    expect(map.hasCellData(3, 2)).toBe(false);              // the record is dropped, not left empty
  });

  it('rides the metadata channel through serialization', () => {
    const map = coast();
    setPort(map, 3, 2, true, isLiquid);
    const back = deserializeMap(serializeMap(map));
    expect(back.getCellData(3, 2, PORT_KEY)).toBe(true);
    expect(isPort(back, 3, 2)).toBe(true);
  });
});

describe('createDomainCost', () => {
  it('keeps land units off the water and ships off the land', () => {
    const map = coast();
    const land  = createDomainCost({ map, isLiquid, domain: 'land' });
    const naval = createDomainCost({ map, isLiquid, domain: 'naval' });
    expect(land(offsetToHex(3, 2), offsetToHex(4, 2))).toBe(Infinity);
    expect(land(offsetToHex(2, 2), offsetToHex(3, 2))).toBe(1);
    expect(naval(offsetToHex(5, 2), offsetToHex(6, 2))).toBe(1);
    expect(naval(offsetToHex(4, 2), offsetToHex(3, 2))).toBe(Infinity);
    // A ship cannot reach the island without a dock…
    expect(findPath(offsetToHex(5, 2), offsetToHex(8, 2), naval, map)).toBeNull();
    // …and a land unit cannot cross the strait at all.
    expect(findPath(offsetToHex(2, 2), offsetToHex(8, 2), land, map)).toBeNull();
  });

  it('lets a ship dock at a port but not go inland', () => {
    const map = coast();
    setPort(map, 3, 2, true, isLiquid);
    const naval = createDomainCost({ map, isLiquid, domain: 'naval' });
    expect(naval(offsetToHex(4, 2), offsetToHex(3, 2))).toBe(1);          // dock
    expect(naval(offsetToHex(3, 2), offsetToHex(2, 2))).toBe(Infinity);   // no further
    expect(naval(offsetToHex(3, 2), offsetToHex(4, 2))).toBe(1);          // back out
    const noDock = createDomainCost({ map, isLiquid, domain: 'naval', dockAtPorts: false });
    expect(noDock(offsetToHex(4, 2), offsetToHex(3, 2))).toBe(Infinity);
  });

  it('charges an amphibious unit to change domain, at any shore or only at ports', () => {
    const map = coast();
    const anywhere = createDomainCost({ map, isLiquid, domain: 'amphibious', embarkCost: 2 });
    expect(anywhere(offsetToHex(3, 2), offsetToHex(4, 2))).toBe(3);     // embark: 1 + 2
    expect(anywhere(offsetToHex(4, 2), offsetToHex(5, 2))).toBe(1);     // at sea
    expect(anywhere(offsetToHex(7, 2), offsetToHex(8, 2))).toBe(3);     // land on the island
    const path = findPath(offsetToHex(0, 2), offsetToHex(8, 2), anywhere, map);
    expect(path).not.toBeNull();
    expect(hexToOffset(path![path!.length - 1])).toEqual({ col: 8, row: 2 });

    const portsOnly = createDomainCost({ map, isLiquid, domain: 'amphibious', embarkAt: 'ports' });
    expect(portsOnly(offsetToHex(3, 2), offsetToHex(4, 2))).toBe(Infinity);
    setPort(map, 3, 2, true, isLiquid);
    expect(portsOnly(offsetToHex(3, 2), offsetToHex(4, 2))).toBe(2);
    expect(portsOnly(offsetToHex(4, 2), offsetToHex(3, 2))).toBe(2);     // disembark through the same port
    expect(portsOnly(offsetToHex(7, 2), offsetToHex(8, 2))).toBe(Infinity); // the island has no port
  });

  it('delegates prices to the land and naval cost hooks', () => {
    const map = coast();
    const cost = createDomainCost({
      map, isLiquid, domain: 'amphibious', embarkCost: 0,
      landCost:  (col) => col === 1 ? 5 : 1,
      navalCost: (_c, row) => row === 2 ? 0.5 : 4,
    });
    expect(cost(offsetToHex(0, 2), offsetToHex(1, 2))).toBe(5);
    expect(cost(offsetToHex(4, 2), offsetToHex(5, 2))).toBe(0.5);
    expect(cost(offsetToHex(4, 2), offsetToHex(5, 3))).toBe(4);
  });

  it('names the two shoreline steps', () => {
    const map = coast();
    expect(isEmbarkStep(map, isLiquid, { col: 3, row: 2 }, { col: 4, row: 2 })).toBe(true);
    expect(isDisembarkStep(map, isLiquid, { col: 3, row: 2 }, { col: 4, row: 2 })).toBe(false);
    expect(isDisembarkStep(map, isLiquid, { col: 4, row: 2 }, { col: 3, row: 2 })).toBe(true);
    expect(isEmbarkStep(map, isLiquid, { col: 1, row: 2 }, { col: 2, row: 2 })).toBe(false);
  });
});

describe('HexUnit embark transitions', () => {
  it('reports embark and disembark once per crossing, in order, before cellEnter', () => {
    const map  = coast();
    const unit = new HexUnit({ col: 2, row: 2, travelSpeed: 100, domain: 'amphibious', isLiquid });
    const log: string[] = [];
    unit.onEmbark    = (c, r) => log.push(`embark ${c},${r}`);
    unit.onDisembark = (c, r) => log.push(`disembark ${c},${r}`);
    unit.onCellEnter = (c, r) => log.push(`enter ${c},${r}`);

    unit.update(0, map, layout);
    expect(unit.embarked).toBe(false);
    expect(log).toEqual([]);                       // spawning is not a transition

    const cost = createDomainCost({ map, isLiquid, domain: 'amphibious' });
    unit.travel(findPath(offsetToHex(2, 2), offsetToHex(8, 2), cost, map)!);
    unit.update(1, map, layout);                   // speed 100: the whole path in one frame
    expect(unit.isMoving).toBe(false);
    expect(unit.col).toBe(8);
    expect(unit.embarked).toBe(false);
    expect(log.filter(l => l.startsWith('embark'))).toEqual(['embark 4,2']);
    expect(log.filter(l => l.startsWith('disembark'))).toEqual(['disembark 8,2']);
    expect(log.indexOf('embark 4,2')).toBe(log.indexOf('enter 4,2') - 1);
    expect(log.indexOf('disembark 8,2')).toBe(log.indexOf('enter 8,2') - 1);
  });

  it('starts afloat when spawned on water and rides the surface', () => {
    const map  = coast();
    const ship = new HexUnit({ col: 6, row: 2, domain: 'naval', isLiquid });
    ship.update(0, map, layout);
    expect(ship.embarked).toBe(true);
    // Water surface is elevation 0 (+ lift), the sea bed −0.5: a ship floats.
    expect(ship.worldY).toBeGreaterThan(-0.1);
    const walker = new HexUnit({ col: 6, row: 2 });
    walker.update(0, map, layout);
    expect(walker.embarked).toBe(false);
    expect(walker.worldY).toBeLessThan(ship.worldY);
  });
});
