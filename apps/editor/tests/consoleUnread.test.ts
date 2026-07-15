/**
 * Unread console badge (B5 review follow-up, T9-U8): the error badge used to
 * count only while the Console tab was hidden (`!consoleOpen`). It now also
 * counts errors that land while the Console is open but scrolled away from the
 * bottom — the reader can't see new lines there either. Returning to the
 * bottom (or revealing the tab) clears it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../src/store';

function reset(open: boolean, atBottom: boolean) {
  useEditor.setState({ consoleEntries: [], consoleUnread: 0, consoleOpen: open, consoleAtBottom: atBottom });
}

describe('console unread badge — scrolled-away counting', () => {
  beforeEach(() => reset(false, true));

  it('counts an error while the Console tab is hidden (existing behavior)', () => {
    useEditor.getState().log('error', 'runtime', 'boom');
    expect(useEditor.getState().consoleUnread).toBe(1);
  });

  it('does not count non-errors', () => {
    useEditor.getState().log('info', 'editor', 'fine');
    useEditor.getState().log('warn', 'editor', 'hmm');
    expect(useEditor.getState().consoleUnread).toBe(0);
  });

  it('does not count while the Console is open and parked at the bottom', () => {
    reset(true, true);
    useEditor.getState().log('error', 'runtime', 'boom');
    expect(useEditor.getState().consoleUnread).toBe(0);
  });

  it('counts while the Console is open but scrolled away from the bottom', () => {
    reset(true, false);
    useEditor.getState().log('error', 'runtime', 'boom');
    useEditor.getState().log('error', 'runtime', 'boom2');
    expect(useEditor.getState().consoleUnread).toBe(2);
  });

  it('scrolling back to the bottom while open clears the badge', () => {
    reset(true, false);
    useEditor.getState().log('error', 'runtime', 'boom');
    useEditor.getState().setConsoleAtBottom(true);
    expect(useEditor.getState().consoleUnread).toBe(0);
    expect(useEditor.getState().consoleAtBottom).toBe(true);
  });

  it('scrolling to the bottom while the tab is hidden does NOT clear (nothing was seen)', () => {
    reset(false, false);
    useEditor.getState().log('error', 'runtime', 'boom');
    useEditor.getState().setConsoleAtBottom(true);
    expect(useEditor.getState().consoleUnread).toBe(1);
  });

  it('revealing the Console tab still clears the badge', () => {
    useEditor.getState().log('error', 'runtime', 'boom');
    useEditor.getState().setConsoleOpen(true);
    expect(useEditor.getState().consoleUnread).toBe(0);
  });
});
