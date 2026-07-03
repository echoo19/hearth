/**
 * @hearth/runtime/pixi — browser renderer for a running Hearth scene.
 *
 * Mounts a PixiJS v8 Application into a host element and drives a headless
 * SceneRuntime at the project's fixed timestep, syncing display objects to
 * entity state after each render tick.
 *
 * v1 rendering notes:
 *   - Each entity renders as one container whose zIndex is the max layer of
 *     its renderable components (per-component layering within one entity is
 *     not split out).
 *   - Sprite textures are resolved up front via `resolveAssetUrl`; entities
 *     spawned later fall back to primitives unless their texture was already
 *     loaded. Load failures also fall back to primitives.
 *   - UIElement entities render into a screen-space overlay container above
 *     the world, positioned by anchor+offset and re-anchored every tick (so
 *     renderer resizes take effect). Real pointer events are translated to
 *     runtime.sendPointer, the same path playtests use.
 *   - Audio plays through Web Audio (see ./audio.js): decoded buffers are
 *     cached, each playback gets a gain node, and everything stops when the
 *     view is destroyed.
 */
import {
  Application,
  Assets,
  Container,
  Graphics,
  Sprite,
  Text,
  Texture,
  type Ticker,
} from 'pixi.js';
import type { Asset, ProjectStore, SpriteRendererComponent, TilemapComponent } from '@hearth/core';
import { SceneRuntime, type RuntimeEntity, type RuntimeError, type RuntimeLog } from '../runtime.js';
import { uiScreenPosition } from '../ui.js';
import { WebAudioPlayer } from './audio.js';

export interface PixiViewOptions {
  container: HTMLElement;
  store: ProjectStore;
  scene: string;
  /** Host maps an asset record to a URL Pixi can load (file/blob/http). */
  resolveAssetUrl(asset: Asset): string;
  /** Start stepping immediately (default true). */
  autoplay?: boolean;
  /** Listen for keydown/keyup on window (default true). */
  attachKeyboard?: boolean;
  onLog?(e: RuntimeLog): void;
  onError?(e: RuntimeError): void;
}

const DEG_TO_RAD = Math.PI / 180;
const MAX_STEPS_PER_TICK = 5;

export class PixiSceneView {
  readonly runtime: SceneRuntime;

