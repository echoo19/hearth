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

**Status: Wave E (Tasks 9-11) complete.** See "After Wave E" below for the
final numbers and what each task contributed; "Current bottlenecks" has been
rewritten to reflect what's actually left.

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
colliders-100   0.224    0.300   0.501    104       0
colliders-500   4.702    5.092   5.598    504       0
colliders-1500  39.207   41.317  134.393  1504      0
tilemap-arena   4.126    4.396   5.622    201       0
particles       0.109    0.144   0.483    50        0
mixed-horde     14.317   15.367  17.678   804       0
```

(Numbers are one representative run; ±10-20% run-to-run variance is normal
on a dev laptop under thermal/scheduler noise — treat single-digit-percent
deltas between before/after runs as inconclusive, not a regression.)

**Fix round 1** (see `.superpowers/sdd/task-8-report.md`): the first baseline
had two scenario bugs that made its numbers untrustworthy — `mixed-horde`'s
per-layer `collidesWith` lists never included the arena walls' `default`
layer, so `layersInteract` (which requires both sides to match) never let
the walls contain the horde and it silently dispersed over the run; and
every mover/wall used `restitution: 0.9`, so kinetic energy drained on every
contact instead of staying constant. Both are fixed (movers now include
`'default'` in `collidesWith`, and all mover/wall bodies use
`restitution: 1`), and the table above is the corrected re-run. The most
visible effect is `mixed-horde`: mean rose (12.7 → 14.3 ms) because the
horde now stays genuinely dense for the whole window instead of thinning
out, but p95/max dropped sharply (13.5/60.5 → 15.4/17.7 ms) because that
old max was a transient spike from the still-dense early frames before
dispersal thinned things out — the new numbers are steady state, not a
decaying average.

### Interpretation (60 Hz = 16.6 ms/frame budget)

- **colliders-100** (104 entities: 100 movers + 4 walls) — 0.22 ms mean,
  ~74x under budget. This is comfortably "any small game" territory; not a
  useful stress case on its own, but the floor every other scenario is
  measured against.
- **colliders-500** (504 entities) — 4.7 ms mean, still well under budget
  (~28% of the frame), but 5x colliders-100's mover count produced a ~21x
  slowdown (0.22 → 4.7 ms) — consistent with the mover-vs-mover pass being
  quadratic in mover count (see below): 5x the movers is ~25x the pairs.
- **colliders-1500** (1504 entities) — 39.2 ms mean, **over 2x the 16.6 ms
  budget** — this scenario cannot hit 60 Hz today. p95/max (41/134 ms) show
  it's not just slow but spiky: a single frame can cost >3x the mean. This is
  the clearest evidence of the O(n²) collision cost below; nothing in the
  engine currently supports a 1500-collider scene at interactive framerates.
- **tilemap-arena** (201 entities: 1 tilemap + 200 movers over a 100x60 solid
  grid) — 4.1 ms mean, ~25% of budget. Entity count is low, but the tilemap
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
  walls, every mover scripted with a real `onCollision` handler) — 14.3 ms
  mean, ~86% of budget — a survivors-like horde of this size is close to
  saturating the frame budget today, with very little headroom left for
  anything else (rendering, scripts beyond the one-line handler used here,
  audio, particles). p95/max (15.4/17.7 ms) are tight around the mean —
  this scenario keeps a genuinely dense, arena-contained horde live for the
  entire window (fix round 1 corrected a layer-filter bug that had let the
  horde disperse and thin out mid-run), so unlike colliders-1500 there's no
  large spike: the cost is high but steady, not bursty. `ember-horde`
  (`packages/examples/ember-horde`) is this scenario's playable companion —
  a real, scripted, all-Lua game that spawns waves of enemies up to 300
  concurrent and stays well under budget on the "After Wave E" numbers
  below.

## After Wave E (Tasks 9-11)

**Machine:** same Apple M3 Pro dev machine. **Node:** v22.17.0. **Mode:**
full (120 warmup / 1000 timed frames). Two consecutive runs at Task 11's
HEAD agreed within noise; the table below is the second (representative).

```
scenario        mean ms  p95 ms  max ms  entities  errors
--------------  -------  ------  ------  --------  ------
colliders-100   0.156    0.222   0.639   104       0
colliders-500   0.943    1.389   1.966   504       0
colliders-1500  2.912    3.086   3.341   1504      0
tilemap-arena   0.406    0.548   0.638   201       0
particles       0.094    0.104   0.264   50        0
mixed-horde     2.717    3.220   3.835   804       0
```

| scenario | before (mean ms) | after (mean ms) | speedup | before p95 | after p95 |
|---|---|---|---|---|---|
| colliders-100 | 0.224 | 0.156 | 1.4x | 0.300 | 0.222 |
| colliders-500 | 4.702 | 0.943 | 5.0x | 5.092 | 1.389 |
| **colliders-1500** | **39.207** | **2.912** | **13.5x** | 41.317 | 3.086 |
| tilemap-arena | 4.126 | 0.406 | 10.2x | 4.396 | 0.548 |
| particles | 0.109 | 0.094 | 1.2x | 0.144 | 0.104 |
| **mixed-horde** | **14.317** | **2.717** | **5.3x** | 15.367 | 3.220 |

colliders-1500's max also dropped from a 134ms spike to 3.3ms — the old
number wasn't just slow, it was spiky (see the original "Interpretation"
above); that spikiness is gone along with the O(n²) cost that caused it.
particles and colliders-100 move the least in absolute terms because they
were never the bottleneck — both stay comfortably under budget before and
after, and their small deltas are within the ±10-20% run-to-run noise band
called out above (still directionally consistent with pooling/caching
removing *some* cost, just not a dominant one).

**What each task contributed:**

- **Task 9** (`packages/runtime/src/runtime.ts`): cached `getEntities()`
  (invalidated only when entities/destroyedIds actually change, instead of
  a fresh `.filter()` on every call) and a per-Tilemap collider cache
  (`tilemapBoxes` computed once at load instead of rebuilt from scratch
  every frame). This is most of tilemap-arena's win (4.1 -> ~0.4ms once
  combined with Task 10) and a baseline improvement felt by every scenario.
- **Task 10** (`packages/runtime/src/broadphase.ts`, new): replaced the
  O(n²) mover-vs-obstacle and mover-vs-mover sweeps with a spatial-hash
  broadphase (`SpatialHash.query()`), order-preserving so surviving pairs
  are still visited in the exact naive order (ascending, deduped) — this is
  the overwhelming majority of colliders-1500's and mixed-horde's win. Two
  deliberate deviations from the original brief, both required and both
  test-proven (see `.superpowers/sdd/task-10-report.md`):
  - **Cell size from the 90th-percentile shape extent, not the max.** Using
    the max degenerates when one giant collider (e.g. arena walls) is far
    larger than everything else — it forces a cellSize so large the whole
    scene falls into 1-2 cells, which is O(n²) again *plus* hash overhead
    (measured: colliders-1500 got 2x *slower*, 38.5 -> 77.1ms, with
    max-extent). p90 tracks the typical object size instead; outlier giants
    just span more cells on insert (bounded, see below) and are still found
    by any query that reaches them.
  - **Exact, displacement-tracked requery instead of a fixed inflation
    margin.** A mover can get shoved well past a single cellSize of slack
    in one pair resolution (e.g. ejected out of a giant collider it spawned
    inside). stepPhysics tracks cumulative per-mover push displacement and
    forces a requery whenever accumulated displacement could have escaped
    the original query's cell-inflation radius — checked both mid-loop and
    at loop exit (a real bug during development: checking only mid-loop let
    a push from the *final* candidate in a list escape re-checking). This
    keeps pruning exact for arbitrarily violent same-frame displacement,
    at the cost of two float compares per pair on the hot path.
  - A follow-up fix bounded `SpatialHash.insert`'s per-shape cell count
    (`MAX_INSERT_CELL_SPAN`), routing pathologically large finite AABBs to
    the same always-candidate list non-finite AABBs already used — closing
    a freeze/OOM the naive loops never had.
- **Task 11** (this task): `EmitterState` (`packages/runtime/src/particles.ts`)
  now keeps a per-emitter free-list (`pool: Particle[]`); `spawnOne` reuses
  a detached object (overwriting every field) instead of allocating, and
  both expiry (`splice`) and cap-eviction (`shift`) release the removed
  object into the pool (capped at `maxParticles`) instead of discarding it.
  Live-particle order is untouched (still splice/shift, unchanged), so
  render order and the golden hashes are unaffected — pinned exactly by
  `packages/runtime/tests/particles.test.ts`'s per-particle trajectory
  snapshots. Also: the pixi presentation layer (`packages/runtime/src/pixi/index.ts`)
  now coalesces native `pointermove` events to at most one
  `sendPointer(..., 'move')` dispatch per ticker frame (latest position
  wins; `pointerdown`/`pointerup` flush any pending move first, then stay
  immediate/unthrottled) instead of dispatching every native move event
  (which can fire many times per rendered frame, each re-running
  `resolveUiPositions`/hit-testing over every entity). This doesn't show up
  in the headless bench numbers above (bench never touches the pixi layer),
  but removes redundant UI-position resolution work from real browser
  input; the headless `sendPointer`/playtest path in `runtime.ts` is
  untouched, so drag semantics (UISlider, Wave D playtests) are unaffected.

## Current bottlenecks

Wave E removed every bottleneck identified in the original baseline below
(O(n²) collision, per-frame tilemap rebuild, `getEntities()` churn, unpooled
particles) — none of those costs exist in the current implementation. What's
left, roughly in order of remaining cost:

- **Per-frame spatial-hash rebuild.** `stepPhysics` resets and reinserts
  into two persistent `SpatialHash` instances every frame — one for
  obstacles, one for movers (`packages/runtime/src/runtime.ts`,
  `obstacleBroadphase`/`moverBroadphase`) — rather than incrementally
  updating one across frames. The instances themselves live for the whole
  session (so their internal stamp/scratch buffers don't reallocate), but
  every cell they hold is cleared and rebuilt from scratch each step. This is why colliders-1500 and
  mixed-horde still cost more than colliders-100/tilemap-arena per entity —
  building the hash and running every query is O(n) with a real constant,
  just no longer O(n²). An incremental/persistent hash (insert moved
  entities only) is the next lever if these scenarios need to shrink
  further, but neither scenario is anywhere near the 16.6ms budget anymore
  (2.9ms and 2.7ms respectively — both under 20% of budget).
- **Script dispatch cost.** mixed-horde's 800 movers each run a real
  `onCollision` handler; per-script call overhead (marshaling `ctx`,
  running the JS/Lua VM) is now a proportionally larger slice of the frame
  than it was when collision dominated. Not measured in isolation here —
  the bench harness's own scripted scenario is exactly mixed-horde, so its
  current 2.7ms mean already includes this cost; it just isn't broken out
  from broadphase overhead.
- **Rendering sync.** None of the numbers above touch pixi at all (the
  bench harness is deliberately headless) — `PixiView.syncEntities` and
  friends (`packages/runtime/src/pixi/index.ts`) still walk every live
  entity every tick to keep display objects in sync, and were entirely out
  of scope for this doc's measurements. If a future task wants an "after"
  number for rendering, it needs its own (non-headless) harness.

None of these are urgent: every bench scenario now finishes well under the
16.6ms/frame (60Hz) budget, including colliders-1500 and mixed-horde, which
were the only two scenarios over budget in the original baseline.
