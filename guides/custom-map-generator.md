# Custom Map Generator

The library provides two ways to create a world generator. The **plugin interface** (`MapGeneratorPlugin`) integrates with any UI that lets players cycle generators or adjust settings. The **raw functions** (`simulateClimate`, `assignBiomes`, `generateClimateRivers`, etc.) let you compose only the passes you need, in whatever order you want.

Both approaches work fine together — the built-in `ChunkPlugin` is just a thin wrapper around `generateMap`, which itself is just the raw passes assembled in order.

---

## Option A — Simple plugin (recommended starting point)

Implement `MapGeneratorPlugin<TConfig>` and you get consistent seed handling, a named entry in any plugin registry, and an optional `configSchema` for auto-generated UI controls:

```ts
import type { MapGeneratorPlugin, HexMap } from 'hex-world';
import { makeRng } from 'hex-world';   // mulberry32 PRNG

interface IslandConfig {
  radius:       number;
  borderWater:  number;   // cells of ocean around the edge
}

export const IslandPlugin: MapGeneratorPlugin<IslandConfig> = {
  id:            'island',
  name:          'Island',
  defaultConfig: { radius: 30, borderWater: 8 },

  // Optional: describe fields for a generic settings UI
  configSchema: [
    { key: 'radius',      label: 'Island Radius', type: 'integer', default: 30, min: 10, max: 60 },
    { key: 'borderWater', label: 'Ocean Border',  type: 'integer', default: 8,  min: 2,  max: 20 },
  ],

  generate(map: HexMap, config: IslandConfig, seed: number): void {
    const rand = makeRng(seed);   // deterministic — same seed = same map

    const cx = map.width / 2;
    const cz = map.height / 2;

    map.forEach((col, row) => {
      const dx = col - cx;
      const dz = row - cz;
      const d  = Math.hypot(dx, dz);

      // Noise jitter on the island edge so it isn't a perfect circle
      const jitter = (rand() - 0.5) * config.radius * 0.4;

      if (d > config.radius + jitter || col < config.borderWater ||
          col >= map.width - config.borderWater ||
          row < config.borderWater || row >= map.height - config.borderWater) {
        map.setTerrain(col, row, 5);    // water index
        map.setElevation(col, row, -1);
      } else {
        const elev = Math.round((1 - d / config.radius) * 8);
        map.setTerrain(col, row, 0);    // grassland
        map.setElevation(col, row, elev);
      }
    });
  },
};
```

### Plugin contract

- `generate` receives a **pre-constructed, already-cleared** map. Do not resize or recreate it.
- The same `seed` + `config` + map dimensions must always produce exactly the same result.
- Call `makeRng(seed)` to get a deterministic PRNG; advance it in a fixed order so the sequence is stable.

### Registering in a plugin system

```ts
import { FbmPlugin, ChunkPlugin } from 'hex-world';

const GENERATORS = [FbmPlugin, ChunkPlugin, IslandPlugin];
let currentGenerator = 0;

function regenerate(seed: number): void {
  const gen = GENERATORS[currentGenerator];
  map.clear();
  gen.generate(map, gen.defaultConfig, seed);
  chunks.markAllDirty();   // or rebuild all chunks
}
```

---

## Option B — Composing raw passes

The full-quality pipeline is eight passes run in order. You can pick any subset:

```
RegionLayout → ChunkTerrain → Erosion → ClimateSimulator → TemperatureModel → BiomeAssigner → ClimateRivers → Roads
```

Import the raw functions directly:

```ts
import {
  makeRng,
  createRegions,
  generateChunkTerrain,
  applyErosion,
  simulateClimate,
  computeTemperature,
  assignBiomes,
  generateClimateRivers,
  generateRoads,
} from 'hex-world';
```

### Minimal example — terrain + rivers, no climate

```ts
import { makeRng, createRegions, generateChunkTerrain, applyErosion, generateClimateRivers } from 'hex-world';

function generateSimple(map: HexMap, seed: number): void {
  const rand = makeRng(seed);

  // 1. Decide how many landmass regions and where they sit
  const regions = createRegions(map.width, map.height, { regionCount: 2, landPercentage: 55 }, rand);

  // 2. BFS raise/sink — sets elevation only, no terrain types yet
  generateChunkTerrain(map, regions, { elevationMax: 10 }, rand);

  // 3. Smooth out cliffs by eroding high edges and raising their bases
  applyErosion(map, { erosionPercentage: 40 }, rand);

  // 4. Trace rivers downhill from high-elevation origins
  generateClimateRivers(map, new Float32Array(map.width * map.height).fill(0.5), {
    riverPercentage: 8,
  }, rand);
}
```

### Full pipeline — identical to ChunkPlugin

```ts
import { makeRng, createRegions, generateChunkTerrain, applyErosion,
         simulateClimate, computeTemperature, assignBiomes,
         generateClimateRivers, generateRoads } from 'hex-world';

function generateFull(map: HexMap, seed: number): void {
  const rand    = makeRng(seed);
  const elevMax = 12;

  const regions = createRegions(map.width, map.height, { regionCount: 2, landPercentage: 50 }, rand);
  generateChunkTerrain(map, regions, { elevationMax: elevMax }, rand);
  applyErosion(map, { erosionPercentage: 50 }, rand);

  // Climate — returns per-cell moisture values
  const moisture    = simulateClimate(map, { elevationMax: elevMax });

  // Temperature — returns per-cell temperature values
  const temperature = computeTemperature(map, {
    elevationMax:      elevMax,
    hemisphere:        'both',
    temperatureJitter: 0.1,
    jitterChannel:     Math.floor(rand() * 4),
  });

  // Biomes — sets terrain type and scatter (tree) density per cell
  assignBiomes(map, temperature, moisture, { elevationMax: elevMax });

  // Rivers — origin weight derived from moisture and elevation
  generateClimateRivers(map, moisture, { riverPercentage: 10, elevationMax: elevMax }, rand);

  // Roads — grid of routes avoiding water, rivers, steep slopes
  generateRoads(map, { gridSpacing: 24, maxElevationDiff: 1 });
}
```

