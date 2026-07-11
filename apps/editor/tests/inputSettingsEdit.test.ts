/**
 * Pure logic test for InputSettings' optimistic-edit error path:
 * `updateSettingsErrorMessage` decides what (if anything) to tell the user
 * when a key/gamepad-binding edit fails to persist. Before this fix, a
 * failed edit silently snapped the chip back to server truth with zero
 * explanation. No DOM, no store — mirrors externalChange.test.ts's style.
 */
import { describe, expect, it } from 'vitest';
import { updateSettingsErrorMessage } from '../src/components/InputSettings';

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
