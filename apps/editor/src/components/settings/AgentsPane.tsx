/**
 * Settings → Agents: the chat harnesses, and the models each one drives.
 *
 * THE MENTAL MODEL, because everything below follows from it: a chat agent is
 * a HARNESS paired with a MODEL. The harness runs the loop and holds the
 * credential; the model is the one it drives. Composing those two is how a
 * person makes their own agent, so the pane is a list of harnesses and the
 * models live inside the harness they belong to.
 *
 * One row per harness, always the same shape:
 *
 *     ⌄  mark   name                    state or the one action to take
 *               what it drives · how it is connected
 *
 * Collapsed, the whole pane is that list: two rows, each showing either a
 * Connected badge or a single button that gets it connected. Expanded, a row
 * opens onto its own connection controls and its own model list with a switch
 * per model. Nothing about a harness appears anywhere but inside it, which is
 * what keeps this from becoming a wall of unrelated controls.
 *
 * THE TERMINAL HAS A CARD, and it has no controls on it (`TerminalSection`).
 * That combination is the correction to what used to be here: one grey line at
 * the very foot of the pane, under two other grey lines, saying the terminal
 * was free. It is free — a shell in the open project, running as you, needing
 * nothing connected or paired or configured — which is exactly why it is the
 * broadest thing in the app and why burying it made a pane whose first two
 * cards are named vendors read as "Hearth works with Claude and ChatGPT". It
 * is the answer to "can I use X" for every X, so it says so at the size that
 * claim deserves, and it still grows no controls, because there are none.
 *
 * WHAT IS LISTED, and why nothing else is. A harness row appears here only if
 * Hearth has a driver that can actually answer a turn with it — today the
 * Claude Agent SDK (server/chat.ts) and the Codex CLI
 * (server/chatDrivers/codex.ts). Listing a third vendor Hearth cannot drive
 * would put a Connect button on screen that saves a credential nothing reads.
 * The registry is `AGENT_BACKENDS` in chat/modelChoice; adding an entry there
 * is what adding a harness looks like from this file.
 *
 * That shortlist is a fact about Hearth's DRIVERS and must never be allowed to
 * read as the set of agents that work here, which is what `TerminalSection`
 * exists to prevent: any other agent runs in the terminal, in the same folder,
 * with nothing to set up.
 *
 * The two harnesses that exist are genuinely different animals, and the rows
 * say so rather than pretending otherwise:
 *
 *   Claude Code CLI    a binary that is already signed into an account, or an
 *                      API key. The sign-in is the ordinary route and costs
 *                      nothing extra, but it is the CLI's own interactive
 *                      flow, so the row runs `claude auth login` in the
 *                      visible terminal rather than pretending to drive it.
 *                      A key stays as the alternative, not as a step after.
 *   Codex CLI          an open-source binary you install and sign into in a
 *                      browser. Before the binary exists there is nothing a
 *                      Sign in button could do, so the row offers the install
 *                      instead — and runs it in the visible terminal.
 *
 * NEITHER SIGN-IN PASSES THROUGH HEARTH. Codex's hands a URL to the user's own
 * browser; Claude's types one command into the user's own shell. In both cases
 * the person talks to the vendor directly, and there is no field on this pane
 * that takes a token, a password or a session key.
 *
 * Both are also bound to one catalogue: the SDK's `model` option takes Claude
 * ids and codex answers from its own `model/list`. Other harnesses are
 * model-agnostic; `AgentBackend.catalogue` is where an entry says which it is,
 * so the pane never implies a cross-product these two do not support.
 *
 * Nothing here is an official integration. Hearth is not affiliated with
 * Anthropic or OpenAI, and no copy on this pane may suggest it is.
 *
 * There is no Save button, because this pane has no footer to put one in:
 * every control commits its own change and then re-reads the truth, so a row
 * never shows a state the disk does not agree with. Keys are written into the
 * OPEN project's `.hearth/app.json` — with no project open there is nowhere to
 * put one, and the pane says that rather than quietly dropping it.
 *
 * THE ONE RULE THIS PANE MUST NOT BREAK, and the reason for `AgentCard.known`,
 * the `unchecked` card state and agentEnvironment.ts: uncertainty may never be
 * resolved into a confident "not connected". Every read here is project
 * scoped, so on Home there is nothing to read, and this pane used to render
 * from nulls and announce that nothing was connected and Hearth could not
 * answer a message. It said that to people with codex installed, signed into
 * ChatGPT, with a key already in their environment. A pane that is honestly
 * unsure costs its user a glance; a pane that is confidently wrong in the
 * negative sends them off to fix something that was never broken, and this is
 * the screen a new user lands on when nothing works yet.
 *
 * The same rule bites in three more places, so they are all written the same
 * way: whether `codex` is installed is a machine fact and is read from
 * `/api/agent-clis`, which takes no project; whether you are signed into
 * ChatGPT cannot be told apart on the wire from a probe that timed out, so the
 * row says only what it confirmed and offers to ask again; and a pasted key is
 * shape checked before it can earn a green badge, without that check ever
 * becoming a gate on what its user is allowed to paste.
 *
 * AND THE RULE HAS A SECOND HALF, which the first version of this pane got
 * wrong in the other direction: uncertainty may not be resolved into "we have
 * not asked yet" either. Both project reads keep their last value on a null
 * answer, so a 500, a network throw, a malformed body and a request that never
 * came back all left the same nulls behind, and the row rendered them as
 * "Looking for a key in this project." forever, with no error, no spinner and
 * not one control on it but its own disclosure button. So `AgentCard.read`
 * carries how the read went alongside `known`, a failed read says it failed,
 * and every unread row offers the read. AN UNCHECKED ROW MUST ALWAYS OFFER A
 * WAY TO CHECK. See agentEnvironment.ts, which owns both reads and never has
 * two of them in flight at once.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiOpenAiLogin, apiSaveProviderSettings, type ProviderSettingsPatch } from '../../api';
import { showToast } from '../../toast';
import {
  AGENT_BACKENDS,
  type AgentBackend,
  canSetModelEnabled,
  enabledModels,
  getModelChoice,
  getModelPrefsFile,
  isModelEnabled,
  setModelChoice,
  setModelEnabled,
  useDisabledModels,
  useModelChoice,
} from '../../chat/modelChoice';
import { NOTHING_DISABLED, choiceForModel, modelGroups } from '../chat/ModelSelector';
import { useAgentClis } from '../../chat/agentClis';
import { useApp } from '../../store';
import type {
  AgentChoice,
  AppSettingsInfo,
  ChatProvider,
  ChatProviderStatus,
  ProviderModelInfo,
} from '../../types';
import {
  ensureAgentPtySessionId,
  markAgentStarted,
  planTerminalLaunch,
  useAgentSocket,
} from '../agent/useAgentSocket';
import { OPEN_FOLDER_EVENT } from '../shell/useOpenFolder';
import { ConfirmDialog, Icon } from '../ui';
import { Button } from '../ui/Button';
import { SettingsRow } from './SettingsRow';
import { ClaudeLogo, OpenAiLogo } from './providerLogos';
import { keyShapeProblem } from './apiKeyShape';
import {
  UNKNOWN_ENVIRONMENT,
  useAgentEnvironment,
  type AgentEnvironment,
  type ReadState,
} from './agentEnvironment';
// The app's one read of provider state. Imported, never re-derived here: the
// composer's selector and this pane have to give the same answer about whether
// a provider can answer a turn, and two copies of that rule would drift.
import { anthropicUsable, keySourceLabel, openAiStatusLabel, openAiUsable } from './providerStatus';

/** What the user has to run before the Codex harness can do anything. */
export const CODEX_INSTALL_COMMAND = 'npm i -g @openai/codex';

/**
 * What signs the Claude Code CLI into an account.
 *
 * It is a command rather than a call, and that is the whole shape of this
 * feature. `claude auth login` opens a browser and finishes in a terminal the
 * person is looking at; there is no headless or device-code equivalent to hand
 * off to the way `apiOpenAiLogin` hands off codex's. So Hearth types it into
 * the terminal it already owns, in the project folder, and gets out of the
 * way. It never sees what comes back: the credential is the CLI's, it lands
 * wherever the CLI keeps it, and this pane only ever reads `claude auth status`
 * afterwards to find out how it went.
 */
export const CLAUDE_LOGIN_COMMAND = 'claude auth login';

/** How long "Copied" stays on the copy button before it goes back to "Copy". */
const COPIED_MS = 1400;

/**
 * How long the row will claim to be waiting for a browser sign-in.
 *
 * There has to be a number, because the flow this pane starts finishes in a
 * browser Hearth does not own and may never finish at all: the user closes the
 * tab, or takes the OAuth page as far as the password and walks away. Nothing
 * ever arrives to say so. Without a deadline the row latched on "Connecting",
 * on a status line reading "Waiting for the browser to finish signing in.",
 * with the Sign in button disabled, and the only way out was to close Settings
 * and open it again.
 *
 * Generous, because a real sign-in with a password manager and a second factor
 * is not quick, and giving up early on someone who is halfway through is the
 * worse mistake. Nothing is cancelled when it fires: the browser flow is not
 * ours to stop, and a sign-in that lands afterwards still arrives on the
 * socket and still turns the row green.
 */
const SIGN_IN_WAIT_MS = 5 * 60 * 1000;

/**
 * Dismiss the Settings dialog (see shell/SettingsDialog). A literal rather
 * than an import, because this pane is already reached FROM that module and
 * importing back into it would close a cycle for the sake of one string. The
 * five places that open Settings dispatch their event the same way.
 */
const CLOSE_SETTINGS_EVENT = 'hearth:close-settings';