---

## Pass reference

### `createRegions` + `generateChunkTerrain`

Controls **shape** of landmasses. Sets elevation only — terrain type is left to `assignBiomes`.

| Option | Default | Notes |
|---|---|---|
| `regionCount` | 1 | 1–4 rectangular sub-regions |
| `landPercentage` | 50 | Target % of cells above sea level |
| `elevationMax` | 12 | Highest elevation step |
| `chunkSizeMin/Max` | 30/100 | BFS raise/sink budget range |
| `jitterProbability` | 0.25 | Edge roughness (0 = smooth, 0.5 = jagged) |
| `sinkProbability` | 0.2 | Frequency of inland sinks/lakes |

### `applyErosion`

Removes isolated cliffs by raising low neighbors of eroded cells. Conserves total landmass.

| Option | Default | Notes |
|---|---|---|
| `erosionPercentage` | 50 | % of erodible cliffs to smooth |

### `simulateClimate`

Runs a water cycle simulation and returns `Float32Array` of per-cell moisture (0–1). High values near water and downwind. Required by `generateClimateRivers` and `assignBiomes`.

| Option | Default | Notes |
|---|---|---|
| `cycles` | 40 | More cycles = more diffused moisture |
| `evaporationFactor` | 0.5 | Ocean evaporation rate |
| `precipitationFactor` | 0.25 | Cloud-to-rain conversion |
| `windDirection` | 2 (NW) | 0=E, 1=NE, 2=NW, 3=W, 4=SW, 5=SE |
| `windStrength` | 4 | Dominant wind weight vs. uniform dispersal |

### `computeTemperature`

Returns `Float32Array` of per-cell temperature (0–1). Cold poles, warm equator, elevation cooling.

| Option | Default | Notes |
|---|---|---|
| `lowTemperature` | 0 | Polar temperature |
| `highTemperature` | 1 | Equatorial temperature |
| `hemisphere` | `'both'` | `'north'` / `'south'` / `'both'` |
| `temperatureJitter` | 0.1 | Noise perturbation |

### `assignBiomes`

Sets terrain type and tree-density feature layer (layer 0) per cell using a 4×4 temperature × moisture matrix. Override the matrix for custom biome distributions.

```ts
import { TerrainType } from 'hex-world';

assignBiomes(map, temperature, moisture, {
  elevationMax: 12,
  // 4 temperature bands (cold→hot) × 4 moisture bands (dry→wet)
  biomeMatrix: [
    [TerrainType.Desert, TerrainType.Snow,      TerrainType.Snow,      TerrainType.Snow],
    [TerrainType.Desert, TerrainType.Mud,       TerrainType.Mud,       TerrainType.Mud],
    [TerrainType.Desert, TerrainType.Grassland, TerrainType.Grassland, TerrainType.Grassland],
    [TerrainType.Desert, TerrainType.Grassland, TerrainType.Grassland, TerrainType.Grassland],
  ],
  treeDensityMatrix: [
    [0, 0, 0, 0],
    [0, 0, 1, 2],
    [0, 0, 1, 2],
    [0, 1, 2, 3],
  ],
  waterTerrainIndex: 5,   // set if using custom water terrain index
});
```

### `generateClimateRivers`

Traces rivers downhill from high-moisture, high-elevation origins. Requires the `moisture` array from `simulateClimate`. If you skip climate simulation, pass a uniform array.

| Option | Default | Notes |
|---|---|---|
| `riverPercentage` | 10 | % of land cells that may have rivers |
| `extraLakeProbability` | 0.25 | Chance of mid-flow lake formation |
| `waterTerrainIndex` | 5 | Terrain index of water cells |

### `generateRoads`

Lays a grid of roads. Stops at water, steep slopes, and rivers.

| Option | Default | Notes |
|---|---|---|
| `gridSpacing` | 24 | Cells between parallel road bands |
| `maxElevationDiff` | 1 | Max slope a road will cross |
| `waterTerrainIndex` | 5 | Also accepts `number[]` for multiple water types |

---

## Tips

**Skipping biome assignment** — If you set terrain types yourself cell-by-cell, skip `assignBiomes`. Just call `map.setTerrain(col, row, idx)` directly.

**Custom water terrain** — Pass `waterTerrainIndex` to `assignBiomes`, `generateClimateRivers`, and `generateRoads` whenever your water terrain is not index 5.

**Seeding scattered effects** — `makeRng` advances linearly; call it in a fixed order and you'll get reproducible results. Calling it a different number of times before a pass will change everything downstream, so add new passes at the end of the sequence.

**Feature layers** — `assignBiomes` writes tree density to layer 0 and rock density to layer 1 when the map has `featureLayerCount >= 2`. If your map has 0 layers, those writes are silently ignored.
