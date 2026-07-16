/**
 * @hearth/runtime/pixi — browser renderer for a running Hearth game.
 *
 * Mounts a PixiJS v8 Application into a host element and drives a GameSession
 * at the project's fixed timestep, syncing display objects to entity state
 * after each render tick. Scene switches requested by scripts
 * (ctx.scenes.load) are handled by the session; the view keeps its
 * Application/canvas and rebuilds the display graph for the new runtime.
 *
 * Rendering notes:
 *   - Each entity renders as one container whose zIndex is the max layer of
 *     its renderable components (per-component layering within one entity is
 *     not split out).
 *   - Sprite textures for EVERY scene in the project are resolved up front
 *     via `resolveAssetUrl` (the bundle is local, so this is cheap and makes
 *     scene switches pop-free); entities spawned later fall back to
 *     primitives unless their texture was already loaded. Load failures also
 *     fall back to primitives.
 *   - UIElement entities render into a screen-space overlay container above
 *     the world, positioned via `resolveUiPositions` (anchor+offset, or a
 *     stacked slot when the parent is a UILayout container) and re-resolved
 *     every tick (so renderer resizes and layout changes take effect). Real
 *     pointer events are translated to runtime.sendPointer, the same path
 *     playtests use and the same position math it hit-tests against.
 *   - Audio plays through Web Audio (see ./audio.js): decoded buffers are
 *     cached, each playback gets a gain node, the context unlocks silently
 *     on the first user input, and everything stops when the view is
 *     destroyed. Scene switches stop the old scene's playbacks via the
 *     session's stop events. Music is a separate streamed channel (one
 *     `<audio>` element at a time, crossfaded on replace) — `onAudio` events
 *     are dispatched to the right WebAudioPlayer method by `routeAudioEvent`.
 *   - Every font-type asset in the project (see ./fonts.js) is registered
 *     with the document via FontFace up front, alongside texture preload,
 *     so Text.fontFamily can name one by asset name from the first render.
 *     A font that fails to load falls back to whatever the browser resolves
 *     that family name to (system font, or the next font-family in a CSS
 *     stack — Text itself only ever sets one fontFamily, so in practice a
 *     failed load just renders in the platform default).
 */
import {
  Application,
  Assets,
  Container,
  Graphics,
  Rectangle,
  RenderTexture,
  Sprite,
  Text,
  Texture,
  type Ticker,
} from 'pixi.js';
import {
  AnimationDataSchema,
  StateMachineDataSchema,
  findSheetFrame,
  joinPath,
  type Asset,
  type Light2DComponent,
  type LineRendererComponent,
  type ParticleEmitterComponent,
  type ProjectStore,
  type SpriteRendererComponent,
  type TilemapComponent,
  type UISliderComponent,
  type UIToggleComponent,
  type Vec2,
} from '@hearth/core';
import type { RuntimeEntity, RuntimeError, RuntimeLog, SceneRuntime } from '../runtime.js';
import { colliderShape, type Box, type CollisionShape } from '../physics.js';
import { GameSession, type SceneEvent, type SessionStorage } from '../session.js';
import { resolveUiPositions, uiScreenPosition } from '../ui.js';
import { WebAudioPlayer, routeAudioEvent } from './audio.js';
import { lerp, lerpColor } from './color.js';
import { shouldCaptureGameKey } from './keyboardCapture.js';
import { loadFontFaces } from './fonts.js';
import {
  createPostEffectFilterState,
  syncPostEffectFilters,
  type PostEffectFilterState,
} from './postEffects.js';
import { syncSpriteEffectsFilter } from './spriteEffectsFilter.js';
import { buildTilemapContainer } from './tilemapRender.js';
import { clearGraphics } from './graphicsGuard.js';
import { pixiTextureAssetDescriptor } from './assetDescriptor.js';

export { localStorageAdapter, type WebStorageLike } from './storage.js';

export interface PixiViewOptions {
  container: HTMLElement;
  store: ProjectStore;
  /** Scene id or name to start in. Default: project initialScene (then first scene). */
  scene?: string;
  /** Seed for ctx.random / Lua math.random (default 0). */
  seed?: number;
  /** Persistence for ctx.save/load (default in-memory; player passes localStorageAdapter). */
  storage?: SessionStorage;
  /** Host maps an asset record to a URL Pixi can load (file/blob/http). */
  resolveAssetUrl(asset: Asset): string;
  /** Start stepping immediately (default true). */
  autoplay?: boolean;
  /** Listen for keydown/keyup on window (default true). */
  attachKeyboard?: boolean;
  /**
   * Root element the game "owns" for keyboard capture. While the game is
   * receiving input, mapped keys are only captured (preventDefault + routed)
   * when focus is inside this root, on `<body>`/`<html>` (ambient — the
   * exported-player case), or nothing is focused; focus in editor chrome
   * outside this root, or an open modal `<dialog>`, passes keys through
   * (see keyboardCapture.ts / L-001). Defaults to `container`. Exported
   * players can leave it as the container — full capture is preserved because
   * their focus rests on `<body>`.
   */
  captureRoot?: HTMLElement;
  onLog?(e: RuntimeLog): void;
  onError?(e: RuntimeError): void;
  /** Fired after a script-requested scene switch completes. */
  onSceneChange?(e: SceneEvent): void;
  /** Draw collider outlines, velocity vectors, and light radii (default false — never on in exports). */
  debugDraw?: boolean;
}

const DEG_TO_RAD = Math.PI / 180;
const MAX_STEPS_PER_TICK = 5;
const DEBUG_COLLIDER_COLOR = 0x00ff88;
const DEBUG_VELOCITY_COLOR = 0xffff00;
const DEBUG_LIGHT_COLOR = 0x66aaff;
/** Velocity vector length is velocity (px/s) scaled by this many seconds. */
const DEBUG_VELOCITY_SCALE = 0.25;

export class PixiSceneView {
  /** The cross-scene session driving this view. */
  readonly session: GameSession;

