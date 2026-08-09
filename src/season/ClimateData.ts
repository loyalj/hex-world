import * as THREE from 'three';
import type { HexMap } from '../map/HexMap.js';
import { computeTemperature } from '../generators/TemperatureModel.js';
import type { TemperatureModelOptions } from '../generators/TemperatureModel.js';

/** Magic bytes + version for the `serialize()` blob. "HXCL". */
const CLIMATE_MAGIC = [0x48, 0x58, 0x43, 0x4c];
const CLIMATE_FORMAT_VERSION = 1;
const CLIMATE_HEADER_SIZE = 13; // 4 magic + 1 version + 4 width + 4 height

/** One run of identical (snow, temperature) cells: 4-byte count + 1 byte snow + 1 byte temperature. */
const RUN_SIZE = 6;

function quantize(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
}

/**
 * Per-cell climate state for a hex map, in one GPU-sampled texture.
 *
 * Two tiers, mirroring how {@link FogData} splits live and remembered state.
 * **Base** is the map's static climate — the temperature and moisture fields the
 * generator computed, which never change for a given map. **Seasonal** is the
 * derived state a {@link SeasonCycle} rewrites as the year turns: how deep the
 * snow lies and how cold it has become.
 *
 * The split is what makes seasons cheap. The base fields are written once; the
 * seasonal pass reads them, applies the year's phase, and writes two bytes per
 * cell. Nothing regenerates and no geometry rebuilds.
 *
 * State is stored as a `DataTexture` (RGBA) that shader materials sample by the
 * `cellIndex` attribute every hex-world geometry already carries: **R** = base
 * temperature (0–1), **G** = base moisture (0–1), **B** = snow depth (0–1),
 * **A** = season-adjusted temperature (0–1).
 *
 * Note what is *not* here: whether the water has frozen. Every liquid freezes
 * at its own `freezePoint`, so a single "is frozen" byte could only ever be
 * right about one of them. The season writes the temperature instead and each
 * liquid — and {@link isFrozen} — reads its own answer out of it.
 *
 * The CPU side of every channel is readable through {@link temperature},
 * {@link moisture}, {@link snowDepth} and {@link effectiveTemperature} —
 * deliberately the *same* bytes the shaders sample, so a game's "is this hex
 * snowed in" answer and the white pixels on screen can never drift apart.
 *
 * @example
 * // Generation fills the base fields…
 * const climate = new ClimateData(map.width, map.height);
 * generateMap(map, { climateData: climate }, seed);
 *
 * // …a season cycle derives the rest.
 * seasons.setPhase(0.0);      // midwinter
 * seasons.apply(climate);
 *
 * // Gameplay reads exactly what the player sees.
 * if (climate.snowDepth(col, row) > 0.5) moveCost += 2;
 */
export class ClimateData {
  /** The GPU texture sampled by climate-aware shader materials. */
  readonly texture: THREE.DataTexture;
  readonly width: number;
  readonly height: number;

  private readonly data: Uint8Array; // RGBA (R=base temperature, G=moisture, B=snow, A=season-adjusted temperature)
  private dirty = false;

  /**
   * The options that reproduce the base temperature field, recorded by
   * `generateMap` when it fills this instance (including the `jitterChannel` it
   * picked at random). Save this object — it is tens of bytes — and
   * {@link ClimateData.fromMap} rebuilds the base tier exactly on load, which
   * is why {@link serialize} does not write the dense field.
   *
   * Null when the base fields were supplied some other way.
   */
  temperatureOptions: TemperatureModelOptions | null = null;

  /** Raw RGBA bytes; index as `[(row * width + col) * 4]`. */
  get rawData(): Uint8Array { return this.data; }

  /** True if any channel changed since the last call to {@link update}. */
  get needsUpdate(): boolean { return this.dirty; }

  constructor(width: number, height: number) {
    this.width  = width;
    this.height = height;
    this.data   = new Uint8Array(width * height * 4);

    this.texture = new THREE.DataTexture(this.data, width, height, THREE.RGBAFormat);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
  }

  /**
   * Builds climate for a map by running the same {@link computeTemperature} the
   * generator does. Use this on a loaded or hand-authored map that has no
   * climate attached — pass the *same* options the map was generated with
   * (including `jitterChannel`) and the field comes back bit-identical, which
   * is why the dense temperature field never needs to be saved.
   */
  static fromMap(map: HexMap, opts: TemperatureModelOptions = {}): ClimateData {
    const climate = new ClimateData(map.width, map.height);
    climate.setTemperature(computeTemperature(map, opts));
    climate.temperatureOptions = { ...opts };
    return climate;
  }

