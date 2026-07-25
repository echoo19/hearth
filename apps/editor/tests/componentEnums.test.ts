/**
 * The Inspector renders a `<select>` for any string field with schema-declared
 * enum options, sourced from `doc.enums` — inspectComponents' passthrough of
 * core's COMPONENT_ENUMS, which is derived by walking every COMPONENT_SCHEMAS
 * shape for `z.enum` fields. That derivation is why CharacterController.mode
 * and Health.deathAction need no per-field editor code at all.
 *
 * This pins the contract the Inspector depends on: if a future schema edit
 * turned one of these into a plain `z.string()` (or the derivation stopped
 * unwrapping `.default()`), the field would silently regress to a bare text
 * input and only a human clicking through the editor would notice.
 */
import { describe, expect, it } from 'vitest';
import { CHARACTER_MODES, COMPONENT_ENUMS, DEATH_ACTIONS } from '@hearth/core';

describe('COMPONENT_ENUMS drives the Inspector enum dropdowns', () => {
  it('exposes CharacterController.mode with both movement models', () => {
    expect(COMPONENT_ENUMS.CharacterController?.mode).toEqual([...CHARACTER_MODES]);
  });

  it('exposes Health.deathAction with all three outcomes', () => {
    expect(COMPONENT_ENUMS.Health?.deathAction).toEqual([...DEATH_ACTIONS]);
  });

  it('leaves the non-enum string fields of these components alone', () => {
    // Checkpoint.target and CharacterController.actions.* are free-form
    // strings, so they must NOT arrive as enums — they get their own typed
    // controls (see newComponentFields.test.tsx) instead of a dropdown of
    // schema options that doesn't exist.
    expect(COMPONENT_ENUMS.Checkpoint?.target).toBeUndefined();
    expect(COMPONENT_ENUMS.CharacterController?.actions).toBeUndefined();
  });
});
