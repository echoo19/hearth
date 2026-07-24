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
  PrefabDataSchema,
  StateMachineDataSchema,
  buildNavGrid,
  collectNavSolids,
  createComponent,
  findPath,
  generateId,
  instantiatePrefabData,
  isComponentType,
  joinPath,
  type AnimationData,
  type AnimationStateMachineComponent,
  type PrefabData,
  type StateMachineData,
  type ComponentMap,
  type Entity,
  type NavEntityInput,
  type NavGrid,
  type ParticleEmitterComponent,
  type PhysicsBodyComponent,
  type PostEffect,
  type ProjectStore,
  type Scene,
  type TilemapComponent,
  type TransformComponent,
  type Vec2,
} from '@hearth/core';
import { createAnimatorState, stepAnimator, type AnimatorState } from './animator.js';
import {
  createSmState,
  fireSmTrigger,
  getSmParam,
  setSmParam,
  stepStateMachine,
  type SmState,
} from './stateMachine.js';
import {
  SpatialHash,
  broadphaseTestHooks,
  chooseCellSize,
  shapeAabb,
  type Aabb,
} from './broadphase.js';
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
  type Box,
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
import { CameraEffectsState, type CameraEffectRecord } from './cameraEffects.js';
import { createCtxMath } from './ctxMath.js';
import { EventBus, type GameEventRecord } from './events.js';
import { LuaScriptEngine, isLuaPath } from './lua.js';
import { EmitterState, type Particle } from './particles.js';
import { ScriptModuleRegistry } from './scriptModules.js';
import { MemorySessionStorage, type SessionStorage } from './session.js';
import { EASINGS, EntityScheduler, createRng, resolveNumericTarget } from './stdlib.js';
import { rectAtPosition, resolveUiPositions } from './ui.js';

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
  /** 1-based source line, when extractable from the error; null otherwise. */
  line?: number | null;
}

/** One recorded audio play/stop, as it appears in run reports. */
export interface AudioEvent {
  frame: number;
  assetId: string;
  action: 'play' | 'stop';
  /** True only for records from the music channel (playMusic/stopMusic). */
  music?: boolean;
}

/** Live audio notification for rendering hosts (Web Audio playback). */
export interface AudioPlaybackEvent {
  action: 'play' | 'stop' | 'music-volume';
  handleId: string;
  assetId: string;
  volume: number;
  loop: boolean;
  /** True only for the single music channel (playMusic/stopMusic/setMusicVolume). */
  music?: boolean;
  /** Fade-in seconds, set on music play records. */
  fadeIn?: number;
  /** Fade-out seconds, set on music stop records. */
  fadeOut?: number;
  /** Fade seconds for a music-volume change. */
  fade?: number;
}

/**
 * Shared state for the single music channel — owned by GameSession (so
 * music survives scene switches) and passed into every SceneRuntime via
 * `RuntimeOptions.musicChannel`. A standalone SceneRuntime (no session)
 * creates its own when none is provided.
 */
