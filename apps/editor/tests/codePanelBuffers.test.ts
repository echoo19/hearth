/**
 * Pure logic tests for the Code panel's multi-buffer model: the tab list is
 * a plain `Buffer[]` + `activePath`, mutated only through the side-effect-free
 * reducers in code/buffers.ts. No DOM, no store, no CodeMirror — the same
 * testing style as externalChange.test.ts and codePanelSave.test.ts.
 *
 * The invariants that must never break:
 *  - dirty is derived per buffer (source !== savedSource, once loaded);
 *  - opening past the cap auto-closes the OLDEST CLEAN buffer, never a dirty
 *    one (unsaved work is never silently discarded);
 *  - closing the active tab hands focus to a sensible neighbour;
 *  - a formatScript/replaceInScripts journal entry carrying `{ paths }` fans
 *    out to one external-change entry per path.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_BUFFERS,
  closeBuffer,
  isDirty,
  makeBuffer,
  openBuffer,
  toExternalChangeEntries,
} from '../src/components/code/buffers';
import type { JournalEntry } from '../src/types';

/** A loaded buffer with the given dirty state, for terse test setup. */
function loaded(path: string, opts: { dirty?: boolean } = {}) {
  return { ...makeBuffer(path), loading: false, source: opts.dirty ? 'edited' : 'clean', savedSource: 'clean' };
}

describe('makeBuffer', () => {
  it('starts loading, clean, and free of banners', () => {
    const b = makeBuffer('scripts/player.lua');
    expect(b.path).toBe('scripts/player.lua');
    expect(b.loading).toBe(true);
    expect(b.conflict).toBe(false);
    expect(b.saveError).toBeNull();
    expect(b.scriptMissing).toBe(false);
    expect(isDirty(b)).toBe(false);
  });
});

describe('isDirty', () => {
  it('is false while the buffer is still loading', () => {
    expect(isDirty({ ...makeBuffer('a'), loading: true, source: 'x', savedSource: 'y' })).toBe(false);
  });
  it('is false when a load failed', () => {
    expect(isDirty({ ...makeBuffer('a'), loading: false, loadError: 'boom', source: 'x', savedSource: 'y' })).toBe(false);
  });
  it('is true when a loaded buffer diverges from its saved source', () => {
    expect(isDirty(loaded('a', { dirty: true }))).toBe(true);
  });
  it('is false when a loaded buffer matches its saved source', () => {
    expect(isDirty(loaded('a'))).toBe(false);
  });
});

describe('openBuffer', () => {
  it('appends a fresh buffer and activates it when the path is new', () => {
    const { state, evicted } = openBuffer({ buffers: [], activePath: null }, 'scripts/a.lua');
    expect(state.buffers.map((b) => b.path)).toEqual(['scripts/a.lua']);
    expect(state.activePath).toBe('scripts/a.lua');
    expect(evicted).toEqual([]);
  });

  it('just activates an already-open buffer without reordering or duplicating', () => {
    const start = { buffers: [loaded('a'), loaded('b')], activePath: 'a' };
    const { state, evicted } = openBuffer(start, 'b');
    expect(state.buffers.map((b) => b.path)).toEqual(['a', 'b']);
    expect(state.activePath).toBe('b');
    expect(evicted).toEqual([]);
  });

  it('auto-closes the oldest CLEAN buffer when opening past the cap', () => {
    const buffers = Array.from({ length: MAX_BUFFERS }, (_, i) => loaded(`s${i}`));
    const { state, evicted } = openBuffer({ buffers, activePath: 's0' }, 'new');
    expect(state.buffers).toHaveLength(MAX_BUFFERS);
    expect(evicted).toEqual(['s0']); // oldest clean one
    expect(state.buffers.map((b) => b.path)).not.toContain('s0');
    expect(state.buffers.map((b) => b.path)).toContain('new');
  });

  it('never auto-closes a dirty buffer, skipping to the next clean one', () => {
    const buffers = [loaded('s0', { dirty: true }), loaded('s1'), ...Array.from({ length: MAX_BUFFERS - 2 }, (_, i) => loaded(`s${i + 2}`))];
    const { state, evicted } = openBuffer({ buffers, activePath: 's0' }, 'new');
    expect(evicted).toEqual(['s1']); // s0 is dirty, so the oldest CLEAN is s1
    expect(state.buffers.map((b) => b.path)).toContain('s0');
  });

  it('exceeds the cap rather than discard unsaved work when every buffer is dirty', () => {
    const buffers = Array.from({ length: MAX_BUFFERS }, (_, i) => loaded(`s${i}`, { dirty: true }));
    const { state, evicted } = openBuffer({ buffers, activePath: 's0' }, 'new');
    expect(evicted).toEqual([]);
    expect(state.buffers).toHaveLength(MAX_BUFFERS + 1);
  });
});

