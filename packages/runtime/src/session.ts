/**
 * GameSession — cross-scene orchestration on top of SceneRuntime.
 *
 * SceneRuntime stays single-scene; GameSession owns everything that must
 * survive a scene switch: the seeded RNG stream, session storage
 * (ctx.save/load), the shared Lua engine, the monotonic frame counter, and
 * aggregated logs/errors/audio/scene events. All hosts (editor preview,
 * playtests, exported player) drive a GameSession.
 */
import type { ProjectStore } from '@hearth/core';
import type { CameraEffectRecord } from './cameraEffects.js';
import type { GameEventRecord } from './events.js';
import { LuaScriptEngine, isLuaPath } from './lua.js';
import {
  SceneRuntime,
  type AudioEvent,
  type AudioPlaybackEvent,
  type MusicChannelState,
  type RuntimeError,
  type RuntimeLog,
} from './runtime.js';
import { createRng } from './stdlib.js';

/**
 * Key/value persistence behind ctx.save/load. MemorySessionStorage for
 * headless runs; browsers use a localStorage-backed adapter. `keys` is
 * optional but required for ctx.clearSave() with no argument.
 */
export interface SessionStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** Enumerate stored keys (enables ctx.clearSave() with no key). */
  keys?(): string[];
}

/** Map-backed SessionStorage (default; nothing persists past the session). */
export class MemorySessionStorage implements SessionStorage {
  private map = new Map<string, string>();

  get(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  set(key: string, value: string): void {
    this.map.set(key, value);
  }

  remove(key: string): void {
    this.map.delete(key);
  }

  keys(): string[] {
    return [...this.map.keys()];
  }
}

/** One completed scene switch, in session-monotonic frames. */
export interface SceneEvent {
  frame: number;
  from: string | null;
  to: string;
}

/** Cap on GameSession.events (mirrors SceneRuntime's MAX_RECORDED_EVENTS). */
const MAX_RECORDED_EVENTS = 200;

export interface GameSessionOptions {
  /** Scene id or name to start in. Default: project.initialScene ?? first scene. */
  scene?: string;
  /** Seed for the single RNG stream shared across scenes. Default 0. */
  seed?: number;
  /** Persistence behind ctx.save/load. Default MemorySessionStorage. */
  storage?: SessionStorage;
  onLog?(e: RuntimeLog): void;
  onError?(e: RuntimeError): void;
  onAudio?(e: AudioPlaybackEvent): void;
  /** Fired after a scene switch completes (new runtime is live). */
  onSceneChange?(e: SceneEvent): void;
  /** Fired for every ctx.events.emit across every scene this session runs. */
  onGameEvent?(record: GameEventRecord): void;
  maxLogs?: number;
}

export class GameSession {
  /** Aggregated across all scenes this session has run. */
  readonly logs: RuntimeLog[] = [];
  readonly errors: RuntimeError[] = [];
  readonly audioEvents: AudioEvent[] = [];
  readonly sceneEvents: SceneEvent[] = [];
  /**
   * ctx.camera.shake/flash/fade/zoomPunch calls across every scene this
   * session runs, capped at MAX_RECORDED_EVENTS like `events`.
   */
  readonly cameraEffects: CameraEffectRecord[] = [];
  cameraEffectsTruncated = false;
  /** ctx.events.emit records across every scene, session-monotonic frames, capped at 200. */
  readonly events: GameEventRecord[] = [];
  eventsTruncated = false;
  /** Exact per-name totals across every scene switch — never truncated. */
  readonly eventCounts = new Map<string, number>();

  private _runtime!: SceneRuntime;
  private _currentSceneId = '';
  private _switching = false;
  private switchPromise: Promise<void> | null = null;
  private destroyed = false;
  private luaEngine: LuaScriptEngine | null = null;
  private readonly rng: () => number;
  private readonly storage: SessionStorage;
  private readonly maxLogs: number;
  /** One music channel per session, shared across every scene so playMusic survives switches. */
  private readonly musicChannel: MusicChannelState = { current: null, seq: 0 };

  private constructor(
    private readonly store: ProjectStore,
    private readonly opts: GameSessionOptions,
  ) {
    this.rng = createRng(opts.seed ?? 0);
    this.storage = opts.storage ?? new MemorySessionStorage();
    this.maxLogs = opts.maxLogs ?? 1000;
  }

  static async create(store: ProjectStore, opts: GameSessionOptions = {}): Promise<GameSession> {
    const session = new GameSession(store, opts);
    const requested = opts.scene ?? store.project.initialScene ?? store.project.scenes[0]?.id;
    if (!requested) throw new Error('GameSession: project has no scenes');
    const scene = store.getScene(requested);
    if (!scene) throw new Error(`Scene not found: ${requested}`);
    await session.startScene(scene.id, 0);
    return session;
  }

  /** The live runtime for the current scene. Replaced on scene switch. */
  get runtime(): SceneRuntime {
    return this._runtime;
  }

  get currentSceneId(): string {
    return this._currentSceneId;
  }

  /** Monotonic across scene switches. */
  get frame(): number {
    return this._runtime.frame;
  }

  get elapsed(): number {
    return this._runtime.elapsed;
  }

  /** True while an async scene switch is in flight (hosts skip stepping). */
  get switching(): boolean {
    return this._switching;
  }

