/**
 * Who answers, and with which of their models.
 *
 * A text pill in the composer's bottom row, no border at rest, because the
 * composer already has one and a control inside a control reads as clutter.
 *
 * ONE AGENT AT A TIME, AND THE MENU SHOWS ONLY ITS MODELS. This is the whole
 * shape of the control and it is a correction. The menu used to list every
 * vendor's catalogue at once, so picking a model was also, silently, a way to
 * change who answered: choosing a GPT model moved the conversation to codex
 * with nothing announcing it, while the account row in the sidebar still
 * described a different sign-in. Neither surface was lying on its own, and
 * together they were incoherent. So the models under the header belong to the
 * active agent and nothing else, and changing agent is a row of its own under
 * "Switch agent" that says what it is doing.
 *
 * Which agent is active is `activeProvider` in chat/modelChoice: the standing
 * choice first, then what the server says would answer. Picking a new one here
 * writes BOTH, so the composer and Settings cannot drift apart. That write is
 * the fix for the older bug where the pill and Settings each held their own
 * opinion and the server quietly preferred the pill.
 *
 * What is NOT here any more, and where it went:
 *
 *   Terminal   this menu used to carry a Chat/Terminal switch and a list of
 *              CLIs it would type for you. A conversation is a chat or a
 *              terminal session from the moment it exists, so that switch was
 *              minting a second conversation underneath the reader while
 *              looking like a view toggle. The choice moved to where the
 *              conversation is created: New chat and New terminal, in the
 *              sidebar and on a project's own screen. A terminal now opens
 *              empty in the project folder and you type your own command,
 *              which is also the honest answer to "which agents work here":
 *              all of them, because it is your shell.
 *   Effort     its own control beside this one (EffortSelector), shown only
 *              when the active model declared efforts. It was a section at the
 *              bottom of this menu, below the fold, on a menu opened
 *              mid-sentence.
 *   Your own   registering a program against a small stdio protocol is gone.
 *   agents     The terminal is the door for any agent Hearth does not drive
 *              itself, and it does not need a registry to open.
 *
 * Every backend states its own availability. One that cannot answer still
 * lists its models, because hiding them answers "why isn't Opus in here?" with
 * silence, but picking one opens Settings rather than pretending the choice
 * took.
 */
import React from 'react';
import {
  AGENT_BACKENDS,
  activeProvider,
  backendFor,
  choiceForProvider,
  effortDisplayName,
  effortLabel,
  effortOptions,
  effectiveModel,
  agentForTurn,
  enabledModels,
  getDisabledModels,
  modelChoiceLabel,
  modelRowCovers,
  getModelChoice,
  providerModels,
  setModelChoice,
  useDisabledModels,
  useModelChoice,
  EFFORT_AUTOMATIC_LABEL,
} from '../../chat/modelChoice';
import { useApp } from '../../store';
import type { AgentChoice, ChatProvider, ChatProviderStatus, ProviderModelInfo } from '../../types';
import { Icon } from '../ui';
import { MenuButton, type MenuItem } from '../ui/Menu';

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
    // The sign-in comes FIRST, because it is the one most people already have
    // and the one that costs nothing extra. The CLI answers on whatever the
    // person signed into, so a key is an alternative rather than a
    // prerequisite: reading only `hasKey` put "Not set up" beside a Claude
    // that had been working all day, under a row offering to set up the thing
    // that was already set up.
    //
    // SIGNED IN, not merely installed. `cli` alone was the previous answer
    // here and it was the same mistake in the other direction: a machine with
    // claude on PATH and nobody signed into it reported itself ready, listed
    // its models, and failed the turn with no clue why.
    const loggedIn = providers?.anthropic.loggedIn === true;
    if (loggedIn) {
      const plan = providers?.anthropic.planType;
      return { available: true, note: hasKey ? 'API key' : plan ? `Claude ${plan}` : 'Claude Code sign in' };
    }
    if (hasKey) return { available: true, note: 'API key' };
    // Installed but signed out is its own state, and it gets its own sentence:
    // the fix is one command, and "Not set up" would send someone looking for
    // an API key they do not need.
    if (providers?.anthropic.cli === true) return { available: false, note: 'Not signed in' };
    return { available: false, note: 'Not set up' };
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
 * True when the stored choice is this row.
 *
 * Takes the ROW rather than a bare id so an alias can cover a stored explicit
 * id: Claude's catalogue is `sonnet` / `opus[1m]`, and a choice saved as
 * `claude-sonnet-5` ticked nothing at all until this matched through
 * `resolvedModel`. `info` is null for a row that is not a model.
 */
