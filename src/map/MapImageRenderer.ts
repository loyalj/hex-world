import type { HexMap } from './HexMap.js';
import type { HexLayout } from '../math/HexLayout.js';
import { hexCorners } from '../math/HexLayout.js';
import { offsetToHex } from '../math/HexCoord.js';
import type { TerrainDefinition } from '../geometry/TerrainTypes.js';
import { buildTerrainLookup } from '../geometry/TerrainTypes.js';
import type { FogData } from '../geometry/FogData.js';

/** World-space bounding box of all hex cell corners. */
export interface MapWorldBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Returns the world-space bounding box of every hex corner in the map. */
export function getMapWorldBounds(map: HexMap, layout: HexLayout): MapWorldBounds {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      for (const { x, z } of hexCorners(layout, offsetToHex(col, row))) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
  }
  return { minX, maxX, minZ, maxZ };
}

export interface MapImageOptions {
  /** Pixels per world unit. Default: 4. Controls output resolution. */
  scale?: number;
  /** CSS color string for cells with unknown terrain indices. Default: '#1a1a1a'. */
  background?: string;
  /** Padding in pixels on each side. Default: 2. */
  padding?: number;
  /** Output MIME type. Default: 'image/png'. */
  type?: 'image/png' | 'image/jpeg' | 'image/webp';
  /** JPEG/WebP quality 0–1. Default: 0.92. Ignored for PNG. */
  quality?: number;
  /**
   * Darken or lighten cells based on elevation.
   * Each elevation step multiplies brightness by this factor (>1 = lighter, <1 = darker).
   * Default: 0 (disabled).
   */
  elevationShading?: number;
  /**
   * Fog-of-war data to apply. When provided, cells are shaded by visibility state.
   * Use `fogDimOpacity` and `fogHideUnexplored` to control how fog is drawn.
   */
  fog?: FogData;
  /**
   * Opacity of the black overlay drawn over explored-but-not-currently-visible cells.
   * 0 = no dimming, 1 = fully black. Default: 0.5. Has no effect without `fog`.
   */
  fogDimOpacity?: number;
  /**
   * If true, cells that have never been explored are rendered solid black.
   * Default: false. Has no effect without `fog`.
   */
  fogHideUnexplored?: boolean;
}

/**
 * Renders a flat top-down image of the map using terrain colors.
 * Returns a `Blob` (PNG by default) suitable for download, minimap display,
 * or passing to `URL.createObjectURL`.
 *
 * @example
 * const blob = await renderMapImage(map, layout, DEFAULT_TERRAIN_DEFINITIONS);
 * minimapImg.src = URL.createObjectURL(blob);
 */
export async function renderMapImage(
  map:                HexMap,
  layout:             HexLayout,
  terrainDefinitions: TerrainDefinition[],
  options?:           MapImageOptions,
): Promise<Blob> {
  const scale            = options?.scale            ?? 4;
  const background       = options?.background       ?? '#1a1a1a';
  const padding          = options?.padding          ?? 2;
  const type             = options?.type             ?? 'image/png';
  const quality          = options?.quality          ?? 0.92;
  const elevationShading = options?.elevationShading ?? 0;
  const fog              = options?.fog;
  const fogDimOpacity    = options?.fogDimOpacity    ?? 0.5;
  const fogHideUnexplored = options?.fogHideUnexplored ?? false;

  const lookup = buildTerrainLookup(terrainDefinitions);

  const { minX, maxX, minZ, maxZ } = getMapWorldBounds(map, layout);

  const width  = Math.ceil((maxX - minX) * scale) + padding * 2;
  const height = Math.ceil((maxZ - minZ) * scale) + padding * 2;

  const canvas = new OffscreenCanvas(width, height);
  const ctx    = canvas.getContext('2d')!;

  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  // Pass 2 — draw each hex as a filled polygon
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      const def = lookup.get(map.getTerrain(col, row));
      if (!def) continue;

      // Resolve fog state before touching the canvas so we can skip hidden cells entirely.
      let dimAlpha = 0;
      if (fog) {
        const base     = (row * map.width + col) * 4;
        const visible  = fog.rawData[base]     === 255;
        const explored = fog.rawData[base + 1] === 255;
        if (!explored && fogHideUnexplored) continue; // leave background showing — no draw at all
        if (!visible) dimAlpha = fogDimOpacity;
      }

      let r = def.color.r;
      let g = def.color.g;
      let b = def.color.b;

      if (elevationShading !== 0) {
        const elev   = map.getElevation(col, row);
        const factor = Math.max(0, 1 + elev * elevationShading);
        r = Math.min(1, r * factor);
        g = Math.min(1, g * factor);
        b = Math.min(1, b * factor);
      }

      const corners = hexCorners(layout, offsetToHex(col, row));
      ctx.beginPath();
      ctx.moveTo((corners[0].x - minX) * scale + padding, (corners[0].z - minZ) * scale + padding);
      for (let i = 1; i < 6; i++) {
        ctx.lineTo((corners[i].x - minX) * scale + padding, (corners[i].z - minZ) * scale + padding);
      }
      ctx.closePath();
      ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
      ctx.fill();

      if (dimAlpha > 0) {
        ctx.fillStyle = `rgba(0,0,0,${dimAlpha})`;
        ctx.fill();
      }
    }
  }

  return canvas.convertToBlob({ type, quality });
}
