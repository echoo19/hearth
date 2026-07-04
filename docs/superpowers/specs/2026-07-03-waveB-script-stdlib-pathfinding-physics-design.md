# Wave B — Script stdlib (math/events) + Pathfinding + Physics v2 (design)

Date: 2026-07-03. Ships as **v0.5.0**.

Scope, from the v0.3+ backlog (Wave B): `ctx.math`, `ctx.events` (+ the
`onEvent` hook and playtest event recording), grid pathfinding
(`ctx.scene.findPath` + `hearth inspect path`), and physics v2
(mass/restitution/friction, named collision layers, one-way platforms,
circle-accurate resolution).

Standing rules apply: agent-native first (schemas + commands + headless
asserts before editor UI); no engine chrome in shipped games; every ctx
addition is identical across JS and Lua and lands in `hearth inspect api
--json`, CTX_API, and the generated AGENTS.md.

Jake granted end-to-end autonomy for this wave ("lets do the next wave end
to end using subagents as needed"); design decisions below were made under
that grant, following Wave A precedent.

## 1. `ctx.math` — pure helpers (JS + Lua identical)

A new namespace of pure functions. All vec2 values are plain `{x, y}`
objects (Lua tables cross the wasmoon boundary as such already — same as
`ctx.scene.spawn`). No mutation of inputs; every function returns a fresh
value. Angles are degrees, engine convention (0 = +x, 90 = +y/down).

- `vec2(x, y) -> Vec2` — convenience constructor (missing args default 0).
- `add(a, b) -> Vec2`, `sub(a, b) -> Vec2`, `scale(v, s) -> Vec2`.
- `dot(a, b) -> number`, `length(v) -> number`, `distance(a, b) -> number`.
- `normalize(v) -> Vec2` — zero vector returns `{x: 0, y: 0}`.
- `angle(v) -> number` — degrees; zero vector returns 0.
- `fromAngle(degrees, length?) -> Vec2` — length defaults to 1.
- `lerp(a, b, t) -> number` — scalar; `t` is NOT clamped.
- `lerpVec(a, b, t) -> Vec2` — componentwise lerp; `t` NOT clamped.
- `clamp(x, min, max) -> number`.
- `hexToRgb(hex) -> {r, g, b}` — channels 0–255 ints; accepts `#rgb`,
  `#rrggbb`, `#rrggbbaa` (alpha ignored); invalid input returns
  `{r: 255, g: 255, b: 255}` plus a warn log (once per script state).
- `rgbToHex(r, g, b) -> string` — channels clamped to 0–255 and rounded;
  returns `#rrggbb` lowercase.
- `colorLerp(hexA, hexB, t) -> string` — lerp in RGB space, `t` clamped to
  [0, 1]; invalid hex behaves like hexToRgb (white + warn).

Implementation: a pure module `packages/runtime/src/ctxMath.ts` exporting a
single frozen `CTX_MATH` object; `makeContext` attaches it as `ctx.math`
(shared instance — it is stateless except the warn hook, which is injected
per context). CTX_API entries + docs for every function.

## 2. `ctx.events` — global pub/sub + `onEvent` hook

Scene-wide, deterministic, synchronous event bus owned by the runtime
(reset on scene switch — event subscriptions do not survive scene loads).

Script surface (JS + Lua identical):

- `ctx.events.emit(name: string, data?: unknown): void` — deliver
  synchronously, immediately, to: (1) every live `ctx.events.on`
  subscription for `name` in subscription order, then (2) every live
  script's `onEvent(ctx, name, data)` hook in entity creation order (the
  same order `onUpdate` runs). The emitting entity is NOT excluded — it
  hears its own events like everyone else. `data` must be JSON-safe
  (objects/arrays/strings/numbers/booleans/null); it is passed by
  reference between JS scripts and converted at the Lua boundary exactly
  like other ctx payloads.
- `ctx.events.on(name: string, fn: (data) => void): string` — subscribe;
  returns a cancel id. Subscriptions are owned by the subscribing entity
  and are removed automatically when the entity is destroyed or the scene
  switches.
- `ctx.events.off(id: string): void` — unsubscribe by id; unknown ids are
  a no-op.
- New lifecycle hook `onEvent(ctx, name, data)` — zero-setup listening;
  fires for every emitted event. Same error handling as other hooks
  (routed to script errors, disable after MAX_CONSECUTIVE_SCRIPT_ERRORS).

Determinism + safety rules:

- Delivery is synchronous at the emit call site. Handlers may emit; nested
  emits are allowed to depth 8, beyond which the emit is dropped with a
  warn log ("event cascade too deep").
- Handlers subscribed during a delivery do not receive the in-flight
  event. Handlers unsubscribed during a delivery are skipped if not yet
  called.
- An entity destroyed mid-delivery stops receiving (its remaining
  subscriptions/hooks are skipped).

Headless observability:

- The runtime records emitted events two ways: an exact per-name counter
  (a plain `Map<string, number>`, unbounded — names are few) used by
  assertions, and a recorded event LIST
  `{ frame: number, name: string, data?: unknown }[]` (data JSON-cloned
  at record time) capped at 200 entries with a truncation flag — same
  spirit as log caps. Assertions never depend on the capped list.
