/**
 * localStorageAdapter: per-project key namespacing over a Web Storage
 * backend, with a silent in-memory fallback when localStorage is missing
 * (Node) or throwing (privacy modes).
 */
import { describe, it, expect } from 'vitest';
import { localStorageAdapter, type WebStorageLike } from '../src/pixi/storage.js';

function fakeBackend(): WebStorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe('localStorageAdapter', () => {
  it('namespaces keys as hearth:<projectId>:<key>', () => {
    const backend = fakeBackend();
    const storage = localStorageAdapter('prj_abc123', backend);
    storage.set('bestScore', '42');
    expect(backend.data.get('hearth:prj_abc123:bestScore')).toBe('42');
    expect(storage.get('bestScore')).toBe('42');
  });

  it('returns null for absent keys and removes cleanly', () => {
    const storage = localStorageAdapter('prj_abc123', fakeBackend());
    expect(storage.get('missing')).toBeNull();
    storage.set('k', 'v');
    storage.remove('k');
    expect(storage.get('k')).toBeNull();
    storage.remove('never-set'); // no throw
  });

  it('isolates projects sharing one backend (same origin)', () => {
    const backend = fakeBackend();
    const a = localStorageAdapter('prj_aaa', backend);
    const b = localStorageAdapter('prj_bbb', backend);
    a.set('save', 'A');
    b.set('save', 'B');
    expect(a.get('save')).toBe('A');
    expect(b.get('save')).toBe('B');
  });

  it('falls back to in-memory storage when localStorage is unavailable', () => {
    // Node has no globalThis.localStorage; the adapter must still work.
    const storage = localStorageAdapter('prj_abc123');
    storage.set('k', 'v');
    expect(storage.get('k')).toBe('v');
  });

  it('swallows backend write failures instead of crashing the game', () => {
    const throwing: WebStorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    const storage = localStorageAdapter('prj_abc123', throwing);
    expect(() => storage.set('k', 'v')).not.toThrow();
    expect(storage.get('k')).toBeNull();
    expect(() => storage.remove('k')).not.toThrow();
  });
});
