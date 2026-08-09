import type { HexMap } from './HexMap.js';
import type { HexLayout } from '../math/HexLayout.js';
import { hexCorner, hexToWorld } from '../math/HexLayout.js';
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

/**
 * Returns the world-space bounding box of every hex corner in the map.
 *
 * The six corner offsets are identical for every cell, so this only walks cell
 * centers and adds the extreme offsets once — cheap enough to call per frame.
 */
export function getMapWorldBounds(map: HexMap, layout: HexLayout): MapWorldBounds {
  const { f0, f1, f2, f3 } = layout.orientation;
  const size = layout.size;

  // Corner offsets relative to a cell center — the same for every cell.
  let offMinX = Infinity, offMaxX = -Infinity, offMinZ = Infinity, offMaxZ = -Infinity;
  for (let i = 0; i < 6; i++) {
    const angle = (2 * Math.PI * (layout.orientation.startAngle + i)) / 6;
    const ox = size * Math.cos(angle);
    const oz = size * Math.sin(angle);
    if (ox < offMinX) offMinX = ox;
    if (ox > offMaxX) offMaxX = ox;
    if (oz < offMinZ) offMinZ = oz;
    if (oz > offMaxZ) offMaxZ = oz;
  }

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let row = 0; row < map.height; row++) {
    const r = row;
    const rowShift = (row - (row & 1)) / 2;
    for (let col = 0; col < map.width; col++) {
      const q = col - rowShift;
      const x = (f0 * q + f1 * r) * size + layout.originX;
      const z = (f2 * q + f3 * r) * size + layout.originZ;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }

  return {
    minX: minX + offMinX, maxX: maxX + offMaxX,
    minZ: minZ + offMinZ, maxZ: maxZ + offMaxZ,
  };
}

/** Placement options shared by the transform and the renderer. */
export interface MapImageLayoutOptions {
  /** Pixels per world unit. Default: 4. Controls output resolution. */
  scale?: number;
  /** Padding in pixels on each side. Default: 2. */
  padding?: number;
}

/**
 * The world ↔ image mapping a map image uses, plus the pixel size it needs.
 *
 * Build one with {@link getMapImageTransform} (or take the one
 * {@link drawMapImage} returns) to place overlays — a camera viewport
 * rectangle, unit pins, a cursor ring — on top of a rendered minimap, and to
 * turn minimap clicks back into world positions.
 */
export interface MapImageTransform {
  /** Image width in pixels, padding included. */
  readonly width: number;
  /** Image height in pixels, padding included. */
  readonly height: number;
  readonly scale: number;
  readonly padding: number;
  readonly bounds: MapWorldBounds;
  /** World XZ → image pixel. Pass `out` to avoid an allocation. */
  worldToImage(x: number, z: number, out?: { x: number; y: number }): { x: number; y: number };
  /** Image pixel → world XZ. Pass `out` to avoid an allocation. */
  imageToWorld(px: number, py: number, out?: { x: number; z: number }): { x: number; z: number };
}

/**
 * Builds the world ↔ pixel mapping for a map image without drawing anything.
 *
 * Use it to size a canvas ahead of time, or to convert coordinates for an
 * overlay drawn beside an image produced earlier with the same options.
 *
 * @example
 * const t = getMapImageTransform(map, layout, { scale: 2 });
 * canvas.width = t.width; canvas.height = t.height;
 * const { x, y } = t.worldToImage(camera.position.x, camera.position.z);
 */
export function getMapImageTransform(
  map:      HexMap,
  layout:   HexLayout,
  options?: MapImageLayoutOptions,
): MapImageTransform {
  const scale   = options?.scale   ?? 4;
  const padding = options?.padding ?? 2;
  const bounds  = getMapWorldBounds(map, layout);

  return {
    width:  Math.ceil((bounds.maxX - bounds.minX) * scale) + padding * 2,
    height: Math.ceil((bounds.maxZ - bounds.minZ) * scale) + padding * 2,
    scale,
    padding,
    bounds,
    worldToImage(x, z, out) {
      const px = (x - bounds.minX) * scale + padding;
      const py = (z - bounds.minZ) * scale + padding;
      if (out) { out.x = px; out.y = py; return out; }
      return { x: px, y: py };
    },
    imageToWorld(px, py, out) {
      const x = (px - padding) / scale + bounds.minX;
      const z = (py - padding) / scale + bounds.minZ;
      if (out) { out.x = x; out.z = z; return out; }
      return { x, z };
    },
  };
}

