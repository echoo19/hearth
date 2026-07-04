/**
 * Script engine — loading and typing for Hearth behavior scripts.
 *
 * Scripts are plain JavaScript files of the shape
 * `export default { onStart(ctx), onUpdate(ctx, dt), onCollision(ctx, other) }`.
 * They are compiled with `new Function('module', 'exports', source)` after
 * rewriting `export default` to `module.exports =`, so they run identically
 * in Node and the browser without dynamic import.
 *
 * v1 limitation: scripts cannot use `import` (there is no module graph);
 * everything a script needs comes through its `ctx`.
 */
import type { ComponentMap, ComponentType, TransformComponent, Vec2 } from '@hearth/core';

/** Lifecycle hooks a script may export. */
export interface ScriptHooks {
  onStart?(ctx: ScriptContext): void;
  onUpdate?(ctx: ScriptContext, dt: number): void;
  onCollision?(ctx: ScriptContext, other: EntityHandle): void;
  /** Pointer events on this entity's interactive UIElement. */
  onUiEvent?(ctx: ScriptContext, event: UiEvent): void;
}

/** Pointer event delivered to onUiEvent (screen coordinates). */
export interface UiEvent {
  type: 'click' | 'press' | 'release' | 'enter' | 'exit';
  x: number;
  y: number;
}

/** Lightweight wrapper handed to scripts instead of raw runtime entities. */
export interface EntityHandle {
  readonly id: string;
  readonly name: string;
  readonly tags: string[];
  readonly transform: TransformComponent;
  getComponent<T extends ComponentType>(type: T): ComponentMap[T];
  destroy(): void;
}

/** Definition accepted by `ctx.scene.spawn()`. */
export interface SpawnDef {
  name: string;
  position?: Vec2;
  tags?: string[];
  /** Component type → overrides, passed through core's createComponent. */
  components?: Record<string, Record<string, unknown>>;
}

export interface ScriptCollision {
  other: EntityHandle;
  normal: Vec2;
  trigger: boolean;
}

/** The `ctx` object passed to every script hook (see core's SCRIPT_TEMPLATE). */
export interface ScriptContext {
  entity: { id: string; name: string; tags: string[] };
  /** Live Transform of this entity (mutable). */
  transform: TransformComponent;
  getComponent<T extends ComponentType>(type: T): ComponentMap[T];
  /** Parameters from the Script component. */
  params: Record<string, unknown>;
  input: {
    isDown(action: string): boolean;
    justPressed(action: string): boolean;
  };
  scene: {
    find(idOrName: string): EntityHandle | null;
    findByTag(tag: string): EntityHandle[];
    spawn(def: SpawnDef): EntityHandle;
    destroy(idOrHandle: string | EntityHandle): void;
  };
  audio: {
    /**
     * Play an audio asset (by asset id or name). Returns a handle id for
     * ctx.audio.stop, or null when the asset does not exist.
     */
    play(assetRef: string, opts?: { volume?: number; loop?: boolean }): string | null;
    /** Stop a playback by handle id, or every playback of an asset id/name. */
    stop(handleIdOrAssetRef: string): void;
  };
  /** Persistent per-entity state, survives across frames. */
  vars: Record<string, unknown>;
  time: { elapsed: number; delta: number; frame: number };
  log(...args: unknown[]): void;
  /** This entity's current collisions (refreshed each frame). */
  collisions: ScriptCollision[];
  /** Any non-trigger contact pushing this entity up (normal.y < -0.5). */
  isGrounded(): boolean;
  destroySelf(): void;
  scenes: {
    /** Current scene {id, name}. */
    current: { id: string; name: string };
    list(): { id: string; name: string }[];
    /** Request a scene switch at end of frame. False if unknown. */
    load(idOrName: string): boolean;
  };
  timers: {
    /** Run fn once after `seconds`. Returns a cancel id. */
    after(seconds: number, fn: () => void): string;
    /** Run fn every `seconds`. Returns a cancel id. */
    every(seconds: number, fn: () => void): string;
    cancel(id: string): void;
  };
  tweens: {
    /**
     * Tween a numeric component property on this entity, e.g.
     * to('Transform.position.x', 400, 0.5, { easing: 'easeOut' }).
     * Returns a cancel id. Unknown/non-numeric path → warn log + '' id.
     */
    to(
      path: string,
      target: number,
      seconds: number,
      opts?: {
        easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
        onComplete?: () => void;
      },
    ): string;
    cancel(id: string): void;
  };
  random: {
    /** Seeded, deterministic [0, 1). Same seed → same sequence. */
    next(): number;
    range(min: number, max: number): number; // float
    int(min: number, max: number): number; // inclusive
  };
  particles: {
    /** Spawn `count` particles immediately from this entity's ParticleEmitter. Warn if none. */
    burst(count: number): void;
    /** Live particle count for this entity's ParticleEmitter (0 if none). */
    count(): number;
  };
  /** Pure math helpers: vec2 ops, lerp/clamp, color conversion. See ctx API docs. */
  math: import('./ctxMath.js').CtxMath;
  /**
   * Switch this entity's SpriteAnimator to `assetRef` (animation asset id
   * or name), set playing = true, and reset to frame 0. Warn + no-op when
   * the entity has no SpriteAnimator or the asset is unknown.
   */
  animate(assetRef: string): void;
  /** Persistent save data (JSON values), survives scene switches; in the
   *  browser it persists across sessions via localStorage. */
  save(key: string, value: unknown): void;
  load(key: string): unknown; // null when absent
  clearSave(key?: string): void; // no key = clear all
  camera: {
    getPosition(): Vec2;
    setPosition(x: number, y: number): void;
    getZoom(): number;
    setZoom(zoom: number): void;
    /** Follow an entity each frame (null stops). Warn log if not found. */
    follow(idOrName: string | null): void;
  };
}

/**
 * Compile script source into its exported hooks object.
 * Throws when the source fails to evaluate or exports the wrong shape.
 */
export function compileScript(source: string): ScriptHooks {
  const body = source.replace(/export\s+default/, 'module.exports =');
  const factory = new Function('module', 'exports', body);
  const module = { exports: {} as unknown };
  factory(module, module.exports);
  const hooks = module.exports;
  if (hooks === null || typeof hooks !== 'object') {
    throw new Error('script must `export default` an object with lifecycle hooks');
  }
  return hooks as ScriptHooks;
}

/** Format ctx.log arguments the way console.log would, roughly. */
export function formatLogArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}
