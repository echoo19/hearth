/**
 * Pure logic test for InputSettings' optimistic-edit error path:
 * `updateSettingsErrorMessage` decides what (if anything) to tell the user
 * when a key/gamepad-binding edit fails to persist. Before this fix, a
 * failed edit silently snapped the chip back to server truth with zero
 * explanation. No DOM, no store — mirrors externalChange.test.ts's style.
 */
import { describe, expect, it } from 'vitest';
import { nameConflictMessage, updateSettingsErrorMessage } from '../src/components/InputSettings';

describe('updateSettingsErrorMessage', () => {
  it('returns null on success — nothing to show', () => {
    expect(updateSettingsErrorMessage({ success: true, errors: [] })).toBeNull();
  });

  it('returns the server error message on failure', () => {
    expect(
      updateSettingsErrorMessage({ success: false, errors: [{ message: 'Action name already in use' }] }),
    ).toBe('Action name already in use');
  });

  it('falls back to a generic message when the errors array is empty', () => {
    expect(updateSettingsErrorMessage({ success: false, errors: [] })).toBe("That didn't save.");
  });
});

describe('nameConflictMessage', () => {
  const axes = { moveX: {}, moveY: {} };

  it('accepts a free name (returns null)', () => {
    expect(nameConflictMessage('axis', 'aim', [axes])).toBeNull();
  });

  it('rejects a blank name', () => {
    expect(nameConflictMessage('axis', '   ', [axes])).toBe('Name can’t be empty.');
  });

  it('rejects a duplicate axis name (INPUT-3)', () => {
    expect(nameConflictMessage('axis', 'moveY', [axes])).toBe('An axis named “moveY” already exists.');
  });

  it('rejects a duplicate action across multiple name maps (INPUT-2)', () => {
    const actions = { jump: [] };
    const gamepadButtons = { dash: [] };
    expect(nameConflictMessage('action', 'dash', [actions, gamepadButtons])).toBe(
      'An action named “dash” already exists.',
    );
  });

  it('treats a rename back to the current name as a no-op, not a conflict (INPUT-1)', () => {
    expect(nameConflictMessage('axis', 'moveX', [axes], 'moveX')).toBeNull();
  });

  it('still rejects a rename onto a different existing name', () => {
    expect(nameConflictMessage('axis', 'moveY', [axes], 'moveX')).toBe(
      'An axis named “moveY” already exists.',
    );
  });
});
