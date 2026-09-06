# Pathfinding and Movement

The library provides A*, flow fields, flood-fill movement range, BFS visibility, line-of-sight, and Catmull-Rom path smoothing. All algorithms accept a `MoveCostFn` that your game supplies — the library never reads terrain or unit data directly, so your rules stay in your code.

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

## Flow fields (many units, one destination)

`findPath` is one search per unit. When a whole army converges on a rally point — or a horde chases one target — that is the wrong shape: every search re-derives the same information about the same terrain. A **flow field** inverts it. One Dijkstra sweep runs *outward from the destination* and records, for every cell on the map, the cost to reach the goal and which neighbour to step to next. After that, each unit's next move is an array lookup.

```ts
import { computeFlowField, offsetToHex } from '@loyalj/hex-world';

const field = computeFlowField(offsetToHex(rallyCol, rallyRow), cost, map);

for (const unit of army) {
  const path = field.path(offsetToHex(unit.col, unit.row));
  if (path && path.length > 1) unit.travel(path);
}
```

`field.path()` returns exactly what `findPath` returns — start first, goal last, both inclusive, `null` if unreachable — so it drops into `HexUnit.travel()` unchanged.

### When to use which

| | `findPath` | `FlowField` |
|---|---|---|
| Cost | One A* per unit | One Dijkstra per **destination** |
| Best for | One unit, one goal; path previews | Many units → one goal; chase/rally/retreat AI |
| Per-unit read | The whole search | O(1) array lookup |
| Covers | Just the route | Every cell on the map |

A single unit clicking a destination should still use `findPath` — A* stops as soon as it reaches the goal, while the field explores everything. The crossover is roughly "more than a handful of units heading to the same place".

### Re-targeting without reallocating

`computeFlowField` allocates its buffers. If the destination changes every turn or every frame, build the field once and call `compute` on it — the storage is reused, so re-targeting allocates nothing.

```ts
import { FlowField } from '@loyalj/hex-world';

const field = new FlowField(map);        // 13 bytes per map cell, allocated once

function onOrderIssued(col: number, row: number): void {
  field.compute(offsetToHex(col, row), cost);
  for (const unit of army) {
    const path = field.path(offsetToHex(unit.col, unit.row));
    if (path && path.length > 1) unit.travel(path);
  }
}
```

### The cost function runs in the direction of travel

The search expands outward from the goal, but the move a unit will actually make runs the other way. `costFn` is called accordingly: when the sweep reaches cell `X` from an already-settled cell `Y`, it asks `costFn(X, Y)` — the step the unit will take, not the step the search took.

Symmetric cost functions (the common case) never notice. Asymmetric ones get the right answer for free:

```ts
// Climbing costs more than descending. No special handling needed.
const slopeCost: MoveCostFn = (from, to) => {
  const f = hexToOffset(from), t = hexToOffset(to);
  const climb = map.getElevation(t.col, t.row) - map.getElevation(f.col, f.row);
  return climb > 0 ? 1 + climb : 1;
};
```

One consequence worth knowing: a cell your cost function refuses to let anyone *enter* still gets a direction if it has a passable way *out*. A unit spawned or shoved onto a wall is handed a route off it rather than being stranded. Nothing routes *through* the cell, because the step into it is still rejected.

### Several goals

Pass an array and every cell flows to whichever goal is cheapest *from that cell*. The watershed between them falls out of the search — one field serves "retreat to the nearest fort".

```ts
const field = computeFlowField(
  forts.map(f => offsetToHex(f.col, f.row)),
  cost,
  map,
);
```

### Bounding the sweep

`maxCost` stops the expansion once the accumulated cost passes a threshold. Cells beyond it report `Infinity` and no direction, exactly as if unreachable — which is what you want when only units within a known distance will ever consult the field, and what makes a field over a continent-sized map affordable.

```ts
const field = computeFlowField(goal, cost, map, { maxCost: 40 });
```

### Steering: `flowVector`

`next()` gives the discrete next cell. `flowVector()` gives a normalised world-space `(x, z)` bearing, and it is **not** just `next()` converted to world space: it blends every neighbour the field descends into, weighted by how much cost each one saves.

That blend is what makes a crowd read as a crowd. Units crossing open ground aim at the true bearing instead of snapping to one of six axes, and a column meeting an obstacle splits around both sides rather than filing through a single hex. Edges the cost function rejects are excluded, so a cell whose cheap-looking neighbour sits across an impassable cliff never steers into it.

```ts
const v = field.flowVector(layout, offsetToHex(unit.col, unit.row));
if (v) {
  unit.worldX += v.x * speed * dt;
  unit.worldZ += v.z * speed * dt;
}
```

Use `path()` + `travel()` for cell-locked movement, `flowVector()` when units move continuously and you want them to spread.

### Reading the field

