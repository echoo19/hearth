/**
 * Who answers the next turn, and how hard it thinks.
 *
 * A text pill in the composer's bottom row — no border at rest, because the
 * composer already has one and a control inside a control reads as clutter.
 * The menu is grouped by vendor rather than flattened into one list: the
 * choice a user is actually making is "Claude or ChatGPT", and the model is
 * the second half of that sentence.
 *
 * Every group states its own availability. A provider that can't answer still
 * lists its models — hiding them would answer the question "why isn't Opus in
 * here?" with silence — but picking one opens Settings instead of pretending
 * the choice took.
 */
import React from 'react';
import { getModelChoice, modelChoiceLabel, effortLabel, providerDisplayName, setModelChoice, useModelChoice } from '../../chat/modelChoice';
import { useApp } from '../../store';
import type { AgentChoice, ChatProvider, ChatProviderStatus, ProviderModelInfo } from '../../types';
import { Icon } from '../ui';
import { MenuButton, type MenuItem } from '../ui/Menu';

/** Efforts the ChatGPT group offers, in the order they read. */
export const EFFORTS: ('low' | 'medium' | 'high')[] = ['low', 'medium', 'high'];

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
  openai: [{ id: '', label: 'Default' }],
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
  availability: ProviderAvailability;
  models: ProviderModelInfo[];
}

/**
 * The menu's contents: one group per vendor, in a fixed order so the list
 * never reshuffles under the pointer as availability changes. Server-curated
 * models win; the fallback fills in before the read-out lands.
 */
export function modelGroups(providers: ChatProviderStatus | null): ModelGroup[] {
  return (['anthropic', 'openai'] as ChatProvider[]).map((provider) => {
    const curated = provider === 'anthropic' ? providers?.anthropic.models : providers?.openai.models;
    return {
      provider,
      title: providerDisplayName(provider),
      availability: providerAvailability(provider, providers),
      models: curated && curated.length > 0 ? curated : FALLBACK_MODELS[provider],
    };
  });
}

/** An empty id from the server means "whatever this provider defaults to". */
export function modelIdFor(info: ProviderModelInfo): string | null {
  return info.id === '' ? null : info.id;
}

/** True when the stored choice is exactly this provider + model. */
export function isChosen(choice: AgentChoice | null, provider: ChatProvider, model: string | null): boolean {
  return choice !== null && choice.provider === provider && choice.model === model;
}

/**
 * The choice a click on one of the model rows produces. Effort is carried over
 * only where it means anything (ChatGPT) — otherwise it would sit in storage
 * as a setting the user can't see and can't have meant.
 */
export function choiceForModel(
  current: AgentChoice | null,
  provider: ChatProvider,
  model: string | null,
): AgentChoice {
  const effort = provider === 'openai' ? (current?.provider === 'openai' ? current.effort : null) : null;
  return { provider, model, effort };
}

function openSettings(): void {
  window.dispatchEvent(new CustomEvent('hearth:open-settings'));
}

export function ModelSelector() {
  const choice = useModelChoice();
  const providers = useApp((s) => s.providers);
  const groups = modelGroups(providers);
  const effort = effortLabel(choice);

  const items: MenuItem[] = [];
  for (const group of groups) {
    if (items.length > 0) items.push({ separator: true });
    items.push({ header: group.title, note: group.availability.note });
    for (const info of group.models) {
      const model = modelIdFor(info);
      items.push({
        label: info.label,
        checked: isChosen(choice, group.provider, model),
        onSelect: () => {
          // An unavailable provider routes to the one place the situation can
          // actually be fixed, rather than storing a choice that can't run.
          if (!group.availability.available) openSettings();
          else setModelChoice(choiceForModel(getModelChoice(), group.provider, model));
        },
      });
    }
    if (!group.availability.available) {
      items.push({ label: 'Set up in Settings…', onSelect: openSettings });
    }
    if (group.provider === 'openai') {
      items.push({ header: 'Effort' });
      for (const level of EFFORTS) {
        const isOpenAi = choice?.provider === 'openai';
        items.push({
          label: level.charAt(0).toUpperCase() + level.slice(1),
          checked: isOpenAi && choice?.effort === level,
          disabled: !isOpenAi,
          disabledReason: 'Applies to ChatGPT models',
          onSelect: () => {
            const current = getModelChoice();
            if (current?.provider !== 'openai') return;
            setModelChoice({ ...current, effort: level });
          },
        });
      }
    }
  }

  return (
    <MenuButton
      label="Model"
      align="right"
      items={items}
      triggerClassName="model-pill"
      popoverClassName="model-menu"
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
