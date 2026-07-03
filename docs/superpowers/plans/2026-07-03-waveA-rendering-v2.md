# Wave A — Rendering v2 + Sprite Animation + Screenshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.4.0: Light2D lighting, LineRenderer, debug draw overlay, deterministic ParticleEmitter, SpriteAnimator playback, and `hearth screenshot` — agent-native first (schemas + headless asserts before editor UI).

**Architecture:** New components flow through the existing pipeline: Zod schema in `packages/core` → headless simulation in `packages/runtime/src/runtime.ts` (particles + animator run without Pixi so playtests can assert them) → rendering in `packages/runtime/src/pixi/index.ts` (shared by editor preview and exported player) → gizmos in the editor SVG canvas. Screenshots boot the real player bundle in headless Chromium via playwright-core and capture the canvas.

**Tech Stack:** TypeScript ESM (NodeNext — relative imports need `.js`), Zod, PixiJS v8, vitest, playwright-core (optional dep), wasmoon (existing).

**Spec:** `docs/superpowers/specs/2026-07-03-waveA-rendering-v2-design.md` — read it first; decisions there are final.

## Global Constraints

- Fully-defaulted Zod schemas: `{}` must parse valid for every new component.
- Determinism: no `Math.random`/`Date.now` anywhere in runtime; particle randomness comes from a per-emitter mulberry32 stream seeded by the emitter's own `seed` field.
- `Camera.ambientLight` defaults to **1**; at 1 with no enabled lights, the lighting pass must be completely skipped (existing projects render byte-identical).
- Debug overlay is NEVER on by default in exports (no-chrome rule).
- Tests run from repo root: `npx vitest run <path>` (aliases map @hearth/* to src; no build needed).
- Build order when building: `npm run build:packages`.
- Examples are generated: edit `packages/examples/generate.mjs`, never the JSON.
- Commit after each task, plain human voice, no AI attribution.
- All ctx additions must work identically from JS and Lua (Lua ctx is a live proxy; dot-call convention).

## Execution order

Task 1 first (everything depends on schemas). Then Tasks 2, 3, 10 may run in parallel (disjoint files). Task 4 after 2+3. Tasks 5–7 are sequential (all edit `pixi/index.ts`). Task 8 after 5–7; Task 9 after 8; Task 11 after all features; Task 12 last.

---

### Task 1: Core schemas, docs, validation

**Files:**
- Modify: `packages/core/src/schema/components.ts`
- Modify: `packages/core/src/validate.ts`
- Test: `packages/core/test/waveA-components.test.ts` (create; follow the existing test layout — check `packages/core/test/` for naming conventions and copy the style of an existing schema test)

**Interfaces (Produces — later tasks rely on these exact names):**
- `Light2DSchema`, `LineRendererSchema`, `ParticleEmitterSchema`, `SpriteAnimatorSchema`; components registered as `Light2D`, `LineRenderer`, `ParticleEmitter`, `SpriteAnimator` in `COMPONENT_SCHEMAS`; `CameraSchema` gains `ambientLight`.
- Types `Light2DComponent`, `LineRendererComponent`, `ParticleEmitterComponent`, `SpriteAnimatorComponent` + `ComponentMap` fields.

- [ ] **Step 1: Write failing tests** — defaults, ranges, registry membership:

```ts
import { describe, expect, it } from 'vitest';
import {
  COMPONENT_SCHEMAS,
  COMPONENT_DOCS,
  createComponent,
  isComponentType,
} from '../src/schema/components.js';

describe('Wave A component schemas', () => {
  it('registers the four new component types with docs', () => {
    for (const type of ['Light2D', 'LineRenderer', 'ParticleEmitter', 'SpriteAnimator'] as const) {
      expect(isComponentType(type)).toBe(true);
      expect(COMPONENT_DOCS[type]).toBeTruthy();
    }
  });

  it('Light2D defaults', () => {
    expect(createComponent('Light2D')).toEqual({
      radius: 200, color: '#ffffff', intensity: 1, enabled: true,
    });
  });

  it('LineRenderer defaults', () => {
    expect(createComponent('LineRenderer')).toEqual({
      points: [], width: 2, color: '#ffffff', closed: false,
      opacity: 1, layer: 0, visible: true,
    });
  });

  it('ParticleEmitter defaults are deterministic-ready', () => {
    const e = createComponent('ParticleEmitter');
    expect(e).toEqual({
      emitting: true, rate: 10, burst: 0, lifetime: 1, speed: 100,
      spread: 30, direction: 0, gravity: { x: 0, y: 0 },
      startColor: '#ffffff', endColor: '#ffffff', startSize: 8, endSize: 0,
      maxParticles: 256, layer: 0, seed: 0,
    });
  });

  it('SpriteAnimator defaults', () => {
    expect(createComponent('SpriteAnimator')).toEqual({
      assetId: '', fps: 0, playing: true, loop: true,
    });
  });

  it('Camera gains ambientLight defaulting to 1 (fully lit)', () => {
    expect(createComponent('Camera').ambientLight).toBe(1);
  });

  it('clamps ambientLight and rejects bad colors', () => {
    expect(() => createComponent('Camera', { ambientLight: 2 })).toThrow();
    expect(() => createComponent('Light2D', { color: 'red' })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run packages/core/test/waveA-components.test.ts` → FAIL (unknown component types).

- [ ] **Step 3: Implement schemas.** In `components.ts`, after `TilemapSchema`, following the file's exact style (JSDoc on non-obvious fields):

```ts
export const Light2DSchema = z.object({
  /** Light falloff radius in world pixels. */
  radius: z.number().positive().default(200),
  color: ColorSchema.default('#ffffff'),
  /** Brightness multiplier at the light's center. */
  intensity: z.number().min(0).default(1),
  enabled: z.boolean().default(true),
});

