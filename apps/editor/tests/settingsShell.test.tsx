// @vitest-environment jsdom
/**
 * The settings panel: the rail, the search that filters it, and the registry
 * the panes plug into.
 *
 * Three things are worth pinning down here, and they are all about the shell
 * rather than about any one pane:
 *
 *   1. the registry's shape — the panes are written by different people, and a
 *      missing icon or a group nobody draws is the kind of mistake that only
 *      shows up as a blank row;
 *   2. the search, which is a pure function and tested as one: every word has
 *      to hit, and the order must stay the registry's so a filtered rail does
 *      not reshuffle under the cursor;
 *   3. that opening the dialog actually lands somewhere — on the first pane,
 *      with the rail saying so.
 *
 * The panes themselves are stubbed down to their heading. This suite is about
 * routing, and the real Agents and Usage panes talk to the network on mount;
 * letting them do that here would make a test of the rail fail for reasons in
 * a different file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../src/components/settings/GeneralPane', () => ({
  GeneralPane: () => <h2 className="set-pane-title">General</h2>,
}));
vi.mock('../src/components/settings/PersonalizationPane', () => ({
  PersonalizationPane: () => <h2 className="set-pane-title">Personalization</h2>,
}));
vi.mock('../src/components/settings/AgentsPane', () => ({
  AgentsPane: () => <h2 className="set-pane-title">Agents</h2>,
}));
vi.mock('../src/components/settings/UsagePane', () => ({
  UsagePane: () => <h2 className="set-pane-title">Usage</h2>,
}));
vi.mock('../src/components/settings/SkillsPane', () => ({
  SkillsPane: () => <h2 className="set-pane-title">Skills</h2>,
}));

import { SETTINGS_GROUPS, SETTINGS_PANES, filterPanes } from '../src/components/settings/panes';
import { SettingsShell } from '../src/components/settings/SettingsShell';
import { CLOSE_SETTINGS_EVENT, OPEN_SETTINGS_EVENT, SettingsDialog } from '../src/components/shell/SettingsDialog';

// jsdom implements neither showModal nor close, and the Modal effect calls
// both. Model them as a plain open/close toggle, as modalShowModal.test.tsx
// does — the panel's contents are what this suite is looking at.
beforeEach(() => {
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  proto.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(cleanup);

/** Every rail button, in the order the rail draws them. */
function railLabels(): string[] {
  return [...document.querySelectorAll('.set-rail-item')].map((item) => item.textContent ?? '');
}

/** The pane the rail says you are on. */
function currentRailLabel(): string | undefined {
  return document.querySelector('.set-rail-item[aria-current="true"]')?.textContent ?? undefined;
}

describe('the pane registry', () => {
  it('holds the settings panes and Skills, in rail order', () => {
    expect(SETTINGS_PANES.map((pane) => pane.id)).toEqual([
      'general',
      'personalization',
      'agents',
      'usage',
      'skills',
    ]);
  });

  it('gives every pane a label, an icon, a component and a group that is drawn', () => {
    const drawn = new Set(SETTINGS_GROUPS.map((group) => group.id));
    for (const pane of SETTINGS_PANES) {
      expect(pane.label).not.toBe('');
      expect(pane.icon).not.toBe('');
      expect(typeof pane.Component).toBe('function');
      expect(drawn.has(pane.group)).toBe(true);
    }
  });

  it('has no two panes claiming the same id', () => {
    expect(new Set(SETTINGS_PANES.map((pane) => pane.id)).size).toBe(SETTINGS_PANES.length);
  });
});

describe('the rail search', () => {
  it('returns everything for a blank or whitespace query', () => {
    expect(filterPanes(SETTINGS_PANES, '')).toHaveLength(SETTINGS_PANES.length);
    expect(filterPanes(SETTINGS_PANES, '   ')).toHaveLength(SETTINGS_PANES.length);
  });

  it('matches a label regardless of case', () => {
    expect(filterPanes(SETTINGS_PANES, 'PERSONAL').map((pane) => pane.id)).toEqual(['personalization']);
  });

  it('matches on keywords the label never mentions', () => {
    expect(filterPanes(SETTINGS_PANES, 'anthropic').map((pane) => pane.id)).toEqual(['agents']);
    expect(filterPanes(SETTINGS_PANES, 'tokens').map((pane) => pane.id)).toEqual(['usage']);
    expect(filterPanes(SETTINGS_PANES, 'version').map((pane) => pane.id)).toEqual(['general']);
  });

  it('narrows on every word rather than widening', () => {
    // "instructions" alone is on more than one pane; the second word has to
    // cut it down, which an OR would not do.
    expect(filterPanes(SETTINGS_PANES, 'instructions').length).toBeGreaterThan(1);
    expect(filterPanes(SETTINGS_PANES, 'api key').map((pane) => pane.id)).toEqual(['agents']);
  });

  it('keeps the registry order, whatever order the words hit in', () => {
    const matched = filterPanes(SETTINGS_PANES, 'e').map((pane) => pane.id);
    const registryOrder = SETTINGS_PANES.map((pane) => pane.id).filter((id) => matched.includes(id));
    expect(matched).toEqual(registryOrder);
  });

  it('answers with nothing when nothing matches', () => {
    expect(filterPanes(SETTINGS_PANES, 'kerning')).toEqual([]);
  });
});

