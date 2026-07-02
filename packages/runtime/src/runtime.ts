/**
 * SceneRuntime — headless fixed-timestep simulation of one Hearth scene.
 *
 * Instantiates a deep copy of the authored scene from a ProjectStore (the
 * store is never mutated), then advances it one fixed frame at a time:
 * script onStart → script onUpdate → physics integrate + resolve →
 * collision events → input frame end.
 *
 * This module is headless-safe: no DOM, no pixi. Rendering lives in the
 * `@hearth/runtime/pixi` subpath.
 *
 * v1 simplifications (documented, on purpose):
 *   - Children inherit only their parent's translation; parent rotation and
 *     scale are not applied to child world transforms.
 *   - Colliders ignore Transform.scale/rotation; circles collide as their
 *     bounding box.
 */
import {
  createComponent,
  generateId,
  isComponentType,
  type ComponentMap,
  type Entity,
  type ProjectStore,
  type Scene,
  type TransformComponent,
  type Vec2,
} from '@hearth/core';
import { InputState } from './input.js';
import {
  GRAVITY,
  cancelVelocityAlong,
  colliderBox,
  computePush,
  tilemapBoxes,
  type Box,
} from './physics.js';
import {
  compileScript,
  formatLogArgs,
  type EntityHandle,
  type ScriptContext,
  type ScriptHooks,
  type SpawnDef,
} from './scripts.js';

export interface RuntimeLog {
  frame: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface RuntimeError {
  frame: number;
  message: string;
  entity?: string;
  script?: string;
  phase?: string;
}

export interface RuntimeOptions {
  onLog?(e: RuntimeLog): void;
  onError?(e: RuntimeError): void;
  /** Cap on retained logs (oldest dropped first). Default 1000. */
  maxLogs?: number;
}

/** A collision contact as seen from one entity. */
export interface RuntimeCollision {
  other: RuntimeEntity;
  /** Direction this entity was (or would be) pushed; unit axis vector. */
  normal: Vec2;
  trigger: boolean;
}

/** A live entity in a running scene. Component data is mutable. */
export interface RuntimeEntity {
  id: string;
  name: string;
  tags: string[];
  enabled: boolean;
  parentId: string | null;
  /** Live Transform (alias of components.Transform). */
  transform: TransformComponent;
  /** Live deep copy of the authored component data. */
  components: ComponentMap;
  /** Current contacts, refreshed each frame by the physics pass. */
  collisions: RuntimeCollision[];
}

interface ScriptState {
  path: string;
  hooks: ScriptHooks | null;
  ctx: ScriptContext;
  vars: Record<string, unknown>;
  started: boolean;
  disabled: boolean;
  consecutiveErrors: number;
}

interface Contact {
  a: RuntimeEntity;
  b: RuntimeEntity;
  /** Normal for `a` (b gets the negation). */
  nx: number;
  ny: number;
  trigger: boolean;
}

const MAX_CONSECUTIVE_SCRIPT_ERRORS = 3;

export class SceneRuntime {
  readonly fixedDt: number;
  readonly errors: RuntimeError[] = [];
  readonly logs: RuntimeLog[] = [];
  readonly input: InputState;

  private _frame = 0;
  private _elapsed = 0;
  private entities: RuntimeEntity[] = [];
  private destroyedIds = new Set<string>();
  private scriptModules = new Map<string, ScriptHooks | null>();
  private scriptStates = new Map<string, ScriptState>();
  private handles = new Map<string, EntityHandle>();
  private prevContactPairs = new Set<string>();
  private maxLogs: number;
  private stopped = false;

  private constructor(
    private readonly store: ProjectStore,
    scene: Scene,
    private readonly options: RuntimeOptions,
  ) {
    this.fixedDt = 1 / store.project.buildSettings.fixedTimestep;
    this.maxLogs = options.maxLogs ?? 1000;
    this.input = new InputState(store.project.inputMappings.actions);
    for (const authored of scene.entities) {
      if (!authored.enabled) continue;
      this.entities.push(this.instantiate(authored));
    }
  }