export const LineRendererSchema = z.object({
  /** Polyline vertices in local space (entity transform applies). */
  points: z.array(Vec2Schema).default([]),
  width: z.number().positive().default(2),
  color: ColorSchema.default('#ffffff'),
  /** Connect the last point back to the first. */
  closed: z.boolean().default(false),
  opacity: z.number().min(0).max(1).default(1),
  layer: z.number().int().default(0),
  visible: z.boolean().default(true),
});

export const ParticleEmitterSchema = z.object({
  emitting: z.boolean().default(true),
  /** Particles spawned per second while emitting. */
  rate: z.number().min(0).default(10),
  /** Particles spawned once on scene start (in addition to rate). */
  burst: z.number().int().min(0).default(0),
  /** Particle lifetime in seconds. */
  lifetime: z.number().positive().default(1),
  /** Initial speed in pixels/second. */
  speed: z.number().min(0).default(100),
  /** Emission cone half-angle in degrees around direction. */
  spread: z.number().min(0).max(180).default(30),
  /** Emission direction in degrees (0 = +x, 90 = +y/down). */
  direction: z.number().default(0),
  /** Constant acceleration in pixels/second². */
  gravity: Vec2Schema.default({ x: 0, y: 0 }),
  startColor: ColorSchema.default('#ffffff'),
  endColor: ColorSchema.default('#ffffff'),
  startSize: z.number().min(0).default(8),
  endSize: z.number().min(0).default(0),
  /** Hard cap; oldest particles die first when exceeded. */
  maxParticles: z.number().int().positive().max(2048).default(256),
  layer: z.number().int().default(0),
  /** Per-emitter RNG seed — same seed, same particles, every run. */
  seed: z.number().int().default(0),
});