/** Stroke styling for the optional river and road passes. */
export interface MapImageLineStyle {
  /** CSS color. Defaults: rivers `#4d8ecb`, roads `#b39567`. */
  color?: string;
  /**
   * Stroke width in image pixels. Defaults to a fraction of `scale`
   * (0.6 for rivers, 0.45 for roads), never thinner than 1px.
   */
  width?: number;
}

export interface MapImageOptions extends MapImageLayoutOptions {
  /** CSS color string for cells with unknown terrain indices. Default: '#1a1a1a'. */
  background?: string;
  /** Output MIME type. Default: 'image/png'. Ignored by {@link drawMapImage}. */
  type?: 'image/png' | 'image/jpeg' | 'image/webp';
  /** JPEG/WebP quality 0–1. Default: 0.92. Ignored for PNG and by {@link drawMapImage}. */
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
  /**
   * Per-cell overlay color, painted over the terrain fill. Return a CSS color
   * (use `rgba(...)` to tint rather than replace) or `null` to leave the cell
   * alone. This is the hook for anything the map itself doesn't describe —
   * territory ownership, resource highlights, a selection.
   *
   * Called once per cell, so keep it cheap.
   */
  cellTint?: (col: number, row: number) => string | null | undefined;
  /** Draw river channels as lines through each cell. Default: false. */
  rivers?: boolean | MapImageLineStyle;
  /** Draw roads as lines through each cell. Default: false. */
  roads?: boolean | MapImageLineStyle;
  /**
   * Clear the canvas to transparent before drawing instead of filling it with
   * `background`. Default: false. Only meaningful for {@link drawMapImage}.
   */
  transparent?: boolean;
}

/**
 * The 2D drawing surface {@link drawMapImage} needs. Both
 * `CanvasRenderingContext2D` and `OffscreenCanvasRenderingContext2D` satisfy it.
 */
export interface MapImageContext {
  fillStyle:   string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth:   number;
  lineCap:     CanvasLineCap;
  lineJoin:    CanvasLineJoin;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
}

const DEFAULT_RIVER_COLOR = '#4d8ecb';
const DEFAULT_ROAD_COLOR  = '#b39567';

function lineStyle(
  opt:          boolean | MapImageLineStyle | undefined,
  scale:        number,
  defaultColor: string,
  widthFactor:  number,
): { color: string; width: number } | null {
  if (!opt) return null;
  const style = opt === true ? {} : opt;
  return {
    color: style.color ?? defaultColor,
    width: style.width ?? Math.max(1, scale * widthFactor),
  };
}

/**
 * Draws a flat top-down view of the map into an existing 2D context and returns
 * the world ↔ pixel transform it used.
 *
 * This is the synchronous core of {@link renderMapImage}. Prefer it for a live
 * minimap: it draws straight into a visible canvas with no `Blob` encode, no
 * object URL, and no image decode, so it can be re-run on every edit.
 *
 * The context is assumed to be at least `transform.width × transform.height`
 * pixels; size it with {@link getMapImageTransform} first, or read the returned
 * transform after the first draw.
 *
 * @example
 * const t = getMapImageTransform(map, layout, { scale: 2 });
 * canvas.width = t.width; canvas.height = t.height;
 * drawMapImage(canvas.getContext('2d')!, map, layout, terrainDefinitions, {
 *   scale: 2, elevationShading: 0.05, rivers: true, roads: true,
 * });
 */