  private app: Application;
  private world = new Container();
  /** Screen-space UI overlay: always above the world, unaffected by camera. */
  private ui = new Container();
  private nodes = new Map<string, Container>();
  /**
   * Particle graphics are direct children of `world`, keyed by emitter
   * entity id — NOT children of the entity's own node — so particles
   * (already simulated in world space by the runtime) never inherit the
   * emitter entity's rotation/scale. A plain child of `world` has the
   * identity transform by default, so this gives the same "world-space,
   * untransformed" guarantee the old dedicated particleLayer container did,
   * while letting `zIndex = emitter.layer` interleave particles with sprites/
   * lines/tilemaps that share `world` (world.sortableChildren is already on).
   */
  private particleNodes = new Map<string, Graphics>();
  /** Last-drawn (points, width, color, closed, opacity) snapshot per entity, to skip redundant LineRenderer redraws. */
  private lineSnapshots = new Map<string, string>();
  /**
   * Last-drawn (assetId, shape, color, width, height) snapshot per entity for
   * SpriteRenderer, to detect when the sprite child needs to be rebuilt
   * (e.g. a SpriteAnimator or script swaps assetId to a different texture).
   * buildNode's sprite child is only ever built once, so without this the
   * canvas would never pick up a texture change after entity creation.
   */
  private spriteSnapshots = new Map<string, string>();
  /**
   * Last-seen Tilemap.grid and Tilemap.tileAssets REFERENCES per entity, to
   * detect when the tilemap child needs a rebuild — a live paint or autotile
   * edit (setTiles/setTileAutotile, or the editor's live-patch) replaces one of
   * those arrays/objects with a fresh reference. buildNode's tilemap child is
   * only built once, so without this a live tilemap edit would never show until
   * a restart. Reference identity (not a deep hash) keeps this O(1) per tick,
   * matching why the physics tilemap cache avoids per-frame grid joins.
   */
  private tilemapRefs = new Map<string, { grid: unknown; tileAssets: unknown }>();
  /** Last-drawn (min,max,value,step,width,trackColor,fillColor,handleColor) snapshot per entity, to skip redundant UISlider redraws. */
  private sliderSnapshots = new Map<string, string>();
  /** Last-drawn (value,size,color,checkColor) snapshot per entity, to skip redundant UIToggle redraws. */
  private toggleSnapshots = new Map<string, string>();
  private textures = new Map<string, Texture>();
  /**
   * Sub-textures cropped to a sliced sheet's named frame, keyed
   * `${assetId}#${frameName}`, built once from the base texture's `source`
   * and reused across every entity/tick that draws that frame — mirrors
   * `textures` itself being preloaded once per project rather than rebuilt
   * per sprite.
   */
  private frameTextures = new Map<string, Texture>();
  /** `${assetId}#${frame}` keys already warned about (missing/unsliced frame), so a bad ref only logs once, not every tick. */
  private warnedFrames = new Set<string>();
  /**
   * 2D lighting: a multiply-blend sprite sitting above `world`, filled each
   * tick from an offscreen `lightScene` (ambient gray rect + one additive
   * radial sprite per enabled Light2D) rendered to `lightmapRT`. When
   * ambientLight is fully bright and no light is enabled, `lightmapSprite`
   * is hidden and none of this work runs (existing projects with no
   * lighting must render byte-identical to before this feature existed).
   */
  private lightmapSprite: Sprite;
  private lightmapRT: RenderTexture;
  private lightGradientTexture: Texture;
  private lightScene = new Container();
  private ambientGraphics = new Graphics();
  private lightSprites: Sprite[] = [];
  /**
   * Debug overlay: colliders, PhysicsBody velocity vectors, Light2D radii.
   * Sits above `lightmapSprite` (so debug lines aren't darkened/tinted by
   * lighting) and below `ui`. Mirrors `world`'s position/scale every tick
   * since it draws in world coordinates. One `Graphics`, redrawn per tick
   * only while enabled; otherwise `debugLayer.visible = false` and zero
   * per-tick work. Never on by default — callers opt in via
   * `PixiViewOptions.debugDraw` or `setDebugDraw`.
   */
  private debugLayer = new Container();
  private debugGraphics = new Graphics();
  private _debugDraw: boolean;
  /**
   * Full-screen camera-effects overlay (ctx.camera.flash/fade), tinted and
   * redrawn every syncCamera call. Sits above `ui` so a fade covers the HUD.
   */
  private fxOverlay = new Graphics();
  /**
   * Post-processing host: background, world, lightmap, ui, and fxOverlay all
   * live inside this one container so Camera.postEffects filters (bloom/crt/…)
   * apply to the whole composited game view at once. The debug overlay is
   * deliberately NOT a child of this — it stays a direct stage child above
   * gameView so collider/velocity lines are never distorted by a CRT warp or
   * pixelate.
   */
  private gameView = new Container();
  /**
   * Full-screen opaque rect in Camera.backgroundColor, gameView's FIRST child
   * (below the world). Two jobs, both for post effects: (1) the renderer's
   * own clear color lives OUTSIDE gameView, so without this rect a vignette/
   * CRT/colorGrade would only touch drawn texels and leave raw background
   * showing through untinted; (2) it pins gameView's bounds to the full
   * screen, so filter geometry (uOutputFrame) anchors to screen space instead
   * of the content bounding box — vignette centers on the screen, not on
   * wherever the sprites happen to cluster. The renderer clear stays as-is
   * (same color, hidden behind this rect); with an empty effect stack the
   * rect renders byte-identically to that clear, which the neutral-guard
   * screenshot test locks in. Redrawn only when color/size change.
   */
  private backgroundRect = new Graphics();
  /** Last-drawn (color|width|height) of backgroundRect, to skip redundant redraws. */
  private backgroundSnapshot = '';
  /** Cached post-effect filters, rebuilt only when the stack shape changes. */
  private postEffectState: PostEffectFilterState = createPostEffectFilterState();
  private audio: WebAudioPlayer | null = null;
  private accumulator = 0;
  private _paused: boolean;
  private tickerFn: (ticker: Ticker) => void;
  private keydownFn?: (e: KeyboardEvent) => void;
  private keyupFn?: (e: KeyboardEvent) => void;
  private pointerFns: Array<[keyof HTMLElementEventMap, (e: PointerEvent) => void]> = [];
  private destroyed = false;
  /**
   * Latest pointermove position not yet dispatched to the runtime, coalesced
   * to at most one `sendPointer(..., 'move')` call per pixi ticker frame
   * (onTick) instead of one per native pointermove — the browser can fire
   * dozens of these per rendered frame, each of which re-runs
   * resolveUiPositions/hitTestUi across every entity. 'down'/'up' are
   * discrete and stay dispatched immediately (they also flush any pending
   * move first, so hover/press state never sees a stale position on
   * click). Only this presentation-layer path throttles: runtime.ts's
   * sendPointer/handleMove semantics and the headless playtest path are
   * untouched, since playtests call sendPointer directly.
   */
  private pendingMove: { x: number; y: number } | null = null;

  private constructor(
    private readonly opts: PixiViewOptions,
    session: GameSession,
    app: Application,
  ) {
    this.session = session;
    this.app = app;
    this._paused = opts.autoplay === false;
    this.world.sortableChildren = true;
    this.ui.sortableChildren = true;

    const settings = opts.store.project.buildSettings;
    this.lightGradientTexture = PixiSceneView.buildLightGradientTexture();
    this.lightmapRT = RenderTexture.create({ width: settings.width, height: settings.height });
    this.lightmapSprite = new Sprite(this.lightmapRT);
    this.lightmapSprite.blendMode = 'multiply';
    this.lightmapSprite.visible = false;
    this.lightScene.addChild(this.ambientGraphics);

    this._debugDraw = opts.debugDraw ?? false;
    this.debugLayer.addChild(this.debugGraphics);
    this.debugLayer.visible = this._debugDraw;
    this.fxOverlay.label = 'fx-overlay';
    this.fxOverlay.eventMode = 'none';

    // Stage order: gameView (backgroundRect, world, lightmapSprite, ui,
    // fxOverlay) then debugLayer above it. The lightmap darkens/tints the
    // world (and the background rect, exactly as it darkened the renderer
    // clear before) but never the UI, and the fx overlay sits above
    // everything inside the view so a fade covers the HUD too. Everything
    // filterable lives inside gameView so Camera.postEffects apply to the
    // whole composited frame at once; the debug overlay stays a DIRECT stage
    // child above gameView so its lines are never warped/tinted by a post
    // effect.
    this.backgroundRect.label = 'background';
    this.backgroundRect.eventMode = 'none';
    this.gameView.addChild(this.backgroundRect);
    this.gameView.addChild(this.world);
    this.gameView.addChild(this.lightmapSprite);
    this.gameView.addChild(this.ui);
    this.gameView.addChild(this.fxOverlay);
    this.app.stage.addChild(this.gameView);
    this.app.stage.addChild(this.debugLayer);
    this.tickerFn = (ticker) => this.onTick(ticker);
  }

