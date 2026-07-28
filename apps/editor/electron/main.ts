/**
 * Hearth desktop app — Electron main process.
 *
 * Why Electron for the packaged app: Hearth's project server is Node (it
 * reuses @hearth/core/node directly), and Electron's main process *is* Node —
 * so the exact same command-layer server that powers `npm run dev` runs
 * in-process here, plus we get native folder dialogs (open/create projects
 * straight from disk, Godot/Unity style). The Tauri shell in src-tauri/
 * remains as an experimental alternative (needs a Rust toolchain and a
 * sidecar for the project server).
 *
 * This file is bundled to dist-electron/main.cjs by scripts/build-electron.mjs
 * (esbuild, everything inlined except the electron builtin), so the packaged
 * app does not need node_modules.
 */
import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import type { MessageBoxOptions, MessageBoxSyncOptions } from 'electron';
import { autoUpdater } from 'electron-updater';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  createProjectServerContext,
  handleApiRequest,
  attachWebSocket,
  resolveToolPaths,
  isHearthServerPath,
} from '../server/projectServer.js';
import { attachProbeStream } from '../server/probeStream.js';
import { startGameServer, type GameServerHandle } from '../server/gameServer.js';
import { ensureHearthShim, hearthPtyEnv } from '../server/hearthShim.js';
import { applyAppMenu, buildAppMenuTemplate } from './appMenu.js';
import { resolveUpdatePolicy } from './updaterPolicy.js';
import { wireUpdater, type UpdatePrompt, type UpdaterHandle, type UpdaterLike } from './updater.js';
import type { SerializedMenuSection } from '../src/menu/appMenu';

const SMOKE = process.env.HEARTH_SMOKE === '1';
/** In dev, point the window at the Vite dev server instead of dist/. */
const START_URL = process.env.ELECTRON_START_URL;

/**
 * The window opens at working size, always. There is no compact launcher any
 * more: the app's first screen is a conversation, and a conversation needs the
 * same room the editor does.
 */
const WINDOW_WIDTH = 1440;
const WINDOW_HEIGHT = 900;
const MIN_WINDOW_WIDTH = 1024;
const MIN_WINDOW_HEIGHT = 640;

/** Matches --bg-0, so the frame never flashes a lighter panel before paint. */
const WINDOW_BACKGROUND = '#101014';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  // wasm must carry its real MIME or WebAssembly.compileStreaming falls back
  // to the slow ArrayBuffer path on every Lua project load.
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

/**
 * Serve the built UI (dist/) + the /api routes on a loopback-only port.
 * Serving over http (rather than file://) keeps the renderer identical to
 * browser mode — same-origin fetch('/api/...') works unchanged.
 *
 * The game mount does NOT ride this server. It gets a second loopback port of
 * its own (server/gameServer.ts, whose header says why), started here so the
 * packaged app has exactly the same origin boundary the dev server does. If
 * that listener fails the pane says it has nowhere to serve the game from,
 * which is the honest outcome: the alternative would be putting the agent's
 * HTML back on the origin that spawns shells.
 */
async function startServer(uiRoot: string): Promise<{ port: number; close: () => void }> {
  const ctx = createProjectServerContext();
  let game: GameServerHandle | null = null;
  try {
    game = await startGameServer(ctx);
    ctx.setGameOrigin(game.origin);
  } catch (err) {
    console.error(`[hearth] game mount server could not start: ${(err as Error).message}`);
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // /api/* only. Checked before the SPA fallback below, which would
    // otherwise answer an API call with the editor's index.html.
    if (isHearthServerPath(url.pathname)) {
      handleApiRequest(ctx, req, res).catch((err: unknown) => {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: (err as Error).message ?? 'Internal error' }));
      });
      return;
    }
    // Static UI files; unknown paths fall back to index.html (SPA).
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const filePath = path.join(uiRoot, path.normalize(rel));
    const safe = filePath.startsWith(uiRoot) && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    const finalPath = safe ? filePath : path.join(uiRoot, 'index.html');
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[path.extname(finalPath)] ?? 'application/octet-stream');
    fs.createReadStream(finalPath).pipe(res);
  });
  attachWebSocket(server, ctx);
  // The running-sweep picture rides its own upgrade path; see probeStream.ts.
  attachProbeStream(server, ctx.probeBus);
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    // Port 0 = pick any free port; loopback only.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve({
          port: address.port,
          close: () => {
            server.close();
            game?.close();
          },
        });
      } else {
        reject(new Error('Could not determine server port'));
      }
    });
  });
}

function registerDialogHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('hearth:pick-project-folder', async () => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win!, {
      title: 'Open a Hearth project',
      message: 'Choose a folder that contains hearth.json',
      properties: ['openDirectory'],
      buttonLabel: 'Open',
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('hearth:pick-directory', async () => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win!, {
      title: 'Open a folder',
      message: 'Pick a folder to work in, or make a new one',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Open',
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('hearth:reveal-in-folder', (_event, target: string) => {
    if (typeof target === 'string' && fs.existsSync(target)) shell.showItemInFolder(target);
  });

  // Native application menu: the renderer pushes the serialized File/Edit/View/
  // Help model (macOS) and null to restore the baseline when the project closes.
  ipcMain.on('hearth:set-app-menu', (_event, model: SerializedMenuSection[] | null) => {
    applyAppMenu(model, getWindow());
  });

  // There is only ONE window shape now. The app used to open as a compact
  // project manager and grow when a project opened (Godot-style); the chat-
  // first home means there is nothing to gate on, so the window is always the
  // working size and 'launcher' is just an alias of 'editor'. The IPC name and
  // both mode values stay so a renderer running against an older or newer
  // preload can't break on it.
  ipcMain.handle('hearth:window-mode', (_event, _mode: string, title?: string) => {
    const win = getWindow();
    if (!win) return;
    win.setMinimumSize(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT);
    const { width, height } = win.getBounds();
    // Only ever grow a window the user hasn't already sized past the floor —
    // resizing one they deliberately made bigger would be rude.
    if (width < WINDOW_WIDTH || height < WINDOW_HEIGHT) {
      win.setSize(Math.max(width, WINDOW_WIDTH), Math.max(height, WINDOW_HEIGHT), true);
      win.center();
    }
    win.setTitle(title ? `${title} — Hearth` : 'Hearth');
  });
}

/** Where macOS's notify-only update prompt sends people. */
const DOWNLOAD_URL = 'https://hearthengine.com/download';

/**
 * Hook electron-updater up to the GitHub-Releases feed (app-update.yml, baked
 * into the packaged app by electron-builder's `publish` config). All behavior
 * lives in wireUpdater (unit-tested); this is just the Electron glue: native
 * message boxes, the system browser, and the policy inputs. Returns null when
 * updates are off (dev runs, smoke tests, HEARTH_DISABLE_UPDATES=1).
 */
function initAutoUpdater(
  getWindow: () => BrowserWindow | null,
  onUpdateReady: (info: { version: string }) => void,
): UpdaterHandle | null {
  const policy = resolveUpdatePolicy({
    platform: process.platform,
    packaged: app.isPackaged,
    env: process.env,
  });
  if (policy.mode === 'off') return null;

  const prompt = async (p: UpdatePrompt): Promise<number> => {
    const options: MessageBoxOptions = {
      type: 'info',
      title: p.title,
      message: p.message,
      detail: p.detail,
      buttons: p.buttons,
      defaultId: 0,
      cancelId: p.buttons.length - 1,
      noLink: true,
    };
    const win = getWindow();
    const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return result.response;
  };

  return wireUpdater({
    // Structural cast: electron-updater's emitter types its events; UpdaterLike
    // only needs the string-event subset wireUpdater listens to.
    updater: autoUpdater as unknown as UpdaterLike,
    policy,
    prompt,
    openDownloadPage: () => void shell.openExternal(DOWNLOAD_URL),
    log: (message) => console.log('[updater]', message),
    onUpdateReady,
  });
}

function confirmDiscardUnsavedScripts(win: BrowserWindow | null): boolean {
  const options: MessageBoxSyncOptions = {
    type: 'warning',
    buttons: ['Discard and close', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Unsaved script changes',
    message: 'Discard unsaved script changes?',
    detail: "Closing Hearth will discard unsaved changes in your open scripts. Scripts don't auto-save.",
    noLink: true,
  };
  const choice = win ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options);
  return choice === 0;
}

async function main(): Promise<void> {
  await app.whenReady();

  // Tell the project server where the bundled agent tools live (the Agent
  // panel shows these paths so users can wire up MCP/CLI without a repo
  // checkout). __dirname is dist-electron/ both in dev and inside app.asar,
  // but tools must be readable by external `node`, so prefer the unpacked
  // path when packaged.
  const toolsDir = __dirname.includes('app.asar')
    ? __dirname.replace('app.asar', 'app.asar.unpacked')
    : __dirname;
  process.env.HEARTH_TOOLS_DIR = toolsDir;

  let win: BrowserWindow | null = null;
  let hasUnsavedScripts = false;
  registerDialogHandlers(() => win);

  /**
   * The last downloaded-update announcement, kept so a renderer that loads (or
   * reloads) after the download still gets it. Without the replay, an update
   * that lands during startup — or before the user opens a folder — would
   * never show its banner.
   */
  let updateReady: { version: string } | null = null;
  const sendUpdateReady = (): void => {
    if (updateReady && win && !win.isDestroyed()) win.webContents.send('hearth:update-ready', updateReady);
  };
  const updates = initAutoUpdater(
    () => win,
    (info) => {
      updateReady = info;
      sendUpdateReady();
    },
  );
  ipcMain.handle('hearth:check-for-updates', async () => {
    // No-op when updates are off (dev runs) — the menu item is still wired.
    await updates?.checkNow();
  });
  ipcMain.handle('hearth:relaunch-to-update', () => {
    updates?.relaunchToUpdate();
  });
  ipcMain.on('hearth:set-unsaved-scripts', (_event, has: boolean) => {
    hasUnsavedScripts = has === true;
  });

  app.on('before-quit', (event) => {
    if (!hasUnsavedScripts) return;
    if (confirmDiscardUnsavedScripts(win)) {
      hasUnsavedScripts = false;
      return;
    }
    event.preventDefault();
  });

  let url = START_URL;
  if (!url) {
    // Packaged / local-app mode: serve dist/ ourselves.
    const uiRoot = path.join(__dirname, '..', 'dist');
    if (!fs.existsSync(path.join(uiRoot, 'index.html'))) {
      dialog.showErrorBox(
        'Hearth: missing UI build',
        `No built UI found at ${uiRoot}. Run "npm run build -w @hearth/editor" first.`,
      );
      app.quit();
      return;
    }
    const { port } = await startServer(uiRoot);
    url = `http://127.0.0.1:${port}`;
  }

  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: 'Hearth',
    backgroundColor: WINDOW_BACKGROUND,
    center: true,
    // macOS: no title bar of our own — the traffic lights sit inside the
    // sidebar's top strip, which is the drag region (see .sidebar-titlebar).
    // Every other platform keeps its native frame.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 18 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.on('close', (event) => {
    if (!hasUnsavedScripts) return;
    if (confirmDiscardUnsavedScripts(win)) {
      hasUnsavedScripts = false;
      return;
    }
    event.preventDefault();
  });
  win.on('closed', () => {
    win = null;
  });

  // setWindowMode owns the native title; block document.title from racing it
  // (the renderer also sets document.title for browser-tab identity).
  win.webContents.on('page-title-updated', (e) => e.preventDefault());

  // Replay a pending update-ready to every load of the renderer, including a
  // reload — the banner's state lives in the main process, not the page.
  win.webContents.on('did-finish-load', sendUpdateReady);

  // Baseline app menu (app menu + system Edit + Window) so Quit/copy-paste work
  // before a project is open. The renderer replaces it with the full
  // File/Edit/View/Help model once the editor mounts (macOS).
  if (process.platform === 'darwin') applyAppMenu(null, win);

  // External links open in the system browser, not in the editor window.
  win.webContents.setWindowOpenHandler(({ url: external }) => {
    if (external.startsWith('http://127.0.0.1') || external.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    void shell.openExternal(external);
    return { action: 'deny' };
  });

  await win.loadURL(url);

  // One quiet startup check, delayed so it never competes with app boot.
  // Offline/failed checks just log; the user can always check explicitly via
  // Help → Check for updates….
  if (updates) setTimeout(() => updates.checkBackground(), 5000);

  if (SMOKE) {
    // Self-test mode: verify the API responds through the real server, then
    // verify the packaged app can actually spawn a working PTY — the whole
    // point of this file's asarUnpack/external plumbing — then exit. Any
    // failure here must throw so the process exits non-zero: a silently
    // broken native module in a packaged build is exactly what this test
    // exists to catch.
    const meta = await fetch(`${url}/api/meta`).then((r) => r.json());
    console.log('[smoke] /api/meta ok:', JSON.stringify(meta).slice(0, 120));
    console.log('[smoke] window loaded:', win.webContents.getURL());
    smokeTestMenu();
    await smokeTestPty();
    await smokeTestHearthShim();
    console.log('[smoke] all checks passed');
    app.quit();
  }
}

/**
 * Loads @lydell/node-pty exactly the way ptyManager's default backend does
 * (a dynamic import resolved at runtime, never bundled by esbuild — see
 * scripts/build-electron.mjs's `external`), then spawns a real shell and
 * confirms a round-tripped command's output actually arrives. In a packaged
 * app this only succeeds if: the platform prebuild package was installed
 * into release-app/node_modules (scripts/assemble-app.mjs), asarUnpack kept
 * its .node binary a real file on disk (apps/editor/package.json's `build`
 * config), and it's still executable after ad-hoc codesigning on macOS
 * (scripts/afterPack.cjs).
 */
/**
 * Verify the native menu path end-to-end on the main side: build the same
 * template the renderer's model produces, find File → Open folder…, and
 * confirm clicking it dispatches `menu:invoke(open-folder)`. The renderer half
 * (model item id → onSelect) is covered by apps/editor/tests/appMenu.test.ts;
 * this pins the model → native Menu → IPC half that only exists in a real
 * Electron process. Kept structural (no folder needed) so it runs in SMOKE.
 */
function smokeTestMenu(): void {
  const invoked: string[] = [];
  const sample: SerializedMenuSection[] = [
    {
      label: 'File',
      items: [
        { id: 'open-folder', label: 'Open folder…', accelerator: 'CmdOrCtrl+O', enabled: true },
        { type: 'separator' },
        { id: 'close-folder', label: 'Close folder', enabled: false },
      ],
    },
  ];
  const template = buildAppMenuTemplate(sample, (id) => invoked.push(id));
  const menu = Menu.buildFromTemplate(template);
  const file = menu.items.find((i) => i.label === 'File');
  if (!file?.submenu) throw new Error('[smoke] native File menu missing');
  const openFolder = file.submenu.items.find((i) => i.id === 'open-folder');
  if (!openFolder) throw new Error('[smoke] native File → Open folder… missing');
  if (!openFolder.enabled) throw new Error('[smoke] Open folder… should be enabled');
  const closeFolder = file.submenu.items.find((i) => i.id === 'close-folder');
  if (closeFolder?.enabled) throw new Error('[smoke] Close folder should be disabled with no folder open');
  openFolder.click();
  if (!invoked.includes('open-folder')) throw new Error('[smoke] Open folder… click did not dispatch menu:invoke');
  console.log('[smoke] native File → Open folder… dispatches menu:invoke(open-folder)');
}

async function smokeTestPty(): Promise<void> {
  const nodePty = await import('@lydell/node-pty');
  console.log('[smoke] @lydell/node-pty module loaded');

  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
  const marker = 'hearth-pty-ok';
  const pty = nodePty.spawn(shell, [], {
    cwd: os.homedir(),
    cols: 80,
    rows: 24,
    env: process.env,
  });

  await new Promise<void>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      pty.kill();
      reject(new Error(`[smoke] pty did not echo marker within 3s (got: ${JSON.stringify(buffer.slice(-200))})`));
    }, 3000);

    pty.onData((data: string) => {
      buffer += data;
      if (buffer.includes(marker)) {
        clearTimeout(timer);
        pty.kill();
        resolve();
      }
    });

    pty.write(`echo ${marker}\r`);
  });

  console.log('[smoke] pty spawn + echo round-trip ok');
}