- Playtest + smoke reports gain an `events` array (the capped list) and
  an `eventCounts` map (the exact counters).
- New playtest step `assertEventCount`:
  `{ assertEventCount: { event: string, equals?: number, min?: number,
  max?: number } }` (at least one bound required — same refine pattern as
  `assertParticleCount`). Reads the exact per-name counter (total emits
  of that name from run start to the step's frame position).

## 3. Pathfinding — grid A*

### Core module (pure, no runtime dependency)

`packages/core/src/pathfinding.ts` — pure grid logic so the CLI/MCP can
answer reachability questions without booting a runtime:

- `buildNavGrid(inputs: NavGridInput): NavGrid`
  - `NavGridInput`: `{ cellSize: number; solids: Rect[] }` where `Rect` is
    `{ x, y, width, height }` world-space AABBs.
  - The grid's bounds are the AABB union of all solids expanded by 2 cells
    of padding; `buildNavGrid` callers additionally expand bounds so the
    from/to query points are inside. A cell is solid when its cell rect
    overlaps any solid rect by more than 1% of the cell area (the margin
    guards floating-point edge contact from marking neighbors solid).
  - Hard cap: grids larger than 512×512 cells throw a descriptive error
    (surfaced as a command error / script warn) — pathological worlds
    should fail loudly, not hang.
- `findPath(grid: NavGrid, from: Vec2, to: Vec2, opts?: { diagonals?:
  boolean }): Vec2[] | null`
  - A* over walkable cells. 4-directional by default; `diagonals: true`
    adds the 4 diagonals with cost √2, and a diagonal step is only allowed
    when BOTH adjacent orthogonal cells are walkable (no corner cutting).
  - Deterministic: neighbor expansion order fixed (N, E, S, W, NE, SE,
    SW, NW), heuristic Manhattan (octile when diagonals), ties broken by
    lower g then insertion sequence.
  - Returns world-space cell centers from the start cell to the goal cell
    inclusive (start == goal cell → single-element path). Returns null
    when from/to lie in solid cells or no path exists.

### Scene geometry → nav grid (shared assembly)

A shared helper (`collectNavSolids`) turns scene data into `Rect[]`:
every solid Tilemap contributes one rect per non-empty cell; every entity
with a Collider and a static body (no PhysicsBody, or `bodyType ===
'static'`), excluding triggers, contributes its shape's AABB (circles and
polygons rasterize conservatively as their AABB). Dynamic and kinematic
bodies are NOT obstacles — paths route around the level, not around
movers. `cellSize` = the first solid Tilemap's `tileSize` (scene entity
order), else 32.

### Runtime API

- `ctx.scene.findPath(from: Vec2, to: Vec2, opts?: { diagonals?: boolean })
  -> Vec2[] | null` — builds the grid from LIVE world positions of solid
  tilemaps and static colliders, memoized per frame (any number of calls
  in one frame reuse the grid; it rebuilds next frame). Grid-size errors
  become a warn log + null.

### CLI / MCP

- `hearth inspect path <scene> --from x,y --to x,y [--diagonals] [--json]`
  — new core command `inspectPath` over the AUTHORED scene document
  (design-time positions). JSON result: `{ found: boolean, path: Vec2[] |
  null, cells: number, cellSize: number }`. Human output prints waypoint
  count + the first few waypoints.
- MCP tool `inspect_path` wrapping the same command (same pattern as the
  other inspect tools).

## 4. Physics v2

### New PhysicsBody fields (defaults reproduce v1 exactly)

- `mass: number` — positive, default 1. Mover-vs-mover overlap resolves
  split inversely proportional to mass: a moves `push * mb/(ma+mb)`, b
  moves the rest (equal masses → the old 50/50 split). Kinematic movers
  behave as infinite mass in the split (dynamic partner absorbs the whole
  push — unchanged v1 behavior).
- `restitution: number` — 0–1, default 0. On non-trigger contact
  resolution, the pushed body's velocity component INTO the contact
  (`v·n < 0`) becomes `-e * (v·n)` instead of 0, where `e` is the pair's
  combined restitution = `max(a, b)`. Bounce threshold: when the incoming
  normal speed is below 20 px/s, `e` is treated as 0 so bodies come to
  rest instead of micro-bouncing. `e = 0` reproduces the old
  `cancelVelocityAlong` exactly.
- `friction: number` — 0–1, default 0. On non-trigger contact resolution,
  the pushed body's tangential velocity is scaled by
  `max(0, 1 - μ * FRICTION_DAMPING * dt)` with `FRICTION_DAMPING = 10`
  and pair friction `μ = max(a, b)`. `μ = 0` leaves tangential velocity
  untouched (old behavior).
- Obstacles without a PhysicsBody (static colliders, tilemap cells) have
  implicit restitution 0 and friction 0 — the pair combine being `max`
  means a bouncy ball still bounces off a plain tilemap floor.