  /**
   * One 256x256 offscreen-canvas radial gradient, white center to
   * transparent edge with quadratic falloff (alpha = 1 - t^2). Generated
   * once per view; light sprites reuse this texture, tinted and scaled per
   * light.
   */
  private static buildLightGradientTexture(): Texture {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const r = size / 2;
    const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
    const steps = 8;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const alpha = Math.max(0, 1 - t * t);
      gradient.addColorStop(t, `rgba(255,255,255,${alpha})`);
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return Texture.from(canvas);
  }

  static async mount(opts: PixiViewOptions): Promise<PixiSceneView> {
    let sessionRef: GameSession | null = null;
    let viewRef: PixiSceneView | null = null;
    const audio = WebAudioPlayer.supported()
      ? new WebAudioPlayer(
          (assetId) => {
            const asset = opts.store.getAsset(assetId);
            return asset ? opts.resolveAssetUrl(asset) : null;
          },
          (message) =>
            opts.onLog?.({ frame: sessionRef?.frame ?? 0, level: 'warn', message }),
        )
      : null;
    const session = await GameSession.create(opts.store, {
      scene: opts.scene,
      seed: opts.seed,
      storage: opts.storage,
      onLog: opts.onLog,
      onError: opts.onError,
      onAudio: audio ? (e) => routeAudioEvent(e, audio) : undefined,
      onSceneChange: (e) => {
        viewRef?.onSceneChanged();
        opts.onSceneChange?.(e);
      },
    });
    sessionRef = session;
    const settings = opts.store.project.buildSettings;
    const app = new Application();
    await app.init({
      width: settings.width,
      height: settings.height,
      background: session.runtime.camera.backgroundColor,
      antialias: true,
    });
    opts.container.appendChild(app.canvas);

    const view = new PixiSceneView(opts, session, app);
    viewRef = view;
    view.audio = audio;
    await Promise.all([view.preloadTextures(), view.loadFonts()]);
    view.syncEntities();
    view.syncCamera();
    app.ticker.add(view.tickerFn);
    if (opts.attachKeyboard !== false) view.attachKeyboard();
    view.attachPointer();
    return view;
  }

  /** The live runtime for the current scene (replaced on scene switch). */
  get runtime(): SceneRuntime {
    return this.session.runtime;
  }

  get paused(): boolean {
    return this._paused;
  }

  play(): void {
    this._paused = false;
    // Resume any audio pause() suspended (a context still waiting on its
    // autoplay-unlock gesture is left alone — see WebAudioPlayer.resume).
    this.audio?.resume();
  }

  pause(): void {
    this._paused = true;
    this.accumulator = 0;
    // Freeze audio with the simulation: suspend the context (halts SFX buffer
    // sources on the audio clock) and hold the music element at its position.
    // The render ticker and gamepad polling keep running by design — only
    // session.step() is gated on `_paused` — so pause is a sim+audio freeze,
    // not a render freeze.
    this.audio?.suspend();
  }

  /** Advance exactly one fixed frame while paused. */
  stepOnce(): void {
    this.session.step();
    if (this.session.switching) return;
    this.syncEntities();
    this.syncCamera();
  }

  /**
   * Advance exactly one fixed frame, awaiting any pending/newly-triggered
   * scene switch first (via `session.stepAsync`) so a `ctx.scenes.load`
   * mid-frame never gets silently skipped the way it would with the
   * fire-and-forget `stepOnce`/`session.step`. Used by manual-stepping hosts
   * (screenshot/test harnesses driving `window.__hearth.step(n)`) that need
   * deterministic frame counts across scene switches — mirrors how the
   * headless playtest runner loops `await session.stepAsync()`.
   */
  async stepOnceAsync(): Promise<void> {
    await this.session.stepAsync();
    if (this.session.switching) return;
    this.syncEntities();
    this.syncCamera();
  }

  /**
   * One deterministic frame plus an immediate render, for manual-step UIs
   * (play-mode pause/step): scene-switch-safe advance via `stepOnceAsync`,
   * then `renderOnce` so the canvas reflects it without waiting for the
   * next ticker tick.
   */
  async stepFrame(): Promise<void> {
    await this.stepOnceAsync();
    this.renderOnce();
  }

  /** Force one render pass so the canvas reflects current state right now, without waiting for the next ticker/rAF tick (manual-stepping hosts call this before taking a screenshot). */
  renderOnce(): void {
    // Render-after-destroy guard (L-116 hardening): stepFrame awaits before
    // calling this, so the view can be destroyed mid-await; rendering a
    // destroyed app would throw deep inside Pixi.
    if (this.destroyed) return;
    this.app.render();
  }

  get debugDraw(): boolean {
    return this._debugDraw;
  }

  /**
   * Toggle the debug overlay (collider outlines, velocity vectors, light
   * radii). Never on by default — this is the only way to enable it, so a
   * shipped export stays clean unless a host explicitly opts in (Task 8
   * wires this into the player UI; this class does not enable it itself).
   */
  setDebugDraw(on: boolean): void {
    this._debugDraw = on;
    this.debugLayer.visible = on;
    if (!on) clearGraphics(this.debugGraphics);
  }

  /**
   * Hot-reload a script against the CURRENT scene's runtime (editor
   * write→play→tweak). Resolves `this.runtime` per call so it targets whatever
   * scene the GameSession is on right now. See SceneRuntime.reloadScript.
   */
  reloadScript(
    path: string,
    source: string,
  ): Promise<
    { ok: true; entities: number } | { ok: false; message: string; line: number | null }
  > {
    return this.runtime.reloadScript(path, source);
  }

  /** Live-patch a component property on the current scene's runtime. See SceneRuntime.patchComponent. */
  patchComponent(
    entityRef: string,
    componentType: string,
    propertyPath: string,
    value: unknown,
  ): boolean {
    return this.runtime.patchComponent(entityRef, componentType, propertyPath, value);
  }

