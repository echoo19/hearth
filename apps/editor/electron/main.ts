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
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createProjectServerContext, handleApiRequest, attachWebSocket } from '../server/projectServer.js';

const SMOKE = process.env.HEARTH_SMOKE === '1';
/** In dev, point the window at the Vite dev server instead of dist/. */
const START_URL = process.env.ELECTRON_START_URL;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/**
 * Serve the built UI (dist/) + the /api routes on a loopback-only port.
 * Serving over http (rather than file://) keeps the renderer identical to
 * browser mode — same-origin fetch('/api/...') works unchanged.
 */
function startServer(uiRoot: string): Promise<{ port: number; close: () => void }> {
  const ctx = createProjectServerContext();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
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
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    // Port 0 = pick any free port; loopback only.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve({ port: address.port, close: () => server.close() });
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
      title: 'Open Hearth Project',
      message: 'Choose a folder containing hearth.json',
      properties: ['openDirectory'],
      buttonLabel: 'Open Project',
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('hearth:pick-directory', async () => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose Location',
      message: 'The project is created in a subfolder here',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Choose',
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('hearth:reveal-in-folder', (_event, target: string) => {
    if (typeof target === 'string' && fs.existsSync(target)) shell.showItemInFolder(target);
  });

  // Godot-style window modes: the app opens as a compact project manager;
  // opening a project grows the same window into the full editor (same
  // BrowserWindow, so no state is lost), closing the project shrinks it back.
  ipcMain.handle('hearth:window-mode', (_event, mode: string, title?: string) => {
    const win = getWindow();
    if (!win) return;
    if (mode === 'editor') {
      win.setMinimumSize(1100, 700);
      const { width, height } = win.getBounds();
      if (width < 1440 || height < 900) {
        win.setSize(1440, 900, true);
        win.center();
      }
      if (!win.isMaximized()) win.maximize();
      win.setTitle(title ? `${title} — Hearth` : 'Hearth');
    } else {
      if (win.isMaximized()) win.unmaximize();
      win.setMinimumSize(880, 600);
      win.setSize(980, 680, true);
      win.center();
      win.setTitle('Hearth — Projects');
    }
  });
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
  registerDialogHandlers(() => win);

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

  // Start as a compact project-manager window (Godot-style); the renderer
  // asks for editor size via hearth:window-mode once a project opens.
  win = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 880,
    minHeight: 600,
    title: 'Hearth — Projects',
    backgroundColor: '#141019',
    center: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.on('closed', () => {
    win = null;
  });

  // External links open in the system browser, not in the editor window.
  win.webContents.setWindowOpenHandler(({ url: external }) => {
    if (external.startsWith('http://127.0.0.1') || external.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    void shell.openExternal(external);
    return { action: 'deny' };
  });

  await win.loadURL(url);

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
    await smokeTestPty();
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
async function smokeTestPty(): Promise<void> {
  const nodePty = await import('@lydell/node-pty');
  console.log('[smoke] @lydell/node-pty module loaded');

  const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
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
