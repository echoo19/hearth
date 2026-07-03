# Wave A — Rendering v2 + Sprite Animation + Screenshots (design)

Date: 2026-07-03. Ships as **v0.4.0**.

Scope, from the v0.3+ backlog (Wave A) plus one pulled-forward item Jake
approved today: 2D lighting, polylines, debug draw overlay, deterministic
particles, sprite animation playback, and **screenshots-for-agents**
(`hearth screenshot [--debug]`), since debug draw's agent value depends on
agents being able to see frames.

Decisions made with Jake (2026-07-03):

- **Observability: both** — deterministic runtime state assertable in
  headless playtests AND real rendered screenshots.
- **Editor authoring canvas: gizmos, not simulation** — the SVG scene view
  gets gizmos; live lighting/particles stay in the Pixi preview.
- **Screenshots: headless Chromium via playwright-core** — boot the real
  player bundle, step deterministically, capture the canvas. No renderer
  duplication; `playwright-core` is an optional CLI dependency that uses an
  installed Chrome/Chromium and errors with an install hint if absent.
- **Lighting: multiply lightmap render texture** — ambient color + additive
  radial light sprites rendered into one screen-sized render texture,
  composited over the world with multiply blend. Everything world-rendered
  "gets lighting for free"; UI is above it and unaffected.

Standing rules apply: agent-native first (schemas + commands + headless
asserts before editor UI); no engine chrome in shipped games (debug overlay
is opt-in tooling, never on by default in exports).

## 1. Components & schemas (`packages/core/src/schema/components.ts`)

All new schemas carry full Zod defaults so `{}` parses valid.

- **`Light2D`**: `radius` (200), `color` ('#ffffff'), `intensity` (1),
  `enabled` (true). Position from Transform.
- **`Camera.ambientLight`**: number 0–1, **default 1** (fully lit). At 1
  with no enabled lights the lighting pass is skipped entirely — existing
  projects render byte-identical, zero cost.
- **`LineRenderer`**: `points` (Vec2[], local space, default []), `width`
  (2), `color` ('#ffffff'), `closed` (false), `opacity` (1), `layer` (0),
  `visible` (true).
- **`ParticleEmitter`**: `emitting` (true), `rate` (10/sec), `burst` (0, on
  scene start), `lifetime` (1s), `speed` (100), `spread` (30°), `direction`
  (0°, engine angle convention), `gravity` (Vec2 {0,0}), `startColor`
  ('#ffffff') / `endColor` ('#ffffff'), `startSize` (8) / `endSize` (0),
  `maxParticles` (256), `layer` (0), `seed` (0). Trail/streak look is a
  documented preset recipe (high rate, zero spread, shrinking size), not an
  engine mode.
- **`SpriteAnimator`**: `assetId` (''), `fps` (0 = use asset
  `frameDuration`), `playing` (true), `loop` (true). The component is the
  single runtime authority; the animation asset's own `loop` is only an
  authoring-time default. Requires a sibling `SpriteRenderer`.

Each addition: `COMPONENT_SCHEMAS` registry entry, `ComponentMap` field,
`COMPONENT_DOCS` entry, semantic checks in `validate.ts` (LineRenderer with
<2 points; non-positive particle `lifetime`/`rate`+`burst` both zero;
SpriteAnimator without SpriteRenderer or pointing at a non-animation asset;
ambientLight out of range is clamped by schema).

## 2. Headless simulation & determinism (`packages/runtime/src/runtime.ts`)

- **Particles simulate headlessly** in `SceneRuntime.step()` on the fixed
  timestep: spawn accumulator (`rate`), burst on start, integrate velocity +
  gravity, expire by lifetime, hard cap at `maxParticles` (oldest die
  first). The renderer only draws this state. Each emitter owns a
  mulberry32 stream seeded from **its own `seed` field**, so an emitter's
  behavior is reproducible regardless of playtest seed, scene composition,
  or spawn order.
- **SpriteAnimator advances in `step()`** and writes the current frame id
  into the sibling `SpriteRenderer.assetId` — agents assert animation state
  with the existing `assertProperty`, no new machinery. Non-looping
  animations clamp on the last frame and set `playing = false`.
- **Playtest additions** (`packages/playtest`): `assertParticleCount` step
  (entity + equals/min/max); playtest + smoke reports gain per-emitter
  particle count snapshots at end of run. Determinism is a tested
  invariant: same project, same steps → identical counts at frame N.
- **Script API (JS + Lua, identical)**: component mutation already covers
  control (`emitting`, `playing`, `assetId`). Additions: `ctx.particles.burst(count)`
  and `ctx.particles.count()` (self entity), `ctx.animate(assetId)`
  convenience (sets SpriteAnimator.assetId, playing=true, resets frame).
  Documented in `hearth inspect api --json` and generated AGENTS.md.