/**
 * Prove the packaged PATH shim works end-to-end: build the `hearth` shim for
 * the bundled CLI (resolveToolPaths finds hearth-cli.mjs via HEARTH_TOOLS_DIR),
 * spawn a shell with the shim'd PATH, and confirm `hearth --version` runs
 * successfully. The `&&` gate means the marker only prints if `hearth` was
 * found AND exited 0 — a missing shim or broken CLI fails this loudly, which is
 * the whole point of running it in the packaged smoke build.
 */
async function smokeTestHearthShim(): Promise<void> {
  const toolPaths = await resolveToolPaths(process.cwd());
  const shimDir = await ensureHearthShim(toolPaths.cli, toolPaths.probe);
  const nodePty = await import('@lydell/node-pty');
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
  const marker = 'hearth-shim-ok';
  const pty = nodePty.spawn(shell, [], {
    cwd: os.homedir(),
    cols: 80,
    rows: 24,
    env: hearthPtyEnv(process.env, shimDir),
  });

  await new Promise<void>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      pty.kill();
      reject(new Error(`[smoke] hearth shim did not respond within 5s (got: ${JSON.stringify(buffer.slice(-200))})`));
    }, 5000);

    pty.onData((data: string) => {
      buffer += data;
      if (/not found|No such file|not recognized/.test(buffer)) {
        clearTimeout(timer);
        pty.kill();
        reject(new Error(`[smoke] hearth not on PATH via shim (got: ${JSON.stringify(buffer.slice(-200))})`));
        return;
      }
      if (buffer.includes(marker)) {
        clearTimeout(timer);
        pty.kill();
        resolve();
      }
    });

    pty.write(`hearth --version && echo ${marker}\r`);
  });

  console.log('[smoke] hearth CLI reachable via PATH shim');
}

app.on('window-all-closed', () => {
  app.quit();
});

main().catch((err: unknown) => {
  // In smoke mode this is the whole point: a broken native module in a
  // packaged build must fail the process loudly (non-zero exit) rather than
  // vanish as an unhandled rejection while Electron keeps the window open.
  console.error('[smoke] FAILED:', err instanceof Error ? err.stack ?? err.message : err);
  app.exit(1);
});