  /**
   * Live-swap a state-machine asset's parsed doc against the CURRENT scene's
   * runtime (editor Animator edits / an external `hearth` update during play).
   * Re-reads the asset file fresh from the store fs and parses it (the on-disk
   * copy the mutation just wrote), then hands the parsed doc to the runtime,
   * which resets only the entities bound to that machine. Resolves to the
   * number of entities reset (0 when the asset is unknown/not a state machine).
   * See SceneRuntime.reloadStateMachineAsset.
   */
  async reloadStateMachineAsset(assetId: string): Promise<number> {
    const asset = this.opts.store.getAsset(assetId);
    if (!asset || asset.type !== 'stateMachine') return 0;
    const raw = await this.opts.store.fs.readFile(joinPath(this.opts.store.root, asset.path));
    const data = StateMachineDataSchema.parse(JSON.parse(raw));
    return this.runtime.reloadStateMachineAsset(assetId, data);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.app.ticker.remove(this.tickerFn);
    if (this.keydownFn) window.removeEventListener('keydown', this.keydownFn);
    if (this.keyupFn) window.removeEventListener('keyup', this.keyupFn);
    for (const [type, fn] of this.pointerFns) {
      this.app.canvas.removeEventListener(type, fn as EventListener);
    }
    this.pointerFns = [];
    this.audio?.destroy();
    this.session.destroy();
    this.nodes.clear();
    this.particleNodes.clear();
    this.lineSnapshots.clear();
    this.spriteSnapshots.clear();
    this.tilemapRefs.clear();
    this.sliderSnapshots.clear();
    this.toggleSnapshots.clear();
    // `textures` (the base preloaded set) is never explicitly cleared/destroyed
    // in this lifecycle either — see preloadTextures's doc comment: it's a
    // once-per-project preload, not cleared on scene change. frameTextures
    // mirrors that: only released when the view itself is destroyed.
    this.frameTextures.clear();
    this.warnedFrames.clear();
    // lightScene is never added to app.stage, so app.destroy's recursive
    // child destruction doesn't reach it or its pooled light sprites.
    this.lightScene.destroy({ children: true });
    this.lightSprites = [];
    // debugLayer/debugGraphics ARE on app.stage, so app.destroy below
    // recursively destroys them; no explicit cleanup needed here.
    // Free GPU textures: app.destroy doesn't destroy textures (texture/textureSource
    // default false), so we must explicitly destroy the uniquely-owned GPU resources.
    this.lightmapRT.destroy(true);
    this.lightGradientTexture.destroy(true);
    // rendererDestroyOptions MUST be `{ removeView: true }`, never `true`
    // (L-116). Passing `true` also sets releaseGlobalResources, which calls
    // GlobalResourceRegistry.release() and destroys Pixi's MODULE-GLOBAL
    // batch pool — a pool shared by every Application on the page. The pool
    // array keeps stale references to batches checked out by OTHER live
    // renderers (getBatchFromPool never nulls the slot), so releasing it
    // nulls `batch.textures` on batches another view is still using; that
    // view's next render then throws "Cannot read properties of null
    // (reading 'clear')" inside Batcher.break. This is exactly what happened
    // when React StrictMode's double-mounted GamePreview destroyed its
    // cancelled view while the surviving view was rendering. removeView
    // keeps the only behavior we wanted from `true`: detaching the canvas.
    this.app.destroy({ removeView: true }, { children: true });
  }

  // ---------------------------------------------------------------------------

  /** After a scene switch: rebuild the display graph, keep app/canvas. */
  private onSceneChanged(): void {
    if (this.destroyed) return;
    for (const [, node] of this.nodes) node.destroy({ children: true });
    this.nodes.clear();
    for (const [, g] of this.particleNodes) g.destroy();
    this.particleNodes.clear();
    this.lineSnapshots.clear();
    this.spriteSnapshots.clear();
    this.tilemapRefs.clear();
    this.sliderSnapshots.clear();
    this.toggleSnapshots.clear();
    this.accumulator = 0;
    this.syncEntities();
    this.syncCamera();
  }

  private attachKeyboard(): void {
    // Handlers read this.runtime (the session's CURRENT runtime) at event
    // time, so input keeps routing correctly across scene switches.
    this.keydownFn = (e) => {
      if (this.runtime.input.isMappedCode(e.code) && this.shouldCaptureKey()) {
        e.preventDefault();
        this.runtime.input.handleKeyDown(e.code);
      }
    };
    this.keyupFn = (e) => {
      if (!this.runtime.input.isMappedCode(e.code)) return;
      // Always release a mapped code (a key held when focus left the game must
      // never stick down), but only preventDefault while actually capturing.
      if (this.shouldCaptureKey()) e.preventDefault();
      this.runtime.input.handleKeyUp(e.code);
    };
    window.addEventListener('keydown', this.keydownFn);
    window.addEventListener('keyup', this.keyupFn);
  }

  /**
   * L-001 capture gate: should a mapped key be captured by the game right now?
   * Delegates the focus/dialog/paused decision to the pure
   * `shouldCaptureGameKey` (unit-tested in keyboard-capture.test.ts).
   */
  private shouldCaptureKey(): boolean {
    if (typeof document === 'undefined') return true; // headless: no chrome to protect
    return shouldCaptureGameKey({
      paused: this._paused,
      dialogOpen: document.querySelector('dialog[open]') !== null,
      activeElement: document.activeElement,
      captureRoot: this.opts.captureRoot ?? this.opts.container,
    });
  }

  /**
   * Translate real pointer events on the canvas into runtime.sendPointer
   * (screen coordinates in the renderer's logical space), so browser clicks
   * take exactly the path playtests exercise. Targets the current runtime.
   */
  private attachPointer(): void {
    const canvas = this.app.canvas;
    const toLocal = (e: PointerEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      const sx = rect.width > 0 ? this.app.screen.width / rect.width : 1;
      const sy = rect.height > 0 ? this.app.screen.height / rect.height : 1;
      return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
    };
    // 'down'/'up' flush any queued move first so hover/press state reflects
    // the pointer's true last-known position before the discrete event
    // lands, then dispatch immediately (never throttled).
    const sendNow = (e: PointerEvent, kind: 'down' | 'up') => {
      this.flushPendingMove();
      const { x, y } = toLocal(e);
      this.runtime.sendPointer(x, y, kind);
    };
    this.pointerFns = [
      ['pointermove', (e) => { this.pendingMove = toLocal(e); }],
      ['pointerdown', (e) => sendNow(e, 'down')],
      ['pointerup', (e) => sendNow(e, 'up')],
    ];
    for (const [type, fn] of this.pointerFns) {
      canvas.addEventListener(type, fn as EventListener);
    }
  }

  /** Dispatch the latest coalesced pointermove, if any, then clear it. */
  private flushPendingMove(): void {
    if (!this.pendingMove) return;
    const { x, y } = this.pendingMove;
    this.pendingMove = null;
    this.runtime.sendPointer(x, y, 'move');
  }

  private onTick(ticker: Ticker): void {
    if (this.destroyed) return;
    // Poll gamepads once per render tick, before the fixed-step accumulator
    // loop below — never inside session.step()/runtime.step(), which must
    // stay a pure function of its inputs for headless/playtest determinism.
    if (typeof navigator !== 'undefined' && navigator.getGamepads) {
      this.runtime.input.pollGamepads(navigator.getGamepads());
    }
    // Coalesced pointermove: dispatch at most once per tick, regardless of
    // pause state (matches the pre-throttle behavior, where every native
    // pointermove dispatched immediately whether or not the session was
    // paused — only session.step() itself is gated by `_paused` below).
    this.flushPendingMove();
    if (!this._paused) {
      this.accumulator += ticker.deltaMS / 1000;
      let steps = 0;
      const dt = this.runtime.fixedDt;
      while (this.accumulator >= dt && steps < MAX_STEPS_PER_TICK) {
        this.session.step(); // no-op while an async scene switch is in flight
        this.accumulator -= dt;
        steps++;
      }
      // Do not let a long stall (tab hidden, breakpoint) build up a spiral.
      if (steps === MAX_STEPS_PER_TICK) this.accumulator = 0;
    }
    // Mid-switch the old runtime is torn down; onSceneChanged resyncs.
    if (this.session.switching) return;
    this.syncEntities();
    this.syncCamera();
  }