  static async create(
    store: ProjectStore,
    sceneIdOrName: string,
    options: RuntimeOptions = {},
  ): Promise<SceneRuntime> {
    const scene = store.getScene(sceneIdOrName);
    if (!scene) {
      throw new Error(`Scene not found: ${sceneIdOrName}`);
    }
    const runtime = new SceneRuntime(store, scene, options);
    await runtime.loadScripts();
    return runtime;
  }

  get frame(): number {
    return this._frame;
  }

  get elapsed(): number {
    return this._elapsed;
  }

  /** Live, spawned and not destroyed entities, in stable order. */
  getEntities(): RuntimeEntity[] {
    return this.entities.filter((e) => !this.destroyedIds.has(e.id));
  }

  /** Find a live entity by id, then by exact name. */
  find(idOrName: string): RuntimeEntity | undefined {
    const live = this.getEntities();
    return live.find((e) => e.id === idOrName) ?? live.find((e) => e.name === idOrName);
  }

  findByTag(tag: string): RuntimeEntity[] {
    return this.getEntities().filter((e) => e.tags.includes(tag));
  }

  /** Active camera view: main Camera entity, or build-settings defaults. */
  get camera(): { position: Vec2; zoom: number; backgroundColor: string } {
    const settings = this.store.project.buildSettings;
    const cameras = this.getEntities().filter((e) => e.enabled && e.components.Camera);
    const cam = cameras.find((e) => e.components.Camera!.isMain) ?? cameras[0];
    if (!cam) {
      return {
        position: { x: settings.width / 2, y: settings.height / 2 },
        zoom: 1,
        backgroundColor: settings.backgroundColor,
      };
    }
    return {
      position: this.getWorldPosition(cam),
      zoom: cam.components.Camera!.zoom,
      backgroundColor: cam.components.Camera!.backgroundColor,
    };
  }

  /**
   * World position of an entity: its local position plus all ancestor
   * translations (rotation/scale inheritance is not applied in v1).
   */
  getWorldPosition(entity: RuntimeEntity): Vec2 {
    let x = entity.transform.position.x;
    let y = entity.transform.position.y;
    const seen = new Set<string>([entity.id]);
    let parentId = entity.parentId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = this.entities.find((e) => e.id === parentId);
      if (!parent) break;
      x += parent.transform.position.x;
      y += parent.transform.position.y;
      parentId = parent.parentId;
    }
    return { x, y };
  }

  /** Advance exactly one fixed frame. */
  step(): void {
    if (this.stopped) return;

    // 1. onStart for entities that have not started yet (entity order).
    for (const entity of this.getEntities()) {
      const state = this.scriptStates.get(entity.id);
      if (state && !state.started) {
        state.started = true;
        if (entity.enabled) this.callHook(entity, 'onStart');
      }
    }

    // 2. Script updates.
    for (const entity of this.getEntities()) {
      if (!entity.enabled) continue;
      this.callHook(entity, 'onUpdate', this.fixedDt);
    }

    // 3. Physics integration + collision detection/resolution.
    const contacts = this.stepPhysics();

    // 4. Collision events for new contact pairs.
    this.dispatchCollisionEvents(contacts);

    // 5. End of frame bookkeeping.
    this.flushDestroyed();
    this.input.endFrame();
    this._frame++;
    this._elapsed += this.fixedDt;
  }

  run(frames: number): void {
    for (let i = 0; i < frames; i++) this.step();
  }

  destroy(): void {
    this.stopped = true;
    this.entities = [];
    this.scriptStates.clear();
    this.handles.clear();
    this.destroyedIds.clear();
  }

  // ---------------------------------------------------------------------------
  // Instantiation & scripts
  // ---------------------------------------------------------------------------

  private instantiate(authored: Entity): RuntimeEntity {
    const components = structuredClone(authored.components) as ComponentMap;
    if (!components.Transform) components.Transform = createComponent('Transform');
    const entity: RuntimeEntity = {
      id: authored.id,
      name: authored.name,
      tags: [...authored.tags],
      enabled: true,
      parentId: authored.parentId,
      components,
      collisions: [],
      get transform() {
        return this.components.Transform!;
      },
    };
    return entity;
  }