  /**
   * Step one fixed frame. If scripts requested a scene change this frame,
   * kicks off the async swap; while `switching` is true further step()
   * calls are no-ops. Await stepAsync() instead when determinism matters.
   */
  step(): void {
    if (this.destroyed || this._switching) return;
    this._runtime.step();
    void this.maybeBeginSwitch();
  }

  /** Step one frame and await any pending scene swap (deterministic). */
  async stepAsync(): Promise<void> {
    if (this.destroyed) return;
    if (this.switchPromise) await this.switchPromise;
    if (this.destroyed) return;
    this._runtime.step();
    const swap = this.maybeBeginSwitch();
    if (swap) await swap;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this._runtime.destroy();
    this.luaEngine?.dispose();
    this.luaEngine = null;
  }

  // ---------------------------------------------------------------------------

  private maybeBeginSwitch(): Promise<void> | null {
    const to = this._runtime.pendingScene;
    if (!to) return null;
    this._switching = true;
    const promise = this.performSwitch(to).finally(() => {
      this._switching = false;
      this.switchPromise = null;
    });
    this.switchPromise = promise;
    return promise;
  }

  private async performSwitch(to: string): Promise<void> {
    const old = this._runtime;
    const from = this._currentSceneId;
    const frame = old.frame;
    // Persist only the fade overlay level across the switch — transient
    // shake/flash/zoomPunch never carry to the new scene's runtime.
    // persistentOverlay (not .overlay, the combined rendered view) so a flash
    // pulse mid-flight at switch time can't leak its color/alpha into the carry.
    const carriedOverlay = old.cameraEffects.persistentOverlay;
    old.stopAllAudio(); // emits stop AudioPlaybackEvents through onAudio
    this.eventsTruncated ||= old.eventsTruncated;
    old.destroy();
    try {
      await this.startScene(to, frame, carriedOverlay);
    } catch (err) {
      this.recordError({
        frame,
        message: `Scene switch to "${to}" failed: ${(err as Error).message}`,
        phase: 'sceneSwitch',
      });
      return;
    }
    const event: SceneEvent = { frame, from, to };
    this.sceneEvents.push(event);
    this.opts.onSceneChange?.(event);
  }

  private async startScene(
    sceneId: string,
    frameOffset: number,
    initialCameraOverlay?: { color: string; alpha: number },
  ): Promise<void> {
    await this.ensureLuaEngine();
    this._currentSceneId = sceneId;
    this._runtime = await SceneRuntime.create(this.store, sceneId, {
      rng: this.rng,
      // `rng` wins for ctx.random, so the numeric seed only reaches things
      // that need their own derived stream (CameraEffectsState's implicit
      // shake seeds) — without it every session would fall back to seed 0.
      seed: this.opts.seed ?? 0,
      storage: this.storage,
      luaEngine: this.luaEngine ?? undefined,
      frameOffset,
      maxLogs: this.opts.maxLogs,
      musicChannel: this.musicChannel,
      initialCameraOverlay,
      onCameraEffect: (rec) => {
        if (this.cameraEffects.length < MAX_RECORDED_EVENTS) {
          this.cameraEffects.push(rec);
        } else {
          this.cameraEffectsTruncated = true;
        }
      },
      onLog: (e) => this.recordLog(e),
      onError: (e) => this.recordError(e),
      onAudio: (e) => {
        if (e.action !== 'music-volume') {
          this.audioEvents.push({
            frame: this._runtime?.frame ?? frameOffset,
            assetId: e.assetId,
            action: e.action,
            ...(e.music ? { music: true } : {}),
          });
        }
        this.opts.onAudio?.(e);
      },
      onGameEvent: (record) => {
        const merged: GameEventRecord = { ...record, frame: this._runtime?.frame ?? frameOffset };
        if (this.events.length < MAX_RECORDED_EVENTS) {
          this.events.push(merged);
        } else {
          this.eventsTruncated = true;
        }
        this.eventCounts.set(merged.name, (this.eventCounts.get(merged.name) ?? 0) + 1);
        this.opts.onGameEvent?.(merged);
      },
    });
  }

  /**
   * Create the shared Lua engine once per session, lazily, when the
   * project contains any .lua script. Scenes recompile their own chunks
   * but share this one VM (and its seeded math.random stream).
   *
   * Deliberately NO resolveModule/readModule here: module resolution must
   * close over the PER-SCENE ScriptModuleRegistry, which does not exist yet.
   * Every SceneRuntime.loadScripts rebinds this engine to its own registry
   * via setModuleResolver — binding (or omitting) callbacks at creation is
   * what once made `require` fail in every GameSession host.
   */
  private async ensureLuaEngine(): Promise<void> {
    if (this.luaEngine) return;
    const scripts = await this.store.listScripts();
    if (!scripts.some(isLuaPath)) return;
    this.luaEngine = await LuaScriptEngine.create({
      random: () => this.rng(),
      log: (level, message) => this.recordLog({ frame: this.framesSoFar(), level, message }),
    });
  }

  private framesSoFar(): number {
    return this._runtime ? this._runtime.frame : 0;
  }

  private recordLog(e: RuntimeLog): void {
    this.logs.push(e);
    if (this.logs.length > this.maxLogs) this.logs.shift();
    this.opts.onLog?.(e);
  }

  private recordError(e: RuntimeError): void {
    this.errors.push(e);
    this.opts.onError?.(e);
  }
}
