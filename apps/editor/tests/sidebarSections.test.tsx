// @vitest-environment jsdom
/**
 * The rail's harness fold: Connectors.
 *
 * Skills used to be a second fold here, holding names the app could not yet
 * act on. They are real folders now, with their own store and panel, so this
 * file covers what is left: the connector registry.
 *
 * These are insertion slots, so the tests are about honesty as much as
 * rendering:
 *   1. every row says what it is — an ember dot only for the things that
 *      genuinely run, a neutral mark for the merely registered, "soon" for the
 *      things that don't exist yet;
 *   2. adding one really does record it (the round trip goes through the REAL
 *      server module, so validation and the merge are exercised, not faked)
 *      and the confirmation says what actually happened;
 *   3. built-in rows offer nothing to rename or remove; the folder's own rows
 *      offer both;
 *   4. a fold you closed stays closed across a remount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { getHarnessRegistry, postHarnessRegistry, type HarnessHost } from '../server/harnessRegistry';
import { HarnessSections } from '../src/harness/HarnessSections';
import { resetHarnessRegistryCache } from '../src/harness/useRegistry';
import { sectionStorageKey } from '../src/harness/registry';

/** Every folder is open, as far as these tests are concerned — the jail has its own suite. */
const OPEN_HOST: HarnessHost = { serveMounted: async () => ({ status: 404 }) };

let folder: string;

/** fetch, wired straight to the route handlers: a real round trip, no HTTP. */
function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = new URL(String(input), 'http://localhost');
      const result =
        init?.method === 'POST'
          ? await postHarnessRegistry(OPEN_HOST, JSON.parse(String(init.body)))
          : await getHarnessRegistry(OPEN_HOST, url.searchParams.get('project'));
      return {
        ok: result.status < 400,
        status: result.status,
        json: async () => result.body,
      } as Response;
    }),
  );
}

beforeEach(async () => {
  folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-sections-'));
  localStorage.clear();
  resetHarnessRegistryCache();
  installFetch();
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await fsp.rm(folder, { recursive: true, force: true });
});

/** Render the folds and wait for the first load to land. */
async function mount(): Promise<void> {
  render(<HarnessSections projectPath={folder} />);
  await screen.findByText('Web games');
}

function row(name: string): HTMLElement {
  return screen.getByText(name).closest('.harness-row') as HTMLElement;
}

/** The folder's harness file, once the write has landed. */
async function onDisk(): Promise<{ connectors: unknown[]; skills: unknown[] }> {
  return JSON.parse(await fsp.readFile(path.join(folder, '.hearth', 'harness.json'), 'utf8'));
}

/** Add one entry through the inline form, exactly as a user would. */
async function addConnector(name: string, kind: 'mcp' | 'engine', extra: string): Promise<void> {
  fireEvent.click(screen.getByText('Add connector…'));
  fireEvent.change(screen.getByLabelText('Connector name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Connector kind'), { target: { value: kind } });
  fireEvent.change(screen.getByLabelText(kind === 'mcp' ? 'Command' : 'URL'), { target: { value: extra } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText(name);
}

describe('what the rows say', () => {
  it('marks the built-in that genuinely runs, and only that one', async () => {
    await mount();
    expect(within(row('Web games')).getByRole('img', { name: 'Active' })).toBeTruthy();
    expect(within(row('Playtesting')).getByRole('img', { name: 'Active' })).toBeTruthy();
    // Named, not built: a word, never a badge.
    expect(within(row('Godot')).getByText('soon')).toBeTruthy();
    expect(within(row('Godot')).queryByRole('img', { name: 'Active' })).toBeNull();
  });

  it('shows a registered connector as registered — not as active', async () => {
    await mount();
    await addConnector('Acme MCP', 'mcp', 'npx acme-mcp');
    expect(within(row('Acme MCP')).getByRole('img', { name: 'Registered' })).toBeTruthy();
    expect(within(row('Acme MCP')).queryByRole('img', { name: 'Active' })).toBeNull();
  });

  it('offers rename/remove on the folder’s own rows and nothing on built-ins', async () => {
    await mount();
    await addConnector('Acme MCP', 'mcp', '');
    expect(screen.queryByRole('button', { name: /Connector options — Web games/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Connector options — Acme MCP/ })).toBeTruthy();
  });
});

describe('adding something', () => {
  it('records it, keeps what was typed, and says what actually happened', async () => {
    await mount();
    await addConnector('Acme MCP', 'engine', 'http://localhost:9000');

    // The optimistic row lands first; the receipt appears when the write does.
    await screen.findByText('Saved — activates in a future update.');

    expect((await onDisk()).connectors).toEqual([
      {
        id: 'acme-mcp',
        name: 'Acme MCP',
        kind: 'engine',
        status: 'available',
        config: { url: 'http://localhost:9000' },
      },
    ]);
  });

  it('never sends a nameless entry, and cancels back to the row', async () => {
    await mount();
    fireEvent.click(screen.getByText('Add connector…'));
    fireEvent.change(screen.getByLabelText('Connector name'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Connector name')).toBeNull();
    expect(screen.getByText('Add connector…')).toBeTruthy();
  });

  it('keeps the form open and says why when the write is refused', async () => {
    await mount();
    // The next write fails; the row must not survive as if it had been saved.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'Disk is full.' }) }) as Response),
    );
    fireEvent.click(screen.getByText('Add connector…'));
    fireEvent.change(screen.getByLabelText('Connector name'), { target: { value: 'Acme MCP' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('Disk is full.');
    expect(screen.getByLabelText('Connector name')).toBeTruthy();
    expect(screen.queryByText('Saved — activates in a future update.')).toBeNull();
    await waitFor(() => expect(screen.queryByText('Acme MCP')).toBeNull());
  });
});

describe('changing something', () => {
  it('renames a row in place', async () => {
    await mount();
    await addConnector('Acme MCP', 'mcp', '');
    fireEvent.click(screen.getByRole('button', { name: /Connector options — Acme MCP/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));

    const input = screen.getByLabelText('Acme MCP name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Acme tools' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await screen.findByText('Acme tools');
    await waitFor(async () =>
      expect(((await onDisk()).connectors[0] as { name: string }).name).toBe('Acme tools'),
    );
  });

  it('removes a row it added', async () => {
    await mount();
    await addConnector('Acme MCP', 'mcp', '');
    fireEvent.click(screen.getByRole('button', { name: /Connector options — Acme MCP/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));

    await waitFor(() => expect(screen.queryByText('Acme MCP')).toBeNull());
    // The built-ins are untouched — they were never in the file to begin with.
    expect(screen.getByText('Web games')).toBeTruthy();
    await waitFor(async () => expect((await onDisk()).connectors).toEqual([]));
  });
});

describe('the folds', () => {
  it('closes a section and remembers it across a remount', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Connectors' }));

    expect(screen.queryByText('Web games')).toBeNull();
    expect(screen.queryByText('Add connector…')).toBeNull();
    expect(localStorage.getItem(sectionStorageKey('connectors'))).toBe('0');

    cleanup();
    render(<HarnessSections projectPath={folder} />);
    await waitFor(() => expect(screen.queryByText('Web games')).toBeNull());
    expect(screen.getByRole('button', { name: 'Connectors' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('shows nothing at all without an open folder', () => {
    const { container } = render(<HarnessSections projectPath={null} />);
    expect(container.textContent).toBe('');
  });
});
