import * as THREE from 'three';

export class FogData {
  readonly texture: THREE.DataTexture;
  readonly width: number;
  readonly height: number;

  private readonly visibility: Uint8Array;   // count per cell
  private readonly data: Uint8Array;          // RGBA bytes for DataTexture
  private dirty = false;

  /** Raw RGBA bytes; index as [flatCellIndex * 4], R channel = visibility (0 or 255). */
  get rawData(): Uint8Array { return this.data; }

  /** True if visibility changed since the last call to update(). */
  get needsUpdate(): boolean { return this.dirty; }

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.visibility = new Uint8Array(width * height);
    this.data = new Uint8Array(width * height * 4);

    this.texture = new THREE.DataTexture(this.data, width, height, THREE.RGBAFormat);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
  }

  increaseVisibility(col: number, row: number): void {
    const idx = row * this.width + col;
    const prev = this.visibility[idx];
    this.visibility[idx] = Math.min(255, prev + 1);
    if (prev === 0) {
      this.data[idx * 4] = 255;     // R = currently visible
      this.data[idx * 4 + 1] = 255; // G = explored (stays 255 once set)
      this.dirty = true;
    }
  }

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

  /** Call once per frame before rendering. Uploads dirty texture data to GPU. */
  update(): void {
    if (!this.dirty) return;
    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  /** Reset all visibility and exploration state. */
  reset(): void {
    this.visibility.fill(0);
    this.data.fill(0);
    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
