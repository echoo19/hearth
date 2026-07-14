/**
 * Hearth desktop preload: exposes native affordances to the renderer.
 * The UI feature-detects `window.hearthNative` — in browser mode it is
 * undefined and the launcher falls back to typed paths.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hearthNative', {
  /** Native "Open Project" folder dialog. Resolves to a path or null. */
  pickProjectFolder: () => ipcRenderer.invoke('hearth:pick-project-folder'),
  /** Native directory chooser for new-project location. */
  pickDirectory: () => ipcRenderer.invoke('hearth:pick-directory'),
  /** Reveal a file/folder in Finder / Explorer. */
  revealInFolder: (path) => ipcRenderer.invoke('hearth:reveal-in-folder', path),
  /** Godot-style window sizing: 'launcher' (compact) or 'editor' (full). */
  setWindowMode: (mode, title) => ipcRenderer.invoke('hearth:window-mode', mode, title),
  /** Push the serialized app-menu model (or null to restore the baseline). */
  setAppMenu: (model) => ipcRenderer.send('hearth:set-app-menu', model),
  /** Subscribe to native-menu clicks; returns an unsubscribe function. */
  onMenuInvoke: (cb) => {
    const listener = (_event, id) => cb(id);
    ipcRenderer.on('menu:invoke', listener);
    return () => ipcRenderer.removeListener('menu:invoke', listener);
  },
  platform: process.platform,
});
