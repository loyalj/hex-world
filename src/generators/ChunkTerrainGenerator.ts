import type { HexMap } from '../map/HexMap.js';
import { offsetToHex, hexDistance, offsetNeighbor } from '../math/HexCoord.js';
import { fbm } from '../math/Noise.js';
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
  /**
   * Where raise chunks seed. 'uniform' picks anywhere in the region (default);
   * 'accrete' seeks the coast of existing land, so the landmass grows as one
   * coherent body; 'scatter' seeks open water away from existing land, so
   * chunks become separate islands. Sinks under either non-uniform mode seek
   * the coast, so they carve bays instead of deepening open ocean.
   */
  seedPlacement?: 'uniform' | 'accrete' | 'scatter';
  /**
   * Open-water clearance a 'scatter' seed keeps from existing land, in cells.
   * Small values pack islands into dense chains with narrow channels; large
   * values spread them far apart. 0 or unset = one chunk radius (auto).
   */
  scatterGap?: number;
  /**
   * Stretch factor for chunk growth. 1 grows round chunks (default); higher
   * values grow lens-shaped chunks along a random per-chunk axis, which union
   * into elongated, geological-looking landmasses instead of round blobs.
   */
  chunkElongation?: number;
  /**
   * Number of guide curves per region that 'scatter' seeds are sampled along
   * instead of uniformly. Islands then form chains and arcs — the visual
   * signature of real archipelagos. Default 0 (off; plain scatter).
   */
  seedArcs?: number;
  /**
   * Probability (0–1) that a raise round grows a walked chunk sequence — each
   * chunk seeded a step past the last along a drifting heading — instead of a
   * single chunk. Produces peninsulas, capes, and isthmuses reaching out of
   * the landmass. Needs at least one prior chunk to anchor on. Default 0.
   */
  peninsulaProbability?: number;
  /**
   * Amplitude of a shared multi-octave noise field added to the BFS growth
   * priority, in priority steps. All chunks share the field, so their
   * boundaries follow common contours: coasts develop coherent lobes and
   * bights at the low frequency and fractal texture at the higher octaves,
   * instead of the uniform per-cell fuzz jitter alone produces. Default 0.
   */
  coastWarp?: number;
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

// ---- Growth shape (seed placement + chunk elongation) ----

/** Per-generation growth settings, derived once from the options. */
interface GrowthOpts {
  placement:  'uniform' | 'accrete' | 'scatter';
  /** Minimum open-water spokes for a 'scatter' seed, in cells. */
  gap:        number;
  /** How far an 'accrete' seed may land from the previous seed it attaches to. */
  accreteRadius: number;
  elongation: number;
  /** Chance a raise round walks a peninsula instead of placing one chunk. */
  peninsulaProb: number;
  /** Priority-warp noise field: amplitude in priority steps, 0 = off. */
  warpAmp: number;
  /** Noise-space offsets so each generation gets its own warp field. */
  warpOx: number;
  warpOz: number;
}

/** Cell spacing of the warp field's lowest octave; octaves halve from here. */
const WARP_PERIOD = 20;
const WARP_OCTAVES = 3;

/** Chunk seeds already placed in a region — what 'accrete' placement attaches to. */
type SeedHistory = { col: number; row: number }[];

/** A quadratic bezier through a region that 'scatter' seeds are sampled along. */
interface SeedArc {
  x0: number; y0: number;
  cx: number; cy: number;
  x2: number; y2: number;
  /**
   * Number of island slots along the curve. Seeds quantize to these beads —
   * pearls on a string — so chain islands keep their channels by construction
   * instead of relying on the clearance check, whose crowded-corridor fallback
   * would otherwise fuse the chain into a solid ribbon.
   */
  beads: number;
}

/**
 * Lays `count` guide curves across a region: endpoints far apart, control
 * point pushed off the midline so each chain bows like a real island arc.
 * `beadSpacing` is the intended cell distance between chain islands.
 */