  /**
   * Load every texture referenced by SpriteRenderers and Tilemaps in ANY
   * scene of the project up front, so scene switches never pop in assets.
   * Also covers SpriteAnimator: animation assets are tiny JSON on disk
   * listing frame sprite-asset ids, so those get read and their frames
   * folded into the same preload set (the runtime does the same read to
   * play animations; see SceneRuntime.loadAnimations).
   */
  private async preloadTextures(): Promise<void> {
    const assetIds = new Set<string>();
    const animationAssetIds = new Set<string>();
    const collect = (components: {
      SpriteRenderer?: { assetId?: string | null };
      Tilemap?: { tileAssets: Record<string, string | { sheet: string }> };
      SpriteAnimator?: { assetId?: string };
    }) => {
      if (components.SpriteRenderer?.assetId) assetIds.add(components.SpriteRenderer.assetId);
      if (components.Tilemap) {
        // A tile source is a plain asset id (string) or an autotile rule whose
        // `sheet` is the spritesheet asset id — preload whichever it references.
        for (const tile of Object.values(components.Tilemap.tileAssets)) {
          assetIds.add(typeof tile === 'string' ? tile : tile.sheet);
        }
      }
      if (components.SpriteAnimator?.assetId) animationAssetIds.add(components.SpriteAnimator.assetId);
    };
    for (const ref of this.opts.store.project.scenes) {
      const scene = this.opts.store.scenes.get(ref.id);
      if (!scene) continue;
      for (const entity of scene.entities) collect(entity.components);
    }
    // Entities already live in the current runtime (covers spawned ones).
    for (const entity of this.runtime.getEntities()) collect(entity.components);

    for (const id of animationAssetIds) {
      const asset = this.opts.store.getAsset(id);
      if (!asset || asset.type !== 'animation') continue;
      try {
        const raw = await this.opts.store.fs.readFile(joinPath(this.opts.store.root, asset.path));
        const animation = AnimationDataSchema.parse(JSON.parse(raw));
        // Entries may be a plain sprite-asset id or a sheet ref
        // `<sheetAssetId>#<frameName>` (split on the FIRST '#') — either way
        // the sheet's own asset id is what needs a texture loaded.
        for (const frameAssetId of animation.frames) {
          const hashIndex = frameAssetId.indexOf('#');
          assetIds.add(hashIndex === -1 ? frameAssetId : frameAssetId.slice(0, hashIndex));
        }
      } catch (err) {
        this.opts.onLog?.({
          frame: this.session.frame,
          level: 'warn',
          message: `Failed to load animation asset ${asset.name}: ${(err as Error).message}`,
        });
      }
    }

    for (const id of assetIds) {
      const asset = this.opts.store.getAsset(id);
      if (!asset) continue;
      try {
        const texture = await Assets.load<Texture>(pixiTextureAssetDescriptor(asset, this.opts.resolveAssetUrl(asset)));
        this.textures.set(id, texture);
      } catch (err) {
        this.opts.onLog?.({
          frame: this.session.frame,
          level: 'warn',
          message: `Failed to load texture for asset ${asset.name}: ${(err as Error).message}`,
        });
      }
    }
  }

  /**
   * Loads every font-type asset in the project via FontFace (see
   * ./fonts.js), so Text.fontFamily can reference one by asset name. Runs
   * alongside preloadTextures — both are awaited before the first render —
   * and, unlike preloadTextures, isn't scoped to referenced assets: fonts
   * are looked up by name (a plain string on Text.fontFamily), not by
   * asset id, so there's no component reference to scan for.
   */
  private async loadFonts(): Promise<void> {
    const fonts = this.opts.store.assets.assets.filter((a) => a.type === 'font');
    await loadFontFaces(
      fonts,
      (asset) => this.opts.resolveAssetUrl(asset),
      (message) => this.opts.onLog?.({ frame: this.session.frame, level: 'warn', message }),
    );
  }

  private syncCamera(): void {
    const settings = this.opts.store.project.buildSettings;
    const cam = this.runtime.camera;
    const fx = this.runtime.cameraEffects;
    const zoom = cam.zoom * fx.zoomMul;
    this.world.scale.set(zoom);
    this.world.position.set(
      settings.width / 2 - (cam.position.x + fx.offset.x) * zoom,
      settings.height / 2 - (cam.position.y + fx.offset.y) * zoom,
    );
    this.app.renderer.background.color = cam.backgroundColor;
    this.syncBackgroundRect(cam.backgroundColor, settings.width, settings.height);
    this.updateLightmap(cam, settings.width, settings.height);
    this.syncFxOverlay(fx.overlay, settings.width, settings.height);

    // Screen-space post-processing (Camera.postEffects). Filters are cached by
    // stack shape; uniforms (including CRT's frame-seeded noise) refresh
    // every tick. An empty stack yields `filters = null` — byte-identical to
    // no effects, which the neutral-guard screenshot test locks in.
    this.gameView.filters = syncPostEffectFilters(
      this.postEffectState,
      cam.postEffects,
      this.runtime.frame,
    );

    if (this._debugDraw) {
      // Same camera transform as `world` — debug lines are drawn in world
      // coordinates, so the layer must track pan/zoom identically.
      this.debugLayer.scale.set(this.world.scale.x, this.world.scale.y);
      this.debugLayer.position.set(this.world.position.x, this.world.position.y);
      this.redrawDebug();
    }
  }

  /**
   * Redraws the debug overlay for every live enabled entity: collider
   * outlines (green, trigger colliders at half alpha since Pixi strokes
   * can't dash), PhysicsBody velocity vectors (yellow), and Light2D radius
   * circles (soft blue). Reuses `colliderShape` — the exact geometry
   * physics.ts collides with — so the overlay never drifts from real
   * collision bounds.
   */
  private redrawDebug(): void {
    const g = this.debugGraphics;
    if (!clearGraphics(g)) return;
    for (const entity of this.runtime.getEntities()) {
      if (!entity.enabled) continue;
      const worldPos = this.runtime.getWorldPosition(entity);

      const collider = entity.components.Collider;
      if (collider) {
        const shape = colliderShape(collider, worldPos, entity.transform);
        this.drawDebugCollider(g, shape, collider.isTrigger);
        if (collider.oneWay) this.drawOneWayArrow(g, shape.box);
      }

      const body = entity.components.PhysicsBody;
      if (body && (body.velocity.x !== 0 || body.velocity.y !== 0)) {
        g.moveTo(worldPos.x, worldPos.y)
          .lineTo(
            worldPos.x + body.velocity.x * DEBUG_VELOCITY_SCALE,
            worldPos.y + body.velocity.y * DEBUG_VELOCITY_SCALE,
          )
          .stroke({ width: 1, color: DEBUG_VELOCITY_COLOR });
      }

      const light = entity.components.Light2D;
      if (light?.enabled) {
        g.circle(worldPos.x, worldPos.y, light.radius).stroke({
          width: 1,
          color: DEBUG_LIGHT_COLOR,
          alpha: 0.6,
        });
      }
    }
  }

