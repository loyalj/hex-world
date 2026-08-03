import type { HexMap } from '../map/HexMap.js';
import { offsetToHex, hexDistance, offsetNeighbor } from '../math/HexCoord.js';
import type { MapRegion } from './RegionLayout.js';

export interface ChunkTerrainOptions {
  /** Target percentage of map cells that will be above water (0–100). Default 50. */
  landPercentage?: number;
  /** Minimum cells in a single raised or sunk chunk. Default 30. */
  chunkSizeMin?: number;
  /** Maximum cells in a single raised or sunk chunk. Default 100. */
  chunkSizeMax?: number;
  /** Probability (0–0.5) that a neighbour's BFS priority is increased by 1 (jitter). Default 0.25. */
  jitterProbability?: number;
  /** Probability that an iteration sinks terrain instead of raising it. Default 0.2. */
  sinkProbability?: number;
  /** Maximum land elevation value. Default 12. */
  elevationMax?: number;
  /** Minimum water elevation value (ocean floor). Default -5. */
  elevationMin?: number;
}

// ---- BFS priority queue (bucket-based, O(1) enqueue/dequeue for small integer priorities) ----

class BucketQueue {
  private readonly buckets: [number, number][][] = [];
  private min = 0;
  count = 0;

  enqueue(col: number, row: number, priority: number): void {
    while (this.buckets.length <= priority) this.buckets.push([]);
    this.buckets[priority].push([col, row]);
    this.count++;
  }

  dequeue(): [number, number] | null {
    while (this.min < this.buckets.length && this.buckets[this.min].length === 0) this.min++;
    if (this.min >= this.buckets.length) return null;
    this.count--;
    return this.buckets[this.min].pop()!;
  }

  clear(): void {
    for (let i = this.min; i < this.buckets.length; i++) this.buckets[i].length = 0;
    this.min = 0;
    this.count = 0;
  }
}

// BFS working state — created per generateChunkTerrain call and reused across
// its raise/sink passes, so concurrent or interleaved generations can't
// corrupt each other's frontier.
interface BfsState {
  frontier:   BucketQueue;
  inFrontier: Set<number>;
}

// ---- Shared BFS setup ----

function initBfs(
  map: HexMap,
  region: MapRegion,
  rand: () => number,
  bfs: BfsState,
): { seedCol: number; seedRow: number; seedHex: ReturnType<typeof offsetToHex> } | null {
  const seedCol = Math.floor(region.colMin + rand() * (region.colMax - region.colMin));
  const seedRow = Math.floor(region.rowMin + rand() * (region.rowMax - region.rowMin));
  if (!map.inBounds(seedCol, seedRow)) return null;

  bfs.frontier.clear();
  bfs.inFrontier.clear();
  const key = seedRow * map.width + seedCol;
  bfs.inFrontier.add(key);
  bfs.frontier.enqueue(seedCol, seedRow, 0);
  return { seedCol, seedRow, seedHex: offsetToHex(seedCol, seedRow) };
}

function expandNeighbors(
  col: number, row: number,
  seedHex: ReturnType<typeof offsetToHex>,
  map: HexMap,
  jitterProb: number,
  rand: () => number,
  bfs: BfsState,
): void {
  for (let d = 0; d < 6; d++) {
    const nb = offsetNeighbor(col, row, d);
    if (!map.inBounds(nb.col, nb.row)) continue;
    const nbKey = nb.row * map.width + nb.col;
    if (bfs.inFrontier.has(nbKey)) continue;
    bfs.inFrontier.add(nbKey);
    const dist   = hexDistance(offsetToHex(nb.col, nb.row), seedHex);
    const jitter = rand() < jitterProb ? 1 : 0;
    bfs.frontier.enqueue(nb.col, nb.row, dist + jitter);
  }
}

// ---- Raise / Sink ----

function raiseTerrain(
  map: HexMap, region: MapRegion, chunkSize: number, budget: number,
  elevMax: number, jitterProb: number, rand: () => number, bfs: BfsState,
): number {
  const seed = initBfs(map, region, rand, bfs);
  if (!seed) return budget;
  const { seedHex } = seed;
  let size = 0;

  while (size < chunkSize && bfs.frontier.count > 0) {
    const [col, row] = bfs.frontier.dequeue()!;
    const oldElev = map.getElevation(col, row);

    if (oldElev < 0) {
      // Water cell: only convert to land if we still have budget
      if (budget <= 0) {
        size++;
        expandNeighbors(col, row, seedHex, map, jitterProb, rand, bfs);
        continue;
      }
      if (oldElev + 1 >= 0) budget--;
    }

    map.setElevation(col, row, Math.min(oldElev + 1, elevMax));
    size++;
    expandNeighbors(col, row, seedHex, map, jitterProb, rand, bfs);
  }
  return budget;
}

