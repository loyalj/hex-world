import * as THREE from 'three';
import { sampleNoise } from '../math/Noise.js';
import { warnOnDuplicateTerrainIndices, type TerrainDescriptor, type TerrainAssetRegistry } from './TerrainTypes.js';

export interface TerrainTextureArrayOptions {
  /** Resolution of each square texture slice in pixels. Default 256. */
  size?: number;
  /** Fallback noise frequency for procedural types that don't specify their own. Default 128. */
  noiseFrequency?: number;
  /** Strength of the noise overlay (0 = solid color, 1 = full range). Default 0.13. */
  noiseStrength?: number;
}

/**
 * Build a DataArrayTexture with one 2-D slice per terrain descriptor.
 *
 * Array size is determined by the highest descriptor index + 1, so gaps are
 * supported (unused slices are left black). Descriptors with texture.type
 * 'image' are resolved from the registry; 'procedural' descriptors are
 * generated from their color and optional noiseFrequency.
 *
 * Async because image-backed descriptors may require a network fetch.
 */
export async function buildTerrainTextureArray(
  descriptors: TerrainDescriptor[],
  registry: TerrainAssetRegistry = new Map(),
  opts: TerrainTextureArrayOptions = {},
): Promise<THREE.DataArrayTexture> {
  const size          = opts.size          ?? 256;
  const noiseFreq     = opts.noiseFrequency ?? 128;
  const noiseStrength = opts.noiseStrength  ?? 0.13;

  warnOnDuplicateTerrainIndices(descriptors, 'buildTerrainTextureArray');
  const sliceCount = descriptors.reduce((m, d) => Math.max(m, d.index + 1), 1);
  const data = new Uint8Array(size * size * sliceCount * 4);

  // Resolve all image sources up front in parallel.
  const bitmapByIndex = new Map<number, ImageBitmap>();
  await Promise.all(
    descriptors
      .filter(d => d.texture.type === 'image' && d.texture.assetId)
      .map(async d => {
        const src = registry.get(d.texture.assetId!);
        if (!src) {
          console.warn(`buildTerrainTextureArray: no asset for id "${d.texture.assetId}" (terrain "${d.id}")`);
          return;
        }
        let bmp: ImageBitmap;
        if (typeof src === 'string') {
          const resp = await fetch(src);
          bmp = await createImageBitmap(await resp.blob(), { resizeWidth: size, resizeHeight: size });
        } else if (src instanceof HTMLImageElement) {
          bmp = await createImageBitmap(src, { resizeWidth: size, resizeHeight: size });
        } else {
          bmp = src;
        }
        bitmapByIndex.set(d.index, bmp);
      }),
  );

  const canvas = document.createElement('canvas');
  canvas.width  = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  for (const d of descriptors) {
    const offset = d.index * size * size * 4;
    const bmp    = bitmapByIndex.get(d.index);

    if (bmp) {
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(bmp, 0, 0, size, size);
      data.set(ctx.getImageData(0, 0, size, size).data, offset);
    } else {
      // Procedural: base color + 3-octave noise brightness modulation, with an
      // optional secondary color mixed in as sharpened noise patches (gravel).
      // Spatial offset is seeded from the terrain index so each type looks distinct.
      const base   = new THREE.Color(d.color);
      const baseR  = base.r * 255;
      const baseG  = base.g * 255;
      const baseB  = base.b * 255;
      const second = d.texture.secondaryColor !== undefined ? new THREE.Color(d.texture.secondaryColor) : null;
      const secR   = second ? second.r * 255 : 0;
      const secG   = second ? second.g * 255 : 0;
      const secB   = second ? second.b * 255 : 0;
      const ox     = d.index * 47.3;
      const oy     = d.index * 31.7;
      const typeFreq  = d.texture.noiseFrequency ?? noiseFreq;
      const patchFreq = d.texture.patchFrequency ?? 40;

      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const nx = ox + (x / size) * typeFreq;
          const ny = oy + (y / size) * typeFreq;
          const n0 = sampleNoise(nx,       ny      );
          const n1 = sampleNoise(nx * 2.3, ny * 2.3);
          const n2 = sampleNoise(nx * 5.1, ny * 5.1);
          const raw = (n0[0] + n1[0] * 0.5 + n2[0] * 0.25) / 1.75;
          const brightness = (raw * 2 - 1) * noiseStrength;
          let r = baseR, g = baseG, b = baseB;
          if (second) {
            // Sharpened mid-frequency mask: distinct patches with soft edges.
            const p  = sampleNoise(oy + (x / size) * patchFreq, ox + (y / size) * patchFreq);
            const m  = Math.min(1, Math.max(0, (p[0] - 0.5) * 3 + 0.5));
            r += (secR - r) * m;
            g += (secG - g) * m;
            b += (secB - b) * m;
          }
          const i = (y * size + x) * 4 + offset;
          data[i + 0] = Math.min(255, Math.max(0, Math.round(r + brightness * 255)));
          data[i + 1] = Math.min(255, Math.max(0, Math.round(g + brightness * 255)));
          data[i + 2] = Math.min(255, Math.max(0, Math.round(b + brightness * 255)));
          data[i + 3] = 255;
        }
      }
    }
  }

  const tex = new THREE.DataArrayTexture(data, size, size, sliceCount);
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
