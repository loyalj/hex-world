import { describe, it, expect } from 'vitest';
import { HexMap } from '../src/map/HexMap.js';
import {
  serializeMap, deserializeMap, serializeMapJSON, deserializeMapJSON,
} from '../src/map/MapSerializer.js';

function makeMap(): HexMap {
  const m = new HexMap({ width: 20, height: 15, featureLayerCount: 2 });
  m.setTerrain(3, 4, 5); m.setElevation(3, 4, -2);
  m.setTerrain(7, 7, 2); m.setElevation(7, 7, 6);
  m.setRoad(5, 5, 2, true);
  m.setFeatureLevel(6, 6, 1, 3);
  m.setRiverOutgoing(8, 8, 4); m.setRiverIncoming(8, 8, 1);
  return m;
}

describe('binary serialization', () => {
  it('round-trips cell, road, feature, and river data', () => {
    const m = makeMap();
    const m2 = deserializeMap(serializeMap(m));
    expect(m2.getTerrain(3, 4)).toBe(5);
    expect(m2.getElevation(3, 4)).toBe(-2);
    expect(m2.getElevation(7, 7)).toBe(6);
    expect(m2.hasRoadThroughEdge(5, 5, 2)).toBe(true);
    expect(m2.getFeatureLevel(6, 6, 1)).toBe(3);
    expect(m2.getOutgoingRiverDir(8, 8)).toBe(4);
    expect(m2.getIncomingRiverDir(8, 8)).toBe(1);
  });

  it('throws on truncated data instead of silently zero-filling', () => {
    const bin = serializeMap(makeMap());
    expect(() => deserializeMap(bin.slice(0, bin.length - 10))).toThrow(/truncated/);
    expect(() => deserializeMap(bin.slice(0, 10))).toThrow(/too short/);
  });

  it('throws on bad magic bytes', () => {
    const bin = serializeMap(makeMap());
    bin[0] = 0x00;
    expect(() => deserializeMap(bin)).toThrow(/magic/);
  });

  it('throws on out-of-range versions with an informative message', () => {
    const bin = serializeMap(makeMap());
    bin[4] = 99;
    expect(() => deserializeMap(bin)).toThrow(/unsupported version 99/);
    bin[4] = 0;
    expect(() => deserializeMap(bin)).toThrow(/unsupported version 0/);
  });

  it('throws on a corrupt header instead of allocating an implausible map', () => {
    const bin = serializeMap(makeMap());
    new DataView(bin.buffer, bin.byteOffset).setUint32(5, 0x7fffffff, true);
    expect(() => deserializeMap(bin)).toThrow(/implausible/);
  });

  it('round-trips per-cell metadata through the trailer', () => {
    const m = makeMap();
    m.setCellData(3, 4, 'owner', 'clan-red');
    m.setCellData(3, 4, 'yield', { food: 2, ore: 1 });
    m.setCellData(9, 9, 'grazed', true);
    const r = deserializeMap(serializeMap(m));
    expect(r.getCellData(3, 4, 'owner')).toBe('clan-red');
    expect(r.getCellData(3, 4, 'yield')).toEqual({ food: 2, ore: 1 });
    expect(r.getCellData(9, 9, 'grazed')).toBe(true);
    expect(r.cellData.size).toBe(2);
  });

  it('throws on a truncated cell metadata trailer', () => {
    const m = makeMap();
    m.setCellData(3, 4, 'owner', 'clan-red');
    const bin = serializeMap(m);
    expect(() => deserializeMap(bin.slice(0, bin.length - 5))).toThrow(/truncated cell metadata/);
  });
});

describe('v2 → v3 migration (cell metadata)', () => {
  it('migrates v2 binary files to an empty metadata store', () => {
    const m = makeMap();
    const cur = serializeMap(m);
    // Reconstruct the v2 layout: strip the metadata trailer, set version 2.
    const v2 = cur.slice(0, cur.length - 4);
    v2[4] = 2;
    const loaded = deserializeMap(v2);
    expect(loaded.cellData.size).toBe(0);
    expect(loaded.getTerrain(3, 4)).toBe(5);
    expect(loaded.getIncomingRiverDir(8, 8)).toBe(1);
  });

  it('migrates v2 JSON files to an empty metadata store', () => {
    const p = JSON.parse(serializeMapJSON(makeMap()));
    delete p.cellData;
    p.version = 2;
    const loaded = deserializeMapJSON(JSON.stringify(p)).map;
    expect(loaded.cellData.size).toBe(0);
    expect(loaded.getTerrain(3, 4)).toBe(5);
  });
});