  private async loadScripts(): Promise<void> {
    const paths = new Set<string>(await this.store.listScripts());
    for (const entity of this.entities) {
      const path = entity.components.Script?.scriptPath;
      if (path) paths.add(path);
    }
    for (const path of paths) {
      try {
        const source = await this.store.readScript(path);
        this.scriptModules.set(path, compileScript(source));
      } catch (err) {
        this.scriptModules.set(path, null);
        this.recordError({
          frame: this._frame,
          message: `Failed to load script ${path}: ${(err as Error).message}`,
          script: path,
          phase: 'load',
        });
      }
    }
    for (const entity of this.entities) {
      this.registerScript(entity);
    }
  }

  private registerScript(entity: RuntimeEntity): void {
    const script = entity.components.Script;
    if (!script || !script.scriptPath) return;
    let hooks = this.scriptModules.get(script.scriptPath);
    if (hooks === undefined) {
      hooks = null;
      this.recordError({
        frame: this._frame,
        message: `Script not loaded: ${script.scriptPath}`,
        entity: entity.name,
        script: script.scriptPath,
        phase: 'load',
      });
    }
    const vars: Record<string, unknown> = {};
    this.scriptStates.set(entity.id, {
      path: script.scriptPath,
      hooks,
      vars,
      ctx: this.makeContext(entity, script.params, vars),
      started: false,
      disabled: hooks === null,
      consecutiveErrors: 0,
    });
  }

