// @vitest-environment jsdom
/**
 * A tab strip keeps the promise its role makes.
 *
 * `role="tablist"` and `role="tab"` are not decoration. They tell an assistive
 * technology that this is ONE stop in the tab order, that the arrows move
 * within it, and that each tab controls a panel that says which tab it belongs
 * to. The app had two strips and only one of them kept any of that: the
 * playtest column claimed both roles and implemented none of the behaviour, so
 * a keyboard user found three separate tab stops that arrows did nothing to,
 * and a screen reader was told about tabs that controlled nothing.
 *
 * Two presentations, one rule, so it cannot drift a third time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';
import { nextTabIndex, tabIds } from '../src/components/ui/tabKeys';

vi.mock('../src/components/game/GamePane', () => ({ GamePane: () => <div>game</div> }));
vi.mock('../src/components/tester/TesterStage', () => ({ TesterStage: () => <div>tester</div> }));
vi.mock('../src/components/ConsolePanel', () => ({ ConsolePanel: () => <div>console</div> }));

import { PaneStack } from '../src/components/game/PaneStack';
import { useApp } from '../src/store';

beforeEach(() => {
  useApp.setState({ paneTab: 'game', paneOpen: true, consoleUnread: 0 });
});

afterEach(() => cleanup());

describe('nextTabIndex', () => {
  it('moves both ways and wraps, because a strip is a ring', () => {
    expect(nextTabIndex('ArrowRight', 0, 3)).toBe(1);
    expect(nextTabIndex('ArrowRight', 2, 3)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(nextTabIndex('ArrowLeft', 2, 3)).toBe(1);
  });

  it('takes the vertical arrows too, since a strip may be drawn either way', () => {
    expect(nextTabIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextTabIndex('ArrowUp', 0, 3)).toBe(2);
  });

  it('jumps to the ends', () => {
    expect(nextTabIndex('Home', 2, 3)).toBe(0);
    expect(nextTabIndex('End', 0, 3)).toBe(2);
  });

  it('keeps its hands off every other key', () => {
    // Tab must still leave the strip, and Enter and Space belong to the button.
    for (const key of ['Tab', 'Enter', ' ', 'Escape', 'a', 'PageDown']) {
      expect(nextTabIndex(key, 0, 3)).toBeNull();
    }
  });

  it('answers nothing for an empty strip rather than dividing by it', () => {
    expect(nextTabIndex('ArrowRight', 0, 0)).toBeNull();
  });
});

describe('tabIds', () => {
  it('derives both halves from one id, so they cannot disagree', () => {
    const ids = tabIds('pane', 'tester');
    expect(ids.tab).not.toBe(ids.panel);
    expect(tabIds('pane', 'tester')).toEqual(ids);
  });
});

describe('the playtest column strip', () => {
  it('is one stop in the tab order, not three', () => {
    render(<PaneStack />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    // Exactly one reachable by Tab; the rest are reached with the arrows.
    expect(tabs.filter((tab) => tab.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.getAttribute('tabindex')).toBe('0');
  });

  it('moves and selects on an arrow key', () => {
    render(<PaneStack />);
    const tabs = screen.getAllByRole('tab');
    act(() => {
      tabs[0].focus();
      tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(useApp.getState().paneTab).toBe('tester');
  });

  it('gives every tab a panel that names it back', () => {
    render(<PaneStack />);
    // `hidden` panels are out of the accessibility tree, which is correct, so
    // the pairing is checked on the DOM rather than by role.
    for (const tab of screen.getAllByRole('tab')) {
      const panelId = tab.getAttribute('aria-controls');
      expect(panelId).toBeTruthy();
      const panel = document.getElementById(panelId!);
      expect(panel).toBeTruthy();
      expect(panel!.getAttribute('role')).toBe('tabpanel');
      expect(panel!.getAttribute('aria-labelledby')).toBe(tab.id);
    }
  });

  it('lets the keyboard reach a panel that has nothing focusable in it', () => {
    // The game is an iframe and the console is a log, so without this there is
    // nothing to press Page Down against.
    render(<PaneStack />);
    const panel = document.querySelector('.pane-view:not([hidden])');
    expect(panel?.getAttribute('tabindex')).toBe('0');
  });
});