- Lighting and lines have no headless behavior (pure visual): agents
  inspect component data and take screenshots.

## 3. Rendering (`packages/runtime/src/pixi/index.ts`)

- **LineRenderer**: a `Graphics` child in the entity container (label
  'line'); rebuilt when points/width/color/closed change, cheap
  position/rotation/scale updates otherwise; participates in the entity
  zIndex max.
- **Lighting**: screen-sized `RenderTexture` lightmap. Per frame (only when
  `ambientLight < 1` or any enabled Light2D exists): clear to ambient gray
  (ambient × white), render each enabled light as an additive tinted
  radial-gradient sprite (shared 256px generated texture; scale = radius,
  alpha = intensity) at its screen position, then composite the lightmap
  over the `world` container via a multiply-blended fullscreen sprite.
  Order: world → lightmap sprite → debug overlay → ui. Resizes track the
  renderer size.
- **Particles**: one `Graphics` per emitter redrawn from runtime particle
  state each frame (positions are world-space; color/size lerp start→end
  by age). Lives in the world container so it's lit and camera-transformed;
  respects `layer`.
- **Debug overlay**: dedicated container above the lightmap, below `ui`,
  camera-synced like `world`. Draws collider outlines (box/circle/polygon
  from the same geometry physics uses), velocity vectors from PhysicsBody,
  and an optional world grid. Controlled by a `debugDraw` mount option +
  runtime setter — editor preview toolbar toggle, `hearth screenshot
  --debug`, and `HearthPlayer.boot({ debug: true })`. **Never enabled by
  default in exports** (no-chrome rule).

## 4. Screenshots (`hearth screenshot`, MCP `screenshot`)

- CLI: `hearth screenshot [scene] --frame N --seed S --size WxH --debug
  --out shot.png --json`. Defaults: initial scene, frame 0 (after onStart),
  800×600, `screenshot.png`.
- Mechanism: build the in-memory web bundle (reuse `exportWeb` machinery),
  serve it to headless Chromium via `playwright-core` (channel: installed
  Chrome/Chromium; clean actionable error if none found), boot the player
  in a new **manual-stepping mode** (`HearthPlayer.boot({ manual: true })`
  exposing `window.__hearth.step(n)` + a render call), step N fixed frames,
  render once, screenshot the canvas element to PNG.
- Deterministic: fixed timestep + seeded session + seeded emitters + no
  ticker ⇒ same inputs, same pixels (modulo GPU rasterization differences,
  which we don't assert on — screenshots are for agent eyes, not pixel
  diffs in CI).
- MCP tool `screenshot` wraps the same command, returns the written file
  path + metadata so agents can Read the image.
- `--debug` flips the debug overlay on for the capture.

## 5. Editor (`apps/editor`)

- **Inspector**: value-type-driven controls cover most new fields for free.
  Add: points-array editing for LineRenderer (reuse the polygon-collider
  vertex editor pattern in SceneView), animation-asset dropdown for
  SpriteAnimator.assetId (same pattern as the existing `assetId` special
  case), color fields already work by `#` prefix.
- **SVG authoring canvas (gizmos, not simulation)**: LineRenderer draws its
  actual polyline (+ vertex drag editing when selected); Light2D draws a
  radius circle + bulb icon; ParticleEmitter draws an icon + direction/
  spread cone; SpriteAnimator shows whatever the SpriteRenderer already
  shows (frame written at runtime only).
- **Preview toolbar**: debug-draw toggle wired to the mount option.
- `componentIcon` switch gains four icons.

## 6. Docs, examples, tests, release

- Docs: components.md, scripting.md (ctx.particles / ctx.animate),
  cli.md + mcp.md (screenshot), export.md (debug never ships on),
  architecture.md rendering section; regenerate AGENTS.md template.
- Examples (`packages/examples/generate.mjs`): extend or add an all-Lua
  showcase ("Glow Caves" or similar) exercising lighting + particles +
  animation + LineRenderer, with playtest asserts on particle counts and
  animation frames.
- Tests (vitest): schema defaults/validation; particle determinism (two
  runs, same counts), cap behavior, burst; animator frame progression,
  non-loop clamp, fps override; playtest assertParticleCount; screenshot
  command test skipped when no Chromium (CI-safe); zIndex/layer behavior
  unit-testable without GPU (logic-level).
- Player rebuild (`npm run build:player`) so exports pick everything up.
- Version bump to **0.4.0** across packages; changelog entry.

## Non-goals (this wave)

Normal maps / shadow casting, physics v2 (Wave B), spritesheet slicing
(Wave C), editor Lua completion, pixel-diff CI assertions.
