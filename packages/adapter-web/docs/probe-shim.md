# The Hearth probe shim (v1)

The web adapter can play **any** page with a game in it: it opens the page in
headless Chromium, presses real keys, moves a real mouse, takes screenshots and
collects uncaught errors. That tier needs nothing from you and is the floor.

Everything above that floor — *where the player is*, *what level this is*, *did
the coin get collected*, *is this region walkable*, *start the level over* — is
knowledge that only the game has. The shim is the smallest possible way to hand
that knowledge over: one global object, no build step, no imports, no runtime.

The rule the whole system rests on: **a sense you don't provide is declared
absent, never faked.** Detectors that need a missing sense are skipped and say
so in the report, rather than quietly "passing".

## Install

Copy `shim/probe-shim.js` out of `@hearth/adapter-web` into your game and load
it before your game code:

```html
<script src="probe-shim.js"></script>
<script src="game.js"></script>
```

It is *your* file now — no dependency, no version pin, no update treadmill.
The adapter's `PROBE_SHIM_PATH` export points at the reference copy.

You can also skip the file entirely and assign `window.__hearthProbe` yourself;
the adapter only cares about the shape below. The reference shim is worth
copying because it normalizes and error-isolates every hook for you.

## The object

```ts
window.__hearthProbe = {
  version: 1,

  // Always present (the reference shim provides both).
  emit(name: string): void,          // record a game event as it happens
  drainEvents(): string[],           // probe drains the buffer each step

  // All optional. Provide one and its sense turns on; omit it and the
  // capability is declared false.
  actions?: string[],                // input vocabulary the game understands
  axes?: string[],                   // analog axis names the game understands
  scene?(): string,                  // current level/scene identifier
  entities?(): Array<{               // world entities, world units
    id: string, name?: string, tags?: string[],
    x: number, y: number, alive: boolean
  }>,
  navGrid?(): {                      // walkability, world units
    originX: number, originY: number, cellSize: number,
    cols: number, rows: number, solid: boolean[]   // row-major, true = solid
  } | null,
  reset?(): void,                    // restart the episode in place

  // Both or neither. Half the pair declares none of the capability.
  listStates?(): Array<{             // situations the game can be put into
    id: string, label: string, detail?: string
  }>,
  enterState?(id: string): void,     // put it into one of them
}
```

`version` **must** be `1`. Anything else, and the adapter treats the page as
having no shim at all — that's the forward-compatibility escape hatch.

With the reference shim you don't write that object by hand; you call
`configure()`:

```js
window.__hearthProbe.configure({
  actions: ['left', 'right', 'jump'],
  scene: () => currentLevel.name,
  entities: () => [
    { id: 'player', name: 'player', tags: ['player'],
      x: player.x, y: player.y, alive: player.hp > 0 },
    { id: 'goal', name: 'goal', tags: ['objective'],
      x: goal.x, y: goal.y, alive: !goal.taken },
  ],
  navGrid: () => ({
    originX: 0, originY: 0, cellSize: TILE,
    cols: level.cols, rows: level.rows,
    solid: level.tiles.map((t) => t.blocks),   // row-major, true = unwalkable
  }),
  reset: () => startLevel(currentLevel.name),
});
```

`configure()` may be called more than once; each call replaces only the fields
it passes. Hooks are wrapped: one that throws degrades that single sense (empty
list, `null` scene) instead of taking down the run.

## Which bots can play

What you declare decides whether a playtest is a bot pressing buttons at random
or a bot trying to finish your game.

| You provide | Who plays | What they can do |
| --- | --- | --- |
| *(nothing)* | `idle`, `mash` | `mash` presses random buttons. It finds crashes and dead controls; it will not clear a pit except by accident. |
| `entities()` | `+ seek` | `seek` steers straight at the entity tagged `objective` (or a target you name) and mashes when it stops getting closer. **No pathfinding**: it cannot solve a maze or round a C-shaped wall, and the report marks such a run `mode: "direct"`. |
| `entities()` + `navGrid()` | `+ wander`, full `seek` | `seek` paths to its target over the walkable cells instead of walking at it. `wander` explores the cells it has not visited, which is what turns up sealed-off regions and unreachable pickups. |

Two things follow from that table:

- Tag the thing the player is meant to reach with `tags: ['objective']`. That is
  the ref `seek` aims at when nobody names a target, so tagging it is the whole
  setup step.
- `navGrid()` is the difference between "the bot walked at the exit" and "the
  bot found a route to the exit". A `direct` seek that never arrives means the
  BOT could not get there, not that a player cannot.

## What each hook unlocks

| You provide | Capability | What it buys |
| --- | --- | --- |
| `entities()` | `senses.entities` | `seek`, position-based objectives, movement/stuck detection, wall-bump analysis, entity coverage keys |
| `drainEvents()` + `emit()` | `senses.events` | event objectives ("did `goal` ever fire?"), progress signals |
| `scene()` | `senses.scenes` | scene-change novelty, per-level attribution |
| `navGrid()` | `senses.nav` | `wander`, pathfinding `seek`, sealed-region and reachability checks |
| `reset()` | fast `senses.reset` | cheap episode restarts (without it, reset is a full page reload — still valid, just slow) |
| `listStates()` + `enterState()` | `senses.states` | your private tester can ask to be put somewhere instead of replaying the opening every session |
| *(nothing)* | `senses.errors`, `senses.screenshot`, slow `senses.reset` | crash detection, black-screen and pixel-novelty checks, evidence shots |

