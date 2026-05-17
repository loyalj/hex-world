# Runtime Map Editing

Games often need to modify the map after it's been generated — painting terrain, raising mountains, carving rivers, placing roads. The library's map data is a flat `TypedArray` that you write to directly; you then tell `ChunkManager` which chunk needs its geometry rebuilt.

---

## The editing loop

Every runtime edit follows this pattern:

```
1. Write to map data  (setTerrain / setElevation / setRoad / etc.)
2. Call chunks.markDirty(col, row)
3. On next chunks.update(camera), the dirty chunk rebuilds its geometry
```

`markDirty` accepts any cell coordinate inside the chunk — it looks up the chunk automatically.

---

## Terrain and elevation

```ts
// Change terrain type
map.setTerrain(col, row, 0);          // Grassland
map.setTerrain(col, row, 5);          // Water (submerged geometry)
chunks.markDirty(col, row);

// Change elevation
map.setElevation(col, row, 4);        // Raise land
map.setElevation(col, row, -1);       // Lower below water level — submerges the cell
chunks.markDirty(col, row);

// Both at once
map.setTerrain(col, row, 5);
map.setElevation(col, row, -1);
chunks.markDirty(col, row);
```

Geometry is rebuilt only for the chunk containing `(col, row)`. If an edit affects the visual edge between two chunks — elevation or terrain change at a chunk boundary — mark both chunks dirty:

```ts
chunks.markDirty(col, row);
chunks.markDirty(col + 1, row);   // neighbor may be in the adjacent chunk
```

---

## Roads

Roads are undirected edge flags. Each edge is shared between two cells, so you must set it on **both sides** to get a consistent road through that boundary:

```ts
import { POINTY_TOP, offsetNeighbor } from '@loyalj/hex-world';

const EDGE_DIRS = POINTY_TOP.edgeDirections;

/**
 * Paint a road through edge `face` (0–5) of cell (col, row).
 * Sets the bit on both sides of the shared edge.
 */
function setRoadEdge(col: number, row: number, face: number, state: boolean): void {
  const nb      = offsetNeighbor(col, row, EDGE_DIRS[face]);
  const oppFace = (face + 3) % 6;

  map.setRoad(col, row, face, state);
  if (map.inBounds(nb.col, nb.row)) {
    map.setRoad(nb.col, nb.row, oppFace, state);
    chunks.markDirty(nb.col, nb.row);
  }
  chunks.markDirty(col, row);
}

// Add a road
setRoadEdge(col, row, 2, true);

// Remove it
setRoadEdge(col, row, 2, false);

// Remove all roads from a cell
for (let face = 0; face < 6; face++) {
  setRoadEdge(col, row, face, false);
}
```

---

## Rivers

Rivers are **directed** — each edge stores which face a river enters and which face it exits. Setting a river requires coordinating two cells per edge: the outgoing side of the upstream cell and the incoming side of the downstream cell.

```ts
import { POINTY_TOP, offsetNeighbor } from '@loyalj/hex-world';

const EDGE_DIRS = POINTY_TOP.edgeDirections;

/**
 * Connect a river from cell A out through face `face` into neighboring cell B.
 * Call this once per edge in the river's flow direction.
 */
function connectRiverEdge(col: number, row: number, face: number): void {
  const nb      = offsetNeighbor(col, row, EDGE_DIRS[face]);
  const oppFace = (face + 3) % 6;

  if (!map.inBounds(nb.col, nb.row)) return;

  map.setRiverOutgoing(col,    row,    face);     // water leaves this cell here
  map.setRiverIncoming(nb.col, nb.row, oppFace);  // water enters the neighbor here

  chunks.markDirty(col, row);
  chunks.markDirty(nb.col, nb.row);
}

/**
 * Clear all river data from a cell and remove the incoming link
 * from whichever neighbor was feeding it.
 */
function clearRiverFromCell(col: number, row: number): void {
  // Clear the outgoing link on the downstream neighbor
  const outFace = map.getOutgoingRiverDir(col, row);
  if (outFace >= 0) {
    const nb = offsetNeighbor(col, row, EDGE_DIRS[outFace]);
    if (map.inBounds(nb.col, nb.row)) {
      map.clearRiver(nb.col, nb.row);
      chunks.markDirty(nb.col, nb.row);
    }
  }

  // Clear the incoming link on the upstream neighbor
  const inFace = map.getIncomingRiverDir(col, row);
  if (inFace >= 0) {
    const oppFace = (inFace + 3) % 6;
    const nb = offsetNeighbor(col, row, EDGE_DIRS[inFace]);
    if (map.inBounds(nb.col, nb.row)) {
      // Remove the outgoing flag from the upstream cell
      const upByte = map.getOutgoingRiverDir(nb.col, nb.row);
      if (upByte === oppFace) {
        const idx = nb.row * map.width + nb.col;
        // Clear only the outgoing bits (preserve incoming)
        map.clearRiver(nb.col, nb.row);
        chunks.markDirty(nb.col, nb.row);
      }
    }
  }

  map.clearRiver(col, row);
  chunks.markDirty(col, row);
}
```

### River data model

Each cell stores one byte:
- **Bits 2–0** = incoming edge index + 1 (0 = no incoming)
- **Bits 5–3** = outgoing edge index + 1 (0 = no outgoing)

Reading river state:

