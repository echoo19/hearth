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
  /** Persistent per-entity state, survives across frames. */
  vars: Record<string, unknown>;
  time: { elapsed: number; delta: number; frame: number };
  log(...args: unknown[]): void;
  /** This entity's current collisions (refreshed each frame). */
  collisions: ScriptCollision[];
  /** Any non-trigger contact pushing this entity up (normal.y < -0.5). */
  isGrounded(): boolean;
  destroySelf(): void;
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
