/**
 * Native desktop affordances, exposed by the Electron preload script.
 * `hearthNative()` returns null in browser mode — callers feature-detect.
 */

export interface HearthNative {
  pickProjectFolder(): Promise<string | null>;
  pickDirectory(): Promise<string | null>;
  revealInFolder(path: string): Promise<void>;
  /** Godot-style window sizing: compact launcher vs full editor. */
  setWindowMode(mode: 'launcher' | 'editor', title?: string): Promise<void>;
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