describe('closeBuffer', () => {
  it('removes the buffer and reports it closed', () => {
    const { state, closed } = closeBuffer({ buffers: [loaded('a'), loaded('b')], activePath: 'b' }, 'a');
    expect(closed).toBe(true);
    expect(state.buffers.map((b) => b.path)).toEqual(['b']);
    expect(state.activePath).toBe('b'); // unaffected: we closed a background tab
  });

  it('hands focus to the tab that slides into place when closing the active one', () => {
    const start = { buffers: [loaded('a'), loaded('b'), loaded('c')], activePath: 'b' };
    const { state } = closeBuffer(start, 'b');
    expect(state.buffers.map((b) => b.path)).toEqual(['a', 'c']);
    expect(state.activePath).toBe('c'); // the buffer now at b's old index
  });

  it('falls back to the previous tab when closing the active last tab', () => {
    const start = { buffers: [loaded('a'), loaded('b')], activePath: 'b' };
    const { state } = closeBuffer(start, 'b');
    expect(state.activePath).toBe('a');
  });

  it('clears the active path when the last remaining buffer closes', () => {
    const { state } = closeBuffer({ buffers: [loaded('a')], activePath: 'a' }, 'a');
    expect(state.buffers).toEqual([]);
    expect(state.activePath).toBeNull();
  });

  it('is a no-op for a path that is not open', () => {
    const start = { buffers: [loaded('a')], activePath: 'a' };
    const { state, closed } = closeBuffer(start, 'missing');
    expect(closed).toBe(false);
    expect(state).toBe(start);
  });
});

describe('toExternalChangeEntries', () => {
  const base = { seq: 1, ts: '', source: 'cli', summary: '', ok: true } as const;

  it('maps an editScript entry to a single script entry carrying its path', () => {
    const entry = { ...base, command: 'editScript', detail: { path: 'scripts/a.lua' } } as JournalEntry;
    expect(toExternalChangeEntries(entry)).toEqual([{ kind: 'script', source: 'cli', path: 'scripts/a.lua' }]);
  });

  it('fans a formatScript entry with { paths } out to one entry per path', () => {
    const entry = { ...base, command: 'formatScript', detail: { paths: ['scripts/a.lua', 'scripts/b.lua'] } } as JournalEntry;
    expect(toExternalChangeEntries(entry)).toEqual([
      { kind: 'script', source: 'cli', path: 'scripts/a.lua' },
      { kind: 'script', source: 'cli', path: 'scripts/b.lua' },
    ]);
  });

  it('fans a replaceInScripts entry with { paths } out per path', () => {
    const entry = { ...base, command: 'replaceInScripts', detail: { paths: ['scripts/a.lua'] } } as JournalEntry;
    expect(toExternalChangeEntries(entry)).toEqual([{ kind: 'script', source: 'cli', path: 'scripts/a.lua' }]);
  });

  it('treats a non-script command as its own kind with no path', () => {
    const entry = { ...base, command: 'moveEntity', detail: undefined } as JournalEntry;
    expect(toExternalChangeEntries(entry)).toEqual([{ kind: 'moveEntity', source: 'cli', path: undefined }]);
  });

  it('yields a single path-less script entry when detail carries neither path nor paths', () => {
    const entry = { ...base, command: 'editScript', detail: undefined } as JournalEntry;
    expect(toExternalChangeEntries(entry)).toEqual([{ kind: 'script', source: 'cli', path: undefined }]);
  });
});