export const SpriteAnimatorSchema = z.object({
  /** Animation asset id (assets/animations/*.anim.json). */
  assetId: z.string().default(''),
  /** Frames per second; 0 = use the asset's frameDuration. */
  fps: z.number().min(0).default(0),
  playing: z.boolean().default(true),
  loop: z.boolean().default(true),
});
```

Add `ambientLight: z.number().min(0).max(1).default(1)` to `CameraSchema` with JSDoc `/** Scene brightness with no lights: 1 = fully lit (lighting disabled), 0 = black. */`. Register all four in `COMPONENT_SCHEMAS`, add the four `z.infer` type exports, four `ComponentMap` fields, and `COMPONENT_DOCS` entries (one sentence each, mention determinism for ParticleEmitter and the SpriteRenderer requirement for SpriteAnimator).

- [ ] **Step 4: Run tests** → PASS. Also run the full core suite (`npx vitest run packages/core`) to catch any `Record<ComponentType, ...>` exhaustiveness breaks — `COMPONENT_DOCS` is typed `Record<ComponentType, string>`, so missing entries fail typecheck: run `npx tsc -b packages/core` too (check root package.json for the canonical typecheck script first and use that if it exists).

- [ ] **Step 5: Add validation rules.** In `packages/core/src/validate.ts`, follow the existing warning/error pattern (see the polygon-convexity check around line 301):
  - `LineRenderer` with fewer than 2 points → warning ("LineRenderer needs at least 2 points to draw").
  - `ParticleEmitter` with `rate === 0 && burst === 0` → warning ("emits nothing").
  - `SpriteAnimator` present without a sibling `SpriteRenderer` → warning.
  - `SpriteAnimator.assetId` set but the asset is missing or not type `animation` → error (match how other asset refs are validated in this file).

Write the tests for these in the same test file first (look at how existing validate tests build a minimal project — copy that helper usage), watch them fail, then implement.

- [ ] **Step 6: Full core suite green, commit** — `git commit -m "Core: Light2D, LineRenderer, ParticleEmitter, SpriteAnimator schemas + ambient light"`.

---

### Task 2: Headless particle simulation + ctx.particles

**Files:**
- Modify: `packages/runtime/src/runtime.ts` (step stage + state + public API + ctx)
- Create: `packages/runtime/src/particles.ts`
- Modify: `packages/runtime/src/luaApi.ts` or wherever the Lua ctx bridge enumerates namespaces — grep for `'random'`/`'timers'` in `packages/runtime/src` to find where ctx namespaces cross into Lua, and mirror `particles`.
- Test: `packages/runtime/test/particles.test.ts`

**Interfaces:**
- Consumes: `ParticleEmitterComponent` (Task 1), `createRng` from `./stdlib.js`.
- Produces (exact — Tasks 4, 5, 11 use these):

```ts
// particles.ts
export interface Particle {
  x: number; y: number;        // world space
  vx: number; vy: number;
  age: number;                  // seconds
  lifetime: number;
}
export class EmitterState {
  constructor(seed: number);
  readonly particles: Particle[];
  /** Advance one fixed step: spawn from rate, integrate, expire, cap. */
  step(dt: number, emitter: ParticleEmitterComponent, origin: Vec2): void;
  /** Spawn `count` particles immediately at origin using emitter params. */
  burst(count: number, emitter: ParticleEmitterComponent, origin: Vec2): void;
}
// SceneRuntime additions
getParticles(entityIdOrName: string): ReadonlyArray<Particle>;   // [] when none
getParticleCount(entityIdOrName: string): number;
// ctx additions (JS and Lua)
ctx.particles.burst(count: number): void;   // self entity; warn if no emitter
ctx.particles.count(): number;              // self entity; 0 if no emitter
```

- [ ] **Step 1: Write failing tests.** Key cases (build a minimal in-memory project the way existing runtime tests do — check `packages/runtime/test/` for the store/scene helper and copy it):

```ts
// determinism: two runtimes, same project, different session seeds →
// identical particle counts and positions at frame 60
// (emitter seed, not session seed, drives particles)
it('particle streams are reproducible regardless of session seed', async () => {
  const a = await makeRuntimeWithEmitter({ seed: 7, rate: 20, lifetime: 0.5 }, { sessionSeed: 1 });
  const b = await makeRuntimeWithEmitter({ seed: 7, rate: 20, lifetime: 0.5 }, { sessionSeed: 999 });
  a.run(60); b.run(60);
  expect(a.getParticles('Emitter')).toEqual(b.getParticles('Emitter'));
});

it('burst spawns on scene start, rate accumulates fractionally', ...);
it('particles expire after lifetime', ...);
it('maxParticles caps with oldest-first eviction', ...);
it('gravity integrates into velocity then position', ...);
it('ctx.particles.burst and count work from a script', ...);
it('emitting=false stops rate spawning but existing particles live on', ...);
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `particles.ts`.** Core stepping logic (complete):

```ts
import type { ParticleEmitterComponent, Vec2 } from '@hearth/core';
import { createRng } from './stdlib.js';

const DEG_TO_RAD = Math.PI / 180;

export class EmitterState {
  readonly particles: Particle[] = [];
  private spawnAccumulator = 0;
  private readonly rng: () => number;

  constructor(seed: number) {
    this.rng = createRng(seed);
  }

  step(dt: number, emitter: ParticleEmitterComponent, origin: Vec2): void {
    // 1. Age + integrate existing particles (gravity is acceleration).
    for (const p of this.particles) {
      p.age += dt;
      p.vx += emitter.gravity.x * dt;
      p.vy += emitter.gravity.y * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    // 2. Expire.
    for (let i = this.particles.length - 1; i >= 0; i--) {
      if (this.particles[i].age >= this.particles[i].lifetime) this.particles.splice(i, 1);
    }
    // 3. Spawn from rate.
    if (emitter.emitting && emitter.rate > 0) {
      this.spawnAccumulator += emitter.rate * dt;
      while (this.spawnAccumulator >= 1) {
        this.spawnAccumulator -= 1;
        this.spawnOne(emitter, origin);
      }
    }
    this.enforceCap(emitter.maxParticles);
  }

  burst(count: number, emitter: ParticleEmitterComponent, origin: Vec2): void {
    for (let i = 0; i < count; i++) this.spawnOne(emitter, origin);
    this.enforceCap(emitter.maxParticles);
  }

  private spawnOne(emitter: ParticleEmitterComponent, origin: Vec2): void {
    const angle =
      (emitter.direction + (this.rng() * 2 - 1) * emitter.spread) * DEG_TO_RAD;
    this.particles.push({
      x: origin.x, y: origin.y,
      vx: Math.cos(angle) * emitter.speed,
      vy: Math.sin(angle) * emitter.speed,
      age: 0,
      lifetime: emitter.lifetime,
    });
  }

  private enforceCap(max: number): void {
    while (this.particles.length > max) this.particles.shift(); // oldest first
  }
}
```

