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
 *     the world, positioned by anchor+offset and re-anchored every tick (so
 *     renderer resizes take effect). Real pointer events are translated to
 *     runtime.sendPointer, the same path playtests use.
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
  findSheetFrame,
  joinPath,
  type Asset,
  type Light2DComponent,
  type LineRendererComponent,
  type ParticleEmitterComponent,
  type ProjectStore,
  type SpriteRendererComponent,
  type TilemapComponent,
} from '@hearth/core';
import type { RuntimeEntity, RuntimeError, RuntimeLog, SceneRuntime } from '../runtime.js';
import { colliderShape, type Box, type CollisionShape } from '../physics.js';
import { GameSession, type SceneEvent, type SessionStorage } from '../session.js';
import { uiScreenPosition } from '../ui.js';
import { WebAudioPlayer, routeAudioEvent } from './audio.js';
import { lerp, lerpColor } from './color.js';
import { loadFontFaces } from './fonts.js';

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
  private audio: WebAudioPlayer | null = null;
  private accumulator = 0;
  private _paused: boolean;
  private tickerFn: (ticker: Ticker) => void;
  private keydownFn?: (e: KeyboardEvent) => void;
  private keyupFn?: (e: KeyboardEvent) => void;
  private pointerFns: Array<[keyof HTMLElementEventMap, (e: PointerEvent) => void]> = [];
  private destroyed = false;

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

    // Stage order: world, lightmapSprite, debugLayer, ui, fxOverlay — the
    // lightmap darkens/tints the world but never the UI or debug overlay
    // (debug lines sit above the lightmap so they stay full-brightness); the
    // fx overlay sits above everything so a fade covers the HUD too.
    this.app.stage.addChild(this.world);
    this.app.stage.addChild(this.lightmapSprite);
    this.app.stage.addChild(this.debugLayer);
    this.app.stage.addChild(this.ui);
    this.app.stage.addChild(this.fxOverlay);
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
  }

  pause(): void {
    this._paused = true;
    this.accumulator = 0;
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

  /** Force one render pass so the canvas reflects current state right now, without waiting for the next ticker/rAF tick (manual-stepping hosts call this before taking a screenshot). */
  renderOnce(): void {
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
    if (!on) this.debugGraphics.clear();
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
    this.app.destroy(true, { children: true });
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
    this.accumulator = 0;
    this.syncEntities();
    this.syncCamera();
  }

  private attachKeyboard(): void {
    // Handlers read this.runtime (the session's CURRENT runtime) at event
    // time, so input keeps routing correctly across scene switches.
    this.keydownFn = (e) => {
      if (this.runtime.input.isMappedCode(e.code)) {
        e.preventDefault();
        this.runtime.input.handleKeyDown(e.code);
      }
    };
    this.keyupFn = (e) => {
      if (this.runtime.input.isMappedCode(e.code)) {
        e.preventDefault();
        this.runtime.input.handleKeyUp(e.code);
      }
    };
    window.addEventListener('keydown', this.keydownFn);
    window.addEventListener('keyup', this.keyupFn);
  }

  /**
   * Translate real pointer events on the canvas into runtime.sendPointer
   * (screen coordinates in the renderer's logical space), so browser clicks
   * take exactly the path playtests exercise. Targets the current runtime.
   */
  private attachPointer(): void {
    const canvas = this.app.canvas;
    const send = (e: PointerEvent, kind: 'move' | 'down' | 'up') => {
      const rect = canvas.getBoundingClientRect();
      const sx = rect.width > 0 ? this.app.screen.width / rect.width : 1;
      const sy = rect.height > 0 ? this.app.screen.height / rect.height : 1;
      this.runtime.sendPointer((e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy, kind);
    };
    this.pointerFns = [
      ['pointermove', (e) => send(e, 'move')],
      ['pointerdown', (e) => send(e, 'down')],
      ['pointerup', (e) => send(e, 'up')],
    ];
    for (const [type, fn] of this.pointerFns) {
      canvas.addEventListener(type, fn as EventListener);
    }
  }

  private onTick(ticker: Ticker): void {
    if (this.destroyed) return;
    // Poll gamepads once per render tick, before the fixed-step accumulator
    // loop below — never inside session.step()/runtime.step(), which must
    // stay a pure function of its inputs for headless/playtest determinism.
    if (typeof navigator !== 'undefined' && navigator.getGamepads) {
      this.runtime.input.pollGamepads(navigator.getGamepads());
    }
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
      Tilemap?: { tileAssets: Record<string, string> };
      SpriteAnimator?: { assetId?: string };
    }) => {
      if (components.SpriteRenderer?.assetId) assetIds.add(components.SpriteRenderer.assetId);
      if (components.Tilemap) {
        for (const id of Object.values(components.Tilemap.tileAssets)) assetIds.add(id);
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
        const texture = await Assets.load<Texture>(this.opts.resolveAssetUrl(asset));
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
    this.updateLightmap(cam, settings.width, settings.height);
    this.syncFxOverlay(fx.overlay, settings.width, settings.height);

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
    g.clear();
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
    this.ambientGraphics.clear();
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
   * Redraw the full-screen camera-effects overlay (ctx.camera.flash/fade) to
   * the current screen size, tinted `overlay.color` at `overlay.alpha`.
   * Cheap enough to redraw every tick (mirrors updateLightmap's ambient
   * rect); skips the fill entirely at alpha 0 so idle scenes pay nothing.
   */
  private syncFxOverlay(overlay: { color: string; alpha: number }, width: number, height: number): void {
    this.fxOverlay.clear();
    if (overlay.alpha <= 0) return;
    this.fxOverlay.rect(0, 0, width, height).fill({ color: overlay.color, alpha: overlay.alpha });
  }

  private syncEntities(): void {
    const live = this.runtime.getEntities();
    const liveById = new Map(live.map((e) => [e.id, e]));

    // Remove nodes for destroyed entities.
    for (const [id, node] of this.nodes) {
      if (!liveById.has(id)) {
        node.destroy({ children: true });
        this.nodes.delete(id);
        this.lineSnapshots.delete(id);
        this.spriteSnapshots.delete(id);
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
      this.updateNode(entity, node);

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
   * the named sheet frame (built once per `${assetId}#${frame}` and reused).
   * Falls back to the whole texture — logging a warning exactly once per key
   * via `onLog` — when the frame name isn't on the asset's sliced sheet
   * metadata (asset was never sliced, or the name doesn't exist).
   */
  private resolveSpriteTexture(sprite: SpriteRendererComponent, base: Texture): Texture {
    if (!sprite.frame) return base;
    const key = `${sprite.assetId}#${sprite.frame}`;
    const cached = this.frameTextures.get(key);
    if (cached) return cached;

    const asset = sprite.assetId ? this.opts.store.getAsset(sprite.assetId) : undefined;
    const frame = asset ? findSheetFrame(asset, sprite.frame) : null;
    if (!frame) {
      if (!this.warnedFrames.has(key)) {
        this.warnedFrames.add(key);
        this.opts.onLog?.({
          frame: this.session.frame,
          level: 'warn',
          message: `SpriteRenderer frame "${sprite.frame}" not found on asset "${asset?.name ?? sprite.assetId}" — drawing the whole texture`,
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

  private buildTilemap(tilemap: TilemapComponent): Container {
    const container = new Container();
    const ts = tilemap.tileSize;
    for (let row = 0; row < tilemap.grid.length; row++) {
      const line = tilemap.grid[row];
      for (let col = 0; col < line.length; col++) {
        const ch = line[col];
        if (ch === '.' || ch === ' ') continue;
        const assetId = tilemap.tileAssets[ch];
        const texture = assetId ? this.textures.get(assetId) : undefined;
        if (texture) {
          const s = new Sprite(texture);
          s.position.set(col * ts, row * ts);
          s.width = ts;
          s.height = ts;
          container.addChild(s);
        } else {
          const g = new Graphics();
          g.rect(col * ts, row * ts, ts, ts).fill('#888888');
          container.addChild(g);
        }
      }
    }
    return container;
  }

  private updateNode(entity: RuntimeEntity, node: Container): void {
    const transform = entity.transform;
    const uiElement = entity.components.UIElement;
    if (uiElement) {
      // Screen space: anchor + offset position the node (Transform.position
      // is ignored); recomputing per tick re-anchors on renderer resize.
      const pos = uiScreenPosition(uiElement, this.app.screen.width, this.app.screen.height);
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
    node.zIndex = Math.max(sprite?.layer ?? 0, text?.layer ?? 0, tilemap?.layer ?? 0, line?.layer ?? 0);
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

    g.clear();
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
    g.clear();
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