  private makeContext(
    entity: RuntimeEntity,
    params: Record<string, unknown>,
    vars: Record<string, unknown>,
  ): ScriptContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const runtime = this;
    return {
      entity: { id: entity.id, name: entity.name, tags: entity.tags },
      get transform() {
        return entity.transform;
      },
      getComponent: (type) => entity.components[type],
      params,
      input: {
        isDown: (action) => runtime.input.isDown(action),
        justPressed: (action) => runtime.input.justPressed(action),
      },
      scene: {
        find: (idOrName) => {
          const found = runtime.find(idOrName);
          return found ? runtime.handleFor(found) : null;
        },
        findByTag: (tag) => runtime.findByTag(tag).map((e) => runtime.handleFor(e)),
        spawn: (def) => runtime.spawn(def),
        destroy: (idOrHandle) =>
          runtime.destroyEntity(typeof idOrHandle === 'string' ? idOrHandle : idOrHandle.id),
      },
      vars,
      time: {
        get elapsed() {
          return runtime._elapsed;
        },
        get delta() {
          return runtime.fixedDt;
        },
        get frame() {
          return runtime._frame;
        },
      },
      log: (...args) => this.recordLog('info', formatLogArgs(args)),
      get collisions() {
        return entity.collisions.map((c) => ({
          other: runtime.handleFor(c.other),
          normal: c.normal,
          trigger: c.trigger,
        }));
      },
      isGrounded: () => entity.collisions.some((c) => !c.trigger && c.normal.y < -0.5),
      destroySelf: () => this.destroyEntity(entity.id),
    };
  }

  private handleFor(entity: RuntimeEntity): EntityHandle {
    let handle = this.handles.get(entity.id);
    if (!handle) {
      const runtime = this;
      handle = {
        id: entity.id,
        name: entity.name,
        tags: entity.tags,
        get transform() {
          return entity.transform;
        },
        getComponent: (type) => entity.components[type],
        destroy: () => runtime.destroyEntity(entity.id),
      };
      this.handles.set(entity.id, handle);
    }
    return handle;
  }

  /** Spawn a runtime entity (used by ctx.scene.spawn). */
  private spawn(def: SpawnDef): EntityHandle {
    const components: ComponentMap = {};
    for (const [type, overrides] of Object.entries(def.components ?? {})) {
      if (!isComponentType(type)) {
        this.recordLog('warn', `spawn "${def.name}": unknown component type ${type} (skipped)`);
        continue;
      }
      (components as Record<string, unknown>)[type] = createComponent(type, overrides);
    }
    if (!components.Transform) {
      components.Transform = createComponent(
        'Transform',
        def.position ? { position: def.position } : {},
      );
    } else if (def.position) {
      components.Transform.position = { x: def.position.x, y: def.position.y };
    }
    const entity: RuntimeEntity = {
      id: generateId('ent'),
      name: def.name,
      tags: [...(def.tags ?? [])],
      enabled: true,
      parentId: null,
      components,
      collisions: [],
      get transform() {
        return this.components.Transform!;
      },
    };
    this.entities.push(entity);
    this.registerScript(entity);
    return this.handleFor(entity);
  }

  private destroyEntity(id: string): void {
    if (this.entities.some((e) => e.id === id)) {
      this.destroyedIds.add(id);
    }
  }

  private flushDestroyed(): void {
    if (this.destroyedIds.size === 0) return;
    this.entities = this.entities.filter((e) => !this.destroyedIds.has(e.id));
    for (const id of this.destroyedIds) {
      this.scriptStates.delete(id);
      this.handles.delete(id);
    }
    this.destroyedIds.clear();
  }

  private callHook(
    entity: RuntimeEntity,
    hook: 'onStart' | 'onUpdate' | 'onCollision',
    arg?: unknown,
  ): void {
    const state = this.scriptStates.get(entity.id);
    if (!state || state.disabled || !state.hooks) return;
    const fn = state.hooks[hook];
    if (typeof fn !== 'function') return;
    try {
      (fn as (ctx: ScriptContext, arg?: unknown) => void).call(state.hooks, state.ctx, arg);
      state.consecutiveErrors = 0;
    } catch (err) {
      state.consecutiveErrors++;
      this.recordError({
        frame: this._frame,
        message: (err as Error)?.message ?? String(err),
        entity: entity.name,
        script: state.path,
        phase: hook,
      });
      if (state.consecutiveErrors >= MAX_CONSECUTIVE_SCRIPT_ERRORS) {
        state.disabled = true;
        this.recordLog(
          'warn',
          `script ${state.path} on "${entity.name}" disabled after ${MAX_CONSECUTIVE_SCRIPT_ERRORS} consecutive errors`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Physics
  // ---------------------------------------------------------------------------

  private stepPhysics(): Contact[] {
    const live = this.getEntities();
    for (const entity of live) entity.collisions.length = 0;

    // Integrate velocities.
    for (const entity of live) {
      if (!entity.enabled) continue;
      const body = entity.components.PhysicsBody;
      if (!body) continue;
      if (body.bodyType === 'dynamic') {
        body.velocity.y += GRAVITY * body.gravityScale * this.fixedDt;
        if (body.drag > 0) {
          body.velocity.x *= Math.max(0, 1 - body.drag * this.fixedDt);
        }
      }
      if (body.bodyType === 'dynamic' || body.bodyType === 'kinematic') {
        entity.transform.position.x += body.velocity.x * this.fixedDt;
        entity.transform.position.y += body.velocity.y * this.fixedDt;
      }
    }

    // Collect movers (dynamic/kinematic with colliders) and static obstacles.
    interface Mover {
      entity: RuntimeEntity;
      box: Box;
      isTrigger: boolean;
      dynamic: boolean;
    }
    interface Obstacle {
      entity: RuntimeEntity;
      box: Box;
      isTrigger: boolean;
    }
    const movers: Mover[] = [];
    const obstacles: Obstacle[] = [];
    for (const entity of live) {
      if (!entity.enabled) continue;
      const bodyType = entity.components.PhysicsBody?.bodyType ?? 'static';
      const collider = entity.components.Collider;
      if (collider) {
        const box = colliderBox(collider, this.getWorldPosition(entity));
        if (bodyType === 'static') {
          obstacles.push({ entity, box, isTrigger: collider.isTrigger });
        } else {
          movers.push({ entity, box, isTrigger: collider.isTrigger, dynamic: bodyType === 'dynamic' });
        }
      }
      const tilemap = entity.components.Tilemap;
      if (tilemap && tilemap.solid) {
        for (const box of tilemapBoxes(tilemap, this.getWorldPosition(entity))) {
          obstacles.push({ entity, box, isTrigger: false });
        }
      }
    }

    const contacts: Contact[] = [];
    const addContact = (
      a: RuntimeEntity,
      b: RuntimeEntity,
      nx: number,
      ny: number,
      trigger: boolean,
    ) => {
      contacts.push({ a, b, nx, ny, trigger });
      a.collisions.push({ other: b, normal: { x: nx, y: ny }, trigger });
      b.collisions.push({ other: a, normal: { x: -nx, y: -ny }, trigger });
    };

    const applyPush = (mover: Mover, nx: number, ny: number, amount: number) => {
      mover.entity.transform.position.x += nx * amount;
      mover.entity.transform.position.y += ny * amount;
      mover.box.cx += nx * amount;
      mover.box.cy += ny * amount;
      const body = mover.entity.components.PhysicsBody;
      if (body) cancelVelocityAlong(body.velocity, nx, ny);
    };

    // Movers vs static obstacles (dynamic movers get pushed out).
    for (const mover of movers) {
      for (const obstacle of obstacles) {
        const push = computePush(mover.box, obstacle.box);
        if (!push) continue;
        const trigger = mover.isTrigger || obstacle.isTrigger;
        if (!trigger && mover.dynamic) {
          applyPush(mover, push.nx, push.ny, push.amount);
        }
        addContact(mover.entity, obstacle.entity, push.nx, push.ny, trigger);
      }
    }

    // Mover vs mover.
    for (let i = 0; i < movers.length; i++) {
      for (let j = i + 1; j < movers.length; j++) {
        const a = movers[i];
        const b = movers[j];
        const push = computePush(a.box, b.box);
        if (!push) continue;
        const trigger = a.isTrigger || b.isTrigger;
        if (!trigger) {
          if (a.dynamic && b.dynamic) {
            applyPush(a, push.nx, push.ny, push.amount / 2);
            applyPush(b, -push.nx, -push.ny, push.amount / 2);
          } else if (a.dynamic) {
            applyPush(a, push.nx, push.ny, push.amount);
          } else if (b.dynamic) {
            applyPush(b, -push.nx, -push.ny, push.amount);
          }
        }
        addContact(a.entity, b.entity, push.nx, push.ny, trigger);
      }
    }

    return contacts;
  }

  private dispatchCollisionEvents(contacts: Contact[]): void {
    const currentPairs = new Set<string>();
    const newContacts: Contact[] = [];
    for (const contact of contacts) {
      const key =
        contact.a.id < contact.b.id
          ? `${contact.a.id}|${contact.b.id}`
          : `${contact.b.id}|${contact.a.id}`;
      if (currentPairs.has(key)) continue; // e.g. multiple tilemap cells
      currentPairs.add(key);
      if (!this.prevContactPairs.has(key)) newContacts.push(contact);
    }
    this.prevContactPairs = currentPairs;
    for (const contact of newContacts) {
      if (!this.destroyedIds.has(contact.a.id) && !this.destroyedIds.has(contact.b.id)) {
        this.callHook(contact.a, 'onCollision', this.handleFor(contact.b));
      }
      if (!this.destroyedIds.has(contact.a.id) && !this.destroyedIds.has(contact.b.id)) {
        this.callHook(contact.b, 'onCollision', this.handleFor(contact.a));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Logging
  // ---------------------------------------------------------------------------

  private recordLog(level: RuntimeLog['level'], message: string): void {
    const entry: RuntimeLog = { frame: this._frame, level, message };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) this.logs.shift();
    this.options.onLog?.(entry);
  }

  private recordError(entry: RuntimeError): void {
    this.errors.push(entry);
    this.options.onError?.(entry);
  }
}
