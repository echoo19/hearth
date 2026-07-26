/**
 * The user's standing agent/model/effort choice.
 *
 * Deliberately its own tiny store rather than a corner of the app store: the
 * composer's model selector writes it, the send path reads it, and neither
 * needs the other's file to exist. Persisted in localStorage because it is a
 * preference about the person, not about any one folder.
 */
import { useSyncExternalStore } from 'react';
import type { AgentChoice, ChatProvider, ChatProviderStatus } from '../types';

const STORAGE_KEY = 'hearth:modelChoice';

/** Fallback labels for model ids the providers endpoint hasn't described. */
const KNOWN_MODEL_LABELS: Record<string, string> = {
  'claude-opus-5': 'Opus 5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
};

let current: AgentChoice | null = load();
const listeners = new Set<() => void>();

function load(): AgentChoice | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AgentChoice>;
    if (parsed.provider !== 'anthropic' && parsed.provider !== 'openai') return null;
    return {
      provider: parsed.provider,
      model: typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : null,
      effort: parsed.effort === 'low' || parsed.effort === 'medium' || parsed.effort === 'high' ? parsed.effort : null,
    };
  } catch {
    return null;
  }
}

/** The choice as the send path should read it — null means "server decides". */
export function getModelChoice(): AgentChoice | null {
  return current;
}

export function setModelChoice(choice: AgentChoice | null): void {
  current = choice;
  try {
    if (choice === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Storage unavailable — the in-memory value still holds for this window.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React binding for the selector; re-renders on every setModelChoice. */
export function useModelChoice(): AgentChoice | null {
  return useSyncExternalStore(subscribe, getModelChoice, getModelChoice);
}

/** The provider's human name, as the selector groups say it. */
export function providerDisplayName(provider: ChatProvider): string {
  return provider === 'anthropic' ? 'Claude' : 'ChatGPT';
}

/**
 * What the selector pill says. Resolves the model id against the providers
 * read-out when available, falls back to known labels, then to the raw id,
 * then to the provider's name; a null choice reads as "Auto".
 */
export function modelChoiceLabel(choice: AgentChoice | null, providers: ChatProviderStatus | null): string {
  if (!choice) return 'Auto';
  const models = choice.provider === 'anthropic' ? providers?.anthropic.models : providers?.openai.models;
  if (choice.model === null) return providerDisplayName(choice.provider);
  const described = models?.find((m) => m.id === choice.model);
  return described?.label ?? KNOWN_MODEL_LABELS[choice.model] ?? choice.model;
}

/** The effort word shown beside the model, or null when it doesn't apply. */
export function effortLabel(choice: AgentChoice | null): string | null {
  if (!choice || choice.effort === null || choice.provider !== 'openai') return null;
  return choice.effort.charAt(0).toUpperCase() + choice.effort.slice(1);
}
