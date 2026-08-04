// @vitest-environment jsdom
/**
 * The Publishing pane: which of its states it is in, and what each one is
 * willing to claim.
 *
 * The pane holds one credential, so the tests that matter are about honesty
 * rather than about layout:
 *
 *   1. the three states the user can be in each say the right thing, and the
 *      third one — a stored token the catalog has stopped accepting — never
 *      renders as Connected, whatever else the body says alongside the error;
 *   2. a read that did not come back is not an answer: a null account renders
 *      as "could not check" with the check offered again, never as "no
 *      account";
 *   3. the shape check costs no round trip, so an obvious typo is answered
 *      here — and it is a warning rather than a gate, so a second press sends
 *      it anyway;
 *   4. when the catalog refuses a token, ITS sentence is what appears;
 *   5. disconnecting asks first, and asking is not doing.
 *
 * The server answers 501 to all of this today, which is why the mocks below
 * model a refusal as carefully as a success: a refusal is what this pane will
 * actually meet first, and it has to render as a clean sentence rather than as
 * a blank pane or a confident "not connected".
 *
 * jsdom cannot see layout, so nothing here claims the pane LOOKS right. Every
 * assertion is about the words on it and the requests behind them.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { CatalogAccount } from '../src/api';

// Hoisted, because `vi.mock` is: the factory runs while this file's own
// imports are still being evaluated.
const { catalogAccount, catalogConnect, catalogDisconnect } = vi.hoisted(() => ({
  catalogAccount: vi.fn(async (): Promise<CatalogAccount | null> => null),
  catalogConnect: vi.fn(
    async (): Promise<{ ok: boolean; username?: string; error?: string }> => ({ ok: true, username: 'ashe' }),
  ),
  catalogDisconnect: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
}));

// The pane is the only thing under test; the rest of api.ts still has to be
// itself, because the module graph around it expects the real thing.
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return {
    ...actual,
    apiCatalogAccount: catalogAccount,
    apiCatalogConnect: catalogConnect,
    apiCatalogDisconnect: catalogDisconnect,
  };
});

import {
  CATALOG_TOKENS_URL,
  PublishingPane,
  TOKEN_PREFIX,
  accountLabel,
  catalogState,
  catalogTokenProblem,
} from '../src/components/settings/PublishingPane';
import { SETTINGS_PANES, filterPanes } from '../src/components/settings/panes';

/** A token that passes the shape check: the prefix and 40 hex characters. */
const GOOD_TOKEN = `${TOKEN_PREFIX}${'a1b2c3d4e5'.repeat(4)}`;

function account(over: Partial<CatalogAccount> = {}): CatalogAccount {
  return { connected: true, username: 'ashe', api: 'https://catalog.hearthengine.com', ...over };
}

beforeEach(() => {
  // jsdom implements neither showModal nor close; the ConfirmDialog only needs
  // them to be open/close toggles.
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  proto.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  catalogAccount.mockReset();
  catalogAccount.mockResolvedValue(null);
  catalogConnect.mockReset();
  catalogConnect.mockResolvedValue({ ok: true, username: 'ashe' });
  catalogDisconnect.mockReset();
  catalogDisconnect.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
});

/** Render, and wait for the mount read to land so nothing asserts on "reading". */
async function mount(): Promise<void> {
  render(<PublishingPane />);
  await waitFor(() => expect(catalogAccount).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText(/Checking this machine/)).toBeNull());
}

// ---------------------------------------------------------------------------
// The state machine, on its own
// ---------------------------------------------------------------------------