```ts
map.hasRiver(col, row)                   // any river on this cell
map.hasIncomingRiver(col, row)           // water flows in
map.hasOutgoingRiver(col, row)           // water flows out
map.hasRiverBeginOrEnd(col, row)         // exactly one of in/out (source or terminus)
map.getIncomingRiverDir(col, row)        // edge index 0–5, or -1
map.getOutgoingRiverDir(col, row)        // edge index 0–5, or -1
map.hasRiverThroughEdge(col, row, face)  // river crosses this specific edge
```

---

## Scatter feature density

Feature density is 0–3 per cell per layer. You can paint it at runtime the same way generators do:

```ts
// Set density for scatter layer 0
map.setFeatureLevel(col, row, 0, 3);   // dense
map.setFeatureLevel(col, row, 0, 0);   // clear

chunks.markDirty(col, row);
```

---

## Bulk edits (painting a region)

When editing many cells at once, collect the dirty set rather than marking each cell individually. `markDirty` just adds a chunk key to a `Set` — it's cheap to call multiple times for the same chunk — but for very large edits you may want to batch the `markDirty` calls and invalidate only the unique chunks:

```ts
// Paint a radius of cells
const affected = new Set<string>();

for (const hex of hexRange(center, brushRadius)) {
  const { col, row } = hexToOffset(hex);
  if (!map.inBounds(col, row)) continue;

  map.setTerrain(col, row, newTerrain);

  // markDirty is idempotent — cheap to call for each cell
  chunks.markDirty(col, row);
}
```

The chunk geometry rebuild happens lazily on the next `chunks.update(camera)` call, so multiple `markDirty` calls for the same chunk in one frame cost nothing extra.

---

## Reading edge direction indices

The edge index (0–5) maps to compass directions in pointy-top orientation:

| Index | Pointy-top direction |
|---|---|
| 0 | East (right) |
| 1 | NE |
| 2 | NW |
| 3 | West (left) |
| 4 | SW |
| 5 | SE |

The opposite of face `f` is always `(f + 3) % 6`.

Use `POINTY_TOP.edgeDirections[face]` to get the `HexCoord` offset vector for neighbor lookups. For flat-top maps substitute `FLAT_TOP.edgeDirections`.

---

## Water surfaces

Water bodies automatically compute a flat surface elevation so that every cell in a connected lake or ocean sits at the same Y, regardless of the individual depth variation underneath. This surface is stored in `map.waterSurfaces` and drives the water geometry Y position.

**`ChunkManager` handles this automatically.** When any cells are marked dirty, `computeWaterSurfaces()` runs once before the affected chunks are rebuilt. You do not need to call it yourself for normal editing workflows.

If you need the water surface elevation before the next `update()` — for example, to position a hover indicator at the correct Y — call it manually after your edits:

```ts
map.setTerrain(col, row, waterTerrainIndex);
map.computeWaterSurfaces(t => myWaterTerrains.has(t));
chunks.markDirty(col, row);

// Now safe to query
const surfaceY = map.getWaterSurface(col, row) * elevScale;
```

### Mountain lakes

Set the lake floor cells to **one below your desired surface elevation** — `computeWaterSurfaces` adds one to the highest floor cell to produce the surface, then clamps to ≥ 0 so ocean bodies (floor at −1) always surface at sea level. Shore land cells should sit at the desired surface elevation so the foam renders flush with the waterline.

```ts
// Create a lake with surface at elevation 5 (world Y = 5 × elevScale)
const desiredSurface = 5;
for (const {col, row} of lakeCells) {
  map.setTerrain(col, row, waterTerrainIndex);
  map.setElevation(col, row, desiredSurface - 1); // floor one step below surface
  chunks.markDirty(col, row);
}
// Rim / shore land cells should be at desiredSurface so water meets land flush
// ChunkManager recomputes surfaces automatically on next update()
```

Depth variation within a lake is supported — cells set lower than `desiredSurface - 1` will appear darker. The surface geometry stays flat at the computed surface elevation regardless of floor variation.

### Querying water surface elevation

```ts
// World-space Y of the water surface above a cell
const surfaceY = map.getWaterSurface(col, row) * elevScale;

// All cells that form the same connected water body
const body = map.getConnectedWaterBody(col, row, t => myWaterTerrains.has(t));
```

`getWaterSurface` returns the elevation index (same units as `getElevation`). Multiply by your `elevScale` to get world Y. Returns 0 for non-water cells.

---

## Quick reference

| Operation | Map API | Note |
|---|---|---|
| Change terrain | `map.setTerrain(col, row, idx)` | mark chunk dirty |
| Change elevation | `map.setElevation(col, row, elev)` | mark chunk dirty |
| Set road edge | `map.setRoad(col, row, face, bool)` | set on BOTH sides of edge |
| Set river out | `map.setRiverOutgoing(col, row, face)` | set incoming on neighbor too |
| Set river in | `map.setRiverIncoming(col, row, face)` | |
| Clear river | `map.clearRiver(col, row)` | also clear neighbor links |
| Set scatter density | `map.setFeatureLevel(col, row, layer, 0–3)` | mark chunk dirty |
| Trigger rebuild | `chunks.markDirty(col, row)` | lazy — runs on next update() |
| Water surface Y | `map.getWaterSurface(col, row) * elevScale` | elevation index × scale |
| Connected water body | `map.getConnectedWaterBody(col, row, isWater)` | returns all cells in body |
| Recompute surfaces | `map.computeWaterSurfaces(isWater?)` | auto-called by ChunkManager |
