/**
 * Hearth desktop preload: exposes native affordances to the renderer.
 * The UI feature-detects `window.hearthNative` — in browser mode it is
 * undefined and every caller falls back to a non-native path.
 */
const { contextBridge, ipcRenderer } = require('electron');

/**
 * The last `hearth:update-ready` the main process sent. Held here as well as
 * in main so a component that mounts AFTER the message arrived still learns
 * about it — main replays on page load, the preload replays within one.
 */
let lastUpdateReady = null;
ipcRenderer.on('hearth:update-ready', (_event, info) => {
  lastUpdateReady = info;
});

contextBridge.exposeInMainWorld('hearthNative', {
  /** Native "Open Project" folder dialog. Resolves to a path or null. */
  pickProjectFolder: () => ipcRenderer.invoke('hearth:pick-project-folder'),
  /** Native directory chooser for new-project location. */
  pickDirectory: () => ipcRenderer.invoke('hearth:pick-directory'),
  /** Reveal a file/folder in Finder / Explorer. */
  revealInFolder: (path) => ipcRenderer.invoke('hearth:reveal-in-folder', path),
  /**
   * Silence the game. Mutes the whole window, which is the only thing that
   * reaches a cross-origin frame's WebAudio; the game is the only thing in
   * here that makes a sound.
   */
  setAudioMuted: (muted) => ipcRenderer.invoke('hearth:set-audio-muted', !!muted),
  /** Ensure the working window size and set its title. Both modes are the same. */
  setWindowMode: (mode, title) => ipcRenderer.invoke('hearth:window-mode', mode, title),
  /** Push the serialized app-menu model (or null to restore the baseline). */
  setAppMenu: (model) => ipcRenderer.send('hearth:set-app-menu', model),
  /** Mirror Code-panel dirty script state for native close/quit guards. */
  setUnsavedScripts: (has) => ipcRenderer.send('hearth:set-unsaved-scripts', !!has),
  /** Ask the main process to check for app updates (it owns the dialogs). */
  checkForUpdates: () => ipcRenderer.invoke('hearth:check-for-updates'),
  /**
   * Subscribe to "an update is downloaded and installs on relaunch". A late
   * subscriber is replayed the latest value; returns an unsubscribe function.
   */
  onUpdateReady: (cb) => {
    const listener = (_event, info) => cb(info);
    ipcRenderer.on('hearth:update-ready', listener);
    if (lastUpdateReady) {
      const replayed = lastUpdateReady;
      queueMicrotask(() => cb(replayed));
    }
    return () => ipcRenderer.removeListener('hearth:update-ready', listener);
  },
  /** Quit and install the downloaded update now. */
  relaunchToUpdate: () => ipcRenderer.invoke('hearth:relaunch-to-update'),
  /** Subscribe to native-menu clicks; returns an unsubscribe function. */
  onMenuInvoke: (cb) => {
    const listener = (_event, id) => cb(id);
    ipcRenderer.on('menu:invoke', listener);
    return () => ipcRenderer.removeListener('menu:invoke', listener);
  },
  platform: process.platform,
});
