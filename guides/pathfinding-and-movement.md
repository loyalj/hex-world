# Pathfinding and Movement

The library provides A*, flood-fill movement range, BFS visibility, line-of-sight, and Catmull-Rom path smoothing. All algorithms accept a `MoveCostFn` that your game supplies — the library never reads terrain or unit data directly, so your rules stay in your code.

---

## The `MoveCostFn` contract

```ts
import type { MoveCostFn } from '@loyalj/hex-world';
import { hexToOffset } from '@loyalj/hex-world';

const cost: MoveCostFn = (from, to) => {
  // `from` and `to` are cube HexCoords — convert to offset to read map data
  const { col, row } = hexToOffset(to);

  // Return Infinity (or any non-finite value) to make `to` impassable
  if (map.getTerrain(col, row) === TerrainType.Water) return Infinity;

  // Return a positive number for the movement cost
  return 1;
};
```

**Rules:**
- Costs must be **non-negative**. Negative costs produce undefined behavior.
- Return `Infinity` (or `NaN`) to mark a cell as impassable. The step is skipped.
- The function receives both `from` and `to` so you can apply edge-based costs (river crossing, road bonus, facing penalty).
- Close over your `HexMap`, unit state, and game rules — the library passes only the coordinates.

---

## A* pathfinding

```ts
import { findPath, offsetToHex } from '@loyalj/hex-world';

const path = findPath(
  offsetToHex(startCol, startRow),
  offsetToHex(goalCol,  goalRow),
  cost,
  map,
);

if (path) {
  // path[0] = start, path[path.length - 1] = goal
  unit.travel(path);
} else {
  // No path exists
}
```

Returns `HexCoord[]` (both endpoints inclusive) or `null` if the goal is unreachable. A path from a cell to itself returns `[start]`.

### Unit-type cost functions

Different units can reuse the same underlying map with different cost functions:

```ts
const infantryCost: MoveCostFn = (from, to) => {
  const { col, row } = hexToOffset(to);
  if (map.getTerrain(col, row) === TerrainType.Water) return Infinity;
  const elev = map.getElevation(col, row);
  return elev > 4 ? 3 : 1;   // steep terrain costs more
};

const cavalryCost: MoveCostFn = (from, to) => {
  const { col, row } = hexToOffset(to);
  if (map.getTerrain(col, row) === TerrainType.Water)  return Infinity;
  if (map.getTerrain(col, row) === TerrainType.Mud)    return 3;   // cavalry hates mud
  if (map.hasRoads(col, row))                          return 0.5; // fast on roads
  return 1;
};

const shipCost: MoveCostFn = (from, to) => {
  const { col, row } = hexToOffset(to);
  return map.getTerrain(col, row) === TerrainType.Water ? 1 : Infinity;
};
```

### Edge-based costs

The `from` parameter lets you apply costs that depend on the edge being crossed, not just the destination:

```ts
const riverCrossingCost: MoveCostFn = (from, to) => {
  const toOff = hexToOffset(to);
  if (map.getTerrain(toOff.col, toOff.row) === TerrainType.Water) return Infinity;

  // Find the edge between from and to by checking which neighbor direction leads to `to`
  const fromOff = hexToOffset(from);
  for (let face = 0; face < 6; face++) {
    const nb = offsetNeighbor(fromOff.col, fromOff.row, EDGE_DIRS[face]);
    if (nb.col === toOff.col && nb.row === toOff.row) {
      if (map.hasRiverThroughEdge(fromOff.col, fromOff.row, face)) return 3; // river crossing
      break;
    }
  }
  return 1;
};
```

---

## Movement range (flood-fill)

Returns every cell reachable within a movement budget. Uses Dijkstra — each reachable cell is settled at its minimum cost, so it handles non-uniform costs correctly.

```ts
import { getMovementRange, offsetToHex } from '@loyalj/hex-world';

const reachable = getMovementRange(
  offsetToHex(unitCol, unitRow),
  budget,      // total movement points (in cost units)
  cost,
  map,
);

// Highlight reachable cells
for (const hex of reachable) {
  const { col, row } = hexToOffset(hex);
  setHighlight(col, row, true);
}
```

The center cell is always included (at cost 0). Order is not guaranteed. If you need the cells sorted by distance, sort the result by `hexDistance(center, cell)`.

### Combining path + range

A common pattern: show range on hover, path on click.

```ts
let hoveredRange: HexCoord[] = [];
let activePath:  HexCoord[] | null = null;

// On pointer move — show which cells the unit can reach
renderer.domElement.addEventListener('pointermove', e => {
  const cell = pickHexFromMeshes(e.clientX, e.clientY, renderer.domElement, camera, layout, map, chunks.terrainMeshes);
  if (!cell) return;

  // Show path preview to hovered cell
  activePath = findPath(offsetToHex(unit.col, unit.row), offsetToHex(cell.col, cell.row), cost, map);
});

// On click — move if the cell is reachable
renderer.domElement.addEventListener('click', e => {
  const cell = pickHexFromMeshes(e.clientX, e.clientY, renderer.domElement, camera, layout, map, chunks.terrainMeshes);
  if (!cell || !activePath) return;

  const isReachable = hoveredRange.some(h => {
    const oc = hexToOffset(h);
    return oc.col === cell.col && oc.row === cell.row;
  });

  if (isReachable) unit.travel(activePath);
});
```