- [ ] **Step 4: Wire into `SceneRuntime`.** Private `emitters = new Map<string, EmitterState>()`. New step stage **4c** (after `applyCameraFollow()`, before `flushDestroyed()`), commented like the existing stages:

```ts
// 4c. Particle emitters step deterministically (per-emitter seeded RNG).
this.stepParticles();
```

`stepParticles()`: for each live enabled entity with `components.ParticleEmitter`, get-or-create `EmitterState(emitter.seed)`; on first creation also `burst(emitter.burst, ...)`; call `state.step(this.fixedDt, emitter, this.getWorldPosition(entity))`. Delete map entries whose entity id is no longer live. Public `getParticles`/`getParticleCount` resolve via `this.find()` then the map. In `makeContext`, add the `particles` namespace after `random` (warn via `recordLog('warn', ...)` when the entity has no ParticleEmitter, matching existing warn copy style). Mirror into the Lua bridge exactly the way `random` is exposed.

- [ ] **Step 5: Tests pass; full runtime suite green; commit** — `"Runtime: deterministic particle simulation + ctx.particles"`.

---

### Task 3: SpriteAnimator playback + ctx.animate

**Files:**
- Modify: `packages/runtime/src/runtime.ts`
- Create: `packages/runtime/src/animator.ts`
- Test: `packages/runtime/test/animator.test.ts`

**Interfaces:**
- Consumes: `SpriteAnimatorComponent` (Task 1); `AnimationDataSchema` (`packages/core/src/schema/project.ts:81` — `frames: string[]`, `frameDuration`, `loop`).
- Produces: animator writes the current frame into `SpriteRenderer.assetId` each step; `ctx.animate(assetId: string): void` sets `SpriteAnimator.assetId`, `playing = true`, resets to frame 0 (warns when the entity has no SpriteAnimator or the asset is unknown).