export function isChosen(
  choice: AgentChoice | null,
  provider: ChatProvider,
  model: string | null,
  info?: ProviderModelInfo,
): boolean {
  if (choice === null || choice.provider !== provider) return false;
  if (choice.model === model) return true;
  return info !== undefined && choice.model !== null && modelRowCovers(info, choice.model);
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
 * The one group the composer draws: the active agent and its catalogue.
 *
 * Separate from `modelGroups` below rather than a filter over it, because the
 * two callers want genuinely different things. Settings shows every backend at
 * once, switches and all, because that is the screen where you decide what the
 * composer may offer. The composer shows exactly what would answer.
 */
export function activeModelGroup(
  choice: AgentChoice | null,
  providers: ChatProviderStatus | null,
  disabled: ReadonlySet<string> = getDisabledModels(),
): ModelGroup {
  const provider = activeProvider(choice, providers);
  const curated = providerModels(provider, providers);
  const models = curated.length > 0 ? curated : FALLBACK_MODELS[provider];
  return {
    provider,
    title: backendFor(provider).vendor,
    backend: backendFor(provider).name,
    availability: providerAvailability(provider, providers),
    models: enabledModels(provider, models, disabled).filter((m) => m.id !== ''),
  };
}

export function ModelSelector() {
  const choice = useModelChoice();
  const providers = useApp((s) => s.providers);
  // Subscribed rather than read once: switching a model off in Settings has to
  // be felt by an already-open composer, not only by the next one to mount.
  const disabled = useDisabledModels();
  const setChatProvider = useApp((s) => s.setChatProvider);
  const group = activeModelGroup(choice, providers, disabled);
  const backend = backendFor(group.provider);

  const items: MenuItem[] = [];

  items.push({ header: group.title, note: `${backend.name} · ${group.availability.note}` });
  // With no automatic row, a backend that has reported no catalogue leaves a
  // header with nothing under it. Say so: an empty group reads as a rendering
  // fault, and the reason is something the user can act on.
  if (group.models.length === 0) {
    items.push({
      label: 'No models reported',
      disabled: true,
      disabledReason: group.availability.available
        ? 'This agent has not sent its catalogue yet. It usually lands a moment after a project opens.'
        : 'Set this agent up and the models it can drive are listed here.',
      onSelect: () => {},
    });
  }
  for (const info of group.models) {
    const model = modelIdFor(info);
    items.push({
      label: info.label,
      shortcut: modelRowNote(info),
      checked: isChosen(choice, group.provider, model, info),
      onSelect: () => {
        if (!group.availability.available) openSettings();
        else setModelChoice(choiceForModel(getModelChoice(), group.provider, model, providers));
      },
    });
  }
  if (!group.availability.available) {
    items.push({ label: 'Set up in Settings…', onSelect: openSettings });
  }

  // Which AGENT answers is not a per-message choice, so it is not offered
  // here. It used to be: a "Switch agent" list sat under the models, one
  // click from the box you type in, and swapping the whole catalogue mid-
  // sentence is not the same size of decision as picking a model. It is
  // settled once, in Settings, where the sign-in and the model shortlist it
  // depends on already live. The door stays in the menu so the answer to
  // "where did that go" is one click away.
  // One door, not two: an unavailable agent already has "Set up in Settings…"
  // above, and a second row pointing at the same screen reads as a duplicate.
  if (group.availability.available) {
    items.push({ separator: true });
    items.push({
      label: 'Settings…',
      icon: 'gear',
      shortcut: 'Change agent',
      onSelect: openSettings,
    });
  }

  return (
    <MenuButton
      label="Model"
      align="right"
      items={items}
      triggerClassName="model-pill"
      popoverClassName="model-menu"
      heading={<p className="model-menu-blurb">{backend.blurb}</p>}
      trigger={
        <>
          <span className="model-pill-name">{modelChoiceLabel(choice, providers)}</span>
          <Icon name="chevron" size={9} />
        </>
      }
    />
  );
}

/**
 * How hard the model thinks, as its own control.
 *
 * IT DISAPPEARS RATHER THAN GREYING OUT, and that is the point of splitting it
 * off. Effort is the model's vocabulary, not ours: codex answers it per model
 * from `model/list` (one build offers `low medium high xhigh max ultra`, the
 * next offers four of those) and today's Claude models declare none at all. A
 * permanent third pill would therefore be a dial wired to nothing for half the
 * agents in the app, which is worse than no dial: a control that is present
 * and inert is a promise the turn does not keep.
 *
 * So the rule is evidence, not vendor. `effortOptions` reads what the resolved
 * model actually declared, and nothing renders when it declared nothing. The
 * moment a Claude model ships efforts, this appears for Claude with no change
 * here.
 */
export function EffortSelector() {
  const choice = useModelChoice();
  const providers = useApp((s) => s.providers);
  // The ticks show what a turn sent RIGHT NOW would carry, not what storage
  // happens to hold: a stored effort the current model has stopped accepting is
  // dropped on send, so it must not read as selected here either.
  const sending = agentForTurn(choice, providers);
  const options = effortOptions(sending, providers);
  const label = effortLabel(sending, providers);
  if (options.length === 0 || label === null) return null;

  const model = effectiveModel(sending, providers);
  const items: MenuItem[] = [
    { header: 'Effort', note: model?.label ?? '' },
    {
      // Named with what it resolves to, because "Automatic" on its own is the
      // one row here that does not say what it does.
      label: EFFORT_AUTOMATIC_LABEL,
      shortcut: model?.defaultEffort ? effortDisplayName(model.defaultEffort) : undefined,
      checked: sending?.effort == null,
      onSelect: () => {
        const current = getModelChoice();
        if (current) setModelChoice({ ...current, effort: null });
      },
    },
    ...options.map<MenuItem>((option) => ({
      label: effortDisplayName(option.id),
      shortcut: option.description,
      checked: sending?.effort === option.id,
      onSelect: () => {
        const current = getModelChoice();
        if (current) setModelChoice({ ...current, effort: option.id });
      },
    })),
  ];

  return (
    <MenuButton
      label="Effort"
      align="right"
      items={items}
      triggerClassName="model-pill effort-pill"
      popoverClassName="model-menu effort-menu"
      trigger={
        <>
          <span className="model-pill-name">{label}</span>
          <Icon name="chevron" size={9} />
        </>
      }
    />
  );
}
