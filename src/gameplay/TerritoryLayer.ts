import * as THREE from 'three';
import type { HexMap } from '../map/HexMap.js';
import type { CellOverlayLayer } from '../geometry/CellOverlayLayer.js';

/**
 * A claimable faction: the owner ids stored per cell are these `id` strings.
 * Fully JSON-serializable, so a faction roster rides through a `.hexpack`
 * manifest or a game save next to the map.
 */
export interface FactionDescriptor {
  /** Stable id written into the map's metadata channel. Keep it short — it is stored per owned cell. */
  id: string;
  name: string;
  /** Territory tint. Fills use it at `fillOpacity`; borders at full strength unless `borderColor` overrides. */
  color: number;
  /** Border line color. Defaults to `color`. */
  borderColor?: number;
}

/** Per-cell ownership as stored in the metadata channel: one owner, or weighted influence. */
export type OwnershipValue = string | Record<string, number>;

export interface TerritoryLayerOptions {
  /** The overlay layer territory draws through — usually `world.overlays`. */
  overlays: CellOverlayLayer;
  /** The map ownership is stored on. Pass an accessor if the map can be swapped at runtime. */
  map: HexMap | (() => HexMap);
  factions?: FactionDescriptor[];
  /**
   * Metadata channel key ownership is stored under. Default `'owner'`.
   * Change it only to avoid a collision with your own per-cell data.
   */
  dataKey?: string;
  /** Fill opacity for owned cells. Default 0.25. */
  fillOpacity?: number;
  /** Border line opacity. Default 0.9. */
  borderOpacity?: number;
  /** Lift of the fill above the cell surface. Default 0.02. */
  fillYOffset?: number;
  /** Lift of the border above the cell surface. Default 0.035 (just over the fill). */
  borderYOffset?: number;
  /** Draw borders around each faction's holdings. Default true. */
  borders?: boolean;
  /** Overlay id prefix, so several territory layers can coexist. Default `'territory'`. */
  idPrefix?: string;
}

/**
 * Per-cell ownership: who holds which hex, drawn as translucent faction tints
 * with an outline around each faction's holdings.
 *
 * Ownership lives in the map's metadata channel (`HexMap.cellData`), so it
 * serializes with the map for free — save through `serializeMap` /
 * `serializeMapJSON` / `.hexpack` and the borders come back exactly as they
 * were, no companion file. The layer itself holds no cell state; it is a view
 * over that data plus a faction roster.
 *
 * A cell can be held outright (`claim`) or *contested* (`setInfluence`), where
 * several factions hold fractional weights and the fill is their weighted color
 * blend. Contested cells count toward whichever faction has the largest share
 * for border and {@link ownedCells} purposes.
 *
 * Mutations only mark the layer dirty; call {@link update} once per frame (or
 * {@link refresh} straight after a batch of edits) to rebuild the geometry, so
 * a thousand-cell flood fill costs one rebuild instead of a thousand.
 *
 * @example
 * const territory = new TerritoryLayer({
 *   overlays: world.overlays,
 *   map:      () => world.map,
 *   factions: [
 *     { id: 'red',  name: 'Kelmar',   color: 0xdd4433 },
 *     { id: 'blue', name: 'Ossiran',  color: 0x3377dd },
 *   ],
 * });
 * territory.claim(10, 10, 'red');
 * territory.setInfluence(11, 10, { red: 0.6, blue: 0.4 }); // contested border hex
 * territory.refresh();
 */
export class TerritoryLayer {
  private readonly overlays: CellOverlayLayer;
  private readonly getMap: () => HexMap;
  private readonly dataKey: string;
  private readonly fillOpacity: number;
  private readonly borderOpacity: number;
  private readonly fillYOffset: number;
  private readonly borderYOffset: number;
  private readonly drawBorders: boolean;
  private readonly idPrefix: string;

  private _factions: FactionDescriptor[];
  private factionsById = new Map<string, FactionDescriptor>();
  /** Overlay ids currently in the scene, so removed factions clean up after themselves. */
  private activeBorderIds = new Set<string>();
  private dirty = true;
  private _visible = true;

  constructor(options: TerritoryLayerOptions) {
    this.overlays      = options.overlays;
    this.getMap        = typeof options.map === 'function' ? options.map : () => options.map as HexMap;
    this.dataKey       = options.dataKey       ?? 'owner';
    this.fillOpacity   = options.fillOpacity   ?? 0.25;
    this.borderOpacity = options.borderOpacity ?? 0.9;
    this.fillYOffset   = options.fillYOffset   ?? 0.02;
    this.borderYOffset = options.borderYOffset ?? 0.035;
    this.drawBorders   = options.borders       ?? true;
    this.idPrefix      = options.idPrefix      ?? 'territory';
    this._factions     = options.factions ?? [];
    this.rebuildFactionIndex();
  }

  /** The faction roster currently in use. */
  get factions(): FactionDescriptor[] { return this._factions; }

