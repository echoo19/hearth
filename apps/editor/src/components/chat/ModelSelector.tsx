/**
 * How you want to work, and with what.
 *
 * A text pill in the composer's bottom row — no border at rest, because the
 * composer already has one and a control inside a control reads as clutter.
 *
 * The menu's first cut is not by vendor, it is by HOW THE AGENT IS REACHED,
 * because that is the difference a person actually feels. It is a switch at
 * the head of the menu rather than two headers down one list: the two sides
 * are alternatives, not sections, and stacking them made a menu long enough
 * that the terminal half was below the fold and the effort dial below that.
 *
 *   Chat      backends Hearth drives itself, over a key or a sign-in. Picking
 *             one changes who answers the next turn and nothing else.
 *             Underneath it, one group per backend, then that backend's own
 *             models — the two lists are not a cross-product and the menu does
 *             not pretend otherwise: the Agent SDK takes Claude model ids,
 *             codex takes whatever its own `model/list` returned. The backend
 *             is named in each group's header, so "what is running the loop"
 *             is still a question with a visible answer. The models listed are
 *             the ones the user left switched on in Settings: the catalogues
 *             only grow, and a menu opened mid-sentence should be a shortlist.
 *             Under those, "Your agents": programs the person registered
 *             themselves (Settings, and server/agentRegistry.ts). Their own
 *             group rather than a fourth vendor, because Hearth knows a label
 *             and a command line about each and nothing else, and the command
 *             line is what the row prints. One that has not been confirmed is
 *             shown and not offered, with what would make it work.
 *   Terminal  a real shell in the project folder, and it opens with the row
 *             that says so: "Open a terminal", ahead of every name, running
 *             nothing. Everything under it is a shortcut — the agent CLIs
 *             Hearth knows BY NAME, as found on this machine — and picking one
 *             flips to terminal mode AND types that command, so you land in a
 *             running session instead of a prompt. Only what is really there is
 *             offered: the list is measured against PATH by the server
 *             (server/agentClis.ts), and a missing CLI is shown greyed with
 *             what would make it work.
 *
 *             THE LIST IS NOT THE BOUNDARY, and every word on this side is
 *             written to keep that obvious. AGENT_CLIS is a fixed registry of
 *             names Hearth can type, not the set of agents that work here: a
 *             CLI nobody has heard of runs exactly as well, typed by hand. A
 *             menu of two vendors read as a supported-agents list, which is the
 *             assumption this app must never plant, so the registry names the
 *             field and the bare-shell row sits above all of it.
 *   Effort    exactly the efforts the selected chat model declared, and
 *             nothing when it declares none. Codex's catalogue answers this
 *             per model — one offers `low medium high xhigh max ultra`,
 *             another four of those — so a fixed list would offer failing
 *             turns. It has no meaning on the terminal side, where the CLI
 *             owns its own settings, so it stays with the chat half.
 *
 * The same vendor can appear on both sides, and that is not a duplicate: the
 * Claude under Chat is the Agent SDK answering here, and Claude Code under
 * Terminal is the CLI running in a shell. Nothing here implies a partnership
 * with anyone — ChatGPT works through the open-source codex the user installed
 * themselves, and the same goes for every CLI in the Terminal group.
 *
 * Every chat backend states its own availability. One that can't answer still
 * lists its models — hiding them would answer "why isn't Opus in here?" with
 * silence — but picking one opens Settings instead of pretending the choice
 * took.
 */
import React, { useEffect, useState } from 'react';
import {
  AGENT_BACKENDS,
  backendFor,
  choiceForCustomAgent,
  effectiveModel,
  effortDisplayName,
  agentForTurn,
  effortLabel,
  effortOptions,
  enabledModels,
  getDisabledModels,
  isCustomChosen,
  modelChoiceLabel,
  getModelChoice,
  providerModels,
  setModelChoice,
  useCustomAgents,
  useDisabledModels,
  useModelChoice,
} from '../../chat/modelChoice';
import { apiAgentClis } from '../../api';
import { useApp } from '../../store';
import type {
  AgentCliInfo,
  AgentChoice,
  ChatProvider,
  ChatProviderStatus,
  CustomAgentInfo,
  ProviderModelInfo,
} from '../../types';
import { planTerminalLaunch, useAgentSocket } from '../agent/useAgentSocket';
import { Icon } from '../ui';
import { MenuButton, type MenuItem } from '../ui/Menu';
import { Switch } from '../ui/Switch';