function sinkTerrain(
  map: HexMap, region: MapRegion, chunkSize: number, budget: number,
  elevMin: number, jitterProb: number, rand: () => number, bfs: BfsState,
): number {
  const seed = initBfs(map, region, rand, bfs);
  if (!seed) return budget;
  const { seedHex } = seed;
  let size = 0;

  while (size < chunkSize && bfs.frontier.count > 0) {
    const [col, row] = bfs.frontier.dequeue()!;
    const oldElev = map.getElevation(col, row);
    map.setElevation(col, row, Math.max(oldElev - 1, elevMin));

    // Crossed from land to water — return one unit of budget
    if (oldElev >= 0 && oldElev - 1 < 0) budget++;

    size++;
    expandNeighbors(col, row, seedHex, map, jitterProb, rand, bfs);
  }
  return budget;
}

// ---- Public API ----

/**
 * Fills `map` with elevation data using a budget-controlled BFS raise/sink algorithm.
 * Sets only elevation — terrain types must be assigned by the caller afterward.
 * Cells start at elevation -1 (ocean). Land cells end up at elevation ≥ 0.
 */
export function generateChunkTerrain(
  map: HexMap,
  regions: MapRegion[],
  opts: ChunkTerrainOptions,
  rand: () => number,
): void {
  const steps = generateChunkTerrainSteps(map, regions, opts, rand);
  while (!steps.next().done) { /* drain */ }
}

/**
 * Step-generator form of {@link generateChunkTerrain}: yields the fraction of
 * the land budget placed so far (0–1) after each raise/sink round, so async
 * drivers can suspend between rounds. Deterministic — the `rand` call order is
 * identical to the synchronous version.
 */
export function* generateChunkTerrainSteps(
  map: HexMap,
  regions: MapRegion[],
  opts: ChunkTerrainOptions,
  rand: () => number,
): Generator<number, void> {
  const landPercentage = opts.landPercentage    ?? 50;
  const chunkSizeMin   = opts.chunkSizeMin      ?? 30;
  const chunkSizeMax   = opts.chunkSizeMax      ?? 100;
  const jitterProb     = opts.jitterProbability ?? 0.25;
  const sinkProb       = opts.sinkProbability   ?? 0.2;
  const elevMax        = opts.elevationMax      ?? 12;
  const elevMin        = opts.elevationMin      ?? -5;

  // All cells start as shallow ocean
  map.forEach((col, row) => map.setElevation(col, row, -1));

  if (regions.length === 0) return;

  const initialBudget = Math.round(map.width * map.height * landPercentage / 100);
  let budget = initialBudget;
  let bestFraction = 0; // sink rounds refund budget, so report a running max
  const bfs: BfsState = { frontier: new BucketQueue(), inFrontier: new Set<number>() };

  for (let guard = 0; guard < 10000; guard++) {
    const sink = rand() < sinkProb;
    for (const region of regions) {
      const chunkSize = chunkSizeMin + Math.floor(rand() * (chunkSizeMax - chunkSizeMin + 1));
      if (sink) {
        budget = sinkTerrain(map, region, chunkSize, budget, elevMin, jitterProb, rand, bfs);
      } else {
        budget = raiseTerrain(map, region, chunkSize, budget, elevMax, jitterProb, rand, bfs);
        if (budget === 0) return;
      }
    }
    bestFraction = Math.max(bestFraction, initialBudget > 0 ? 1 - budget / initialBudget : 1);
    yield bestFraction;
  }

  // Exited via the iteration cap rather than exhausting the budget — the
  // requested landPercentage could not be placed (usually too high for the
  // map/region configuration). Surface it instead of failing silently.
  console.warn(
    `generateChunkTerrain: iteration cap reached with ${budget} land-budget cells unplaced — ` +
    `landPercentage may be too high for this map/region configuration`,
  );
}
