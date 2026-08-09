import * as THREE from 'three';

/** Magic bytes + version for the `serialize()` blob. "HXFG". */
const FOG_MAGIC = [0x48, 0x58, 0x46, 0x47];
const FOG_FORMAT_VERSION = 1;
const FOG_HEADER_SIZE = 13; // 4 magic + 1 version + 4 width + 4 height

/**
 * Fog-of-war state for a hex map, with two memory tiers.
 *
 * **Visible** is the live tier: cells currently in some source's sight, tracked
 * with integer reference counts so overlapping units are handled automatically.
 * **Explored** is the memory tier: every cell ever seen, which never decreases.
 * The gap between them is the classic Civ/AoE ghost state — an explored cell
 * still shows its remembered terrain and scatter, dimmed, while anything
 * transient there (see `UnitManager`'s `hideUnitsInFog`) is hidden until a
 * source sees it again.
 *
 * The state is stored as a `DataTexture` (RGBA) that shader materials sample
 * at runtime: **R channel** = currently visible (0 or 255), **G channel** =
 * ever explored (0 or 255, never decreases), **B channel** = reveal animation
 * progress (0→255 over `revealDuration` seconds when a cell is first explored).
 *
 * Pass the instance to `ChunkManager` and `UnitManager` at construction time.
 * Call `reset()` to wipe all state (e.g. new game), then `UnitManager.reapplyFog()`
 * to restore unit reveal contributions.
 *
 * The memory tier persists across sessions: {@link serialize} writes a compact
 * run-length-encoded blob of the explored set (and {@link toBase64} the same
 * blob as text for JSON or `localStorage`). Visibility is deliberately *not*
 * saved — it is derived state, rebuilt by `UnitManager.reapplyFog()` once the
 * units are back in place.
 *
 * @example
 * // Save alongside the map…
 * localStorage.setItem('fog', fogData.toBase64());
 * // …and restore on the next session.
 * fogData.loadBase64(localStorage.getItem('fog')!);
 * unitManager.reapplyFog();
 */
export class FogData {
  /** The GPU texture sampled by all fog-aware shader materials. */
  readonly texture: THREE.DataTexture;
  readonly width: number;
  readonly height: number;
  /** Seconds for a newly-explored cell to fade from invisible to fully visible. */
  readonly revealDuration: number;

  private readonly visibility: Uint8Array;      // count per cell
  private readonly data: Uint8Array;             // RGBA bytes for DataTexture (R=visible, G=explored, B=revealProgress)
  private readonly revealProgress: Float32Array; // 0→1 animation progress per cell
  private readonly animating = new Set<number>();
  private dirty = false;

  /** Raw RGBA bytes; index as [flatCellIndex * 4], R channel = visibility (0 or 255). */
  get rawData(): Uint8Array { return this.data; }

  /** True if visibility changed since the last call to update(). */
  get needsUpdate(): boolean { return this.dirty; }

  /** True while any cells still have in-progress reveal animations. */
  get isAnimating(): boolean { return this.animating.size > 0; }

  constructor(width: number, height: number, revealDuration = 0.5) {
    this.width = width;
    this.height = height;
    this.revealDuration = revealDuration;
    this.visibility = new Uint8Array(width * height);
    this.data = new Uint8Array(width * height * 4);
    this.revealProgress = new Float32Array(width * height);

    this.texture = new THREE.DataTexture(this.data, width, height, THREE.RGBAFormat);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
  }

  /**
   * Increments the visibility reference count for a cell.
   * When the count goes from 0 → 1 the cell becomes visible (R=255) and
   * permanently explored (G=255). Call once per visibility-granting source
   * (unit, ability, etc.) that covers this cell.
   */
  increaseVisibility(col: number, row: number): void {
    const idx = row * this.width + col;
    const prev = this.visibility[idx];
    this.visibility[idx] = Math.min(255, prev + 1);
    if (prev === 0) {
      this.data[idx * 4] = 255;     // R = currently visible
      const wasExplored = this.data[idx * 4 + 1] === 255;
      this.data[idx * 4 + 1] = 255; // G = explored (stays 255 once set)
      if (!wasExplored) {
        // First time this cell is explored — start reveal fade-in via B channel
        this.revealProgress[idx] = this.revealDuration > 0 ? 0 : 1;
        this.data[idx * 4 + 2] = this.revealDuration > 0 ? 0 : 255;
        if (this.revealDuration > 0) this.animating.add(idx);
      }
      this.dirty = true;
    }
  }