export function drawMapImage(
  ctx:                MapImageContext,
  map:                HexMap,
  layout:             HexLayout,
  terrainDefinitions: TerrainDefinition[],
  options?:           MapImageOptions,
): MapImageTransform {
  const background        = options?.background        ?? '#1a1a1a';
  const elevationShading  = options?.elevationShading  ?? 0;
  const fog               = options?.fog;
  const fogDimOpacity     = options?.fogDimOpacity     ?? 0.5;
  const fogHideUnexplored = options?.fogHideUnexplored ?? false;
  const cellTint          = options?.cellTint;

  const lookup    = buildTerrainLookup(terrainDefinitions);
  const transform = getMapImageTransform(map, layout, options);
  const { width, height, scale, padding, bounds } = transform;
  const { minX, minZ } = bounds;

  const riverStyle = lineStyle(options?.rivers, scale, DEFAULT_RIVER_COLOR, 0.6);
  const roadStyle  = lineStyle(options?.roads,  scale, DEFAULT_ROAD_COLOR,  0.45);

  const hasRiverEdge = (col: number, row: number, edge: number) => map.hasRiverThroughEdge(col, row, edge);
  const hasRoadEdge  = (col: number, row: number, edge: number) => map.hasRoadThroughEdge(col, row, edge);

  if (options?.transparent) {
    ctx.clearRect(0, 0, width, height);
  } else {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }

  // Rivers and roads meet at shared edge midpoints, so round caps and joins are
  // what make separate per-cell strokes read as one continuous line.
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';

  const cx = new Float64Array(6);
  const cz = new Float64Array(6);

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

      const hex = offsetToHex(col, row);
      for (let i = 0; i < 6; i++) {
        const c = hexCorner(layout, hex, i);
        cx[i] = (c.x - minX) * scale + padding;
        cz[i] = (c.z - minZ) * scale + padding;
      }

      ctx.beginPath();
      ctx.moveTo(cx[0], cz[0]);
      for (let i = 1; i < 6; i++) ctx.lineTo(cx[i], cz[i]);
      ctx.closePath();
      ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
      ctx.fill();

      if (cellTint) {
        const tint = cellTint(col, row);
        if (tint) { ctx.fillStyle = tint; ctx.fill(); }
      }

      // Roads first, rivers over them: a bridge reads better than a severed river.
      if (roadStyle || riverStyle) {
        const center = hexToWorld(layout, hex);
        const ox = (center.x - minX) * scale + padding;
        const oz = (center.z - minZ) * scale + padding;

        if (roadStyle && map.hasRoads(col, row)) {
          strokeCellEdges(ctx, col, row, ox, oz, cx, cz, roadStyle, hasRoadEdge);
        }
        if (riverStyle && map.hasRiver(col, row)) {
          strokeCellEdges(ctx, col, row, ox, oz, cx, cz, riverStyle, hasRiverEdge);
        }
      }

      if (dimAlpha > 0) {
        // Re-walk the hex: the river/road strokes above replaced the path.
        ctx.beginPath();
        ctx.moveTo(cx[0], cz[0]);
        for (let i = 1; i < 6; i++) ctx.lineTo(cx[i], cz[i]);
        ctx.closePath();
        ctx.fillStyle = `rgba(0,0,0,${dimAlpha})`;
        ctx.fill();
      }
    }
  }

  return transform;
}

/**
 * Strokes center→edge-midpoint spokes for every edge the predicate accepts.
 * Edge `i` spans corners `i` and `i + 1`, matching the terrain mesh, so spokes
 * from neighbouring cells meet exactly at the shared midpoint.
 */
function strokeCellEdges(
  ctx:   MapImageContext,
  col:   number,
  row:   number,
  ox:    number,
  oz:    number,
  cx:    Float64Array,
  cz:    Float64Array,
  style: { color: string; width: number },
  has:   (col: number, row: number, edge: number) => boolean,
): void {
  let any = false;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    if (!has(col, row, i)) continue;
    const i1 = (i + 1) % 6;
    ctx.moveTo(ox, oz);
    ctx.lineTo((cx[i] + cx[i1]) * 0.5, (cz[i] + cz[i1]) * 0.5);
    any = true;
  }
  if (!any) return;
  ctx.strokeStyle = style.color;
  ctx.lineWidth   = style.width;
  ctx.stroke();
}

/**
 * Renders a flat top-down image of the map using terrain colors.
 * Returns a `Blob` (PNG by default) suitable for download, a saved thumbnail,
 * or passing to `URL.createObjectURL`.
 *
 * For a minimap that updates as the map is edited, use {@link drawMapImage}
 * against a visible canvas instead — it skips the encode/decode round trip.
 *
 * @example
 * const blob = await renderMapImage(map, layout, DEFAULT_TERRAIN_DEFINITIONS);
 * thumbnail.src = URL.createObjectURL(blob);
 */
export async function renderMapImage(
  map:                HexMap,
  layout:             HexLayout,
  terrainDefinitions: TerrainDefinition[],
  options?:           MapImageOptions,
): Promise<Blob> {
  const type    = options?.type    ?? 'image/png';
  const quality = options?.quality ?? 0.92;

  const { width, height } = getMapImageTransform(map, layout, options);

  // OffscreenCanvas where available (workers, modern browsers); DOM canvas fallback.
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : document.createElement('canvas');
  if (canvas instanceof HTMLCanvasElement) {
    canvas.width  = width;
    canvas.height = height;
  }
  const ctx = (canvas as HTMLCanvasElement).getContext('2d');
  if (!ctx) throw new Error('renderMapImage: could not acquire a 2d canvas context');

  drawMapImage(ctx, map, layout, terrainDefinitions, options);

  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      b => (b ? resolve(b) : reject(new Error('renderMapImage: canvas.toBlob produced no data'))),
      type, quality,
    );
  });
}