function makeSeedArcs(region: MapRegion, count: number, beadSpacing: number, rand: () => number): SeedArc[] {
  const arcs: SeedArc[] = [];
  const w = region.colMax - region.colMin;
  const h = region.rowMax - region.rowMin;
  const minSpan = Math.min(w, h) * 0.5;
  // Bounded attempts: a degenerate region may never yield a long-enough arc,
  // and an empty result just means seeds fall back to plain scatter.
  for (let attempt = 0; attempt < count * 8 && arcs.length < count; attempt++) {
    const x0 = region.colMin + rand() * w;
    const y0 = region.rowMin + rand() * h;
    // Far-apart endpoint: best of three tries.
    let x2 = x0, y2 = y0, best = -1;
    for (let t = 0; t < 3; t++) {
      const px = region.colMin + rand() * w;
      const py = region.rowMin + rand() * h;
      const d = Math.hypot(px - x0, py - y0);
      if (d > best) { best = d; x2 = px; y2 = py; }
    }
    if (best < minSpan) continue;
    const len   = Math.hypot(x2 - x0, y2 - y0);
    const bow   = len * (0.15 + rand() * 0.3) * (rand() < 0.5 ? -1 : 1);
    const perpX = -(y2 - y0) / len;
    const perpY =  (x2 - x0) / len;
    arcs.push({
      x0, y0,
      cx: (x0 + x2) / 2 + perpX * bow,
      cy: (y0 + y2) / 2 + perpY * bow,
      x2, y2,
      beads: Math.max(3, Math.round(len / Math.max(2, beadSpacing))),
    });
  }
  return arcs;
}

/** A point at a random bead of a random arc, with a little scatter so chains stay loose. */
function sampleArc(arcs: SeedArc[], region: MapRegion, rand: () => number): { col: number; row: number } {
  const a = arcs[Math.floor(rand() * arcs.length)];
  const bead = Math.floor(rand() * a.beads);
  const t = (bead + 0.5 + (rand() - 0.5) * 0.4) / a.beads;
  const u = 1 - t;
  const x = u * u * a.x0 + 2 * u * t * a.cx + t * t * a.x2 + (rand() * 2 - 1) * 1.5;
  const y = u * u * a.y0 + 2 * u * t * a.cy + t * t * a.y2 + (rand() * 2 - 1) * 1.5;
  return {
    col: Math.min(region.colMax - 1, Math.max(region.colMin, Math.round(x))),
    row: Math.min(region.rowMax - 1, Math.max(region.rowMin, Math.round(y))),
  };
}

/**
 * Per-chunk growth shape: a stretch axis (identity for round chunks) plus the
 * generation-wide warp field, carried here because this is what the BFS
 * expansion already receives per chunk.
 */
interface ChunkShape {
  elong: number;
  axisX: number;
  axisY: number;
  warpAmp: number;
  warpOx: number;
  warpOz: number;
}

const SQRT3_2 = 0.8660254037844386;

/** How many candidate cells a biased seed pick may sample before settling. */
const SEED_TRIES = 24;

function pickChunkShape(growth: GrowthOpts, rand: () => number): ChunkShape {
  const base = { warpAmp: growth.warpAmp, warpOx: growth.warpOx, warpOz: growth.warpOz };
  if (growth.elongation <= 1) return { ...base, elong: 1, axisX: 1, axisY: 0 };
  // The axis is a line, not a direction, so half a turn covers every case.
  const theta = rand() * Math.PI;
  return { ...base, elong: growth.elongation, axisX: Math.cos(theta), axisY: Math.sin(theta) };
}

/** True if (col, row) is water and the six spokes out to `gap` cells are all water. */
function waterClearance(map: HexMap, col: number, row: number, gap: number): boolean {
  if (map.getElevation(col, row) >= 0) return false;
  for (let d = 0; d < 6; d++) {
    let c = col, r = row;
    for (let s = 0; s < gap; s++) {
      const nb = offsetNeighbor(c, r, d);
      c = nb.col; r = nb.row;
      if (!map.inBounds(c, r)) break;
      if (map.getElevation(c, r) >= 0) return false;
    }
  }
  return true;
}

