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
}

/** Boots the player; resolves with the running view once the game renders. */
async function boot(opts: BootOptions): Promise<PixiSceneView> {
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
      // scene omitted: the session defaults to initialScene (then first scene)
      seed: 0,
      storage: localStorageAdapter(store.project.id),
      resolveAssetUrl: (asset: Asset) => dataUris.get(asset.id) ?? asset.path,
    });

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
