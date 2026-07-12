/**
 * Electron shell generator for `hearth ship` — produces the plain CJS
 * `main.js` and the tiny `package.json` that sit alongside a web export
 * inside the packaged desktop app. The generated files run inside Electron,
 * not in this repo's TS build, so `renderElectronMain` returns a source
 * string rather than emitting a module.
 */

export interface ElectronShellOptions {
  width: number;
  height: number;
  title: string;
}

/**
 * Render the Electron `main.js` entry point as a source string.
 *
 * Hardening (non-negotiable, asserted literally by tests):
 * - `contextIsolation: true`, `nodeIntegration: false`, no preload script.
 * - The window loads the exported `index.html` via `loadFile` — no remote
 *   navigation is ever the initial load.
 * - `will-navigate` and `setWindowOpenHandler` deny anything that isn't the
 *   already-loaded file URL, so links can't escape the shell into a browser
 *   or a remote origin.
 * - F11 and Cmd/Ctrl+F toggle full screen via hidden application-menu
 *   accelerators (no `globalShortcut`, so the binding doesn't leak outside
 *   the app when it isn't focused).
 */
export function renderElectronMain(opts: ElectronShellOptions): string {
  const width = JSON.stringify(opts.width);
  const height = JSON.stringify(opts.height);
  const title = JSON.stringify(opts.title);

  return `'use strict';
const { app, BrowserWindow, Menu } = require('electron');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: ${width},
    height: ${height},
    title: ${title},
    useContentSize: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile('index.html');

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function toggleFullScreen() {
  if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
}

app.whenReady().then(() => {
  createWindow();

  // Hidden application-menu accelerators: fire only while this app is
  // focused (unlike globalShortcut, which would bind system-wide).
  const menu = Menu.buildFromTemplate([
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Full Screen', accelerator: 'F11', visible: false, click: toggleFullScreen },
        { label: 'Toggle Full Screen', accelerator: 'CommandOrControl+F', visible: false, click: toggleFullScreen },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
`;
}

export interface AppPackageJsonOptions {
  name: string;
  version?: string;
}

/** Slugify an app display name into an npm-package-safe, hyphenated slug. */
function slugifyAppName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'hearth-game';
}

/** Render the tiny `package.json` placed alongside `main.js` in the Electron app. */
export function packageJsonForApp(opts: AppPackageJsonOptions): string {
  const pkg = {
    name: slugifyAppName(opts.name),
    version: opts.version ?? '1.0.0',
    main: 'main.js',
    private: true,
  };
  return JSON.stringify(pkg, null, 2) + '\n';
}
