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
import { classifySaveFailure, shouldSave } from '../src/components/CodePanel';

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