  private drawDebugCollider(g: Graphics, shape: CollisionShape, isTrigger: boolean): void {
    const stroke = { width: 1, color: DEBUG_COLLIDER_COLOR, alpha: isTrigger ? 0.5 : 1 };
    switch (shape.kind) {
      case 'box':
        g.rect(
          shape.box.cx - shape.box.hw,
          shape.box.cy - shape.box.hh,
          shape.box.hw * 2,
          shape.box.hh * 2,
        ).stroke(stroke);
        break;
      case 'circle':
        g.circle(shape.x, shape.y, shape.radius).stroke(stroke);
        break;
      case 'polygon':
        g.poly(
          shape.points.map((p) => ({ x: p.x, y: p.y })),
          true,
        ).stroke(stroke);
        break;
    }
  }

  /** Up-arrow marking a one-way collider's top edge (allows through from below). */
  private drawOneWayArrow(g: Graphics, box: Box): void {
    const stroke = { width: 2, color: DEBUG_COLLIDER_COLOR };
    const topY = box.cy - box.hh;
    g.moveTo(box.cx, topY + 8)
      .lineTo(box.cx, topY - 8)
      .stroke(stroke);
    g.moveTo(box.cx, topY - 8)
      .lineTo(box.cx - 5, topY - 3)
      .stroke(stroke);
    g.moveTo(box.cx, topY - 8)
      .lineTo(box.cx + 5, topY - 3)
      .stroke(stroke);
  }

  /**
   * Rebuilds and renders the lightmap for the current frame. When the scene
   * has no lighting (ambientLight fully bright, no enabled Light2D), this
   * does zero work beyond the two cheap checks below — existing projects
   * with no lights must render byte-identical to before this feature
   * existed.
   */
  private updateLightmap(
    cam: { position: { x: number; y: number }; zoom: number; ambientLight: number },
    width: number,
    height: number,
  ): void {
    const lights = this.runtime
      .getEntities()
      .filter((e) => e.enabled && e.components.Light2D?.enabled);
    if (cam.ambientLight >= 1 && lights.length === 0) {
      this.lightmapSprite.visible = false;
      return;
    }

    const channel = Math.round(cam.ambientLight * 255);
    const ambientColor = (channel << 16) | (channel << 8) | channel;
    if (!clearGraphics(this.ambientGraphics)) return;
    this.ambientGraphics.rect(0, 0, width, height).fill(ambientColor);

    while (this.lightSprites.length < lights.length) {
      const sprite = new Sprite(this.lightGradientTexture);
      sprite.anchor.set(0.5);
      sprite.blendMode = 'add';
      this.lightScene.addChild(sprite);
      this.lightSprites.push(sprite);
    }
    for (let i = lights.length; i < this.lightSprites.length; i++) {
      this.lightSprites[i].visible = false;
    }

    const halfW = width / 2;
    const halfH = height / 2;
    lights.forEach((entity, i) => {
      const light = entity.components.Light2D as Light2DComponent;
      const sprite = this.lightSprites[i];
      sprite.visible = true;
      const world = this.runtime.getWorldPosition(entity);
      sprite.position.set(
        halfW + (world.x - cam.position.x) * cam.zoom,
        halfH + (world.y - cam.position.y) * cam.zoom,
      );
      const diameter = light.radius * 2 * cam.zoom;
      sprite.scale.set(diameter / this.lightGradientTexture.width);
      sprite.tint = light.color;
      sprite.alpha = Math.min(light.intensity, 1);
    });

    this.app.renderer.render({ container: this.lightScene, target: this.lightmapRT, clear: true });
    this.lightmapSprite.visible = true;
  }

  /**
   * Redraw the full-screen background rect (gameView's bottom child — see the
   * `backgroundRect` field doc for why post effects need it) when the camera
   * background color or screen size changed since last tick.
   */
  private syncBackgroundRect(color: string, width: number, height: number): void {
    const snapshot = `${color}|${width}x${height}`;
    if (this.backgroundSnapshot === snapshot) return;
    this.backgroundSnapshot = snapshot;
    if (!clearGraphics(this.backgroundRect)) return;
    this.backgroundRect.rect(0, 0, width, height).fill(color);
  }

  /**
   * Redraw the full-screen camera-effects overlay (ctx.camera.flash/fade) to
   * the current screen size, tinted `overlay.color` at `overlay.alpha`.
   * Cheap enough to redraw every tick (mirrors updateLightmap's ambient
   * rect); skips the fill entirely at alpha 0 so idle scenes pay nothing.
   */
  private syncFxOverlay(overlay: { color: string; alpha: number }, width: number, height: number): void {
    if (!clearGraphics(this.fxOverlay)) return;
    if (overlay.alpha <= 0) return;
    this.fxOverlay.rect(0, 0, width, height).fill({ color: overlay.color, alpha: overlay.alpha });
  }

  private syncEntities(): void {
    const live = this.runtime.getEntities();
    const liveById = new Map(live.map((e) => [e.id, e]));
    // Computed once per tick (mirrors sendPointer) so every UIElement node
    // — including UILayout children — positions from the same layout math
    // the runtime hit-tests against.
    const uiPositions = resolveUiPositions(live, this.app.screen.width, this.app.screen.height);

    // Remove nodes for destroyed entities.
    for (const [id, node] of this.nodes) {
      if (!liveById.has(id)) {
        node.destroy({ children: true });
        this.nodes.delete(id);
        this.lineSnapshots.delete(id);
        this.spriteSnapshots.delete(id);
        this.sliderSnapshots.delete(id);
        this.toggleSnapshots.delete(id);
      }
    }
    // Remove particle graphics for destroyed entities (or ones that lost their emitter).
    for (const [id, g] of this.particleNodes) {
      const entity = liveById.get(id);
      if (!entity || !entity.components.ParticleEmitter) {
        g.destroy();
        this.particleNodes.delete(id);
      }
    }

    for (const entity of live) {
      let node = this.nodes.get(entity.id);
      if (!node) {
        node = this.buildNode(entity);
        this.nodes.set(entity.id, node);
        (entity.components.UIElement ? this.ui : this.world).addChild(node);
      }
      this.updateNode(entity, node, uiPositions);

      const emitter = entity.components.ParticleEmitter;
      if (emitter) {
        let particles = this.particleNodes.get(entity.id);
        if (!particles) {
          particles = new Graphics();
          particles.label = 'particles';
          this.particleNodes.set(entity.id, particles);
          this.world.addChild(particles);
        }
        this.updateParticles(entity, emitter, particles);
      }
    }
  }

  private buildNode(entity: RuntimeEntity): Container {
    const node = new Container();
    const sprite = entity.components.SpriteRenderer;
    if (sprite) {
      const child = this.buildSpriteRenderable(sprite);
      if (child) {
        child.label = 'sprite';
        node.addChild(child);
      }
      this.spriteSnapshots.set(entity.id, this.spriteSnapshotKey(sprite));
    }
    const text = entity.components.Text;
    if (text) {
      const child = new Text({
        text: text.content,
        style: {
          fontFamily: text.fontFamily,
          fontSize: text.fontSize,
          fill: text.color,
          align: text.align,
        },
      });
      child.anchor.set(text.align === 'center' ? 0.5 : text.align === 'right' ? 1 : 0, 0.5);
      child.label = 'text';
      node.addChild(child);
    }
    const tilemap = entity.components.Tilemap;
    if (tilemap) {
      const child = this.buildTilemap(tilemap);
      child.label = 'tilemap';
      node.addChild(child);
    }
    if (entity.components.LineRenderer) {
      const child = new Graphics();
      child.label = 'line';
      node.addChild(child);
    }
    if (entity.components.UISlider) {
      // Left empty: updateNode's redrawSlider draws it on the first tick
      // (no snapshot recorded yet here), same as 'line' above.
      const child = new Graphics();
      child.label = 'slider';
      node.addChild(child);
    }
    if (entity.components.UIToggle) {
      const child = new Graphics();
      child.label = 'toggle';
      node.addChild(child);
    }
    return node;
  }