---

## BFS visibility radius

`getVisibleCells` is a simple hop count — it doesn't use a cost function. Every step from the center counts as 1, regardless of terrain. Use it to decide which cells a unit can "see" for fog of war, detection range, or ability targeting.

```ts
import { getVisibleCells, offsetToHex, hexToOffset } from '@loyalj/hex-world';

const visible = getVisibleCells(offsetToHex(col, row), 3, map);

for (const hex of visible) {
  const oc = hexToOffset(hex);
  fog.increaseVisibility(oc.col, oc.row);
}
```

The center cell is always included. Cells that fall outside the map boundary are excluded.

---

## Line of sight

`hasLineOfSight` traces the hex line between two cells and checks whether any intermediate cell's terrain elevation pokes above the straight sight line. It uses the same 0.5-world-units-per-elevation-step scale as the terrain geometry.

```ts
import { hasLineOfSight, offsetToHex } from '@loyalj/hex-world';

const canSee = hasLineOfSight(
  offsetToHex(unitCol,   unitRow),
  offsetToHex(targetCol, targetRow),
  map,
);

// Optional: custom eye height (default 1.5 world units above terrain)
const canSeeFromTower = hasLineOfSight(from, to, map, 3.0);
```

Cells adjacent to the observer are always considered visible (LOS returns `true` when `hexDistance(from, to) <= 1`).

### LOS-filtered visibility range

Combine `getVisibleCells` with `hasLineOfSight` to get a set of cells within range that are actually visible (not behind hills):

```ts
const inRange = getVisibleCells(offsetToHex(col, row), range, map);
const trueVisible = inRange.filter(hex =>
  hasLineOfSight(offsetToHex(col, row), hex, map)
);
```

---

## Path smoothing

`smoothPath` generates a dense array of world-space points along a Catmull-Rom spline through the cell centers of a path. Use it for a curved path preview line or an animated projectile curve.

```ts
import { smoothPath } from '@loyalj/hex-world';

// Returns { x, y, z }[] — world-space positions along the spline
const pts = smoothPath(path, layout, map);          // 8 samples per segment (default)
const pts = smoothPath(path, layout, map, 16);      // smoother

// Build a THREE.Line from the points
const positions = new Float32Array(pts.length * 3);
pts.forEach((p, i) => {
  positions[i * 3]     = p.x;
  positions[i * 3 + 1] = p.y + 0.15;  // float slightly above terrain
  positions[i * 3 + 2] = p.z;
});

const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffaa22, depthTest: false }));
scene.add(line);
```

Update the line geometry each frame as the path changes:

```ts
function updatePathLine(path: HexCoord[] | null): void {
  if (!path || path.length < 2) {
    line.visible = false;
    return;
  }
  const pts = smoothPath(path, layout, map);
  const positions = geo.attributes.position as THREE.BufferAttribute;
  // Resize if needed
  if (positions.count !== pts.length) {
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts.length * 3), 3));
  }
  const arr = geo.attributes.position.array as Float32Array;
  pts.forEach((p, i) => {
    arr[i * 3]     = p.x;
    arr[i * 3 + 1] = p.y + 0.15;
    arr[i * 3 + 2] = p.z;
  });
  geo.attributes.position.needsUpdate = true;
  geo.setDrawRange(0, pts.length);
  line.visible = true;
}
```

---

## Coordinate conversion

The pathfinding functions use cube `HexCoord` (`{ q, r }`). Map data uses offset `(col, row)`. Convert between them with:

```ts
import { offsetToHex, hexToOffset } from '@loyalj/hex-world';

const hex = offsetToHex(col, row);   // HexCoord for pathfinding
const off = hexToOffset(hex);        // { col, row } for map API
```

---

## Quick reference

| Task | API |
|---|---|
| Find a path | `findPath(from, to, costFn, map)` → `HexCoord[] \| null` |
| Movement range | `getMovementRange(center, budget, costFn, map)` → `HexCoord[]` |
| Visibility radius | `getVisibleCells(center, range, map)` → `HexCoord[]` |
| Line of sight | `hasLineOfSight(from, to, map, eyeHeight?)` → `boolean` |
| Smooth path | `smoothPath(path, layout, map, samplesPerSegment?)` → `{x,y,z}[]` |
| Offset ↔ cube | `offsetToHex(col, row)` / `hexToOffset(hex)` |
| Impassable cell | Return `Infinity` from `MoveCostFn` |