  /**
   * Decrements the visibility reference count for a cell.
   * When the count reaches 0 the cell becomes not-visible (R=0) but remains
   * explored (G stays 255). Pair every `increaseVisibility` call with a
   * corresponding `decreaseVisibility` when the source moves away or is removed.
   */
  decreaseVisibility(col: number, row: number): void {
    const idx = row * this.width + col;
    const prev = this.visibility[idx];
    if (prev === 0) return;
    this.visibility[idx] = prev - 1;
    if (prev === 1) {
      this.data[idx * 4] = 0; // R = no longer visible; G stays 255 (explored)
      this.dirty = true;
    }
  }

  // --- Memory tier queries ---

  /**
   * True if the cell is *currently* in some source's sight (the live tier).
   * Out-of-bounds cells read as not visible.
   */
  isVisible(col: number, row: number): boolean {
    if (col < 0 || col >= this.width || row < 0 || row >= this.height) return false;
    return this.visibility[row * this.width + col] > 0;
  }

  /**
   * True if the cell has *ever* been seen (the memory tier). Explored cells
   * keep showing their remembered terrain and scatter after the last source
   * moves away; use {@link isVisible} to decide whether transient things
   * (units, current stockpiles) should be drawn there.
   * Out-of-bounds cells read as not explored.
   */
  isExplored(col: number, row: number): boolean {
    if (col < 0 || col >= this.width || row < 0 || row >= this.height) return false;
    return this.data[(row * this.width + col) * 4 + 1] === 255;
  }

  /** Number of sources currently granting sight of the cell (0 when not visible). */
  visibilityCount(col: number, row: number): number {
    if (col < 0 || col >= this.width || row < 0 || row >= this.height) return 0;
    return this.visibility[row * this.width + col];
  }

  /** How many cells have ever been explored — the "% of world discovered" stat. */
  get exploredCount(): number {
    let n = 0;
    for (let i = 0; i < this.width * this.height; i++) {
      if (this.data[i * 4 + 1] === 255) n++;
    }
    return n;
  }

  /**
   * Marks a cell explored without granting visibility — the memory tier only.
   * Use for scripted reveals (a map fragment, a scouting report) and for
   * restoring saved exploration. No-op for out-of-bounds cells and for cells
   * already explored.
   *
   * @param animate Play the reveal fade-in. Default `false`, which is what you
   *   want when restoring a save — remembered cells should already be there,
   *   not fade in as if just discovered.
   */
  markExplored(col: number, row: number, animate = false): void {
    if (col < 0 || col >= this.width || row < 0 || row >= this.height) return;
    const idx = row * this.width + col;
    if (this.data[idx * 4 + 1] === 255) return;
    this.data[idx * 4 + 1] = 255;
    const fade = animate && this.revealDuration > 0;
    this.revealProgress[idx] = fade ? 0 : 1;
    this.data[idx * 4 + 2] = fade ? 0 : 255;
    if (fade) this.animating.add(idx);
    this.dirty = true;
  }

  /**
   * Takes a cell back to never-seen: clears exploration, any in-progress
   * reveal animation, and the visibility count that would immediately
   * re-explore it. The inverse of {@link markExplored}, for authoring tools
   * and scripted "you forget this place" effects — normal play never needs it,
   * since the memory tier only ever grows.
   *
   * Any live sight source still standing here re-reveals the cell as soon as
   * it reports in; clear or move the source too if the cell should stay dark.
   * No-op for out-of-bounds cells and for cells that were never explored.
   */
  unexplore(col: number, row: number): void {
    if (col < 0 || col >= this.width || row < 0 || row >= this.height) return;
    const idx = row * this.width + col;
    if (this.data[idx * 4 + 1] === 0 && this.visibility[idx] === 0) return;
    this.visibility[idx]     = 0;
    this.data[idx * 4]       = 0; // R: not visible
    this.data[idx * 4 + 1]   = 0; // G: not explored
    this.data[idx * 4 + 2]   = 0; // B: reveal progress
    this.revealProgress[idx] = 0;
    this.animating.delete(idx);
    this.dirty = true;
  }

  // --- Persistence (memory tier only) ---