  // --- Base fields (written once, at generation time) ---

  /** Writes the base temperature field (0–1, indexed `row * width + col`). */
  setTemperature(field: Float32Array): void {
    this.writeChannel(0, field);
  }

  /** Writes the base moisture field (0–1, indexed `row * width + col`). */
  setMoisture(field: Float32Array): void {
    this.writeChannel(1, field);
  }

  private writeChannel(offset: number, field: Float32Array): void {
    const n = this.width * this.height;
    if (field.length !== n) {
      throw new Error(
        `ClimateData: field has ${field.length} entries but this map is ` +
        `${this.width}×${this.height} (${n} cells)`,
      );
    }
    for (let i = 0; i < n; i++) this.data[i * 4 + offset] = quantize(field[i]);
    this.dirty = true;
  }

  /** Base temperature at a cell, 0 (polar) – 1 (equatorial). Out-of-bounds reads 0. */
  temperature(col: number, row: number): number {
    return this.read(col, row, 0);
  }

  /** Base moisture at a cell, 0–1. Out-of-bounds reads 0. */
  moisture(col: number, row: number): number {
    return this.read(col, row, 1);
  }

  // --- Seasonal state (rewritten by SeasonCycle.apply) ---

  /** Snow lying on a cell, 0 (bare) – 1 (deep). Out-of-bounds reads 0. */
  snowDepth(col: number, row: number): number {
    return this.read(col, row, 2);
  }

  /**
   * The cell's temperature *this season* — base temperature after the year's
   * swing, on the same 0–1 scale. This is what a liquid's `freezePoint` is
   * compared against, and what the shaders read out of the A channel.
   * Out-of-bounds reads 0.
   */
  effectiveTemperature(col: number, row: number): number {
    return this.read(col, row, 3);
  }

  /**
   * Whether a liquid with the given freeze point has frozen at this cell — the
   * gameplay question ("can the caravan cross here?"). Pass the descriptor's
   * `freezePoint`; `undefined` never freezes, matching how the shaders read a
   * negative `uFreezePoint`.
   *
   * @example
   * const water = descriptors.find(d => d.id === 'water');
   * if (climate.isFrozen(col, row, water.freezePoint)) allowCrossing();
   */
  isFrozen(col: number, row: number, freezePoint?: number): boolean {
    if (freezePoint === undefined || freezePoint < 0) return false;
    return this.effectiveTemperature(col, row) <= freezePoint;
  }

  /** Overwrite one cell's snow depth (0–1). Use for scripted or gameplay-driven snow. */
  setSnowDepth(col: number, row: number, depth: number): void {
    this.write(col, row, 2, depth);
  }

  /** Overwrite one cell's season-adjusted temperature (0–1). */
  setEffectiveTemperature(col: number, row: number, value: number): void {
    this.write(col, row, 3, value);
  }

  private read(col: number, row: number, offset: number): number {
    if (col < 0 || col >= this.width || row < 0 || row >= this.height) return 0;
    return this.data[(row * this.width + col) * 4 + offset] / 255;
  }

  private write(col: number, row: number, offset: number, value: number): void {
    if (col < 0 || col >= this.width || row < 0 || row >= this.height) return;
    const idx = (row * this.width + col) * 4 + offset;
    const q = quantize(value);
    if (this.data[idx] === q) return;
    this.data[idx] = q;
    this.dirty = true;
  }

  /**
   * Marks the texture for re-upload. {@link SeasonCycle.apply} calls this for
   * you; call it yourself after a batch of {@link setSnowDepth} writes.
   */
  markDirty(): void {
    this.dirty = true;
  }

