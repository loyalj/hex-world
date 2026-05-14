import * as THREE from 'three';

/**
 * Fog-of-war state for a hex map.
 *
 * Maintains per-cell visibility using integer reference counts so multiple
 * overlapping sources (e.g. several units) are handled automatically.
 * The state is stored as a `DataTexture` (RGBA) that shader materials sample
 * at runtime: **R channel** = currently visible (0 or 255), **G channel** =
 * ever explored (0 or 255, never decreases), **B channel** = reveal animation
 * progress (0→255 over `revealDuration` seconds when a cell is first explored).
 *
 * Pass the instance to `ChunkManager` and `UnitManager` at construction time.
 * Call `reset()` to wipe all state (e.g. new game), then `UnitManager.reapplyFog()`
 * to restore unit reveal contributions.
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
