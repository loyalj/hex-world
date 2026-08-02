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
