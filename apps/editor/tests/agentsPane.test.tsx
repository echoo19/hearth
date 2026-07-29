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
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { AgentChoice, AppSettingsInfo, ChatProviderStatus } from '../src/types';
import { FALLBACK_MODELS } from '../src/components/chat/ModelSelector';
import { setModelChoice } from '../src/chat/modelChoice';

// Hoisted, because `vi.mock` is: the factory below runs while this file's own
// imports are still being evaluated, and a plain `const` up here would not
// exist yet when it does.
const { saveProviderSettings, agentClis, openAiLogin } = vi.hoisted(() => ({
  saveProviderSettings: vi.fn(async () => ({ hasKey: true, source: 'project' as const })),
  // What the machine has, asked without a project. Null is "the read did not
  // land", which is what jsdom would produce anyway; naming it here keeps the
  // suite from depending on whether this environment has a fetch.
  agentClis: vi.fn(async (): Promise<{ id: string; installed: boolean }[] | null> => null),
  // The sign-in never leaves this file. Every test below either refuses it or
  // hands back a URL that `window.open` is spied on for, so nothing here can
  // touch a real ChatGPT session.
  openAiLogin: vi.fn(
    async (): Promise<{ ok: boolean; authUrl?: string; error?: string }> => ({ ok: false, error: 'not in a test' }),
  ),
}));

// The pane is the only thing under test; the rest of api.ts still has to be
// itself, because store.ts imports half of it.
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return {
    ...actual,
    apiSaveProviderSettings: saveProviderSettings,
    apiAgentClis: agentClis,
    apiOpenAiLogin: openAiLogin,
  };
});

import {
  ANTHROPIC_KEYS_URL,
  AgentsPane,
  CLAUDE_LOGIN_COMMAND,
  CODEX_INSTALL_COMMAND,
  activeProvider,
  agentCards,
  anthropicCard,
  cardState,
  claudeSignedInStatus,
  modelOptions,
  openAiCard,
  selectedModelValue,
} from '../src/components/settings/AgentsPane';
import { resetAgentSocket } from '../src/components/agent/useAgentSocket';
import { keyShapeProblem } from '../src/components/settings/apiKeyShape';
import type { AgentEnvironment } from '../src/components/settings/agentEnvironment';
import { openAiStatusLabel } from '../src/components/settings/providerStatus';
import { OPEN_FOLDER_EVENT } from '../src/components/shell/useOpenFolder';
import { useApp } from '../src/store';

/**
 * A key of a plausible length and prefix. Not a real one and not valid: the
 * shape check is a shape check, and proving that is half of what these tests
 * are for.
 */
const GOOD_KEY = `sk-ant-api03-${'x'.repeat(64)}`;

/** An environment, with the fields a case does not care about left honest. */
function env(over: Partial<AgentEnvironment> = {}): AgentEnvironment {
  return { hasProject: false, codexInstalled: null, machineRead: 'unread', projectRead: 'unread', ...over };
}

/** With a project open and both reads landed. */
const CHECKED = env({ hasProject: true, codexInstalled: true, machineRead: 'ok', projectRead: 'ok' });
/** On Home, with the machine read still out. */
const NOTHING_ASKED = env({ machineRead: 'checking' });
/**
 * A project open, and the read for it came back empty. The state that used to
 * be invisible: the store keeps its last value on a null answer, so an HTTP
 * 500, a network throw and a request nobody sent all leave the same nulls here.
 */
const READ_FAILED = env({ hasProject: true, machineRead: 'ok', projectRead: 'failed' });

type State = ReturnType<typeof useApp.getState>;