/**
 * Where each vendor issues keys.
 *
 * Nominative use, the same as the logos on the rows: these are the pages you
 * get a key from, named because there is nowhere else to find them from inside
 * this app. Hearth has no relationship with either company, and linking to a
 * sign-up page is not one.
 *
 * They exist because of a gap that made the rest of this pane unfollowable: an
 * Electron window has no address bar, the placeholder read `sk-ant-…`, and
 * there was not one external link anywhere under settings. Someone without an
 * Anthropic account was being told to paste a thing with no route at all to
 * obtaining it.
 */
export const ANTHROPIC_KEYS_URL = 'https://console.anthropic.com/settings/keys';
export const OPENAI_KEYS_URL = 'https://platform.openai.com/api-keys';

export const KEY_SOURCE_URL: Record<ChatProvider, string> = {
  anthropic: ANTHROPIC_KEYS_URL,
  openai: OPENAI_KEYS_URL,
};

/**
 * A link out to the real web.
 *
 * The call is the app's one way of doing this (store.ts's sign-in, the game
 * pane's play URL, the Help menu's docs): `setWindowOpenHandler` in
 * electron/main.ts denies anything that is not localhost and hands it to
 * `shell.openExternal`, so it lands in the user's own browser rather than in a
 * chrome-less editor window with no way back. An anchor rather than a button
 * because it is a link, and because hovering one should say where it goes.
 */
function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      className="set-agent-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault();
        window.open(href, '_blank', 'noopener,noreferrer');
      }}
    >
      {children}
      {/* Drawn here rather than asked of `Icon`, which has no glyph for this
          and answers an unknown name with a silently wrong one. Same viewBox
          and stroke as that set, so it sits in the line at the same weight. */}
      <svg
        className="set-agent-link-mark"
        width="10"
        height="10"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4.6 2.5h4.9v4.9" />
        <path d="M9.5 2.5 5.2 6.8" />
        <path d="M8.2 7.9v1.6H2.5V3.8h1.6" />
      </svg>
    </a>
  );
}


/**
 * What a harness you have not set up says about itself.
 *
 * This pane refuses the words "missing" and "not installed". They describe the
 * user's machine as deficient, and on a screen whose entire job is to offer
 * things they could add, the honest reading of an empty row is that there is a
 * button next to it. So the line names the way in, in the harness's own terms,
 * and the button beside it does exactly that.
 *
 * Deliberately NOT in providerStatus: that module's sentences are written for
 * surfaces that have to explain a consequence to someone who did not come here
 * to fix it. These two are for the one screen that can.
 */
const NOT_CONNECTED_STATUS: Record<ChatProvider, string> = {
  anthropic: 'Not connected yet. Paste an API key and Claude can answer straight away.',
  openai: 'Not added yet. Hearth can install codex for you. Then you sign in.',
};

/**
 * The Claude row's two other unconnected sentences, because "not connected" is
 * three different situations there and one line cannot carry all three.
 *
 * The one that matters is the first. With the binary sitting on PATH and no
 * sign-in on it, the row used to fall through to NOT_CONNECTED_STATUS and send
 * someone off to the Anthropic console for a key they do not need and would be
 * billed for, when the thing that fixes it is one command and their existing
 * account. That is a worse failure than an unhelpful sentence: it costs money.
 *
 * It stops short of "you are signed out", for the same reason the codex row
 * does. `readClaudeAuth` reports `loggedIn: false` when the status command
 * times out, exits non-zero, or prints something this version cannot parse, so
 * a busy machine and a signed-out one are the same bytes on the wire. The row
 * says what it confirmed and offers the command; `unconfirmed` carries the
 * rest, so the hero above cannot make the claim the row is declining to.
 */
const CLAUDE_SIGNED_OUT_STATUS =
  'The Claude Code CLI is here, and no sign-in was confirmed. Signing in takes one command and no key.';

/**
 * ...and without the binary there is nothing a sign-in button could do, so the
 * line names the key route instead. Not "not installed" as a verdict on the
 * machine: it is one of two ways in, and the other one is on the row already.
 */
const CLAUDE_NO_CLI_STATUS =
  'The Claude Code CLI is not on this machine. Paste an API key and Claude can answer straight away.';

/**
 * Who the CLI says you are, in one line.
 *
 * Lives here rather than in providerStatus for the reason given above
 * NOT_CONNECTED_STATUS: this is the screen that can act on it. The plan word
 * is passed through verbatim (see server/claudeAuth.ts) because it is
 * Anthropic's vocabulary and it will grow, and either half may be missing —
 * some builds report a plan and no address, and an older one reports neither.
 */
export function claudeSignedInStatus(email: string | null, planType: string | null): string {
  if (email !== null) return planType !== null ? `Signed in as ${email} (${planType}).` : `Signed in as ${email}.`;
  if (planType !== null) return `Signed in to the Claude Code CLI on a ${planType} plan.`;
  // Neither, which is what an older build reports. Still a real sign-in, so
  // the line says the useful half: nothing else has to be set up.
  return 'Signed in to the Claude Code CLI. No key needed.';
}

/**
 * The row's primary control. A row offers exactly one of these, and which one
 * is decided entirely by the harness's real state — there is no state in which
 * a row shows a button that cannot work.
 */
export type AgentAction =
  /** A field and a Connect beside it: the whole of connecting, in one press. */
  | { kind: 'paste-key'; label: string; placeholder: string }
  /**
   * The vendor's own sign-in, started from here and finished elsewhere.
   *
   * Two shapes behind one kind, because a row offers one primary action and
   * the person pressing it wants the same thing either way. Codex hands back a
   * URL and Hearth opens it (`beginSignIn`); Claude has no such handoff, so
   * Hearth types `claude auth login` into the visible terminal and the CLI
   * takes it from there (`signInToClaude`). Which one runs is decided by
   * `card.provider` at the press, and neither ever touches the credential.
   */
  | { kind: 'sign-in'; label: string }
  /** The binary has to exist first. Hearth can run the install for you. */
  | { kind: 'install'; command: string }
  /** Connected by something this pane did not do and cannot undo. */
  | { kind: 'none' };

/** What taking the credential away means, said before it happens. */
export interface AgentDisconnect {
  label: string;
  confirmTitle: string;
  confirmBody: string;
  confirmLabel: string;
}

export interface AgentCard {
  provider: ChatProvider;
  /** The vendor's name for the thing, not the driver's. */
  name: string;
  /**
   * Has Hearth actually found out, or is this the answer to a question nobody
   * has asked yet?
   *
   * Separate from `connected` on purpose, and the most important field on this
   * type. `connected: false` used to carry both meanings, which is how a pane
   * with nothing read yet came to announce that nothing was connected to a
   * user whose machine was fully set up. A card that is not `known` makes no
   * claim in either direction and offers no button that presumes one.
   */
  known: boolean;
  /**
   * When `known` is false, how the read that would have settled it went.
   *
   * The field this row was missing, and the reason a failed read rendered
   * byte-identically to a read nobody had started: both left the same null and
   * the card had no way to tell them apart, so the row said "Hearth has not
   * read it yet" forever and offered nothing to press. `failed` is never
   * allowed to wear a `checking` sentence, and the pane hangs a Check again on
   * every value of this that is not `ok`. Meaningless when `known`.
   */
  read: ReadState;
  /**
   * Could this harness answer a turn right now? Only meaningful when `known`.
   */
  connected: boolean;
  /**
   * Is `connected: false` a fact, or only what a probe that did not answer
   * leaves behind?
   *
   * True on exactly one card state, and it is the state the hero used to talk
   * over: codex installed, `loggedIn: false`. `readCodexStatus` reports that
   * same shape when its probe times out, so the row below says "a busy machine
   * can look exactly like this" while the hero two inches above announced that
   * nothing was connected and Hearth could not answer a message. One of those
   * two was wrong, and the largest piece of copy on the screen is not the
   * place to be the confident one.
   */
  unconfirmed: boolean;
  /** One line: where the credential came from, or what has not been asked. */
  status: string;
  action: AgentAction;
  /** Null when there is nothing here to take back. */
  disconnect: AgentDisconnect | null;
  /** A second, quieter path — offered only where one genuinely exists. */
  altKey: { label: string; hint: string; placeholder: string } | null;
}

/**
 * The Claude row. The source of truth is the app settings read-out, with the
 * providers read-out as a fallback: they are gathered by different routes and
 * either one may land first.
 *
 * An environment key is connected but not ours to remove — unsetting a shell
 * variable is not something a settings pane gets to do, and offering a
 * Disconnect that silently did nothing would be a lie.
 *
 * THERE ARE TWO WAYS IN AND THEY ARE ALTERNATIVES, which is the thing the
 * branches below are ordered to say. A signed-in CLI answers on the account
 * the person already pays for; a key is billed per token. So a sign-in that
 * has been confirmed is reported first and a key is never presented as the
 * step after it. What each state offers:
 *
 *   loggedIn                signed in, named, with Sign in again
 *   cli, no sign-in         the one command that fixes it, NOT a key hunt
 *   a key, either source    connected on the key, and the key is what the
 *                           row manages, because that is what this pane wrote
 *   no cli, no key          the key route, since a sign-in cannot run here
 *
 * The middle one is the reason this exists. It used to render as "Not
 * connected yet. Paste an API key", to someone with the binary on PATH and a
 * Claude subscription already, which sent them to buy API credit to solve a
 * problem one command solves for nothing.
 */
