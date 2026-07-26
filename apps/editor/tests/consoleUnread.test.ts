/**
 * Unread console badge. An error counts as unread whenever the reader can't
 * see the live tail: the Console tab isn't showing, OR it is showing but they
 * have scrolled up to reread something. Returning to the bottom on a visible
 * tab clears it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useApp, type PaneTab } from '../src/store';

function reset(paneTab: PaneTab, atBottom: boolean): void {
  useApp.setState({ consoleEntries: [], consoleUnread: 0, paneTab, consoleAtBottom: atBottom });
}

describe('console unread badge', () => {
  beforeEach(() => reset('game', true));

  it('counts an error while another tab is showing', () => {
    useApp.getState().log('error', 'game', 'boom');
    expect(useApp.getState().consoleUnread).toBe(1);
  });

  it('does not count non-errors', () => {
    useApp.getState().log('info', 'app', 'fine');
    useApp.getState().log('warn', 'app', 'hmm');
    expect(useApp.getState().consoleUnread).toBe(0);
  });

  it('does not count while the Console is showing and parked at the bottom', () => {
    reset('console', true);
    useApp.getState().log('error', 'game', 'boom');
    expect(useApp.getState().consoleUnread).toBe(0);
  });

  it('counts while the Console is showing but scrolled away from the bottom', () => {
    reset('console', false);
    useApp.getState().log('error', 'game', 'boom');
    useApp.getState().log('error', 'game', 'boom2');
    expect(useApp.getState().consoleUnread).toBe(2);
  });

  it('scrolling back to the bottom while showing clears the badge', () => {
    reset('console', false);
    useApp.getState().log('error', 'game', 'boom');
    useApp.getState().setConsoleAtBottom(true);
    expect(useApp.getState().consoleUnread).toBe(0);
    expect(useApp.getState().consoleAtBottom).toBe(true);
  });

  it('scrolling to the bottom on a hidden tab does NOT clear (nothing was seen)', () => {
    reset('game', false);
    useApp.getState().log('error', 'game', 'boom');
    useApp.getState().setConsoleAtBottom(true);
    expect(useApp.getState().consoleUnread).toBe(1);
  });

  it('switching to the Console tab clears the badge', () => {
    useApp.getState().log('error', 'game', 'boom');
    useApp.getState().setPaneTab('console');
    expect(useApp.getState().consoleUnread).toBe(0);
  });
});
