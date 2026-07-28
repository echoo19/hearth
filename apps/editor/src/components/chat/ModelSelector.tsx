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
 *   Terminal  agent CLIs installed on this machine. Picking one flips the
 *             conversation to terminal mode AND starts that CLI, so you land
 *             in a running session instead of a bare shell to type into.
 *             Only what is really there is offered: the list is measured
 *             against PATH by the server (server/agentClis.ts), and a CLI that
 *             is missing is shown greyed with what would make it work.
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
  effectiveModel,
  effortDisplayName,
  agentForTurn,
  effortLabel,
  effortOptions,
  enabledModels,
  getDisabledModels,
  modelChoiceLabel,
  getModelChoice,
  providerModels,
  setModelChoice,
  useDisabledModels,
  useModelChoice,
} from '../../chat/modelChoice';
import { apiAgentClis } from '../../api';
import { useApp } from '../../store';
import type { AgentCliInfo, AgentChoice, ChatProvider, ChatProviderStatus, ProviderModelInfo } from '../../types';
import { planTerminalLaunch, useAgentSocket } from '../agent/useAgentSocket';
import { Icon } from '../ui';
import { MenuButton, type MenuItem } from '../ui/Menu';
import { Switch } from '../ui/Switch';

/**
 * The row that hands the model choice back to the backend. Ours rather than
 * either backend's — codex sends an empty-id row of its own and Anthropic
 * sends none — so it is named in one place and both providers word it the
 * same way. An id of '' is the documented "whatever this provider defaults to".
 */
export const AUTOMATIC_MODEL: ProviderModelInfo = { id: '', label: 'Automatic' };

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
 * Every group leads with the Automatic row, so "let it decide" is a visible,
 * checkable choice on both sides rather than a state you can only reach by
 * clearing the menu. A backend that sent its own empty-id row has it renamed
 * rather than doubled.
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
      models: [AUTOMATIC_MODEL, ...offered.filter((m) => m.id !== '')],
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

/** True when the stored choice is exactly this provider + model. */
export function isChosen(choice: AgentChoice | null, provider: ChatProvider, model: string | null): boolean {
  return choice !== null && choice.provider === provider && choice.model === model;
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
  return 'Your own CLI, running in a shell.';
}

/** Which half of the menu is showing. */
export type AgentSide = 'chat' | 'terminal';

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
  const { session } = useAgentSocket();
  const connected = useApp((s) => s.wsStatus === 'connected');
  const hasProject = useApp((s) => s.projectPath !== null);
  const startTerminalCli = useApp((s) => s.startTerminalCli);

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
  const [side, setSide] = useState<AgentSide>(() => defaultSide(terminalRunning));

  const items: MenuItem[] = [];

  if (side === 'chat') {
    for (const [index, group] of groups.entries()) {
      if (index > 0) items.push({ separator: true });
      // The note carries what a menu row's `shortcut` cannot: it is real text in
      // the header, so "which backend, and is it set up" is readable rather than
      // decorative.
      items.push({ header: group.title, note: `${backendFor(group.provider).name} · ${group.availability.note}` });
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

    // The ticks show what a turn sent right now WOULD carry, not what storage
    // happens to hold: a stored effort the current model has stopped accepting
    // is dropped on send, so it must not read as selected here either.
    const sending = agentForTurn(choice, providers);

    // Only when the chosen model said which efforts it takes. No catalogue means
    // no dial — an effort a model rejects is a turn that fails on send. It stays
    // on this side of the switch: on the terminal side the CLI owns its own
    // settings and this dial would be a control over nothing.
    if (efforts.length > 0 && sending) {
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
    if (clis.state === 'ready' && cliPlans.length === 0) {
      items.push({
        label: 'Nothing installed',
        disabled: true,
        disabledReason: 'Hearth found none of the agent CLIs it knows how to start on your PATH.',
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
              { id: 'chat', label: 'Chat' },
              { id: 'terminal', label: 'Terminal' },
            ]}
          />
          {/* The one line each side needs. It is the difference the switch is
              actually asking about, and two words cannot carry it. On the
              terminal side it also reports the PATH read, so a list that is
              empty because the walk failed does not look like a machine with
              nothing installed. */}
          <p className="model-menu-blurb">
            {side === 'chat' ? 'Hearth runs the agent and answers here.' : agentCliNote(clis)}
          </p>
        </>
      }
      trigger={
        <>
          <span className="model-pill-name">{modelChoiceLabel(choice, providers)}</span>
          {effort && <span className="model-pill-effort">{effort}</span>}
          <Icon name="chevron" size={9} />
        </>
      }
    />
  );
}
