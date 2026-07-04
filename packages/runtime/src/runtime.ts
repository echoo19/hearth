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
 *   - Box/circle colliders ignore Transform.scale/rotation; circles collide
 *     as their bounding box except against polygons (SAT uses the true
 *     circle). Polygon colliders honor scale and rotation.
 */
import {
  AnimationDataSchema,
  buildNavGrid,
  collectNavSolids,
  createComponent,
  findPath,
  generateId,
  isComponentType,
  joinPath,
  type AnimationData,
  type ComponentMap,
  type Entity,
  type NavEntityInput,
  type NavGrid,
  type ParticleEmitterComponent,
  type PhysicsBodyComponent,
  type ProjectStore,
  type Scene,
  type TransformComponent,
  type Vec2,
} from '@hearth/core';
import { createAnimatorState, stepAnimator, type AnimatorState } from './animator.js';
import { InputState } from './input.js';
import {
  GRAVITY,
  TILEMAP_FILTER,
  colliderShape,
  computeShapePush,
  layersInteract,
  resolveContactVelocity,
  tilemapBoxes,
  translateShape,
  type CollisionShape,
} from './physics.js';
import {
  compileScript,
  formatLogArgs,
  type EntityHandle,
  type ScriptContext,
  type ScriptHooks,
  type SpawnDef,
  type UiEvent,
} from './scripts.js';
import { createCtxMath } from './ctxMath.js';
import { EventBus, type GameEventRecord } from './events.js';
import { LuaScriptEngine, isLuaPath } from './lua.js';
import { EmitterState, type Particle } from './particles.js';
import { MemorySessionStorage, type SessionStorage } from './session.js';
import { EASINGS, EntityScheduler, createRng, resolveNumericTarget } from './stdlib.js';
import { uiElementRect } from './ui.js';

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

/** One recorded audio play/stop, as it appears in run reports. */
export interface AudioEvent {
  frame: number;
  assetId: string;
  action: 'play' | 'stop';
}

/** Live audio notification for rendering hosts (Web Audio playback). */
export interface AudioPlaybackEvent {
  action: 'play' | 'stop';
  handleId: string;
  assetId: string;
  volume: number;
  loop: boolean;
}

/** Pointer event kinds accepted by SceneRuntime.sendPointer. */
export type PointerKind = 'move' | 'down' | 'up';

export interface RuntimeOptions {
  onLog?(e: RuntimeLog): void;
  onError?(e: RuntimeError): void;
  /** Hosts with real audio output subscribe here (headless just records). */
  onAudio?(e: AudioPlaybackEvent): void;
  /** Cap on retained logs (oldest dropped first). Default 1000. */
  maxLogs?: number;
  /** Seed for ctx.random when no `rng` is provided (standalone use). Default 0. */
  seed?: number;
  /** Session-provided RNG stream (wins over seed). */
  rng?(): number;
  /** Persistence behind ctx.save/load. Default MemorySessionStorage. */
  storage?: SessionStorage;
  /** Session-shared Lua engine; created on demand if absent and a .lua script is present. */
  luaEngine?: LuaScriptEngine;
  /** Session frame base so log/error/audio frames stay monotonic across scenes. */
  frameOffset?: number;
  /**
   * Live notification for every ctx.events.emit — fires even after the
   * runtime's recorded-events list caps, so aggregators keep exact counts.
   */
  onGameEvent?(record: GameEventRecord): void;
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
  /** Timers/tweens created via this entity's ctx; dies with the entity. */
  scheduler: EntityScheduler;
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
/** ctx.events.emit re-entrancy guard: nested emits deeper than this are dropped. */
const MAX_EVENT_DEPTH = 8;
/** Cap on SceneRuntime.events (oldest kept, newest dropped once full). */
const MAX_RECORDED_EVENTS = 200;

export class SceneRuntime {
  readonly fixedDt: number;
  readonly errors: RuntimeError[] = [];
  readonly logs: RuntimeLog[] = [];
  /** Every audio play/stop, in order — surfaced by run reports and playtests. */
  readonly audioEvents: AudioEvent[] = [];
  /** Recorded ctx.events.emit calls, in emission order, capped at MAX_RECORDED_EVENTS. */
  readonly events: GameEventRecord[] = [];
  /** True once `events` has dropped emits past the cap (eventCounts stays exact). */
  eventsTruncated = false;
  /** Exact per-name emit totals, unbounded — never truncated even once `events` caps. */
  readonly eventCounts = new Map<string, number>();
  readonly input: InputState;