export interface MusicChannelState {
  current: { handleId: string; assetId: string } | null;
  seq: number;
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
  /** Session-shared music channel; created on demand if absent (standalone use). */
  musicChannel?: MusicChannelState;
  /**
   * Live notification for every ctx.events.emit — fires even after the
   * runtime's recorded-events list caps, so aggregators keep exact counts.
   */
  onGameEvent?(record: GameEventRecord): void;
  /**
   * Persistent fade overlay level to start this runtime's CameraEffectsState
   * with (carried across a GameSession scene switch). Transient shake/flash/
   * zoomPunch never carry. Default: no overlay (alpha 0).
   */
  initialCameraOverlay?: { color: string; alpha: number };
  /** Fired for every ctx.camera.shake/flash/fade/zoomPunch call, tagged with its frame. */
  onCameraEffect?(rec: CameraEffectRecord): void;
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

/**
 * Best-effort 1-based source line for a script error, kept LOCAL to the
 * runtime so this package never pulls in core's validate.ts (and luaparse
 * with it, which would bloat the player bundle). Lua errors carry a native
 * "path:LINE:" prefix from the `@path` chunk name; JS runtime errors carry a
 * `<anonymous>:LINE:COL` stack frame whose line is offset by 2 for the
 * `new Function(module, exports)` wrapper compileScript uses (same offset as
 * validate.ts). Returns null when no line is recoverable (notably JS
 * *compile* failures, whose SyntaxError has no usable stack frame).
 */
function extractScriptErrorLine(path: string, err: unknown): number | null {
  if (isLuaPath(path)) {
    const message = (err as Error | undefined)?.message ?? String(err);
    const match = message.match(new RegExp(`${escapeRegExp(path)}:(\\d+):`));
    return match ? parseInt(match[1], 10) : null;
  }
  const stack = (err as Error | undefined)?.stack ?? '';
  const match = stack.match(/<anonymous>:(\d+):\d+/);
  if (!match) return null;
  const line = parseInt(match[1], 10) - 2;
  return line >= 1 ? line : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MAX_CONSECUTIVE_SCRIPT_ERRORS = 3;
/** ctx.events.emit re-entrancy guard: nested emits deeper than this are dropped. */
const MAX_EVENT_DEPTH = 8;
/** Cap on SceneRuntime.events (oldest kept, newest dropped once full). */
const MAX_RECORDED_EVENTS = 200;
/** Unit vectors for moveUiFocus directions, in screen space (+x right, +y down). */
const DIRECTION_VECTORS: Record<'up' | 'down' | 'left' | 'right', Vec2> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

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
  /**
   * Every action/axis name read this scene run via ctx.input.isDown,
   * ctx.input.justPressed, or ctx.input.axis — recorded passively (no effect
   * on the returned value, no ordering/rng impact) so a later consumer can
   * diff this against inputMappings to find "dead controls": declared
   * actions/axes no script ever queries. Pointer reads are not tracked.
   * GameSession folds this into GameSession.readInputs across scene
   * switches (see performSwitch in session.ts).
   */
  readonly readInputNames = new Set<string>();
  /** Deterministic shake/flash/fade/zoomPunch — stepped right after camera follow. */
  readonly cameraEffects: CameraEffectsState;

  /** Scene id requested by ctx.scenes.load this frame (hosts react after step). */
  pendingScene: string | null = null;

  private _frame = 0;
  private _elapsed = 0;
  private entities: RuntimeEntity[] = [];
  private destroyedIds = new Set<string>();
  /**
   * getEntities() cache — invalidated by invalidateEntitiesCache() on every
   * spawn, destroy (destroyedIds mutation), and flushDestroyed(), the only
   * things that change what getEntities() would compute. `enabled` toggles
   * do NOT invalidate it: getEntities() has never filtered on `enabled`
   * (every call site does that itself), and there is no runtime API that
   * mutates `enabled` post-instantiate, so there is nothing to invalidate
   * for. The returned array must never be mutated by callers (no push/
   * splice/sort at any call site — audited) since the same
   * array is handed out to every call site for the rest of the frame.
   */
  private entitiesCache: RuntimeEntity[] | null = null;
  /**
   * Per-entity tilemap collider cache, keyed by entity id. `key` encodes
   * everything tilemapBoxes()'s output can depend on: grid content, tile
   * size, solid, and world position (a moving parent moves the tilemap —
   * see getWorldPosition). Recomputed only when `key` changes; see
   * `tilemapGridHashCache` for why the grid-content part of `key` is cheap
   * to keep current every frame despite being an O(rows) join.
   */
  private tilemapBoxCache = new Map<string, { key: string; boxes: Box[] }>();
  /**
   * Memoizes `grid.join('\n')` per entity, recomputed only when the grid
   * ARRAY REFERENCE changes (not on in-place content edits — nothing in
   * this codebase mutates Tilemap.grid in place; setComponentProperty and
   * ctx.getComponent('Tilemap').grid = [...] both assign a whole new
   * array). This turns the join from "every physics step" into "only when
   * a script/live-edit actually replaces the grid," which is the
   * expensive part getTilemapBoxes's cache exists to avoid paying per
   * frame for tilemaps that never change.
   */
  private tilemapGridHashCache = new Map<string, { ref: readonly string[]; hash: string }>();
  /**
   * Per-frame spatial hashes for stepPhysics's pair loops (rebuilt via
   * reset() each step; instances persist so their internal stamp/scratch
   * buffers don't reallocate every frame). See broadphase.ts for the
   * order-preservation and conservative-pruning contract.
   */
  private readonly obstacleBroadphase = new SpatialHash(32);
  private readonly moverBroadphase = new SpatialHash(32);
  private scriptModules = new Map<string, ScriptHooks | null>();
  /**
   * Phase-1 result of loadScripts: every script path's source text, read up
   * front because `require` is synchronous while store.readScript is async.
   * Hot reload updates entries in place (the registry shares this map).
   */
  private scriptSources = new Map<string, string>();
  /** Module registry: memoized module values + the require dependents graph. */
  private moduleRegistry: ScriptModuleRegistry | null = null;
  /**
   * During a hot-reload staging pass, Lua require edges (reported through the
   * Lua engine's resolveModule callback) are recorded here instead of the
   * live registry, so a failed reload never mutates the live graph and a
   * successful one commits FRESH edges (a require removed by an edit drops
   * its edge). Null outside reloadScript.
   */
  private moduleEdgeSink: ScriptModuleRegistry | null = null;
  private scriptStates = new Map<string, ScriptState>();
  private handles = new Map<string, EntityHandle>();
  private prevContactPairs = new Set<string>();
  private maxLogs: number;
  private stopped = false;
  private audioStarted = false;
  private audioHandleSeq = 0;
  private activePlaybacks = new Map<string, { assetId: string }>();
  private readonly musicChannel: MusicChannelState;
  private uiHoverId: string | null = null;
  private uiPressedId: string | null = null;
  /**
   * Latest pointer position in screen coordinates (buildSettings width×height
   * space), fed by every `sendPointer`. Defaults to screen center so
   * `ctx.input.pointer()` reads the camera-center world point before the first
   * pointer event. `pointerButtonDown` tracks the primary button held-state
   * and `pointerPressedEdge` its just-pressed-this-frame flag (cleared at
   * endFrame, mirroring InputState.justPressed).
   */
  private pointerScreenPos: Vec2;
  private pointerButtonDown = false;
  private pointerPressedEdge = false;
  private uiFocusId: string | null = null;
  private readonly sceneId: string;
  private readonly sceneName: string;
  private readonly rng: () => number;
  private readonly storage: SessionStorage;
  private ownedLuaEngine: LuaScriptEngine | null = null;
  private cameraFollowId: string | null = null;
  private warnedNoCamera = false;
  private emitters = new Map<string, EmitterState>();
  private animationAssets = new Map<string, AnimationData>();
  private stateMachineAssets = new Map<string, StateMachineData>();
  private prefabAssets = new Map<string, PrefabData>();
  private animatorStates = new Map<string, AnimatorState>();
  private smStates = new Map<string, SmState>();
  /** Entities warned once about an AnimationStateMachine overriding a SpriteAnimator. */
  private warnedDualAnimator = new Set<string>();
  private eventBus = new EventBus();
  private emitDepth = 0;
  private navGrid: NavGrid | null = null;
  private navGridFrame = -1;
  /**
   * Tilemap `grid` array references baked into `navGrid`, in entity order.
   * A same-frame `tilemap.grid = [...]` swap (common in onStart, which shares
   * frame 0 with the first onUpdate) changes a reference here, so the cache is
   * invalidated even though the frame is unchanged — mirrors how
   * `tilemapGridHashCache` keys off the grid ARRAY REFERENCE.
   */
  private navGridGrids: readonly (readonly string[])[] = [];

  private constructor(
    private readonly store: ProjectStore,
    scene: Scene,
    private readonly options: RuntimeOptions,
  ) {
    this.fixedDt = 1 / store.project.buildSettings.fixedTimestep;
    this.maxLogs = options.maxLogs ?? 1000;
    this.input = new InputState(store.project.inputMappings);
    this.pointerScreenPos = {
      x: store.project.buildSettings.width / 2,
      y: store.project.buildSettings.height / 2,
    };
    this.sceneId = scene.id;
    this.sceneName = scene.name;
    this.rng = options.rng ?? createRng(options.seed ?? 0);
    this.storage = options.storage ?? new MemorySessionStorage();
    this.musicChannel = options.musicChannel ?? { current: null, seq: 0 };
    this._frame = options.frameOffset ?? 0;
    this._elapsed = this._frame * this.fixedDt;
    this.cameraEffects = new CameraEffectsState({
      // Reuses RuntimeOptions.seed (not the shared `rng` stream — consuming it
      // here would shift ctx.random's first value out from under scripts).
      seed: options.seed ?? 0,
      initialOverlay: options.initialCameraOverlay,
      onRecord: (rec) => this.options.onCameraEffect?.(rec),
    });
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
    await runtime.loadStateMachines();
    await runtime.loadPrefabs();
    await runtime.loadScripts();
    return runtime;
  }

  get frame(): number {
    return this._frame;
  }

  get elapsed(): number {
    return this._elapsed;
  }

  /**
   * Live, spawned and not destroyed entities, in stable order. Cached for
   * the rest of the frame (or until the next spawn/destroy) — see
   * `entitiesCache`'s doc comment for exactly what invalidates it.
   */
  getEntities(): RuntimeEntity[] {
    if (!this.entitiesCache) {
      // Always a fresh array distinct from `this.entities` (never the live
      // array itself), even when nothing is destroyed: a spawn later this
      // same frame pushes onto `this.entities`, and a `for...of` loop
      // already iterating an aliased return value would pick up that push
      // mid-iteration (array iterators track live length), silently
      // changing which entities get onStart/onUpdate this frame. Slicing
      // decouples the snapshot handed out from further mutation of
      // `this.entities`, matching the pre-cache behavior exactly.
      this.entitiesCache =
        this.destroyedIds.size === 0
          ? this.entities.slice()
          : this.entities.filter((e) => !this.destroyedIds.has(e.id));
    }
    return this.entitiesCache;
  }

  private invalidateEntitiesCache(): void {
    this.entitiesCache = null;
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

  /**
   * Read-only snapshot of an entity's pending timers and active tweens
   * (Live panel inspection). Null for an unknown entity or one with no
   * script (and so no scheduler) — never throws.
   */
  getSchedulerSnapshot(
    entityId: string,
  ): {
    timers: ReadonlyArray<{ id: string; remaining: number; interval: number; repeat: boolean }>;
    tweens: ReadonlyArray<{ id: string; key: string; elapsed: number; duration: number; from: number; to: number }>;
  } | null {
    const state = this.scriptStates.get(entityId);
    if (!state) return null;
    return { timers: state.scheduler.listTimers(), tweens: state.scheduler.listTweens() };
  }

  /**
   * Hot-reload one script's source while the scene keeps running (editor
   * write→play→tweak). On success every live entity bound to `path` gets the
   * newly compiled hooks; their vars, scheduler (timers/tweens), ctx, and
   * `started` flag are all preserved — so onStart does NOT re-run, and an
   * error-disabled script re-enables. Future spawns of `path` pick up the new
   * hooks too (scriptModules is updated). On a compile failure the old hooks
   * keep running unchanged and the failure is recorded (phase 'reload') with a
   * best-effort source line.
   *
   * Note (documented, pinned by tests): existing `ctx.events.on` subscriptions
   * keep firing their OLD closures — reload does not, and cannot, re-register
   * them. Only the `onEvent` hook resolves to the new code.
   */
  async reloadScript(
    path: string,
    source: string,
  ): Promise<
    { ok: true; entities: number } | { ok: false; message: string; line: number | null }
  > {
    // Everything the edit invalidates: the script itself plus every module
    // that (transitively) requires it — recompiling only the edited path
    // would leave dependents running stale code, the exact bug class hot
    // reload exists to prevent.
    if (!this.moduleRegistry) this.moduleRegistry = new ScriptModuleRegistry(this.scriptSources);
    const registry = this.moduleRegistry;
    const dependents = [...registry.transitiveDependentsOf(path)];
    const affected = [path, ...dependents];

    // Stage EVERYTHING first; commit only on full success, so a compile
    // failure anywhere leaves the entire previous module graph in place
    // (the old "compile failure keeps old code running" contract must not
    // become "half the graph swapped"). Unaffected modules stay memoized in
    // the staging registry — their bodies never re-run and every requirer
    // keeps the one live instance.
    const stagedSources = new Map(this.scriptSources);
    stagedSources.set(path, source);
    const staging = registry.stageFor(stagedSources, affected);
    const staged = new Map<string, ScriptHooks>();
    const luaEngine = this.options.luaEngine ?? this.ownedLuaEngine;
    let failedPath = path;
    // Route Lua require edges (reported via the engine's resolveModule
    // callback while staged bodies run) into the staging graph.
    this.moduleEdgeSink = staging;
    try {
      // The edited module compiles first: if it fails, nothing at all has
      // mutated (the Lua engine keeps the previous module on a failed
      // re-run of changed text; the staging registry is thrown away).
      staged.set(path, this.moduleHooks(path, staging, stagedSources));
      // Dependents' sources are unchanged, so the Lua engine's path+source
      // memo would return their OLD bodies — drop those memos first so each
      // body re-runs against the new module, then recompile them all.
      if (luaEngine) {
        for (const dep of dependents) {
          if (isLuaPath(dep)) luaEngine.invalidateModule(dep);
        }
      }
      for (const dep of dependents) {
        failedPath = dep;
        staged.set(dep, this.moduleHooks(dep, staging, stagedSources));
      }
    } catch (err) {
      // For JS this is a pure no-op failure (only the staging registry saw
      // the new code). For Lua, a DEPENDENT failing after the edited module
      // already replaced its value inside the VM needs a best-effort reset:
      // drop every affected Lua memo so future requires lazily re-run from
      // the unchanged scriptSources text. Live hooks were never swapped, so
      // the prior graph keeps running either way.
      if (luaEngine && staged.has(path)) {
        for (const p of affected) {
          if (isLuaPath(p)) luaEngine.invalidateModule(p);
        }
      }
      const message = (err as Error)?.message ?? String(err);
      const line = extractScriptErrorLine(failedPath, err);
      this.recordError({ frame: this._frame, message, script: failedPath, phase: 'reload', line });
      return { ok: false, message, line };
    } finally {
      this.moduleEdgeSink = null;
    }

    // Full success — commit. Fresh edges replace the affected paths'
    // outgoing edges (a require REMOVED by the edit drops its edge here).
    // One exception: a Lua reload with byte-identical text is a VM memo hit
    // whose body (and requires) never re-ran, so no staging edges were
    // recorded for it — keep its old edges (same text means same requires).
    const editedBodyReran = !(isLuaPath(path) && this.scriptSources.get(path) === source);
    this.scriptSources.set(path, source); // the registry shares this map
    registry.clearEdgesFrom(editedBodyReran ? affected : dependents);
    registry.absorbEdges(staging);
    for (const p of affected) {
      registry.setExport(p, staged.get(p));
    }
    // Swap the modules (so future spawns compile against them) and re-point
    // every live entity bound to an affected path at its fresh hooks.
    const affectedSet = new Set(affected);
    let entities = 0;
    for (const p of affected) {
      this.scriptModules.set(p, staged.get(p) ?? null);
    }
    for (const state of this.scriptStates.values()) {
      if (!affectedSet.has(state.path)) continue;
      state.hooks = staged.get(state.path) ?? null;
      state.disabled = false;
      state.consecutiveErrors = 0;
      entities++;
    }
    return { ok: true, entities };
  }

  /**
   * Live-patch a single component property on one entity (editor Inspector
   * tweaks during play). `entityRef` is an id, falling back to a UNIQUE name
   * match. `propertyPath` is a dot path WITHOUT the leading component type
   * (e.g. "ambientLight" or "position.x"); a numeric segment indexes an array.
   * Returns false (a silent skip) when the entity, the component, or an
   * intermediate object on the path is missing — patching never creates
   * structure (the authoring layer already validated the write). Camera props
   * take effect immediately: runtime.camera reads live component data every
   * tick.
   */
  patchComponent(
    entityRef: string,
    componentType: string,
    propertyPath: string,
    value: unknown,
  ): boolean {
    const live = this.getEntities();
    let entity = live.find((e) => e.id === entityRef);
    if (!entity) {
      const named = live.filter((e) => e.name === entityRef);
      if (named.length === 1) entity = named[0];
    }
    if (!entity) return false;
    const component = (entity.components as Record<string, unknown>)[componentType];
    if (component === undefined || component === null || typeof component !== 'object') {
      return false;
    }
    const segments = propertyPath.split('.');
    let target: Record<string, unknown> = component as Record<string, unknown>;
    for (let i = 0; i < segments.length - 1; i++) {
      const next = target[segments[i]];
      if (next === undefined || next === null || typeof next !== 'object') return false;
      target = next as Record<string, unknown>;
    }
    target[segments[segments.length - 1]] = value;
    return true;
  }

  /**
   * Live-swap a state-machine asset's parsed document while the scene keeps
   * running (editor Animator edits, or an external `hearth` update, during
   * play). Replaces the stored StateMachineData for `assetId`, then resets ONLY
   * the entities currently bound to that asset back to their initial state
   * (params re-defaulted, triggers cleared, clip rewound) so the new graph
   * takes effect immediately; every other entity's SmState — including entities
   * on a DIFFERENT machine — is left untouched. Entities that reference the
   * asset but have not stepped yet (no SmState) simply pick up the new document
   * lazily. Returns the number of live entities that were reset.
   */
  reloadStateMachineAsset(assetId: string, data: StateMachineData): number {
    this.stateMachineAssets.set(assetId, data);
    let reset = 0;
    for (const [entityId, state] of this.smStates) {
      if (state.assetId !== assetId) continue;
      // Reseed from the new asset: initial state, default params, empty triggers.
      this.smStates.set(entityId, createSmState(data, assetId));
      reset++;
    }
    return reset;
  }

  /** Active camera view: main Camera entity, or build-settings defaults. */
  get camera(): {
    position: Vec2;
    zoom: number;
    backgroundColor: string;
    ambientLight: number;
    postEffects: PostEffect[];
  } {
    const settings = this.store.project.buildSettings;
    const cameras = this.getEntities().filter((e) => e.enabled && e.components.Camera);
    const cam = cameras.find((e) => e.components.Camera!.isMain) ?? cameras[0];
    if (!cam) {
      return {
        position: { x: settings.width / 2, y: settings.height / 2 },
        zoom: 1,
        backgroundColor: settings.backgroundColor,
        ambientLight: 1,
        postEffects: [],
      };
    }
    return {
      position: this.getWorldPosition(cam),
      zoom: cam.components.Camera!.zoom,
      backgroundColor: cam.components.Camera!.backgroundColor,
      ambientLight: cam.components.Camera!.ambientLight,
      postEffects: cam.components.Camera!.postEffects ?? [],
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

  /**
   * Whether the current tilemap grid references match the ones baked into the
   * cached nav grid (identity per element, in entity order). A same-frame
   * `tilemap.grid = [...]` swap fails this and forces a rebuild.
   */
  private sameNavGrids(grids: readonly (readonly string[])[]): boolean {
    if (grids.length !== this.navGridGrids.length) return false;
    for (let i = 0; i < grids.length; i++) {
      if (grids[i] !== this.navGridGrids[i]) return false;
    }
    return true;
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
   *
   * Public so external per-frame callers (bot playtesting policies) can reuse
   * the exact same grid `ctx.scene.findPath` uses, rather than reconstructing
   * one. It is safe to call every frame: the result is memoized per frame and
   * only rebuilt when the query points fall outside the cached bounds or the
   * scene's solids change. Pair it with `findPath` from `@hearth/core`, passing
   * the same `include` points you intend to path between so the grid is
   * guaranteed to cover them.
   */
  getNavGrid(include: Vec2[]): NavGrid | null {
    const inputs: NavEntityInput[] = [];
    const grids: (readonly string[])[] = [];
    for (const entity of this.getEntities()) {
      if (!entity.enabled) continue;
      inputs.push({
        position: this.getWorldPosition(entity),
        transform: entity.transform,
        collider: entity.components.Collider,
        tilemap: entity.components.Tilemap,
        bodyType: entity.components.PhysicsBody?.bodyType ?? 'static',
      });
      if (entity.components.Tilemap) grids.push(entity.components.Tilemap.grid);
    }
    if (
      this.navGridFrame === this._frame &&
      this.navGrid &&
      this.sameNavGrids(grids) &&
      this.gridContains(this.navGrid, include)
    ) {
      return this.navGrid;
    }
    this.navGridFrame = this._frame;
    this.navGridGrids = grids;
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
          if (source.music) {
            this.playMusic(source.assetId, { volume: source.volume, loop: source.loop });
          } else {
            this.playAudio(source.assetId, { volume: source.volume, loop: source.loop });
          }
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

    // 2c. AnimationStateMachine playback runs BEFORE plain SpriteAnimator so a
    // machine wins the shared SpriteRenderer on entities that (mis)configure
    // both; the plain animator then skips those entities.
    this.stepStateMachines();

    // 2d. SpriteAnimator playback, right after scripts so same-frame
    // playing/assetId mutations (including ctx.animate) take effect the
    // frame they're made.
    this.stepAnimators();

    // 3. Physics integration + collision detection/resolution.
    const contacts = this.stepPhysics();

    // 4. Collision events for new contact pairs.
    this.dispatchCollisionEvents(contacts);

    // 4b. Camera follow applies at end of frame, after physics.
    this.applyCameraFollow();

    // 4b2. Camera effects (shake/flash/fade/zoomPunch) step deterministically.
    this.cameraEffects.step(this.fixedDt, this._frame, (err) =>
      this.recordError({
        frame: this._frame,
        message: (err as Error)?.message ?? String(err),
        phase: 'cameraEffect',
      }),
    );

    // 4b3. SpriteEffects hit-flash decays deterministically — pure arithmetic,
    // no RNG: flashStrength counts down to 0 over flashDuration seconds.
    for (const entity of this.getEntities()) {
      if (!entity.enabled) continue;
      const fx = entity.components.SpriteEffects;
      if (!fx || fx.flashStrength <= 0) continue;
      fx.flashStrength = Math.max(0, fx.flashStrength - this.fixedDt / fx.flashDuration);
    }

    // 4c. Particle emitters step deterministically (per-emitter seeded RNG).
    this.stepParticles();

    // 5. End of frame bookkeeping.
    this.flushDestroyed();
    this.input.endFrame();
    // Pointer just-pressed edge is frame-scoped, like InputState.justPressed.
    this.pointerPressedEdge = false;
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
    this.invalidateEntitiesCache();
    this.scriptStates.clear();
    this.handles.clear();
    this.destroyedIds.clear();
    this.tilemapBoxCache.clear();
    this.tilemapGridHashCache.clear();
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
  // Music channel — one shared channel (session-scoped; see MusicChannelState)
  // ---------------------------------------------------------------------------

  /**
   * Play a track on the single music channel (by asset id or name). Replaces
   * any current track: a stop is recorded for it first (fadeOut = this
   * call's fadeIn). Never enters activePlaybacks, so stopAudio/stopAllAudio
   * never touch it. Null when the asset does not exist.
   */
  playMusic(
    assetRef: string,
    opts: { volume?: number; loop?: boolean; fadeIn?: number } = {},
  ): string | null {
    const asset = this.store.getAsset(assetRef);
    if (!asset) {
      this.recordLog('warn', `audio.playMusic: asset not found: ${assetRef}`);
      return null;
    }
    const fadeIn = opts.fadeIn ?? 0;
    const current = this.musicChannel.current;
    if (current) {
      this.recordMusicEvent(current.assetId, 'stop', current.handleId, 1, false, {
        fadeOut: fadeIn,
      });
    }
    const handleId = `mus_${++this.musicChannel.seq}`;
    this.musicChannel.current = { handleId, assetId: asset.id };
    const volume = Math.min(1, Math.max(0, opts.volume ?? 1));
    const loop = opts.loop ?? true;
    this.recordMusicEvent(asset.id, 'play', handleId, volume, loop, { fadeIn });
    return handleId;
  }

  /** Stop the current music track. No-op (no warn) when nothing is playing. */
  stopMusic(opts: { fadeOut?: number } = {}): void {
    const current = this.musicChannel.current;
    if (!current) return;
    this.musicChannel.current = null;
    this.recordMusicEvent(current.assetId, 'stop', current.handleId, 1, false, {
      fadeOut: opts.fadeOut ?? 0,
    });
  }

  /**
   * Change the current music track's volume. No-op when nothing is playing.
   * Fires onAudio directly with action 'music-volume' — never recorded in
   * audioEvents (it isn't a play/stop and shouldn't appear in run reports).
   */
  setMusicVolume(volume: number, opts: { fade?: number } = {}): void {
    const current = this.musicChannel.current;
    if (!current) return;
    const clamped = Math.min(1, Math.max(0, volume));
    this.options.onAudio?.({
      action: 'music-volume',
      handleId: current.handleId,
      assetId: current.assetId,
      volume: clamped,
      loop: false,
      music: true,
      fade: opts.fade ?? 0,
    });
  }

  private recordMusicEvent(
    assetId: string,
    action: 'play' | 'stop',
    handleId: string,
    volume: number,
    loop: boolean,
    fade: { fadeIn?: number } | { fadeOut?: number },
  ): void {
    this.audioEvents.push({ frame: this._frame, assetId, action, music: true });
    this.options.onAudio?.({ action, handleId, assetId, volume, loop, music: true, ...fade });
  }

  // ---------------------------------------------------------------------------
  // UI pointer input
  // ---------------------------------------------------------------------------

  /**
   * Feed a pointer event in screen coordinates (the buildSettings
   * width×height space). Interactive UIElement entities under the pointer
   * receive onUiEvent: enter/exit on hover changes, press on down, release
   * on up, and click when down and up landed on the same element. While a
   * press is held, every 'move' also dispatches {type:'drag'} to the
   * pressed entity (whether or not the pointer is still over it) — a
   * pressed UISlider additionally maps pointer x onto its track on both
   * 'down' and 'move', and a clicked UIToggle flips its value, each firing
   * an additional {type:'change', value} event. Hit-testing uses
   * `resolveUiPositions` so UILayout children are tested at their stacked
   * position, not their own bare anchor+offset. Used by playtests directly
   * and by the pixi host for real pointer events.
   */
  sendPointer(x: number, y: number, kind: PointerKind): void {
    if (this.stopped) return;
    // Record the pointer state read by ctx.input.pointer/pointerScreen/
    // pointerDown/pointerPressed. This is the single choke point for both real
    // browser pointer events and playtest steps, so scripts see identical
    // input in the editor and in headless runs.
    this.pointerScreenPos = { x, y };
    if (kind === 'down') {
      this.pointerButtonDown = true;
      this.pointerPressedEdge = true;
    } else if (kind === 'up') {
      this.pointerButtonDown = false;
    }
    const settings = this.store.project.buildSettings;
    const positions = resolveUiPositions(this.getEntities(), settings.width, settings.height);
    const target = this.hitTestUi(x, y, positions);
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
      if (target) {
        this.dispatchUiEvent(target, 'press', x, y);
        this.applySliderPointer(target, x, y, positions);
      }
    } else if (kind === 'up') {
      if (target) {
        this.dispatchUiEvent(target, 'release', x, y);
        if (this.uiPressedId === targetId) {
          this.dispatchUiEvent(target, 'click', x, y);
          this.applyToggleClick(target, x, y);
        }
      }
      this.uiPressedId = null;
    } else if (kind === 'move' && this.uiPressedId) {
      const pressed = this.getEntities().find((e) => e.id === this.uiPressedId);
      if (pressed) {
        this.dispatchUiEvent(pressed, 'drag', x, y);
        this.applySliderPointer(pressed, x, y, positions);
      }
    }
  }

  /** Latest pointer position in screen coordinates (buildSettings space). */
  get pointerScreen(): Vec2 {
    return { x: this.pointerScreenPos.x, y: this.pointerScreenPos.y };
  }

  /** Is the primary pointer button currently held? */
  get pointerDown(): boolean {
    return this.pointerButtonDown;
  }

  /** Did the primary pointer button go down this frame? (cleared at endFrame) */
  get pointerPressed(): boolean {
    return this.pointerPressedEdge;
  }

  /**
   * The pointer position un-projected into world space through the logical
   * camera (position + zoom), the inverse of the pixi renderer's world
   * transform. Uses the logical camera only — transient shake/zoomPunch
   * effects are ignored so aim never jitters with screen juice, matching the
   * camera the `ctx.camera` API already exposes to scripts. This is the
   * backing for `ctx.input.pointer()` (mouse aim).
   */
  pointerWorld(): Vec2 {
    const settings = this.store.project.buildSettings;
    const cam = this.camera;
    const zoom = cam.zoom !== 0 ? cam.zoom : 1;
    return {
      x: cam.position.x + (this.pointerScreenPos.x - settings.width / 2) / zoom,
      y: cam.position.y + (this.pointerScreenPos.y - settings.height / 2) / zoom,
    };
  }

  /** Topmost interactive UI element under a screen point (layer, then order), positioned via `resolveUiPositions`. */
  private hitTestUi(x: number, y: number, positions: Map<string, Vec2>): RuntimeEntity | undefined {
    let best: RuntimeEntity | undefined;
    let bestLayer = -Infinity;
    for (const entity of this.getEntities()) {
      if (!entity.enabled || !entity.components.UIElement?.interactive) continue;
      const pos = positions.get(entity.id);
      if (!pos) continue;
      const rect = rectAtPosition(entity.components, pos);
      if (!rect) continue;
      if (x < rect.minX || x > rect.maxX || y < rect.minY || y > rect.maxY) continue;
      const layer = Math.max(
        entity.components.SpriteRenderer?.layer ?? 0,
        entity.components.Text?.layer ?? 0,
        entity.components.UISlider?.layer ?? 0,
        entity.components.UIToggle?.layer ?? 0,
      );
      if (layer >= bestLayer) {
        bestLayer = layer;
        best = entity; // later entities win ties, matching render order
      }
    }
    return best;
  }

  private dispatchUiEvent(
    entity: RuntimeEntity,
    type: UiEvent['type'],
    x: number,
    y: number,
    value?: number | boolean,
  ): void {
    const event: UiEvent = { type, x, y };
    if (value !== undefined) event.value = value;
    this.callHook(entity, 'onUiEvent', event);
  }

  /**
   * Maps pointer x onto a pressed UISlider's track (min at the track's left
   * edge, max at its right edge), snapping to `step` when set and clamping
   * to [min, max]. Writes the new value and fires onUiEvent
   * {type:'change', value, x, y} only when the value actually changes —
   * called on both 'down' and 'move' while the slider is the pressed
   * entity. No-op for entities without a UISlider.
   */
  private applySliderPointer(
    entity: RuntimeEntity,
    x: number,
    y: number,
    positions: Map<string, Vec2>,
  ): void {
    const slider = entity.components.UISlider;
    if (!slider) return;
    const pos = positions.get(entity.id);
    if (!pos) return;
    // Matches rectAtPosition's slider branch: the track's drawn/hit width
    // scales with Transform.scale.x, so the drag mapping must too, or a
    // scaled slider's value would drift from where its handle is drawn.
    const sx = Math.abs(entity.components.Transform?.scale.x ?? 1);
    const width = slider.width * sx;
    const rectLeft = pos.x - width / 2;
    const t = width > 0 ? Math.min(1, Math.max(0, (x - rectLeft) / width)) : 0;
    let value = slider.min + t * (slider.max - slider.min);
    if (slider.step > 0) value = Math.round(value / slider.step) * slider.step;
    this.writeSliderValue(entity, slider, value, x, y);
  }

  /**
   * Clamps `value` to [slider.min, slider.max] and writes it, firing
   * onUiEvent {type:'change', value, x, y} only when it actually changes.
   * Shared by applySliderPointer (drag) and adjustUiFocus (keyboard/gamepad).
   */
  private writeSliderValue(
    entity: RuntimeEntity,
    slider: { min: number; max: number; value: number },
    value: number,
    x: number,
    y: number,
  ): void {
    const clamped = Math.min(slider.max, Math.max(slider.min, value));
    if (clamped === slider.value) return;
    slider.value = clamped;
    this.dispatchUiEvent(entity, 'change', x, y, clamped);
  }

  /** Flips a clicked UIToggle's value and fires onUiEvent {type:'change', value, x, y}. No-op for entities without a UIToggle. */
  private applyToggleClick(entity: RuntimeEntity, x: number, y: number): void {
    const toggle = entity.components.UIToggle;
    if (!toggle) return;
    toggle.value = !toggle.value;
    this.dispatchUiEvent(entity, 'change', x, y, toggle.value);
  }

  // ---------------------------------------------------------------------------
  // UI focus & spatial navigation (ctx.ui backing)
  // ---------------------------------------------------------------------------

  /** Resolved screen position of a live entity, or {0,0} when it has none (no UIElement, or not yet placed). */
  private resolvedUiPosition(entity: RuntimeEntity): Vec2 {
    const settings = this.store.project.buildSettings;
    const positions = resolveUiPositions(this.getEntities(), settings.width, settings.height);
    return positions.get(entity.id) ?? { x: 0, y: 0 };
  }

  /** Every enabled, focusable UIElement entity with a resolved screen position, in scene entity order. */
  private focusCandidates(): { entity: RuntimeEntity; pos: Vec2 }[] {
    const settings = this.store.project.buildSettings;
    const live = this.getEntities();
    const positions = resolveUiPositions(live, settings.width, settings.height);
    const out: { entity: RuntimeEntity; pos: Vec2 }[] = [];
    for (const entity of live) {
      if (!entity.enabled || !entity.components.UIElement?.focusable) continue;
      const pos = positions.get(entity.id);
      if (!pos) continue;
      out.push({ entity, pos });
    }
    return out;
  }

  /** Fires onUiEvent {type:'blur'} on the currently focused entity (if any) and clears focus. */
  private blurUiFocus(): void {
    if (!this.uiFocusId) return;
    const prev = this.getEntities().find((e) => e.id === this.uiFocusId);
    this.uiFocusId = null;
    if (prev) {
      const pos = this.resolvedUiPosition(prev);
      this.dispatchUiEvent(prev, 'blur', pos.x, pos.y);
    }
  }

  /**
   * ctx.ui.focus backing: set the UI focus to an entity by id/name (firing
   * blur on the previous focus and focus on the new one), or clear it with
   * null. Warns (no state change) when the target is unknown, disabled, or
   * its UIElement.focusable is not true — a disabled entity is treated
   * exactly like a not-focusable one so ctx.ui.focus can never reach a
   * widget that moveUiFocus's candidate set (focusCandidates) excludes.
   * Focusing the already-focused entity is a no-op (no repeat events).
   */
  focusUi(idOrName: string | null): void {
    if (idOrName === null) {
      this.blurUiFocus();
      return;
    }
    const target = this.find(idOrName);
    if (!target || !target.enabled || !target.components.UIElement?.focusable) {
      this.recordLog('warn', `ui.focus: entity not found or not focusable: ${idOrName}`);
      return;
    }
    if (this.uiFocusId === target.id) return;
    this.blurUiFocus();
    this.uiFocusId = target.id;
    const pos = this.resolvedUiPosition(target);
    this.dispatchUiEvent(target, 'focus', pos.x, pos.y);
  }

  /** ctx.ui.getFocused backing: the focused entity's id, or null. */
  getUiFocused(): string | null {
    return this.uiFocusId;
  }

  /**
   * ctx.ui.moveFocus backing: among focusable UIElement entities with a
   * resolved position, picks the nearest one strictly in `direction`'s
   * half-plane (dot product of the offset with the direction unit vector
   * > 0) from the current focus position — or from the top-left-most
   * candidate's position (min y, then min x) when nothing is focused.
   * Euclidean distance; ties broken by scene entity order (the earlier
   * candidate is kept since only a strictly smaller distance replaces it).
   * No wrap: no-op when nothing lies in that direction.
   */
  moveUiFocus(direction: 'up' | 'down' | 'left' | 'right'): void {
    const candidates = this.focusCandidates();
    if (candidates.length === 0) return;

    let fromPos: Vec2;
    const current = this.uiFocusId
      ? candidates.find((c) => c.entity.id === this.uiFocusId)
      : undefined;
    if (current) {
      fromPos = current.pos;
    } else {
      fromPos = candidates.reduce((best, c) =>
        c.pos.y < best.pos.y || (c.pos.y === best.pos.y && c.pos.x < best.pos.x) ? c : best,
      ).pos;
    }

    const dir = DIRECTION_VECTORS[direction];
    let best: { entity: RuntimeEntity; pos: Vec2 } | null = null;
    let bestDist = Infinity;
    for (const c of candidates) {
      const dx = c.pos.x - fromPos.x;
      const dy = c.pos.y - fromPos.y;
      const dot = dx * dir.x + dy * dir.y;
      if (dot <= 0) continue;
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    if (!best) return;
    this.focusUi(best.entity.id);
  }

  /**
   * ctx.ui.activate backing: synthesizes a press+release (a click) at the
   * focused element's center, through the normal sendPointer path — so
   * slider/toggle behavior fires exactly as it would from a real click.
   * Warns and skips the click when the focused entity is not interactive
   * (sendPointer's hit test requires interactive=true, so the click would
   * otherwise silently dispatch nothing). No-op when nothing is focused
   * or it has no resolved position.
   */
  activateUiFocus(): void {
    if (!this.uiFocusId) return;
    const target = this.getEntities().find((e) => e.id === this.uiFocusId);
    if (!target) return;
    if (!target.components.UIElement?.interactive) {
      this.recordLog('warn', `ui.activate: focused entity "${target.name}" is not interactive`);
      return;
    }
    const settings = this.store.project.buildSettings;
    const positions = resolveUiPositions(this.getEntities(), settings.width, settings.height);
    const pos = positions.get(target.id);
    if (!pos) return;
    this.sendPointer(pos.x, pos.y, 'down');
    this.sendPointer(pos.x, pos.y, 'up');
  }

  /**
   * ctx.ui.adjust backing: for a focused UISlider, value +=
   * delta * (step || (max-min)/10), clamped to [min, max], firing
   * onUiEvent {type:'change', value} only when it actually changes.
   * No-op when nothing is focused or the focused entity has no UISlider.
   */
  adjustUiFocus(delta: number): void {
    if (!this.uiFocusId) return;
    const target = this.getEntities().find((e) => e.id === this.uiFocusId);
    if (!target) return;
    const slider = target.components.UISlider;
    if (!slider) return;
    const step = slider.step || (slider.max - slider.min) / 10;
    const value = slider.value + delta * step;
    const pos = this.resolvedUiPosition(target);
    this.writeSliderValue(target, slider, value, pos.x, pos.y);
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

  /**
   * Preload every state machine asset payload (tiny JSON, like animations) so
   * the AnimationStateMachine stepper and ctx.animator can resolve them
   * synchronously at play time. In exports the player's loadStore materializes
   * .asm.json files into the store fs (assetNeedsRawContent includes
   * 'stateMachine'), same as animations/prefabs.
   */
  private async loadStateMachines(): Promise<void> {
    for (const asset of this.store.assets.assets) {
      if (asset.type !== 'stateMachine') continue;
      try {
        const raw = await this.store.fs.readFile(joinPath(this.store.root, asset.path));
        this.stateMachineAssets.set(asset.id, StateMachineDataSchema.parse(JSON.parse(raw)));
      } catch (err) {
        this.recordError({
          frame: this._frame,
          message: `Failed to load state machine asset "${asset.name}": ${(err as Error).message}`,
          phase: 'load',
        });
      }
    }
  }

  /**
   * Preload every prefab asset payload in the project (tiny JSON, like
   * animations) so ctx.scene.spawnPrefab can instantiate them synchronously,
   * with zero I/O, at play time. Reads raw content straight off the store's
   * fs — in exports the player's loadStore materializes prefab files into
   * that fs (see player/index.ts + loading.ts assetNeedsRawContent).
   */
  private async loadPrefabs(): Promise<void> {
    for (const asset of this.store.assets.assets) {
      if (asset.type !== 'prefab') continue;
      try {
        const raw = await this.store.fs.readFile(joinPath(this.store.root, asset.path));
        this.prefabAssets.set(asset.id, PrefabDataSchema.parse(JSON.parse(raw)));
      } catch (err) {
        this.recordError({
          frame: this._frame,
          message: `Failed to load prefab asset "${asset.name}": ${(err as Error).message}`,
          phase: 'load',
        });
      }
    }
  }

  /**
   * Spawn a prefab asset (resolved by name or id) as a live entity subtree:
   * every prefab entity becomes a fresh RuntimeEntity with a new id, the
   * parent/child links are preserved AMONG the spawned set, `opts.position`
   * overrides the root's Transform position and `opts.name` its name. Entities
   * are inserted in payload order (root first) and each is registered for its
   * Script, exactly like the single-entity spawn(). Returns the root handle,
   * or null (with a warn log) when the prefab is unknown — matching spawn()'s
   * tolerance for unknown inputs. No prefab marker is attached at runtime.
   *
   * Deterministic: ids come from generateId (a Math.random-based id, never
   * the seeded ctx.random stream), so spawning consumes nothing from the RNG.
   */
  private spawnPrefab(
    name: string,
    opts: { position?: Vec2; name?: string } = {},
  ): EntityHandle | null {
    const asset = this.store.getAsset(name);
    const data =
      asset && asset.type === 'prefab' ? this.prefabAssets.get(asset.id) : undefined;
    if (!data) {
      this.recordLog('warn', `spawnPrefab: unknown prefab "${name}"`);
      return null;
    }
    // instantiatePrefabData remaps local pfe_* ids to fresh ent_* ids and
    // rewrites parentId to match; instantiate() then turns each schema Entity
    // into a RuntimeEntity (deep-cloned live components) just like an authored
    // scene entity, so the spawned subtree follows the normal entity lifecycle.
    const instances = instantiatePrefabData(data, {
      position: opts.position,
      name: opts.name,
    });
    const entities = instances.map((authored) => this.instantiate(authored));
    for (const entity of entities) this.entities.push(entity);
    this.invalidateEntitiesCache();
    for (const entity of entities) this.registerScript(entity);
    return this.handleFor(entities[0]);
  }

  /** Advance every live enabled SpriteAnimator one fixed step; reap destroyed entities. */
  private stepAnimators(): void {
    const liveIds = new Set<string>();
    for (const entity of this.getEntities()) {
      const animator = entity.components.SpriteAnimator;
      if (!animator) continue;
      // An AnimationStateMachine on the same entity owns the SpriteRenderer
      // (stepped in stepStateMachines); the plain animator yields to it.
      if (entity.components.AnimationStateMachine) continue;
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
  // Animation state machines
  // ---------------------------------------------------------------------------

  /** Get or lazily (re)create the SmState for an entity's AnimationStateMachine. */
  private getOrCreateSmState(
    entity: RuntimeEntity,
    component: AnimationStateMachineComponent,
    asset: StateMachineData,
  ): SmState {
    let state = this.smStates.get(entity.id);
    // A changed assetId means a different machine — rebuild from the new asset.
    if (!state || state.assetId !== component.assetId) {
      state = createSmState(asset, component.assetId);
      this.smStates.set(entity.id, state);
    }
    return state;
  }

  /**
   * Advance every live enabled AnimationStateMachine one fixed step, writing
   * the current frame into the sibling SpriteRenderer; reap destroyed entities.
   * Runs before stepAnimators so a machine wins the renderer when both
   * components are present (warned once per entity).
   */
  private stepStateMachines(): void {
    const liveIds = new Set<string>();
    for (const entity of this.getEntities()) {
      const component = entity.components.AnimationStateMachine;
      if (!component) continue;
      // Disabled entities keep their state (frozen); only destruction reaps it.
      liveIds.add(entity.id);
      if (!entity.enabled) continue;
      if (entity.components.SpriteAnimator && !this.warnedDualAnimator.has(entity.id)) {
        this.warnedDualAnimator.add(entity.id);
        this.recordLog(
          'warn',
          `AnimationStateMachine on "${entity.name}" overrides its SpriteAnimator (state machine wins the SpriteRenderer)`,
        );
      }
      const renderer = entity.components.SpriteRenderer;
      if (!renderer) continue; // no renderer to write frames into: skip silently
      const asset = component.assetId ? this.stateMachineAssets.get(component.assetId) : undefined;
      if (!asset) continue; // unknown/empty assetId: skip silently
      const state = this.getOrCreateSmState(entity, component, asset);
      const r = stepStateMachine(state, component, asset, this.animationAssets, this.fixedDt);
      if (r !== null) {
        renderer.assetId = r.assetId;
        renderer.frame = r.frame;
      }
    }
    for (const id of [...this.smStates.keys()]) {
      if (!liveIds.has(id)) this.smStates.delete(id);
    }
    for (const id of [...this.warnedDualAnimator]) {
      if (!liveIds.has(id)) this.warnedDualAnimator.delete(id);
    }
  }

  /**
   * Current state name of an entity's AnimationStateMachine (by id or name),
   * or null when the entity has no machine (or none has run yet). Read-only
   * accessor for hosts and the script bridge.
   */
  getStateMachineState(entityIdOrName: string): string | null {
    const entity = this.find(entityIdOrName);
    if (!entity) return null;
    return this.smStates.get(entity.id)?.current ?? null;
  }

  /**
   * Resolve an entity's AnimationStateMachine for a ctx.animator call. Throws
   * (surfacing as a script error with line info) when the entity, its
   * component, or its asset is missing.
   */
  private smForScript(
    entityRef: string,
    method: string,
  ): { asset: StateMachineData; state: SmState } {
    const entity = this.find(entityRef);
    if (!entity) throw new Error(`ctx.animator.${method}: entity not found "${entityRef}"`);
    const component = entity.components.AnimationStateMachine;
    if (!component) {
      throw new Error(`ctx.animator.${method}: no AnimationStateMachine on "${entity.name}"`);
    }
    const asset = component.assetId ? this.stateMachineAssets.get(component.assetId) : undefined;
    if (!asset) {
      throw new Error(
        `ctx.animator.${method}: unknown state machine asset "${component.assetId}" on "${entity.name}"`,
      );
    }
    return { asset, state: this.getOrCreateSmState(entity, component, asset) };
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
    // PHASE 1 (async): read every source up front. `require` is synchronous
    // while store.readScript is async, so compilation (phase 2) must resolve
    // requires purely from this map and never touch I/O.
    for (const path of paths) {
      try {
        this.scriptSources.set(path, await this.store.readScript(path));
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
    this.moduleRegistry = new ScriptModuleRegistry(this.scriptSources);
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
    if (luaEngine) {
      // Bind require to THIS runtime's registry/sources — on BOTH engine
      // paths. A provided (GameSession) engine outlives scene switches while
      // the registry is per scene, so every scene load must rebind here;
      // binding only at engine creation is exactly the bug that made
      // `require` work in standalone SceneRuntimes (unit tests) but fail in
      // every real host (player, playtest, editor preview all share one
      // engine through GameSession).
      luaEngine.setModuleResolver({
        // Lua resolves requires INSIDE the VM (it never calls
        // registry.load), so this callback is the ONLY place the registry
        // learns about Lua require edges — skip the recordEdge and hot
        // reload never sees Lua dependents (the stale-code bug this whole
        // design exists to prevent). During a reload staging pass the edge
        // goes to the staging sink instead of the live graph.
        resolveModule: (spec, fromPath) => {
          const registry = this.moduleRegistry;
          if (!registry) throw new Error('script module registry unavailable');
          const resolved = registry.resolve(spec, fromPath);
          (this.moduleEdgeSink ?? registry).recordEdge(resolved, fromPath);
          return resolved;
        },
        readModule: (path) => {
          const source = this.scriptSources.get(path);
          if (source === undefined) throw new Error(`module not found: ${path}`);
          return source;
        },
      });
      // Drop the shared VM's memo for every path this scene is loading. On a
      // shared engine a previous scene already ran these bodies, so phase 2
      // below would be all memo hits: requires would never fire and THIS
      // scene's registry would record no dependents edges — hot-reloading a
      // library after a scene switch would then recompile nobody (stale
      // code). Re-running bodies once per scene load also matches JS module
      // semantics exactly (the JS registry is rebuilt per scene). On a
      // fresh owned engine this is a no-op.
      for (const path of paths) {
        if (isLuaPath(path)) luaEngine.invalidateModule(path);
      }
    }
    // PHASE 2 (sync): obtain hooks THROUGH the registry so a module body
    // runs exactly once per session whether it is reached eagerly here or by
    // a require — compiling directly would run a library's body twice, a
    // silent determinism break.
    for (const path of paths) {
      if (!this.scriptSources.has(path)) continue; // read failed above; error already recorded
      try {
        this.scriptModules.set(
          path,
          this.moduleHooks(path, this.moduleRegistry, this.scriptSources),
        );
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

  /**
   * The single compile path for both eager loads and hot-reload staging:
   * obtain a script's hooks through `registry` (memoized — the module body
   * runs at most once per registry), resolving its requires from `sources`.
   * JS requires recurse through registry.load (which records the dependents
   * edge); Lua requires resolve inside the VM via the engine's callbacks.
   */
  private moduleHooks(
    path: string,
    registry: ScriptModuleRegistry,
    sources: Map<string, string>,
  ): ScriptHooks {
    const compile = (p: string): unknown => {
      const source = sources.get(p);
      if (source === undefined) throw new Error(`module not found: ${p}`);
      if (isLuaPath(p)) {
        const engine = this.options.luaEngine ?? this.ownedLuaEngine;
        if (!engine) throw new Error('Lua engine unavailable');
        return engine.compile(p, source);
      }
      return compileScript(source, (spec) =>
        registry.load(registry.resolve(spec, p), compile, p),
      );
    };
    return registry.load(path, compile) as ScriptHooks;
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
        isDown: (action) => {
          runtime.readInputNames.add(action);
          return runtime.input.isDown(action);
        },
        justPressed: (action) => {
          runtime.readInputNames.add(action);
          return runtime.input.justPressed(action);
        },
        axis: (name) => {
          runtime.readInputNames.add(name);
          return runtime.input.axisValue(name);
        },
        pointer: () => runtime.pointerWorld(),
        pointerScreen: () => runtime.pointerScreen,
        pointerDown: () => runtime.pointerDown,
        pointerPressed: () => runtime.pointerPressed,
      },
      scene: {
        find: (idOrName) => {
          const found = runtime.find(idOrName);
          return found ? runtime.handleFor(found) : null;
        },
        findByTag: (tag) => runtime.findByTag(tag).map((e) => runtime.handleFor(e)),
        spawn: (def) => runtime.spawn(def),
        spawnPrefab: (name, opts) => runtime.spawnPrefab(name, opts),
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
        playMusic: (assetRef, opts) => runtime.playMusic(assetRef, opts),
        stopMusic: (opts) => runtime.stopMusic(opts),
        setMusicVolume: (volume, opts) => runtime.setMusicVolume(volume, opts),
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
      animator: {
        setParam: (entityRef, name, value) => {
          const { asset, state } = runtime.smForScript(entityRef, 'setParam');
          setSmParam(state, asset, name, value);
        },
        getParam: (entityRef, name) => {
          const { asset, state } = runtime.smForScript(entityRef, 'getParam');
          return getSmParam(state, asset, name);
        },
        fire: (entityRef, name) => {
          const { asset, state } = runtime.smForScript(entityRef, 'fire');
          fireSmTrigger(state, asset, name);
        },
        state: (entityRef) => runtime.smForScript(entityRef, 'state').state.current,
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
        shake: (intensity, seconds, opts) => runtime.cameraEffects.shake(intensity, seconds, opts),
        flash: (color, seconds) => runtime.cameraEffects.flash(color, seconds),
        fade: (alpha, seconds, opts) => runtime.cameraEffects.fade(alpha, seconds, opts),
        zoomPunch: (scale, seconds) => runtime.cameraEffects.zoomPunch(scale, seconds),
      },
      effects: {
        flash: (color, seconds) => {
          const fx =
            entity.components.SpriteEffects ??
            (entity.components.SpriteEffects = createComponent('SpriteEffects'));
          const duration = Math.min(10, Math.max(0.01, seconds ?? 0.15));
          fx.flashColor = color ?? '#ffffff';
          fx.flashStrength = 1;
          fx.flashDuration = duration;
        },
      },
      events: {
        emit: (name, data) => runtime.emitEvent(name, data),
        on: (name, fn) => runtime.eventBus.on(entity.id, name, fn),
        off: (id) => runtime.eventBus.off(id),
      },
      ui: {
        focus: (idOrName) => runtime.focusUi(idOrName),
        getFocused: () => runtime.getUiFocused(),
        moveFocus: (direction) => runtime.moveUiFocus(direction),
        activate: () => runtime.activateUiFocus(),
        adjust: (delta) => runtime.adjustUiFocus(delta),
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
    this.invalidateEntitiesCache();
    this.registerScript(entity);
    return this.handleFor(entity);
  }

  private destroyEntity(id: string): void {
    if (this.entities.some((e) => e.id === id)) {
      this.destroyedIds.add(id);
      this.invalidateEntitiesCache();
    }
  }

  private flushDestroyed(): void {
    if (this.destroyedIds.size === 0) return;
    if (this.uiFocusId && this.destroyedIds.has(this.uiFocusId)) {
      const focused = this.entities.find((e) => e.id === this.uiFocusId);
      this.uiFocusId = null;
      // Unlike a normal blur (which carries the entity's resolved screen
      // position), this blur uses (0,0): the entity is already excluded
      // from getEntities() here, so resolveUiPositions can't place it.
      if (focused) this.dispatchUiEvent(focused, 'blur', 0, 0);
    }
    this.entities = this.entities.filter((e) => !this.destroyedIds.has(e.id));
    for (const id of this.destroyedIds) {
      this.scriptStates.delete(id);
      this.handles.delete(id);
      this.eventBus.removeOwner(id);
      this.tilemapBoxCache.delete(id);
      this.tilemapGridHashCache.delete(id);
    }
    this.destroyedIds.clear();
    this.invalidateEntitiesCache();
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
      line: extractScriptErrorLine(state.path, err),
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

  /**
   * Static boxes for a solid Tilemap entity, cached per entity and
   * recomputed only when its cache key changes (grid content, tileSize,
   * solid, or world position — see `tilemapBoxCache`'s doc comment).
   * Obstacle shapes built from these boxes are never mutated by physics
   * (translateShape only moves movers, never static obstacles), so sharing
   * the same Box objects across frames is safe.
   */
  private getTilemapBoxes(entity: RuntimeEntity, tilemap: TilemapComponent): Box[] {
    const worldPos = this.getWorldPosition(entity);
    let gridHashEntry = this.tilemapGridHashCache.get(entity.id);
    if (!gridHashEntry || gridHashEntry.ref !== tilemap.grid) {
      gridHashEntry = { ref: tilemap.grid, hash: tilemap.grid.join('\n') };
      this.tilemapGridHashCache.set(entity.id, gridHashEntry);
    }
    // Cache key includes grid.length to detect length-changing mutations (push/splice/pop).
    // **Contract**: cached fields must be REPLACED (`tilemap.grid = [...]`), never mutated
    // in place. In-place same-length writes (e.g. `grid[0] = '####'`) are not detected by
    // this cache and will silently keep stale collider boxes. Use whole-array assignment to
    // ensure changes take effect the same frame.
    const key = `${gridHashEntry.hash}|${tilemap.grid.length}|${tilemap.tileSize}|${tilemap.solid}|${worldPos.x}|${worldPos.y}`;
    const cached = this.tilemapBoxCache.get(entity.id);
    if (cached && cached.key === key) return cached.boxes;
    const boxes = tilemapBoxes(tilemap, worldPos);
    this.tilemapBoxCache.set(entity.id, { key, boxes });
    return boxes;
  }

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
      /** Position in `movers` — indexes the broadphase displacement bookkeeping. */
      index: number;
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
            index: movers.length,
          });
        }
      }
      const tilemap = entity.components.Tilemap;
      if (tilemap && tilemap.solid) {
        for (const box of this.getTilemapBoxes(entity, tilemap)) {
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

    // -----------------------------------------------------------------------
    // Broadphase: spatial hashes prune far-apart pairs; the pair
    // loops below are otherwise byte-identical to the naive O(n²) loops.
    // query() returns candidates ascending, so per mover the surviving
    // obstacles run in collection-index order and mover×mover pairs run in
    // ascending (i, j), j > i — the exact naive visit order.
    //
    // applyPush mutates mover positions MID-LOOP (later pairs see pushed
    // positions), so a candidate list fetched at the top of a mover's sweep
    // can go stale. Every query uses the mover's CURRENT AABB inflated by
    // cellSize, and the loops maintain an exact invariant: before each pair
    // test, if the mover's accumulated push displacement since its query
    // (plus, for mover×mover, the largest displacement of any mover since
    // the mover hash was built) could exceed that inflation, the candidates
    // are refetched (and the mover hash rebuilt) at current positions,
    // resuming at the next unprocessed index — candidate lists are
    // ascending, so the visit order of surviving pairs is unchanged. A pair
    // can only be missed if combined staleness exceeds the inflation, which
    // the refresh rule makes impossible: pruning stays exact no matter how
    // violent the mid-loop displacement is. Shape extents never change
    // within a frame (translateShape only moves), so cellSize stays valid
    // all step.
    // -----------------------------------------------------------------------
    const obstacleAabbs: Aabb[] = [];
    for (const o of obstacles) obstacleAabbs.push(shapeAabb(o.shape));
    const allAabbs: Aabb[] = [];
    for (const m of movers) allAabbs.push(shapeAabb(m.shape));
    for (const a of obstacleAabbs) allAabbs.push(a);
    const cellSize = chooseCellSize(allAabbs);
    const queryAabb: Aabb = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const setQueryFromBox = (b: Box): void => {
      queryAabb.minX = b.cx - b.hw - cellSize;
      queryAabb.minY = b.cy - b.hh - cellSize;
      queryAabb.maxX = b.cx + b.hw + cellSize;
      queryAabb.maxY = b.cy + b.hh + cellSize;
    };
    // TEST-ONLY fallback to the naive full-pair sweep (see broadphase.ts).
    const forceNaive = broadphaseTestHooks.forceNaive;
    const allObstacleIndices = forceNaive ? obstacles.map((_, i) => i) : null;
    const allMoverIndices = forceNaive ? movers.map((_, i) => i) : null;

    // Cumulative |dx|+|dy| applyPush displacement per mover this step (L1
    // bounds L∞, so comparing it against the cellSize inflation is
    // conservative), plus per-mover snapshots at mover-hash build time and
    // the max staleness any mover has accumulated since that build.
    const moverDisp: number[] = new Array<number>(movers.length).fill(0);
    const moverDispAtHashBuild: number[] = new Array<number>(movers.length).fill(0);
    let maxMoverStaleness = 0;

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
      const moved = Math.abs(nx * amount) + Math.abs(ny * amount);
      moverDisp[mover.index] += moved;
      const staleness = moverDisp[mover.index] - moverDispAtHashBuild[mover.index];
      if (staleness > maxMoverStaleness) maxMoverStaleness = staleness;
      const body = mover.entity.components.PhysicsBody;
      if (body) {
        const e = Math.max(body.restitution, other.restitution);
        const mu = Math.max(body.friction, other.friction);
        resolveContactVelocity(body.velocity, nx, ny, e, mu, this.fixedDt);
      }
    };

    this.obstacleBroadphase.reset(cellSize);
    for (let i = 0; i < obstacles.length; i++) {
      this.obstacleBroadphase.insert(i, obstacleAabbs[i]);
    }

    // Movers vs static obstacles (dynamic movers get pushed out).
    for (const mover of movers) {
      setQueryFromBox(mover.shape.box);
      let candidates = allObstacleIndices ?? this.obstacleBroadphase.query(queryAabb);
      let dispAtQuery = moverDisp[mover.index];
      let lastProcessed = -1;
      let p = 0;
      // The staleness check runs before the bounds check on purpose: a push
      // from the FINAL candidate can eject the mover toward obstacles past
      // the end of the list, so exhaustion alone must not end the sweep.
      for (;;) {
        if (!allObstacleIndices && moverDisp[mover.index] - dispAtQuery > cellSize) {
          // Pushes since the query may have moved this mover past the
          // inflation slack — refetch at the current position and resume
          // after the last processed index (obstacles never move, so the
          // hash itself stays valid).
          setQueryFromBox(mover.shape.box);
          candidates = this.obstacleBroadphase.query(queryAabb);
          dispAtQuery = moverDisp[mover.index];
          p = 0;
          while (p < candidates.length && candidates[p] <= lastProcessed) p++;
        }
        if (p >= candidates.length) break;
        const obstacleIndex = candidates[p];
        lastProcessed = obstacleIndex;
        p++;
        const obstacle = obstacles[obstacleIndex];
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

    // Mover vs mover. The mover hash is built AFTER obstacle resolution so
    // it indexes current (post-obstacle-push) positions. Unlike obstacles,
    // BOTH sides of a pair move mid-loop: `a` drifts from its query position
    // and any `j` may drift from its hash-insert position (pairs (k, j),
    // k < i, push j too). A pair test is covered while a's
    // displacement-since-query plus the largest any-mover
    // displacement-since-hash-build stays within the cellSize inflation;
    // past that, rebuild the hash and requery at current positions, resuming
    // after the last processed j (ascending order preserved).
    const rebuildMoverHash = (): void => {
      this.moverBroadphase.reset(cellSize);
      for (let i = 0; i < movers.length; i++) {
        this.moverBroadphase.insert(i, shapeAabb(movers[i].shape));
        moverDispAtHashBuild[i] = moverDisp[i];
      }
      maxMoverStaleness = 0;
    };
    rebuildMoverHash();
    for (let i = 0; i < movers.length; i++) {
      const a = movers[i];
      setQueryFromBox(a.shape.box);
      let candidates = allMoverIndices ?? this.moverBroadphase.query(queryAabb);
      let dispAtQuery = moverDisp[i];
      let lastJ = i; // only j > i pairs run, so i doubles as "last processed"
      let p = 0;
      // As above: check staleness before the bounds check so a push from
      // the final candidate still triggers a rebuild + requery.
      for (;;) {
        if (
          !allMoverIndices &&
          moverDisp[i] - dispAtQuery + maxMoverStaleness > cellSize
        ) {
          rebuildMoverHash();
          setQueryFromBox(a.shape.box);
          candidates = this.moverBroadphase.query(queryAabb);
          dispAtQuery = moverDisp[i];
          p = 0;
          while (p < candidates.length && candidates[p] <= lastJ) p++;
        }
        if (p >= candidates.length) break;
        const j = candidates[p];
        p++;
        if (j <= lastJ) continue;
        lastJ = j;
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
