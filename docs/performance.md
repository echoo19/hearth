# Performance benchmarks

A headless benchmark harness for the runtime's per-frame cost, independent of
rendering — it steps a `GameSession` (`packages/runtime/src/session.ts`)
wall-clock-free via `session.step()`, so timings measure script/physics/
particle/event simulation only, not pixi, the DOM, or `setTimeout`/rAF jitter.

This doc exists to give Wave E's perf work (broadphase, caching, pooling) an
honest **before** so later tasks have something concrete to compare against.
Tasks 9-11 re-run the harness and update the table below with **after**
numbers — the "Current bottlenecks" section is expected to shrink or change
as they land.

## How to run

```sh
npm run bench            # full run: 120 warmup + 1000 timed frames per scenario
npm run bench -- --smoke # fast harness check: 10 + 10 frames, no thresholds (this is what CI runs)
npm run bench -- --json  # machine-readable output instead of the aligned table
```

`npm run bench` chains `build:packages` first — the harness itself
(`packages/runtime/bench/bench.mjs`) is plain Node ESM that imports
`@hearth/core`/`@hearth/runtime` from their compiled `dist` output, so once
packages are built it can also be run directly with
`node packages/runtime/bench/bench.mjs`.

Every scenario (`packages/runtime/bench/scenarios.mjs`) builds a fully
in-memory project (`MemoryFileSystem`, never touches disk) with a seeded
PRNG (mulberry32) driving initial positions/velocities/tilemap layout, so
every run of a given scenario is byte-identical frame-for-frame — this is
what makes before/after comparisons meaningful rather than noise.

## Baseline

**Machine:** Apple Silicon dev machine (Apple M3 Pro, arm64), macOS (Darwin).
**Node:** v22.17.0. **Mode:** full (120 warmup / 1000 timed frames).

```
scenario        mean ms  p95 ms  max ms   entities  errors
--------------  -------  ------  -------  --------  ------
colliders-100   0.218    0.283   0.502    104       0
colliders-500   4.698    5.105   5.899    504       0
colliders-1500  38.788   41.116  132.068  1504      0
tilemap-arena   4.161    4.495   5.671    201       0
particles       0.106    0.123   0.911    50        0
mixed-horde     12.656   13.501  60.500   804       0
```

(Numbers are one representative run; ±10-20% run-to-run variance is normal
on a dev laptop under thermal/scheduler noise — treat single-digit-percent
deltas between before/after runs as inconclusive, not a regression.)

### Interpretation (60 Hz = 16.6 ms/frame budget)

- **colliders-100** (104 entities: 100 movers + 4 walls) — 0.22 ms mean,
  ~75x under budget. This is comfortably "any small game" territory; not a
  useful stress case on its own, but the floor every other scenario is
  measured against.
- **colliders-500** (504 entities) — 4.7 ms mean, still well under budget
  (~28% of the frame), but 5x colliders-100's mover count produced a ~21x
  slowdown (0.22 → 4.7 ms) — consistent with the mover-vs-mover pass being
  quadratic in mover count (see below): 5x the movers is ~25x the pairs.
- **colliders-1500** (1504 entities) — 38.8 ms mean, **over 2x the 16.6 ms
  budget** — this scenario cannot hit 60 Hz today. p95/max (41/132 ms) show
  it's not just slow but spiky: a single frame can cost >3x the mean. This is
  the clearest evidence of the O(n²) collision cost below; nothing in the
  engine currently supports a 1500-collider scene at interactive framerates.
- **tilemap-arena** (201 entities: 1 tilemap + 200 movers over a 100x60 solid
  grid) — 4.2 ms mean, ~25% of budget. Entity count is low, but the tilemap
  contributes far more than 200 static colliders' worth of obstacle-list
  entries (every non-empty grid cell becomes one; see the tilemapBoxes cost
  below) — this scenario exists specifically to isolate that cost from
  mover-vs-mover.
- **particles** (50 entities, ~12,800 live particles at steady state: 50
  emitters x 256-particle cap) — 0.11 ms mean, negligible. Particle
  simulation is currently the cheapest per-entity system in the engine by a
  wide margin, even saturated at its hard cap — see "unpooled particles"
  below for why this is expected to get *more* visible (not less) once
  collision is no longer the dominant cost.
- **mixed-horde** (804 entities: 800 movers across 3 collision layers + 4
  walls, every mover scripted with a real `onCollision` handler) — 12.7 ms
  mean, ~76% of budget — a survivors-like horde of this size is *just*
  inside budget today, with no headroom for anything else (rendering,
  scripts beyond the one-line handler used here, audio, particles). p95/max
  (13.5/60.5 ms) show occasional frames blow through budget alone.

## Current bottlenecks

These are real, verified costs in the current implementation (not
speculative) — cited by file and function so Tasks 9-11 can point at exactly
what they changed.

- **O(n²) all-pairs collision.** `SceneRuntime.stepPhysics()`
  (`packages/runtime/src/runtime.ts:1599`) checks every mover against every
  static obstacle (`packages/runtime/src/runtime.ts:1732`, one nested loop
  over `movers x obstacles`) and then every mover against every *other*
  mover (`packages/runtime/src/runtime.ts:1750`, `for (let i...) for (let
  j = i+1...)`). There is no broadphase (spatial hash/grid/sweep) — every
  pair gets a `computeShapePush` call regardless of distance. This is the
  single largest cost in colliders-1500 and mixed-horde: mover count going
  up 3x (500 -> 1500) costs ~8.3x the mean frame time.
- **Per-frame `tilemapBoxes` rebuild.** Inside the same obstacle-collection
  loop, `SceneRuntime.stepPhysics()` calls `tilemapBoxes(tilemap,
  worldPos)` (`packages/runtime/src/runtime.ts:1671`, defined in
  `packages/runtime/src/physics.ts:114`) for every enabled solid Tilemap
  entity, *every single frame* — allocating one `Box` object per non-empty
  grid cell from scratch, even though a Tilemap's grid never changes at
  runtime (there's no API that mutates `Tilemap.grid` after scene load).
  For tilemap-arena's ~5,700 non-empty cells (100x60 grid, ~4% scatter +
  border) that's ~5,700 fresh object allocations per frame purely to
  reconstruct data that was identical last frame.
- **`getEntities()` allocation churn.** `SceneRuntime.getEntities()`
  (`packages/runtime/src/runtime.ts:319`) is `this.entities.filter(...)` —
  a fresh array on every call, not a cached view. It's called repeatedly
  within a single frame (`stepPhysics` alone calls it once at
  `runtime.ts:1600` plus indirectly via `getWorldPosition`/`find` calls
  elsewhere in the same step), plus again from `sendPointer`,
  `applyCameraFollow`'s `find`, focus handling, etc. None of these callers
  mutate the destroyed-set mid-frame in a way that would require a fresh
  filter every time — the array could be memoized and invalidated only when
  `destroyedIds`/`entities` actually change.
- **Unpooled particles.** `EmitterState.spawnOne`
  (`packages/runtime/src/particles.ts:66`) does `this.particles.push({...})`
  — a new object literal per particle, every spawn, with no reuse of
  expired particle slots. `enforceCap`
  (`packages/runtime/src/particles.ts:79`) evicts with
  `this.particles.shift()`, an O(n) operation on a plain array (shifts
  every remaining element down) called once per excess particle. At the
  particles scenario's steady state (50 emitters x up to 256 particles,
  rate 300/s) this is thousands of allocations and O(n) shifts per second;
  it doesn't show up in the baseline numbers yet only because collision
  dominates every other scenario's budget — this is exactly the kind of
  cost pooling work (a later Wave E task) is expected to remove.