- `cancelVelocityAlong` is replaced by a `resolveContactVelocity(velocity,
  nx, ny, restitution, friction, dt)` that degenerates to it at (0, 0).

### Collision layers (named strings, no bitmasks)

Collider gains:

- `layer: string` — default `'default'`. Free-form name.
- `collidesWith: string[]` — default `['*']` (everything).

A pair interacts (resolution, contacts, trigger events — everything) only
when `a.collidesWith` matches `b.layer` AND `b.collidesWith` matches
`a.layer`, where `'*'` matches any layer. Filtered pairs produce no
contact and no events. Tilemap obstacles are always layer `'default'`
with `collidesWith ['*']` (Tilemap has no filtering fields).
Defaults on both sides → every pair passes → v1 behavior unchanged.

Validation (validate.ts): warning when `collidesWith` is an empty array
(entity collides with nothing); warning when a non-`'*'` `collidesWith`
entry names a layer no Collider in the project uses.

### One-way platforms

Collider gains `oneWay: boolean` — default false. When the OBSTACLE side
of a resolution has `oneWay: true`, the contact only counts when both:

- the push direction on the mover is within 45° of straight up
  (`push.ny < -0.707`; +y is down), and
- the mover's velocity.y ≥ 0 at resolution time (falling or resting, not
  jumping up through).

Otherwise the pair produces no contact and no events this frame (the
mover passes through cleanly). The rule is evaluated per pushed body:
in mover-vs-mover contacts each side checks the other's `oneWay`.
Triggers ignore `oneWay` (they never resolve; they still report).

### Circle-accurate resolution (intended behavior change)

`computeShapePush` gains true circle handling for the two pairs that
still use AABBs in v1:

- circle vs circle: push along the center-to-center axis, amount
  `ra + rb - distance` (concentric circles push +x by `ra + rb`).
- circle vs box: closest point on the box to the circle center; push along
  that axis (center inside the box falls back to the AABB axis push).

Polygon pairs and box-box keep their existing math. This changes rolling/
corner behavior for existing circle colliders — example playtest
expectations get RE-BAKED from probe runs (never hand-computed; Wave A
lesson).

### Debug draw

The debug overlay (Wave A) draws one-way colliders with a small upward
arrow at the shape's top edge, and renders filtered/one-way state with the
same collider outline color (no new colors).

## 5. Editor (`apps/editor`)

- Inspector: `mass`/`restitution`/`friction` numeric fields and `oneWay`
  boolean render via existing typed controls for free. `Collider.layer`
  renders as a text field (existing string control). `collidesWith` gets a
  **StringListField** — a typed list control matching Vec2ListField's
  styling (add/remove rows, one string per row, `'*'` placeholder hint) —
  never a raw JSON textarea (Jake's uniformity bar).
- No new gizmos (one-way arrow lives in the debug overlay, which the
  preview toolbar already toggles).

## 6. Docs, examples, tests, release

- Docs truth pass: scripting.md (ctx.math, ctx.events, onEvent,
  findPath), components.md (new Collider/PhysicsBody fields), cli.md +
  mcp.md (`inspect path`), architecture.md (event bus + pathfinding
  paragraphs); regenerate AGENTS.md template; CTX_API entries for every
  new ctx member.
- New all-Lua example **"Bounce Patrol"** (`packages/examples/generate.mjs`):
  a bouncy ball (restitution) on mixed friction floors, one-way platforms,
  a patrol enemy that chases the player via `ctx.scene.findPath` over a
  solid tilemap, enemy projectiles on a `projectile` layer that pass
  through enemies (`collidesWith` excludes their own layer), and a score
  UI driven by `ctx.events.emit('coin', ...)` + `onEvent`. Playtest
  asserts: `assertEventCount`, position/velocity asserts for bounce and
  one-way behavior — all expectations baked from probe runs.
- Tests (vitest): ctx.math (every function, both zero-vector edge cases,
  color parsing); event bus (order, auto-cleanup, depth cap,
  mid-delivery mutation rules, scene-switch reset, Lua round-trip);
  pathfinding (grid build overlap rule, 4-dir vs diagonals, no corner
  cutting, determinism — two runs identical, unreachable/blocked → null,
  512×512 cap); physics (restitution bounce + rest threshold, friction
  damping, mass split, layer filtering incl. triggers, one-way from all
  four approach directions, circle-circle/circle-box accuracy, defaults
  reproduce v1 on the existing physics test suite); `inspectPath` command
  (+ JSON shape); playtest `assertEventCount` + events in reports.
- Existing examples (Ember Trail, Glow Caves): re-run generation; re-bake
  any expectation shifted by circle-accurate resolution.
- Player rebuild (`npm run build:player`); version bump to **0.5.0**
  across packages + HEARTH_VERSION + CLI/MCP constants; roadmap entry.

## Non-goals (this wave)

Impulse solver and momentum transfer, joints, physics material assets,
navmesh/any-angle pathfinding, path smoothing, moving-platform carry,
ctx.math matrices, event payload schemas.