**Implementation notes (locked decisions):**
- Animation data loads in `SceneRuntime.create` (it's async) — read every animation asset referenced by any SpriteAnimator in the scene, plus lazily on `ctx.animate` of an unloaded id is NOT supported this wave: instead preload ALL animation assets of the project up front (they're tiny JSON). Find how `loadScripts()` reads files via the store's fs and mirror it; parse with `AnimationDataSchema.parse`.
- Advance in a step stage **2c** right after the scripts loop (so same-frame `playing`/`assetId` script mutations take effect the frame they're made): per entity with SpriteAnimator + SpriteRenderer, keep `{ assetId, elapsed, frame }` state; if the component's `assetId` differs from state, reset elapsed/frame. If `playing` and the animation has frames: `frameDuration = fps > 0 ? 1/fps : asset.frameDuration`; `elapsed += fixedDt`; advance whole frames; `loop` wraps, non-loop clamps on last frame and sets `component.playing = false`. Write `frames[frame]` into `SpriteRenderer.assetId`.
- Missing SpriteRenderer or unknown/empty assetId: skip silently (validation already warns at author time).

- [ ] **Step 1: Failing tests** — frame progression at asset frameDuration; fps override; loop wrap; non-loop clamp sets playing=false; script `ctx.animate` switches mid-run and resets; assertable via `SpriteRenderer.assetId`:

```ts
it('advances SpriteRenderer.assetId through frames on the fixed timestep', async () => {
  // animation: frames [f0, f1, f2], frameDuration 0.1; fixedTimestep 60
  const rt = await makeRuntimeWithAnimator();
  expect(spriteAssetId(rt)).toBe('f0');
  rt.run(6);  // 0.1s
  expect(spriteAssetId(rt)).toBe('f1');
  rt.run(6);
  expect(spriteAssetId(rt)).toBe('f2');
  rt.run(6);  // loop wraps
  expect(spriteAssetId(rt)).toBe('f0');
});
```

- [ ] **Step 2: Verify failure. Step 3: Implement (`animator.ts` holds the pure stepping; runtime owns state + preload). Step 4: Suite green. Step 5: Commit** — `"Runtime: SpriteAnimator playback + ctx.animate"`.

---

### Task 4: Playtest assertParticleCount + particle report

**Files:**
- Modify: `packages/core/src/schema/project.ts` (PlaytestStep schema — grep `assertProperty` to find it)
- Modify: `packages/playtest/src/index.ts`
- Test: `packages/playtest/test/particles.test.ts` (copy setup style from existing playtest tests)

**Interfaces:**
- Consumes: `getParticleCount` (Task 2).
- Produces:
  - New playtest step `{ type: 'assertParticleCount', entity: string, equals?: number, min?: number, max?: number }` (schema-validated; at least one of equals/min/max required — refine the Zod schema accordingly).
  - `PlaytestResult` and `SmokeResult` gain `particleCounts: Record<string, number>` (entity name → live count at end of run; only entities with a ParticleEmitter appear).

- [ ] **Step 1: Failing tests** — a playtest with a seeded emitter asserts an exact count at a known frame (compute expected by hand: rate 10/s at 60fps for 30 frames with lifetime 1 → 5 live particles); min/max variants; unknown entity fails the step with a clear message; `particleCounts` lands in both result types.
- [ ] **Step 2: Verify failure. Step 3: Implement** — add to `ASSERT_TYPES`, new case in `executeStep` mirroring `assertProperty`'s resolve-and-compare shape; snapshot counts after the final frame. **Step 4: Suite green. Step 5: Commit** — `"Playtest: assertParticleCount + particle count reporting"`.

---

### Task 5: Pixi rendering — LineRenderer + particles

**Files:**
- Modify: `packages/runtime/src/pixi/index.ts`

**Interfaces:**
- Consumes: `LineRendererComponent`, `getParticles` (world-space positions), particle age/lifetime for color/size lerp.
- Produces: `'line'`-labeled Graphics child per entity with LineRenderer; a `'particles'`-labeled Graphics child per emitter entity (world container, so lighting and camera apply).

**Implementation (follow the existing buildNode/updateNode split):**
- `buildNode`: LineRenderer → `new Graphics()` labeled `'line'`; ParticleEmitter → `new Graphics()` labeled `'particles'` **added to the node but drawn in world coordinates** — set the child's position to negate the node's world position each frame (`child.position.set(-world.x, -world.y)`) OR (simpler, do this) put particle Graphics in a separate `this.particleLayer = new Container()` child of `world`, keyed by entity id in a `particleNodes` map, cleaned up in `syncEntities` alongside `nodes`. Choose the separate-container approach — particles must not inherit entity rotation/scale.
- Line redraw: cache the last-drawn `(points, width, color, closed, opacity)` snapshot (JSON.stringify is fine — points arrays are tiny); rebuild the Graphics path only when it changes: `g.clear(); g.poly(flatPoints, closed).stroke({ width, color, alpha: opacity })` — for open polylines use `moveTo`/`lineTo` since `poly` closes; check Pixi v8 stroke API in the installed version if unsure.
- Particle redraw every frame: `g.clear()`; for each particle, `t = age / lifetime`, size = lerp(startSize, endSize, t), color = lerpColor(startColor, endColor, t) (write a tiny hex-lerp helper in the file), `g.circle(p.x, p.y, size / 2).fill({ color, alpha: 1 - t * 0.25 })`. zIndex from `emitter.layer`.
- Include `LineRenderer.layer` in the entity zIndex `Math.max` (line ~456).
- Extend `updateNode` for line visible/opacity, matching how sprite visible/opacity is handled.

- [ ] **Step 1: Implement as above.** Rendering has no headless test harness — the logic-level pieces that CAN be unit-tested (hex color lerp) go in a small exported helper with a test in `packages/runtime/test/colorLerp.test.ts` (write the test first).
- [ ] **Step 2: Manual smoke:** `HEARTH_SMOKE=1` app self-test still passes; run `npm run build:packages` and boot the editor dev server (`npm run dev` — check root package.json scripts) with a scratch project containing a LineRenderer and an emitter; confirm visuals.
- [ ] **Step 3: Full suite green. Step 4: Commit** — `"Renderer: LineRenderer + particle rendering"`.

---

### Task 6: Pixi rendering — multiply lightmap

**Files:**
- Modify: `packages/runtime/src/pixi/index.ts`

**Interfaces:**
- Consumes: `Light2DComponent`, `Camera.ambientLight` (via `this.runtime.camera` — extend the runtime `camera` getter in `runtime.ts` to include `ambientLight`, defaulting to 1 when no camera entity).
- Produces: stage order becomes `world`, `lightmapSprite`, `debugLayer` (Task 7), `ui`.

**Implementation (locked):**
- One 256×256 radial-gradient `Texture` generated once at mount from an offscreen canvas (white center → transparent edge, quadratic falloff).
- `lightmapRT = RenderTexture.create({ width, height })` at buildSettings size; `lightmapSprite = new Sprite(lightmapRT)` with `blendMode: 'multiply'`, added to stage above `world`.
- A non-staged `lightScene = new Container()` holding: a fullscreen `Graphics` rect filled with the ambient gray (`0x010101 * Math.round(ambient*255)` — compute channel from `ambientLight`), plus one additive-blend Sprite per enabled Light2D (tint = light color, alpha = min(intensity, 1), extra brightness beyond 1 via a second stacked sprite is out of scope this wave — clamp), positioned at the light's **screen** position (same transform math as `syncCamera`: `screen = size/2 + (worldPos - cam.position) * zoom`), scaled so the gradient spans `radius * 2 * zoom` pixels.
- Per tick, after `syncCamera()`: if `ambientLight >= 1` and no enabled lights → `lightmapSprite.visible = false` and **skip all lightmap work** (the byte-identical guarantee). Else rebuild the lightScene children and `this.app.renderer.render({ container: lightScene, target: lightmapRT, clear: true })`, `lightmapSprite.visible = true`.

- [ ] **Step 1: Implement. Step 2: Manual smoke in the editor** — scratch scene: ambientLight 0.2, two colored lights, verify sprites/lines/particles darken and tint; set ambientLight back to 1 → identical to pre-wave rendering; UI/Text-with-UIElement unaffected. **Step 3: Suite + HEARTH_SMOKE green. Step 4: Commit** — `"Renderer: 2D lighting via multiply lightmap"`.

---

### Task 7: Pixi rendering — debug draw overlay

**Files:**
- Modify: `packages/runtime/src/pixi/index.ts`
- Modify: `packages/runtime/src/physics.ts` ONLY IF collider world-geometry isn't already exported — reuse the exact geometry physics collides with (grep for the function that produces collider shapes; export it if private rather than duplicating math).

**Interfaces:**
- Produces: `PixiViewOptions.debugDraw?: boolean` (default false) and `view.setDebugDraw(on: boolean): void`. `debugLayer` container sits above `lightmapSprite`, below `ui`, and copies `world`'s position/scale every tick (debug lines must NOT be darkened by lighting — hence above the lightmap).

**Implementation:** one `Graphics` redrawn per tick when enabled, else `debugLayer.visible = false` and zero work. Draw for every live enabled entity: collider outline (box/circle/polygon at world position + offset, green `#00ff88`, 1px stroke; trigger colliders dashed — Pixi has no dash: use alpha 0.5 instead), velocity vector for PhysicsBody (yellow line from center, length = velocity * 0.25s, arrowhead optional — skip it, YAGNI), and Light2D radius circles (soft blue). No grid this wave (the editor canvas already has one; YAGNI in the runtime view).

- [ ] **Step 1: Implement. Step 2: Manual smoke: toggle on in editor preview via console (`view.setDebugDraw(true)`), verify collider boxes track moving entities. Step 3: Suite green. Step 4: Commit** — `"Renderer: debug draw overlay (colliders, velocities, light radii)"`.

---

### Task 8: Player manual-stepping mode + debug boot + rebuild

**Files:**
- Modify: `packages/runtime/src/player/index.ts`
- Modify: `packages/runtime/scripts/build-player.mjs` (only if new externals appear — likely untouched)

**Interfaces:**
- Produces (Task 9 depends on these exact globals): `HearthPlayer.boot(opts)` accepts `{ manual?: boolean, seed?: number, debug?: boolean }` in addition to existing options. In manual mode: mount with `autoplay: false`, do NOT start the ticker-driven stepping, and set

```ts
window.__hearth = {
  /** Step N fixed frames synchronously-per-frame (awaits scene switches). */
  step: async (n: number) => { for (let i = 0; i < n; i++) view.stepOnce(); },
  /** Force one render so the canvas reflects current state. */
  render: () => app.render(),   // expose via a new view.renderOnce() method
  ready: true,
  frame: () => view.session.frame,
};
```

`debug: true` → `view.setDebugDraw(true)` after mount. Add `view.renderOnce()` to `PixiSceneView` (calls `this.app.render()`).

- [ ] **Step 1: Implement. Step 2: Rebuild player** — `npm run build:player` (from packages/runtime or root; check where the script lives) → succeeds. **Step 3: Export a test game single-file, open it, confirm normal boot unaffected** (manual mode only activates when opted in). **Step 4: Commit** — `"Player: manual stepping + debug boot options"`.

---

### Task 9: `hearth screenshot` CLI + MCP tool

**Files:**
- Create: `packages/cli/src/screenshot.ts`
- Modify: `packages/cli/src/program.ts` (register command — copy the pattern of an existing command like export)
- Modify: `packages/cli/package.json` (add `playwright-core` to `optionalDependencies` — verify how the standalone hearth-cli.mjs bundle treats it: it must stay EXTERNAL in the esbuild config; find the CLI bundling script and add it to `external`)
- Modify: `packages/mcp-server/src/` — add `screenshot` tool (find the tool registration list; mirror an existing tool that shells through to a CLI-adjacent function)
- Test: `packages/cli/test/screenshot.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ScreenshotOptions {
  scene?: string;        // id or name; default initial scene
  frame?: number;        // fixed frames to step before capture; default 0
  seed?: number;         // session seed; default 0
  width?: number; height?: number;  // default buildSettings size
  debug?: boolean;       // debug overlay on
  out?: string;          // default 'screenshot.png'
}
export async function captureScreenshot(store: ProjectStore, opts: ScreenshotOptions):
  Promise<{ path: string; width: number; height: number; frame: number; scene: string }>;
```

CLI: `hearth screenshot [scene] --frame N --seed S --size 800x600 --debug --out shot.png --json`. MCP tool `screenshot` with the same fields, returns the JSON metadata (agents Read the PNG themselves).

**Implementation (locked):**
1. Build a single-file HTML in a temp dir: reuse the `exportWeb` machinery (`packages/core/src/commands/exportCommands.ts` — `loadPlayerSource` / `resources.getPlayerBundle`; if those internals aren't exported, run the actual `exportWeb` command with `singleFile` into a scratchpad temp dir, then inject `<script>window.__HEARTH_BOOT__ = {manual:true, seed:S, debug:D}</script>` before the player script tag and make the player's auto-boot read `window.__HEARTH_BOOT__` overrides — pick whichever needs LESS new export-side surface; the injected-global route is preferred).
2. Launch Chromium: `playwright-core`'s `chromium.launch({ channel: 'chrome', headless: true })`, falling back through `channel: 'chromium'`, `channel: 'msedge'`, and `CHROMIUM_PATH` env; on total failure throw a clean error: `"hearth screenshot needs Chrome or Chromium installed (or CHROMIUM_PATH set). Install Google Chrome, or: npx playwright install chromium"`. Import `playwright-core` lazily inside the function so the CLI works without it installed.
3. `page.goto(fileUrl)`, `page.waitForFunction(() => window.__hearth?.ready)`, `page.evaluate(n => window.__hearth.step(n), frames)`, `page.evaluate(() => window.__hearth.render())`, then `page.locator('canvas').screenshot({ path: out })`.
4. `--size` overrides buildSettings via viewport + boot override (pass through `__HEARTH_BOOT__`).

- [ ] **Step 1: Failing test** — unit-test the option parsing + HTML injection pure parts; gate the end-to-end test behind Chromium availability:

```ts
const hasChromium = await canLaunchChromium();  // helper that try/catches launch
it.skipIf(!hasChromium)('captures a deterministic frame', async () => {
  const meta = await captureScreenshot(store, { frame: 30, out: tmpPng });
  expect(existsSync(tmpPng)).toBe(true);
  expect(meta.frame).toBe(30);
});
```

- [ ] **Step 2: Verify failure. Step 3: Implement. Step 4: Run e2e locally (Chrome is installed on this machine) — verify the PNG actually shows the scene (open it / Read the image). Verify `--debug` shows collider outlines. Step 5: Register MCP tool; run the MCP server's existing test suite. Step 6: Commit** — `"CLI+MCP: hearth screenshot via headless Chromium"`.

---

### Task 10: Editor — gizmos, inspector, icons, debug toggle

**Files:**
- Modify: `apps/editor/src/components/SceneView.tsx` (gizmos; reuse the polygon-collider vertex-editor pattern for LineRenderer points)
- Modify: `apps/editor/src/components/Inspector.tsx` (animation-asset dropdown for `SpriteAnimator.assetId` — mirror the existing `assetId` special case at ~line 315 but filter to `type === 'animation'`)

**Direct feedback from Jake (2026-07-03, screenshot of LineRenderer points rendering as a raw JSON textarea): "stuff like this is not user friendly, should be more uniform."** This is now a hard requirement for this task:
- `points` (and ANY Vec2[] field) must NOT fall through to the JsonField. Build a `Vec2ListField` control: one row per point with the same paired x/y NumberField inputs the existing Vec2Field uses, a remove button per row, and an "add point" button; styled identically to the other Inspector controls (same spacing, background, borders as NumberField/Vec2Field rows).
- Audit every new-component field against the Inspector's control dispatch: nothing Wave A adds may render as raw JSON. `gravity` (Vec2) already hits Vec2Field — verify. Colors hit ColorField via `#` prefix — verify for startColor/endColor.
- Reuse: `Collider.points` (polygon) currently also falls through to JsonField — apply the same Vec2ListField there; it's the identical data shape and Jake's complaint applies equally.
- General uniformity: numbers→NumberField, booleans→checkbox, enums with known values (SpriteRenderer.shape etc. are already special-cased)→ their existing controls. No new one-off styles.
- Modify: `apps/editor/src/components/ui.tsx` (`componentIcon` switch: four icons)
- Modify: the game-preview panel component (grep `runtimeBridge` usage for where the preview toolbar lives) — add a debug-draw toggle button wired to `view.setDebugDraw`.

**Gizmos (SVG, gizmo-not-simulation per spec):**
- LineRenderer: `<polyline>`/`<polygon>` with actual points/width/color at the entity transform; when selected, draggable vertex handles (the polygon collider editor already does exactly this — extract/reuse its handle logic rather than copying it).
- Light2D: dashed radius circle in the light's color at 40% opacity + a small bulb glyph.
- ParticleEmitter: small fountain glyph + two lines showing the `direction ± spread` cone (length ~48px).
- SpriteAnimator: no canvas drawing (SpriteRenderer already draws frame content).

- [ ] **Step 1: Implement (check for existing editor component tests — if the project has them, follow suit; the SVG gizmos are otherwise verified visually). Step 2: Manual pass in the dev editor: place all four components, drag line vertices, toggle preview debug draw. Step 3: Suite green. Step 4: Commit** — `"Editor: Wave A gizmos, animation asset picker, preview debug toggle"`.

---

### Task 11: Docs, example game, AGENTS.md

**Files:**
- Modify: `docs/components.md`, `docs/scripting.md`, `docs/cli.md`, `docs/mcp.md`, `docs/export.md`, `docs/architecture.md`
- Modify: `packages/examples/generate.mjs`
- Modify: the AGENTS.md template (grep for how AGENTS.md is generated — the ctx API docs and `hearth inspect api` surface must list `ctx.particles.*` and `ctx.animate`)

**Content:**
- components.md: the four new components + ambientLight, with the trail-preset recipe (high rate, spread 0, endSize 0, short lifetime) as a worked ParticleEmitter example.
- scripting.md: `ctx.particles.burst/count`, `ctx.animate`, determinism note (per-emitter seed).
- cli.md + mcp.md: `hearth screenshot` with the Chromium requirement and install hint.
- export.md: note the debug overlay never ships enabled.
- New example **"Glow Caves"** in generate.mjs: all-Lua; a dark scene (ambientLight 0.15), player-following Light2D torch, LineRenderer cave outlines, two ParticleEmitters (torch sparks preset + a drip trail), an animated sprite via SpriteAnimator + createAnimationAsset frames, and a playtest using `assertParticleCount` + an `assertProperty` on the animator's current frame. Run the generator; run the new playtest headlessly.

- [ ] **Step 1: Write docs + example. Step 2: `node packages/examples/generate.mjs` (check exact invocation in package.json), then run the example's playtests via the CLI and `hearth validate` — all green. Step 3: Take a screenshot of Glow Caves with the new command (the dogfood proof: `hearth screenshot --debug`). Step 4: Commit** — `"Docs + Glow Caves example for rendering v2"`.

---

### Task 12: Version bump, full verification, release notes

- [ ] **Step 1:** Bump every package.json version to 0.4.0 exactly the way v0.3.0 did (`git show 37d68e1 --stat` to see which files a version bump touches; replicate).
- [ ] **Step 2:** Full verification: `npx vitest run` (whole repo, expect all green — was 310 tests pre-wave, will be more now), `npm run build:packages`, `npm run build:player`, editor build (check root scripts), `HEARTH_SMOKE=1` app self-test.
- [ ] **Step 3:** Update the release notes/changelog the same way v0.3.0 did (grep the repo for where 0.3.0 notes live).
- [ ] **Step 4:** Commit — `"v0.4.0: rendering v2, sprite animation, agent screenshots"`. Do NOT tag or push — Jake decides releases.

---

## Self-review notes

- Spec coverage: schemas/validation (T1), headless particles + ctx (T2), animator (T3), playtest asserts + report (T4), line/particle rendering (T5), lighting (T6), debug overlay (T7), player hooks (T8), screenshot CLI/MCP (T9), editor gizmos/inspector/toggle (T10), docs/example (T11), release (T12). Trail preset = docs recipe (T11). No-chrome rule enforced in T7/T8 defaults + export.md note.
- Type consistency: `EmitterState.step/burst`, `getParticles/getParticleCount`, `ctx.particles.burst/count`, `ctx.animate`, `setDebugDraw`, `renderOnce`, `window.__hearth.{step,render,ready,frame}`, `captureScreenshot` — names locked here and referenced identically across tasks.
- Known judgment points left to implementers (with instructions to check reality): exact Lua-bridge file, AGENTS.md generation location, preview-toolbar component, exportWeb internal exports, CLI bundling externals list.