  /** Identity of a sprite's drawn visual: assetId+frame (texture/sub-rect) plus the primitive fallback fields. */
  private spriteSnapshotKey(sprite: SpriteRendererComponent): string {
    return JSON.stringify([
      sprite.assetId,
      sprite.frame,
      sprite.shape,
      sprite.color,
      sprite.width,
      sprite.height,
    ]);
  }

  private buildSpriteRenderable(sprite: SpriteRendererComponent): Container | null {
    const texture = sprite.assetId ? this.textures.get(sprite.assetId) : undefined;
    if (texture) {
      const s = new Sprite(this.resolveSpriteTexture(sprite, texture));
      s.anchor.set(0.5);
      s.width = sprite.width;
      s.height = sprite.height;
      // Pixi v8 tint accepts '#rrggbb' strings directly (see updateLightmap's
      // `sprite.tint = light.color` above) — default '#ffffff' is Pixi's own
      // default tint, so untouched sprites render identically to before this
      // was wired up.
      s.tint = sprite.color;
      return s;
    }
    if (sprite.shape === 'none' && !sprite.assetId) return null;
    const g = new Graphics();
    const w = sprite.width;
    const h = sprite.height;
    switch (sprite.shape) {
      case 'circle':
        g.circle(0, 0, Math.min(w, h) / 2).fill(sprite.color);
        break;
      case 'triangle':
        g.poly([-w / 2, h / 2, w / 2, h / 2, 0, -h / 2]).fill(sprite.color);
        break;
      case 'none':
        // Asset was set but its texture failed to load: visible placeholder.
        g.rect(-w / 2, -h / 2, w, h).stroke({ width: 1, color: sprite.color });
        break;
      default:
        g.rect(-w / 2, -h / 2, w, h).fill(sprite.color);
        break;
    }
    return g;
  }

  /**
   * Resolves the texture to draw for a textured SpriteRenderer: the whole
   * base texture when `frame` is null, or a cached sub-texture cropped to
   * the named sheet frame — delegates the actual crop/cache/fallback-warn
   * logic to `resolveFrameTexture`, shared with Tilemap autotile rendering
   * (see `buildTilemap` below), since both are "asset id + named sheet
   * frame -> cropped Texture".
   */
  private resolveSpriteTexture(sprite: SpriteRendererComponent, base: Texture): Texture {
    if (!sprite.frame || !sprite.assetId) return base;
    return this.resolveFrameTexture(sprite.assetId, sprite.frame, base);
  }

  /**
   * Crops `base` to `frameName` on `assetId`'s sliced sheet metadata, caching
   * the result per `${assetId}#${frameName}` and reusing it across every
   * sprite/tile that draws that frame (mirrors `textures` itself being
   * preloaded once per project rather than rebuilt per draw). Falls back to
   * the whole `base` texture — logging a warning exactly once per key via
   * `onLog` — when the frame name isn't on the asset's sliced sheet metadata
   * (asset was never sliced, or the name doesn't exist).
   */
  private resolveFrameTexture(assetId: string, frameName: string, base: Texture): Texture {
    const key = `${assetId}#${frameName}`;
    const cached = this.frameTextures.get(key);
    if (cached) return cached;

    const asset = this.opts.store.getAsset(assetId);
    const frame = asset ? findSheetFrame(asset, frameName) : null;
    if (!frame) {
      if (!this.warnedFrames.has(key)) {
        this.warnedFrames.add(key);
        this.opts.onLog?.({
          frame: this.session.frame,
          level: 'warn',
          message: `Sheet frame "${frameName}" not found on asset "${asset?.name ?? assetId}" — drawing the whole texture`,
        });
      }
      return base;
    }
    const sub = new Texture({
      source: base.source,
      frame: new Rectangle(frame.x, frame.y, frame.width, frame.height),
    });
    this.frameTextures.set(key, sub);
    return sub;
  }

  /**
   * Builds the tile display graph fresh from `tilemap.grid` every call — see
   * ./tilemapRender.ts for the actual per-cell resolution (plain asset id vs
   * autotile rule) and why that's a standalone function rather than inlined
   * here (unit-testable without a canvas).
   */
  private buildTilemap(tilemap: TilemapComponent): Container {
    return buildTilemapContainer(tilemap, {
      getTexture: (assetId) => this.textures.get(assetId),
      resolveFrameTexture: (assetId, frameName, base) => this.resolveFrameTexture(assetId, frameName, base),
    });
  }

  private updateNode(entity: RuntimeEntity, node: Container, uiPositions: Map<string, Vec2>): void {
    const transform = entity.transform;
    const uiElement = entity.components.UIElement;
    if (uiElement) {
      // Screen space, layout-aware: `uiPositions` is resolveUiPositions'
      // result for the whole live entity set (computed once per tick in
      // syncEntities), so a UILayout child renders at its stacked slot
      // instead of its own bare anchor+offset — the same positions
      // runtime.sendPointer hit-tests against, so clicks and pixels agree.
      // Transform.position is ignored; recomputing per tick re-anchors on
      // renderer resize.
      const pos = uiPositions.get(entity.id) ?? uiScreenPosition(uiElement, this.app.screen.width, this.app.screen.height);
      node.position.set(pos.x, pos.y);
    } else {
      const world = this.runtime.getWorldPosition(entity);
      node.position.set(world.x, world.y);
    }
    node.rotation = transform.rotation * DEG_TO_RAD;
    node.scale.set(transform.scale.x, transform.scale.y);

    const sprite = entity.components.SpriteRenderer;
    const text = entity.components.Text;
    const tilemap = entity.components.Tilemap;
    const line = entity.components.LineRenderer;
    const slider = entity.components.UISlider;
    const toggle = entity.components.UIToggle;
    node.zIndex = Math.max(
      sprite?.layer ?? 0,
      text?.layer ?? 0,
      tilemap?.layer ?? 0,
      line?.layer ?? 0,
      slider?.layer ?? 0,
      toggle?.layer ?? 0,
    );
    node.visible = entity.enabled;

    let spriteNode = node.getChildByLabel?.('sprite') ?? null;
    if (sprite) {
      const snapshot = this.spriteSnapshotKey(sprite);
      if (this.spriteSnapshots.get(entity.id) !== snapshot) {
        this.spriteSnapshots.set(entity.id, snapshot);
        // Visual identity changed (most commonly a SpriteAnimator or script
        // swapping assetId) — rebuild the child from the new texture/shape.
        // buildNode only builds this child once, so this is the only path
        // that ever picks up a post-creation texture swap.
        const index = spriteNode ? node.getChildIndex(spriteNode) : 0;
        if (spriteNode) {
          node.removeChild(spriteNode);
          spriteNode.destroy();
        }
        const rebuilt = this.buildSpriteRenderable(sprite);
        if (rebuilt) {
          rebuilt.label = 'sprite';
          node.addChildAt(rebuilt, Math.min(index, node.children.length));
        }
        spriteNode = rebuilt;
      }
      if (spriteNode) {
        spriteNode.visible = sprite.visible;
        spriteNode.alpha = sprite.opacity;
        const sx = Math.abs(spriteNode.scale.x) * (sprite.flipX ? -1 : 1);
        const sy = Math.abs(spriteNode.scale.y) * (sprite.flipY ? -1 : 1);
        spriteNode.scale.set(sx, sy);
      }
    }
    const textNode = node.getChildByLabel?.('text') as Text | null;
    if (textNode && text) {
      textNode.visible = text.visible;
      if (textNode.text !== text.content) textNode.text = text.content;
    }
    const lineNode = node.getChildByLabel?.('line') as Graphics | null;
    if (lineNode && line) {
      lineNode.visible = line.visible;
      this.redrawLine(entity.id, lineNode, line);
    }
    const sliderNode = node.getChildByLabel?.('slider') as Graphics | null;
    if (sliderNode && slider) {
      this.redrawSlider(entity.id, sliderNode, slider);
    }
    const toggleNode = node.getChildByLabel?.('toggle') as Graphics | null;
    if (toggleNode && toggle) {
      this.redrawToggle(entity.id, toggleNode, toggle);
    }
    const tilemapNode = node.getChildByLabel?.('tilemap') ?? null;
    if (tilemapNode && tilemap) {
      const prev = this.tilemapRefs.get(entity.id);
      if (!prev || prev.grid !== tilemap.grid || prev.tileAssets !== tilemap.tileAssets) {
        this.tilemapRefs.set(entity.id, { grid: tilemap.grid, tileAssets: tilemap.tileAssets });
        // First sight (prev undefined) is the child buildNode already drew — only
        // a subsequent grid/tileAssets swap rebuilds it.
        if (prev) {
          const index = node.getChildIndex(tilemapNode);
          node.removeChild(tilemapNode);
          tilemapNode.destroy({ children: true });
          const rebuilt = this.buildTilemap(tilemap);
          rebuilt.label = 'tilemap';
          node.addChildAt(rebuilt, Math.min(index, node.children.length));
        }
      }
    }

    // Per-sprite outline/flash/dissolve. Attaches the combined filter only
    // when a field is non-neutral; a default (or absent) SpriteEffects
    // component leaves `node.filters` null so it renders byte-identically.
    syncSpriteEffectsFilter(node, entity.components.SpriteEffects);
  }

