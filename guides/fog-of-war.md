# Fog of War

`FogData` tracks per-cell visibility using integer reference counts. Multiple overlapping sources (units, abilities, revealed areas) are handled automatically — a cell stays visible as long as at least one source is covering it. The state is uploaded to a GPU texture that all chunk shaders sample to dim or hide cells.

---

## Setup

```ts
import { FogData, ChunkManager } from '@loyalj/hex-world';

const fog    = new FogData(map.width, map.height);
const chunks = new ChunkManager({ ..., fogData: fog });
```

Pass the same `FogData` instance to both `ChunkManager` and `UnitManager`. You do not need to call `fog.update()` yourself — `chunks.update(camera, dt)` does it.

### Reveal animation speed

The optional third argument is `revealDuration` in seconds — how long a newly-explored cell takes to fade in on first discovery:

```ts
const fog = new FogData(map.width, map.height, 0.8);   // 0.8 s fade (default 0.5)
const fog = new FogData(map.width, map.height, 0);      // instant reveal
```

Pass `dt` (elapsed seconds) to `chunks.update` each frame so the animation advances:

```ts
function animate(now: number): void {
  requestAnimationFrame(animate);
  const dt = (now - last) / 1000;
  last = now;

  chunks.update(camera, dt);   // dt drives the reveal fade
  manager.update(dt);
  renderer.render(scene, camera);
}
let last = performance.now();
animate(last);
```

---

## Visibility reference counting

A cell is visible while its reference count is ≥ 1. Call `increaseVisibility` when a source starts covering a cell, and `decreaseVisibility` when it stops. Mismatched calls will corrupt the count, so always pair them.

```ts
// Reveal cells within BFS range of a point
function revealAround(col: number, row: number, range: number): void {
  const cells = getVisibleCells(offsetToHex(col, row), range, map);
  for (const c of cells) {
    const oc = hexToOffset(c);
    if (map.inBounds(oc.col, oc.row)) fog.increaseVisibility(oc.col, oc.row);
  }
}

// Withdraw those reveals (e.g. unit moved away)
function hideAround(col: number, row: number, range: number): void {
  const cells = getVisibleCells(offsetToHex(col, row), range, map);
  for (const c of cells) {
    const oc = hexToOffset(c);
    if (map.inBounds(oc.col, oc.row)) fog.decreaseVisibility(oc.col, oc.row);
  }
}
```

### What the three channels carry

The GPU texture is RGBA; shaders read:

| Channel | Value | Meaning |
|---|---|---|
| R | 0 or 255 | Currently visible (reference count ≥ 1) |
| G | 0 or 255 | Ever explored (set on first reveal; never decreases) |
| B | 0–255 | Reveal fade-in progress (animates 0→255 on first exploration) |

R going from 0→255 makes a cell **become** visible. G staying 255 permanently marks explored cells. B drives the fade shader so newly-seen cells don't snap in harshly.

---

## Visibility modes

Two independent toggles control what happens to cells the player can't currently see:

```ts
// Hide cells the player has never seen (fully black)
chunks.setHideUnexplored(true);

// Dim cells seen before but not currently visible (desaturated/darkened)
chunks.setDimExplored(true);

// Both on — standard strategy-game fog
chunks.setHideUnexplored(true);
chunks.setDimExplored(true);

// Both off — the terrain material ignores fog entirely (useful for debug)
chunks.setHideUnexplored(false);
chunks.setDimExplored(false);
```

Toggle at any time — the change takes effect immediately on the next rendered frame.

---

## Unit integration

Pass `fogData` to `UnitManager` and set `fogRevealRange > 0` on each unit. The manager wires `increaseVisibility` / `decreaseVisibility` to `onCellEnter` automatically, so you don't track cells manually for moving units:

```ts
import { HexUnit, UnitManager } from '@loyalj/hex-world';

const manager = new UnitManager({ scene, map, layout, fogData: fog });

const scout = new HexUnit({
  col: 10, row: 10,
  travelSpeed:    4,
  fogRevealRange: 4,   // BFS radius this unit reveals
});

manager.addUnit(scout, scoutMesh);
// Fog reveal at (10, 10) is applied immediately on addUnit.
// As the unit moves, cells enter and leave its reveal range automatically.
```

### Multiple units

Each unit independently increments the reference count for every cell it covers. A cell at the overlap of two units keeps its count at 2; when one unit leaves the count drops to 1 and the cell stays visible. Only when the last unit leaves does the count reach 0 and R go dark.

---

## Revealing areas non-unit sources

Some games reveal permanent areas (scouted locations, towers, map expansions). Use `increaseVisibility` directly — just don't call the matching `decreaseVisibility` if you want the reveal to be permanent:

```ts
// Permanently reveal a radius around a built structure
function revealPermanent(col: number, row: number, range: number): void {
  const cells = getVisibleCells(offsetToHex(col, row), range, map);
  for (const c of cells) {
    const oc = hexToOffset(c);
    if (map.inBounds(oc.col, oc.row)) fog.increaseVisibility(oc.col, oc.row);
  }
  // No matching decreaseVisibility — these stays revealed forever
}
```

This also means the cell is permanently explored (G=255) and contributes to the reference count. If the structure is later destroyed, you can track the cells it covered and call `decreaseVisibility` for each one to un-reveal them.

---

## Starting a new game

Call `fog.reset()` to zero out all visibility and exploration state. Then immediately re-apply any standing reveals (units, structures) so the reference counts are accurate:

```ts
// New game or map reload
fog.reset();

// UnitManager can re-apply all unit reveals in one call
manager.reapplyFog();

// Re-apply any non-unit permanent reveals yourself
for (const structure of placedStructures) {
  revealPermanent(structure.col, structure.row, structure.range);
}
```

If you call `fog.reset()` without re-applying unit reveals, `UnitManager` will still track each unit's last-revealed cells and the reference counts will be wrong the next time a unit moves.

---

## Toggling fog at runtime

Detach or swap the fog data on a live scene:

```ts
// Disable fog entirely (vVisibility → 1.0 everywhere)
chunks.setFogData(null);

// Re-enable with the same FogData
chunks.setFogData(fog);

// Swap to a fresh FogData (e.g. different map loaded)
const newFog = new FogData(newMap.width, newMap.height);
chunks.setFogData(newFog);
```

---

## Quick reference

| Task | API |
|---|---|
| Create | `new FogData(width, height, revealDuration?)` |
| Wire to renderer | `ChunkManager({ fogData: fog })` |
| Wire to units | `UnitManager({ fogData: fog })` + `unit.fogRevealRange` |
| Reveal cell | `fog.increaseVisibility(col, row)` |
| Hide cell | `fog.decreaseVisibility(col, row)` |
| Advance animation | `chunks.update(camera, dt)` (pass dt each frame) |
| Hide unexplored | `chunks.setHideUnexplored(true)` |
| Dim explored | `chunks.setDimExplored(true)` |
| Reset all state | `fog.reset()` then `manager.reapplyFog()` |
| Toggle fog off | `chunks.setFogData(null)` |