describe('which state the pane is in', () => {
  it('claims nothing while the read is in flight', () => {
    expect(catalogState(null, 'reading')).toBe('reading');
    // Even with an account already in hand, a fresh read in flight is not a
    // moment to redraw a claim from stale data.
    expect(catalogState(account(), 'reading')).toBe('reading');
  });

  it('reads a null as a failed read, never as "no account"', () => {
    expect(catalogState(null, 'failed')).toBe('unreadable');
    // ...and `ok` with a null body is the same thing: `apiCatalogAccount`
    // answers null for a transport failure, a refusal and a malformed body
    // alike, so there is no null anywhere that means "connected: false".
    expect(catalogState(null, 'ok')).toBe('unreadable');
  });

  it('separates connected from disconnected', () => {
    expect(catalogState(account({ connected: true }), 'ok')).toBe('connected');
    expect(catalogState(account({ connected: false, username: null }), 'ok')).toBe('disconnected');
  });

  it('lets a stored error beat connected, whatever else the body says', () => {
    // The one that matters. A server that knows whose token it is and has just
    // been told the catalog will not take it can honestly answer
    // `connected: true` with an error beside it, and reading that as connected
    // is how a pane shows green to someone whose next publish will fail.
    expect(catalogState(account({ connected: true, error: 'That token was revoked.' }), 'ok')).toBe('stale');
    expect(catalogState(account({ connected: false, error: 'That token has expired.' }), 'ok')).toBe('stale');
  });

  it('does not treat an empty error string as a failure', () => {
    expect(catalogState(account({ error: '' }), 'ok')).toBe('connected');
    expect(catalogState(account({ error: '   ' }), 'ok')).toBe('connected');
  });

  it('never invents a username', () => {
    expect(accountLabel('ashe')).toBe('@ashe');
    expect(accountLabel(null)).toBe('your catalog account');
    expect(accountLabel('')).toBe('your catalog account');
    expect(accountLabel(undefined)).toBe('your catalog account');
  });
});

// ---------------------------------------------------------------------------
// The shape check
// ---------------------------------------------------------------------------

describe('what looks wrong with a pasted token', () => {
  it('passes a well-formed one', () => {
    expect(catalogTokenProblem(GOOD_TOKEN)).toBeNull();
    // Trimmed, because a paste that picked up a trailing newline is a paste
    // that is otherwise perfect.
    expect(catalogTokenProblem(`  ${GOOD_TOKEN}\n`)).toBeNull();
    // Hex is hex in either case.
    expect(catalogTokenProblem(`${TOKEN_PREFIX}${'A1B2C3D4E5'.repeat(4)}`)).toBeNull();
  });

  it('names the mistake rather than the rule', () => {
    expect(catalogTokenProblem('')).toMatch(/Paste a token/);
    expect(catalogTokenProblem(`${TOKEN_PREFIX}${'a1b2c3d4e5'.repeat(2)} ${'a1b2c3d4e5'.repeat(2)}`)).toMatch(
      /space or a line break/,
    );
    expect(catalogTokenProblem(`sk-ant-${'a'.repeat(40)}`)).toMatch(/begin with hpub_/);
    expect(catalogTokenProblem(`${TOKEN_PREFIX}a1b2c3`)).toMatch(/shorter/);
    expect(catalogTokenProblem(`${TOKEN_PREFIX}${'a1b2c3d4e5'.repeat(5)}`)).toMatch(/longer/);
    expect(catalogTokenProblem(`${TOKEN_PREFIX}${'z'.repeat(40)}`)).toMatch(/hexadecimal/);
  });
});

// ---------------------------------------------------------------------------
// The three states, rendered
// ---------------------------------------------------------------------------

