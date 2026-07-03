/**
 * Browser persistence for GameSession: a SessionStorage backed by
 * window.localStorage, namespaced per project so multiple exported games on
 * one origin never collide. Used by the web player and editor preview.
 *
 * Storage failures (quota, privacy mode) must never crash a game: when
 * localStorage is unavailable the adapter falls back to a Map (session-only
 * persistence), and individual write errors are swallowed.
 */
import type { SessionStorage } from '../session.js';

/** The subset of the Web Storage API the adapter needs (injectable in tests). */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** Web Storage enumeration — needed for ctx.clearSave() with no key. */
  readonly length?: number;
  key?(index: number): string | null;
}

/** `ctx.save`/`ctx.load` persistence under `hearth:<projectId>:<key>`. */
export function localStorageAdapter(projectId: string, backend?: WebStorageLike): SessionStorage {
  const prefix = `hearth:${projectId}:`;
  const store = backend ?? detectLocalStorage() ?? mapStorage();
  return {
    get(key: string): string | null {
      try {
        return store.getItem(prefix + key);
      } catch {
        return null;
      }
    },
    set(key: string, value: string): void {
      try {
        store.setItem(prefix + key, value);
      } catch {
        // Quota exceeded / privacy mode: save data is best-effort.
      }
    },
    remove(key: string): void {
      try {
        store.removeItem(prefix + key);
      } catch {
        // ignore
      }
    },
    keys(): string[] {
      try {
        const out: string[] = [];
        const count = typeof store.length === 'number' && store.key ? store.length : 0;
        for (let i = 0; i < count; i++) {
          const key = store.key!(i);
          if (key && key.startsWith(prefix)) out.push(key.slice(prefix.length));
        }
        return out;
      } catch {
        return [];
      }
    },
  };
}

function detectLocalStorage(): WebStorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: WebStorageLike }).localStorage;
    if (!ls) return null;
    // Some browsers throw on any localStorage access in privacy modes.
    ls.getItem('hearth:probe');
    return ls;
  } catch {
    return null;
  }
}

function mapStorage(): WebStorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
  };
}