```ts
field.cost(hex);            // cost to the nearest goal, Infinity if unreachable
field.costAt(col, row);     // same, in offset coordinates
field.isReachable(hex);     // boolean
field.direction(hex);       // 0–5 index into HEX_DIRECTIONS, -1 at a goal or unreachable
field.next(hex);            // the next cell, or null
field.path(hex);            // full HexCoord[] route, or null
field.reachedCount;         // cells the last sweep settled
field.goals;                // the in-bounds goals it ran from

// Debug overlay — scans the whole grid, so keep it out of per-unit code.
field.forEachReached((col, row, cost, direction) => drawArrow(col, row, direction));
```

`direction()` returns `-1` both at a goal and on an unreachable cell. Call `cost()` to tell them apart: a goal costs `0`.

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

## Movement domains, ports, and bridges

Liquids are terrain like any other to the pathfinder — the cost function decides who may enter them. `createDomainCost` writes that decision once per unit type:

```ts
import { createDomainCost, setPort, hasBridge } from '@loyalj/hex-world';

// Which terrains float a ship. A lava shore is not a harbour, so this is
// yours to say — world.isWater covers every liquid; pick water alone here.
const isLiquid = (t: number) => t === TerrainType.Water;

const shipCost = createDomainCost({ map, isLiquid, domain: 'naval' });
const armyCost = createDomainCost({
  map, isLiquid, domain: 'land',
  // Wading a river is slow — unless a road bridges it, in which case the
  // chunk builder has spanned the cell with a deck and it is an ordinary step.
  landCost: (col, row) => map.hasRiver(col, row) && !hasBridge(map, col, row) ? 3 : 1,
});
const raidersCost = createDomainCost({
  map, isLiquid, domain: 'amphibious',
  embarkCost: 1,          // added to every step that crosses the shoreline
  embarkAt:   'shore',    // or 'ports': only through a port cell
});
```

The three domains:

| Domain | Land | Liquid | Shoreline |
| --- | --- | --- | --- |
| `land` | `landCost` | impassable | — |
| `naval` | impassable, except **port** cells to dock in | `navalCost` | a docked ship may only put back out to sea |
| `amphibious` | `landCost` | `navalCost` | `+ embarkCost`, anywhere or only at ports |

The returned function is a plain `MoveCostFn`, so it drops into `findPath`, `getMovementRange`, and `computeFlowField` unchanged.

### Ports

A port is a shore cell — land with a liquid neighbour — flagged in the map's metadata channel, so it serializes with the map:

```ts
setPort(map, col, row, true, isLiquid);   // false: not shore, refused
isPort(map, col, row);
listPorts(map);
```

An editor should write the flag through its transaction (`tx.setCellData(col, row, PORT_KEY, true)`) so it is undoable with everything else.

### Embark and disembark on the unit

Give a unit its domain and the liquid predicate and it reports its own crossings:

```ts
const raiders = new HexUnit({ col, row, domain: 'amphibious', isLiquid });
raiders.onEmbark    = () => { walker.visible = false; boat.visible = true; };
raiders.onDisembark = () => { walker.visible = true;  boat.visible = false; };
// or, on the manager, for every unit at once:
unitManager.events.on('unitEmbark', ({ unit, col, row }) => splash(col, row));
```

`unit.embarked` is set from the spawn cell on the first update (silently — spawning is not a crossing) and flipped at each shoreline, with the callback fired **before** `onCellEnter` for that cell. `isLiquid` also serves as the unit's surface predicate when none is given, so a ship floats at the water surface rather than standing on the sea bed.

### Bridges

Roads and rivers both run from a cell's centre out through its edges, so a road crosses a river *inside* a cell, bank to bank. `riverBanks(map, col, row)` names the banks (`-1` on the two river edges, `0` and `1` elsewhere; `null` at a source, mouth, confluence, or hairpin) and `hasBridge` is true when both banks carry road — the cell the chunk builder spans with a deck, and the cell your land price should treat as dry. `generateRoads` crosses river cells by default; `bridges: false` stops at the bank.

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
| Many units, one goal | `computeFlowField(goals, costFn, map, opts?)` → `FlowField` |
| Re-target a field | `field.compute(goals, costFn, opts?)` (reuses buffers) |
| Route out of a field | `field.path(from)` → `HexCoord[] \| null` |
| Steering direction | `field.flowVector(layout, hex)` → `{x, z} \| null` |
| Movement range | `getMovementRange(center, budget, costFn, map)` → `HexCoord[]` |
| Visibility radius | `getVisibleCells(center, range, map)` → `HexCoord[]` |
| Line of sight | `hasLineOfSight(from, to, map, eyeHeight?)` → `boolean` |
| Smooth path | `smoothPath(path, layout, map, samplesPerSegment?)` → `{x,y,z}[]` |
| Offset ↔ cube | `offsetToHex(col, row)` / `hexToOffset(hex)` |
| Impassable cell | Return `Infinity` from `MoveCostFn` |