describe('the panel', () => {
  it('opens on the first pane, and says so in the rail', () => {
    render(<SettingsShell />);
    expect(screen.getByRole('heading', { level: 2, name: 'General' })).toBeTruthy();
    expect(currentRailLabel()).toBe('General');
  });

  it('draws both headings, with their own panes under them', () => {
    render(<SettingsShell />);
    const settings = screen.getByRole('list', { name: 'Settings' });
    const customize = screen.getByRole('list', { name: 'Customize' });
    expect(within(settings).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'General',
      'Personalization',
      'Agents',
      'Usage',
    ]);
    expect(within(customize).getAllByRole('button').map((button) => button.textContent)).toEqual(['Skills']);
  });

  it('switches the pane when a rail item is clicked', () => {
    render(<SettingsShell />);
    fireEvent.click(screen.getByRole('button', { name: 'Usage' }));
    expect(screen.getByRole('heading', { level: 2, name: 'Usage' })).toBeTruthy();
    expect(currentRailLabel()).toBe('Usage');
  });

  it('filters the rail without replacing the pane you are reading', () => {
    render(<SettingsShell />);
    fireEvent.change(screen.getByLabelText('Search settings'), { target: { value: 'tokens' } });
    expect(railLabels()).toEqual(['Usage']);
    // Still on General: a search narrows a list of destinations, it does not
    // navigate for you.
    expect(screen.getByRole('heading', { level: 2, name: 'General' })).toBeTruthy();
  });

  it('drops a heading whose panes all filtered out', () => {
    render(<SettingsShell />);
    fireEvent.change(screen.getByLabelText('Search settings'), { target: { value: 'skill' } });
    expect(railLabels()).toEqual(['Skills']);
    expect(screen.queryByRole('list', { name: 'Settings' })).toBeNull();
    expect(screen.getByRole('list', { name: 'Customize' })).toBeTruthy();
  });

  it('says so instead of showing an empty rail', () => {
    render(<SettingsShell />);
    fireEvent.change(screen.getByLabelText('Search settings'), { target: { value: 'kerning' } });
    expect(railLabels()).toEqual([]);
    expect(screen.getByText(/Nothing here matches/)).toBeTruthy();
  });
});

describe('the way out', () => {
  it('offers a close control, because Escape is invisible', () => {
    // The panel has no header of its own (each pane carries its heading) and
    // no footer (each pane commits its own changes), so before this there was
    // nothing on screen to click and the only exit was a key nobody was told
    // about.
    const onClose = vi.fn();
    render(<SettingsShell onClose={onClose} />);
    const close = screen.getByRole('button', { name: 'Close settings' });
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders no close control when nobody is listening for one', () => {
    render(<SettingsShell />);
    expect(screen.queryByRole('button', { name: 'Close settings' })).toBeNull();
  });
});

describe('the dialog', () => {
  it('shows nothing until the open event, then shows the first pane', () => {
    render(<SettingsDialog />);
    expect(screen.queryByRole('heading', { level: 2, name: 'General' })).toBeNull();

    fireEvent(window, new Event(OPEN_SETTINGS_EVENT));
    expect(screen.getByRole('heading', { level: 2, name: 'General' })).toBeTruthy();
    expect(currentRailLabel()).toBe('General');
  });

  it('lands on the pane the opener asked for', () => {
    render(<SettingsDialog />);
    fireEvent(window, new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { pane: 'agents' } }));
    expect(currentRailLabel()).toBe('Agents');
  });

  it('falls back to the first pane when asked for one that does not exist', () => {
    render(<SettingsDialog />);
    fireEvent(window, new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { pane: 'kerning' } }));
    expect(currentRailLabel()).toBe('General');
  });

  it('closes when a pane sends you somewhere else', () => {
    render(<SettingsDialog />);
    fireEvent(window, new Event(OPEN_SETTINGS_EVENT));
    expect(screen.getByRole('heading', { level: 2, name: 'General' })).toBeTruthy();

    fireEvent(window, new Event(CLOSE_SETTINGS_EVENT));
    expect(screen.queryByRole('heading', { level: 2, name: 'General' })).toBeNull();
  });
});
