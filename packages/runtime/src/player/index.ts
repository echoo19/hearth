/**
 * Hearth web player — the entry point bundled into player/hearth-player.js
 * (see scripts/build-player.mjs). Exposes `window.HearthPlayer.boot({ mount,
 * bundle })`: renders a themed click-to-start screen (the click doubles as
 * the user gesture browser audio autoplay policy requires), rebuilds a
 * ProjectStore from the exported project bundle in memory, then mounts the
 * pixi host on the initial scene, letterbox-scaled to fit the mount element.
 *
 * Scripts in the bundle go through the normal ProjectStore.readScript →
 * compileScript path (the same Function wrapper every host uses). Assets
 * resolve to their relative `path` (fetched next to index.html) or to an
 * inline `dataUri`.
 */
import { MemoryFileSystem, ProjectStore, type Asset } from '@hearth/core';
import { PixiSceneView } from '../pixi/index.js';

const DARK = '#141019';
const EMBER = '#F76B15';
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

/** Boots the player; resolves with the running view after the start click. */
async function boot(opts: BootOptions): Promise<PixiSceneView> {
  const mount =
    typeof opts.mount === 'string'
      ? document.querySelector<HTMLElement>(opts.mount)
      : opts.mount;
  if (!mount) throw new Error(`HearthPlayer.boot: mount element not found`);

  const store = await loadStore(opts.bundle);
  const settings = store.project.buildSettings as {
    width?: number;
    height?: number;
    title?: string;
  };
  const baseW = settings.width ?? FALLBACK_WIDTH;
  const baseH = settings.height ?? FALLBACK_HEIGHT;
  const title = settings.title || store.project.name;

  mount.style.background = DARK;
  mount.style.overflow = 'hidden';
  if (getComputedStyle(mount).position === 'static') mount.style.position = 'relative';

  await showStartScreen(mount, title);

  // Game host: fills the mount and centers the letterboxed canvas.
  const host = document.createElement('div');
  host.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;';
  mount.appendChild(host);

  const dataUris = new Map<string, string>();
  for (const asset of opts.bundle.assets) {
    if (asset.dataUri) dataUris.set(asset.id, asset.dataUri);
  }
  const sceneId = store.project.initialScene ?? store.project.scenes[0]?.id;
  if (!sceneId) throw new Error('HearthPlayer.boot: project has no scenes');

  const view = await PixiSceneView.mount({
    container: host,
    store,
    scene: sceneId,
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
  return view;
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

/** Themed click-to-start overlay; resolves on the first click. */
function showStartScreen(mount: HTMLElement, title: string): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      `position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;` +
      `justify-content:center;gap:16px;background:${DARK};cursor:pointer;user-select:none;` +
      `font-family:system-ui,sans-serif;z-index:10;`;
    const heading = document.createElement('div');
    heading.textContent = title;
    heading.style.cssText = 'color:#f5f0eb;font-size:32px;font-weight:600;text-align:center;';
    const prompt = document.createElement('div');
    prompt.textContent = 'Click to start';
    prompt.style.cssText =
      `color:${EMBER};font-size:16px;letter-spacing:0.08em;text-transform:uppercase;` +
      `border:1px solid ${EMBER};border-radius:6px;padding:10px 24px;`;
    overlay.append(heading, prompt);
    mount.appendChild(overlay);
    overlay.addEventListener(
      'click',
      () => {
        overlay.remove();
        resolve();
      },
      { once: true },
    );
  });
}

declare global {
  interface Window {
    HearthPlayer: { boot: typeof boot };
  }
}

window.HearthPlayer = { boot };
