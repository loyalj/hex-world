import * as THREE from 'three';
import { TerrainType } from '../map/HexCell.js';
import { TERRAIN_COLORS } from './HexChunk.js';
import { sampleNoise } from '../math/Noise.js';

/**
 * An image source for overriding a single terrain type's texture.
 * - string: URL fetched and decoded via createImageBitmap
 * - HTMLImageElement / ImageBitmap: blitted directly onto a canvas
 */
export type TerrainTextureSource = string | HTMLImageElement | ImageBitmap;

export interface TerrainTextureArrayOptions {
  /** Resolution of each square texture slice in pixels. Default 256. */
  size?: number;
  /** Noise frequency (larger = finer detail). Default 10. */
  noiseFrequency?: number;
  /** Strength of the noise overlay (0 = solid color, 1 = full range). Default 0.45. */
  noiseStrength?: number;
  /**
   * Per-terrain-type image overrides. TerrainType values without an entry
   * are filled with procedural noise derived from TERRAIN_COLORS.
   */
  overrides?: Partial<Record<TerrainType, TerrainTextureSource>>;
}

const TERRAIN_COUNT = 6; // TerrainType values 0–5

/**
 * Build a DataArrayTexture (one 2-D slice per TerrainType).
 * Async because URL-based override sources require a network fetch.
 * Slices without overrides are generated procedurally using sampleNoise.
 */
export async function buildTerrainTextureArray(
  opts: TerrainTextureArrayOptions = {},
): Promise<THREE.DataArrayTexture> {
  const size          = opts.size          ?? 256;
  const noiseFreq     = opts.noiseFrequency ?? 128;
  const noiseStrength = opts.noiseStrength  ?? 0.13;
  const overrides     = opts.overrides      ?? {};

  // Resolve all override sources to ImageBitmap (or null = use noise).
  const bitmaps: (ImageBitmap | null)[] = await Promise.all(
    Array.from({ length: TERRAIN_COUNT }, async (_, type) => {
      const src = overrides[type as TerrainType];
      if (!src) return null;
      if (typeof src === 'string') {
        const resp = await fetch(src);
        const blob = await resp.blob();
        return createImageBitmap(blob, { resizeWidth: size, resizeHeight: size });
      }
      if (src instanceof HTMLImageElement) {
        return createImageBitmap(src, { resizeWidth: size, resizeHeight: size });
      }
      return src as ImageBitmap;
    }),
  );

  // One RGBA canvas we reuse to read pixel data from bitmaps.
  const canvas = document.createElement('canvas');
  canvas.width  = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const data = new Uint8Array(size * size * TERRAIN_COUNT * 4);

  for (let type = 0; type < TERRAIN_COUNT; type++) {
    const offset = type * size * size * 4;
    const bmp    = bitmaps[type];

    if (bmp) {
      // User-supplied image: blit to canvas, read pixels.
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(bmp, 0, 0, size, size);
      const imgData = ctx.getImageData(0, 0, size, size);
      data.set(imgData.data, offset);
    } else {
      // Procedural: base color + 3-octave noise brightness modulation.
      // Each terrain type gets a unique spatial offset so the patterns look distinct.
      const base = TERRAIN_COLORS[type as TerrainType];
      const baseR = Math.round(base.r * 255);
      const baseG = Math.round(base.g * 255);
      const baseB = Math.round(base.b * 255);
      // Prime-spaced offsets keep terrain types visually independent.
      const ox = type * 47.3;
      const oy = type * 31.7;

      const typeFreq = type === 1 /* Desert */ ? 256 : type === 4 /* Rock */ ? 64 : noiseFreq;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const nx = ox + (x / size) * typeFreq;
          const ny = oy + (y / size) * typeFreq;

          // Three octaves: coarse, medium, fine.
          const n0 = sampleNoise(nx,        ny       );
          const n1 = sampleNoise(nx * 2.3,  ny * 2.3 );
          const n2 = sampleNoise(nx * 5.1,  ny * 5.1 );
          const raw = (n0[0] + n1[0] * 0.5 + n2[0] * 0.25) / 1.75; // 0..1
          const brightness = (raw * 2 - 1) * noiseStrength;

          const i = (y * size + x) * 4 + offset;
          data[i + 0] = Math.min(255, Math.max(0, Math.round(baseR + brightness * 255)));
          data[i + 1] = Math.min(255, Math.max(0, Math.round(baseG + brightness * 255)));
          data[i + 2] = Math.min(255, Math.max(0, Math.round(baseB + brightness * 255)));
          data[i + 3] = 255;
        }
      }
    }
  }

  const tex = new THREE.DataArrayTexture(data, size, size, TERRAIN_COUNT);
  tex.format          = THREE.RGBAFormat;
  tex.type            = THREE.UnsignedByteType;
  tex.minFilter       = THREE.LinearFilter;
  tex.magFilter       = THREE.LinearFilter;
  tex.wrapS           = THREE.MirroredRepeatWrapping;
  tex.wrapT           = THREE.MirroredRepeatWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate     = true;
  return tex;
}