  /** The metadata channel key ownership is stored under. */
  get ownerKey(): string { return this.dataKey; }

  private rebuildFactionIndex(): void {
    this.factionsById = new Map(this._factions.map(f => [f.id, f]));
  }

  /** Replace the faction roster (colors, names). Cell ownership is untouched. */
  setFactions(factions: FactionDescriptor[]): void {
    this._factions = factions;
    this.rebuildFactionIndex();
    this.dirty = true;
  }

  /** Look up a faction descriptor by id. */
  getFaction(id: string): FactionDescriptor | undefined {
    return this.factionsById.get(id);
  }

  // --- Ownership reads ---

  /** Raw stored ownership for a cell — a faction id, an influence record, or `null`. */
  ownershipAt(col: number, row: number): OwnershipValue | null {
    const map = this.getMap();
    if (!map.inBounds(col, row)) return null;
    const value = map.getCellData(col, row, this.dataKey);
    if (typeof value === 'string') return value;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, number>;
    }
    return null;
  }

  /**
   * The faction holding a cell — the sole owner, or the largest share of a
   * contested cell. `null` when unowned. Ties resolve to the roster order so
   * the answer is stable across calls.
   */
  ownerOf(col: number, row: number): string | null {
    const value = this.ownershipAt(col, row);
    if (value === null) return null;
    if (typeof value === 'string') return value;

    let best: string | null = null;
    let bestWeight = 0;
    for (const [id, weight] of Object.entries(value)) {
      if (typeof weight !== 'number' || !(weight > bestWeight)) continue;
      bestWeight = weight;
      best = id;
    }
    return best;
  }

  /**
   * Per-faction influence on a cell, normalized to sum to 1. An outright claim
   * reads as `{ [ownerId]: 1 }`. `null` when unowned.
   */
  influenceAt(col: number, row: number): Record<string, number> | null {
    const value = this.ownershipAt(col, row);
    if (value === null) return null;
    if (typeof value === 'string') return { [value]: 1 };

    let total = 0;
    for (const w of Object.values(value)) if (typeof w === 'number' && w > 0) total += w;
    if (total <= 0) return null;

    const out: Record<string, number> = {};
    for (const [id, w] of Object.entries(value)) {
      if (typeof w === 'number' && w > 0) out[id] = w / total;
    }
    return out;
  }

  /** Every cell whose dominant owner is `factionId`. */
  ownedCells(factionId: string): Array<{ col: number; row: number }> {
    const map = this.getMap();
    const out: Array<{ col: number; row: number }> = [];
    for (const [ci, record] of map.cellData) {
      if (record[this.dataKey] === undefined) continue;
      const col = ci % map.width;
      const row = (ci / map.width) | 0;
      if (this.ownerOf(col, row) === factionId) out.push({ col, row });
    }
    return out;
  }

  /** Cell counts per faction id, for scoreboards. Unowned cells are not counted. */
  cellCounts(): Map<string, number> {
    const map = this.getMap();
    const counts = new Map<string, number>();
    for (const [ci, record] of map.cellData) {
      if (record[this.dataKey] === undefined) continue;
      const owner = this.ownerOf(ci % map.width, (ci / map.width) | 0);
      if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    return counts;
  }

  // --- Ownership writes ---

  /** Give a cell outright to a faction. Out-of-bounds cells are skipped. */
  claim(col: number, row: number, factionId: string): void {
    const map = this.getMap();
    if (!map.inBounds(col, row)) return;
    map.setCellData(col, row, this.dataKey, factionId);
    this.dirty = true;
  }

  /** Give many cells to one faction — a conquest, a starting region, a flood fill. */
  claimAll(cells: Iterable<{ col: number; row: number }>, factionId: string): void {
    for (const { col, row } of cells) this.claim(col, row, factionId);
  }

  /**
   * Mark a cell contested, with a weight per faction (any positive scale — they
   * are normalized on read). Weights of zero or less are dropped; an empty
   * result releases the cell.
   */
  setInfluence(col: number, row: number, weights: Record<string, number>): void {
    const map = this.getMap();
    if (!map.inBounds(col, row)) return;
    const cleaned: Record<string, number> = {};
    for (const [id, w] of Object.entries(weights)) {
      if (typeof w === 'number' && w > 0) cleaned[id] = w;
    }
    const ids = Object.keys(cleaned);
    if (ids.length === 0) {
      this.release(col, row);
      return;
    }
    // A single contender is just an outright claim — store the cheaper shape.
    map.setCellData(col, row, this.dataKey, ids.length === 1 ? ids[0] : cleaned);
    this.dirty = true;
  }

  /** Return a cell to no-one. */
  release(col: number, row: number): void {
    const map = this.getMap();
    if (!map.inBounds(col, row)) return;
    map.setCellData(col, row, this.dataKey, undefined);
    this.dirty = true;
  }

  /** Return many cells to no-one. */
  releaseAll(cells: Iterable<{ col: number; row: number }>): void {
    for (const { col, row } of cells) this.release(col, row);
  }

  /**
   * Wipe all ownership from the map, leaving every other metadata key intact.
   * @param factionId Limit the wipe to one faction's holdings.
   */
  clear(factionId?: string): void {
    const map = this.getMap();
    // Snapshot first: setCellData deletes records, which would mutate cellData mid-iteration.
    const owned: Array<{ col: number; row: number }> = [];
    for (const [ci, record] of map.cellData) {
      if (record[this.dataKey] === undefined) continue;
      const col = ci % map.width;
      const row = (ci / map.width) | 0;
      if (factionId === undefined || this.ownerOf(col, row) === factionId) owned.push({ col, row });
    }
    for (const { col, row } of owned) map.setCellData(col, row, this.dataKey, undefined);
    this.dirty = true;
  }

  // --- Rendering ---

  /** Show or hide the whole layer without discarding ownership data. */
  setVisible(visible: boolean): void {
    this._visible = visible;
    if (visible) {
      this.dirty = true;
      this.refresh();
    } else {
      this.overlays.hide(`${this.idPrefix}:fill`);
      for (const id of this.activeBorderIds) this.overlays.hide(id);
    }
  }

  /** Whether the layer is currently drawn. */
  get visible(): boolean { return this._visible; }

  /** Rebuild only if something changed since the last build. Cheap to call every frame. */
  update(): void {
    if (this.dirty && this._visible) this.refresh();
  }

  /**
   * Rebuild the territory geometry now: one vertex-colored fill over every
   * owned cell (contested cells carrying their blended tint) plus one outline
   * per faction.
   */
  refresh(): void {
    this.dirty = false;
    if (!this._visible) return;

    const map = this.getMap();

    // Walk the sparse metadata store, not the whole map — cost scales with the
    // number of owned cells, so this stays cheap on continent-sized maps.
    const owned: Array<{ col: number; row: number }> = [];
    const byFaction = new Map<string, Array<{ col: number; row: number }>>();
    const tints: THREE.Color[] = [];

    for (const [ci, record] of map.cellData) {
      if (record[this.dataKey] === undefined) continue;
      const col = ci % map.width;
      const row = (ci / map.width) | 0;
      const influence = this.influenceAt(col, row);
      if (!influence) continue;

      const tint = this.blendColor(influence);
      if (!tint) continue; // every contributing faction is off the roster

      owned.push({ col, row });
      tints.push(tint);

      const owner = this.ownerOf(col, row);
      if (owner && this.factionsById.has(owner)) {
        const list = byFaction.get(owner);
        if (list) list.push({ col, row }); else byFaction.set(owner, [{ col, row }]);
      }
    }

    this.overlays.set(`${this.idPrefix}:fill`, owned, {
      style:     'fill',
      opacity:   this.fillOpacity,
      yOffset:   this.fillYOffset,
      // Pass the Color itself — a hex round-trip would re-encode to sRGB and back.
      cellColor: (_cell, i) => tints[i],
    });

    // Borders: one outline per faction, and hide any faction that just lost its last cell.
    const stillActive = new Set<string>();
    if (this.drawBorders) {
      for (const [factionId, cells] of byFaction) {
        const faction = this.factionsById.get(factionId)!;
        const id = `${this.idPrefix}:border:${factionId}`;
        stillActive.add(id);
        this.overlays.set(id, cells, {
          style:   'outline',
          color:   faction.borderColor ?? faction.color,
          opacity: this.borderOpacity,
          yOffset: this.borderYOffset,
        });
      }
    }
    for (const id of this.activeBorderIds) {
      if (!stillActive.has(id)) this.overlays.hide(id);
    }
    this.activeBorderIds = stillActive;
  }

  /**
   * Weighted blend of the faction colors holding a cell. Blending happens in
   * the renderer's working color space (three converts on `set`), so a 50/50
   * red/blue cell lands on the perceptual midpoint rather than a muddy average
   * of sRGB bytes. Returns `null` if no contributing faction is on the roster.
   */
  private blendColor(influence: Record<string, number>): THREE.Color | null {
    const out = new THREE.Color(0, 0, 0);
    const c = new THREE.Color();
    let total = 0;
    for (const [id, weight] of Object.entries(influence)) {
      const faction = this.factionsById.get(id);
      if (!faction) continue;
      c.set(faction.color);
      out.r += c.r * weight;
      out.g += c.g * weight;
      out.b += c.b * weight;
      total += weight;
    }
    if (total <= 0) return null;
    // Renormalize in case some contributors were off the roster.
    out.r /= total; out.g /= total; out.b /= total;
    return out;
  }

  /** Remove this layer's overlays. Ownership data on the map is left alone. */
  dispose(): void {
    this.overlays.remove(`${this.idPrefix}:fill`);
    for (const id of this.activeBorderIds) this.overlays.remove(id);
    this.activeBorderIds.clear();
  }
}
