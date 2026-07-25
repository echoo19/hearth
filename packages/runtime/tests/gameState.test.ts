/**
 * GameStateStore unit tests: declared keys start at their initial value,
 * writes are type-checked against the declaration, only `persist` keys touch
 * storage, and every real change notifies exactly once.
 */
import { describe, expect, it, vi } from 'vitest';
import { GameStateStore } from '../src/gameState.js';

const decls = {
  score: { type: 'number' as const, initial: 0, persist: false },
  best: { type: 'number' as const, initial: 0, persist: true },
  alive: { type: 'boolean' as const, initial: true, persist: false },
};

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    get: (k: string) => map.get(k) ?? null,
    set: (k: string, v: string) => void map.set(k, v),
    remove: (k: string) => void map.delete(k),
    keys: () => [...map.keys()],
    raw: map,
  };
}

describe('GameStateStore', () => {
  it('starts every declared key at its initial value', () => {
    const store = new GameStateStore(decls, memoryStorage());
    expect(store.get('score')).toBe(0);
    expect(store.get('alive')).toBe(true);
  });

  it('reports declared keys through has and keys', () => {
    const store = new GameStateStore(decls, memoryStorage());
    expect(store.has('score')).toBe(true);
    expect(store.has('nope')).toBe(false);
    expect(store.keys().sort()).toEqual(['alive', 'best', 'score']);
  });

  it('adds to numbers and notifies on change', () => {
    const onChange = vi.fn();
    const store = new GameStateStore(decls, memoryStorage(), onChange);
    store.add('score', 5);
    store.add('score', 3);
    expect(store.get('score')).toBe(8);
    expect(onChange).toHaveBeenLastCalledWith('score', 8, 5);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('does not notify when the value is unchanged', () => {
    const onChange = vi.fn();
    const store = new GameStateStore(decls, memoryStorage(), onChange);
    store.set('score', 0);
    store.add('score', 0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('refuses a value of the wrong type and leaves the old value in place', () => {
    const store = new GameStateStore(decls, memoryStorage());
    expect(() => store.set('score', 'nope' as never)).toThrow(/number/);
    expect(store.get('score')).toBe(0);
  });

  it('refuses add on a non-number key', () => {
    const store = new GameStateStore(decls, memoryStorage());
    expect(() => store.add('alive', 1)).toThrow(/number/);
    expect(store.get('alive')).toBe(true);
  });

  it('throws a declaration hint when writing an undeclared key', () => {
    const store = new GameStateStore(decls, memoryStorage());
    expect(() => store.set('nope', 1)).toThrow(/gameState/);
    expect(() => store.add('nope', 1)).toThrow(/gameState/);
    expect(() => store.reset('nope')).toThrow(/gameState/);
  });

  it('returns null and does not throw for an undeclared key', () => {
    const store = new GameStateStore(decls, memoryStorage());
    expect(store.get('nope')).toBeNull();
  });

  it('persists only keys marked persist, and reloads them', () => {
    const storage = memoryStorage();
    const first = new GameStateStore(decls, storage);
    first.set('best', 42);
    first.set('score', 7);

    const second = new GameStateStore(decls, storage);
    expect(second.get('best')).toBe(42);
    expect(second.get('score')).toBe(0);
  });

  it('falls back to the initial value when stored data is corrupt or mistyped', () => {
    const storage = memoryStorage();
    storage.raw.set('hearth:state:best', 'not json');
    expect(new GameStateStore(decls, storage).get('best')).toBe(0);

    storage.raw.set('hearth:state:best', '"forty-two"');
    expect(new GameStateStore(decls, storage).get('best')).toBe(0);
  });

  it('reset restores one key, or all keys when called with no argument', () => {
    const store = new GameStateStore(decls, memoryStorage());
    store.set('score', 9);
    store.set('alive', false);
    store.reset('score');
    expect(store.get('score')).toBe(0);
    expect(store.get('alive')).toBe(false);
    store.reset();
    expect(store.get('alive')).toBe(true);
  });

  it('reset writes the initial value back through storage for persisted keys', () => {
    const storage = memoryStorage();
    const store = new GameStateStore(decls, storage);
    store.set('best', 12);
    store.reset('best');
    expect(new GameStateStore(decls, storage).get('best')).toBe(0);
  });

  it('works with no declarations at all', () => {
    const store = new GameStateStore({}, memoryStorage());
    expect(store.keys()).toEqual([]);
    expect(store.get('score')).toBeNull();
    expect(() => store.reset()).not.toThrow();
  });
});
