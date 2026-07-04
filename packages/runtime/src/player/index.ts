/**
 * Hearth web player — the entry point bundled into player/hearth-player.js
 * (see scripts/build-player.mjs). Exposes `window.HearthPlayer.boot({ mount,
 * bundle })`: shows a neutral loading layer styled entirely from
 * buildSettings.loading (background color, optional centered image, optional
 * monochrome spinner — no text, no logo, zero engine branding), rebuilds a
 * ProjectStore from the exported project bundle in memory, then mounts the
 * pixi host on the initial scene, letterbox-scaled to fit the mount element.
 * The loading layer is removed once the first frame has rendered. Audio
 * unlocks silently on the first natural user input (see ../pixi/audio.js).
 *
 * Scripts in the bundle go through the normal ProjectStore.readScript path:
 * .js via the Function wrapper, .lua via the wasmoon engine whose glue.wasm
 * is inlined into this bundle as a data: URI (registered with setLuaWasmUri
 * before anything else runs).
 */
import { MemoryFileSystem, ProjectStore, type Asset } from '@hearth/core';
import { setLuaWasmUri } from '../lua.js';
import { PixiSceneView, localStorageAdapter } from '../pixi/index.js';
import { mergeBootOverrides, type BootOverrides } from './bootOverrides.js';
import {
  loadingForegroundColor,
  normalizeLoadingSettings,
  resolveBundleAssetUrl,
} from './loading.js';
import { LUA_WASM_DATA_URI } from './luaWasm.js';

// Must happen before any boot: Lua projects need the inlined wasm. The
// placeholder is empty only in unbundled (Node/tsc) builds, where wasmoon
// resolves its own wasm file.
if (LUA_WASM_DATA_URI) setLuaWasmUri(LUA_WASM_DATA_URI);

const FALLBACK_WIDTH = 960;
const FALLBACK_HEIGHT = 540;

/** One asset entry in the exported project bundle (path or dataUri). */
export interface PlayerBundleAsset {
  id: string;
  name: string;
  type: string;
  path?: string;
  dataUri?: string;
}

/** Parsed project.bundle.json produced by `hearth export web`. */
export interface PlayerBundle {
  /** hearth.json contents. */
  project: unknown;
  /** Full scene files. */
  scenes: unknown[];
  /** Script path → source. */
  scripts: Record<string, string>;
  assets: PlayerBundleAsset[];
}

export interface BootOptions {
  /** Element (or selector) the player takes over. */
  mount: HTMLElement | string;
  bundle: PlayerBundle;
  /**
   * Manual-stepping mode: mounts with `autoplay: false` (no ticker-driven
   * stepping) and exposes `window.__hearth` so a host can drive frames one
   * at a time — see `window.__hearth` below. Off by default; normal
   * (non-manual) boot behaves exactly as before this option existed.
   */
  manual?: boolean;
  /** Seed for ctx.random / Lua math.random (default 0, same as before). */
  seed?: number;
  /** Enable the collider/velocity/light debug overlay right after mount. */
  debug?: boolean;
  /** Override the exported project's canvas resolution (default: buildSettings.width/height). */
  width?: number;
  height?: number;
  /** Scene id or name to boot into (default: the project's initialScene). */
  scene?: string;
}

// window.__HEARTH_BOOT__ (read by boot() below) is the seam a host — the
// `hearth screenshot` CLI (Task 9) — uses to stage manual/seeded/debug mode
// BEFORE this script runs, so an export's unmodified auto-boot call
// (`window.HearthPlayer.boot({ mount, bundle })`, see exportCommands.ts's
// index.html template) can still be driven into that mode without touching
// the template: `<script>window.__HEARTH_BOOT__={manual:true,seed:5,debug:true}</script>`
// ahead of the player script tag. See ./bootOverrides.js for the merge logic
// (kept window-free so it's unit-testable without a DOM).
declare global {
  interface Window {
    __HEARTH_BOOT__?: BootOverrides;
    /**
     * Manual-stepping control surface, present only after a `manual: true`
     * boot. Task 9 (`hearth screenshot`) drives this from Playwright.
     */
    __hearth?: {
      /** Step N fixed frames, awaiting any scene switch triggered mid-run. */
      step: (n: number) => Promise<void>;
      /** Force one render so the canvas reflects current state. */
      render: () => void;
      ready: true;
      frame: () => number;
    };
  }
}

