import { describe, it, expect } from 'vitest';
import { decideExternalChange } from '../src/components/code/externalChange';

/**
 * Exhaustive decision-table coverage for the Code panel's external-change
 * seam. The one invariant that must never break (the Wave E stale-clobber
 * bug class): an external edit is never silently discarded by a later Save
 * without the user explicitly choosing "Keep mine" — i.e. whenever the open
 * buffer is dirty and an external script edit lands, the outcome must be
 * 'banner', never 'reload' (which would blow away unsaved local edits) and
 * never 'ignore' (which would let a later Save clobber the external edit
 * with no warning at all).
 */
describe('decideExternalChange', () => {
  it('ignores entries that originated from this editor session (already reflected locally)', () => {
    expect(
      decideExternalChange({
        openPath: 'scripts/player.lua',
        dirty: false,
        entry: { kind: 'script', source: 'editor', path: 'scripts/player.lua' },
      }),
    ).toBe('ignore');

    expect(
      decideExternalChange({
        openPath: 'scripts/player.lua',
        dirty: true,
        entry: { kind: 'script', source: 'editor', path: 'scripts/player.lua' },
      }),
    ).toBe('ignore');
  });

  it('ignores non-script journal entries regardless of source', () => {
    expect(
      decideExternalChange({
        openPath: 'scripts/player.lua',
        dirty: false,
        entry: { kind: 'scene', source: 'cli', path: 'scripts/player.lua' },
      }),
    ).toBe('ignore');

    expect(
      decideExternalChange({
        openPath: 'scripts/player.lua',
        dirty: true,
        entry: { kind: 'asset', source: 'mcp' },
      }),
    ).toBe('ignore');
  });

  it('ignores everything when no script is open', () => {
    expect(
      decideExternalChange({
        openPath: null,
        dirty: false,
        entry: { kind: 'script', source: 'cli', path: 'scripts/player.lua' },
      }),
    ).toBe('ignore');

    expect(
      decideExternalChange({
        openPath: null,
        dirty: true,
        entry: { kind: 'script', source: 'mcp' },
      }),
    ).toBe('ignore');
  });

  it('ignores a script edit whose path is known and does not match the open path', () => {
    expect(
      decideExternalChange({
        openPath: 'scripts/player.lua',
        dirty: false,
        entry: { kind: 'script', source: 'cli', path: 'scripts/enemy.lua' },
      }),
    ).toBe('ignore');

    expect(
      decideExternalChange({
        openPath: 'scripts/player.lua',
        dirty: true,
        entry: { kind: 'script', source: 'mcp', path: 'scripts/enemy.lua' },
      }),
    ).toBe('ignore');
  });

  it('silently reloads a matching external edit when the buffer is clean', () => {
    expect(
      decideExternalChange({
        openPath: 'scripts/player.lua',
        dirty: false,
        entry: { kind: 'script', source: 'cli', path: 'scripts/player.lua' },
      }),
    ).toBe('reload');

    expect(
      decideExternalChange({
        openPath: 'scripts/player.lua',
        dirty: false,
        entry: { kind: 'script', source: 'mcp', path: 'scripts/player.lua' },
      }),
    ).toBe('reload');
  });

  it('shows the conflict banner (never silently reloads) when the buffer is dirty', () => {
    expect(
      decideExternalChange({
        openPath: 'scripts/player.lua',
        dirty: true,
        entry: { kind: 'script', source: 'cli', path: 'scripts/player.lua' },
      }),
    ).toBe('banner');

    expect(
      decideExternalChange({
        openPath: 'scripts/player.lua',
        dirty: true,
        entry: { kind: 'script', source: 'unknown', path: 'scripts/player.lua' },
      }),
    ).toBe('banner');
  });

  it('treats a script edit with an unknown path as a possible match to the open file (conservative: never clobber)', () => {
    // The core journal doesn't always carry a path (older entries, or a
    // command whose detail extraction didn't populate one) -- when we can't
    // rule the edit out, we must not silently overwrite it.
    expect(
      decideExternalChange({
        openPath: 'scripts/player.lua',
        dirty: false,
        entry: { kind: 'script', source: 'cli' },
      }),
    ).toBe('reload');

    expect(
      decideExternalChange({
        openPath: 'scripts/player.lua',
        dirty: true,
        entry: { kind: 'script', source: 'cli' },
      }),
    ).toBe('banner');
  });
});
