# Wave B — Script stdlib + Pathfinding + Physics v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.5.0: `ctx.math` + `ctx.events` (with `onEvent` hook and playtest event asserts), grid A* pathfinding (`ctx.scene.findPath`, `hearth inspect path`, MCP `inspect_path`), and physics v2 (mass/restitution/friction, named collision layers, one-way platforms, circle-accurate resolution).

**Architecture:** Pure new modules (`ctxMath.ts`, `events.ts` in runtime; `pathfinding.ts` in core) wired into the existing seams: `makeContext` attaches ctx namespaces, `callHook` dispatches lifecycle hooks, the command registry + CLI/MCP adapters expose `inspectPath`, and `stepPhysics` gains filtering + a velocity-response function whose defaults reproduce v1 bit-for-bit.

**Tech Stack:** TypeScript ESM (NodeNext — relative imports need `.js`), Zod, vitest (root `npx vitest run`, aliases map @hearth/* to src), wasmoon Lua, PixiJS 8.6, commander CLI.

Spec: `docs/superpowers/specs/2026-07-03-waveB-script-stdlib-pathfinding-physics-design.md` (read it; it governs).

## Global Constraints

- Every new ctx member is identical across JS and Lua, has a `CTX_API` entry in `packages/core/src/ctxApi.ts` (with js+lua examples), and therefore appears in `hearth inspect api` and generated AGENTS.md automatically.
- Determinism: no `Math.random`, no `Date.now`, no wall clock anywhere in runtime code. Event delivery, A* expansion, and physics response must be reproducible run-to-run.
- New schema fields carry full Zod defaults so `{}` stays valid, and **defaults must reproduce v1 behavior exactly**: `mass: 1`, `restitution: 0`, `friction: 0`, `layer: 'default'`, `collidesWith: ['*']`, `oneWay: false`.
- Physics constants (exact values): `FRICTION_DAMPING = 10`, `RESTITUTION_MIN_SPEED = 20` (px/s), one-way angle gate `push.ny < -0.707`, nav grid cap 512×512 cells, event emit depth cap 8, recorded event list cap 200, cell-solid overlap threshold 1% of cell area.
- Angles are degrees, 0 = +x, 90 = +y (down). Vec2 values cross the script boundary as plain `{x, y}` objects.
- Editor: never render a field as a raw JSON textarea — `collidesWith` gets a typed StringListField matching Vec2ListField's styling.
- Lua: nullable returns must return JS `null` (never `undefined`) so the NullToNil extension fires; ctx calls use dot syntax.
- Playtest expectations for examples are baked from probe runs (`GameSession` probe pattern in `packages/examples/generate.mjs` glow-caves, lines ~1219-1242) — never hand-computed.
- Tests live in `packages/<pkg>/tests/*.test.ts` / `apps/editor/tests/*.test.ts`; run from repo root with `npx vitest run <path>`; no build needed for tests.
- Commits: plain human voice, no AI attribution, no emoji.
- `packages/examples/generate.mjs` imports `dist/` — run `npm run build:packages` before regenerating examples.

---

### Task 1: `ctx.math`

**Files:**
- Create: `packages/runtime/src/ctxMath.ts`
- Modify: `packages/runtime/src/scripts.ts` (ScriptContext gains `math`), `packages/runtime/src/runtime.ts` (makeContext attaches it), `packages/core/src/ctxApi.ts` (entries)
- Test: `packages/runtime/tests/ctxMath.test.ts`, extend `packages/runtime/tests/lua.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `createCtxMath(warn: (msg: string) => void): CtxMath` and the `CtxMath` interface — later tasks and scripts rely on `ctx.math.<fn>` exactly as specified below.

- [ ] **Step 1: Write failing tests** in `packages/runtime/tests/ctxMath.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createCtxMath } from '../src/ctxMath.js';

describe('ctx.math', () => {
  const m = createCtxMath(() => {});
  it('vec2 defaults missing args to 0', () => {
    expect(m.vec2()).toEqual({ x: 0, y: 0 });
    expect(m.vec2(3)).toEqual({ x: 3, y: 0 });
  });
  it('add/sub/scale return fresh objects without mutating inputs', () => {
    const a = { x: 1, y: 2 };
    const b = { x: 3, y: 4 };
    expect(m.add(a, b)).toEqual({ x: 4, y: 6 });
    expect(m.sub(b, a)).toEqual({ x: 2, y: 2 });
    expect(m.scale(a, 2)).toEqual({ x: 2, y: 4 });
    expect(a).toEqual({ x: 1, y: 2 });
  });
  it('dot/length/distance', () => {
    expect(m.dot({ x: 1, y: 2 }, { x: 3, y: 4 })).toBe(11);
    expect(m.length({ x: 3, y: 4 })).toBe(5);
    expect(m.distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
  it('normalize handles the zero vector', () => {
    expect(m.normalize({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(m.normalize({ x: 10, y: 0 })).toEqual({ x: 1, y: 0 });
  });
  it('angle/fromAngle use degrees, 0=+x, 90=down(+y)', () => {
    expect(m.angle({ x: 1, y: 0 })).toBe(0);
    expect(m.angle({ x: 0, y: 1 })).toBe(90);
    expect(m.angle({ x: 0, y: 0 })).toBe(0);
    const v = m.fromAngle(90);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(1);
    expect(m.fromAngle(0, 5)).toEqual({ x: 5, y: 0 });
  });
  it('lerp/lerpVec do not clamp t; clamp clamps', () => {
    expect(m.lerp(0, 10, 0.5)).toBe(5);
    expect(m.lerp(0, 10, 1.5)).toBe(15);
    expect(m.lerpVec({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5)).toEqual({ x: 5, y: 10 });
    expect(m.clamp(5, 0, 3)).toBe(3);
    expect(m.clamp(-1, 0, 3)).toBe(0);
  });
  it('hexToRgb parses #rgb, #rrggbb, #rrggbbaa (alpha ignored)', () => {
    expect(m.hexToRgb('#ff8800')).toEqual({ r: 255, g: 136, b: 0 });
    expect(m.hexToRgb('#f80')).toEqual({ r: 255, g: 136, b: 0 });
    expect(m.hexToRgb('#ff880080')).toEqual({ r: 255, g: 136, b: 0 });
  });
  it('invalid hex returns white and warns once per instance', () => {
    const warn = vi.fn();
    const mm = createCtxMath(warn);
    expect(mm.hexToRgb('nope')).toEqual({ r: 255, g: 255, b: 255 });
    expect(mm.hexToRgb('also-nope')).toEqual({ r: 255, g: 255, b: 255 });
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it('rgbToHex clamps and rounds', () => {
    expect(m.rgbToHex(255, 136, 0)).toBe('#ff8800');
    expect(m.rgbToHex(300, -5, 127.6)).toBe('#ff0080');
  });
  it('colorLerp clamps t and lerps in RGB', () => {
    expect(m.colorLerp('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(m.colorLerp('#000000', '#ffffff', 2)).toBe('#ffffff');
  });
});
```

- [ ] **Step 2: Run to verify failure**: `npx vitest run packages/runtime/tests/ctxMath.test.ts` — FAIL (module not found).

- [ ] **Step 3: Implement** `packages/runtime/src/ctxMath.ts`:

```ts
/**
 * ctx.math — pure vec2/scalar/color helpers, identical across JS and Lua.
 * All vec2 values are plain {x, y}; every function returns a fresh value and
 * never mutates inputs. Angles are degrees (0 = +x, 90 = +y/down).
 */
import type { Vec2 } from '@hearth/core';

export interface CtxMath {
  vec2(x?: number, y?: number): Vec2;
  add(a: Vec2, b: Vec2): Vec2;
  sub(a: Vec2, b: Vec2): Vec2;
  scale(v: Vec2, s: number): Vec2;
  dot(a: Vec2, b: Vec2): number;
  length(v: Vec2): number;
  distance(a: Vec2, b: Vec2): number;
  normalize(v: Vec2): Vec2;
  angle(v: Vec2): number;
  fromAngle(degrees: number, length?: number): Vec2;
  lerp(a: number, b: number, t: number): number;
  lerpVec(a: Vec2, b: Vec2, t: number): Vec2;
  clamp(x: number, min: number, max: number): number;
  hexToRgb(hex: string): { r: number; g: number; b: number };
  rgbToHex(r: number, g: number, b: number): string;
  colorLerp(hexA: string, hexB: string, t: number): string;
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const DEG = 180 / Math.PI;

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  if (typeof hex !== 'string' || !HEX_RE.test(hex)) return null;
  let h = hex.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

const channel = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');

/** Build the ctx.math object. `warn` fires once per instance on invalid hex input. */
export function createCtxMath(warn: (msg: string) => void): CtxMath {
  let warned = false;
  const badHex = (fn: string, value: string) => {
    if (!warned) {
      warned = true;
      warn(`ctx.math.${fn}: invalid hex color "${value}" (expected #rgb/#rrggbb); using white`);
    }
    return { r: 255, g: 255, b: 255 };
  };
  return {
    vec2: (x = 0, y = 0) => ({ x, y }),
    add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
    sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
    scale: (v, s) => ({ x: v.x * s, y: v.y * s }),
    dot: (a, b) => a.x * b.x + a.y * b.y,
    length: (v) => Math.hypot(v.x, v.y),
    distance: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
    normalize: (v) => {
      const len = Math.hypot(v.x, v.y);
      return len === 0 ? { x: 0, y: 0 } : { x: v.x / len, y: v.y / len };
    },
    angle: (v) => (v.x === 0 && v.y === 0 ? 0 : Math.atan2(v.y, v.x) * DEG),
    fromAngle: (degrees, length = 1) => {
      const rad = degrees / DEG;
      return { x: Math.cos(rad) * length, y: Math.sin(rad) * length };
    },
    lerp: (a, b, t) => a + (b - a) * t,
    lerpVec: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
    clamp: (x, min, max) => Math.min(max, Math.max(min, x)),
    hexToRgb: (hex) => parseHex(hex) ?? badHex('hexToRgb', hex),
    rgbToHex: (r, g, b) => `#${channel(r)}${channel(g)}${channel(b)}`,
    colorLerp(hexA, hexB, t) {
      const a = parseHex(hexA) ?? badHex('colorLerp', hexA);
      const b = parseHex(hexB) ?? badHex('colorLerp', hexB);
      const tt = Math.min(1, Math.max(0, t));
      return this.rgbToHex(a.r + (b.r - a.r) * tt, a.g + (b.g - a.g) * tt, a.b + (b.b - a.b) * tt);
    },
  };
}
```

- [ ] **Step 4: Wire into ScriptContext.** In `packages/runtime/src/scripts.ts` add to the `ScriptContext` interface (near `random`):

```ts
  /** Pure math helpers: vec2 ops, lerp/clamp, color conversion. See ctx API docs. */
  math: import('./ctxMath.js').CtxMath;
```

In `packages/runtime/src/runtime.ts` `makeContext` (object literal returned around lines 735-929), add a sibling key (import `createCtxMath` at top):

```ts
      math: createCtxMath((msg) => this.recordLog('warn', msg)),
```

- [ ] **Step 5: Run tests**: `npx vitest run packages/runtime/tests/ctxMath.test.ts` — PASS. Then `npx vitest run packages/runtime` — all green (type check: `ScriptContext` implementations satisfied).

- [ ] **Step 6: Lua round-trip test.** In `packages/runtime/tests/lua.test.ts`, add a test in the existing engine-fixture style (reuse the file's established helper for compiling+running a Lua script; every existing test there shows the pattern):

```lua
function onStart(ctx)
  local v = ctx.math.normalize(ctx.math.vec2(3, 4))
  ctx.log(v.x, v.y, ctx.math.colorLerp("#000000", "#ffffff", 0.5))
end
```

Assert the log records `0.6`, `0.8`, `'#808080'`.

- [ ] **Step 7: CTX_API entries.** In `packages/core/src/ctxApi.ts` add a `// --- math (wave B) ---` section with one entry per function (16 entries), `kind: 'method'`, path `math.<name>`, signatures matching `CtxMath` exactly, each with js+lua examples, e.g.:

```ts
  {
    path: 'math.normalize',
    kind: 'method',
    signature: 'normalize(v: Vec2): Vec2',
    description: 'Unit vector in the direction of v ({x:0,y:0} for the zero vector). Pure — returns a new value.',
    example: { js: 'const dir = ctx.math.normalize(ctx.math.sub(target, me))', lua: 'local dir = ctx.math.normalize(ctx.math.sub(target, me))' },
  },
```

- [ ] **Step 8: Run full runtime + core tests, commit**: `npx vitest run packages/runtime packages/core` green, then:

```bash
git add packages/runtime/src/ctxMath.ts packages/runtime/src/scripts.ts packages/runtime/src/runtime.ts packages/core/src/ctxApi.ts packages/runtime/tests/ctxMath.test.ts packages/runtime/tests/lua.test.ts
git commit -m "Runtime: ctx.math pure helpers (vec2, lerp/clamp, colors)"
```

---

### Task 2: `ctx.events` + `onEvent` hook

**Files:**
- Create: `packages/runtime/src/events.ts`
- Modify: `packages/runtime/src/runtime.ts`, `packages/runtime/src/scripts.ts`, `packages/runtime/src/lua.ts`, `packages/runtime/src/session.ts`, `packages/core/src/ctxApi.ts`
- Test: `packages/runtime/tests/events.test.ts`, extend `packages/runtime/tests/session-lua.test.ts`

**Interfaces:**
- Consumes: `callHook` (runtime.ts:1001), `flushDestroyed` reap pattern, `audioEvents` session-aggregation pattern (session.ts ~211).
- Produces (Task 3 relies on these exactly):
  - `SceneRuntime.emitEvent(name: string, data?: unknown): void` (also what `ctx.events.emit` calls)
  - `SceneRuntime.events: GameEventRecord[]` (capped 200), `SceneRuntime.eventsTruncated: boolean`, `SceneRuntime.eventCounts: Map<string, number>` (exact, unbounded)
  - `GameSession.events: GameEventRecord[]` (capped 200, session-monotonic frames), `GameSession.eventsTruncated: boolean`, `GameSession.eventCounts: Map<string, number>` (aggregated across scene switches)
  - `GameEventRecord = { frame: number; name: string; data?: unknown }` exported from `packages/runtime/src/events.ts` and re-exported from `packages/runtime/src/index.ts`
  - New script hook `onEvent(ctx, name, data)`; `ctx.events.emit/on/off`

- [ ] **Step 1: Write failing tests** `packages/runtime/tests/events.test.ts`. Use the existing `makeStore`/`ent` helpers from `./helpers.js` (see `packages/runtime/tests/runtime.test.ts` for the store construction pattern). Cover, with one `it` each:
  - emit delivers synchronously to `ctx.events.on` subscribers in subscription order, then to `onEvent` hooks in entity creation order (build 3 scripted entities; each logs a marker; assert exact log order).
  - the emitter hears its own event (both mechanisms).
  - `ctx.events.off(id)` stops delivery; unknown id is a no-op.
  - subscriptions auto-clean when the owning entity is destroyed (destroy entity A mid-run; emit; A's handler must not fire and no error is recorded).
  - a handler subscribed during a delivery does not receive the in-flight event; one unsubscribed during delivery (before its turn) is skipped.
  - nested emits work to depth 8; the 9th-deep emit is dropped and a warn log containing `event cascade too deep` is recorded (script: `onEvent` re-emits the same name unconditionally — assert eventCounts stays at 8 and warn appears).
  - `runtime.eventCounts` counts exactly; `runtime.events` list caps at 200 with `eventsTruncated === true` while `eventCounts` keeps exact totals (script emits 250 events in one update).
  - data payload passes through: emit `{ score: 5 }`, listener logs `data.score`.

```ts
// Representative skeleton (repeat the pattern per case):
import { describe, it, expect } from 'vitest';
import { SceneRuntime } from '@hearth/runtime';
import { makeStore, ent } from './helpers.js';

describe('ctx.events', () => {
  it('delivers to subscribers in order, then onEvent hooks in entity order', async () => {
    // scripts/a.js: exports onStart that subscribes, scripts/b.js: exports onEvent
    // build store with entities A (sub), B (hook), C (emitter with onUpdate emitting once)
    // step runtime 2 frames, assert log sequence ['sub:A', 'hook:B'] after emit frame
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement the bus** `packages/runtime/src/events.ts`:

```ts
/**
 * Scene-wide event bus behind ctx.events — subscription bookkeeping only.
 * Delivery ordering, depth limits, and onEvent hooks are orchestrated by
 * SceneRuntime.emitEvent, which owns entity order and script dispatch.
 * Deterministic: subscription order is insertion order; no wall clock.
 */
export interface GameEventRecord {
  frame: number;
  name: string;
  data?: unknown;
}

export interface EventSubscription {
  id: string;
  ownerId: string;
  name: string;
  fn: (data: unknown) => void;
}

export class EventBus {
  private subs: EventSubscription[] = [];
  private seq = 0;

  on(ownerId: string, name: string, fn: (data: unknown) => void): string {
    const id = `evt_${++this.seq}`;
    this.subs.push({ id, ownerId, name, fn });
    return id;
  }

  off(id: string): void {
    this.subs = this.subs.filter((s) => s.id !== id);
  }

  /** Drop every subscription owned by a destroyed entity. */
  removeOwner(ownerId: string): void {
    this.subs = this.subs.filter((s) => s.ownerId !== ownerId);
  }

  /** Snapshot of current subscribers for `name`, in subscription order. */
  listenersFor(name: string): EventSubscription[] {
    return this.subs.filter((s) => s.name === name);
  }

  /** True when `sub` is still live (not off'd/reaped mid-delivery). */
  isLive(sub: EventSubscription): boolean {
    return this.subs.includes(sub);
  }

  clear(): void {
    this.subs = [];
  }
}
```

- [ ] **Step 4: Wire the runtime.** In `packages/runtime/src/runtime.ts`:
  - Fields: `private eventBus = new EventBus();`, `private emitDepth = 0;`, `readonly events: GameEventRecord[] = [];`, `eventsTruncated = false;`, `readonly eventCounts = new Map<string, number>();` and constants `const MAX_EVENT_DEPTH = 8; const MAX_RECORDED_EVENTS = 200;` near `MAX_CONSECUTIVE_SCRIPT_ERRORS`.
  - Widen `callHook`'s hook union (line ~1003) to `'onStart' | 'onUpdate' | 'onCollision' | 'onUiEvent' | 'onEvent'` and change `arg?: unknown` to `...args: unknown[]`, calling `fn.call(state.hooks, state.ctx, ...args)`. Update the four existing call sites (they pass 0-1 args — unchanged behavior).
  - New method:

```ts
  /** ctx.events.emit — synchronous, deterministic delivery. */
  emitEvent(name: string, data?: unknown): void {
    if (this.emitDepth >= MAX_EVENT_DEPTH) {
      this.recordLog('warn', `event "${name}" dropped: event cascade too deep (max ${MAX_EVENT_DEPTH})`);
      return;
    }
    this.eventCounts.set(name, (this.eventCounts.get(name) ?? 0) + 1);
    if (this.events.length < MAX_RECORDED_EVENTS) {
      const record: GameEventRecord = { frame: this._frame, name };
      if (data !== undefined) {
        try {
          record.data = JSON.parse(JSON.stringify(data));
        } catch {
          record.data = String(data);
        }
      }
      this.events.push(record);
      this.options.onGameEvent?.(record);
    } else {
      this.eventsTruncated = true;
    }
    this.emitDepth++;
    try {
      // 1. Explicit subscriptions, subscription order. Snapshot: handlers
      //    subscribed during delivery wait for the next emit; handlers
      //    unsubscribed (or whose entity died) mid-delivery are skipped.
      const listeners = this.eventBus.listenersFor(name);
      for (const sub of listeners) {
        if (!this.eventBus.isLive(sub) || this.destroyedIds.has(sub.ownerId)) continue;
        try {
          sub.fn(data);
        } catch (err) {
          // Route through the shared recordHookError helper (Step 4a) so
          // subscription-callback errors get the same record/disable
          // bookkeeping as lifecycle hooks.
          this.recordHookError(sub.ownerId, 'onEvent', err);
        }
      }
      // 2. onEvent hooks, entity creation order (same order as onUpdate).
      for (const entity of this.getEntities()) {
        if (!entity.enabled || this.destroyedIds.has(entity.id)) continue;
        this.callHook(entity, 'onEvent', name, data);
      }
    } finally {
      this.emitDepth--;
    }
  }
```

  - **Step 4a (error path):** `callHook` already owns script-error recording/disable. For subscription callbacks (`sub.fn`), route errors through the same bookkeeping: look up `this.scriptStates.get(sub.ownerId)` and apply the identical recordError + consecutiveErrors + disable logic — extract that block from `callHook` into a small private `recordHookError(state, entity-ish info, phase: string, err)` helper so both paths share it (do NOT duplicate the block).
  - In `makeContext`, add the namespace:

```ts
      events: {
        emit: (name: string, data?: unknown) => this.emitEvent(name, data),
        on: (name: string, fn: (data: unknown) => void) => this.eventBus.on(entity.id, name, fn),
        off: (id: string) => this.eventBus.off(id),
      },
```

  - In `flushDestroyed()` (~991-999), alongside `scriptStates.delete(id)`: `this.eventBus.removeOwner(id);`.
  - In `destroy()` (~376): `this.eventBus.clear();`.
  - Add `onGameEvent?: (record: GameEventRecord) => void;` to the runtime create/mount options type (same place `onAudio`/`onLog` live).
  - Re-export from `packages/runtime/src/index.ts`: `export { EventBus, type GameEventRecord } from './events.js';`.

- [ ] **Step 5: scripts.ts + lua.ts.** In `scripts.ts`: add to `ScriptHooks`:

```ts
  /** Fires for every ctx.events.emit in the scene: onEvent(ctx, name, data). */
  onEvent?(ctx: ScriptContext, name: string, data: unknown): void;
```

and to `ScriptContext`:

```ts
  /** Global pub/sub. emit delivers synchronously; on() subscriptions die with this entity. */
  events: {
    emit(name: string, data?: unknown): void;
    on(name: string, fn: (data: unknown) => void): string;
    off(id: string): void;
  };
```

In `lua.ts` `compile()` (~225-239), add `onEvent` alongside the four picks, wrapping `(ctx, name, data) => void fn(ctx, name, data)`.

- [ ] **Step 6: Session aggregation.** In `packages/runtime/src/session.ts`, mirror the `audioEvents` pattern exactly (fields ~line 81, callback ~211-214): add `readonly events: GameEventRecord[] = []`, `eventsTruncated = false`, `readonly eventCounts = new Map<string, number>()`; in the options passed to `SceneRuntime.create`, add an `onGameEvent` callback that pushes `{ ...record, frame: this._runtime?.frame ?? frameOffset }` when `this.events.length < 200` (else set `eventsTruncated = true`) and increments `this.eventCounts`. Note the runtime-level truncation flag must also propagate: after each scene ends (in `performSwitch`) OR simply set session `eventsTruncated ||= runtime.eventsTruncated` in the same callback... — cleanest: in `performSwitch`, before `old.destroy()`, `this.eventsTruncated ||= old.eventsTruncated;` and also count-merge nothing (counts already streamed via callback). Runtime-level counts stream through the callback, so the session map is exact.

- [ ] **Step 7: Run tests** — events.test.ts PASS, whole `packages/runtime` suite green.

- [ ] **Step 8: Lua session test.** In `packages/runtime/tests/session-lua.test.ts` add: a Lua script with `onStart` doing `ctx.events.on("ping", function(data) ctx.log("got", data.n) end)` on one entity, another Lua entity with `onEvent(ctx, name, data)` logging `name`, a third emitting `ctx.events.emit("ping", { n = 7 })` in onUpdate frame 1. Step 3 frames; assert logs contain `got 7` and `ping`, and `session.eventCounts.get('ping') === <expected>`.

- [ ] **Step 9: CTX_API entries** for `events.emit`, `events.on`, `events.off` (+ document the `onEvent` hook in the `events.emit` description: "also triggers every script's onEvent(ctx, name, data) hook").

- [ ] **Step 10: Commit**:

```bash
git add packages/runtime/src/events.ts packages/runtime/src/runtime.ts packages/runtime/src/scripts.ts packages/runtime/src/lua.ts packages/runtime/src/session.ts packages/runtime/src/index.ts packages/core/src/ctxApi.ts packages/runtime/tests/events.test.ts packages/runtime/tests/session-lua.test.ts
git commit -m "Runtime: ctx.events pub/sub with onEvent hook and event recording"
```

---

### Task 3: Playtest events — reports + `assertEventCount`

**Files:**
- Modify: `packages/core/src/schema/project.ts` (step union + refine), `packages/playtest/src/index.ts`
- Test: `packages/playtest/tests/` (extend the existing playtest test file covering assert steps — find it via `grep -l assertParticleCount packages/playtest/tests`)

**Interfaces:**
- Consumes: `GameSession.events`, `GameSession.eventCounts`, `GameSession.eventsTruncated` (Task 2).
- Produces: playtest step `{ type: 'assertEventCount', event: string, equals?, min?, max? }`; `PlaytestResult.events: GameEventRecord-shaped[]`, `PlaytestResult.eventCounts: Record<string, number>` (plain object, JSON-safe); same two fields on `SmokeResult`.

- [ ] **Step 1: Failing schema test** (in `packages/core/tests/`, next to existing project-schema tests): `assertEventCount` with only `event` fails refine with message `assertEventCount requires at least one of equals, min, or max`; with `min: 1` parses.

- [ ] **Step 2: Schema.** In `packages/core/src/schema/project.ts` add to `PlaytestStepUnionSchema`:

```ts
  z.object({
    type: z.literal('assertEventCount'),
    event: z.string().min(1),
    equals: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
```

and a second branch in the existing `superRefine` mirroring the `assertParticleCount` rule with the message above.

- [ ] **Step 3: Failing playtest test**: build a project (same helper pattern as the existing `assertParticleCount` tests in packages/playtest/tests) whose script emits `ctx.events.emit('coin')` 3 times over the run; playtest steps `[{type:'wait',frames:30},{type:'assertEventCount',event:'coin',equals:3},{type:'assertEventCount',event:'coin',min:5}]`; assert step 2 passes, step 3 fails with a message containing `count 3`; assert `result.eventCounts.coin === 3` and `result.events.length === 3`.

- [ ] **Step 4: Implement.** In `packages/playtest/src/index.ts`:
  - Add `'assertEventCount'` to `ASSERT_TYPES` (line ~82-89).
  - Add the `executeStep` case (model on `assertParticleCount`, ~346-388):

```ts
    case 'assertEventCount': {
      const count = session.eventCounts.get(step.event) ?? 0;
      const failures: string[] = [];
      if (step.equals !== undefined && count !== step.equals) failures.push(`expected exactly ${step.equals}`);
      if (step.min !== undefined && count < step.min) failures.push(`expected at least ${step.min}`);
      if (step.max !== undefined && count > step.max) failures.push(`expected at most ${step.max}`);
      const passed = failures.length === 0;
      return {
        index, type: step.type, passed,
        message: passed
          ? `event "${step.event}" count ${count} OK`
          : `event "${step.event}" count ${count}: ${failures.join(', ')}`,
      };
    }
```

  (Match the surrounding code's exact result-building style; `session` is however the existing cases reach the GameSession.)
  - Extend `PlaytestResult` and `SmokeResult` with `events: { frame: number; name: string; data?: unknown }[]` and `eventCounts: Record<string, number>`; populate where `audioEvents` is copied: `events: [...session.events], eventCounts: Object.fromEntries(session.eventCounts)`.

- [ ] **Step 5: Run** `npx vitest run packages/playtest packages/core` — green.

- [ ] **Step 6: Commit** `git commit -m "Playtest: record emitted events and add assertEventCount step"` (add the touched files explicitly).

---

### Task 4: Core pathfinding module (pure A*)

**Files:**
- Create: `packages/core/src/pathfinding.ts`
- Modify: `packages/core/src/index.ts` (re-export)
- Test: `packages/core/tests/pathfinding.test.ts`

**Interfaces:**
- Consumes: `Vec2`, `ColliderComponent`, `TilemapComponent`, `TransformComponent` types from core schemas.
- Produces (Tasks 5 and 6 rely on these exactly):

```ts
export interface NavRect { x: number; y: number; width: number; height: number } // top-left + size, world px
export interface NavGrid { cellSize: number; originX: number; originY: number; cols: number; rows: number; solid: Uint8Array }
export interface NavEntityInput {
  position: Vec2;                                     // world position
  transform?: { rotation: number; scale: Vec2 };
  collider?: ColliderComponent;
  tilemap?: TilemapComponent;
  bodyType: 'dynamic' | 'static' | 'kinematic';       // 'static' when no PhysicsBody
}
export function collectNavSolids(entities: NavEntityInput[]): { cellSize: number; solids: NavRect[] }
export function buildNavGrid(opts: { cellSize: number; solids: NavRect[]; include?: Vec2[] }): NavGrid
export function findPath(grid: NavGrid, from: Vec2, to: Vec2, opts?: { diagonals?: boolean }): Vec2[] | null
```

- [ ] **Step 1: Failing tests** `packages/core/tests/pathfinding.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildNavGrid, findPath, collectNavSolids } from '@hearth/core';

const wall = (x: number, y: number, w = 32, h = 32) => ({ x, y, width: w, height: h });

describe('buildNavGrid', () => {
  it('marks cells solid on >1% area overlap, not edge contact', () => {
    const grid = buildNavGrid({ cellSize: 32, solids: [wall(32, 32)] });
    const cellAt = (wx: number, wy: number) => {
      const col = Math.floor((wx - grid.originX) / grid.cellSize);
      const row = Math.floor((wy - grid.originY) / grid.cellSize);
      return grid.solid[row * grid.cols + col];
    };
    expect(cellAt(48, 48)).toBe(1);  // fully covered cell
    expect(cellAt(16, 48)).toBe(0);  // edge-adjacent cell (exact edge contact) stays walkable
  });
  it('pads bounds by 2 cells and includes query points', () => {
    const grid = buildNavGrid({ cellSize: 32, solids: [wall(0, 0)], include: [{ x: 500, y: 0 }] });
    expect(grid.originX).toBeLessThanOrEqual(-64);
    expect(grid.originX + grid.cols * 32).toBeGreaterThan(500);
  });
  it('throws over 512x512 cells', () => {
    expect(() =>
      buildNavGrid({ cellSize: 1, solids: [wall(0, 0, 1, 1), wall(600, 600, 1, 1)] }),
    ).toThrow(/max 512x512/);
  });
});

describe('findPath', () => {
  // 5x5 open field with a full-height vertical wall at col 2, gap at row 4 (bottom)
  const solids = [wall(64, 0, 32, 32), wall(64, 32), wall(64, 64), wall(64, 96)];
  const grid = buildNavGrid({ cellSize: 32, solids, include: [{ x: 16, y: 16 }, { x: 144, y: 16 }] });
  it('routes around the wall, 4-directional', () => {
    const path = findPath(grid, { x: 16, y: 16 }, { x: 144, y: 16 });
    expect(path).not.toBeNull();
    // Waypoints are cell centers: every step differs by exactly one axis, 32px
    for (let i = 1; i < path!.length; i++) {
      const dx = Math.abs(path![i].x - path![i - 1].x);
      const dy = Math.abs(path![i].y - path![i - 1].y);
      expect(dx + dy).toBe(32);
    }
    expect(path![0]).toEqual({ x: 16, y: 16 });
    expect(path![path!.length - 1]).toEqual({ x: 144, y: 16 });
  });
  it('diagonals shorten the path and never cut corners', () => {
    const p4 = findPath(grid, { x: 16, y: 16 }, { x: 144, y: 16 })!;
    const p8 = findPath(grid, { x: 16, y: 16 }, { x: 144, y: 16 }, { diagonals: true })!;
    expect(p8.length).toBeLessThan(p4.length);
    for (let i = 1; i < p8.length; i++) {
      const isDiagonal = p8[i].x !== p8[i - 1].x && p8[i].y !== p8[i - 1].y;
      if (isDiagonal) {
        // both orthogonal neighbors of the diagonal step must be walkable
        const cell = (wx: number, wy: number) =>
          grid.solid[Math.floor((wy - grid.originY) / 32) * grid.cols + Math.floor((wx - grid.originX) / 32)];
        expect(cell(p8[i].x, p8[i - 1].y)).toBe(0);
        expect(cell(p8[i - 1].x, p8[i].y)).toBe(0);
      }
    }
  });
  it('returns null when from/to are solid or unreachable', () => {
    expect(findPath(grid, { x: 80, y: 16 }, { x: 144, y: 16 })).toBeNull(); // from inside wall
    const sealed = buildNavGrid({
      cellSize: 32,
      solids: [wall(32, 0), wall(32, 32), wall(32, 64), wall(0, 64), wall(-32, 64), wall(-32, 32), wall(-32, 0), wall(0, -32), wall(32, -32), wall(-32, -32)],
      include: [{ x: 16, y: 16 }, { x: 300, y: 300 }],
    });
    expect(findPath(sealed, { x: 16, y: 16 }, { x: 300, y: 300 })).toBeNull();
  });
  it('same-cell from/to returns the single cell center', () => {
    const p = findPath(grid, { x: 10, y: 10 }, { x: 20, y: 20 });
    expect(p).toEqual([{ x: 16, y: 16 }]);
  });
  it('is deterministic', () => {
    const a = findPath(grid, { x: 16, y: 16 }, { x: 144, y: 112 }, { diagonals: true });
    const b = findPath(grid, { x: 16, y: 16 }, { x: 144, y: 112 }, { diagonals: true });
    expect(a).toEqual(b);
  });
});

describe('collectNavSolids', () => {
  it('uses first solid tilemap tileSize, static colliders, skips triggers and movers', () => {
    const { cellSize, solids } = collectNavSolids([
      { position: { x: 0, y: 0 }, bodyType: 'static',
        tilemap: { tileSize: 16, tileAssets: {}, grid: ['#.', '.#'], solid: true, layer: 0 } as any },
      { position: { x: 100, y: 100 }, bodyType: 'static',
        collider: { shape: 'box', width: 32, height: 32, radius: 16, points: [], offset: { x: 0, y: 0 }, isTrigger: false } as any },
      { position: { x: 200, y: 200 }, bodyType: 'static',
        collider: { shape: 'box', width: 32, height: 32, radius: 16, points: [], offset: { x: 0, y: 0 }, isTrigger: true } as any },
      { position: { x: 300, y: 300 }, bodyType: 'dynamic',
        collider: { shape: 'box', width: 32, height: 32, radius: 16, points: [], offset: { x: 0, y: 0 }, isTrigger: false } as any },
    ]);
    expect(cellSize).toBe(16);
    expect(solids).toHaveLength(3); // 2 tilemap cells + 1 static collider
    expect(solids.some((r) => r.x === 84 && r.y === 84)).toBe(true); // box centered at 100 → top-left 84
  });
  it('defaults cellSize to 32 with no solid tilemap', () => {
    expect(collectNavSolids([]).cellSize).toBe(32);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** `packages/core/src/pathfinding.ts`. Requirements (write the real code, this is the shape):

```ts
/**
 * Grid A* pathfinding — pure data logic shared by the inspectPath command
 * (authored scenes) and ctx.scene.findPath (live runtime state). No runtime
 * dependency; deterministic: fixed neighbor order N,E,S,W,NE,SE,SW,NW,
 * ties broken by lower g then insertion sequence.
 */
import type { ColliderComponent, TilemapComponent, Vec2 } from './schema/components.js';

export interface NavRect { x: number; y: number; width: number; height: number }
export interface NavGrid { cellSize: number; originX: number; originY: number; cols: number; rows: number; solid: Uint8Array }
export interface NavEntityInput {
  position: Vec2;
  transform?: { rotation: number; scale: Vec2 };
  collider?: ColliderComponent;
  tilemap?: TilemapComponent;
  bodyType: 'dynamic' | 'static' | 'kinematic';
}

const MAX_GRID = 512;
const SOLID_OVERLAP_FRACTION = 0.01;

export function collectNavSolids(entities: NavEntityInput[]): { cellSize: number; solids: NavRect[] } {
  // cellSize: first entity (input order) with tilemap?.solid → its tileSize, else 32.
  // Solids: for each solid tilemap, one cellSize? NO — one tileSize rect per non-'.'/non-' ' grid char
  //   at { x: pos.x + col*ts, y: pos.y + row*ts, width: ts, height: ts } (same cell walk as
  //   tilemapBoxes in packages/runtime/src/physics.ts, but top-left rects instead of center boxes).
  // For each entity with a collider, bodyType 'static', and !collider.isTrigger → its AABB:
  //   box: { x: pos.x + offset.x - width/2, y: pos.y + offset.y - height/2, width, height }
  //   circle: same with radius as half extents
  //   polygon: transform points by scale then rotation (degrees) then translate by pos+offset
  //     (identical math to colliderShape in packages/runtime/src/physics.ts lines 66-79),
  //     then take min/max bounds; polygons with <3 points contribute nothing.
  // Dynamic and kinematic bodies are never obstacles.
}

export function buildNavGrid(opts: { cellSize: number; solids: NavRect[]; include?: Vec2[] }): NavGrid {
  // Bounds: min/max over all solid rects and include points; expand by 2*cellSize on every side.
  // No solids and no includes → 1x1 walkable grid at origin.
  // cols/rows = ceil(span / cellSize); if cols > 512 || rows > 512 throw
  //   new Error(`nav grid too large: ${cols}x${rows} cells (max 512x512)`);
  // Mark solid: for each rect, compute overlapping cell index range, and per cell compute
  //   overlap area; mark when overlapArea > SOLID_OVERLAP_FRACTION * cellSize * cellSize.
}

export function findPath(grid, from, to, opts): Vec2[] | null {
  // Cell of a point: floor((p - origin) / cellSize); out-of-bounds or solid start/goal → null.
  // A*: g in cells (orthogonal cost 1, diagonal Math.SQRT2), heuristic Manhattan (octile with
  //   diagonals: max+ (SQRT2-1)*min of |dx|,|dy| in cells). Open list = binary min-heap ordered by
  //   (f, then g, then insertion seq). Neighbor order exactly N(0,-1), E(1,0), S(0,1), W(-1,0),
  //   then with diagonals NE(1,-1), SE(1,1), SW(-1,1), NW(-1,-1). A diagonal neighbor is admitted
  //   only when BOTH its orthogonal cell neighbors are walkable (no corner cutting).
  // Reconstruct via cameFrom; map cells to centers: { x: originX + (col+0.5)*cellSize, y: ... }.
  // Same start/goal cell → [goalCenter].
}
```

  Re-export everything from `packages/core/src/index.ts` (match its existing export style).

- [ ] **Step 4: Run tests** — pathfinding tests PASS, `npx vitest run packages/core` green.

- [ ] **Step 5: Commit** `git commit -m "Core: deterministic grid A* pathfinding module"`.

---

### Task 5: `inspectPath` command + CLI + MCP

**Files:**
- Modify: `packages/core/src/commands/inspectCommands.ts`, `packages/core/src/commands/registry.ts`, `packages/cli/src/program.ts`, `packages/mcp-server/src/tools.ts`
- Test: `packages/core/tests/` (command test, next to existing inspect command tests), `packages/cli/tests/` and `packages/mcp-server/tests/` (extend the existing command-listing/smoke tests in whatever pattern those suites already use for inspect commands)

**Interfaces:**
- Consumes: `collectNavSolids`, `buildNavGrid`, `findPath` (Task 4).
- Produces: command `inspectPath` with params `{ scene: string, from: Vec2, to: Vec2, diagonals?: boolean }` returning `{ found: boolean, path: Vec2[] | null, cells: number, cellSize: number }`; CLI `hearth inspect path <scene> --from x,y --to x,y [--diagonals]`; MCP tool `inspect_path`.

- [ ] **Step 1: Failing command test**: build a store via the same helper existing inspect-command tests use; scene with a solid Tilemap wall and two open areas; `session.execute('inspectPath', { scene, from: {...}, to: {...} })` → `success`, `found: true`, path is an array of `{x,y}`; a blocked query → `found: false, path: null`; unknown scene → `success: false` (match how `inspectScene` reports unknown scenes — same error style).

- [ ] **Step 2: Implement the command** in `packages/core/src/commands/inspectCommands.ts`:

```ts
export const inspectPath = defineCommand({
  name: 'inspectPath',
  description:
    'Find a walkable grid path between two world points in a scene (A* over solid tilemaps and static colliders). Read-only; uses authored entity positions.',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({
    scene: z.string().min(1),
    from: z.object({ x: z.number(), y: z.number() }),
    to: z.object({ x: z.number(), y: z.number() }),
    diagonals: z.boolean().default(false),
  }),
  async run(ctx, params) {
    // Resolve scene by id or name (mirror inspectScene's lookup + unknown-scene error).
    // World position per entity = sum of Transform.position up the parent chain
    //   (mirror the runtime's getWorldPosition semantics).
    // Map entities → NavEntityInput: bodyType from components.PhysicsBody?.bodyType ?? 'static'.
    // const { cellSize, solids } = collectNavSolids(inputs);
    // const grid = buildNavGrid({ cellSize, solids, include: [params.from, params.to] });
    //   (catch the too-large Error → return it as a command error, same style as other command errors)
    // const path = findPath(grid, params.from, params.to, { diagonals: params.diagonals });
    // return { found: path !== null, path, cells: grid.cols * grid.rows, cellSize };
  },
});
```

Register it in `registry.ts`'s `ALL_DEFINITIONS` under the `// inspect (read-only)` group.

- [ ] **Step 3: CLI leaf.** In `packages/cli/src/program.ts`, inside the `inspect` group (after the `api` leaf ~line 163):

```ts
addGlobalOptions(
  inspect
    .command('path <scene>')
    .description('find a walkable path between two points (A* over solid geometry)')
    .requiredOption('--from <x,y>', 'start position')
    .requiredOption('--to <x,y>', 'goal position')
    .option('--diagonals', 'allow 8-directional movement'),
).action(async (scene: string, opts: { from: string; to: string; diagonals?: boolean }, cmd) => {
  await guarded(cmd, 'inspectPath', () =>
    runAndEmit(cmd, 'inspectPath', {
      scene,
      from: parsePosition(opts.from),
      to: parsePosition(opts.to),
      diagonals: Boolean(opts.diagonals),
    }),
  );
});
```

(`parsePosition` exists in `packages/cli/src/parse.ts:24-34`; import it if the file section doesn't already.)

- [ ] **Step 4: MCP tool.** In `packages/mcp-server/src/tools.ts`, append to `TOOL_SPECS` in the inspect section:

```ts
  {
    name: 'inspect_path',
    command: 'inspectPath',
    description:
      'Find a walkable grid path between two world points in a scene (A* over solid tilemaps and static colliders). Returns waypoints or found=false.',
    permission: 'read-only',
    inputShape: {
      scene: z.string().min(1),
      from: positionShape,
      to: positionShape,
      diagonals: z.boolean().optional(),
    },
  },
```

- [ ] **Step 5: Run** `npx vitest run packages/core packages/cli packages/mcp-server` — green (extend any tool-count/command-count snapshot tests those suites assert).

- [ ] **Step 6: Commit** `git commit -m "Core/CLI/MCP: inspect path command (grid A* over scene geometry)"`.

---

### Task 6: `ctx.scene.findPath` (runtime)

**Files:**
- Modify: `packages/runtime/src/runtime.ts`, `packages/runtime/src/scripts.ts`, `packages/core/src/ctxApi.ts`
- Test: `packages/runtime/tests/pathfinding-runtime.test.ts`, extend `packages/runtime/tests/lua.test.ts`

**Interfaces:**
- Consumes: `collectNavSolids`, `buildNavGrid`, `findPath` from `@hearth/core` (Task 4).
- Produces: `ctx.scene.findPath(from: Vec2, to: Vec2, opts?: { diagonals?: boolean }): Vec2[] | null` — returns `null` (JS null, for Lua nil) on no path / grid error.

- [ ] **Step 1: Failing tests** `packages/runtime/tests/pathfinding-runtime.test.ts` (use `makeStore`/`ent` helpers):
  - a scene with a solid Tilemap wall between a scripted entity and a target; script's onStart calls `ctx.scene.findPath` and logs `path && path.length`; assert a positive length.
  - live-state test: the same query returns different results after a static wall entity is destroyed and a frame passes (grid memo is per frame).
  - grid-too-large: a scene with two static colliders 100,000px apart with tileSize 16 tilemap → findPath returns null and a warn log containing `nav grid too large` is recorded.
  - memoization: two calls in the same frame; assert via behavior (both return non-null; this is a smoke check — the memo itself is verified by the frame-boundary test above).

- [ ] **Step 2: Implement.** In `runtime.ts`:
  - Fields: `private navGrid: NavGrid | null = null;`, `private navGridFrame = -1;`, `private navGridFailed = false;`
  - Private method:

```ts
  private getNavGrid(include: Vec2[]): NavGrid | null {
    if (this.navGridFrame !== this._frame) {
      this.navGridFrame = this._frame;
      this.navGridFailed = false;
      const inputs: NavEntityInput[] = [];
      for (const entity of this.getEntities()) {
        if (!entity.enabled) continue;
        inputs.push({
          position: this.getWorldPosition(entity),
          transform: entity.transform,
          collider: entity.components.Collider,
          tilemap: entity.components.Tilemap,
          bodyType: entity.components.PhysicsBody?.bodyType ?? 'static',
        });
      }
      const { cellSize, solids } = collectNavSolids(inputs);
      try {
        this.navGrid = buildNavGrid({ cellSize, solids, include });
      } catch (err) {
        this.navGrid = null;
        this.navGridFailed = true;
        this.recordLog('warn', `ctx.scene.findPath: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return this.navGrid;
  }
```

  Memo rule (implement exactly this): the cached grid is valid for the current frame AND only if both query points fall inside its bounds. In `getNavGrid`, when `navGridFrame === this._frame` and the cached grid contains all `include` points, return it; otherwise rebuild with `include` and re-cache (still stamped with the current frame). This keeps the common case (repeated queries within the level) at one build per frame while a far-out query never silently misses.
  - In `makeContext`'s `scene` namespace add:

```ts
        findPath: (from: Vec2, to: Vec2, opts?: { diagonals?: boolean }) => {
          const grid = this.getNavGrid([from, to]);
          if (!grid) return null;
          return findPath(grid, from, to, { diagonals: Boolean(opts?.diagonals) });
        },
```

  - `scripts.ts` `ScriptContext.scene` gains `findPath(from: Vec2, to: Vec2, opts?: { diagonals?: boolean }): Vec2[] | null;`.

- [ ] **Step 3: Run tests**, fix, `npx vitest run packages/runtime` green.

- [ ] **Step 4: Lua test** in `lua.test.ts`: Lua script calling `local path = ctx.scene.findPath({ x = 0, y = 0 }, { x = 100, y = 0 })` then `ctx.log(path == nil and "nil" or #path)` — assert a numeric length (and that a blocked query logs `nil`, proving NullToNil works).

- [ ] **Step 5: CTX_API entry** for `scene.findPath` (description mentions: grid A* over solid tilemaps + static colliders, cell centers, null when unreachable, diagonals option).

- [ ] **Step 6: Commit** `git commit -m "Runtime: ctx.scene.findPath over live scene geometry"`.

---

### Task 7: Physics v2 schemas + validation

**Files:**
- Modify: `packages/core/src/schema/components.ts`, `packages/core/src/validate.ts`
- Test: extend `packages/core/tests/` schema + validate test files (wherever ColliderSchema/validateProject are already tested)

**Interfaces:**
- Produces (Tasks 8-11 rely on these):
  - `PhysicsBodySchema` + `mass: z.number().positive().default(1)`, `restitution: z.number().min(0).max(1).default(0)`, `friction: z.number().min(0).max(1).default(0)`
  - `ColliderSchema` + `layer: z.string().min(1).default('default')`, `collidesWith: z.array(z.string()).default(['*'])`, `oneWay: z.boolean().default(false)`
  - validate warnings with codes `COLLIDER_COLLIDES_WITH_NOTHING`, `COLLIDES_WITH_UNKNOWN_LAYER`

- [ ] **Step 1: Failing tests**: `createComponent('PhysicsBody')` yields `{ ..., mass: 1, restitution: 0, friction: 0 }`; `createComponent('Collider')` yields `{ ..., layer: 'default', collidesWith: ['*'], oneWay: false }`; `mass: 0` rejected; `restitution: 1.5` rejected. Validate tests: a Collider with `collidesWith: []` → warning `COLLIDER_COLLIDES_WITH_NOTHING`; `collidesWith: ['ghosts']` when no collider in the project has `layer: 'ghosts'` → warning `COLLIDES_WITH_UNKNOWN_LAYER`; `collidesWith: ['*']` never warns.

- [ ] **Step 2: Implement schema fields** exactly as in Interfaces, with doc comments:

```ts
  // PhysicsBodySchema additions:
  /** Relative mass for mover-vs-mover push splits (heavier moves less). */
  mass: z.number().positive().default(1),
  /** Bounciness on contact, 0 (stop) to 1 (full reflect). Pair uses the max. */
  restitution: z.number().min(0).max(1).default(0),
  /** Tangential velocity damping on contact, 0 (slick) to 1 (grippy). Pair uses the max. */
  friction: z.number().min(0).max(1).default(0),

  // ColliderSchema additions:
  /** Named collision layer this collider belongs to. */
  layer: z.string().min(1).default('default'),
  /** Layers this collider interacts with; '*' matches every layer. Both sides must match. */
  collidesWith: z.array(z.string()).default(['*']),
  /** One-way platform: only blocks movers landing from above. */
  oneWay: z.boolean().default(false),
```

Update `COMPONENT_DOCS.PhysicsBody` and `COMPONENT_DOCS.Collider` to mention the new fields (keep one-line style).

- [ ] **Step 3: Implement validate warnings** in `packages/core/src/validate.ts` in the per-entity component loop (~238-370), following the exact `push({ severity, code, message, scene, entity })` shape. For `COLLIDES_WITH_UNKNOWN_LAYER`, first collect `const usedLayers = new Set<string>()` over every Collider's `layer` across all scenes (do this in a pre-pass before the per-entity loop), then warn per unknown entry: `Entity "X" collidesWith "ghosts" but no Collider in the project uses layer "ghosts"`.

- [ ] **Step 4: Run** `npx vitest run packages/core` — green (existing schema snapshot tests may need the new defaults added — that's expected, update them).

- [ ] **Step 5: Commit** `git commit -m "Core: physics v2 schema fields (mass/restitution/friction, layers, oneWay)"`.

---

### Task 8: Contact response — restitution, friction, mass split

**Files:**
- Modify: `packages/runtime/src/physics.ts` (add `resolveContactVelocity` + constants; keep `cancelVelocityAlong` exported but unused by runtime), `packages/runtime/src/runtime.ts` (`stepPhysics`)
- Test: extend `packages/runtime/tests/physics.test.ts`

**Interfaces:**
- Consumes: Task 7 schema fields.
- Produces: exported from `physics.ts`:

```ts
export const FRICTION_DAMPING = 10;
export const RESTITUTION_MIN_SPEED = 20;
export function resolveContactVelocity(
  velocity: Vec2, nx: number, ny: number,
  restitution: number, friction: number, dt: number,
): void
```

- [ ] **Step 1: Failing tests** in `physics.test.ts` (unit-level on `resolveContactVelocity`, plus runtime-level):
  - Unit: velocity (0, 100) into floor normal (0, -1) with restitution 0.5 → (0, -50); with restitution 0 → (0, 0); incoming speed 10 (< RESTITUTION_MIN_SPEED) with restitution 0.9 → normal component 0.
  - Unit: velocity (100, 50) into floor normal (0, -1), friction 1, dt 1/60 → x becomes `100 * (1 - 10/60)` = 50, y zeroed (restitution 0).
  - Unit: defaults (0, 0) leave a separating velocity (v·n ≥ 0) **bit-identical** (object equality on exact numbers).
  - Runtime: a dynamic ball (restitution 0.8) dropped on a static floor bounces (velocity.y flips negative after impact frame); with defaults it settles exactly like the existing landing test.
  - Runtime: mass split — two dynamic boxes overlapping, mass 1 vs mass 3: after one step the light one moved 3× the heavy one's displacement (assert ratio with tolerance).
  - Existing suite untouched: **do not modify any pre-existing physics test** — they must pass as-is (defaults reproduce v1).

- [ ] **Step 2: Implement** `resolveContactVelocity` in `physics.ts`:

```ts
/** Velocity response on contact. At (restitution=0, friction=0) this is exactly cancelVelocityAlong. */
export function resolveContactVelocity(
  velocity: Vec2,
  nx: number,
  ny: number,
  restitution: number,
  friction: number,
  dt: number,
): void {
  if (restitution === 0 && friction === 0) {
    cancelVelocityAlong(velocity, nx, ny); // bit-identical v1 path
    return;
  }
  const vn = velocity.x * nx + velocity.y * ny;
  const tx = -ny;
  const ty = nx;
  let vt = velocity.x * tx + velocity.y * ty;
  let outVn = vn;
  if (vn < 0) {
    const e = -vn < RESTITUTION_MIN_SPEED ? 0 : restitution;
    outVn = -e * vn;
  }
  if (friction > 0) {
    vt *= Math.max(0, 1 - friction * FRICTION_DAMPING * dt);
  }
  velocity.x = outVn * nx + vt * tx;
  velocity.y = outVn * ny + vt * ty;
}
```

- [ ] **Step 3: Wire `stepPhysics`.** In `runtime.ts`:
  - Extend the local `Mover`/`Obstacle` interfaces with `body?: PhysicsBodyComponent` (movers already fetch it; obstacles: `entity.components.PhysicsBody`).
  - `applyPush` gains the contact partner: `applyPush(mover, nx, ny, amount, other: { restitution: number; friction: number })` computing:

```ts
      const body = mover.entity.components.PhysicsBody;
      if (body) {
        const e = Math.max(body.restitution, other.restitution);
        const mu = Math.max(body.friction, other.friction);
        resolveContactVelocity(body.velocity, nx, ny, e, mu, this.fixedDt);
      }
```

  - Partner values: from the other side's PhysicsBody when present, else `{ restitution: 0, friction: 0 }` (static colliders and tilemap cells).
  - Mass split in mover-vs-mover (both dynamic): replace the `/2` split with inverse-mass proportions `const ma = a.body?.mass ?? 1, mb = b.body?.mass ?? 1;` → a gets `push.amount * mb / (ma + mb)`, b gets the rest. Kinematic partners keep the existing branch structure (dynamic side absorbs the full push).

- [ ] **Step 4: Run** `npx vitest run packages/runtime` — ALL green including every pre-existing physics test unchanged.

- [ ] **Step 5: Commit** `git commit -m "Runtime: restitution, friction, and mass-weighted push resolution"`.

---

### Task 9: Collision layers + one-way platforms (+ debug-draw arrow)

**Files:**
- Modify: `packages/runtime/src/physics.ts` (layersInteract helper), `packages/runtime/src/runtime.ts` (stepPhysics filtering), `packages/runtime/src/pixi/index.ts` (debug overlay arrow)
- Test: extend `packages/runtime/tests/physics.test.ts`

**Interfaces:**
- Consumes: Task 7 fields, Task 8 mover/obstacle structure.
- Produces: exported `layersInteract(a: { layer: string; collidesWith: string[] }, b: { layer: string; collidesWith: string[] }): boolean`; `TILEMAP_FILTER = { layer: 'default', collidesWith: ['*'] } as const`.

- [ ] **Step 1: Failing tests**:
  - Unit `layersInteract`: defaults ↔ defaults true; `{layer:'a', collidesWith:['b']}` vs `{layer:'b', collidesWith:['a']}` true; one side not listing the other false; `'*'` matches anything; empty `collidesWith` false against everything.
  - Runtime: two overlapping dynamic bodies on mutually-excluded layers pass through — no push, `entity.collisions` empty, no onCollision hook fired (script logs on collision; assert absent). Trigger pairs also filtered (no trigger contact).
  - Runtime one-way, all four approaches against a static `oneWay` box platform: falling from above → lands (contact, isGrounded true); jumping up from below (velocity.y < 0) → passes through, no contact; approaching horizontally from the side while overlapping (push would be sideways, fails the `ny < -0.707` gate) → passes through; standing on top with velocity.y = 0 → supported.
  - Runtime: trigger + oneWay → trigger events still fire regardless of approach.

- [ ] **Step 2: Implement `layersInteract`** in `physics.ts`:

```ts
/** Both sides must list the other's layer ('*' matches any). */
export function layersInteract(
  a: { layer: string; collidesWith: string[] },
  b: { layer: string; collidesWith: string[] },
): boolean {
  const match = (list: string[], layer: string) => list.includes('*') || list.includes(layer);
  return match(a.collidesWith, b.layer) && match(b.collidesWith, a.layer);
}
export const TILEMAP_FILTER = { layer: 'default', collidesWith: ['*'] as string[] };
```

- [ ] **Step 3: Wire `stepPhysics`.** Extend `Mover`/`Obstacle` with `filter: { layer: string; collidesWith: string[] }` and `oneWay: boolean` (from the collider; tilemap obstacles get `TILEMAP_FILTER` and `oneWay: false`). In both pair loops, before `computeShapePush`:

```ts
        if (!layersInteract(mover.filter, obstacle.filter)) continue;
```

After computing a push, gate one-way (skip contact AND events, but only for non-trigger pairs):

```ts
        if (!trigger && !passesOneWay(mover, obstacle.oneWay, push.ny)) continue;
```

with a small helper (in runtime.ts next to stepPhysics):

```ts
    // One-way platforms: the obstacle only blocks a mover being resolved
    // upward (landing on top) while the mover is not moving up through it.
    const passesOneWay = (mover: Mover, obstacleOneWay: boolean, ny: number): boolean => {
      if (!obstacleOneWay) return true;
      if (ny >= -0.707) return false;
      const vy = mover.entity.components.PhysicsBody?.velocity.y ?? 0;
      return vy >= 0;
    };
```

Mover-vs-mover: check both directions — `a` pushed by `push` against `b.oneWay`, `b` pushed by `-push` against `a.oneWay` (`-push.ny < -0.707` ⇔ `push.ny > 0.707`); if either applicable one-way check fails, skip the pair (continue). Trigger pairs bypass one-way entirely (spec: triggers ignore oneWay).

- [ ] **Step 4: Debug-draw arrow.** In `packages/runtime/src/pixi/index.ts` debug overlay (where collider outlines are drawn from `colliderShape` — same color `#00ff88`): for colliders with `oneWay`, draw an upward arrow at the shape's top edge — a vertical line from `(box.cx, box.cy - box.hh + 8)` to `(box.cx, box.cy - box.hh - 8)` plus two head strokes to `(box.cx ± 5, box.cy - box.hh - 3)`, stroke width 2, same debug color.

- [ ] **Step 5: Run** `npx vitest run packages/runtime` green (pre-existing tests untouched — defaults filter nothing).

- [ ] **Step 6: Commit** `git commit -m "Runtime: named collision layers and one-way platforms"`.

---

### Task 10: Circle-accurate resolution

**Files:**
- Modify: `packages/runtime/src/physics.ts` (`computeShapePush` + two new helpers)
- Test: extend `packages/runtime/tests/physics.test.ts`

**Interfaces:**
- Consumes/produces: `computeShapePush` keeps its exact signature; only circle-circle and circle-box pairs change behavior.

- [ ] **Step 1: Failing tests**:
  - circle-circle: r16 at (0,0) vs r16 at (20,0) → push along -x with amount 12 (the push moves `a` OUT of `b`, so a at origin moves -x — not the AABB axis split); diagonal case r16 at (0,0) vs r16 at (20,20): normal ≈ (-0.707, -0.707), amount `32 - Math.hypot(20,20)`; concentric circles → deterministic +x fallback: assert `nx === 1, ny === 0, amount === 32`.
  - circle-box corner: circle r16 centered at (40, 40) vs box 64×64 centered at (0, 0) (corner at (32,32)): closest point (32, 32), distance `Math.hypot(8,8)` ≈ 11.31 < 16 → push along normalized (8,8) direction with amount `16 - 11.31…` (assert with toBeCloseTo). The old AABB code would have pushed axis-aligned — this is the intended change.
  - circle center inside box → falls back to the AABB axis push (assert it matches `computePush(a.box, b.box)`).
  - box-box and polygon pairs unchanged: re-run existing suite.
  - Runtime: a circle-collider ball rolling off a box corner no longer snags (drop circle offset from the box edge; assert x-position drifts past the corner over 30 frames — bake the exact assertion from observed behavior, comparing old/new is unnecessary; just assert the new geometric truth: final position below and beside the corner).

- [ ] **Step 2: Implement.** In `computeShapePush` (physics.ts:146), after the degenerate-polygon guard and before the `a.kind !== 'polygon' && b.kind !== 'polygon'` AABB branch, insert:

```ts
  if (a.kind === 'circle' && b.kind === 'circle') return circleCirclePush(a, b);
  if (a.kind === 'circle' && b.kind === 'box') return circleBoxPush(a, b.box);
  if (a.kind === 'box' && b.kind === 'circle') {
    const push = circleBoxPush(b, a.box);
    return push ? { nx: -push.nx, ny: -push.ny, amount: push.amount } : null;
  }
```

with, in the SAT-internals section:

```ts
/** True circle-vs-circle push (a out of b). Concentric circles push a toward +x. */
function circleCirclePush(
  a: { x: number; y: number; radius: number },
  b: { x: number; y: number; radius: number },
): Push | null {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dist = Math.hypot(dx, dy);
  const overlap = a.radius + b.radius - dist;
  if (overlap <= 0) return null;
  if (dist === 0) return { nx: 1, ny: 0, amount: a.radius + b.radius };
  return { nx: dx / dist, ny: dy / dist, amount: overlap };
}

/** True circle-vs-box push (circle out of box) via closest point; center-inside falls back to AABB axes. */
function circleBoxPush(
  circle: { x: number; y: number; radius: number; box: Box },
  box: Box,
): Push | null {
  const cx = Math.min(box.cx + box.hw, Math.max(box.cx - box.hw, circle.x));
  const cy = Math.min(box.cy + box.hh, Math.max(box.cy - box.hh, circle.y));
  const dx = circle.x - cx;
  const dy = circle.y - cy;
  if (dx === 0 && dy === 0) return computePush(circle.box, box); // center inside: axis push
  const dist = Math.hypot(dx, dy);
  const overlap = circle.radius - dist;
  if (overlap <= 0) return null;
  return { nx: dx / dist, ny: dy / dist, amount: overlap };
}
```

- [ ] **Step 3: Run the FULL suite** `npx vitest run` from root. Circle behavior changes may shift existing runtime/playtest/example expectations — fix forward: where a test asserted AABB-era circle positions, update to the new geometric truth (verify each by reasoning about the geometry, not by pasting observed values blindly). Example projects are regenerated in Task 12 — if `packages/examples/tests/examples.test.ts` fails here because committed example expectations shifted, run `npm run build:packages && node packages/examples/generate.mjs` to re-bake and commit the regenerated projects with this task.

- [ ] **Step 4: Commit** `git commit -m "Runtime: true circle-circle and circle-box collision resolution"`.

---

### Task 11: Editor — StringListField for `collidesWith`

**Files:**
- Create: `apps/editor/src/stringList.ts`
- Modify: `apps/editor/src/components/Inspector.tsx`
- Test: `apps/editor/tests/stringList.test.ts`

**Interfaces:**
- Consumes: Vec2ListField pattern (Inspector.tsx:107-143), `vec2List.ts` helper style.
- Produces: `StringListField` control rendering any `string[]` component field; helpers `setStringAt(list, index, value): string[]`, `removeString(list, index, min): string[] | null`, `addString(list, placeholder?): string[]`.

- [ ] **Step 1: Failing helper tests** `apps/editor/tests/stringList.test.ts` (mirror `vec2List.test.ts` style — pure, no DOM): `setStringAt(['a','b'], 1, 'c')` → `['a','c']` (fresh array, input untouched); `removeString(['a'], 0, 0)` → `[]`; `removeString(['a'], 0, 1)` → `null`; `addString([])` → `['']`; `addString(['x'])` → `['x', '']`.

- [ ] **Step 2: Implement** `apps/editor/src/stringList.ts` (doc comment mirroring vec2List.ts's DOM-free rationale) with those three pure functions.

- [ ] **Step 3: StringListField component** in `Inspector.tsx`, structurally identical to `Vec2ListField` (same `.vec2-list` / `.vec2-list-row` / `.icon-btn.danger` / `.btn.btn-sm` classes, empty-state span, add button): each row is a text `<input>` (same input classes `TextField` uses) with placeholder `*`, remove button disabled at `min` (default 0), "Add layer" button. Commit on blur/Enter like `TextField`.

- [ ] **Step 4: Wire the control chain.** In the field-type if/else chain (Inspector.tsx:362-467), immediately before the `JsonField` fallback:

```tsx
} else if (isStringArray(value) && (value.length > 0 || field === 'collidesWith')) {
  control = (
    <StringListField
      value={value}
      onCommit={(list) => commitComponentField(type, field, list)}
    />
  );
}
```

with `const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');` (place next to `isVec2Array`; note `[]` must still reach StringListField for `collidesWith` — hence the field check, mirroring the points special case). Use the exact commit-callback helper the surrounding branches use (adapt names to what's there).

- [ ] **Step 5: Run** `npx vitest run apps/editor` green; then `npm run dev` sanity is NOT required (no browser in CI) — rely on tests + type check (`npx tsc -p apps/editor --noEmit` if the app has a tsconfig check script; otherwise vitest + build).

- [ ] **Step 6: Commit** `git commit -m "Editor: typed string-list control for Collider.collidesWith"`.

---

### Task 12: Bounce Patrol example + docs + v0.5.0

**Files:**
- Modify: `packages/examples/generate.mjs` (new `generateBouncePatrol()`), `docs/scripting.md`, `docs/components.md`, `docs/cli.md`, `docs/mcp.md`, `docs/architecture.md`, `docs/roadmap.md`, version files (see table below)
- Test: `packages/examples/tests/examples.test.ts` (extend to cover the new example), full suite

**Interfaces:**
- Consumes: everything from Tasks 1-11.

- [ ] **Step 1: Build packages** (generate.mjs imports dist): `npm run build:packages`.

- [ ] **Step 2: Write `generateBouncePatrol()`** in `packages/examples/generate.mjs`, following `generateGlowCaves()`'s structure (freshProject → assets → Lua scripts via `createScript` → entities via `createEntity`/`attachScript` → playtests → `validateProject`), and add `await generateBouncePatrol();` at the bottom. Scene contents (all-Lua):
  - A solid Tilemap arena (bordered room with an interior wall segment leaving a gap — gives findPath something to route around), tileSize 32.
  - `Player`: dynamic body, box collider, arrow-key movement script (reuse the movement idiom from ember-trail's player script), `friction 0.6`.
  - `Ball`: dynamic, circle collider, `restitution 0.85`, spawned above the floor so it visibly bounces.
  - `IcePatch` / `GrindStrip`: two static box colliders under different floor sections with `friction 0` vs `friction 1` (documented contrast).
  - `Ledge`: static box collider with `oneWay: true` above the floor; player can jump onto it from below.
  - `Patroller`: kinematic body whose Lua script, every 30 frames, calls `ctx.scene.findPath(me, player)` and walks waypoint-to-waypoint using `ctx.math.normalize`/`ctx.math.scale` for velocity (speed 60). On touching the player it emits `ctx.events.emit('caught')`.
  - `Coin` ×3: trigger colliders on layer `'pickup'` with `collidesWith: ['player-layer']`... — keep it demonstrative but simple: Player collider `layer: 'player'`; Coins `layer: 'pickup', collidesWith: ['player']`; Patroller projectiles are out (YAGNI — the layer demo is coins ignoring the Patroller: Patroller walks through coins because coins only collide with 'player'). Coin script: on collision emit `ctx.events.emit('coin', { value = 1 })` and `ctx.destroySelf()`.
  - `ScoreUI`: Text + UIElement entity whose Lua script uses `onEvent(ctx, name, data)` to increment `ctx.vars.score` on `'coin'` and update the Text content.
  - Playtests (bake every expectation from a probe `GameSession` run, glow-caves pattern — comment the probe values): (1) determinism/bounce: wait N frames, `assertProperty` Ball velocity/position from probe, `assertNoErrors`; (2) events: scripted input walks the player over a coin, `assertEventCount { event: 'coin', min: 1 }`; (3) one-way: player spawns under the Ledge with upward velocity, assert it ends ABOVE the ledge top (probe-baked `assertPositionNear`); (4) pathfinding: assert the Patroller has moved from its spawn (probe-baked position) proving findPath drove it.
- [ ] **Step 3: Generate + test**: `node packages/examples/generate.mjs` then `npx vitest run packages/examples` — the new example directory `packages/examples/bounce-patrol/` exists, its playtests pass. Extend `examples.test.ts` following how the other 5 examples are covered.

- [ ] **Step 4: Docs truth pass** (hand-maintained prose only — CTX_API already flows into inspect api/AGENTS.md):
  - `docs/scripting.md`: new sections for `ctx.math` (function table), `ctx.events` + `onEvent` hook (with the depth-8 + auto-cleanup rules), `ctx.scene.findPath`; JS + Lua snippets each.
  - `docs/components.md`: PhysicsBody `mass`/`restitution`/`friction` rows (incl. the max-combine rule and 20 px/s rest threshold), Collider `layer`/`collidesWith`/`oneWay` rows (both-sides-must-match rule, `'*'`).
  - `docs/cli.md`: `hearth inspect path` with an example invocation + JSON output.
  - `docs/mcp.md`: `inspect_path` tool row.
  - `docs/architecture.md`: one paragraph each — event bus (deterministic synchronous delivery), pathfinding (core module shared by command + runtime), physics response (positional MTV + restitution/friction velocity response; explicitly not an impulse solver).
  - `docs/roadmap.md`: "Shipped in v0.5.0" entry.

- [ ] **Step 5: Version bump to 0.5.0** — read `.superpowers/sdd/task-12-report.md` (the wave A bump checklist) first, then update every site: 9 `package.json` files (root, core, runtime, cli, mcp-server, playtest, examples, editor, editor/release-app), `packages/core/src/schema/project.ts` `HEARTH_VERSION`, `packages/cli/src/program.ts` `VERSION`, `packages/mcp-server/src/server.ts` `SERVER_VERSION`. Then rebuild + regenerate examples so their `hearth.json` files carry 0.5.0: `npm run build:packages && node packages/examples/generate.mjs`. Rebuild the player: `npm run build:player`.

- [ ] **Step 6: Full verification**: `npx vitest run` (entire repo) green; `npm run build` (or the repo's full build script) green.

- [ ] **Step 7: Commit** (split into two commits: example+docs, then version bump):

```bash
git add packages/examples docs
git commit -m "Examples/docs: Bounce Patrol showcase and wave B documentation"
git add -A
git commit -m "Release: bump to 0.5.0"
```