  private app: Application;
  private world = new Container();
  /** Screen-space UI overlay: always above the world, unaffected by camera. */
  private ui = new Container();
  private nodes = new Map<string, Container>();
  private textures = new Map<string, Texture>();
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
    runtime: SceneRuntime,
    app: Application,
  ) {
    this.runtime = runtime;
    this.app = app;
    this._paused = opts.autoplay === false;
    this.world.sortableChildren = true;
    this.ui.sortableChildren = true;
    this.app.stage.addChild(this.world);
    this.app.stage.addChild(this.ui);
    this.tickerFn = (ticker) => this.onTick(ticker);
  }

  static async mount(opts: PixiViewOptions): Promise<PixiSceneView> {
    let runtimeRef: SceneRuntime | null = null;
    const audio = WebAudioPlayer.supported()
      ? new WebAudioPlayer(
          (assetId) => {
            const asset = opts.store.getAsset(assetId);
            return asset ? opts.resolveAssetUrl(asset) : null;
          },
          (message) =>
            opts.onLog?.({ frame: runtimeRef?.frame ?? 0, level: 'warn', message }),
        )
      : null;
    const runtime = await SceneRuntime.create(opts.store, opts.scene, {
      onLog: opts.onLog,
      onError: opts.onError,
      onAudio: audio
        ? (e) => {
            if (e.action === 'play') audio.play(e.handleId, e.assetId, { volume: e.volume, loop: e.loop });
            else audio.stop(e.handleId);
          }
        : undefined,
    });
    runtimeRef = runtime;
    const settings = opts.store.project.buildSettings;
    const app = new Application();
    await app.init({
      width: settings.width,
      height: settings.height,
      background: runtime.camera.backgroundColor,
      antialias: true,
    });
    opts.container.appendChild(app.canvas);

    const view = new PixiSceneView(opts, runtime, app);
    view.audio = audio;
    await view.preloadTextures();
    view.syncEntities();
    view.syncCamera();
    app.ticker.add(view.tickerFn);
    if (opts.attachKeyboard !== false) view.attachKeyboard();
    view.attachPointer();
    return view;
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
    this.runtime.step();
    this.syncEntities();
    this.syncCamera();
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
    this.runtime.destroy();
    this.nodes.clear();
    this.app.destroy(true, { children: true });
  }

  // ---------------------------------------------------------------------------

  private attachKeyboard(): void {
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
   * take exactly the path playtests exercise.
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
    if (!this._paused) {
      this.accumulator += ticker.deltaMS / 1000;
      let steps = 0;
      while (this.accumulator >= this.runtime.fixedDt && steps < MAX_STEPS_PER_TICK) {
        this.runtime.step();
        this.accumulator -= this.runtime.fixedDt;
        steps++;
      }
      // Do not let a long stall (tab hidden, breakpoint) build up a spiral.
      if (steps === MAX_STEPS_PER_TICK) this.accumulator = 0;
    }
    this.syncEntities();
    this.syncCamera();
  }

  /** Load every texture referenced by SpriteRenderers and Tilemaps up front. */
  private async preloadTextures(): Promise<void> {
    const assetIds = new Set<string>();
    for (const entity of this.runtime.getEntities()) {
      const sprite = entity.components.SpriteRenderer;
      if (sprite?.assetId) assetIds.add(sprite.assetId);
      const tilemap = entity.components.Tilemap;
      if (tilemap) for (const id of Object.values(tilemap.tileAssets)) assetIds.add(id);
    }
    for (const id of assetIds) {
      const asset = this.opts.store.getAsset(id);
      if (!asset) continue;
      try {
        const texture = await Assets.load<Texture>(this.opts.resolveAssetUrl(asset));
        this.textures.set(id, texture);
      } catch (err) {
        this.opts.onLog?.({
          frame: this.runtime.frame,
          level: 'warn',
          message: `Failed to load texture for asset ${asset.name}: ${(err as Error).message}`,
        });
      }
    }
  }

  private syncCamera(): void {
    const settings = this.opts.store.project.buildSettings;
    const cam = this.runtime.camera;
    this.world.scale.set(cam.zoom);
    this.world.position.set(
      settings.width / 2 - cam.position.x * cam.zoom,
      settings.height / 2 - cam.position.y * cam.zoom,
    );
    this.app.renderer.background.color = cam.backgroundColor;
  }

  private syncEntities(): void {
    const live = this.runtime.getEntities();
    const liveIds = new Set(live.map((e) => e.id));

    // Remove nodes for destroyed entities.
    for (const [id, node] of this.nodes) {
      if (!liveIds.has(id)) {
        node.destroy({ children: true });
        this.nodes.delete(id);
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
    return node;
  }

  private buildSpriteRenderable(sprite: SpriteRendererComponent): Container | null {
    const texture = sprite.assetId ? this.textures.get(sprite.assetId) : undefined;
    if (texture) {
      const s = new Sprite(texture);
      s.anchor.set(0.5);
      s.width = sprite.width;
      s.height = sprite.height;
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
    node.zIndex = Math.max(sprite?.layer ?? 0, text?.layer ?? 0, tilemap?.layer ?? 0);
    node.visible = entity.enabled;

    const spriteNode = node.getChildByLabel?.('sprite') ?? null;
    if (spriteNode && sprite) {
      spriteNode.visible = sprite.visible;
      spriteNode.alpha = sprite.opacity;
      const sx = Math.abs(spriteNode.scale.x) * (sprite.flipX ? -1 : 1);
      const sy = Math.abs(spriteNode.scale.y) * (sprite.flipY ? -1 : 1);
      spriteNode.scale.set(sx, sy);
    }
    const textNode = node.getChildByLabel?.('text') as Text | null;
    if (textNode && text) {
      textNode.visible = text.visible;
      if (textNode.text !== text.content) textNode.text = text.content;
    }
  }
}
