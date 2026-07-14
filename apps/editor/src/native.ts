/**
 * Native desktop affordances, exposed by the Electron preload script.
 * `hearthNative()` returns null in browser mode — callers feature-detect.
 */

import type { SerializedMenuSection } from './menu/appMenu';

export interface HearthNative {
  pickProjectFolder(): Promise<string | null>;
  pickDirectory(): Promise<string | null>;
  revealInFolder(path: string): Promise<void>;
  /** Godot-style window sizing: compact launcher vs full editor. */
  setWindowMode(mode: 'launcher' | 'editor', title?: string): Promise<void>;
  /**
   * Push the serialized application menu to the main process (macOS native
   * menu). Pass `null` to restore the baseline app-only menu (project closed).
   */
  setAppMenu(model: SerializedMenuSection[] | null): void;
  /** Subscribe to native-menu clicks (menu:invoke). Returns an unsubscribe fn. */
  onMenuInvoke(cb: (id: string) => void): () => void;
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