  /**
   * Redraws a LineRenderer's Graphics path only when its drawn shape
   * changed since last tick (points/width/color/closed/opacity), since
   * points arrays are tiny and JSON.stringify is cheap relative to a
   * needless Graphics rebuild every frame.
   */
  private redrawLine(entityId: string, g: Graphics, line: LineRendererComponent): void {
    const snapshot = JSON.stringify([line.points, line.width, line.color, line.closed, line.opacity]);
    if (this.lineSnapshots.get(entityId) === snapshot) return;
    this.lineSnapshots.set(entityId, snapshot);

    if (!clearGraphics(g)) return;
    if (line.points.length < 2) return;
    if (line.closed) {
      g.poly(
        line.points.map((p) => ({ x: p.x, y: p.y })),
        true,
      );
    } else {
      g.moveTo(line.points[0].x, line.points[0].y);
      for (let i = 1; i < line.points.length; i++) g.lineTo(line.points[i].x, line.points[i].y);
    }
    g.stroke({ width: line.width, color: line.color, alpha: line.opacity });
  }

  /** Identity of a UISlider's drawn visual, to skip redundant redraws. */
  private sliderSnapshotKey(slider: UISliderComponent): string {
    return JSON.stringify([
      slider.min,
      slider.max,
      slider.value,
      slider.step,
      slider.width,
      slider.trackColor,
      slider.fillColor,
      slider.handleColor,
      slider.layer,
    ]);
  }

  /**
   * Redraws a UISlider as a track (width x 6, `trackColor`) with a filled
   * portion up to the current value (`fillColor`) and a circular handle
   * (radius 8, `handleColor`) at the value position — centered on the
   * node's own origin, since `updateNode` already positions the node at
   * the slider's resolved screen position. Only redraws when the drawn
   * state actually changed since last tick.
   */
  private redrawSlider(entityId: string, g: Graphics, slider: UISliderComponent): void {
    const snapshot = this.sliderSnapshotKey(slider);
    if (this.sliderSnapshots.get(entityId) === snapshot) return;
    this.sliderSnapshots.set(entityId, snapshot);

    if (!clearGraphics(g)) return;
    const halfW = slider.width / 2;
    const trackH = 6;
    g.rect(-halfW, -trackH / 2, slider.width, trackH).fill(slider.trackColor);

    const range = slider.max - slider.min;
    const t = range !== 0 ? Math.min(1, Math.max(0, (slider.value - slider.min) / range)) : 0;
    const fillW = slider.width * t;
    if (fillW > 0) {
      g.rect(-halfW, -trackH / 2, fillW, trackH).fill(slider.fillColor);
    }
    g.circle(-halfW + fillW, 0, 8).fill(slider.handleColor);
  }

  /** Identity of a UIToggle's drawn visual, to skip redundant redraws. */
  private toggleSnapshotKey(toggle: UIToggleComponent): string {
    return JSON.stringify([toggle.value, toggle.size, toggle.color, toggle.checkColor, toggle.layer]);
  }

  /**
   * Redraws a UIToggle as a rounded `size x size` box (`color`) with an
   * inset check fill (`checkColor`) drawn only when `value` is true —
   * centered on the node's own origin, like `redrawSlider`. Only redraws
   * when the drawn state actually changed since last tick.
   */
  private redrawToggle(entityId: string, g: Graphics, toggle: UIToggleComponent): void {
    const snapshot = this.toggleSnapshotKey(toggle);
    if (this.toggleSnapshots.get(entityId) === snapshot) return;
    this.toggleSnapshots.set(entityId, snapshot);

    if (!clearGraphics(g)) return;
    const half = toggle.size / 2;
    const radius = Math.min(6, half);
    g.roundRect(-half, -half, toggle.size, toggle.size, radius).fill(toggle.color);
    if (toggle.value) {
      const inset = toggle.size * 0.25;
      const innerSize = toggle.size - inset * 2;
      g.rect(-half + inset, -half + inset, innerSize, innerSize).fill(toggle.checkColor);
    }
  }

  /**
   * Redraws a ParticleEmitter's world-space Graphics every tick (particle
   * positions/ages change continuously, so there's no cheap change check
   * like LineRenderer's static geometry).
   */
  private updateParticles(
    entity: RuntimeEntity,
    emitter: ParticleEmitterComponent,
    g: Graphics,
  ): void {
    g.zIndex = emitter.layer;
    g.visible = entity.enabled;
    if (!clearGraphics(g)) return;
    if (!entity.enabled) return;

    for (const p of this.runtime.getParticles(entity.id)) {
      const t = p.lifetime > 0 ? p.age / p.lifetime : 1;
      const size = lerp(emitter.startSize, emitter.endSize, t);
      const color = lerpColor(emitter.startColor, emitter.endColor, t);
      if (size <= 0) continue;
      g.circle(p.x, p.y, size / 2).fill({ color, alpha: 1 - Math.min(1, Math.max(0, t)) * 0.25 });
    }
  }
}