/**
 * Picks a chunk seed cell under the given placement policy.
 *
 * 'uniform' is a single sample — exactly the pre-placement behavior.
 *
 * 'accrete' attaches to a random previous seed in the region, offset by up to
 * accreteRadius, so the landmass snowballs into one coherent body instead of
 * speckling the whole region. Attaching to seeds rather than probing the map
 * keeps the bias strong from the second chunk on, when land is still far too
 * rare for rejection sampling to find. The first chunk falls back to uniform.
 *
 * 'scatter' rejection-samples for open water clear of existing land — along
 * the region's guide arcs when it has any, uniformly otherwise — settling for
 * the best fallback when the ocean has filled up: generation has to keep
 * moving even when no candidate qualifies.
 */
function pickSeed(
  map: HexMap,
  region: MapRegion,
  placement: 'uniform' | 'accrete' | 'scatter',
  growth: GrowthOpts,
  history: SeedHistory,
  arcs: SeedArc[],
  rand: () => number,
): { col: number; row: number } {
  const uniform = () => ({
    col: Math.floor(region.colMin + rand() * (region.colMax - region.colMin)),
    row: Math.floor(region.rowMin + rand() * (region.rowMax - region.rowMin)),
  });
  // With guide arcs, one candidate in five still samples the open sea: real
  // archipelagos have outlier islets, and it keeps land placeable after the
  // chains fill up — a beads-only sampler stalls the budget on saturated arcs.
  const sample = placement === 'scatter' && arcs.length > 0
    ? () => (rand() < 0.8 ? sampleArc(arcs, region, rand) : uniform())
    : uniform;
  if (placement === 'uniform') return sample();

  if (placement === 'accrete') {
    if (history.length === 0) return sample();
    // Mostly attach near a recent seed, so growth keeps moving outward and the
    // mass wanders into an elongated continent; attaching uniformly over the
    // whole history re-covers the core until it stacks into a max-elevation
    // plateau. The occasional full-history pick back-fills and thickens.
    const window = Math.min(history.length, 10);
    const base = rand() < 0.75
      ? history[history.length - 1 - Math.floor(rand() * window)]
      : history[Math.floor(rand() * history.length)];
    const r     = 1 + rand() * growth.accreteRadius;
    const theta = rand() * 2 * Math.PI;
    return {
      col: Math.min(region.colMax - 1, Math.max(region.colMin, Math.round(base.col + r * Math.cos(theta)))),
      row: Math.min(region.rowMax - 1, Math.max(region.rowMin, Math.round(base.row + r * Math.sin(theta)))),
    };
  }

  let fallback: { col: number; row: number } | null = null;
  let last = sample();
  for (let t = 0; ; t++) {
    const c = last;
    if (map.inBounds(c.col, c.row) && map.getElevation(c.col, c.row) < 0) {
      fallback ??= c;
      if (waterClearance(map, c.col, c.row, growth.gap)) return c;
    }
    if (t >= SEED_TRIES - 1) break;
    last = sample();
  }
  return fallback ?? last;
}

// ---- Shared BFS setup ----

function initBfs(
  map: HexMap,
  seedCol: number,
  seedRow: number,
  bfs: BfsState,
): { seedHex: ReturnType<typeof offsetToHex> } | null {
  if (!map.inBounds(seedCol, seedRow)) return null;

  bfs.frontier.clear();
  bfs.inFrontier.clear();
  const key = seedRow * map.width + seedCol;
  bfs.inFrontier.add(key);
  bfs.frontier.enqueue(seedCol, seedRow, 0);
  return { seedHex: offsetToHex(seedCol, seedRow) };
}