  /** Scene id requested by ctx.scenes.load this frame (hosts react after step). */
  pendingScene: string | null = null;

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
  private audioStarted = false;
  private audioHandleSeq = 0;
  private activePlaybacks = new Map<string, { assetId: string }>();
  private uiHoverId: string | null = null;
  private uiPressedId: string | null = null;
  private readonly sceneId: string;
  private readonly sceneName: string;
  private readonly rng: () => number;
  private readonly storage: SessionStorage;
  private ownedLuaEngine: LuaScriptEngine | null = null;
  private cameraFollowId: string | null = null;
  private warnedNoCamera = false;
  private emitters = new Map<string, EmitterState>();
  private animationAssets = new Map<string, AnimationData>();
  private animatorStates = new Map<string, AnimatorState>();
  private eventBus = new EventBus();
  private emitDepth = 0;
  private navGrid: NavGrid | null = null;
  private navGridFrame = -1;

  private constructor(
    private readonly store: ProjectStore,
    scene: Scene,
    private readonly options: RuntimeOptions,
  ) {
    this.fixedDt = 1 / store.project.buildSettings.fixedTimestep;
    this.maxLogs = options.maxLogs ?? 1000;
    this.input = new InputState(store.project.inputMappings.actions);
    this.sceneId = scene.id;
    this.sceneName = scene.name;
    this.rng = options.rng ?? createRng(options.seed ?? 0);
    this.storage = options.storage ?? new MemorySessionStorage();
    this._frame = options.frameOffset ?? 0;
    this._elapsed = this._frame * this.fixedDt;
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
    await runtime.loadAnimations();
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

  /** Live particles for an emitter entity (by id or name); [] when none. */
  getParticles(entityIdOrName: string): ReadonlyArray<Particle> {
    const entity = this.find(entityIdOrName);
    if (!entity) return [];
    return this.emitters.get(entity.id)?.particles ?? [];
  }

  /** Live particle count for an emitter entity (by id or name); 0 when none. */
  getParticleCount(entityIdOrName: string): number {
    return this.getParticles(entityIdOrName).length;
  }

  /** Active camera view: main Camera entity, or build-settings defaults. */
  get camera(): { position: Vec2; zoom: number; backgroundColor: string; ambientLight: number } {
    const settings = this.store.project.buildSettings;
    const cameras = this.getEntities().filter((e) => e.enabled && e.components.Camera);
    const cam = cameras.find((e) => e.components.Camera!.isMain) ?? cameras[0];
    if (!cam) {
      return {
        position: { x: settings.width / 2, y: settings.height / 2 },
        zoom: 1,
        backgroundColor: settings.backgroundColor,
        ambientLight: 1,
      };
    }
    return {
      position: this.getWorldPosition(cam),
      zoom: cam.components.Camera!.zoom,
      backgroundColor: cam.components.Camera!.backgroundColor,
      ambientLight: cam.components.Camera!.ambientLight,
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

  /** Whether every point falls within a nav grid's cell bounds. */
  private gridContains(grid: NavGrid, points: Vec2[]): boolean {
    return points.every((p) => {
      const col = Math.floor((p.x - grid.originX) / grid.cellSize);
      const row = Math.floor((p.y - grid.originY) / grid.cellSize);
      return col >= 0 && col < grid.cols && row >= 0 && row < grid.rows;
    });
  }

  /**
   * Nav grid over the live scene (solid tilemaps + static non-trigger
   * colliders). The cached grid is reused only when it was built this frame
   * AND its bounds cover every query point; otherwise it is rebuilt with the
   * current `include` points and re-cached (stamped with the current frame).
   * A build failure (grid over the 512x512 cap) warns and returns null for
   * that query only — a later same-frame query with different points gets a
   * fresh rebuild attempt.
   */
  private getNavGrid(include: Vec2[]): NavGrid | null {
    if (
      this.navGridFrame === this._frame &&
      this.navGrid &&
      this.gridContains(this.navGrid, include)
    ) {
      return this.navGrid;
    }
    this.navGridFrame = this._frame;
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
      this.recordLog('warn', `ctx.scene.findPath: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.navGrid;
  }

  /** Advance exactly one fixed frame. */
  step(): void {
    if (this.stopped) return;

    // 0. AudioSource autoplay on scene start (before any script runs).
    if (!this.audioStarted) {
      this.audioStarted = true;
      for (const entity of this.getEntities()) {
        const source = entity.components.AudioSource;
        if (entity.enabled && source?.autoplay && source.assetId) {
          this.playAudio(source.assetId, { volume: source.volume, loop: source.loop });
        }
      }
    }

    // 1. onStart for entities that have not started yet (entity order).
    for (const entity of this.getEntities()) {
      const state = this.scriptStates.get(entity.id);
      if (state && !state.started) {
        state.started = true;
        if (entity.enabled) this.callHook(entity, 'onStart');
      }
    }

    // 2. Timers fire and tweens advance right before each entity's onUpdate.
    for (const entity of this.getEntities()) {
      if (!entity.enabled) continue;
      const state = this.scriptStates.get(entity.id);
      if (state) {
        state.scheduler.step(this.fixedDt, (phase, err) =>
          this.recordError({
            frame: this._frame,
            message: (err as Error)?.message ?? String(err),
            entity: entity.name,
            script: state.path,
            phase,
          }),
        );
      }
      this.callHook(entity, 'onUpdate', this.fixedDt);
    }

    // 2c. SpriteAnimator playback, right after scripts so same-frame
    // playing/assetId mutations (including ctx.animate) take effect the
    // frame they're made.
    this.stepAnimators();

    // 3. Physics integration + collision detection/resolution.
    const contacts = this.stepPhysics();

    // 4. Collision events for new contact pairs.
    this.dispatchCollisionEvents(contacts);

    // 4b. Camera follow applies at end of frame, after physics.
    this.applyCameraFollow();

    // 4c. Particle emitters step deterministically (per-emitter seeded RNG).
    this.stepParticles();

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
    this.pendingScene = null;
    this.cameraFollowId = null;
    this.entities = [];
    this.scriptStates.clear();
    this.handles.clear();
    this.destroyedIds.clear();
    this.activePlaybacks.clear();
    this.eventBus.clear();
    this.ownedLuaEngine?.dispose();
    this.ownedLuaEngine = null;
  }

  // ---------------------------------------------------------------------------
  // Audio
  // ---------------------------------------------------------------------------

  /** Start a playback of an audio asset (by id or name). Null when unknown. */
  playAudio(assetRef: string, opts: { volume?: number; loop?: boolean } = {}): string | null {
    const asset = this.store.getAsset(assetRef);
    if (!asset) {
      this.recordLog('warn', `audio.play: asset not found: ${assetRef}`);
      return null;
    }
    const handleId = `snd_${++this.audioHandleSeq}`;
    this.activePlaybacks.set(handleId, { assetId: asset.id });
    this.recordAudio(asset.id, 'play', handleId, opts.volume ?? 1, opts.loop ?? false);
    return handleId;
  }

  /** Stop one playback by handle id, or every playback of an asset id/name. */
  stopAudio(handleIdOrAssetRef: string): void {
    const playback = this.activePlaybacks.get(handleIdOrAssetRef);
    if (playback) {
      this.activePlaybacks.delete(handleIdOrAssetRef);
      this.recordAudio(playback.assetId, 'stop', handleIdOrAssetRef, 1, false);
      return;
    }
    const asset = this.store.getAsset(handleIdOrAssetRef);
    if (!asset) {
      this.recordLog('warn', `audio.stop: unknown handle or asset: ${handleIdOrAssetRef}`);
      return;
    }
    for (const [handleId, active] of [...this.activePlaybacks]) {
      if (active.assetId === asset.id) {
        this.activePlaybacks.delete(handleId);
        this.recordAudio(asset.id, 'stop', handleId, 1, false);
      }
    }
  }

  /** Stop every active playback (scene teardown); emits stop events. */
  stopAllAudio(): void {
    for (const [handleId, active] of [...this.activePlaybacks]) {
      this.activePlaybacks.delete(handleId);
      this.recordAudio(active.assetId, 'stop', handleId, 1, false);
    }
  }

  private recordAudio(
    assetId: string,
    action: 'play' | 'stop',
    handleId: string,
    volume: number,
    loop: boolean,
  ): void {
    this.audioEvents.push({ frame: this._frame, assetId, action });
    this.options.onAudio?.({ action, handleId, assetId, volume, loop });
  }

  // ---------------------------------------------------------------------------
  // UI pointer input
  // ---------------------------------------------------------------------------

  /**
   * Feed a pointer event in screen coordinates (the buildSettings
   * width×height space). Interactive UIElement entities under the pointer
   * receive onUiEvent: enter/exit on hover changes, press on down, release
   * on up, and click when down and up landed on the same element. Used by
   * playtests directly and by the pixi host for real pointer events.
   */
  sendPointer(x: number, y: number, kind: PointerKind): void {
    if (this.stopped) return;
    const target = this.hitTestUi(x, y);
    const targetId = target?.id ?? null;

    if (targetId !== this.uiHoverId) {
      const prev = this.uiHoverId
        ? this.getEntities().find((e) => e.id === this.uiHoverId)
        : undefined;
      this.uiHoverId = targetId;
      if (prev) this.dispatchUiEvent(prev, 'exit', x, y);
      if (target) this.dispatchUiEvent(target, 'enter', x, y);
    }

    if (kind === 'down') {
      this.uiPressedId = targetId;
      if (target) this.dispatchUiEvent(target, 'press', x, y);
    } else if (kind === 'up') {
      if (target) {
        this.dispatchUiEvent(target, 'release', x, y);
        if (this.uiPressedId === targetId) this.dispatchUiEvent(target, 'click', x, y);
      }
      this.uiPressedId = null;
    }
  }

  /** Topmost interactive UI element under a screen point (layer, then order). */
  private hitTestUi(x: number, y: number): RuntimeEntity | undefined {
    const settings = this.store.project.buildSettings;
    let best: RuntimeEntity | undefined;
    let bestLayer = -Infinity;
    for (const entity of this.getEntities()) {
      if (!entity.enabled || !entity.components.UIElement?.interactive) continue;
      const rect = uiElementRect(entity.components, settings.width, settings.height);
      if (!rect) continue;
      if (x < rect.minX || x > rect.maxX || y < rect.minY || y > rect.maxY) continue;
      const layer = Math.max(
        entity.components.SpriteRenderer?.layer ?? 0,
        entity.components.Text?.layer ?? 0,
      );
      if (layer >= bestLayer) {
        bestLayer = layer;
        best = entity; // later entities win ties, matching render order
      }
    }
    return best;
  }

  private dispatchUiEvent(entity: RuntimeEntity, type: UiEvent['type'], x: number, y: number): void {
    this.callHook(entity, 'onUiEvent', { type, x, y });
  }

  // ---------------------------------------------------------------------------
  // Scenes & camera (ctx v2 backing)
  // ---------------------------------------------------------------------------

  /** Backing for ctx.scenes.load: validate, record pendingScene, never swap. */
  private requestScene(idOrName: string): boolean {
    const scene = this.store.getScene(idOrName);
    if (!scene) {
      this.recordLog('warn', `scenes.load: unknown scene "${idOrName}"`);
      return false;
    }
    this.pendingScene = scene.id;
    return true;
  }

  /** Main Camera entity (isMain wins, else first); optional warn-once. */
  private mainCameraEntity(warn: boolean): RuntimeEntity | null {
    const cameras = this.getEntities().filter((e) => e.enabled && e.components.Camera);
    const cam = cameras.find((e) => e.components.Camera!.isMain) ?? cameras[0] ?? null;
    if (!cam && warn && !this.warnedNoCamera) {
      this.warnedNoCamera = true;
      this.recordLog('warn', 'ctx.camera: no Camera entity in scene');
    }
    return cam;
  }

  /** ctx.camera.follow — copy followed entity's world position, post-physics. */
  private applyCameraFollow(): void {
    if (!this.cameraFollowId) return;
    const target = this.find(this.cameraFollowId);
    if (!target) return;
    const cam = this.mainCameraEntity(false);
    if (!cam) return;
    const pos = this.getWorldPosition(target);
    cam.transform.position.x = pos.x;
    cam.transform.position.y = pos.y;
  }

  // ---------------------------------------------------------------------------
  // Sprite animation
  // ---------------------------------------------------------------------------

  /** Preload every animation asset in the project (they're tiny JSON). */
  private async loadAnimations(): Promise<void> {
    for (const asset of this.store.assets.assets) {
      if (asset.type !== 'animation') continue;
      try {
        const raw = await this.store.fs.readFile(joinPath(this.store.root, asset.path));
        this.animationAssets.set(asset.id, AnimationDataSchema.parse(JSON.parse(raw)));
      } catch (err) {
        this.recordError({
          frame: this._frame,
          message: `Failed to load animation asset "${asset.name}": ${(err as Error).message}`,
          phase: 'load',
        });
      }
    }
  }

  /** Advance every live enabled SpriteAnimator one fixed step; reap destroyed entities. */
  private stepAnimators(): void {
    const liveIds = new Set<string>();
    for (const entity of this.getEntities()) {
      const animator = entity.components.SpriteAnimator;
      if (!animator) continue;
      // Disabled entities keep their state (frozen); only destruction reaps it.
      liveIds.add(entity.id);
      if (!entity.enabled) continue;
      const renderer = entity.components.SpriteRenderer;
      if (!renderer) continue; // no renderer to write frames into: skip silently
      let state = this.animatorStates.get(entity.id);
      if (!state) {
        state = createAnimatorState(animator.assetId);
        this.animatorStates.set(entity.id, state);
      }
      const asset = animator.assetId ? this.animationAssets.get(animator.assetId) : undefined;
      const r = stepAnimator(state, animator, asset, this.fixedDt);
      if (r !== null) {
        renderer.assetId = r.assetId;
        renderer.frame = r.frame;
      }
    }
    for (const id of [...this.animatorStates.keys()]) {
      if (!liveIds.has(id)) this.animatorStates.delete(id);
    }
  }

  // ---------------------------------------------------------------------------
  // Particles
  // ---------------------------------------------------------------------------

  /** Get or lazily create the EmitterState for an entity's ParticleEmitter. */
  private getOrCreateEmitterState(
    entity: RuntimeEntity,
    emitter: ParticleEmitterComponent,
  ): EmitterState {
    let state = this.emitters.get(entity.id);
    if (!state) {
      state = new EmitterState(emitter.seed);
      this.emitters.set(entity.id, state);
    }
    return state;
  }

  /** Advance every live enabled emitter one fixed step; reap destroyed entities. */
  private stepParticles(): void {
    const liveIds = new Set<string>();
    for (const entity of this.getEntities()) {
      if (!entity.components.ParticleEmitter) continue;
      // Disabled entities keep their state (frozen) so re-enabling neither
      // re-bursts nor drops particles; only destruction reaps it.
      liveIds.add(entity.id);
      if (!entity.enabled) continue;
      const emitter = entity.components.ParticleEmitter;
      const state = this.getOrCreateEmitterState(entity, emitter);
      const origin = this.getWorldPosition(entity);
      // One-time scene-start burst, tracked on the state itself (not on map
      // presence): an early ctx.particles.burst() in onStart lazily creates
      // the EmitterState and must not swallow the emitter's own burst.
      if (!state.autoBurstFired) {
        state.autoBurstFired = true;
        state.burst(emitter.burst, emitter, origin);
      }
      state.step(this.fixedDt, emitter, origin);
    }
    for (const id of [...this.emitters.keys()]) {
      if (!liveIds.has(id)) this.emitters.delete(id);
    }
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
    // Dispatch by extension: .lua → shared Lua engine, else JS compile.
    // The engine is created on demand when the options did not provide one
    // (standalone SceneRuntime use; GameSession shares one per session).
    let luaEngine = this.options.luaEngine ?? null;
    if (!luaEngine && [...paths].some(isLuaPath)) {
      try {
        luaEngine = await LuaScriptEngine.create({
          random: () => this.rng(),
          log: (level, message) => this.recordLog(level, message),
        });
        this.ownedLuaEngine = luaEngine;
      } catch (err) {
        this.recordError({
          frame: this._frame,
          message: `Failed to initialize Lua engine: ${(err as Error).message}`,
          phase: 'load',
        });
      }
    }
    for (const path of paths) {
      try {
        const source = await this.store.readScript(path);
        if (isLuaPath(path)) {
          if (!luaEngine) throw new Error('Lua engine unavailable');
          this.scriptModules.set(path, luaEngine.compile(path, source));
        } else {
          this.scriptModules.set(path, compileScript(source));
        }
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
    const scheduler = new EntityScheduler();
    this.scriptStates.set(entity.id, {
      path: script.scriptPath,
      hooks,
      vars,
      scheduler,
      ctx: this.makeContext(entity, script.params, vars, scheduler),
      started: false,
      disabled: hooks === null,
      consecutiveErrors: 0,
    });
  }

  private makeContext(
    entity: RuntimeEntity,
    params: Record<string, unknown>,
    vars: Record<string, unknown>,
    scheduler: EntityScheduler,
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
        findPath: (from, to, opts) => {
          const grid = this.getNavGrid([from, to]);
          if (!grid) return null;
          return findPath(grid, from, to, { diagonals: Boolean(opts?.diagonals) });
        },
      },
      audio: {
        play: (assetRef, opts) => runtime.playAudio(assetRef, opts),
        stop: (handleIdOrAssetRef) => runtime.stopAudio(handleIdOrAssetRef),
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
      scenes: {
        get current() {
          return { id: runtime.sceneId, name: runtime.sceneName };
        },
        list: () => runtime.store.project.scenes.map((s) => ({ id: s.id, name: s.name })),
        load: (idOrName) => runtime.requestScene(idOrName),
      },
      timers: {
        after: (seconds, fn) => scheduler.after(seconds, fn),
        every: (seconds, fn) => scheduler.every(seconds, fn),
        cancel: (id) => scheduler.cancelTimer(id),
      },
      tweens: {
        to: (path, target, seconds, opts) => {
          const resolved = resolveNumericTarget(entity.components, path);
          if (!resolved) {
            runtime.recordLog(
              'warn',
              `tweens.to: unknown or non-numeric property path "${path}" on "${entity.name}"`,
            );
            return '';
          }
          const easing = EASINGS[opts?.easing ?? 'linear'] ?? EASINGS.linear;
          return scheduler.tweenTo(
            resolved.holder,
            resolved.key,
            target,
            seconds,
            easing,
            opts?.onComplete,
          );
        },
        cancel: (id) => scheduler.cancelTween(id),
      },
      random: {
        next: () => runtime.rng(),
        range: (min, max) => min + runtime.rng() * (max - min),
        int: (min, max) => {
          const lo = Math.ceil(Math.min(min, max));
          const hi = Math.floor(Math.max(min, max));
          if (hi < lo) return lo;
          return lo + Math.floor(runtime.rng() * (hi - lo + 1));
        },
      },
      particles: {
        burst: (count) => {
          const emitter = entity.components.ParticleEmitter;
          if (!emitter) {
            runtime.recordLog(
              'warn',
              `ctx.particles.burst: no ParticleEmitter on "${entity.name}"`,
            );
            return;
          }
          const state = runtime.getOrCreateEmitterState(entity, emitter);
          state.burst(count, emitter, runtime.getWorldPosition(entity));
        },
        count: () => runtime.getParticleCount(entity.id),
      },
      math: createCtxMath((msg) => this.recordLog('warn', msg)),
      animate: (assetRef) => {
        const animator = entity.components.SpriteAnimator;
        if (!animator) {
          runtime.recordLog('warn', `ctx.animate: no SpriteAnimator on "${entity.name}"`);
          return;
        }
        const asset = runtime.store.getAsset(assetRef);
        if (!asset || asset.type !== 'animation' || !runtime.animationAssets.has(asset.id)) {
          runtime.recordLog('warn', `ctx.animate: unknown animation asset "${assetRef}"`);
          return;
        }
        animator.assetId = asset.id;
        animator.playing = true;
        // Reset playback unconditionally so re-triggering the current clip
        // (replaying a finished non-loop animation, restarting a loop)
        // starts over — the stage-2c assetId-diff check alone would not
        // fire when the asset id is unchanged. Stage 2c recreates the
        // state at frame 0 the same frame.
        runtime.animatorStates.delete(entity.id);
      },
      save: (key, value) => {
        runtime.storage.set(key, JSON.stringify(value) ?? 'null');
      },
      load: (key) => {
        const raw = runtime.storage.get(key);
        if (raw === null || raw === undefined) return null;
        try {
          return JSON.parse(raw);
        } catch {
          runtime.recordLog('warn', `load: could not parse saved value for "${key}"`);
          return null;
        }
      },
      clearSave: (key) => {
        if (key !== undefined) {
          runtime.storage.remove(key);
          return;
        }
        const keys = runtime.storage.keys?.();
        if (!keys) {
          runtime.recordLog('warn', 'clearSave: storage cannot enumerate keys; pass a key');
          return;
        }
        for (const k of keys) runtime.storage.remove(k);
      },
      camera: {
        getPosition: () => {
          runtime.mainCameraEntity(true);
          return runtime.camera.position;
        },
        setPosition: (x, y) => {
          const cam = runtime.mainCameraEntity(true);
          if (!cam) return;
          cam.transform.position.x = x;
          cam.transform.position.y = y;
        },
        getZoom: () => {
          runtime.mainCameraEntity(true);
          return runtime.camera.zoom;
        },
        setZoom: (zoom) => {
          const cam = runtime.mainCameraEntity(true);
          if (!cam) return;
          cam.components.Camera!.zoom = zoom;
        },
        follow: (idOrName) => {
          if (idOrName === null) {
            runtime.cameraFollowId = null;
            return;
          }
          const target = runtime.find(idOrName);
          if (!target) {
            runtime.recordLog('warn', `camera.follow: entity not found: ${idOrName}`);
            return;
          }
          runtime.mainCameraEntity(true);
          runtime.cameraFollowId = target.id;
        },
      },
      events: {
        emit: (name, data) => runtime.emitEvent(name, data),
        on: (name, fn) => runtime.eventBus.on(entity.id, name, fn),
        off: (id) => runtime.eventBus.off(id),
      },
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
      this.eventBus.removeOwner(id);
    }
    this.destroyedIds.clear();
  }

  private callHook(
    entity: RuntimeEntity,
    hook: 'onStart' | 'onUpdate' | 'onCollision' | 'onUiEvent' | 'onEvent',
    ...args: unknown[]
  ): void {
    const state = this.scriptStates.get(entity.id);
    if (!state || state.disabled || !state.hooks) return;
    const fn = state.hooks[hook];
    if (typeof fn !== 'function') return;
    try {
      (fn as (ctx: ScriptContext, ...args: unknown[]) => void).call(state.hooks, state.ctx, ...args);
      state.consecutiveErrors = 0;
    } catch (err) {
      this.recordHookError(state, entity.name, hook, err);
    }
  }

  /**
   * Shared error bookkeeping for both callHook and emitEvent's subscription
   * callbacks: records the error, increments consecutiveErrors, and disables
   * the script after MAX_CONSECUTIVE_SCRIPT_ERRORS in a row.
   */
  private recordHookError(state: ScriptState, entityName: string, phase: string, err: unknown): void {
    state.consecutiveErrors++;
    this.recordError({
      frame: this._frame,
      message: (err as Error)?.message ?? String(err),
      entity: entityName,
      script: state.path,
      phase,
    });
    if (state.consecutiveErrors >= MAX_CONSECUTIVE_SCRIPT_ERRORS) {
      state.disabled = true;
      this.recordLog(
        'warn',
        `script ${state.path} on "${entityName}" disabled after ${MAX_CONSECUTIVE_SCRIPT_ERRORS} consecutive errors`,
      );
    }
  }

  /** ctx.events.emit — synchronous, deterministic delivery. */
  emitEvent(name: string, data?: unknown): void {
    if (this.emitDepth >= MAX_EVENT_DEPTH) {
      this.recordLog('warn', `event "${name}" dropped: event cascade too deep (max ${MAX_EVENT_DEPTH})`);
      return;
    }
    this.eventCounts.set(name, (this.eventCounts.get(name) ?? 0) + 1);
    const record: GameEventRecord = { frame: this._frame, name };
    if (data !== undefined) {
      try {
        record.data = JSON.parse(JSON.stringify(data));
      } catch {
        record.data = String(data);
      }
    }
    // Only the recorded list is capped. onGameEvent fires for every emit so
    // aggregators (GameSession) can keep exact counts past the cap; they
    // apply their own list cap.
    if (this.events.length < MAX_RECORDED_EVENTS) {
      this.events.push(record);
    } else {
      this.eventsTruncated = true;
    }
    this.options.onGameEvent?.(record);
    this.emitDepth++;
    try {
      // 1. Explicit subscriptions, subscription order. Snapshot: handlers
      //    subscribed during delivery wait for the next emit; handlers
      //    unsubscribed (or whose entity died) mid-delivery are skipped.
      const listeners = this.eventBus.listenersFor(name);
      for (const sub of listeners) {
        if (!this.eventBus.isLive(sub) || this.destroyedIds.has(sub.ownerId)) continue;
        // Mirror callHook's disabled guard: once a script is disabled after
        // repeated errors, its subscriptions stop firing too.
        const ownerState = this.scriptStates.get(sub.ownerId);
        if (ownerState?.disabled) continue;
        try {
          sub.fn(data);
        } catch (err) {
          if (ownerState) {
            const ownerEntity = this.entities.find((e) => e.id === sub.ownerId);
            this.recordHookError(ownerState, ownerEntity?.name ?? sub.ownerId, 'onEvent', err);
          }
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
      shape: CollisionShape;
      isTrigger: boolean;
      dynamic: boolean;
      body?: PhysicsBodyComponent;
      filter: { layer: string; collidesWith: string[] };
      oneWay: boolean;
    }
    interface Obstacle {
      entity: RuntimeEntity;
      shape: CollisionShape;
      isTrigger: boolean;
      body?: PhysicsBodyComponent;
      filter: { layer: string; collidesWith: string[] };
      oneWay: boolean;
    }
    const movers: Mover[] = [];
    const obstacles: Obstacle[] = [];
    for (const entity of live) {
      if (!entity.enabled) continue;
      const body = entity.components.PhysicsBody;
      const bodyType = body?.bodyType ?? 'static';
      const collider = entity.components.Collider;
      if (collider) {
        const shape = colliderShape(collider, this.getWorldPosition(entity), entity.transform);
        const filter = { layer: collider.layer, collidesWith: collider.collidesWith };
        if (bodyType === 'static') {
          obstacles.push({
            entity,
            shape,
            isTrigger: collider.isTrigger,
            body,
            filter,
            oneWay: collider.oneWay,
          });
        } else {
          movers.push({
            entity,
            shape,
            isTrigger: collider.isTrigger,
            dynamic: bodyType === 'dynamic',
            body,
            filter,
            oneWay: collider.oneWay,
          });
        }
      }
      const tilemap = entity.components.Tilemap;
      if (tilemap && tilemap.solid) {
        for (const box of tilemapBoxes(tilemap, this.getWorldPosition(entity))) {
          obstacles.push({
            entity,
            shape: { kind: 'box', box },
            isTrigger: false,
            filter: TILEMAP_FILTER,
            oneWay: false,
          });
        }
      }
    }

    // One-way platforms: the obstacle only blocks a mover being resolved
    // upward (landing on top) while the mover is not moving up through it.
    //
    // `vy` is read at resolution time, i.e. after this frame's integration
    // (and possibly after an earlier contact in this same pass has already
    // adjusted it) — not the velocity the mover entered the frame with.
    // That's fine: contact resolution is deterministic and per-pair, so
    // "at resolution time" is a well-defined, reproducible instant, it's
    // just not necessarily the pre-integration velocity a naive reading
    // of this code might assume.
    const passesOneWay = (mover: Mover, obstacleOneWay: boolean, ny: number): boolean => {
      if (!obstacleOneWay) return true;
      if (ny >= -0.707) return false;
      const vy = mover.entity.components.PhysicsBody?.velocity.y ?? 0;
      return vy >= 0;
    };

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

    const applyPush = (
      mover: Mover,
      nx: number,
      ny: number,
      amount: number,
      other: { restitution: number; friction: number },
    ) => {
      mover.entity.transform.position.x += nx * amount;
      mover.entity.transform.position.y += ny * amount;
      translateShape(mover.shape, nx * amount, ny * amount);
      const body = mover.entity.components.PhysicsBody;
      if (body) {
        const e = Math.max(body.restitution, other.restitution);
        const mu = Math.max(body.friction, other.friction);
        resolveContactVelocity(body.velocity, nx, ny, e, mu, this.fixedDt);
      }
    };

    // Movers vs static obstacles (dynamic movers get pushed out).
    for (const mover of movers) {
      for (const obstacle of obstacles) {
        if (!layersInteract(mover.filter, obstacle.filter)) continue;
        const push = computeShapePush(mover.shape, obstacle.shape);
        if (!push) continue;
        const trigger = mover.isTrigger || obstacle.isTrigger;
        if (!trigger && !passesOneWay(mover, obstacle.oneWay, push.ny)) continue;
        if (!trigger && mover.dynamic) {
          const other = obstacle.body
            ? { restitution: obstacle.body.restitution, friction: obstacle.body.friction }
            : { restitution: 0, friction: 0 };
          applyPush(mover, push.nx, push.ny, push.amount, other);
        }
        addContact(mover.entity, obstacle.entity, push.nx, push.ny, trigger);
      }
    }

    // Mover vs mover.
    for (let i = 0; i < movers.length; i++) {
      for (let j = i + 1; j < movers.length; j++) {
        const a = movers[i];
        const b = movers[j];
        if (!layersInteract(a.filter, b.filter)) continue;
        const push = computeShapePush(a.shape, b.shape);
        if (!push) continue;
        const trigger = a.isTrigger || b.isTrigger;
        if (
          !trigger &&
          (!passesOneWay(a, b.oneWay, push.ny) || !passesOneWay(b, a.oneWay, -push.ny))
        ) {
          continue;
        }
        if (!trigger) {
          const aOther = b.body
            ? { restitution: b.body.restitution, friction: b.body.friction }
            : { restitution: 0, friction: 0 };
          const bOther = a.body
            ? { restitution: a.body.restitution, friction: a.body.friction }
            : { restitution: 0, friction: 0 };
          if (a.dynamic && b.dynamic) {
            // The schema requires positive mass, but scripts can write it
            // directly (same escape hatch as degenerate polygon points in
            // physics.ts): non-positive/non-finite masses would make the
            // split NaN or negative and corrupt transforms — treat them as 1.
            const rawMa = a.body?.mass ?? 1;
            const rawMb = b.body?.mass ?? 1;
            const ma = Number.isFinite(rawMa) && rawMa > 0 ? rawMa : 1;
            const mb = Number.isFinite(rawMb) && rawMb > 0 ? rawMb : 1;
            const total = ma + mb;
            applyPush(a, push.nx, push.ny, (push.amount * mb) / total, aOther);
            applyPush(b, -push.nx, -push.ny, (push.amount * ma) / total, bOther);
          } else if (a.dynamic) {
            applyPush(a, push.nx, push.ny, push.amount, aOther);
          } else if (b.dynamic) {
            applyPush(b, -push.nx, -push.ny, push.amount, bOther);
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