### `emit(name)`

Call it at the moment something happens, from anywhere in your game:

```js
function jump() { vy = -520; window.__hearthProbe.emit('jump'); }
```

The shim buffers names (bounded at 512, oldest dropped) and the probe drains
them once per sample step, so the events you emit between two steps arrive
together in that step's `newEvents`. Names are free-form; keep them short and
stable — they're what objectives are written against. Emitting is safe when no
probe is watching.

### `entities()`

Called once per query, so keep it cheap — build the array from live objects,
don't allocate a world snapshot. Coordinates are **world units** in whatever
space your game thinks in; nothing downstream assumes pixels, an origin corner,
or a Y direction. Include the things a player cares about (the avatar,
objectives, hazards, enemies), not every particle. `alive: false` is how you say
"destroyed/disabled but still worth reporting".

`id` must be stable across calls — it's how movement is tracked between steps.
`tags` are for the probe's `findEntity(ref)` lookup, which resolves **id first,
then exact name, then tag**.

### `scene()`

Any stable string per level/screen/state (`'level1'`, `'menu'`, `'boss'`).
A change is treated as progress.

### `navGrid()`

Row-major `solid[]` of length `cols * rows`, `true` meaning unwalkable. Return
`null` when the current scene has no meaningful grid — the adapter probes the
grid once at startup and declares `senses.nav` false if it gets `null`, so a
game that only sometimes has a grid stays honest.

You do not need a tile engine to have one. Any coarse occupancy answer works:
walk your solid rects and stamp the cells they cover, sample your collision
query on a grid, or hand-write the row of booleans for a small level. Cells can
be as big as the avatar; the grid is used for routing and coverage, not physics.

```js
navGrid: () => {
  const cellSize = 32;
  const cols = Math.ceil(WORLD_W / cellSize);
  const rows = Math.ceil(WORLD_H / cellSize);
  const solid = new Array(cols * rows).fill(false);
  for (const wall of walls) {
    for (let r = Math.floor(wall.y / cellSize); r <= Math.floor((wall.y + wall.h) / cellSize); r++) {
      for (let c = Math.floor(wall.x / cellSize); c <= Math.floor((wall.x + wall.w) / cellSize); c++) {
        if (r >= 0 && r < rows && c >= 0 && c < cols) solid[r * cols + c] = true;
      }
    }
  }
  return { originX: 0, originY: 0, cellSize, cols, rows, solid };
}
```

Without it, `wander` does not run at all (there is no frontier to explore) and
`seek` runs in `direct` mode: it walks the straight line to its target. Both
facts land in the report, per policy, rather than being inferred.

### `reset()`

Put the game back to the start of the episode *in the page*, without a reload:
respawn the player, reset the score, reload the level. The shim clears the event
buffer around your reset. If you don't provide it, the probe reloads the whole
page instead — correct, just an order of magnitude slower per episode.

### `listStates()` / `enterState(id)`

Where your game can put itself, and how. Provide both or neither: a list
nothing can act on leaves `senses.states` false.

The names are yours. Nothing outside your game reads them for meaning, so a
state is whatever you can restore, and the examples below are all the same call
as far as Hearth is concerned.

```js
// A management sim
listStates: () => [
  { id: 'y1-spring', label: 'Year one, the spring intake' },
  { id: 'y3-deficit', label: 'Year three, already in deficit',
    detail: 'two departments unstaffed' },
],
enterState: (id) => loadScenario(id),
```

```js
// A team shooter
listStates: () => [
  { id: 'mid-6min', label: 'Mid lane, six minutes in' },
  { id: 'last-stand', label: 'Defending the final point' },
],
enterState: (id) => setupSituation(id),
```

`label` is what a person reads in the report, so write it for them. `detail` is
for anything they would want alongside it, such as the state of the economy or
which abilities are unlocked. An entry with no `id` is dropped rather than given
one.

Your tester is offered these and may ask for one. It is never told to, because
the opening of a game is the part a first session is most valuable for.

Anything it sees after being put somewhere is recorded as **placed** rather than
played, and the report says so. Being dropped into the audit week tells you
about the audit week; it tells you nothing about whether anyone can get there.

### `actions` / `axes`

The names your game actually responds to. The adapter maps action names to
keyboard codes (default: `left`/`right`/`up`/`down` → arrows, `jump` → `Space`,
`action` → `KeyZ`; override with `actionKeys`). When you declare `actions`, the
adapter **narrows** its declared input vocabulary to the intersection of your
list and the names it has keys for — so a bot never tries to press something
your game ignores, and never advertises an action nobody can send. Declare
`axes` the same way, alongside `<axis>+` / `<axis>-` entries in `actionKeys`.

## Detection and timing

After `load` and one animation frame, the adapter waits up to one second for
`window.__hearthProbe` to appear, then reads the shape once. So: install the
shim at script-evaluation time, and call `configure()` no later than your first
frame. Hooks may be added later, but capabilities are latched at detection
(and re-latched after a reload-based `reset()`).