/** A providers read-out with both halves at their "nothing set up" defaults. */
function status(over: {
  anthropic?: Partial<ChatProviderStatus['anthropic']>;
  openai?: Partial<ChatProviderStatus['openai']>;
  active?: ChatProviderStatus['active'];
} = {}): ChatProviderStatus {
  return {
    // `cli` is only the binary on PATH; `loggedIn` is what decides whether
    // Claude can answer. The defaults are the empty machine, so a case that
    // cares about either one has to say so.
    anthropic: {
      hasKey: false,
      source: null,
      cli: false,
      loggedIn: false,
      email: null,
      planType: null,
      ...over.anthropic,
    },
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
    const card = anthropicCard({ hasKey: true, source: 'project' }, status({ anthropic: { hasKey: true, source: 'project', cli: false } }));
    expect(card.connected).toBe(true);
    expect(card.action.kind).toBe('none');
    expect(card.disconnect?.label).toBe('Remove key');
    // The confirm has to say where the key goes, not just that something happens.
    expect(card.disconnect?.confirmBody).toContain('.hearth/app.json');
  });

  it('does not ask for a key that is already in the environment, and will not pretend to unset one', () => {
    const card = anthropicCard({ hasKey: true, source: 'environment' }, status({ anthropic: { hasKey: true, source: 'environment', cli: false } }));
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
    const card = anthropicCard(null, status({ anthropic: { hasKey: true, source: 'project', cli: false } }));
    expect(card.connected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Claude — the sign-in, which is the route most people want and the one that
// costs nothing extra
//
// The state that matters here is the middle one: the binary on PATH with no
// sign-in on it. It used to fall through to "Not connected yet. Paste an API
// key", which sent someone with a Claude subscription off to buy API credit to
// fix something one command fixes for free.
// ---------------------------------------------------------------------------

describe('anthropicCard — the CLI sign-in', () => {
  /** Signed in, with everything the CLI reports about it. */
  const signedIn = status({
    anthropic: { cli: true, loggedIn: true, email: 'ada@example.com', planType: 'max' },
  });
  /** The binary is there and nothing was confirmed on it. */
  const signedOut = status({ anthropic: { cli: true } });

  it('is connected on the sign-in alone, with no key anywhere', () => {
    const card = anthropicCard({ hasKey: false, source: null }, signedIn, CHECKED);
    expect(card.known).toBe(true);
    expect(card.connected).toBe(true);
    expect(cardState(card, false)).toBe('connected');
  });

  it('names the account, because "Connected" alone does not say whose', () => {
    const card = anthropicCard({ hasKey: false, source: null }, signedIn, CHECKED);
    expect(card.status).toContain('ada@example.com');
    expect(card.status).toContain('max');
  });

  it('offers Sign in again, the same as the ChatGPT row does', () => {
    const card = anthropicCard({ hasKey: false, source: null }, signedIn, CHECKED);
    expect(card.action).toEqual({ kind: 'sign-in', label: 'Sign in again' });
    // Hearth stored nothing, so it has nothing to delete. Signing out is the
    // CLI's own act and a button here claiming to do it would be a lie.
    expect(card.disconnect).toBeNull();
    // A key is still an alternative, and never a step after the sign-in.
    expect(card.altKey?.label).toBe('Use an API key instead');
  });

  it('reports the plan on its own when the CLI gives no address', () => {
    expect(claudeSignedInStatus('ada@example.com', 'max')).toBe('Signed in as ada@example.com (max).');
    expect(claudeSignedInStatus('ada@example.com', null)).toBe('Signed in as ada@example.com.');
    expect(claudeSignedInStatus(null, 'pro')).toContain('pro');
    // Neither, which an older build reports. Still a real sign-in.
    expect(claudeSignedInStatus(null, null)).toMatch(/Signed in/);
  });

  it('offers the sign-in, not a key hunt, when the binary is there and nothing is signed in', () => {
    const card = anthropicCard({ hasKey: false, source: null }, signedOut, CHECKED);
    expect(card.connected).toBe(false);
    expect(card.action).toEqual({ kind: 'sign-in', label: 'Sign in to Claude Code' });
    // Its own sentence, and it is not the one next door: "Not connected yet.
    // Paste an API key" is what this state used to say, and it is the sentence
    // that cost people money.
    expect(card.status).toMatch(/Claude Code CLI is here/);
    expect(card.status).not.toMatch(/Not connected yet/);
    expect(card.status).not.toMatch(/Not set up/);
    // Not a state that reads as unavailable either: there is a button on it.
    expect(cardState(card, false)).toBe('idle');
    // The key is still reachable, as the alternative it is.
    expect(card.altKey?.label).toBe('Use an API key instead');
  });

  it('does not call anyone signed out on a probe that may simply have failed', () => {
    // `readClaudeAuth` reports this exact shape when `claude auth status`
    // times out, exits non-zero, or prints something it cannot parse, so the
    // row may offer the sign-in but may not announce a disconnection.
    const card = anthropicCard({ hasKey: false, source: null }, signedOut, CHECKED);
    expect(card.unconfirmed).toBe(true);
    expect(card.status).not.toMatch(/signed out/i);
    expect(card.status).not.toMatch(/nobody is signed in/i);
  });

  it('does not offer a sign-in that would type a command the machine does not have', () => {
    const card = anthropicCard({ hasKey: false, source: null }, status(), CHECKED);
    expect(card.action).toEqual({ kind: 'paste-key', label: 'Connect', placeholder: 'sk-ant-…' });
    expect(card.status).toMatch(/not on this machine/);
    // And it does not describe an absent binary as a fault to confirm.
    expect(card.unconfirmed).toBe(false);
  });

  it('will not claim the CLI is absent before the providers read has landed', () => {
    // Settings answered, providers has not. There is no `cli` field to have
    // read, so saying it is not on this machine would be a claim off nothing.
    const card = anthropicCard({ hasKey: false, source: null }, null, CHECKED);
    expect(card.status).not.toMatch(/not on this machine/);
    expect(card.action.kind).toBe('paste-key');
  });

  it('does not hand a Remove key button to someone who never saved one', () => {
    // The trap in `anthropicUsable`: it now answers yes to a signed-in CLI, so
    // reusing it as the has-a-key test offered to delete a file that is not
    // there and promised Claude would stop answering when it did.
    const card = anthropicCard({ hasKey: false, source: null }, signedIn, CHECKED);
    expect(card.disconnect).toBeNull();
  });

  it('still describes the key when there is one, because the key is what runs', () => {
    // `resolveApiKey` (server/chat.ts) prefers a stored key over the CLI's own
    // sign-in, so a row that announced the account here would be naming
    // something that is not going to answer the turn.
    const card = anthropicCard(
      { hasKey: true, source: 'project' },
      status({ anthropic: { hasKey: true, source: 'project', cli: true, loggedIn: true, email: 'ada@example.com' } }),
      CHECKED,
    );
    expect(card.connected).toBe(true);
    expect(card.status).not.toContain('ada@example.com');
    expect(card.disconnect?.label).toBe('Remove key');
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
    expect(card.status).toBe('Not added yet. Hearth can install codex for you. Then you sign in.');
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
    // The same trigger word as the Claude row's: one saved key, one file, one act.
    expect(card.disconnect?.label).toBe('Remove key');
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
// Uncertainty must not resolve into a confident "not connected"
//
// The pane's reads are all project-scoped and its state starts null, so on
// Home it had nothing and said "not connected" anyway. These pin down the one
// direction this pane is not allowed to be wrong in.
// ---------------------------------------------------------------------------

describe('with nothing read yet', () => {
  it('does not report Claude as disconnected, because it has not looked', () => {
    const card = anthropicCard(null, null, NOTHING_ASKED);
    expect(card.known).toBe(false);
    expect(card.status).not.toMatch(/Not connected/);
    // No button either: everything it could offer needs a folder to write to.
    expect(card.action.kind).toBe('none');
    expect(cardState(card, false)).toBe('unchecked');
  });

  it('names the two places a key could already be, rather than denying both', () => {
    // The user this used to lie to: ANTHROPIC_API_KEY already exported.
    expect(anthropicCard(null, null, NOTHING_ASKED).status).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('does not offer to install codex to someone who already has it', () => {
    // The machine read is the honest half of the question, and it says yes.
    const card = openAiCard(null, env({ codexInstalled: true, machineRead: 'ok' }));
    expect(card.action.kind).not.toBe('install');
    expect(card.status).not.toMatch(/Not added yet/);
    expect(card.known).toBe(false);
  });

  it('waits for the machine read rather than guessing at it', () => {
    const card = openAiCard(null, NOTHING_ASKED);
    expect(card.known).toBe(false);
    expect(card.action.kind).toBe('none');
  });

  it('does offer the install once the machine has genuinely answered no', () => {
    // `/api/agent-clis` takes no project, so this is a real answer even on
    // Home, and a real answer earns a real button.
    const card = openAiCard(null, env({ codexInstalled: false, machineRead: 'ok' }));
    expect(card.known).toBe(true);
    expect(card.action).toEqual({ kind: 'install', command: CODEX_INSTALL_COMMAND });
  });

  it('still opens with "set up your first agent" for a genuinely empty machine', () => {
    // The opposite failure: over-correcting into "not checked" for a new user
    // whose reads DID land and really do say nothing is connected.
    const cards = agentCards({ hasKey: false, source: null }, status({ openai: { installed: true } }), CHECKED);
    expect(cards.every((card) => card.known)).toBe(true);
    expect(cards.every((card) => !card.connected)).toBe(true);
  });
});

describe('a codex probe that did not answer', () => {
  it('does not tell a signed-in user they are signed out', () => {
    // `readCodexStatus` falls back to loggedIn:false whenever its probe fails,
    // so this exact shape is both "never signed in" and "machine was busy".
    // The line may claim only the first half of that.
    const line = openAiStatusLabel({
      installed: true,
      version: '0.9.0',
      loggedIn: false,
      authMode: null,
      email: null,
      planType: null,
      hasKey: false,
    });
    expect(line).not.toMatch(/not signed in/i);
    expect(line).toMatch(/No sign-in confirmed/);
  });

  it('marks its own negative as unconfirmed, so the hero cannot make a claim of it', () => {
    const card = openAiCard(status({ openai: { installed: true } }), CHECKED);
    expect(card.known).toBe(true);
    expect(card.connected).toBe(false);
    // The field the hero reads. Without it, "Nothing is connected yet, so
    // Hearth cannot answer a message" sat two inches above this same pane's
    // "a busy machine can look exactly like this".
    expect(card.unconfirmed).toBe(true);
  });

  it('does not mark a confirmed negative unconfirmed', () => {
    // No binary at all is a real answer from a read that really landed.
    expect(openAiCard(status(), CHECKED).unconfirmed).toBe(false);
    expect(anthropicCard({ hasKey: false, source: null }, status(), CHECKED).unconfirmed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ...and neither may it resolve into "we have not asked yet"
//
// The regression the rewrite introduced one notch over. Both project reads
// keep their last value on a null answer, so a 500, a network throw, a
// malformed body and a request that never came back all leave the same nulls
// behind, and the pane rendered every one of them as a permanent "Hearth has
// not read it yet" with no error, no spinner, and no control on the row but
// its own disclosure button. Every case here passes `hasProject: true`, which
// is exactly the case the suite did not have.
// ---------------------------------------------------------------------------

describe('a project read that failed', () => {
  it('says the read failed, rather than that nobody has asked', () => {
    const card = anthropicCard(null, null, READ_FAILED);
    expect(card.known).toBe(false);
    expect(card.read).toBe('failed');
    expect(card.status).toMatch(/could not/i);
    // The two sentences it must not borrow from the states next door.
    expect(card.status).not.toMatch(/Looking for a key/);
    expect(card.status).not.toMatch(/has not read it yet/);
  });

  it('still says it is looking while the read is genuinely still out', () => {
    const card = anthropicCard(null, null, env({ hasProject: true, projectRead: 'checking' }));
    expect(card.read).toBe('checking');
    expect(card.status).toMatch(/Looking for a key/);
  });

  it('says so on the codex row too, without unlearning the binary it did find', () => {
    const card = openAiCard(null, env({ hasProject: true, codexInstalled: true, machineRead: 'ok', projectRead: 'failed' }));
    expect(card.known).toBe(false);
    expect(card.read).toBe('failed');
    expect(card.status).toMatch(/Codex is installed/);
    expect(card.status).toMatch(/could not/i);
    expect(card.status).not.toMatch(/has not read it yet/);
  });

  it('stops claiming to be checking a machine read that died', () => {
    const card = openAiCard(null, env({ machineRead: 'failed' }));
    expect(card.read).toBe('failed');
    expect(card.status).not.toMatch(/^Checking/);
    expect(card.status).toMatch(/could not check this machine/);
    // And it still refuses to guess: no install button off a read that failed.
    expect(card.action.kind).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// The shape check
// ---------------------------------------------------------------------------

describe('keyShapeProblem', () => {
  it('passes a key of a plausible prefix and length', () => {
    expect(keyShapeProblem('anthropic', GOOD_KEY)).toBeNull();
    expect(keyShapeProblem('openai', `sk-proj-${'y'.repeat(64)}`)).toBeNull();
  });

  it('catches the paste that lost its tail, which is the one that used to go green', () => {
    expect(keyShapeProblem('anthropic', 'sk-ant-abc')).toMatch(/shorter/);
  });

  it('catches a string that was never a key', () => {
    expect(keyShapeProblem('anthropic', 'my anthropic key')).toMatch(/space or a line break/);
    expect(keyShapeProblem('anthropic', `ghp_${'z'.repeat(40)}`)).toMatch(/begin with sk-ant-/);
  });

  it('does not mistake an OpenAI key for an Anthropic one', () => {
    expect(keyShapeProblem('anthropic', `sk-${'q'.repeat(48)}`)).toMatch(/begin with sk-ant-/);
    expect(keyShapeProblem('openai', `sk-${'q'.repeat(48)}`)).toBeNull();
  });

  it('catches it in the other direction too, which the sk- prefix cannot', () => {
    // The single most likely mistake on a pane showing both fields with
    // near-identical placeholders, and it used to pass silently: every
    // Anthropic key ever issued starts with OpenAI's `sk-` prefix.
    const problem = keyShapeProblem('openai', GOOD_KEY);
    expect(problem).toMatch(/sk-ant-/);
    expect(problem).toMatch(/Anthropic/);
    expect(problem).toMatch(/OpenAI/);
    // And the same string in its own box is still fine.
    expect(keyShapeProblem('anthropic', GOOD_KEY)).toBeNull();
  });

  it('catches a paste that kept the prefix and lost the body', () => {
    // 25 characters, correct prefix, and 83 of 95 body characters gone. The
    // old floor of 24 let this through and awarded it a green Connected badge,
    // in the module whose header names truncated pastes as its whole purpose.
    expect(keyShapeProblem('anthropic', 'sk-ant-api03-AAAAAAAAAAAA')).toMatch(/shorter/);
    // Real keys are nowhere near the floor: about 108 characters for
    // Anthropic, 51 for a legacy OpenAI one, more for an sk-proj- one.
    expect(keyShapeProblem('openai', `sk-${'q'.repeat(48)}`)).toBeNull();
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
  openAiLogin.mockClear();
  localStorage.clear();
  setModelChoice(null);
  // The terminal session lives in a module-level store, outside React and
  // outside the store this suite patches, so a run left over from one test is
  // still there in the next one and changes what the planner decides to do.
  sentFrames.length = 0;
  resetAgentSocket();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/**
 * Every pty frame the pane sent. The Claude sign-in and the codex install both
 * work by typing into the terminal, so this is the only place their behaviour
 * is observable: there is no request to intercept, by design.
 */
const sentFrames: unknown[] = [];

function patchStore(settings: AppSettingsInfo | null, providers: ChatProviderStatus | null): void {
  useApp.setState({
    projectPath: '/tmp/game',
    settings,
    providers,
    refreshSettings: vi.fn(async () => {}),
    refreshProviders: vi.fn(async () => {}),
    startOpenAiLogin: vi.fn(async () => {}),
    // The terminal side. `planTerminalLaunch` refuses outright on a socket it
    // thinks is down, so a test that does not say the connection is up is a
    // test of the refusal rather than of the command.
    wsStatus: 'connected',
    sendFrame: vi.fn((frame: unknown) => {
      sentFrames.push(frame);
      return true;
    }),
    setConversationMode: vi.fn(),
  } as unknown as Partial<State>);
}

/** Open a harness row. The dashboard is collapsed until you ask for detail. */
function openRow(name: string): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
}

describe('removing a key asks first', () => {
  it('does not touch the server until the confirm is pressed', async () => {
    patchStore({ hasKey: true, source: 'project' }, status({ anthropic: { hasKey: true, source: 'project', cli: false } }));
    render(<AgentsPane />);

    // Connection controls live inside the harness row now, so the row has to
    // be opened before they exist. Collapsed, the dashboard is a short list of
    // harnesses and their states.
    openRow('Claude Code CLI');
    // Both providers now use the same trigger word, and it is the same word
    // the confirm uses, so once the dialog is up there are two of them: the
    // row's, and the one that actually does it.
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    // Asking is not doing.
    expect(saveProviderSettings).not.toHaveBeenCalled();
    expect(screen.getByText('Remove the Anthropic key?')).toBeTruthy();

    const confirms = screen.getAllByRole('button', { name: 'Remove key' });
    fireEvent.click(confirms[confirms.length - 1]);
    await waitFor(() => expect(saveProviderSettings).toHaveBeenCalledTimes(1));
    // An empty string is the instruction to remove it — not `undefined`, which
    // means "leave this one alone".
    expect(saveProviderSettings).toHaveBeenCalledWith('/tmp/game', { apiKey: '' });
  });

  it('leaves the key alone when the confirm is cancelled', async () => {
    patchStore({ hasKey: true, source: 'project' }, status({ anthropic: { hasKey: true, source: 'project', cli: false } }));
    render(<AgentsPane />);

    openRow('Claude Code CLI');
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
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

  it('claims nothing about either harness when no folder is open', () => {
    // The real Home state: closeWorkspace clears both read-outs, and the
    // initial state starts that way, so on Home the pane has read nothing.
    patchStore(null, null);
    useApp.setState({ projectPath: null } as unknown as Partial<State>);
    render(<AgentsPane />);

    // The sentence that used to be here, said to users who were fully set up.
    expect(screen.queryByText(/Nothing is connected yet/)).toBeNull();
    expect(screen.queryByText(/Not connected yet/)).toBeNull();
    expect(screen.getByRole('heading', { level: 3, name: 'Not checked yet' })).toBeTruthy();
    // And the way out, which this pane did not have at all.
    expect(screen.getByRole('button', { name: 'Open a project…' })).toBeTruthy();
  });

  it('asks the window for a folder rather than leaving the user to guess', () => {
    patchStore(null, null);
    useApp.setState({ projectPath: null } as unknown as Partial<State>);
    const asked = vi.fn();
    window.addEventListener(OPEN_FOLDER_EVENT, asked);
    render(<AgentsPane />);
    fireEvent.click(screen.getByRole('button', { name: 'Open a project…' }));
    expect(asked).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_FOLDER_EVENT, asked);
  });

  it('commits a pasted key on Connect — no separate Save', async () => {
    patchStore({ hasKey: false, source: null }, status());
    render(<AgentsPane />);
    openRow('Claude Code CLI');
    fireEvent.change(screen.getByLabelText('Anthropic API key'), { target: { value: `  ${GOOD_KEY}  ` } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(saveProviderSettings).toHaveBeenCalledWith('/tmp/game', { apiKey: GOOD_KEY }));
  });

  it('offers a route to a key, because this window has no address bar', () => {
    patchStore({ hasKey: false, source: null }, status());
    render(<AgentsPane />);
    openRow('Claude Code CLI');
    const link = screen.getByRole('link', { name: /Get a key from Anthropic/ });
    expect(link.getAttribute('href')).toBe(ANTHROPIC_KEYS_URL);
    // Through the handler electron/main.ts installs, which is what sends it to
    // the user's own browser instead of a chrome-less editor window.
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    fireEvent.click(link);
    expect(open).toHaveBeenCalledWith(ANTHROPIC_KEYS_URL, '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// A project open, and the read for it came back empty
//
// The blocker. `patchStore` leaves both read-outs null and hands back a
// `refreshProviders` that resolves without writing one, which is precisely
// what a 500, a network throw or a malformed body does in the real store: the
// value is deliberately kept rather than blanked, so nothing downstream can
// tell the failure from a question nobody asked. This is the case the suite
// did not have, because every "nothing read yet" test above is `hasProject:
// false`.
// ---------------------------------------------------------------------------

describe('with a project open and both reads failed', () => {
  it('offers a way to check, on the row itself, without expanding anything', async () => {
    patchStore(null, null);
    render(<AgentsPane />);
    // One per harness, and it is the whole point: the complete set of
    // interactive elements on this row used to be its disclosure button.
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Check again' })).toHaveLength(2));
  });

  it('does not claim the read has not been started', async () => {
    patchStore(null, null);
    render(<AgentsPane />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Check again' })).toHaveLength(2));
    // The two sentences that shipped for a read that had already died.
    expect(screen.queryByText(/Looking for a key in this project\./)).toBeNull();
    expect(screen.queryByText(/Hearth has not read it yet/)).toBeNull();
    // And what it says instead, on the row and in the body.
    expect(screen.getByText(/could not finish reading this project/)).toBeTruthy();
    openRow('Claude Code CLI');
    expect(screen.getByText(/did not come back/)).toBeTruthy();
  });

  it('will not fire a second read over one that is still out', async () => {
    // The stale-answer race, from the only side this pane owns. A codex probe
    // gives up after fifteen seconds and reports a signed-out account when it
    // does, so the slow request is also the one carrying the wrong answer, and
    // pressing Check again over a live probe is how it lands last.
    let release: () => void = () => {};
    const slow = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    patchStore(null, null);
    useApp.setState({ refreshProviders: slow } as unknown as Partial<State>);
    render(<AgentsPane />);

    const waiting = await screen.findAllByRole('button', { name: 'Checking…' });
    expect((waiting[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(waiting[0]);
    expect(slow).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Check again' })).toHaveLength(2));
    fireEvent.click(screen.getAllByRole('button', { name: 'Check again' })[0]);
    await waitFor(() => expect(slow).toHaveBeenCalledTimes(2));
  });
});

// ---------------------------------------------------------------------------
// The hero may not be more certain than the row beneath it
// ---------------------------------------------------------------------------

describe('the opening block', () => {
  it('does not announce a disconnection the pane itself says cannot be known', () => {
    // codex installed, loggedIn false. `readCodexStatus` reports exactly this
    // when its probe times out, and the row below says so in as many words.
    patchStore({ hasKey: false, source: null }, status({ openai: { installed: true } }));
    render(<AgentsPane />);
    expect(screen.queryByText(/Nothing is connected yet/)).toBeNull();
    expect(screen.getByText(/has not confirmed a connection/)).toBeTruthy();
    // The way in is still offered; only the claim is withdrawn.
    expect(screen.getByRole('button', { name: 'Connect Claude with a key' })).toBeTruthy();
  });

  it('still says it plainly when the negative really is confirmed', () => {
    // No codex binary at all: a real answer from a read that really landed.
    patchStore({ hasKey: false, source: null }, status());
    render(<AgentsPane />);
    expect(screen.getByText(/Nothing is connected yet/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// A sign-in that never finishes
// ---------------------------------------------------------------------------

describe('the ChatGPT sign-in', () => {
  it('does not latch on Connecting when the flow never started', async () => {
    openAiLogin.mockResolvedValueOnce({ ok: false, error: 'codex is not installed' });
    patchStore({ hasKey: false, source: null }, status({ openai: { installed: true } }));
    render(<AgentsPane />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }));
    // The store's own `startOpenAiLogin` answers void either way, which is why
    // the pane calls the api directly: a 400 used to leave the row on
    // "Connecting", on a false status line, with the button disabled, and the
    // only escape was closing and reopening the dialog.
    await waitFor(() => {
      const button = screen.getByRole('button', { name: 'Sign in with ChatGPT' }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });
    expect(screen.queryByText(/Waiting for the browser/)).toBeNull();
  });

  it('lets the user stop waiting on a browser that may never come back', async () => {
    openAiLogin.mockResolvedValueOnce({ ok: true, authUrl: 'https://example.invalid/auth' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    patchStore({ hasKey: false, source: null }, status({ openai: { installed: true } }));
    render(<AgentsPane />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://example.invalid/auth', '_blank', 'noopener,noreferrer'));
    expect(screen.getByText(/Waiting for the browser/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }));
    expect(screen.queryByRole('button', { name: 'Stop waiting' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Sign in with ChatGPT' }) as HTMLButtonElement).disabled).toBe(false);
    open.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The Claude sign-in, which is a command and not a request
//
// `claude auth login` is interactive: it opens a browser and finishes back in
// a shell. There is no headless route to drive it the way codex's is driven,
// so Hearth types it into the terminal it already owns and stays out of it.
// That means these tests watch pty frames rather than a mocked endpoint, and
// that nothing here can touch a credential — there is no field that takes one.
// ---------------------------------------------------------------------------

describe('the Claude sign-in', () => {
  /** The binary is on PATH and no sign-in was confirmed on it. */
  const CLI_ONLY = status({ anthropic: { cli: true } });

  /**
   * The harness rows, without the hero above them. Both offer the sign-in now,
   * deliberately: the hero must not go on recommending a metered key when the
   * CLI is sitting on PATH. These tests are about the row.
   */
  const harnessRows = (): HTMLElement => screen.getByRole('list');

  it('offers the sign-in on the row itself, before anything is expanded', () => {
    patchStore({ hasKey: false, source: null }, CLI_ONLY);
    render(<AgentsPane />);
    expect(within(harnessRows()).getByRole('button', { name: 'Sign in to Claude Code' })).toBeTruthy();
    // And the sentence that used to be here instead, which sent someone with a
    // subscription off to buy API credit.
    expect(screen.queryByText(/Not connected yet\. Paste an API key/)).toBeNull();
  });

  it('types the command into the terminal, and nowhere else', () => {
    patchStore({ hasKey: false, source: null }, CLI_ONLY);
    render(<AgentsPane />);
    fireEvent.click(within(harnessRows()).getByRole('button', { name: 'Sign in to Claude Code' }));

    expect(sentFrames).toContainEqual({ type: 'pty-input', data: `${CLAUDE_LOGIN_COMMAND}\n` });
    expect(CLAUDE_LOGIN_COMMAND).toBe('claude auth login');
    // An idle session has to be started before anything can be typed into it.
    expect(sentFrames.some((frame) => (frame as { type: string }).type === 'pty-start')).toBe(true);
    // Nothing was saved, because there is nothing to save: the credential is
    // the CLI's and the person hands it to Anthropic themselves.
    expect(saveProviderSettings).not.toHaveBeenCalled();
    expect(openAiLogin).not.toHaveBeenCalled();
  });

  it('shows the command it is about to run, so it can be copied and run elsewhere', () => {
    patchStore({ hasKey: false, source: null }, CLI_ONLY);
    render(<AgentsPane />);
    openRow('Claude Code CLI');
    expect(within(harnessRows()).getByText(CLAUDE_LOGIN_COMMAND)).toBeTruthy();
    // The promise the pane makes about it: Hearth never holds the credential.
    expect(screen.getByText(/never through this app/)).toBeTruthy();
  });

  it('keeps the API key route open beside it, as an alternative and not a step', () => {
    patchStore({ hasKey: false, source: null }, CLI_ONLY);
    render(<AgentsPane />);
    openRow('Claude Code CLI');
    // Not shown up front: the sign-in is the primary action here.
    expect(screen.queryByLabelText('Anthropic API key')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use an API key instead' }));
    expect(screen.getByLabelText('Anthropic API key')).toBeTruthy();
  });

  it('names the account once the CLI reports one, and still offers to sign in again', () => {
    patchStore(
      { hasKey: false, source: null },
      status({ anthropic: { cli: true, loggedIn: true, email: 'ada@example.com', planType: 'max' } }),
    );
    render(<AgentsPane />);
    expect(screen.getByText(/Signed in as ada@example\.com \(max\)\./)).toBeTruthy();
    openRow('Claude Code CLI');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(sentFrames).toContainEqual({ type: 'pty-input', data: `${CLAUDE_LOGIN_COMMAND}\n` });
  });

  it('says the CLI is not here rather than offering a command that would fail', () => {
    patchStore({ hasKey: false, source: null }, status());
    render(<AgentsPane />);
    expect(screen.queryByRole('button', { name: 'Sign in to Claude Code' })).toBeNull();
    expect(within(harnessRows()).getByText(/not on this machine/)).toBeTruthy();
    // The key route is still right there, which is the whole point of saying
    // it in this pane rather than reporting a deficiency.
    openRow('Claude Code CLI');
    expect(screen.getByLabelText('Anthropic API key')).toBeTruthy();
  });

  it('disables the sign-in with a reason when there is no project to run it in', () => {
    patchStore({ hasKey: false, source: null }, CLI_ONLY);
    useApp.setState({ projectPath: null } as unknown as Partial<State>);
    render(<AgentsPane />);

    const button = screen.getByRole('button', { name: 'Sign in to Claude Code' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // Greying it out is not enough. The pane says why, and offers the way out,
    // the same as the codex install does.
    openRow('Claude Code CLI');
    expect(screen.getByText(/terminal runs inside a project/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Open a project…' }).length).toBeGreaterThan(0);
    // Pressing it anyway must not type into a shell that does not exist.
    fireEvent.click(screen.getByRole('button', { name: 'Run it in the terminal' }));
    expect(sentFrames).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A key that looks wrong
// ---------------------------------------------------------------------------

describe('a pasted key is looked at before it earns a green badge', () => {
  it('does not save a truncated paste on the first press, and says why', async () => {
    patchStore({ hasKey: false, source: null }, status());
    render(<AgentsPane />);
    openRow('Claude Code CLI');
    fireEvent.change(screen.getByLabelText('Anthropic API key'), { target: { value: 'sk-ant-abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(saveProviderSettings).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/shorter than a key/);
  });

  it('saves it anyway on the second press, because this is not Hearth’s call', async () => {
    patchStore({ hasKey: false, source: null }, status());
    render(<AgentsPane />);
    openRow('Claude Code CLI');
    fireEvent.change(screen.getByLabelText('Anthropic API key'), { target: { value: 'sk-ant-abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    // The button says what the second press will do rather than staying
    // "Connect" and quietly meaning something else.
    fireEvent.click(screen.getByRole('button', { name: 'Save it anyway' }));
    await waitFor(() => expect(saveProviderSettings).toHaveBeenCalledWith('/tmp/game', { apiKey: 'sk-ant-abc' }));
  });

  it('withdraws the warning when the field is edited, so the next paste gets a fresh look', () => {
    patchStore({ hasKey: false, source: null }, status());
    render(<AgentsPane />);
    openRow('Claude Code CLI');
    const field = screen.getByLabelText('Anthropic API key');
    fireEvent.change(field, { target: { value: 'nonsense' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.change(field, { target: { value: 'still nonsense' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
  });

  it('lets a well-formed key straight through', async () => {
    patchStore({ hasKey: false, source: null }, status());
    render(<AgentsPane />);
    openRow('Claude Code CLI');
    fireEvent.change(screen.getByLabelText('Anthropic API key'), { target: { value: GOOD_KEY } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(saveProviderSettings).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