export function anthropicCard(
  settings: AppSettingsInfo | null,
  providers: ChatProviderStatus | null,
  environment: AgentEnvironment = UNKNOWN_ENVIRONMENT,
): AgentCard {
  // Both read-outs are project-scoped, so with no project open neither has
  // been asked and there is nothing here to report. An environment key is a
  // fact about the machine and may well be sitting there. Saying "Not
  // connected yet" over the top of it is the false negative this branch exists
  // to refuse. See agentEnvironment.ts.
  if (settings === null && providers === null) {
    // ...and with a project open, the same nulls mean one of two very
    // different things. `refreshSettings` and `refreshProviders` both keep the
    // last value on a null answer, which is right, but it means an HTTP 500, a
    // network throw and a request nobody has sent yet all arrive here
    // identically. Reading the second one out as the first is the regression
    // this branch was shipped with: a permanent "Looking for a key", no error,
    // no spinner, and not one control on the row.
    const failed = environment.projectRead === 'failed';
    return {
      provider: 'anthropic',
      name: 'Claude',
      known: false,
      read: environment.hasProject ? environment.projectRead : 'unread',
      connected: false,
      unconfirmed: false,
      status: !environment.hasProject
        ? 'Not checked yet. A key can live in a project or in ANTHROPIC_API_KEY. Hearth reads both once a project is open.'
        : failed
          ? 'Hearth could not finish reading this project, so it cannot say whether a key is here.'
          : 'Looking for a key in this project.',
      action: { kind: 'none' },
      disconnect: null,
      altKey: null,
    };
  }
  const anthropic = providers?.anthropic ?? null;
  const source = settings?.source ?? anthropic?.source ?? null;
  // A KEY, not "anything that could answer". It used to read
  // `anthropicUsable(providers)`, which is the right question for the composer
  // and the wrong one here: that helper now says yes to a signed-in CLI with
  // no key at all, and this value decides whether the row offers to REMOVE a
  // key. A signed-in user with nothing saved would have been handed a Remove
  // key button for a file that does not exist.
  const hasKey = settings?.hasKey === true || anthropic?.hasKey === true;
  // `cli` is only the binary on PATH; `loggedIn` is the one that decides
  // whether it can answer. Both default to false only once `providers` has
  // actually landed — the branch above owns the case where it has not, so
  // there is no state here where a false is being invented.
  const loggedIn = anthropic?.loggedIn === true;
  const cliHere = anthropic?.cli === true;
  const status = keySourceLabel(source);
  // Any credential that is not the one this pane wrote into the open project:
  // an environment variable today, and whatever else `source` grows to mean.
  // The shape of the answer is the same for all of them — connected, and not
  // ours to take away — so the branch is written on "not project" rather than
  // on the one value that exists, and a third auth state slots in here without
  // this function being rewritten.
  if (source !== null && source !== 'project') {
    return {
      provider: 'anthropic',
      name: 'Claude',
      known: true,
      read: 'ok',
      connected: true,
      unconfirmed: false,
      status,
      action: { kind: 'none' },
      disconnect: null,
      altKey: {
        label: 'Use a key for this project instead',
        hint: 'Saved in this project, and used ahead of the environment one.',
        placeholder: 'sk-ant-…',
      },
    };
  }
  if (hasKey) {
    return {
      provider: 'anthropic',
      name: 'Claude',
      known: true,
      read: 'ok',
      connected: true,
      unconfirmed: false,
      status,
      action: { kind: 'none' },
      disconnect: {
        // The same word as the Codex row's, because it is the same operation:
        // one saved key, deleted from one file. Two providers offering the
        // identical act under two different trigger words made a user work out
        // that they were identical, and "Disconnect" also overclaimed, since
        // it is the key that goes and nothing else.
        label: 'Remove key',
        confirmTitle: 'Remove the Anthropic key?',
        confirmBody:
          'The key is deleted from .hearth/app.json in this project. Claude cannot answer again until you paste one back in.',
        confirmLabel: 'Remove key',
      },
      altKey: { label: 'Replace the key', hint: 'The old one is overwritten.', placeholder: 'sk-ant-…' },
    };
  }
  // No key anywhere. The CLI's own account is the other way in, and from here
  // down the row is about that rather than about a key.
  if (loggedIn) {
    return {
      provider: 'anthropic',
      name: 'Claude',
      known: true,
      read: 'ok',
      connected: true,
      unconfirmed: false,
      status: claudeSignedInStatus(anthropic?.email ?? null, anthropic?.planType ?? null),
      // The same offer the ChatGPT row makes when it is connected, because it
      // answers the same question: this is the row you come to when you want
      // to be a different account, and there is nothing else here that does
      // it. Nothing is signed out first — the CLI replaces its own session.
      action: { kind: 'sign-in', label: 'Sign in again' },
      // Nothing was stored by this pane, so there is nothing for it to delete.
      // Signing out is the CLI's to do, and a button here that claimed to do
      // it would be claiming to touch a credential Hearth never holds.
      disconnect: null,
      altKey: {
        label: 'Use an API key instead',
        hint: 'An alternative to the sign-in, and used ahead of it. Saved in this project.',
        placeholder: 'sk-ant-…',
      },
    };
  }
  if (cliHere) {
    return {
      provider: 'anthropic',
      name: 'Claude',
      // The read landed, so this row is not "unchecked" and the pane may still
      // open with "set up your first agent".
      known: true,
      read: 'ok',
      connected: false,
      // ...but the sign-in specifically is not settled, for the same reason
      // the codex row's is not: `readClaudeAuth` reports this exact shape when
      // its status command times out or prints something it cannot parse. The
      // row offers the sign-in, as it must, and the hero reads this field
      // rather than announcing a disconnection over the top of it.
      unconfirmed: true,
      status: CLAUDE_SIGNED_OUT_STATUS,
      // The primary action, and it is the sign-in rather than the key. The
      // binary is right there and the person almost certainly has an account
      // for it; sending them to buy API credit instead is the expensive
      // mistake this whole branch exists to stop.
      action: { kind: 'sign-in', label: 'Sign in to Claude Code' },
      disconnect: null,
      altKey: {
        label: 'Use an API key instead',
        hint: 'An alternative to signing in, and used ahead of it. Saved in this project.',
        placeholder: 'sk-ant-…',
      },
    };
  }
  return {
    provider: 'anthropic',
    name: 'Claude',
    known: true,
    read: 'ok',
    connected: false,
    unconfirmed: false,
    // `keySourceLabel` is written for surfaces that have to explain a
    // consequence ("without one, the conversation can only point you at the
    // Terminal"). On this pane the row already carries the button that fixes
    // it, so the line says what to do instead of what is wrong. A dashboard
    // that tells you what you lack reads worse than one that offers.
    //
    // Which of the two sentences depends on whether the providers read has
    // landed at all. Without it there is no `cli` field to have read, and
    // saying the CLI is not on this machine would be a claim off no evidence.
    status: anthropic === null ? NOT_CONNECTED_STATUS.anthropic : CLAUDE_NO_CLI_STATUS,
    // No binary, so no sign-in button: it would type a command that answers
    // "command not found". The key route is the one that works from here.
    action: { kind: 'paste-key', label: 'Connect', placeholder: 'sk-ant-…' },
    disconnect: null,
    altKey: null,
  };
}

/**
 * The Codex CLI's row. Ordered by what blocks the user first: no binary is a
 * different problem from no sign-in, and a Sign in button on a machine
 * without `codex` is a button that fails.
 */
export function openAiCard(
  providers: ChatProviderStatus | null,
  environment: AgentEnvironment = UNKNOWN_ENVIRONMENT,
): AgentCard {
  const openai = providers?.openai;
  const status = openAiStatusLabel(openai);
  const name = 'ChatGPT';
  const removeKey: AgentDisconnect = {
    // The same word as the Claude row's Remove key. See the note there.
    label: 'Remove key',
    confirmTitle: 'Remove the OpenAI key?',
    confirmBody:
      'The key is deleted from .hearth/app.json in this project. A ChatGPT sign-in, if you have one, is left alone.',
    confirmLabel: 'Remove key',
  };
  const altKey = {
    label: 'Use an API key instead',
    hint: 'An alternative to signing in. Saved in this project.',
    placeholder: 'sk-…',
  };

  // Nothing project-scoped has been read. Unlike the Anthropic side, half of
  // this question is still answerable: whether `codex` exists is a fact about
  // the machine, and `/api/agent-clis` answers it without a project. The other
  // half, the sign-in, lives in ~/.codex and has no unscoped reader today.
  if (!openai) {
    if (environment.codexInstalled === null) {
      // Null for two reasons, and they get different sentences. "Checking"
      // that outlives the request it describes is a spinner that never stops,
      // which is the same failure as a permanent "not read yet".
      const failed = environment.machineRead === 'failed';
      return {
        provider: 'openai',
        name,
        known: false,
        read: environment.machineRead,
        connected: false,
        unconfirmed: false,
        status: failed
          ? 'Hearth could not check this machine for codex.'
          : 'Checking this machine for codex.',
        action: { kind: 'none' },
        disconnect: null,
        altKey: null,
      };
    }
    if (!environment.codexInstalled) {
      // A real answer from a real read, so the row may offer the install. The
      // only thing PATH cannot see is a project's own `codexPath` override,
      // and with no project open there is no project to hold one.
      return {
        provider: 'openai',
        name,
        known: true,
        read: 'ok',
        connected: false,
        unconfirmed: false,
        status: NOT_CONNECTED_STATUS.openai,
        action: { kind: 'install', command: CODEX_INSTALL_COMMAND },
        disconnect: null,
        altKey: null,
      };
    }
    const failed = environment.hasProject && environment.projectRead === 'failed';
    return {
      provider: 'openai',
      name,
      known: false,
      read: environment.hasProject ? environment.projectRead : 'unread',
      connected: false,
      unconfirmed: false,
      status: failed
        ? 'Codex is installed. Hearth could not finish reading this project, so it cannot say whether you are signed in.'
        : 'Codex is installed. Your sign-in is kept in ~/.codex, and Hearth has not read it yet.',
      action: { kind: 'none' },
      disconnect: null,
      altKey: null,
    };
  }
  if (!openai.installed) {
    return {
      provider: 'openai',
      name,
      known: true,
      read: 'ok',
      connected: false,
      unconfirmed: false,
      // Not "Not installed." This is the row you are meant to press, so it
      // says that. See NOT_CONNECTED_STATUS.
      status: NOT_CONNECTED_STATUS.openai,
      action: { kind: 'install', command: CODEX_INSTALL_COMMAND },
      disconnect: null,
      altKey: null,
    };
  }
  if (openai.loggedIn) {
    return {
      provider: 'openai',
      name,
      known: true,
      read: 'ok',
      connected: true,
      unconfirmed: false,
      status,
      action: { kind: 'sign-in', label: 'Sign in again' },
      disconnect: openai.hasKey ? removeKey : null,
      altKey: openai.hasKey ? null : altKey,
    };
  }
  return {
    provider: 'openai',
    name,
    // Known: the read genuinely landed, and this is the state a brand new user
    // is in, so the pane must still open with "set up your first agent" rather
    // than with "not checked yet".
    //
    // What is NOT settled is the sign-in specifically. `loggedIn: false` is
    // also what the driver reports when its probe failed to answer at all (see
    // providerStatus), so the row offers a sign-in, as it must, while the
    // status line stops short of calling anyone signed out and the body says a
    // busy machine looks exactly like this.
    known: true,
    read: 'ok',
    connected: openAiUsable(providers),
    // ...and this is where that gets recorded for everything outside this row.
    // A saved key settles it; a bare `loggedIn: false` does not, and the hero
    // reads this field rather than making the claim the row is refusing to.
    unconfirmed: !openai.hasKey,
    status,
    action: { kind: 'sign-in', label: 'Sign in with ChatGPT' },
    disconnect: openai.hasKey ? removeKey : null,
    altKey: openai.hasKey ? null : altKey,
  };
}

