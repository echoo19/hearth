/**
 * Editor-only, in-place live preview of a selected entity's ParticleEmitter,
 * drawn directly in the Scene view (see SceneView.tsx's particle rendering,
 * which reads `getPreviewParticles`/`particleVisual` from this module).
 *
 * This is deliberately NOT the game runtime: it drives the same pure
 * `EmitterState` stepper from `@hearth/runtime`'s particles.ts (seeded RNG,
 * no Math.random/Date.now — see that module's own docs) on a real-time rAF
 * ticker, fixed-dt accumulated so the simulation itself stays deterministic
 * even though frame pacing is real wall-clock time.
 *
 * Bundle boundary: `@hearth/runtime`'s package root also re-exports the
 * heavy, non-pure runtime (SceneRuntime, LuaScriptEngine, …) that the editor
 * only ever needs for the Game panel, which lazily `import()`s it via
 * runtimeBridge.ts so it lands in its own chunk, not the eagerly-loaded main
 * bundle. SceneView.tsx (and therefore this module) IS part of the eager
 * main bundle, so `EmitterState` — the one thing here that's an actual
 * runtime *value*, not just a type — is loaded the same lazy way (see
 * `importRuntime` below) instead of a static `import { EmitterState } from
 * '@hearth/runtime'`, so this preview can't drag the whole runtime chunk
 * into the main bundle. `Particle`/`EmitterState`-as-a-type imports are
 * `import type` and erased at build time, so they're free to import
 * statically.
 *
 * Gating (perf): the ticker only runs while ALL of (Scene panel visible,
 * the "Particles" toggle on, at least one target entity) hold — see
 * `isActive()`. Only entities passed to `setTargets` ever get an
 * `EmitterState`; nothing else in the scene simulates, and `maxParticles`
 * (schema-capped at 2048) is enforced by `EmitterState` itself.
 */
import type { ParticleEmitterComponent } from '@hearth/core';
import type { EmitterState as EmitterStateInstance, Particle } from '@hearth/runtime';
import type { Vec2 } from './types';

export type { Particle };

const DEFAULT_FIXED_DT = 1 / 60;
/**
 * If the tab/panel was throttled or hidden long enough for a huge real-time
 * gap to accumulate, cap how many fixed steps one rAF tick will try to catch
 * up on the backlog is dropped rather than causing a spawn/expire burst.
 */
const MAX_STEPS_PER_FRAME = 8;

type EmitterStateCtor = new (seed: number) => EmitterStateInstance;

/** One emitter the preview should currently be simulating, resolved by the caller (SceneView) each render. */
export interface PreviewTarget {
  entityId: string;
  emitter: ParticleEmitterComponent;
  /** World-space spawn origin (SceneView's `worldPos`, honoring ancestor Transforms). */
  origin: Vec2;
}

/** rAF-like scheduling, injected so tests can drive frames manually instead of relying on real timers. */
export interface ParticlePreviewClock {
  requestFrame(cb: (t: number) => void): number;
  cancelFrame(handle: number): void;
}

const browserClock: ParticlePreviewClock = {
  requestFrame: (cb) => requestAnimationFrame(cb),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
};

/** Loads the real `EmitterState`, injected so tests don't depend on dynamic-import timing/bundling. */
type RuntimeLoader = () => Promise<{ EmitterState: EmitterStateCtor }>;

const defaultRuntimeLoader: RuntimeLoader = () => import('@hearth/runtime');

interface TrackedEmitter {
  state: EmitterStateInstance;
  emitter: ParticleEmitterComponent;
  origin: Vec2;
  signature: string;
}

const EMPTY_PARTICLES: readonly Particle[] = [];

/**
 * Value-based signature of everything that should restart an emitter's
 * preview from a clean slate: its own field values (rate/gravity/seed/…)
 * plus world origin. Value-based (not object identity) because the editor
 * re-fetches the whole scene tree after every command, so an unrelated edit
 * elsewhere hands SceneView a brand-new (but often deep-equal) component
 * object on the very next render — that must NOT reset a running preview.
 */
function emitterSignature(emitter: ParticleEmitterComponent, origin: Vec2): string {
  return JSON.stringify([emitter, origin]);
}

export class ParticlePreview {
  private readonly clock: ParticlePreviewClock;
  private readonly loadRuntime: RuntimeLoader;
  private readonly tracked = new Map<string, TrackedEmitter>();
  private readonly listeners = new Set<() => void>();

  private ctor: EmitterStateCtor | null = null;
  private ctorLoading = false;
  private disposed = false;

  private visible = false;
  private toggleEnabled = true;
  private targets: PreviewTarget[] = [];
  private fixedDt = DEFAULT_FIXED_DT;

  private frameHandle: number | null = null;
  private lastFrameTime: number | null = null;
  private accumulator = 0;

  constructor(options?: { clock?: ParticlePreviewClock; loadRuntime?: RuntimeLoader }) {
    this.clock = options?.clock ?? browserClock;
    this.loadRuntime = options?.loadRuntime ?? defaultRuntimeLoader;
  }

  /** Whether gating currently permits the ticker to run. */
  isActive(): boolean {
    return this.visible && this.toggleEnabled && this.targets.length > 0;
  }

  /** Whether the rAF ticker is actually scheduled right now (for tests). */
  isRunning(): boolean {
    return this.frameHandle !== null;
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.sync();
  }

  setToggleEnabled(enabled: boolean): void {
    if (this.toggleEnabled === enabled) return;
    this.toggleEnabled = enabled;
    this.sync();
  }

  /** Matches the project's fixed timestep (falls back to 1/60 if omitted). */
  setFixedDt(dt: number): void {
    if (dt > 0) this.fixedDt = dt;
  }