/** Boots the player; resolves with the running view once the game renders. */
async function boot(rawOpts: BootOptions): Promise<PixiSceneView> {
  const opts = mergeBootOverrides(
    rawOpts,
    typeof window !== 'undefined' ? window.__HEARTH_BOOT__ : undefined,
  );
  const mount =
    typeof opts.mount === 'string'
      ? document.querySelector<HTMLElement>(opts.mount)
      : opts.mount;
  if (!mount) throw new Error(`HearthPlayer.boot: mount element not found`);

  // Loading layer first, straight from the raw bundle JSON, so the user's
  // chosen visuals appear before any store/scene work happens.
  const loading = normalizeLoadingSettings(opts.bundle.project);
  mount.style.background = loading.backgroundColor;
  mount.style.overflow = 'hidden';
  if (getComputedStyle(mount).position === 'static') mount.style.position = 'relative';
  const loadingLayer = showLoadingLayer(mount, loading, opts.bundle.assets);

  try {
    const store = await loadStore(opts.bundle);
    const settings = store.project.buildSettings as {
      width?: number;
      height?: number;
    };
    // width/height overrides only ever come from an explicit boot() call or
    // __HEARTH_BOOT__ (e.g. the screenshot CLI pinning a canvas size); a
    // normal export never sets them, so this is a no-op for today's boot.
    if (opts.width) settings.width = opts.width;
    if (opts.height) settings.height = opts.height;
    const baseW = settings.width ?? FALLBACK_WIDTH;
    const baseH = settings.height ?? FALLBACK_HEIGHT;

    // Game host: fills the mount and centers the letterboxed canvas.
    const host = document.createElement('div');
    host.style.cssText =
      'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;';
    mount.appendChild(host);

    const dataUris = new Map<string, string>();
    for (const asset of opts.bundle.assets) {
      if (asset.dataUri) dataUris.set(asset.id, asset.dataUri);
    }
    if (!(store.project.initialScene ?? store.project.scenes[0]?.id)) {
      throw new Error('HearthPlayer.boot: project has no scenes');
    }

    const view = await PixiSceneView.mount({
      container: host,
      store,
      // undefined unless a host (e.g. the screenshot CLI) set it; the
      // session then defaults to initialScene (then the first scene).
      scene: opts.scene,
      seed: opts.seed ?? 0,
      storage: localStorageAdapter(store.project.id),
      resolveAssetUrl: (asset: Asset) => dataUris.get(asset.id) ?? asset.path,
      // manual mode: the host drives frames via window.__hearth.step, not the ticker.
      autoplay: opts.manual ? false : undefined,
    });

    if (opts.debug) view.setDebugDraw(true);

    if (opts.manual) {
      window.__hearth = {
        step: async (n: number) => {
          for (let i = 0; i < n; i++) await view.stepOnceAsync();
        },
        render: () => view.renderOnce(),
        ready: true,
        frame: () => view.session.frame,
      };
    }

    // Letterbox: scale the fixed-resolution canvas to fit, preserving aspect.
    const canvas = host.querySelector('canvas');
    if (canvas) {
      const fit = () => {
        const scale = Math.min(mount.clientWidth / baseW, mount.clientHeight / baseH) || 1;
        canvas.style.width = `${Math.floor(baseW * scale)}px`;
        canvas.style.height = `${Math.floor(baseH * scale)}px`;
      };
      fit();
      window.addEventListener('resize', fit);
    }

    // Drop the loading layer only after the first frame is actually up.
    await nextFrames(2);
    loadingLayer.remove();
    return view;
  } catch (err) {
    loadingLayer.remove();
    throw err;
  }
}

