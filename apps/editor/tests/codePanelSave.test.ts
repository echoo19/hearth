/**
 * Pure logic tests for the Code panel's save path: `shouldSave` (the guard
 * that makes Cmd+S on a clean buffer a true no-op — CM6's local `Mod-s`
 * keymap calls onSave() unconditionally, bypassing the toolbar Save
 * button's own `disabled={!dirty || saving}`) and `classifySaveFailure`
 * (routes a NOT_FOUND editScript failure to the "script no longer exists"
 * recovery path instead of a generic save-error banner). No DOM, no store —
 * mirrors the style of externalChange.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { classifySaveFailure, shouldBlockSaveForDrift, shouldLintViaPath, shouldSave } from '../src/components/CodePanel';

describe('shouldSave', () => {
  it('allows a save when a script is open, dirty, and not already saving', () => {
    expect(shouldSave({ selectedPath: 'scripts/player.lua', saving: false, dirty: true })).toBe(true);
  });

  it('blocks a save on a clean buffer (the Cmd+S no-op case)', () => {
    expect(shouldSave({ selectedPath: 'scripts/player.lua', saving: false, dirty: false })).toBe(false);
  });

  it('blocks a save while one is already in flight', () => {
    expect(shouldSave({ selectedPath: 'scripts/player.lua', saving: true, dirty: true })).toBe(false);
  });

  it('blocks a save when no script is open', () => {
    expect(shouldSave({ selectedPath: null, saving: false, dirty: true })).toBe(false);
  });
});

describe('classifySaveFailure', () => {
  it('classifies a NOT_FOUND error as "missing" (the script was undone/reverted)', () => {
    expect(classifySaveFailure([{ code: 'NOT_FOUND', message: 'Script not found: scripts/player.lua' }])).toEqual({
      kind: 'missing',
    });
  });

  it('classifies any other error code as a generic error with its message', () => {
    expect(classifySaveFailure([{ code: 'INVALID_INPUT', message: 'Bad path' }])).toEqual({
      kind: 'error',
      message: 'Bad path',
    });
  });

  it('falls back to a generic message when the errors array is empty', () => {
    expect(classifySaveFailure([])).toEqual({ kind: 'error', message: 'Save failed.' });
  });
});

describe('shouldBlockSaveForDrift (L-054 save-time external-edit guard)', () => {
  it('blocks the save when disk drifted from the saved baseline', () => {
    expect(shouldBlockSaveForDrift({ conflict: false, onDisk: 'external edit', savedSource: 'original' })).toBe(true);
  });

  it('allows the save when disk still matches the baseline', () => {
    expect(shouldBlockSaveForDrift({ conflict: false, onDisk: 'same', savedSource: 'same' })).toBe(false);
  });

  it('does not block when a conflict is already flagged (banner up / kept-mine)', () => {
    expect(shouldBlockSaveForDrift({ conflict: true, onDisk: 'external edit', savedSource: 'original' })).toBe(false);
  });

  it('does not block when the on-disk read failed (null → cannot compare)', () => {
    expect(shouldBlockSaveForDrift({ conflict: false, onDisk: null, savedSource: 'original' })).toBe(false);
  });
});

describe('shouldLintViaPath (require diagnostics only against a disk-matching buffer)', () => {
  const clean = { loading: false, loadError: null, savedSource: 'return {}' };

  it('uses path mode when the buffer matches its on-disk baseline', () => {
    expect(shouldLintViaPath('return {}', clean)).toBe(true);
  });

  it('falls back to source mode for a dirty buffer (path mode would lint the FILE, not the edits)', () => {
    expect(shouldLintViaPath('return { edited = true }', clean)).toBe(false);
  });

  it('falls back to source mode while loading, after a load error, or with no buffer', () => {
    expect(shouldLintViaPath('return {}', { ...clean, loading: true, savedSource: 'return {}' })).toBe(false);
    expect(shouldLintViaPath('return {}', { ...clean, loadError: 'boom' })).toBe(false);
    expect(shouldLintViaPath('return {}', undefined)).toBe(false);
  });
});