function expandNeighbors(
  col: number, row: number,
  seedHex: ReturnType<typeof offsetToHex>,
  shape: ChunkShape,
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
    const nbHex = offsetToHex(nb.col, nb.row);
    let dist: number;
    if (shape.elong > 1) {
      // Elliptical distance in the hex grid's cartesian frame: compression
      // along the chunk's axis makes the BFS reach further that way.
      const dx = (nbHex.q - seedHex.q) + (nbHex.r - seedHex.r) / 2;
      const dy = (nbHex.r - seedHex.r) * SQRT3_2;
      const along  =  dx * shape.axisX + dy * shape.axisY;
      const across = -dx * shape.axisY + dy * shape.axisX;
      dist = Math.round(Math.hypot(along / shape.elong, across));
    } else {
      dist = hexDistance(nbHex, seedHex);
    }
    if (shape.warpAmp > 0) {
      // Shared field: every chunk reads the same noise, so adjacent chunk
      // boundaries agree on where the coast bulges and where it bites in.
      dist += Math.round(
        fbm((nb.col + shape.warpOx) / WARP_PERIOD, (nb.row + shape.warpOz) / WARP_PERIOD, WARP_OCTAVES)
        * shape.warpAmp,
      );
    }
    const jitter = rand() < jitterProb ? 1 : 0;
    bfs.frontier.enqueue(nb.col, nb.row, Math.max(0, dist + jitter));
  }
}

// ---- Raise / Sink ----

function raiseTerrain(
  map: HexMap, region: MapRegion, chunkSize: number, budget: number,
  elevMax: number, jitterProb: number, growth: GrowthOpts, history: SeedHistory,
  arcs: SeedArc[], rand: () => number, bfs: BfsState,
  forcedSeed?: { col: number; row: number },
): number {
  const at    = forcedSeed ?? pickSeed(map, region, growth.placement, growth, history, arcs, rand);
  const shape = pickChunkShape(growth, rand);
  const seed  = initBfs(map, at.col, at.row, bfs);
  if (!seed) return budget;
  if (growth.placement !== 'uniform') history.push(at);
  const { seedHex } = seed;
  let size = 0;

  while (size < chunkSize && bfs.frontier.count > 0) {
    const [col, row] = bfs.frontier.dequeue()!;
    const oldElev = map.getElevation(col, row);

    if (oldElev < 0) {
      // Water cell: only convert to land if we still have budget
      if (budget <= 0) {
        size++;
        expandNeighbors(col, row, seedHex, shape, map, jitterProb, rand, bfs);
        continue;
      }
      if (oldElev + 1 >= 0) budget--;
    }

    map.setElevation(col, row, Math.min(oldElev + 1, elevMax));
    size++;
    expandNeighbors(col, row, seedHex, shape, map, jitterProb, rand, bfs);
  }
  return budget;
}

function sinkTerrain(
  map: HexMap, region: MapRegion, chunkSize: number, budget: number,
  elevMin: number, jitterProb: number, growth: GrowthOpts, history: SeedHistory,
  rand: () => number, bfs: BfsState,
): number {
  // Under a biased placement, sinks attach to the placed mass: carving bays
  // into land shapes the map, deepening open ocean does not.
  const sinkPlacement = growth.placement === 'uniform' ? 'uniform' : 'accrete';
  const at    = pickSeed(map, region, sinkPlacement, growth, history, [], rand);
  const shape = pickChunkShape(growth, rand);
  const seed  = initBfs(map, at.col, at.row, bfs);
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
    expandNeighbors(col, row, seedHex, shape, map, jitterProb, rand, bfs);
  }
  return budget;
}

/**
 * Grows a sequence of small chunks, each seeded a step past the last along a
 * drifting heading — an arm of land walking out of the mass: a peninsula when
 * it stays attached, a cape or isthmus when the sea gets between the steps.
 * Anchors on a recent chunk seed so it starts at the growing edge.
 */
