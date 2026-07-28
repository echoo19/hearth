// @vitest-environment jsdom
/**
 * The Agents pane: what each provider card offers, given the state that
 * provider is actually in.
 *
 * The pane's whole claim is "one click to connect", and a one-click button is
 * only honest if it can work. So the tests that matter here are about which
 * action a card offers, not about how it looks:
 *
 *   1. every state of both providers maps to exactly one action, and the two
 *      states where a button would fail — no folder open is handled by the
 *      pane, no `codex` binary is handled by the card — offer something else
 *      instead of a button that throws;
 *   2. an environment key is connected but is not ours to remove, so the card
 *      neither asks for a key it already has nor offers a Disconnect that
 *      would silently do nothing;
 *   3. removing a key asks first, and asking is not doing — nothing reaches
 *      the server until the confirm is pressed.
 *
 * The model list is covered too, because it is the one place this pane could
 * invent something: everything it offers has to come from the server's list or
 * from the composer's fallback, never from here.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentChoice, AppSettingsInfo, ChatProviderStatus } from '../src/types';
import { FALLBACK_MODELS } from '../src/components/chat/ModelSelector';
import { setModelChoice } from '../src/chat/modelChoice';

// Hoisted, because `vi.mock` is: the factory below runs while this file's own
// imports are still being evaluated, and a plain `const` up here would not
// exist yet when it does.
const { saveProviderSettings } = vi.hoisted(() => ({
  saveProviderSettings: vi.fn(async () => ({ hasKey: true, source: 'project' as const })),
}));

// The pane is the only thing under test; the rest of api.ts still has to be
// itself, because store.ts imports half of it.
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return { ...actual, apiSaveProviderSettings: saveProviderSettings };
});

import {
  AgentsPane,
  CODEX_INSTALL_COMMAND,
  activeProvider,
  agentCards,
  anthropicCard,
  cardState,
  modelOptions,
  openAiCard,
  selectedModelValue,
} from '../src/components/settings/AgentsPane';
import { useApp } from '../src/store';

type State = ReturnType<typeof useApp.getState>;

/** A providers read-out with both halves at their "nothing set up" defaults. */
function status(over: {
  anthropic?: Partial<ChatProviderStatus['anthropic']>;
  openai?: Partial<ChatProviderStatus['openai']>;
  active?: ChatProviderStatus['active'];
} = {}): ChatProviderStatus {
  return {
    anthropic: { hasKey: false, source: null, ...over.anthropic },
    openai: {
      installed: false,
      version: null,
      loggedIn: false,
      authMode: null,
      email: null,
      planType: null,
      hasKey: false,
      ...over.openai,
    },
    active: over.active ?? null,
  };
}

// ---------------------------------------------------------------------------
// Claude — a key you paste
// ---------------------------------------------------------------------------