/**
 * THERE IS NO AUTOMATIC ROW, and this constant is gone rather than hidden.
 *
 * It used to lead every group: an id of '' meaning "whatever this provider
 * defaults to". It read as a sensible default and was in practice the state
 * nobody left, because it is the first row and it is already ticked — so the
 * pill said "Claude", the menu said "Automatic", and which model actually
 * answered your turn was a fact about a codex build or an SDK default that
 * nothing on screen named. On a surface whose whole job is to say what would
 * answer, the one row that declines to say it does not belong.
 *
 * An empty id is still the documented wire value and the server still honours
 * it, so a choice stored by an older build keeps working. It is simply not
 * offered: `modelGroups` filters it out of whatever a backend sends, and the
 * pill reads "Choose a model" until a real one is picked.
 */

/**
 * What the selector falls back to before `/api/chat/providers` has been read —
 * on Home there is no folder yet, so there is no read-out at all. Same ids the
 * server curates, so a choice made here survives the folder opening.
 */
export const FALLBACK_MODELS: Record<ChatProvider, ProviderModelInfo[]> = {
  anthropic: [
    { id: 'claude-opus-5', label: 'Opus 5' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ],
  // Deliberately thin: which models a codex build supports is the binary's
  // answer, not ours, and inventing ids here would offer choices that fail.
  // The real six arrive from `model/list` the moment a folder is open.
  openai: [],
};

export interface ProviderAvailability {
  /** Can this provider answer a turn right now? */
  available: boolean;
  /** The group header's trailing note — how it is set up, or why it isn't. */
  note: string;
}

/**
 * How a provider is set up, in the terms that provider actually uses:
 * Anthropic is a key, OpenAI is a CLI you install and sign into. Pure so the
 * six states are testable without a render.
 */
export function providerAvailability(
  provider: ChatProvider,
  providers: ChatProviderStatus | null,
): ProviderAvailability {
  if (provider === 'anthropic') {
    const hasKey = providers?.anthropic.hasKey === true;
    return { available: hasKey, note: hasKey ? 'API key' : 'Not set up' };
  }
  const openai = providers?.openai;
  if (!openai) return { available: false, note: 'Not set up' };
  if (!openai.installed) return { available: false, note: 'Not installed' };
  if (openai.loggedIn) return { available: true, note: 'Signed in' };
  if (openai.hasKey) return { available: true, note: 'API key' };
  return { available: false, note: 'Not signed in' };
}

export interface ModelGroup {
  provider: ChatProvider;
  /** 'Claude' / 'ChatGPT' — the vendor's name, not the driver's. */
  title: string;
  /** What runs these models. The group's real subject. */
  backend: string;
  availability: ProviderAvailability;
  models: ProviderModelInfo[];
}

/**
 * The menu's contents: one group per backend, in a fixed order so the list
 * never reshuffles under the pointer as availability changes. Server-curated
 * models win; the fallback fills in before the read-out lands.
 *
 * Every row here is a named model. The empty-id row a backend may send
 * ("whatever I default to") is filtered out rather than renamed: see
 * AUTOMATIC_MODEL's note above for why that choice is not offered.
 *
 * `disabled` is the set the user switched off in Settings, and this is where
 * that setting becomes real: a model that is off is not in the menu. It
 * defaults to the live set rather than to empty, so every caller that just
 * wants "the menu as the user would see it" gets exactly that; Settings passes
 * an empty set of its own, because the one screen that has to show a switched
 * off model is the screen with the switch on it.
 */
export function modelGroups(
  providers: ChatProviderStatus | null,
  disabled: ReadonlySet<string> = getDisabledModels(),
): ModelGroup[] {
  return AGENT_BACKENDS.map((backend) => {
    const curated = providerModels(backend.provider, providers);
    const models = curated.length > 0 ? curated : FALLBACK_MODELS[backend.provider];
    const offered = enabledModels(backend.provider, models, disabled);
    return {
      provider: backend.provider,
      title: backend.vendor,
      backend: backend.name,
      availability: providerAvailability(backend.provider, providers),
      models: offered.filter((m) => m.id !== ''),
    };
  });
}

/**
 * "Filter nothing out." Settings passes this to see the full catalogue,
 * switches and all. A shared constant rather than a fresh `new Set()` per
 * render, so a memo downstream is not defeated by a new identity every time.
 */
export const NOTHING_DISABLED: ReadonlySet<string> = new Set<string>();

/** An empty id from the server means "whatever this provider defaults to". */
export function modelIdFor(info: ProviderModelInfo): string | null {
  return info.id === '' ? null : info.id;
}

/**
 * True when the stored choice is exactly this provider + model.
 *
 * A choice that names one of the user's own agents ticks nothing here, even
 * though it still carries the model it was carrying: that model is what the
 * menu goes back to, not what would answer, and two ticks in one menu is the
 * menu telling you two different things.
 */
export function isChosen(choice: AgentChoice | null, provider: ChatProvider, model: string | null): boolean {
  return choice !== null && !choice.agentId && choice.provider === provider && choice.model === model;
}

/**
 * The short trailing note on a model row: what the backend said about it, in
 * the space a menu row has. Codex's own default is called out because the
 * Automatic row above resolves to exactly that model.
 */
export function modelRowNote(info: ProviderModelInfo): string | undefined {
  if (info.isDefault === true) return 'Default';
  return info.note;
}

/**
 * The choice a click on one of the model rows produces.
 *
 * Effort is carried over only where it means anything (ChatGPT) — otherwise it
 * would sit in storage as a setting the user can't see and can't have meant —
 * and only when the model being chosen actually accepts it. Models genuinely
 * differ here: `ultra` exists on one codex model and not on the next, and
 * carrying it across would build a choice that fails on send.
 */
export function choiceForModel(
  current: AgentChoice | null,
  provider: ChatProvider,
  model: string | null,
  providers: ChatProviderStatus | null = null,
): AgentChoice {
  if (provider !== 'openai') return { provider, model, effort: null };
  const carried = current?.provider === 'openai' ? current.effort : null;
  const next: AgentChoice = { provider, model, effort: carried };
  const efforts = effortOptions(next, providers);
  if (carried !== null && efforts.length > 0 && !efforts.some((e) => e.id === carried)) next.effort = null;
  return next;
}

function openSettings(): void {
  window.dispatchEvent(new CustomEvent('hearth:open-settings'));
}

/**
 * The trailing note on one of the user's own agent rows: the exact command
 * line, or the one thing standing between it and answering.
 *
 * The command is shown rather than a friendly summary, everywhere, and this is
 * one of the places that rule is load-bearing: the row is a button that spawns
 * a program, and the only honest label for that is what gets spawned.
 */
export function customAgentNote(agent: CustomAgentInfo): string {
  return agent.confirmed ? agent.commandLine : 'Not confirmed yet';
}

/** Why a row cannot be picked, or undefined when it can. */
export function customAgentBlocked(agent: CustomAgentInfo): string | undefined {
  if (agent.confirmed) return undefined;
  return `Hearth will run "${agent.commandLine}". Open Settings and confirm it before it can answer.`;
}

// ---------------------------------------------------------------------------
// The terminal half: which CLIs this machine has.
// ---------------------------------------------------------------------------

/** Loading / ready / failed, kept apart because "none installed" and "not
 * asked yet" are different answers and only one of them is the machine's. */
export type AgentCliRead =
  | { state: 'loading' }
  | { state: 'ready'; clis: AgentCliInfo[] }
  | { state: 'failed' };

/**
 * Read once per window, then shared: the answer is a property of the machine,
 * it costs a PATH walk, and every composer wants the same one. A CLI installed
 * while Hearth is open shows up on the next launch — the alternative is
 * re-walking PATH on every render of a menu that is usually closed.
 */
let cliRead: AgentCliRead = { state: 'loading' };
let cliRequest: Promise<void> | null = null;
const cliListeners = new Set<() => void>();

function loadAgentClis(): Promise<void> {
  cliRequest ??= apiAgentClis().then((clis) => {
    cliRead = clis ? { state: 'ready', clis } : { state: 'failed' };
    // A failed read is not an answer, so it is not cached as one: the next
    // composer to mount asks again.
    if (!clis) cliRequest = null;
    for (const listener of cliListeners) listener();
  });
  return cliRequest;
}

export function useAgentClis(): AgentCliRead {
  const [read, setRead] = useState(cliRead);
  useEffect(() => {
    let alive = true;
    const settle = (): void => {
      if (alive) setRead(cliRead);
    };
    cliListeners.add(settle);
    void loadAgentClis().then(settle);
    return () => {
      alive = false;
      cliListeners.delete(settle);
    };
  }, []);
  return read;
}

/**
 * The line under the switch on the terminal side: what this half is, or what
 * went wrong finding out. It doubles as the empty state's explanation, which
 * is why the failure reads as a sentence rather than as a status word.
 */
export function agentCliNote(read: AgentCliRead): string {
  if (read.state === 'loading') return 'Checking your PATH…';
  if (read.state === 'failed') return 'Hearth could not read your PATH, so it cannot say what is installed.';
  // The sentence that stops the list below from reading as a boundary. It is a
  // real shell in the project folder: the names are there to save typing, and
  // anything not on them works exactly as well.
  return 'A real shell in your project. Run any CLI you like; these are the ones Hearth can type for you.';
}

/** Which half of the menu is showing. */
export type AgentSide = 'chat' | 'terminal';

/**
 * Whether this menu may still change the conversation's KIND, and what it is
 * locked to when it may not.
 *
 * A conversation is a chat or a terminal session from the moment it exists,
 * and that has always been true of the record — `startConversationOfKind` in
 * store.ts creates a new one rather than converting the open one. What the
 * menu did with that was quietly mint a second conversation underneath
 * someone: pick a CLI three messages into a chat and the chat you were reading
 * went away, replaced by a shell, with the switch at the top of the menu
 * looking exactly like a view toggle. It is not a view toggle. It decides what
 * you are about to start.
 *
 * So it only decides that while there is nothing started: a blank composer, or
 * a window that has not landed in a conversation at all. After the first
 * message the kind is settled, the other side is shown disabled with the
 * reason, and starting the other kind is New chat — which is the honest name
 * for what picking it was doing anyway.
 */
export function lockedSide(state: {
  composing: boolean;
  activeChatId: string | null;
  conversationMode: AgentSide;
}): AgentSide | null {
  // The blank surface: New chat, or Home. Nothing exists to contradict, so
  // both kinds are on offer and picking one is what creates it.
  if (state.composing || state.activeChatId === null) return null;
  return state.conversationMode;
}

/** Why the other half cannot be reached from an established conversation. */
export function sideLockReason(locked: AgentSide, side: AgentSide): string | undefined {
  if (locked === side) return undefined;
  return locked === 'terminal'
    ? 'This is a terminal session. Start a new chat to talk to a model.'
    : 'This is a chat. Start a new chat to open a terminal instead.';
}

/**
 * The side to open on. Whichever one the conversation is already using, so the
 * menu opens onto the answer to "what is running this" rather than onto the
 * side the reader has to switch away from. Terminal only counts as in use when
 * a CLI is genuinely running here: a preference has no meaning on that side,
 * because starting a CLI is the choice.
 */
export function defaultSide(terminalRunning: boolean): AgentSide {
  return terminalRunning ? 'terminal' : 'chat';
}

export function ModelSelector() {
  const choice = useModelChoice();
  const providers = useApp((s) => s.providers);
  // Subscribed rather than read once: switching a model off in Settings has to
  // be felt by an already-open composer, not only by the next one to mount.
  const disabled = useDisabledModels();
  const groups = modelGroups(providers, disabled);
  const effort = effortLabel(choice);
  const efforts = effortOptions(choice, providers);
  const clis = useAgentClis();
  const agents = useCustomAgents();
  const { session } = useAgentSocket();
  const connected = useApp((s) => s.wsStatus === 'connected');
  const hasProject = useApp((s) => s.projectPath !== null);
  const startTerminalCli = useApp((s) => s.startTerminalCli);
  const openTerminal = useApp((s) => s.openTerminal);
  // What the open conversation already is, if it is anything. See `lockedSide`.
  const composing = useApp((s) => s.composing);
  const activeChatId = useApp((s) => s.activeChatId);
  const conversationMode = useApp((s) => s.conversationMode);

  // One plan per CLI, computed from the same function the store re-checks on
  // click, so what is offered and what would happen cannot drift apart.
  const cliPlans =
    clis.state === 'ready'
      ? clis.clis.map((cli) => ({
          cli,
          plan: planTerminalLaunch({ cli, status: session.status, launched: session.cli, connected, hasProject }),
        }))
      : [];
  const terminalRunning = cliPlans.some((entry) => entry.plan.action === 'show');

  // Which half is showing. Seeded from what is running, then the reader's, for
  // as long as the composer lives: someone comparing the two sides should not
  // have the menu jump back under them between openings.
  const [chosenSide, setSide] = useState<AgentSide>(() => defaultSide(terminalRunning));
  // ...unless the conversation has already settled what it is, in which case
  // the menu shows that side and says so. The reader's preference is kept
  // rather than overwritten, so it is still there on the next New chat.
  const locked = lockedSide({ composing, activeChatId, conversationMode });
  const side = locked ?? chosenSide;

  const items: MenuItem[] = [];

  if (side === 'chat') {
    for (const [index, group] of groups.entries()) {
      if (index > 0) items.push({ separator: true });
      // The note carries what a menu row's `shortcut` cannot: it is real text in
      // the header, so "which backend, and is it set up" is readable rather than
      // decorative.
      items.push({ header: group.title, note: `${backendFor(group.provider).name} · ${group.availability.note}` });
      // With the automatic row gone, a backend that has reported no catalogue
      // leaves a header with nothing under it. Say so: an empty group reads as
      // a rendering fault, and the reason here is a real one the user can act
      // on for one of the two providers.
      if (group.models.length === 0) {
        items.push({
          label: 'No models reported',
          disabled: true,
          disabledReason: group.availability.available
            ? 'This backend has not sent its catalogue yet. It usually lands a moment after a project opens.'
            : 'Set this backend up and the models it can drive are listed here.',
          onSelect: () => {},
        });
      }
      for (const info of group.models) {
        const model = modelIdFor(info);
        items.push({
          label: info.label,
          shortcut: modelRowNote(info),
          checked: isChosen(choice, group.provider, model),
          onSelect: () => {
            if (!group.availability.available) openSettings();
            else setModelChoice(choiceForModel(getModelChoice(), group.provider, model, providers));
          },
        });
      }
      if (!group.availability.available) {
        items.push({ label: 'Set up in Settings…', onSelect: openSettings });
      }
    }

    // The user's own agents, as their own group. Not folded in with the vendor
    // groups above: those are a backend paired with a catalogue of models, and
    // one of these is a program with a command line. The row's note IS that
    // command line, because a row that spawns a program and shows only a
    // friendly name is hiding the only fact that matters about it.
    items.push({ separator: true });
    items.push({ header: 'Your agents', note: 'Programs you registered' });
    if (agents.length === 0) {
      items.push({
        label: 'Nothing registered',
        disabled: true,
        disabledReason: 'Add one under Agents in Settings. Any program that speaks the Hearth agent protocol works.',
        onSelect: () => {},
      });
    }
    for (const agent of agents) {
      const blocked = customAgentBlocked(agent);
      items.push({
        label: agent.label,
        shortcut: customAgentNote(agent),
        checked: isCustomChosen(choice, agent.id),
        disabled: blocked !== undefined,
        disabledReason: blocked,
        onSelect: () => setModelChoice(choiceForCustomAgent(getModelChoice(), agent.id)),
      });
    }
    items.push({ label: 'Manage agents…', onSelect: openSettings });

    // The ticks show what a turn sent right now WOULD carry, not what storage
    // happens to hold: a stored effort the current model has stopped accepting
    // is dropped on send, so it must not read as selected here either.
    const sending = agentForTurn(choice, providers);

    // Only when the chosen model said which efforts it takes. No catalogue means
    // no dial — an effort a model rejects is a turn that fails on send. It stays
    // on this side of the switch: on the terminal side the CLI owns its own
    // settings and this dial would be a control over nothing.
    // ...and nothing at all while one of the user's own agents is chosen: the
    // efforts came out of codex's catalogue, and offering them under a program
    // Hearth knows nothing about would be a dial wired to no setting.
    if (efforts.length > 0 && sending && !sending.agentId) {
      items.push({ separator: true });
      items.push({ header: 'Effort', note: effectiveModel(sending, providers)?.label ?? '' });
      // Named with what it resolves to, because "Automatic" on its own is the
      // one row here that doesn't say what it does.
      const modelDefault = effectiveModel(sending, providers)?.defaultEffort;
      items.push({
        label: 'Automatic',
        shortcut: modelDefault ? effortDisplayName(modelDefault) : undefined,
        checked: sending.effort === null,
        onSelect: () => {
          const current = getModelChoice();
          if (current) setModelChoice({ ...current, effort: null });
        },
      });
      for (const option of efforts) {
        items.push({
          label: effortDisplayName(option.id),
          checked: sending.effort === option.id,
          onSelect: () => {
            const current = getModelChoice();
            if (current) setModelChoice({ ...current, effort: option.id });
          },
        });
      }
    }
  } else {
    // No group header on this side. There is one list, the switch above has
    // just named it, and a header would be the third thing in a row to say
    // "terminal" before the reader reaches a single CLI.
    // FIRST, ahead of every named CLI, and that order is the point. The list
    // below is a set of names Hearth can type for you; this is the terminal
    // itself, which runs whatever you type and always has. With only named
    // rows the menu read as the set of agents Hearth supports, which is the
    // one assumption this app must never plant — and the honest answer, "it is
    // your shell", had no row at all.
    items.push({
      label: 'Open a terminal',
      shortcut: 'Any CLI',
      disabled: !hasProject,
      disabledReason: hasProject ? undefined : 'Open a project first. The terminal runs in the project folder.',
      onSelect: openTerminal,
    });
    items.push({ separator: true });
    if (clis.state === 'ready' && cliPlans.length === 0) {
      items.push({
        label: 'None of these are installed',
        disabled: true,
        // Not "nothing installed": what Hearth checked is its own shortlist,
        // and the terminal above still runs whatever the user has.
        disabledReason:
          'Hearth found none of the CLIs it knows by name on your PATH. Open a terminal and run yours by hand.',
        onSelect: () => {},
      });
    }
    for (const { cli, plan } of cliPlans) {
      const blocked = plan.action === 'blocked';
      items.push({
        label: cli.label,
        // The command, because that is what lands in the shell — except when
        // it isn't there, where the missing binary is the more useful fact.
        shortcut: cli.installed ? cli.command : 'Not installed',
        // Ticked only for a session Hearth itself started this CLI in. It
        // means "this is running here", not "this is your preference".
        checked: plan.action === 'show',
        disabled: blocked,
        disabledReason: blocked ? plan.reason : undefined,
        onSelect: () => startTerminalCli(cli),
      });
    }
  }

  return (
    <MenuButton
      label="Model"
      align="right"
      items={items}
      triggerClassName="model-pill"
      popoverClassName="model-menu"
      heading={
        <>
          <Switch
            label="How the agent is reached"
            className="switch-stretch"
            value={side}
            onChange={setSide}
            options={[
              {
                id: 'chat',
                label: 'Chat',
                disabled: locked === 'terminal',
                disabledReason: locked ? sideLockReason(locked, 'chat') : undefined,
              },
              {
                id: 'terminal',
                label: 'Terminal',
                disabled: locked === 'chat',
                disabledReason: locked ? sideLockReason(locked, 'terminal') : undefined,
              },
            ]}
          />
          {/* The one line each side needs. It is the difference the switch is
              actually asking about, and two words cannot carry it. On the
              terminal side it also reports the PATH read, so a list that is
              empty because the walk failed does not look like a machine with
              nothing installed.

              A locked switch replaces it with the reason, because that is now
              the thing the reader most needs: the greyed half is the first
              thing the eye goes to, and "why" beats a description of a side
              they cannot reach. */}
          <p className="model-menu-blurb">
            {locked !== null
              ? sideLockReason(locked, locked === 'chat' ? 'terminal' : 'chat')
              : side === 'chat'
                ? 'Hearth runs the agent and answers here.'
                : agentCliNote(clis)}
          </p>
        </>
      }
      trigger={
        <>
          <span className="model-pill-name">{modelChoiceLabel(choice, providers, agents)}</span>
          {effort && <span className="model-pill-effort">{effort}</span>}
          <Icon name="chevron" size={9} />
        </>
      }
    />
  );
}
