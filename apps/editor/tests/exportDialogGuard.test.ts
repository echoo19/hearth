/**
 * EXPORTDIALOG-1 (L-099): Escape (the native `<dialog>` `cancel` event) must
 * not dismiss the Export dialog while a desktop export job is running —
 * mirroring the already-disabled Cancel button, so mouse and keyboard users
 * get the same "can't dismiss mid-export" contract. `blocksDialogCancel` is
 * the pure decision ExportDialog.tsx's `guardedClose` calls before it decides
 * whether to `preventDefault()` the native cancel event; this repo has no
 * jsdom/RTL, so the DOM-facing half isn't testable here, but the decision
 * itself is pulled to module scope and covered directly (same pattern as
 * gameSettingsEdit.test.ts / agentPanelGuards.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { blocksDialogCancel } from '../src/components/ExportDialog';

describe('blocksDialogCancel', () => {
  it('blocks Escape while a desktop export job is running', () => {
    expect(blocksDialogCancel(true)).toBe(true);
  });

  it('allows Escape to close the dialog when no job is running', () => {
    expect(blocksDialogCancel(false)).toBe(false);
  });
});