export function agentCards(
  settings: AppSettingsInfo | null,
  providers: ChatProviderStatus | null,
  environment: AgentEnvironment = UNKNOWN_ENVIRONMENT,
): AgentCard[] {
  return [anthropicCard(settings, providers, environment), openAiCard(providers, environment)];
}

/** A harness registry entry, paired with what this machine says about it. */
export interface AgentRow {
  backend: AgentBackend;
  card: AgentCard;
}

/**
 * The list the pane renders, driven by the registry rather than by a literal.
 *
 * ADDING A HARNESS is four things and no more:
 *   1. a driver on the server that can answer a turn with it, which is the
 *      only thing that makes it honest to list at all;
 *   2. its `ChatProvider` id, and a branch in `/api/chat/providers` that
 *      reports whether it is connected and which models it drives;
 *   3. an `AGENT_BACKENDS` entry naming it, what it drives, and how it is
 *      connected (`api-key` or `sign-in`);
 *   4. a card builder here, saying what its one primary action is in each of
 *      its states.
 * Nothing else in this file, and nothing at all in the CSS: the row shape,
 * the disclosure, the model switches and the persistence are already general.
 */
export function agentRows(
  settings: AppSettingsInfo | null,
  providers: ChatProviderStatus | null,
  environment: AgentEnvironment = UNKNOWN_ENVIRONMENT,
): AgentRow[] {
  const cards = new Map(agentCards(settings, providers, environment).map((card) => [card.provider, card]));
  return AGENT_BACKENDS.flatMap((backend) => {
    const card = cards.get(backend.provider);
    return card ? [{ backend, card }] : [];
  });
}

/** The five looks a row can have, in the order they are legible at a glance. */
export type AgentCardState = 'connecting' | 'connected' | 'unchecked' | 'unavailable' | 'idle';

export function cardState(card: AgentCard, connecting: boolean): AgentCardState {
  if (connecting) return 'connecting';
  // Ahead of `connected`, because a card nobody has read is not entitled to
  // either answer. It is only below `connecting` because a sign-in this pane
  // started is something it watched happen.
  if (!card.known) return 'unchecked';
  if (card.connected) return 'connected';
  if (card.action.kind === 'install') return 'unavailable';
  return 'idle';
}

/**
 * What the badge says, and it only says anything when there is something
 * good to report.
 *
 * A harness you have not set up gets no badge at all: the slot holds its
 * primary action instead, so an agent you do not have reads as something you
 * can add rather than as something you lack. "Missing" and "Not installed" are
 * states this pane refuses to label, because they describe the user's machine
 * as deficient when the honest reading is that there is a button to press.
 */
export const STATE_BADGE: Record<AgentCardState, string | null> = {
  connecting: 'Connecting',
  connected: 'Connected',
  // A harness nobody has asked about gets no badge either, for the opposite
  // reason: there is nothing good to report and nothing bad to report, and a
  // badge is a claim. The row's own line says what has not been read.
  unchecked: null,
  unavailable: null,
  idle: null,
};

/**
 * Who would answer the next message. The standing choice wins because that is
 * what the send path actually reads (store.ts sends it with every turn); the
 * server's saved provider is the answer only until someone picks one.
 */
export function activeProvider(
  choice: AgentChoice | null,
  providers: ChatProviderStatus | null,
): ChatProvider | null {
  return choice?.provider ?? providers?.active ?? null;
}

/**
 * Every model a harness can drive, switched-off ones included.
 *
 * `NOTHING_DISABLED` is the whole point: this is the one screen that has to
 * show a model the user turned off, because it is the screen with the switch
 * on it. Everywhere else reads the filtered list. Server-curated where the
 * read-out has them, the composer's fallback otherwise — the same list, from
 * the same place, so neither surface can offer a model the other has never
 * heard of.
 */
export function modelOptions(provider: ChatProvider, providers: ChatProviderStatus | null): ProviderModelInfo[] {
  const group = modelGroups(providers, NOTHING_DISABLED).find((g) => g.provider === provider);
  const models = group ? group.models : [];
  return models.some((m) => m.id === '') ? models : [{ id: '', label: 'Automatic' }, ...models];
}

/**
 * The models a harness's switch list shows: its catalogue, without the row
 * that hands the choice back. Automatic is not a model and has no switch —
 * it is what a harness falls back to when the model it was pointed at is no
 * longer offered, so it is the one thing that must always be there.
 */
export function switchableModels(
  provider: ChatProvider,
  providers: ChatProviderStatus | null,
): ProviderModelInfo[] {
  return modelOptions(provider, providers).filter((model) => model.id !== '');
}

/** The `<select>` value for a row: '' is the harness's own default. */
export function selectedModelValue(choice: AgentChoice | null, provider: ChatProvider): string {
  if (choice === null || choice.provider !== provider) return '';
  return choice.model ?? '';
}

/** "3 of 4 offered", or the honest singular. Shown beside the Models heading. */
export function modelCountLabel(offered: number, total: number): string {
  if (total === 0) return 'Nothing reported yet';
  if (offered === total) return total === 1 ? '1 model offered' : `All ${total} offered`;
  return `${offered} of ${total} offered`;
}

/**
 * The terminal, said plainly and at full size.
 *
 * Nothing here is a control, which is the point: there is nothing to connect,
 * nothing to pair, and nothing to configure. It is a shell in the open project
 * running as you, so the honest description of what it supports is "whatever
 * you have", and the named list is a keyboard shortcut rather than a
 * compatibility matrix.
 *
 * The names are the SERVER's list (server/agentClis.ts), read the same way the
 * composer's menu reads it, so this cannot drift into advertising a row the
 * menu does not offer. Install state is deliberately not shown: this card is
 * about what the terminal can run, not about what today's machine happens to
 * have, and greying out most of the list would say the opposite of what the
 * card is for.
 */