describe('the pane, rendered', () => {
  it('offers the token field and the way to get one when nothing is connected', async () => {
    catalogAccount.mockResolvedValue(account({ connected: false, username: null }));
    await mount();

    expect(screen.getByText(/Connect your catalog account/)).toBeTruthy();
    // One line on what the thing is for.
    expect(screen.getByText(/proves a publish is yours/)).toBeTruthy();

    const field = screen.getByLabelText('Catalog token') as HTMLInputElement;
    // A secret behaves like one.
    expect(field.type).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('off');
    expect(field.getAttribute('spellcheck')).toBe('false');
    // Nothing comes back from the server, so the box starts empty and that
    // emptiness is the truth rather than a mask over something stored.
    expect(field.value).toBe('');

    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
    const link = screen.getByRole('link', { name: /Create one on the catalog/ });
    expect(link.getAttribute('href')).toBe(CATALOG_TOKENS_URL);
  });

  it('says who it is connected as and which instance, and offers Disconnect', async () => {
    catalogAccount.mockResolvedValue(account({ api: 'https://catalog.hearthengine.com' }));
    await mount();

    expect(screen.getByText(/Connected as @ashe/)).toBeTruthy();
    expect(screen.getByText('https://catalog.hearthengine.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
    // Connecting is done; there is nothing to paste, so there is no field.
    expect(screen.queryByLabelText('Catalog token')).toBeNull();
  });

  it('does not sit there claiming to be connected when the stored token has stopped working', async () => {
    catalogAccount.mockResolvedValue(
      account({ connected: true, error: 'That token was revoked on 2 August.' }),
    );
    await mount();

    // Not "Connected as @ashe", even though the body said `connected: true`.
    expect(screen.queryByText(/Connected as/)).toBeNull();
    expect(screen.getByText(/no longer working/)).toBeTruthy();
    // The catalog's own words, not a house paraphrase.
    expect(screen.getByText('That token was revoked on 2 August.')).toBeTruthy();
    // ...and the way out is right there: reconnect, or drop it.
    expect(screen.getByLabelText('Catalog token')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  });

  it('renders a read that did not come back as that, with the read offered again', async () => {
    // What the 501 server actually produces today: `apiCatalogAccount` answers
    // null, and null is not permission to say "no account".
    catalogAccount.mockResolvedValue(null);
    await mount();

    expect(screen.getByText(/could not check for a token/)).toBeTruthy();
    expect(screen.queryByText(/Connect your catalog account/)).toBeNull();
    // Never a dead end with nothing to press.
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(catalogAccount).toHaveBeenCalledTimes(2));
  });
});

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

describe('connecting', () => {
  it('answers an obvious typo without a round trip', async () => {
    catalogAccount.mockResolvedValue(account({ connected: false, username: null }));
    await mount();

    fireEvent.change(screen.getByLabelText('Catalog token'), { target: { value: 'hpub_nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(screen.getByRole('alert').textContent).toMatch(/shorter/);
    // The whole point: nothing left the renderer.
    expect(catalogConnect).not.toHaveBeenCalled();
  });

  it('warns rather than gates, so a second press sends it anyway', async () => {
    catalogAccount.mockResolvedValue(account({ connected: false, username: null }));
    await mount();

    fireEvent.change(screen.getByLabelText('Catalog token'), { target: { value: 'hpub_nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    // The button says what the next press will do.
    const anyway = screen.getByRole('button', { name: 'Connect anyway' });
    fireEvent.click(anyway);
    await waitFor(() => expect(catalogConnect).toHaveBeenCalledWith('hpub_nope'));
  });

  it('takes the warning back the moment the field is edited', async () => {
    catalogAccount.mockResolvedValue(account({ connected: false, username: null }));
    await mount();

    const field = screen.getByLabelText('Catalog token');
    fireEvent.change(field, { target: { value: 'hpub_nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.queryByRole('alert')).toBeTruthy();

    // A fresh string gets a fresh look, rather than being saved on the
    // strength of having been told about the previous one.
    fireEvent.change(field, { target: { value: 'hpub_also-nope' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(catalogConnect).not.toHaveBeenCalled();
  });

  it('sends a well-formed token and re-reads the truth rather than drawing what it hoped', async () => {
    catalogAccount.mockResolvedValue(account({ connected: false, username: null }));
    await mount();

    catalogAccount.mockResolvedValue(account({ connected: true, username: 'ashe' }));
    fireEvent.change(screen.getByLabelText('Catalog token'), { target: { value: GOOD_TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(catalogConnect).toHaveBeenCalledWith(GOOD_TOKEN));
    await waitFor(() => expect(screen.getByText(/Connected as @ashe/)).toBeTruthy());
    // The state came from a second read, not from the connect response.
    expect(catalogAccount).toHaveBeenCalledTimes(2);
  });

  it("shows the catalog's own sentence when the catalog refuses", async () => {
    catalogAccount.mockResolvedValue(account({ connected: false, username: null }));
    await mount();

    catalogConnect.mockResolvedValue({ ok: false, error: 'This token belongs to a suspended account.' });
    fireEvent.change(screen.getByLabelText('Catalog token'), { target: { value: GOOD_TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByText('This token belongs to a suspended account.')).toBeTruthy());
    // A refusal is not a connection, and the pane does not re-read on one.
    expect(screen.queryByText(/Connected as/)).toBeNull();
    expect(catalogAccount).toHaveBeenCalledTimes(1);
  });

  it('still says something when a refusal arrives with no sentence in it', async () => {
    // What a bare 501 with an empty envelope produces. A silent failure that
    // leaves the button looking pressed is worse than a plain sentence.
    catalogAccount.mockResolvedValue(account({ connected: false, username: null }));
    await mount();

    catalogConnect.mockResolvedValue({ ok: false });
    fireEvent.change(screen.getByLabelText('Catalog token'), { target: { value: GOOD_TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByText(/would not accept that token/)).toBeTruthy());
  });
});

// ---------------------------------------------------------------------------
// The destructive one
// ---------------------------------------------------------------------------

describe('disconnecting asks first', () => {
  it('does not touch the server until the confirm is pressed', async () => {
    catalogAccount.mockResolvedValue(account());
    await mount();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    // Asking is not doing.
    expect(catalogDisconnect).not.toHaveBeenCalled();
    // And the confirm says what is actually lost, since the token cannot come
    // back and the person has to make a new one.
    expect(screen.getByText('Disconnect the catalog account?')).toBeTruthy();
    expect(screen.getByText(/cannot get it back/)).toBeTruthy();

    const confirms = screen.getAllByRole('button', { name: 'Disconnect' });
    catalogAccount.mockResolvedValue(account({ connected: false, username: null }));
    fireEvent.click(confirms[confirms.length - 1]);

    await waitFor(() => expect(catalogDisconnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/Connect your catalog account/)).toBeTruthy());
  });

  it('leaves the token alone when the confirm is cancelled', async () => {
    catalogAccount.mockResolvedValue(account());
    await mount();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Disconnect the catalog account?')).toBeNull());
    expect(catalogDisconnect).not.toHaveBeenCalled();
    expect(screen.getByText(/Connected as @ashe/)).toBeTruthy();
  });

  it('says so when the server will not drop the token', async () => {
    catalogAccount.mockResolvedValue(account());
    await mount();

    catalogDisconnect.mockResolvedValue({ ok: false, error: 'Could not write to ~/.hearth.' });
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const confirms = screen.getAllByRole('button', { name: 'Disconnect' });
    fireEvent.click(confirms[confirms.length - 1]);

    await waitFor(() => expect(screen.getByText('Could not write to ~/.hearth.')).toBeTruthy());
    // Still connected, because nothing was removed.
    expect(screen.getByText(/Connected as @ashe/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe('the pane is registered', () => {
  it('sits under Settings with the words someone would actually type', () => {
    const pane = SETTINGS_PANES.find((p) => p.id === 'publishing');
    expect(pane).toBeTruthy();
    expect(pane?.group).toBe('settings');
    expect(pane?.label).toBe('Publishing');
    for (const word of ['catalog', 'publish', 'token', 'upload']) {
      expect(filterPanes(SETTINGS_PANES, word).map((p) => p.id)).toContain('publishing');
    }
  });
});
