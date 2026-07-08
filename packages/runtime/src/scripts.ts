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
  /** Fires for every ctx.events.emit in the scene: onEvent(ctx, name, data). */
  onEvent?(ctx: ScriptContext, name: string, data: unknown): void;
}

/** Pointer event delivered to onUiEvent (screen coordinates). */
export interface UiEvent {
  type: 'click' | 'press' | 'release' | 'enter' | 'exit' | 'drag' | 'change' | 'focus' | 'blur';
  x: number;
  y: number;
  /** Present for 'change' (UISlider/UIToggle's new value); unused otherwise. */
  value?: number | boolean;
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
    /** Analog value in [-1, 1] for a virtual axis from inputMappings.axes. */
    axis(name: string): number;
  };
  scene: {
    find(idOrName: string): EntityHandle | null;
    findByTag(tag: string): EntityHandle[];
    spawn(def: SpawnDef): EntityHandle;
    /**
     * Spawn a prefab asset (by name or id) as a fresh entity subtree: every
     * entity gets a new id, parent/child links are preserved among the
     * spawned set, `opts.position` overrides the root's Transform position and
     * `opts.name` its name. Returns the root handle, or null (with a warn log)
     * when no prefab by that name exists. Destroying the returned root does
     * NOT cascade to its children — destroy is per-entity.
     */
    spawnPrefab(name: string, opts?: { position?: Vec2; name?: string }): EntityHandle | null;
    destroy(idOrHandle: string | EntityHandle): void;
    /**
     * Grid A* path from `from` to `to` over solid tilemaps and static,
     * non-trigger colliders currently in the scene. Waypoints are cell
     * centers; null when unreachable or the scene's nav grid is too large.
     */
    findPath(from: Vec2, to: Vec2, opts?: { diagonals?: boolean }): Vec2[] | null;
  };
  audio: {
    /**
     * Play an audio asset (by asset id or name). Returns a handle id for
     * ctx.audio.stop, or null when the asset does not exist.
     */
    play(assetRef: string, opts?: { volume?: number; loop?: boolean }): string | null;
    /** Stop a playback by handle id, or every playback of an asset id/name. */
    stop(handleIdOrAssetRef: string): void;
    /**
     * Play a track on the single music channel (by asset id or name).
     * Replaces any current track (its stop is recorded first). Survives
     * scene switches. Null when the asset does not exist.
     */
    playMusic(assetRef: string, opts?: { volume?: number; loop?: boolean; fadeIn?: number }): string | null;
    /** Stop the current music track. No-op when nothing is playing. */
    stopMusic(opts?: { fadeOut?: number }): void;
    /** Change the current music track's volume. No-op when nothing is playing. */
    setMusicVolume(volume: number, opts?: { fade?: number }): void;
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
    /** Screen shake: offset decays linearly from `intensity` (world units) to 0 over `seconds`. */
    shake(intensity: number, seconds: number, opts?: { seed?: number }): void;
    /** A color pulse that fades from full alpha to 0 over `seconds`. */
    flash(color: string, seconds: number): void;
    /**
     * Ease the persistent screen overlay toward `alpha` over `seconds`, then
     * hold (survives scene switches). Last call wins: a new fade replaces an
     * in-flight one and the superseded fade's onComplete is dropped, never
     * fired — only the winning fade's onComplete runs, once.
     */
    fade(alpha: number, seconds: number, opts?: { color?: string; onComplete?: () => void }): void;
    /** A zoom kick that eases back to 1x over `seconds`. */
    zoomPunch(scale: number, seconds: number): void;
  };
  /** Global pub/sub. emit delivers synchronously; on() subscriptions die with this entity. */
  events: {
    emit(name: string, data?: unknown): void;
    on(name: string, fn: (data: unknown) => void): string;
    off(id: string): void;
  };
  /** Keyboard/gamepad focus navigation among focusable UIElement entities. */
  ui: {
    /**
     * Set focus to an entity by id/name, or clear it with null. Fires
     * onUiEvent {type:'blur'} on the previous focus and {type:'focus'} on
     * the new one. Warns (no-op) when the target is unknown, disabled, or
     * its UIElement.focusable is not true.
     */
    focus(idOrName: string | null): void;
    /** The focused entity's id, or null. */
    getFocused(): string | null;
    /**
     * Move focus to the nearest focusable UIElement entity strictly in
     * `direction` from the current focus (or the top-left-most candidate
     * when nothing is focused). No wrap: no-op if nothing lies that way.
     */
    moveFocus(direction: 'up' | 'down' | 'left' | 'right'): void;
    /**
     * Synthesizes a press+release (a click) at the focused element's
     * center. Warns (no-op) when the focused entity is not interactive.
     */
    activate(): void;
    /**
     * For a focused UISlider: value += delta * (step || (max-min)/10),
     * clamped, firing onUiEvent {type:'change', value}. No-op otherwise.
     */
    adjust(delta: number): void;
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