  /** Called every render with the entities that should currently be previewing (0 or 1 in this app's single-selection UI). */
  setTargets(targets: readonly PreviewTarget[]): void {
    this.targets = targets.slice();
    this.reconcile();
    this.sync();
  }

  /** Live snapshot for rendering; empty when the entity isn't an active preview target. */
  getPreviewParticles(entityId: string): readonly Particle[] {
    return this.tracked.get(entityId)?.state.particles ?? EMPTY_PARTICLES;
  }

  /** React (useSyncExternalStore-style) subscription: fires once per stepped frame. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.visible = false;
    this.toggleEnabled = false;
    this.targets = [];
    this.tracked.clear();
    this.stopTicker();
    this.listeners.clear();
  }

  // -- internals --------------------------------------------------------

  /** Create/replace/drop tracked EmitterStates to match `this.targets`, without touching untouched emitters' state. */
  private reconcile(): void {
    if (this.targets.length > 0 && !this.ctor && !this.ctorLoading) this.beginLoadCtor();
    const seen = new Set<string>();
    for (const target of this.targets) {
      seen.add(target.entityId);
      const signature = emitterSignature(target.emitter, target.origin);
      const existing = this.tracked.get(target.entityId);
      if (existing && existing.signature === signature) {
        // Unchanged (by value) — keep simulating, just refresh the object
        // refs so stepping always uses the latest scene-tree instances.
        existing.emitter = target.emitter;
        existing.origin = target.origin;
        continue;
      }
      if (!this.ctor) continue; // still loading; picked up once beginLoadCtor resolves
      this.tracked.set(target.entityId, {
        state: new this.ctor(target.emitter.seed),
        emitter: target.emitter,
        origin: target.origin,
        signature,
      });
    }
    for (const id of [...this.tracked.keys()]) {
      if (!seen.has(id)) this.tracked.delete(id);
    }
  }

  private beginLoadCtor(): void {
    this.ctorLoading = true;
    this.loadRuntime().then(
      (mod) => {
        this.ctorLoading = false;
        if (this.disposed) return;
        this.ctor = mod.EmitterState;
        this.reconcile();
        this.sync();
        this.notify();
      },
      () => {
        this.ctorLoading = false;
      },
    );
  }

  private sync(): void {
    if (this.isActive() && this.tracked.size > 0) this.startTicker();
    else this.stopTicker();
  }

  private startTicker(): void {
    if (this.frameHandle !== null) return;
    this.lastFrameTime = null;
    this.frameHandle = this.clock.requestFrame(this.tick);
  }

  private stopTicker(): void {
    if (this.frameHandle === null) return;
    this.clock.cancelFrame(this.frameHandle);
    this.frameHandle = null;
    this.lastFrameTime = null;
    this.accumulator = 0;
  }

  private tick = (t: number): void => {
    if (this.disposed) {
      this.frameHandle = null;
      return;
    }
    if (!this.isActive() || this.tracked.size === 0) {
      this.frameHandle = null;
      return;
    }
    if (this.lastFrameTime === null) {
      // First frame after (re)starting: just establishes the time origin,
      // matching rAF's own "no delta on the first callback" behavior.
      this.lastFrameTime = t;
    } else {
      const dt = Math.max(0, (t - this.lastFrameTime) / 1000);
      this.lastFrameTime = t;
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= this.fixedDt && steps < MAX_STEPS_PER_FRAME) {
        this.stepAll();
        this.accumulator -= this.fixedDt;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
      if (steps > 0) this.notify();
    }
    this.frameHandle = this.clock.requestFrame(this.tick);
  };

  private stepAll(): void {
    for (const tracked of this.tracked.values()) {
      if (!tracked.state.autoBurstFired) {
        tracked.state.autoBurstFired = true;
        tracked.state.burst(tracked.emitter.burst, tracked.emitter, tracked.origin);
      }
      tracked.state.step(this.fixedDt, tracked.emitter, tracked.origin);
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers (pure) — mirror packages/runtime/src/pixi/color.ts's
// lerp/lerpColor exactly (same start/end size + color + fade-to-75%-alpha
// formula) so the editor preview matches the real Pixi output. Duplicated
// rather than imported: that file lives under the `@hearth/runtime/pixi`
// subpath, which is off-limits for the editor bundle (see the module doc
// comment above) even though the helpers themselves don't touch Pixi.
// ---------------------------------------------------------------------------

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

function parseHex(color: string): { r: number; g: number; b: number } {
  const hex = color.trim().replace(/^#/, '');
  if (hex.length === 3) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    };
  }
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function toHex2(n: number): string {
  return Math.round(n).toString(16).padStart(2, '0');
}

function lerpColor(from: string, to: string, t: number): string {
  const c = clamp01(t);
  const a = parseHex(from);
  const b = parseHex(to);
  return `#${toHex2(lerp(a.r, b.r, c))}${toHex2(lerp(a.g, b.g, c))}${toHex2(lerp(a.b, b.b, c))}`;
}

export interface ParticleVisual {
  x: number;
  y: number;
  radius: number;
  color: string;
  alpha: number;
}

/** One particle's on-screen appearance, or null once it's shrunk to nothing (size <= 0), matching updateParticles' skip. */
export function particleVisual(p: Particle, emitter: ParticleEmitterComponent): ParticleVisual | null {
  const t = p.lifetime > 0 ? p.age / p.lifetime : 1;
  const size = lerp(emitter.startSize, emitter.endSize, t);
  if (size <= 0) return null;
  return {
    x: p.x,
    y: p.y,
    radius: size / 2,
    color: lerpColor(emitter.startColor, emitter.endColor, t),
    alpha: 1 - clamp01(t) * 0.25,
  };
}