function walkPeninsula(
  map: HexMap, region: MapRegion, chunkSize: number, budget: number,
  elevMax: number, jitterProb: number, growth: GrowthOpts, history: SeedHistory,
  rand: () => number, bfs: BfsState,
): number {
  const steps    = 3 + Math.floor(rand() * 3);                       // 3–5 chunks
  const stepSize = Math.max(6, Math.floor(chunkSize / steps));
  const stepLen  = Math.max(2, Math.sqrt(stepSize / Math.PI) * 1.6); // just past the last chunk's rim
  const anchor   = history[history.length - 1 - Math.floor(rand() * Math.min(history.length, 6))];
  let theta = rand() * 2 * Math.PI;
  let x = anchor.col, y = anchor.row;

  for (let s = 0; s < steps && budget > 0; s++) {
    x += stepLen * Math.cos(theta);
    y += stepLen * Math.sin(theta);
    theta += (rand() - 0.5) * 0.9; // drift: arms curve, they don't shoot straight
    const seed = {
      col: Math.min(region.colMax - 1, Math.max(region.colMin, Math.round(x))),
      row: Math.min(region.rowMax - 1, Math.max(region.rowMin, Math.round(y))),
    };
    budget = raiseTerrain(map, region, stepSize, budget, elevMax, jitterProb, growth, history, [], rand, bfs, seed);
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
  const chunkRadius = Math.sqrt(chunkSizeMax / Math.PI);
  const warpAmp     = opts.coastWarp ?? 0;
  const growth: GrowthOpts = {
    placement:  opts.seedPlacement ?? 'uniform',
    // Scatter seeds keep open water around them so islands stay islands
    // instead of merging as they grow — by default roughly a chunk radius.
    gap:           opts.scatterGap && opts.scatterGap > 0
                     ? Math.round(opts.scatterGap)
                     : Math.max(2, Math.round(chunkRadius)),
    // Accrete seeds land within ~1.5 chunk radii of a previous seed: enough
    // overlap to stay one mass, enough reach to keep the coastline moving.
    accreteRadius: Math.max(2, Math.round(chunkRadius * 1.5)),
    elongation: opts.chunkElongation ?? 1,
    peninsulaProb: opts.peninsulaProbability ?? 0,
    warpAmp,
    // Offsets drawn only when the field is on, so warp-off generations keep
    // their exact pre-warp rand stream (and therefore their maps).
    warpOx: warpAmp > 0 ? rand() * 1000 : 0,
    warpOz: warpAmp > 0 ? rand() * 1000 : 0,
  };
  const arcsPerRegion: SeedArc[][] = regions.map(r =>
    (opts.seedArcs ?? 0) > 0 && growth.placement === 'scatter'
      ? makeSeedArcs(r, opts.seedArcs!, chunkRadius * 2 + growth.gap, rand)
      : [],
  );

  // All cells start as shallow ocean
  map.forEach((col, row) => map.setElevation(col, row, -1));

  if (regions.length === 0) return;

  const initialBudget = Math.round(map.width * map.height * landPercentage / 100);
  let budget = initialBudget;
  let bestFraction = 0; // sink rounds refund budget, so report a running max
  const bfs: BfsState = { frontier: new BucketQueue(), inFrontier: new Set<number>() };
  const histories: SeedHistory[] = regions.map(() => []);

  for (let guard = 0; guard < 10000; guard++) {
    const sink = rand() < sinkProb;
    for (let ri = 0; ri < regions.length; ri++) {
      const region = regions[ri];
      const chunkSize = chunkSizeMin + Math.floor(rand() * (chunkSizeMax - chunkSizeMin + 1));
      if (sink) {
        budget = sinkTerrain(map, region, chunkSize, budget, elevMin, jitterProb, growth, histories[ri], rand, bfs);
      } else {
        // Short-circuit keeps the rand stream unchanged when walking is off.
        const walk = growth.peninsulaProb > 0 && histories[ri].length > 0 && rand() < growth.peninsulaProb;
        budget = walk
          ? walkPeninsula(map, region, chunkSize, budget, elevMax, jitterProb, growth, histories[ri], rand, bfs)
          : raiseTerrain(map, region, chunkSize, budget, elevMax, jitterProb, growth, histories[ri], arcsPerRegion[ri], rand, bfs);
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