function TerminalSection() {
  const clis = useAgentClis();
  const names = clis.state === 'ready' ? clis.clis.map((cli) => cli.label) : [];
  return (
    <section className="set-agent-section">
      <div className="set-agent-section-head">
        <h3 className="set-agent-section-title">Terminal</h3>
        <span className="set-agent-count">Nothing to set up</span>
      </div>
      <p className="set-agent-hint">
        The terminal is a real shell in your open project, running as you. Any agent CLI you already have works there,
        whether or not Hearth has heard of it. Start one from the model menu on the composer, or open a terminal and
        type it yourself.
      </p>
      {names.length > 0 && (
        <p className="set-agent-hint">
          Hearth can type these for you: {names.join(', ')}. Anything else, you type. There is no difference to how it
          runs.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

export function AgentsPane() {
  const project = useApp((s) => s.projectPath);
  const settings = useApp((s) => s.settings);
  const providers = useApp((s) => s.providers);
  const refreshSettings = useApp((s) => s.refreshSettings);
  const refreshProviders = useApp((s) => s.refreshProviders);
  const setConversationMode = useApp((s) => s.setConversationMode);
  const sendFrame = useApp((s) => s.sendFrame);
  const wsConnected = useApp((s) => s.wsStatus === 'connected');
  const log = useApp((s) => s.log);
  const choice = useModelChoice();
  const disabled = useDisabledModels();
  const { session } = useAgentSocket();

  // Which row is open. One at a time: two expanded rows is the wall of
  // controls this pane exists to avoid, and the rows are tall.
  const [open, setOpen] = useState<ChatProvider | null>(null);
  // Drafts are per provider and never pre-filled: a saved key does not come
  // back from the server, so an empty box is the truthful box.
  const [drafts, setDrafts] = useState<Record<ChatProvider, string>>({ anthropic: '', openai: '' });
  const [showField, setShowField] = useState<Record<ChatProvider, boolean>>({ anthropic: false, openai: false });
  // What looks wrong with the key in the box, and whether the user has been
  // told once already. The second press is what saves it anyway: Hearth does
  // not get to decide that a string it does not recognise is not a key.
  const [keyProblem, setKeyProblem] = useState<Record<ChatProvider, string | null>>({ anthropic: null, openai: null });
  const [busy, setBusy] = useState<ChatProvider | null>(null);
  const [confirming, setConfirming] = useState<AgentCard | null>(null);
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  // WHICH command was copied, not merely that one was. There are two of them
  // on this pane now (the codex install and the Claude sign-in), and a shared
  // boolean would have flipped both buttons to "Copied" on either press.
  const [copied, setCopied] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const signInTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // What has actually been read, of the machine and of the project, and how
  // each read went. On Home the machine half is the only thing the pane has,
  // and it is the difference between an honest "not checked yet" and the
  // confident lie that used to be here. With a project open it is also the
  // difference between "still reading" and "the read failed", which is the
  // one the rewrite lost. The hook owns the mount read, so there is exactly
  // one place this pane asks from, and never two asks in flight at once.
  const { environment, recheck, checking } = useAgentEnvironment(project);

  const rows = agentRows(settings, providers, environment);
  const active = activeProvider(choice, providers);
  const bothUsable = anthropicUsable(providers) && openAiUsable(providers);
  const signedIn = providers?.openai.loggedIn === true;
  // Three different opening states, and conflating the first two is the bug
  // this pane was shipped with. "Nothing is connected" is a claim, and it may
  // only be made once every row has actually been read.
  const allKnown = rows.every((row) => row.card.known);
  const noneConnected = allKnown && rows.every((row) => !row.card.connected);
  // ...and the fourth, which the hero used to talk straight over. A row whose
  // negative is only what a timed-out probe looks like does not entitle the
  // largest sentence on the screen to say nothing is connected. See
  // `AgentCard.unconfirmed`.
  const someUnconfirmed = rows.some((row) => row.card.unconfirmed);
  // Can Claude be signed in from here right now?
  //
  // The hero has to know, because its standing recommendation is "paste an
  // Anthropic API key" and that is the wrong advice the moment the CLI is on
  // the machine: the sign-in uses the subscription the person already has and
  // a key is metered. Recommending the paid route over the free one, in the
  // largest copy on the screen, is the same mistake the row itself was making.
  const claudeSignIn = rows.some(
    (row) => row.card.provider === 'anthropic' && row.card.action.kind === 'sign-in' && !row.card.connected,
  );
  const prefsFile = getModelPrefsFile();

  // The browser flow finishes somewhere else entirely and arrives as a
  // `chat-providers` broadcast; this is the row noticing it landed.
  useEffect(() => {
    if (!signedIn) return;
    if (signInTimer.current !== null) {
      clearTimeout(signInTimer.current);
      signInTimer.current = null;
    }
    setSigningIn(false);
  }, [signedIn]);

  useEffect(() => () => {
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    if (signInTimer.current !== null) clearTimeout(signInTimer.current);
  }, []);

  const commit = useCallback(
    async (provider: ChatProvider, patch: ProviderSettingsPatch): Promise<void> => {
      if (!project) return;
      setBusy(provider);
      try {
        await apiSaveProviderSettings(project, patch);
        await Promise.all([refreshSettings(), refreshProviders()]);
      } finally {
        setBusy(null);
      }
    },
    [project, refreshProviders, refreshSettings],
  );

  /**
   * Save the pasted key, once it has been looked at.
   *
   * The check is a warning, not a gate, and the two presses are the whole
   * design. Before it, `trim() !== ''` was the entire test: a truncated paste
   * or an outright wrong string was written to disk, answered for with
   * `hasKey: true`, and shown as a green Connected badge, and the user found
   * out from a turn that failed much later, with nothing pointing back here.
   * A first press on something that looks wrong says so and saves nothing; a
   * second press saves it, because Hearth does not get to tell its user that a
   * string it did not recognise is not their key.
   *
   * It is a SHAPE check and the copy says only that. Telling a real key from a
   * well-formed fake needs a request to the vendor, which belongs on the
   * server, not in this renderer.
   */
  const connect = useCallback(
    async (provider: ChatProvider): Promise<void> => {
      const value = drafts[provider].trim();
      if (value === '') return;
      const problem = keyShapeProblem(provider, value);
      if (problem !== null && keyProblem[provider] === null) {
        setKeyProblem((p) => ({ ...p, [provider]: problem }));
        return;
      }
      setKeyProblem((p) => ({ ...p, [provider]: null }));
      // An empty string is a real instruction to the server (remove the key),
      // which is why nothing is sent for a provider that was left alone.
      await commit(provider, provider === 'anthropic' ? { apiKey: value } : { openaiApiKey: value });
      setDrafts((d) => ({ ...d, [provider]: '' }));
      setShowField((s) => ({ ...s, [provider]: false }));
    },
    [commit, drafts, keyProblem],
  );

  const disconnect = useCallback(
    async (provider: ChatProvider): Promise<void> => {
      await commit(provider, provider === 'anthropic' ? { apiKey: '' } : { openaiApiKey: '' });
      setDrafts((d) => ({ ...d, [provider]: '' }));
      setShowField((s) => ({ ...s, [provider]: false }));
      setKeyProblem((p) => ({ ...p, [provider]: null }));
    },
    [commit],
  );

  /** Stop claiming to be waiting. Safe to call when nothing is waiting. */
  const stopWaiting = useCallback((): void => {
    if (signInTimer.current !== null) {
      clearTimeout(signInTimer.current);
      signInTimer.current = null;
    }
    setSigningIn(false);
  }, []);

  /**
   * Start the ChatGPT sign-in, and be honest about it for exactly as long as
   * it might still be happening.
   *
   * `apiOpenAiLogin` rather than the store's `startOpenAiLogin`, and that is
   * the point of this callback existing: the store action answers `void`
   * whether the server handed back an auth URL or refused with a 400, so the
   * row had no way to know the flow never started and sat there saying it was
   * waiting for a browser that was never opened. Here a refusal clears the
   * badge in the same tick it happens, and says what went wrong.
   */
  const beginSignIn = useCallback((): void => {
    if (!project) return;
    setSigningIn(true);
    if (signInTimer.current !== null) clearTimeout(signInTimer.current);
    signInTimer.current = setTimeout(() => {
      signInTimer.current = null;
      setSigningIn(false);
      log(
        'info',
        'app',
        'Hearth stopped waiting for the ChatGPT sign-in. If you finished it in the browser, press Check again.',
      );
    }, SIGN_IN_WAIT_MS);
    void (async () => {
      const result = await apiOpenAiLogin(project).catch(() => ({ ok: false }) as { ok: boolean; error?: string });
      if (result.ok && 'authUrl' in result && typeof result.authUrl === 'string' && result.authUrl !== '') {
        // The flow finishes in a real browser (it is an OAuth page, and Codex
        // owns the callback); the app hears about it as a `chat-providers`
        // broadcast rather than by polling. Same window handler the rest of
        // the app uses: electron/main.ts sends it to the user's own browser.
        window.open(result.authUrl, '_blank', 'noopener,noreferrer');
        return;
      }
      stopWaiting();
      const note = result.error ?? 'Could not start the ChatGPT sign-in.';
      log('error', 'app', note);
      showToast(note, 'error');
    })();
  }, [log, project, stopWaiting]);

  /** Pick which harness answers. Written to both places, because both are read. */
  const choose = useCallback(
    (provider: ChatProvider, model: string | null): void => {
      setModelChoice(choiceForModel(getModelChoice(), provider, model, providers));
      void commit(provider, { provider });
    },
    [commit, providers],
  );

  /**
   * Flip one model's switch.
   *
   * The server answers with the whole list and that answer replaces the
   * mirror, so a failed write leaves the switch exactly where it was rather
   * than showing a change that did not land. `setModelEnabled` also reconciles
   * the standing choice, which is what stops a switched-off model from still
   * being the thing the next turn sends.
   */
  const toggleModel = useCallback(
    async (provider: ChatProvider, id: string, enabled: boolean): Promise<void> => {
      const key = `${provider}:${id}`;
      setSaving(key);
      try {
        const ok = await setModelEnabled(provider, id, enabled);
        if (!ok) log('error', 'app', `Could not save that model preference. ${id} is unchanged.`);
      } finally {
        setSaving(null);
      }
    },
    [log],
  );

  const copyCommand = useCallback((command: string): void => {
    void navigator.clipboard?.writeText(command);
    setCopied(command);
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(null), COPIED_MS);
  }, []);

  /**
   * Type a command into the terminal the user can see, and take them to it.
   *
   * Never a silent shell-out. It goes through the same planner and the same
   * pty frames the composer's terminal rows use, so the command lands in a
   * visible shell, with its own output, in the project folder. The planner
   * also does the one refusal that matters: it will not type into a session
   * Hearth started an agent in, where a command is not a command but a
   * sentence the agent would read as a prompt.
   *
   * `markAgentCli` is deliberately NOT called. Neither of the two things this
   * runs is an agent session, and claiming either was one would block the very
   * next thing the user wants to do in that same terminal.
   *
   * One helper for both, because they are one act: the codex install and the
   * Claude sign-in differ in the string and in nothing else, and a second copy
   * of this would be a second place for the pty frames to drift.
   */
  const runInTerminal = useCallback(
    (id: string, command: string, label: string): void => {
      const plan = planTerminalLaunch({
        cli: { id, command, label, installed: true, installHint: null },
        status: session.status,
        launched: session.cli,
        connected: wsConnected,
        hasProject: project !== null,
      });
      if (plan.action === 'blocked') {
        log('error', 'app', plan.reason);
        return;
      }
      const down = 'Terminal: the connection is down. Wait a moment and try again.';
      if (plan.action === 'start') {
        if (!sendFrame({ type: 'pty-start', sessionId: ensureAgentPtySessionId() })) {
          log('error', 'app', down);
          return;
        }
        // Marked running before the mode flips, because TerminalPane starts a
        // shell of its own when it mounts onto an idle session.
        markAgentStarted('shell');
      }
      if (plan.action !== 'show' && !sendFrame({ type: 'pty-input', data: `${command}\n` })) {
        log('error', 'app', down);
        return;
      }
      setConversationMode('terminal');
      window.dispatchEvent(new CustomEvent(CLOSE_SETTINGS_EVENT));
    },
    [log, project, sendFrame, session.cli, session.status, setConversationMode, wsConnected],
  );

  const runInstall = useCallback((): void => {
    runInTerminal('codex-install', CODEX_INSTALL_COMMAND, 'Codex install');
  }, [runInTerminal]);

  /**
   * Sign the Claude Code CLI in, which Hearth does by getting out of the way.
   *
   * `claude auth login` is interactive: it opens a browser and then waits in
   * the terminal for the person to come back. There is no headless or
   * device-code route to drive it the way `apiOpenAiLogin` drives codex's, and
   * inventing one would mean Hearth handling a credential that is not its
   * business. So this types the command and switches to the terminal, and the
   * conversation from there is between the person and Anthropic.
   *
   * Nothing waits on it here. Unlike the ChatGPT flow there is no browser
   * callback landing on our socket, so there is no "Connecting" to latch on
   * and nothing to time out — the sign-in shows up on the next providers read,
   * and the row's Check again is how you ask for one early.
   */
  const signInToClaude = useCallback((): void => {
    runInTerminal('claude-login', CLAUDE_LOGIN_COMMAND, 'Claude sign-in');
  }, [runInTerminal]);

  return (
    <>
      <h2 className="set-pane-title">Agents</h2>
      <p className="set-pane-lead">
        A chat agent is a harness paired with a model. The harness holds the connection. The model does the thinking.
        Connect a harness, then choose which of its models you want offered.
      </p>

      {/* NO PROJECT OPEN, and this block is the whole of the fix for what used
          to be here. The pane read from nulls and announced that nothing was
          connected and Hearth could not answer a message, to users with codex
          installed, signed into ChatGPT, and ANTHROPIC_API_KEY already in their
          shell. Every one of those is a fact about the machine; none of them is
          a fact about a project. A provider pane is allowed to be uncertain and
          is allowed to be wrong, but a confident false negative is the one
          failure that sends someone off to fix what is not broken.

          It also carries the way out. Every route to connecting was gated on
          `!project` and Settings offered no way to open one, so the pane was a
          dead end you had to guess your way out of. */}
      {!project ? (
        <section className="set-agent-start">
          <h3 className="set-agent-start-title">Not checked yet</h3>
          <p className="set-agent-start-body">
            Keys and sign-ins are read out of the project you have open. There is no project yet, so Hearth has not
            looked. That is not the same as nothing being connected: a key already on this machine, or a ChatGPT
            sign-in you did through codex, is found the moment a project opens.
          </p>
          <div className="set-agent-start-actions">
            <Button variant="primary" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_FOLDER_EVENT))}>
              Open a project…
            </Button>
            <button type="button" className="set-agent-more" onClick={recheck} disabled={checking}>
              {checking ? 'Checking…' : 'Check this machine again'}
            </button>
          </div>
          <p className="set-agent-start-note">
            A key you paste is written to <span className="mono">.hearth/app.json</span> in that project.
          </p>
        </section>
      ) : (
        /* Nothing connected. This is the first thing most people ever see here,
           so it gets an answer rather than a list to work out: one harness, the
           shortest honest route to a working chat, and one button.

           WHICH route depends on what is on the machine, and getting that
           backwards costs real money. With the Claude Code CLI sitting on PATH
           the shortest route is signing it in: it runs on the subscription the
           person already has, and it is one command. Only without it is a
           pasted key the quickest way in. This block recommended the key
           unconditionally, which meant telling someone with a Max plan and the
           binary already installed to go and buy metered API credit.

           The first sentence is the one that has to be earned. "Nothing is
           connected" is a claim about both rows, and it may not be louder than
           the rows themselves: with codex installed and `loggedIn: false` the
           pane's own body says a busy machine looks exactly like this and
           nothing has signed you out, and the hero was contradicting it two
           inches higher in the largest type on the screen. So when any row's
           negative is unconfirmed, this says what it actually knows and lets
           the row below carry the rest. */
        noneConnected && (
          <section className="set-agent-start">
            <h3 className="set-agent-start-title">Set up your first agent</h3>
            <p className="set-agent-start-body">
              {claudeSignIn
                ? 'The Claude Code CLI is on this machine, and no sign-in was confirmed on it. Signing in is the quickest way in and costs nothing extra: one command in the terminal, on the account you already have. If you already signed in, the check may simply have timed out. Asking again settles it.'
                : someUnconfirmed
                  ? 'Hearth has not confirmed a connection here yet. If you are already signed into ChatGPT, the check below may simply have timed out. Asking again is the quickest way to find out. The surest route to a working chat is an Anthropic API key: paste one and Claude can answer straight away, with nothing to install.'
                  : 'Nothing is connected yet, so Hearth cannot answer a message. The quickest way in is an Anthropic API key: paste one and Claude can answer straight away, with nothing to install.'}
            </p>
            <div className="set-agent-start-actions">
              {claudeSignIn ? (
                <Button variant="primary" disabled={!project} onClick={signInToClaude}>
                  Sign in to Claude Code
                </Button>
              ) : (
                <Button
                  variant="primary"
                  onClick={() => {
                    setOpen('anthropic');
                    setShowField((s) => ({ ...s, anthropic: true }));
                  }}
                >
                  Connect Claude with a key
                </Button>
              )}
              {/* The other route, named in the same breath rather than left to
                  be discovered. Which one this is depends on which one the
                  button beside it took. */}
              {claudeSignIn && (
                <button
                  type="button"
                  className="set-agent-more"
                  onClick={() => {
                    setOpen('anthropic');
                    setShowField((s) => ({ ...s, anthropic: true }));
                  }}
                >
                  I would rather paste an API key
                </button>
              )}
              <button
                type="button"
                className="set-agent-more"
                onClick={() => {
                  setOpen('openai');
                }}
              >
                I would rather sign in with ChatGPT
              </button>
            </div>
            {/* The gap that made the paragraph above unfollowable: this window
                has no address bar, so someone without an Anthropic account was
                being told to paste a thing with no route to obtaining it. The
                sign-in needs no such route, so when that is what is being
                offered the line says where it goes instead. */}
            <p className="set-agent-start-note">
              {claudeSignIn ? (
                <>
                  Signing in runs <span className="mono">{CLAUDE_LOGIN_COMMAND}</span> in the terminal, in this
                  project. It opens your browser and finishes back in the terminal. Hearth never sees the credential.
                </>
              ) : (
                <>
                  No key yet? <ExternalLink href={ANTHROPIC_KEYS_URL}>Get one from the Anthropic console</ExternalLink>.
                  It opens in your browser.
                </>
              )}
            </p>
          </section>
        )
      )}

      <div className="set-agents" role="list">
        {rows.map(({ backend, card }) => {
          const connecting = card.provider === 'openai' && signingIn && !card.connected;
          const state = cardState(card, connecting);
          const badge = STATE_BADGE[state];
          const isActive = active === card.provider && card.connected;
          const expanded = open === card.provider;
          const bodyId = `set-agent-body-${card.provider}`;
          const fieldId = `set-agent-key-${card.provider}`;
          const problemId = `set-agent-key-problem-${card.provider}`;
          const fieldOpen = card.action.kind === 'paste-key' || showField[card.provider];
          const working = busy === card.provider;
          const catalogue = switchableModels(card.provider, providers);
          const offered = enabledModels(card.provider, catalogue, disabled);

          /** Open the row and put the person in front of the control they came for. */
          const reveal = (): void => {
            setOpen(card.provider);
            if (card.altKey !== null) setShowField((s) => ({ ...s, [card.provider]: true }));
          };

          return (
            <section
              key={card.provider}
              role="listitem"
              className="set-agent"
              data-state={state}
              data-active={isActive ? 'true' : 'false'}
              data-open={expanded ? 'true' : 'false'}
            >
              <div className="set-agent-head">
                {/* The whole identity block is the disclosure. One target, and
                    a large one, rather than a chevron you have to aim at. */}
                <button
                  type="button"
                  className="set-agent-disclose"
                  aria-expanded={expanded}
                  aria-controls={bodyId}
                  onClick={() => setOpen(expanded ? null : card.provider)}
                >
                  <span className="set-agent-chevron" aria-hidden="true">
                    <Icon name="chevron" size={10} />
                  </span>
                  <span className="set-agent-mark">
                    {card.provider === 'anthropic' ? <ClaudeLogo size={20} /> : <OpenAiLogo size={18} />}
                  </span>
                  <span className="set-agent-id">
                    <span className="set-agent-name">{backend.name}</span>
                    {/* What it drives, then how it is reached. The same two
                        facts in the same order on every row, which is what
                        makes the list scannable rather than a set of blurbs. */}
                    <span className="set-agent-sub">
                      <span className="set-agent-catalogue">{backend.catalogue}</span>
                      <span className="set-agent-dotsep" aria-hidden="true" />
                      {connecting ? 'Waiting for the browser to finish signing in.' : card.status}
                    </span>
                  </span>
                </button>

                <div className="set-agent-meta">
                  {isActive && bothUsable && <span className="set-agent-badge is-active">Answers your messages</span>}
                  {badge !== null && (
                    <span className="set-agent-badge" data-state={state}>
                      <span className="set-agent-dot" aria-hidden="true" />
                      {badge}
                    </span>
                  )}
                  {/* Only a real choice when both could answer. With one usable
                      harness the question has one answer, and asking it would
                      be chrome. */}
                  {bothUsable && card.connected && !isActive && (
                    <Button
                      size="sm"
                      disabled={working}
                      onClick={() => choose(card.provider, choice?.provider === card.provider ? choice.model : null)}
                    >
                      Use this one
                    </Button>
                  )}
                  {/* Not connected: the slot holds the way in, never a label
                      describing what the machine is short of. */}
                  {card.action.kind === 'paste-key' && !expanded && (
                    <Button variant="primary" size="sm" disabled={!project} onClick={reveal}>
                      {card.action.label}
                    </Button>
                  )}
                  {/* Both harnesses' sign-ins hang here, on one branch,
                      because a row offers one primary action and the press
                      means the same thing on either. What differs is where it
                      goes: codex to a browser Hearth opens, Claude to the
                      terminal Hearth types into. `connecting` is only ever
                      true on the codex row, since the Claude flow has nothing
                      to wait for. */}
                  {card.action.kind === 'sign-in' && !card.connected && (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={!project || connecting}
                      onClick={card.provider === 'anthropic' ? signInToClaude : beginSignIn}
                    >
                      {connecting ? 'Opening browser…' : card.action.label}
                    </Button>
                  )}
                  {/* The way out of a wait that may never end. The flow lands
                      in a browser Hearth does not own, so a closed tab or an
                      abandoned OAuth page sends nothing back, and without this
                      the row stayed on "Connecting" with the Sign in button
                      disabled until Settings was closed and reopened. */}
                  {connecting && (
                    <Button size="sm" onClick={stopWaiting}>
                      Stop waiting
                    </Button>
                  )}
                  {/* A row that has not been read has to offer the read. It is
                      the one action that is honest in every one of these
                      states and it works in all of them, which is exactly what
                      was missing: a failed provider read left this row with no
                      interactive element but its own disclosure. */}
                  {!card.known && project !== null && !connecting && (
                    <Button size="sm" disabled={checking} onClick={recheck}>
                      {checking ? 'Checking…' : 'Check again'}
                    </Button>
                  )}
                  {card.action.kind === 'install' && !expanded && (
                    <Button variant="primary" size="sm" onClick={() => setOpen(card.provider)}>
                      Add Codex
                    </Button>
                  )}
                </div>
              </div>

              {expanded && (
                <div className="set-agent-body" id={bodyId}>
                  <section className="set-agent-section">
                    <h3 className="set-agent-section-title">Connection</h3>
                    <p className="set-agent-hint">{backend.blurb}</p>

                    {card.action.kind === 'install' && (
                      <div className="set-agent-install">
                        <p className="set-agent-hint">
                          This harness is the Codex CLI, an open-source tool from OpenAI that you install yourself.
                          Hearth can run the install in its terminal so you can watch it, or you can copy the command
                          and run it wherever you like.
                        </p>
                        <div className="set-agent-command">
                          <code className="mono">{CODEX_INSTALL_COMMAND}</code>
                          <div className="set-agent-command-actions">
                            <Button
                              size="sm"
                              onClick={() => copyCommand(CODEX_INSTALL_COMMAND)}
                              aria-label="Copy the install command"
                            >
                              {copied === CODEX_INSTALL_COMMAND ? 'Copied' : 'Copy'}
                            </Button>
                            {!confirmInstall && (
                              <Button
                                variant="primary"
                                size="sm"
                                disabled={!project}
                                onClick={() => setConfirmInstall(true)}
                              >
                                Install it
                              </Button>
                            )}
                          </div>
                        </div>
                        {confirmInstall ? (
                          <div className="set-agent-confirm">
                            <p className="set-agent-hint">
                              Hearth will type the command above into its terminal and run it in this project. You will
                              see everything it does. When it finishes, come back here and sign in.
                            </p>
                            <div className="set-agent-confirm-actions">
                              <Button size="sm" onClick={() => setConfirmInstall(false)}>
                                Cancel
                              </Button>
                              <Button
                                variant="primary"
                                size="sm"
                                onClick={() => {
                                  setConfirmInstall(false);
                                  runInstall();
                                }}
                              >
                                Run it in the terminal
                              </Button>
                            </div>
                          </div>
                        ) : (
                          !project && (
                            <>
                              <p className="set-agent-hint">
                                The terminal runs inside a project, so there is nowhere to run this yet. Copying the
                                command works either way.
                              </p>
                              {/* The way out, offered rather than implied. This
                                  pane used to disable the button and leave the
                                  user to work out for themselves that they
                                  should close Settings and go back to Home. */}
                              <div className="set-agent-manage">
                                <Button
                                  size="sm"
                                  onClick={() => window.dispatchEvent(new CustomEvent(OPEN_FOLDER_EVENT))}
                                >
                                  Open a project…
                                </Button>
                              </div>
                            </>
                          )
                        )}
                      </div>
                    )}

                    {/* The Claude sign-in, shown as the command it is.
                        Deliberately not a button on its own: the flow is
                        interactive and finishes in a shell, so the honest
                        thing is to put the command on screen, say who is about
                        to type it and where, and let it be copied and run
                        somewhere else instead. Only while the row is not
                        connected — once it is, the manage strip at the foot
                        carries Sign in again, and two sign-in buttons on one
                        open row would be one too many. */}
                    {card.provider === 'anthropic' && card.action.kind === 'sign-in' && !card.connected && (
                      <div className="set-agent-signin">
                        <p className="set-agent-hint">
                          The Claude Code CLI signs in through its own flow. It opens your browser, you approve it
                          there, and it finishes back in the terminal. Hearth types the command and then stays out of
                          it. Your account details go to Anthropic, never through this app. There is nothing here to
                          paste.
                        </p>
                        <div className="set-agent-command">
                          <code className="mono">{CLAUDE_LOGIN_COMMAND}</code>
                          <div className="set-agent-command-actions">
                            <Button
                              size="sm"
                              onClick={() => copyCommand(CLAUDE_LOGIN_COMMAND)}
                              aria-label="Copy the sign-in command"
                            >
                              {copied === CLAUDE_LOGIN_COMMAND ? 'Copied' : 'Copy'}
                            </Button>
                            <Button variant="primary" size="sm" disabled={!project} onClick={signInToClaude}>
                              Run it in the terminal
                            </Button>
                          </div>
                        </div>
                        {/* Project-gated, and said rather than merely greyed
                            out. The same shape as the codex install above,
                            because it is the same limit: the terminal runs in
                            the project folder and there is no folder. */}
                        {!project && (
                          <>
                            <p className="set-agent-hint">
                              The terminal runs inside a project, so there is nowhere to run this yet. Copying the
                              command works either way.
                            </p>
                            <div className="set-agent-manage">
                              <Button
                                size="sm"
                                onClick={() => window.dispatchEvent(new CustomEvent(OPEN_FOLDER_EVENT))}
                              >
                                Open a project…
                              </Button>
                            </div>
                          </>
                        )}
                        {/* `readClaudeAuth` reports a signed-out account when
                            its status command times out or prints something it
                            cannot parse, exactly as codex's probe does, so a
                            sign-in that already happened can land here too.
                            Asking again is the cheap way to find out, and it
                            is also how a sign-in finished in the terminal a
                            moment ago gets noticed. */}
                        {project !== null && (
                          <div className="set-agent-manage">
                            <Button size="sm" disabled={working || checking} onClick={recheck}>
                              {checking ? 'Checking…' : 'Check again'}
                            </Button>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Codex's state lives outside this app, in a binary on
                        PATH and a session under ~/.codex, and this is the row
                        that has to say so honestly.

                        `readCodexStatus` spawns a fresh `codex app-server` for
                        every probe and falls back to reporting a signed-out
                        account whenever that probe does not answer, so a
                        machine that is merely busy is indistinguishable on the
                        wire from one nobody has signed into, and it hits
                        hardest exactly when the machine is loaded. The row
                        cannot tell the difference either, so it says that
                        plainly and hands over the one thing that helps, which
                        is asking again. */}
                    {card.provider === 'openai' && card.action.kind === 'sign-in' && !card.connected && (
                      <div className="set-agent-recheck">
                        <p className="set-agent-hint">
                          If you have already signed in, a busy machine can look exactly like this: the check starts
                          codex and gives up when it does not answer in time. Nothing here has signed you out.
                        </p>
                        <div className="set-agent-manage">
                          {/* One read at a time, and the button says which one
                              it is waiting on. Firing a second probe over a
                              live one is how a fifteen-second timeout ends up
                              being the answer of record: the slow request is
                              also the one carrying the wrong answer, and it
                              lands last. `recheck` re-reads both the machine
                              and the project, so there is nothing left for
                              this button to fire separately. */}
                          <Button size="sm" disabled={working || checking} onClick={recheck}>
                            {checking ? 'Checking…' : 'Check again'}
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* A row nobody has read yet, said in the terms of whichever
                        read is missing, and always with the read attached.
                        Every branch here reaches a Check again, because "we
                        asked and it failed" used to render as "we have not
                        asked yet", permanently, with the complete set of
                        controls on this row being its own disclosure button. */}
                    {!card.known && (
                      <div className="set-agent-recheck">
                        <p className="set-agent-hint">
                          {card.read === 'failed' ? (
                            'That check did not come back, so Hearth cannot say what is connected here. Nothing on your machine has changed and nothing has been signed out. Asking again is safe.'
                          ) : project === null && card.provider === 'openai' ? (
                            <>
                              Signing in writes to <span className="mono">~/.codex</span>, which belongs to your
                              machine rather than to any one project. Hearth still asks codex about it from inside a
                              project folder, so it has nothing to report until a project is open.
                            </>
                          ) : project === null ? (
                            'A key is read out of the project you have open. There is no project yet, so there is nothing for Hearth to report.'
                          ) : (
                            'Hearth is reading this project now. Whatever it finds lands on this row.'
                          )}
                        </p>
                        <div className="set-agent-manage">
                          <Button size="sm" disabled={checking} onClick={recheck}>
                            {checking ? 'Checking…' : 'Check again'}
                          </Button>
                          {project === null && (
                            <Button
                              size="sm"
                              onClick={() => window.dispatchEvent(new CustomEvent(OPEN_FOLDER_EVENT))}
                            >
                              Open a project…
                            </Button>
                          )}
                        </div>
                      </div>
                    )}

                    {card.altKey !== null && !showField[card.provider] && card.action.kind !== 'paste-key' && (
                      <button
                        type="button"
                        className="set-agent-more"
                        onClick={() => setShowField((s) => ({ ...s, [card.provider]: true }))}
                      >
                        {card.altKey.label}
                      </button>
                    )}

                    {fieldOpen && (
                      <div className="set-agent-connect">
                        <label className="set-agent-field-label" htmlFor={fieldId}>
                          {card.provider === 'anthropic' ? 'Anthropic API key' : 'OpenAI API key'}
                        </label>
                        <div className="set-agent-field-row">
                          <input
                            id={fieldId}
                            className="input mono set-agent-input"
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            value={drafts[card.provider]}
                            placeholder={
                              card.action.kind === 'paste-key'
                                ? card.action.placeholder
                                : (card.altKey?.placeholder ?? '')
                            }
                            disabled={!project || working}
                            aria-invalid={keyProblem[card.provider] !== null}
                            aria-describedby={keyProblem[card.provider] !== null ? problemId : undefined}
                            onChange={(e) => {
                              setDrafts((d) => ({ ...d, [card.provider]: e.target.value }));
                              // Editing withdraws the warning, so the next
                              // press gets a fresh look rather than saving a
                              // second wrong paste on the strength of having
                              // been told about the first.
                              setKeyProblem((p) => (p[card.provider] === null ? p : { ...p, [card.provider]: null }));
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void connect(card.provider);
                            }}
                          />
                          <Button
                            variant="primary"
                            disabled={!project || working || drafts[card.provider].trim() === ''}
                            onClick={() => void connect(card.provider)}
                          >
                            {working ? 'Saving…' : keyProblem[card.provider] !== null ? 'Save it anyway' : 'Connect'}
                          </Button>
                          {card.action.kind !== 'paste-key' && (
                            <Button
                              disabled={working}
                              onClick={() => {
                                setShowField((s) => ({ ...s, [card.provider]: false }));
                                setDrafts((d) => ({ ...d, [card.provider]: '' }));
                                setKeyProblem((p) => ({ ...p, [card.provider]: null }));
                              }}
                            >
                              Cancel
                            </Button>
                          )}
                        </div>
                        {/* What looks wrong, said here and now rather than as a
                            turn that fails half an hour later with nothing
                            pointing back at this field. It does not block: the
                            button beside it now reads "Save it anyway", because
                            a shape Hearth does not recognise is not the same
                            thing as a key its user does not have. */}
                        {keyProblem[card.provider] !== null && (
                          <p className="set-agent-problem" id={problemId} role="alert">
                            {keyProblem[card.provider]}
                          </p>
                        )}
                        <p className="set-agent-hint">
                          {card.altKey?.hint ??
                            'Saved in this project and never shown again. Paste it and press Connect.'}{' '}
                          <ExternalLink href={KEY_SOURCE_URL[card.provider]}>
                            {card.provider === 'anthropic' ? 'Get a key from Anthropic' : 'Get a key from OpenAI'}
                          </ExternalLink>
                        </p>
                      </div>
                    )}

                    {(card.action.kind === 'sign-in' && card.connected) || card.disconnect !== null ? (
                      <div className="set-agent-manage">
                        {/* Sign in again, on a row that is already connected.
                            Claude's runs the command in the terminal and has
                            nothing to wait for, so it never wears the waiting
                            label and never disables itself for one. */}
                        {card.action.kind === 'sign-in' && card.connected && card.provider === 'anthropic' && (
                          <Button size="sm" disabled={!project || working} onClick={signInToClaude}>
                            {card.action.label}
                          </Button>
                        )}
                        {card.action.kind === 'sign-in' && card.connected && card.provider === 'openai' && (
                          <Button size="sm" disabled={!project || working || signingIn} onClick={beginSignIn}>
                            {signingIn ? 'Opening browser…' : card.action.label}
                          </Button>
                        )}
                        {/* Signing in again from an already-connected row can
                            be abandoned in the browser just the same, so the
                            way out is here too. Codex only: nothing waits on
                            the Claude side. */}
                        {card.action.kind === 'sign-in' && card.connected && card.provider === 'openai' && signingIn && (
                          <Button size="sm" onClick={stopWaiting}>
                            Stop waiting
                          </Button>
                        )}
                        {card.disconnect !== null && (
                          <Button size="sm" variant="danger" disabled={working} onClick={() => setConfirming(card)}>
                            {card.disconnect.label}
                          </Button>
                        )}
                      </div>
                    ) : null}
                  </section>

                  <section className="set-agent-section">
                    <div className="set-agent-section-head">
                      <h3 className="set-agent-section-title">Models</h3>
                      {card.connected && (
                        <span className="set-agent-count">{modelCountLabel(offered.length, catalogue.length)}</span>
                      )}
                    </div>

                    {!card.connected ? (
                      <p className="set-agent-hint">
                        Connect this harness and the models it can drive are listed here, each with a switch.
                      </p>
                    ) : catalogue.length === 0 ? (
                      <p className="set-agent-hint">
                        This harness has not reported a catalogue yet. Until it does, it answers with whatever model it
                        picks for itself.
                      </p>
                    ) : (
                      <>
                        <p className="set-agent-hint">
                          Switch off the ones you never reach for. They leave the composer&rsquo;s menu and nothing
                          else changes. Automatic is always there, so a harness can always answer.
                        </p>
                        <div className="set-rows">
                          {catalogue.map((model) => {
                            const on = isModelEnabled(card.provider, model.id, disabled);
                            const canChange = canSetModelEnabled(card.provider, catalogue, disabled, model.id, !on);
                            const id = `set-agent-model-${card.provider}-${model.id}`;
                            const key = `${card.provider}:${model.id}`;
                            return (
                              <SettingsRow
                                key={model.id}
                                label={model.label}
                                htmlFor={id}
                                hint={
                                  <>
                                    {model.isDefault === true && (
                                      <span className="set-agent-tag">Harness default</span>
                                    )}
                                    {/* The backend's own words where it gave
                                        any, and otherwise the id that actually
                                        goes on the wire, which is the more
                                        useful fact than no line at all. */}
                                    {model.description ?? model.note ?? (
                                      <span className="mono set-agent-modelid">{model.id}</span>
                                    )}
                                    {!canChange && (
                                      <span className="set-agent-locked">
                                        {' '}
                                        Kept on: a harness needs at least one model to drive.
                                      </span>
                                    )}
                                  </>
                                }
                                control={
                                  <span className="set-agent-switch">
                                    <input
                                      id={id}
                                      type="checkbox"
                                      role="switch"
                                      checked={on}
                                      disabled={!canChange || saving === key}
                                      onChange={(e) => void toggleModel(card.provider, model.id, e.target.checked)}
                                    />
                                    <span className="set-agent-switch-track" aria-hidden="true">
                                      <span className="set-agent-switch-thumb" />
                                    </span>
                                  </span>
                                }
                              />
                            );
                          })}
                        </div>
                      </>
                    )}
                  </section>
                </div>
              )}
            </section>
          );
        })}
      </div>

      {/* THE TERMINAL, given a card of its own.
          It used to be one grey line at the very foot of this pane, under two
          other grey lines, on a screen whose first two cards are named vendors
          — so the pane read as "Hearth works with Claude and ChatGPT", and the
          single most open thing in the app was the least visible thing on the
          page. It is the answer to "can I use X", for every X, and it needs
          nothing set up, so it says that at the size that claim deserves. */}
      <TerminalSection />

      <p className="set-agent-foot">
        Keys are written to <span className="mono">.hearth/app.json</span> in the open project and are never read back
        into this pane. Which models you switched off is saved{' '}
        {/* The path as the server spelled it. It is not the same string on
            Windows as on macOS, and writing one of them here would send half
            the people reading it to a folder that does not exist. */}
        {prefsFile === '' ? (
          'in your home folder, for you rather than for one project'
        ) : (
          <>
            in <span className="mono">{prefsFile}</span>, for you rather than for one project
          </>
        )}
        . Hearth is not affiliated with Anthropic or OpenAI.
      </p>

      <ConfirmDialog
        open={confirming !== null}
        title={confirming?.disconnect?.confirmTitle ?? 'Remove this key?'}
        body={confirming?.disconnect?.confirmBody ?? ''}
        confirmLabel={confirming?.disconnect?.confirmLabel ?? 'Remove key'}
        danger
        onConfirm={() => {
          const target = confirming;
          setConfirming(null);
          if (target) void disconnect(target.provider);
        }}
        onCancel={() => setConfirming(null)}
      />
    </>
  );
}
