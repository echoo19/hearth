/**
 * Native desktop affordances, exposed by the Electron preload script.
 * `hearthNative()` returns null in browser mode — callers feature-detect.
 */

import type { SerializedMenuSection } from './menu/appMenu';
import type { UpdateReadyInfo } from './types';

export interface HearthNative {
  pickProjectFolder(): Promise<string | null>;
  pickDirectory(): Promise<string | null>;
  revealInFolder(path: string): Promise<void>;
  /**
   * Tell the main process which folder the window is on (it owns the title).
   * The window is always at working size now — the compact launcher window is
   * gone — so 'launcher' survives only as an alias of 'editor', kept in the
   * union so a renderer and a preload of different vintages still agree.
   */
  setWindowMode(mode: 'launcher' | 'editor', title?: string): Promise<void>;
  /**
   * Push the serialized application menu to the main process (macOS native
   * menu). Pass `null` to restore the baseline app-only menu (project closed).
   */
  setAppMenu(model: SerializedMenuSection[] | null): void;
  /** Mirror whether dirty Code-panel script buffers exist for native close/quit guards. */
  setUnsavedScripts(has: boolean): void;
  /** Subscribe to native-menu clicks (menu:invoke). Returns an unsubscribe fn. */
  onMenuInvoke(cb: (id: string) => void): () => void;
  /**
   * User-invoked update check (Help → Check for updates…). The main process
   * owns the whole flow, including result dialogs. Optional so a renderer
   * updated ahead of its preload (post-update relaunch) degrades gracefully.
   */
  checkForUpdates?(): Promise<void>;
  /**
   * An update has been DOWNLOADED and will install on relaunch. The main
   * process replays the latest value to a late subscriber, so mounting after
   * the download still shows the banner. Returns an unsubscribe fn.
   */
  onUpdateReady?(cb: (info: UpdateReadyInfo) => void): () => void;
  /** Quit and install the downloaded update now (the banner's button). */
  relaunchToUpdate?(): Promise<void>;
  platform: string;
}

declare global {
  interface Window {
    hearthNative?: HearthNative;
  }
}

export function hearthNative(): HearthNative | null {
  return window.hearthNative ?? null;
}