describe('anthropicCard', () => {
  it('offers a paste-and-go field when there is no key anywhere', () => {
    const card = anthropicCard({ hasKey: false, source: null }, status());
    expect(card.connected).toBe(false);
    expect(card.action).toEqual({ kind: 'paste-key', label: 'Connect', placeholder: 'sk-ant-…' });
    // Nothing to take back yet.
    expect(card.disconnect).toBeNull();
  });

  it('is connected, and offers to remove it, when the key is saved for the project', () => {
    const card = anthropicCard({ hasKey: true, source: 'project' }, status({ anthropic: { hasKey: true, source: 'project' } }));
    expect(card.connected).toBe(true);
    expect(card.action.kind).toBe('none');
    expect(card.disconnect?.label).toBe('Disconnect');
    // The confirm has to say where the key goes, not just that something happens.
    expect(card.disconnect?.confirmBody).toContain('.hearth/app.json');
  });

  it('does not ask for a key that is already in the environment, and will not pretend to unset one', () => {
    const card = anthropicCard({ hasKey: true, source: 'environment' }, status({ anthropic: { hasKey: true, source: 'environment' } }));
    expect(card.connected).toBe(true);
    expect(card.status).toContain('ANTHROPIC_API_KEY');
    // No field up front...
    expect(card.action.kind).toBe('none');
    // ...but a project key may still be pasted over the top of it.
    expect(card.altKey?.label).toBe('Use a key for this project instead');
    // A shell variable is not this pane's to remove.
    expect(card.disconnect).toBeNull();
  });

  it('reads the providers endpoint when the settings read-out has not landed yet', () => {
    const card = anthropicCard(null, status({ anthropic: { hasKey: true, source: 'project' } }));
    expect(card.connected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ChatGPT — a CLI you install and sign into
// ---------------------------------------------------------------------------

describe('openAiCard', () => {
  it('shows the install command instead of a button that could not work', () => {
    const card = openAiCard(status());
    expect(card.connected).toBe(false);
    expect(card.action).toEqual({ kind: 'install', command: CODEX_INSTALL_COMMAND });
    expect(CODEX_INSTALL_COMMAND).toBe('npm i -g @openai/codex');
    // Not "Not installed." any more: an agent you do not have is something to
    // add, not a fault to report. See NOT_CONNECTED_STATUS in AgentsPane.
    expect(card.status).toBe('Not added yet. Hearth can install the codex binary for you, then you sign in.');
  });

  it('offers the one-click sign-in once the binary is there', () => {
    const card = openAiCard(status({ openai: { installed: true, version: '0.9.0' } }));
    expect(card.connected).toBe(false);
    expect(card.action).toEqual({ kind: 'sign-in', label: 'Sign in with ChatGPT' });
    // Nothing saved here, so nothing to remove — but an API key is a second way in.
    expect(card.disconnect).toBeNull();
    expect(card.altKey?.label).toBe('Use an API key instead');
  });

  it('is connected once signed in, and keeps sign-in reachable', () => {
    const card = openAiCard(
      status({ openai: { installed: true, loggedIn: true, authMode: 'chatgpt', email: 'sam@example.com' } }),
    );
    expect(card.connected).toBe(true);
    expect(card.action).toEqual({ kind: 'sign-in', label: 'Sign in again' });
    expect(card.status).toContain('sam@example.com');
    // A browser sign-in is not a key this pane stored, so it cannot take it away.
    expect(card.disconnect).toBeNull();
  });

  it('is connected on a saved key alone, and that one it can remove', () => {
    const card = openAiCard(status({ openai: { installed: true, hasKey: true } }));
    expect(card.connected).toBe(true);
    expect(card.action.kind).toBe('sign-in');
    expect(card.disconnect?.label).toBe('Remove saved key');
    // Removing the key must not claim to sign anyone out.
    expect(card.disconnect?.confirmBody).toContain('sign-in');
  });
});

describe('cardState — what the badge says at a glance', () => {
  const notInstalled = openAiCard(status());
  const signedIn = openAiCard(status({ openai: { installed: true, loggedIn: true } }));
  const ready = openAiCard(status({ openai: { installed: true } }));

  it('calls a pending sign-in connecting, whatever else is true', () => {
    expect(cardState(ready, true)).toBe('connecting');
    expect(cardState(notInstalled, true)).toBe('connecting');
  });

  it('separates connected, unavailable and merely idle', () => {
    expect(cardState(signedIn, false)).toBe('connected');
    expect(cardState(notInstalled, false)).toBe('unavailable');
    expect(cardState(ready, false)).toBe('idle');
  });
});

describe('agentCards', () => {
  it('always returns both providers, in a fixed order', () => {
    const cards = agentCards(null, null);
    expect(cards.map((c) => c.provider)).toEqual(['anthropic', 'openai']);
    expect(cards.map((c) => c.name)).toEqual(['Claude', 'ChatGPT']);
  });
});

// ---------------------------------------------------------------------------
// Who answers, and with what
// ---------------------------------------------------------------------------

describe('activeProvider', () => {
  const choice = (over: Partial<AgentChoice> = {}): AgentChoice => ({
    provider: 'openai',
    model: null,
    effort: null,
    ...over,
  });

  it('follows the standing choice, because that is what the send path reads', () => {
    expect(activeProvider(choice(), status({ active: 'anthropic' }))).toBe('openai');
  });

  it('falls back to the server’s answer until someone picks one', () => {
    expect(activeProvider(null, status({ active: 'anthropic' }))).toBe('anthropic');
    expect(activeProvider(null, null)).toBeNull();
  });
});

describe('modelOptions — nothing here is invented', () => {
  it('uses the server’s list when it has one', () => {
    const curated = [{ id: 'claude-sonnet-5', label: 'Sonnet 5' }];
    const options = modelOptions('anthropic', status({ anthropic: { models: curated } }));
    expect(options.map((m) => m.id)).toEqual(['', 'claude-sonnet-5']);
    expect(options[0].label).toBe('Automatic');
  });

  it('falls back to the same list the composer falls back to', () => {
    const options = modelOptions('anthropic', null);
    const ids = options.map((m) => m.id);
    for (const model of FALLBACK_MODELS.anthropic) expect(ids).toContain(model.id);
  });

  it('does not add a second default entry when the provider already has one', () => {
    const options = modelOptions('openai', null);
    expect(options.filter((m) => m.id === '')).toHaveLength(1);
  });
});

describe('selectedModelValue', () => {
  it('shows the chosen model only on the card that was chosen', () => {
    const choice: AgentChoice = { provider: 'anthropic', model: 'claude-opus-5', effort: null };
    expect(selectedModelValue(choice, 'anthropic')).toBe('claude-opus-5');
    expect(selectedModelValue(choice, 'openai')).toBe('');
  });

  it('reads a null model as the provider’s own default', () => {
    expect(selectedModelValue({ provider: 'openai', model: null, effort: 'high' }, 'openai')).toBe('');
    expect(selectedModelValue(null, 'anthropic')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The destructive one
// ---------------------------------------------------------------------------

// jsdom implements neither showModal nor close; the ConfirmDialog only needs
// them to be open/close toggles.
beforeEach(() => {
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  proto.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  saveProviderSettings.mockClear();
  localStorage.clear();
  setModelChoice(null);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function patchStore(settings: AppSettingsInfo | null, providers: ChatProviderStatus | null): void {
  useApp.setState({
    projectPath: '/tmp/game',
    settings,
    providers,
    refreshSettings: vi.fn(async () => {}),
    refreshProviders: vi.fn(async () => {}),
    startOpenAiLogin: vi.fn(async () => {}),
  } as unknown as Partial<State>);
}

/** Open a harness row. The dashboard is collapsed until you ask for detail. */
function openRow(name: string): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
}

describe('removing a key asks first', () => {
  it('does not touch the server until the confirm is pressed', async () => {
    patchStore({ hasKey: true, source: 'project' }, status({ anthropic: { hasKey: true, source: 'project' } }));
    render(<AgentsPane />);

    // Connection controls live inside the harness row now, so the row has to
    // be opened before they exist. Collapsed, the dashboard is a short list of
    // harnesses and their states.
    openRow('Claude Agent SDK');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    // Asking is not doing.
    expect(saveProviderSettings).not.toHaveBeenCalled();
    expect(screen.getByText('Remove the Anthropic key?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    await waitFor(() => expect(saveProviderSettings).toHaveBeenCalledTimes(1));
    // An empty string is the instruction to remove it — not `undefined`, which
    // means "leave this one alone".
    expect(saveProviderSettings).toHaveBeenCalledWith('/tmp/game', { apiKey: '' });
  });

  it('leaves the key alone when the confirm is cancelled', async () => {
    patchStore({ hasKey: true, source: 'project' }, status({ anthropic: { hasKey: true, source: 'project' } }));
    render(<AgentsPane />);

    openRow('Claude Agent SDK');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Remove the Anthropic key?')).toBeNull());
    expect(saveProviderSettings).not.toHaveBeenCalled();
  });
});

describe('the pane as rendered', () => {
  it('shows the install command, and no sign-in button, without the CLI', () => {
    patchStore({ hasKey: false, source: null }, status());
    render(<AgentsPane />);
    openRow('Codex CLI');
    expect(screen.getByText(CODEX_INSTALL_COMMAND)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in with ChatGPT' })).toBeNull();
  });

  it('says where keys go when no folder is open, rather than failing quietly', () => {
    patchStore({ hasKey: false, source: null }, status());
    useApp.setState({ projectPath: null } as unknown as Partial<State>);
    render(<AgentsPane />);
    openRow('Claude Agent SDK');
    expect(screen.getByText(/Open a folder first/)).toBeTruthy();
    // The one control that would silently do nothing is off.
    expect((screen.getByLabelText('Anthropic API key') as HTMLInputElement).disabled).toBe(true);
  });

  it('commits a pasted key on Connect — no separate Save', async () => {
    patchStore({ hasKey: false, source: null }, status());
    render(<AgentsPane />);
    openRow('Claude Agent SDK');
    fireEvent.change(screen.getByLabelText('Anthropic API key'), { target: { value: '  sk-ant-abc  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(saveProviderSettings).toHaveBeenCalledWith('/tmp/game', { apiKey: 'sk-ant-abc' }));
  });
});