  /** Call once per frame before rendering — uploads the texture if anything changed. */
  update(): void {
    if (!this.dirty) return;
    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  // --- Persistence (seasonal tier only) ---

  /**
   * Serializes the seasonal tier — snow depth and season-adjusted temperature —
   * as a run-length blob.
   *
   * The base fields are deliberately *not* written: they are a deterministic
   * function of the map and its {@link TemperatureModelOptions}, so saving the
   * options (tens of bytes) and calling {@link ClimateData.fromMap} on load
   * reproduces them exactly, where the dense field would cost a byte per cell.
   * Snow is genuine runtime state that a campaign accumulates, and both channels
   * run-length well — a summer map collapses to a handful of bytes.
   */
  serialize(): Uint8Array {
    const n = this.width * this.height;
    const runs: number[] = []; // flat triples: count, snow, temperature
    let snow = this.data[2];
    let temp = this.data[3];
    let run  = 0;
    for (let i = 0; i < n; i++) {
      const s = this.data[i * 4 + 2];
      const a = this.data[i * 4 + 3];
      if (s === snow && a === temp) {
        run++;
      } else {
        runs.push(run, snow, temp);
        snow = s; temp = a; run = 1;
      }
    }
    runs.push(run, snow, temp);

    const count = runs.length / 3;
    const out   = new Uint8Array(CLIMATE_HEADER_SIZE + count * RUN_SIZE);
    const view  = new DataView(out.buffer);
    out.set(CLIMATE_MAGIC, 0);
    out[4] = CLIMATE_FORMAT_VERSION;
    view.setUint32(5, this.width,  true);
    view.setUint32(9, this.height, true);
    for (let r = 0; r < count; r++) {
      const at = CLIMATE_HEADER_SIZE + r * RUN_SIZE;
      view.setUint32(at, runs[r * 3], true);
      out[at + 4] = runs[r * 3 + 1];
      out[at + 5] = runs[r * 3 + 2];
    }
    return out;
  }

  /**
   * Restores a seasonal tier written by {@link serialize}, leaving the base
   * temperature and moisture fields untouched.
   *
   * Throws if the blob is not climate data, is a newer format version, or was
   * saved for a differently-sized map.
   */
  load(data: Uint8Array): void {
    if (data.byteLength < CLIMATE_HEADER_SIZE) {
      throw new Error(`ClimateData.load: data too short (${data.byteLength} bytes) to contain a climate header`);
    }
    if (data[0] !== CLIMATE_MAGIC[0] || data[1] !== CLIMATE_MAGIC[1]
      || data[2] !== CLIMATE_MAGIC[2] || data[3] !== CLIMATE_MAGIC[3]) {
      throw new Error('ClimateData.load: invalid magic bytes — not hex-world climate data');
    }
    if (data[4] !== CLIMATE_FORMAT_VERSION) {
      throw new Error(
        `ClimateData.load: unsupported climate format version ${data[4]} ` +
        `(expected ${CLIMATE_FORMAT_VERSION}). Data newer than this library cannot be read — ` +
        `upgrade @loyalj/hex-world.`,
      );
    }
    const view   = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const width  = view.getUint32(5, true);
    const height = view.getUint32(9, true);
    if (width !== this.width || height !== this.height) {
      throw new Error(
        `ClimateData.load: saved climate is for a ${width}×${height} map but this ` +
        `ClimateData is ${this.width}×${this.height}`,
      );
    }

    const n        = width * height;
    const runCount = Math.floor((data.byteLength - CLIMATE_HEADER_SIZE) / RUN_SIZE);
    let cell = 0;
    for (let r = 0; r < runCount; r++) {
      const at   = CLIMATE_HEADER_SIZE + r * RUN_SIZE;
      const len  = view.getUint32(at, true);
      const snow = data[at + 4];
      const temp = data[at + 5];
      if (cell + len > n) {
        throw new Error('ClimateData.load: corrupt run-length data — runs overflow the map');
      }
      for (let i = cell; i < cell + len; i++) {
        this.data[i * 4 + 2] = snow;
        this.data[i * 4 + 3] = temp;
      }
      cell += len;
    }

    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  /** The {@link serialize} blob as base64 text, for JSON saves and `localStorage`. */
  toBase64(): string {
    const data = this.serialize();
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < data.length; i += chunk) {
      binary += String.fromCharCode(...data.subarray(i, Math.min(i + chunk, data.length)));
    }
    return btoa(binary);
  }

  /** Restores the seasonal tier from {@link toBase64} text. See {@link load}. */
  loadBase64(text: string): void {
    const binary = atob(text);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    this.load(data);
  }

  /** Clears the seasonal tier back to bare ground and open water; base fields are kept. */
  clearSeasonal(): void {
    const n = this.width * this.height;
    for (let i = 0; i < n; i++) {
      this.data[i * 4 + 2] = 0;
      this.data[i * 4 + 3] = 0;
    }
    this.dirty = true;
  }

  /** Clears every channel, base fields included. */
  reset(): void {
    this.data.fill(0);
    this.dirty = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