describe('JSON serialization', () => {
  it('round-trips cells and metadata (auto-stamping createdAt)', () => {
    const m = makeMap();
    const json = serializeMapJSON(m, { name: 'T', seed: 42, author: 'me', tags: ['a'] });
    const r = deserializeMapJSON(json);
    expect(r.map.getTerrain(3, 4)).toBe(5);
    expect(r.map.getElevation(7, 7)).toBe(6);
    expect(r.metadata.name).toBe('T');
    expect(r.metadata.seed).toBe(42);
    expect(r.metadata.author).toBe('me');
    expect(r.metadata.tags).toEqual(['a']);
    expect(r.metadata.createdAt).toBeTruthy();
  });

  it('throws when cell data size does not match declared dimensions', () => {
    const json = serializeMapJSON(makeMap());
    const p = JSON.parse(json);
    p.width = 21;
    expect(() => deserializeMapJSON(JSON.stringify(p))).toThrow(/cell data/);
  });

  it('throws on out-of-range versions', () => {
    const json = serializeMapJSON(makeMap());
    const p = JSON.parse(json);
    p.version = 0;
    expect(() => deserializeMapJSON(JSON.stringify(p))).toThrow(/unsupported version/);
  });

  it('round-trips per-cell metadata', () => {
    const m = makeMap();
    m.setCellData(3, 4, 'owner', 'clan-red');
    m.setCellData(3, 4, 'yield', { food: 2, ore: 1 });
    m.setCellData(9, 9, 'grazed', true);
    const r = deserializeMapJSON(serializeMapJSON(m)).map;
    expect(r.getCellData(3, 4, 'owner')).toBe('clan-red');
    expect(r.getCellData(3, 4, 'yield')).toEqual({ food: 2, ore: 1 });
    expect(r.getCellData(9, 9, 'grazed')).toBe(true);
    expect(r.cellData.size).toBe(2);
  });

  it('omits the cellData field when the store is empty', () => {
    const p = JSON.parse(serializeMapJSON(makeMap()));
    expect('cellData' in p).toBe(false);
  });

  it('throws on out-of-range cell metadata indices', () => {
    const p = JSON.parse(serializeMapJSON(makeMap()));
    p.cellData = { '99999': { a: 1 } };
    expect(() => deserializeMapJSON(JSON.stringify(p))).toThrow(/out of range/);
  });

  it('accepts descriptor sets positionally or as an object', () => {
    const m = makeMap();
    const terrain = [
      { index: 9, id: 'goo', name: 'Goo', color: 0x00ff00, liquidType: 'goo', texture: { type: 'procedural' as const } },
    ];
    const scatter = [
      { id: 'pine', name: 'Pine', layerIndex: 0, tiers: [[{ assetId: 'pine-lg', yOffset: 1 }]] },
    ];
    const liquid = [{ id: 'goo', name: 'Goo', color: 0x00ff00 }];

    // Legacy positional form (scatter, terrain, liquid).
    const positional = deserializeMapJSON(serializeMapJSON(m, {}, scatter, terrain, liquid));
    expect(positional.scatterDescriptors[0].id).toBe('pine');
    expect(positional.terrainDescriptors[0].id).toBe('goo');
    expect(positional.liquidDescriptors[0].id).toBe('goo');

    // Object form — the only way to carry resources and factions.
    const object = deserializeMapJSON(serializeMapJSON(m, {}, {
      scatterDescriptors:  scatter,
      terrainDescriptors:  terrain,
      liquidDescriptors:   liquid,
      resourceDescriptors: [{ id: 'ore', name: 'Ore', color: 0xb0b6c0 }],
      factions:            [{ id: 'red', name: 'Kelmar', color: 0xff0000 }],
    }));
    expect(object.scatterDescriptors[0].id).toBe('pine');
    expect(object.resourceDescriptors[0].id).toBe('ore');
    expect(object.factions[0].name).toBe('Kelmar');
  });

  it('defaults resource and faction sets to empty for maps without them', () => {
    const r = deserializeMapJSON(serializeMapJSON(makeMap()));
    expect(r.resourceDescriptors).toEqual([]);
    expect(r.factions).toEqual([]);
  });

  it('rebuilds the isWater predicate from embedded terrain descriptors', () => {
    const m = new HexMap({ width: 8, height: 8 });
    m.setTerrain(2, 2, 9); m.setElevation(2, 2, -1); // custom liquid index
    const json = serializeMapJSON(m, {}, undefined, [
      { index: 9, id: 'goo', name: 'Goo', color: 0x00ff00, liquidType: 'goo', texture: { type: 'procedural' } },
    ]);
    const r = deserializeMapJSON(json);
    expect(r.map.getWaterSurface(2, 2)).toBe(0);
    expect(r.terrainDescriptors[0].id).toBe('goo');
  });
});
