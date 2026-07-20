/**
 * Clicking a Console entry's link opens the script it points at.
 * ConsolePanel.tsx's `.console-link` button's onClick calls this exact
 * function (see openConsoleLink's export comment) — this repo has no
 * jsdom/RTL, so the click handler is pulled to module scope and unit-tested
 * directly, same pattern as Hierarchy.tsx's isActivationKey
 * (hierarchyA11y.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { openConsoleLink } from '../src/components/ConsolePanel';

describe('openConsoleLink (Console link click)', () => {
  it('calls openScriptAt with the path and line', () => {
    const openScriptAt = vi.fn();
    openConsoleLink({ path: 'scripts/enemy.lua', line: 12 }, openScriptAt);
    expect(openScriptAt).toHaveBeenCalledWith('scripts/enemy.lua', 12);
  });

  it('a null line opens the file with no line argument (opens at the top)', () => {
    const openScriptAt = vi.fn();
    openConsoleLink({ path: 'scripts/enemy.lua', line: null }, openScriptAt);
    expect(openScriptAt).toHaveBeenCalledWith('scripts/enemy.lua', undefined);
  });
});