  /**
   * Serializes the explored set to a compact blob: a 13-byte header followed by
   * run-length pairs over the cells in row-major order. Fully-explored and
   * untouched maps both collapse to a handful of bytes.
   *
   * Only the memory tier is written. Visibility is derived state — restore it
   * with `UnitManager.reapplyFog()` after the units are positioned.
   */
  serialize(): Uint8Array {
    const n = this.width * this.height;
    // Runs of equal explored-ness, each stored as a u32 length. The first run is
    // "not explored" (possibly zero-length), then they alternate.
    const runs: number[] = [];
    let current = 0; // 0 = unexplored, 1 = explored
    let run = 0;
    for (let i = 0; i < n; i++) {
      const explored = this.data[i * 4 + 1] === 255 ? 1 : 0;
      if (explored === current) {
        run++;
      } else {
        runs.push(run);
        current = explored;
        run = 1;
      }
    }
    runs.push(run);

    const out  = new Uint8Array(FOG_HEADER_SIZE + runs.length * 4);
    const view = new DataView(out.buffer);
    out[0] = FOG_MAGIC[0]; out[1] = FOG_MAGIC[1]; out[2] = FOG_MAGIC[2]; out[3] = FOG_MAGIC[3];
    out[4] = FOG_FORMAT_VERSION;
    view.setUint32(5, this.width,  true);
    view.setUint32(9, this.height, true);
    for (let i = 0; i < runs.length; i++) view.setUint32(FOG_HEADER_SIZE + i * 4, runs[i], true);
    return out;
  }

  /**
   * Restores an explored set written by {@link serialize}, replacing the current
   * memory tier. Visibility counts are cleared — call `UnitManager.reapplyFog()`
   * afterwards to rebuild the live tier from where the units actually are.
   * Restored cells skip the reveal animation.
   *
   * Throws if the blob is not fog data, is a newer format version, or was saved
   * for a differently-sized map.
   */
  load(data: Uint8Array): void {
    if (data.byteLength < FOG_HEADER_SIZE) {
      throw new Error(`FogData.load: data too short (${data.byteLength} bytes) to contain a fog header`);
    }
    if (data[0] !== FOG_MAGIC[0] || data[1] !== FOG_MAGIC[1]
      || data[2] !== FOG_MAGIC[2] || data[3] !== FOG_MAGIC[3]) {
      throw new Error('FogData.load: invalid magic bytes — not hex-world fog data');
    }
    if (data[4] !== FOG_FORMAT_VERSION) {
      throw new Error(
        `FogData.load: unsupported fog format version ${data[4]} (expected ${FOG_FORMAT_VERSION}). ` +
        `Data newer than this library cannot be read — upgrade @loyalj/hex-world.`,
      );
    }
    const view   = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const width  = view.getUint32(5, true);
    const height = view.getUint32(9, true);
    if (width !== this.width || height !== this.height) {
      throw new Error(
        `FogData.load: saved fog is for a ${width}×${height} map but this ` +
        `FogData is ${this.width}×${this.height}`,
      );
    }

    this.reset();

    const n        = width * height;
    const runCount = (data.byteLength - FOG_HEADER_SIZE) >> 2;
    let cell    = 0;
    let explored = false; // runs alternate, starting with unexplored
    for (let r = 0; r < runCount; r++) {
      const len = view.getUint32(FOG_HEADER_SIZE + r * 4, true);
      if (cell + len > n) {
        throw new Error('FogData.load: corrupt run-length data — runs overflow the map');
      }
      if (explored) {
        for (let i = cell; i < cell + len; i++) {
          this.data[i * 4 + 1] = 255; // G = explored
          this.data[i * 4 + 2] = 255; // B = fully revealed, no fade-in
          this.revealProgress[i] = 1;
        }
      }
      cell += len;
      explored = !explored;
    }

    this.texture.needsUpdate = true;
    // Left dirty so ChunkManager.update() refreshes scatter visibility from the
    // restored memory tier on the next frame.
    this.dirty = true;
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

  /** Restores exploration from {@link toBase64} text. See {@link load}. */
  loadBase64(text: string): void {
    const binary = atob(text);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    this.load(data);
  }

  /** Call once per frame before rendering. Advances reveal animations and uploads dirty texture data to GPU. */
  update(dt = 0): void {
    if (dt > 0 && this.animating.size > 0) {
      const step = dt / this.revealDuration;
      for (const idx of this.animating) {
        this.revealProgress[idx] = Math.min(1, this.revealProgress[idx] + step);
        this.data[idx * 4 + 2] = Math.round(this.revealProgress[idx] * 255);
        if (this.revealProgress[idx] >= 1) this.animating.delete(idx);
      }
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  /** Reset all visibility and exploration state, including any in-progress reveal animations. */
  reset(): void {
    this.visibility.fill(0);
    this.data.fill(0);
    this.revealProgress.fill(0);
    this.animating.clear();
    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