/** Neutral loading layer: background + optional centered image + spinner. */
function showLoadingLayer(
  mount: HTMLElement,
  loading: { backgroundColor: string; image: string | null; spinner: boolean },
  assets: PlayerBundleAsset[],
): HTMLElement {
  const layer = document.createElement('div');
  layer.style.cssText =
    `position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;` +
    `justify-content:center;gap:20px;background:${loading.backgroundColor};z-index:10;`;

  const imageUrl = resolveBundleAssetUrl(assets, loading.image);
  if (imageUrl) {
    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = '';
    img.decoding = 'async';
    img.style.cssText = 'max-width:60%;max-height:60%;object-fit:contain;';
    layer.appendChild(img);
  }

  if (loading.spinner) {
    const fg = loadingForegroundColor(loading.backgroundColor);
    const ring = fg === '#ffffff' ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)';
    const head = fg === '#ffffff' ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.75)';
    const spinner = document.createElement('div');
    spinner.style.cssText =
      `width:24px;height:24px;border-radius:50%;border:3px solid ${ring};` +
      `border-top-color:${head};animation:hearth-player-spin 0.9s linear infinite;`;
    const style = document.createElement('style');
    style.textContent =
      '@keyframes hearth-player-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}';
    layer.append(style, spinner);
  }

  mount.appendChild(layer);
  return layer;
}

/** Wait n animation frames (lets the first render reach the screen). */
function nextFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const tick = (left: number) => {
      if (left <= 0) return resolve();
      requestAnimationFrame(() => tick(left - 1));
    };
    tick(n);
  });
}

/**
 * Decode a `data:<mime>;base64,<payload>` URI (as produced by
 * exportCommands.ts's `toBase64`) back to raw bytes.
 */
function decodeDataUri(dataUri: string): Uint8Array {
  const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Rebuild an in-memory ProjectStore from the exported bundle. */
async function loadStore(bundle: PlayerBundle): Promise<ProjectStore> {
  const fs = new MemoryFileSystem();
  const root = '/game';
  const project = bundle.project as { scenes?: { id: string; path: string }[] };
  await fs.writeFile(`${root}/hearth.json`, JSON.stringify(bundle.project));
  await fs.writeFile(
    `${root}/assets.json`,
    JSON.stringify({
      formatVersion: 1,
      assets: bundle.assets.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        // dataUri-only assets still need an index path; it is never fetched.
        path: a.path ?? `assets/${a.id}`,
        metadata: {},
      })),
    }),
  );
  // Beyond texture/audio loading (which goes through resolveAssetUrl's own
  // dataUri map / relative URLs, not this fs), some runtime code reads an
  // asset's raw content straight off the store — SceneRuntime.loadAnimations
  // and PixiSceneView.preloadTextures both do `store.fs.readFile(asset.path)`
  // to parse a SpriteAnimator's *.anim.json frame list. Without the content
  // in this fs those reads throw ENOENT, which loadAnimations swallows into
  // a recorded load error — silently freezing every SpriteAnimator on its
  // first frame. Both export modes need it materialized:
  // - singleFile (what `hearth screenshot` / `--single-file` produce):
  //   content ships inline as a dataUri per asset; decode it back in.
  // - multi-file: content ships as real files next to index.html, so fetch
  //   it over the same relative URL the rest of the page's assets use.
  //   Only animation assets are fetched — they're the only type whose raw
  //   content the runtime reads through this fs (everything else loads by
  //   URL via resolveAssetUrl), and fetching all assets would double-download
  //   every texture/audio file. A failed fetch just skips the write:
  //   loadAnimations then surfaces the missing file as a load error, same
  //   as before.
  for (const asset of bundle.assets) {
    const assetPath = asset.path ?? `assets/${asset.id}`;
    if (asset.dataUri) {
      await fs.writeFile(`${root}/${assetPath}`, decodeDataUri(asset.dataUri));
    } else if (asset.type === 'animation' && asset.path) {
      try {
        const res = await fetch(asset.path);
        if (res.ok) await fs.writeFile(`${root}/${asset.path}`, await res.text());
      } catch {
        /* loadAnimations reports the missing file */
      }
    }
  }
  const sceneRefs = project.scenes ?? [];
  for (const scene of bundle.scenes as { id: string }[]) {
    const ref = sceneRefs.find((r) => r.id === scene.id);
    if (ref) await fs.writeFile(`${root}/${ref.path}`, JSON.stringify(scene));
  }
  for (const [path, source] of Object.entries(bundle.scripts)) {
    await fs.writeFile(`${root}/${path}`, source);
  }
  return ProjectStore.load(fs, root);
}

declare global {
  interface Window {
    HearthPlayer: { boot: typeof boot };
  }
}

window.HearthPlayer = { boot };
