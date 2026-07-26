/**
 * Clicking a Console entry's link opens that file in the code peek. The click
 * handler is module scope, not a component-local closure, so the behavior is
 * unit-tested without a DOM.
 */
import { describe, expect, it, vi } from 'vitest';
import { openConsoleLink } from '../src/components/ConsolePanel';

describe('openConsoleLink (Console link click)', () => {
  it('opens the file the entry points at', () => {
    const openFile = vi.fn();
    openConsoleLink({ path: 'src/enemy.js', line: 12 }, openFile);
    expect(openFile).toHaveBeenCalledWith('src/enemy.js');
  });

  it('opens the file just the same when no line is known', () => {
    const openFile = vi.fn();
    openConsoleLink({ path: 'src/enemy.js', line: null }, openFile);
    expect(openFile).toHaveBeenCalledWith('src/enemy.js');
  });
});
