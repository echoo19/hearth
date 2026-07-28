/**
 * The user's standing choice of agent, model and effort.
 *
 * Deliberately its own tiny store rather than a corner of the app store: the
 * composer's model selector writes it, the send path reads it, and neither
 * needs the other's file to exist. Persisted in localStorage because it is a
 * preference about the person, not about any one folder.
 *
 * Two things a reader has to hold at once, because the picker is shaped by
 * them:
 *
 *  1. **The agent backend decides the model family.** Claude models run
 *     through the Claude Agent SDK, whose `model` option is documented as a
 *     Claude alias or a Claude model id; ChatGPT models run through the Codex
 *     CLI, whose catalogue is whatever `model/list` on the installed binary
 *     returns. There is no cross-product — no Codex-run Claude, no SDK-run
 *     GPT — so `provider` names both halves and there is no second field
 *     pretending they can disagree. The backend is still shown and chosen
 *     explicitly (see AGENT_BACKENDS): "what is running the loop" is a real
 *     question, it just has a two-item answer.
 *  2. **Effort is the model's vocabulary, not ours.** See `AgentChoice`.
 *
 * None of this constrains the terminal, which runs whatever CLI is installed.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { apiModelPrefs, apiSetModelEnabled } from '../api';
import type { AgentChoice, ChatProvider, ChatProviderStatus, EffortOption, ProviderModelInfo } from '../types';

const STORAGE_KEY = 'hearth:modelChoice';

/** Fallback labels for model ids the providers endpoint hasn't described. */
const KNOWN_MODEL_LABELS: Record<string, string> = {
  'claude-opus-5': 'Opus 5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
};

/**
 * What actually runs the agent loop.
 *
 * Named as its own thing because it is a real choice with real consequences —
 * one is a library inside Hearth's server, the other is a binary the user
 * installed and signed into — and because "provider" answers a different
 * question (whose models). The word "harness" is deliberately avoided in the
 * copy: in this app that already means a game backend.
 *
 * This is the registry a chat backend is ADDED to. Everything Settings needs
 * to draw a row for one is a field here — how you connect it, whose models it
 * drives, what to call it — so a third backend is an entry rather than a
 * rewrite. What it is NOT is a wish list: an entry here is a claim that
 * Hearth has a driver that can answer a turn with it (server/chat.ts for the
 * SDK, server/chatDrivers/codex.ts for codex). Listing one Hearth cannot drive
 * would put a Connect button on screen that saves a credential nothing reads,
 * which is the worst thing this pane could do.
 */
export interface AgentBackend {
  /** Stable id, useful in code and never shown. */
  id: 'claude-agent-sdk' | 'codex-cli';
  /** The provider whose models this backend can run. */
  provider: ChatProvider;
  /** What it is called, in its own vendor's words. */
  name: string;
  /** The vendor whose models it runs — the second half of the sentence. */
  vendor: string;
  /** One line: what it actually is, said plainly. */
  blurb: string;
  /**
   * How you give it permission to work. A key you paste, or a sign-in it
   * carries out somewhere else. This is the backend's own answer, not a
   * preference: the SDK has no OAuth to hand off to, and codex's sign-in is
   * the whole reason it exists as a separate binary.
   */
  connection: 'api-key' | 'sign-in';
  /**
   * Whose models it can drive, said in one noun phrase.
   *
   * Both of today's backends are bound to one catalogue: the Agent SDK's
   * `model` option takes Claude ids, and codex answers from its own
   * `model/list`. Other harnesses are model-agnostic, so this field exists to
   * say so per entry rather than the pane implying a free cross-product that
   * neither of these two supports.
   */
  catalogue: string;
}

/**
 * Fixed order, so nothing reshuffles under the pointer as availability moves.
 * Both are listed always — a backend you have not set up is still an answer to
 * "what could run this", and hiding it answers the question with silence.
 */
export const AGENT_BACKENDS: AgentBackend[] = [
  {
    id: 'claude-agent-sdk',
    provider: 'anthropic',
    name: 'Claude Agent SDK',
    vendor: 'Claude',
    blurb: 'Runs inside Hearth, on your Anthropic API key.',
    connection: 'api-key',
    catalogue: 'Claude models',
  },
  {
    id: 'codex-cli',
    provider: 'openai',
    name: 'Codex CLI',
    vendor: 'ChatGPT',
    blurb: 'Runs the open-source codex binary you installed, under your own sign-in.',
    connection: 'sign-in',
    catalogue: 'OpenAI models',
  },
];

/** The backend that runs this provider's models. Total: there are only two. */
export function backendFor(provider: ChatProvider): AgentBackend {
  return AGENT_BACKENDS[provider === 'anthropic' ? 0 : 1];
}

let current: AgentChoice | null = load();
const listeners = new Set<() => void>();

/**
 * Read one stored choice. Exported so the storage contract is testable without
 * a window, and tolerant in both directions:
 *
 *  - The shape has never changed — `{ provider, model, effort }` is what older
 *    builds wrote and what this one writes — so a value saved before any of
 *    this existed loads unchanged rather than being reset.
 *  - Efforts, however, were once validated against a hardcoded
 *    `low | medium | high`. The real vocabulary is per-model and open (a
 *    current codex offers `xhigh`, `max`, `ultra`), so an effort outside the
 *    old three no longer throws the WHOLE choice away — losing someone's model
 *    because we did not recognise their effort would be the worse bug. Shape
 *    is still checked, so junk can't reach a turn.
 */
export function parseStoredChoice(raw: string | null): AgentChoice | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Partial<AgentChoice>;
    if (record.provider !== 'anthropic' && record.provider !== 'openai') return null;
    const effort = typeof record.effort === 'string' ? record.effort.trim() : '';
    return {
      provider: record.provider,
      model: typeof record.model === 'string' && record.model !== '' ? record.model : null,
      effort: /^[a-z][a-z0-9-]{0,23}$/.test(effort) ? effort : null,
    };
  } catch {
    return null;
  }
}

function load(): AgentChoice | null {
  try {
    return parseStoredChoice(localStorage.getItem(STORAGE_KEY));
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

/** The models a provider reported, or none before the read-out has landed. */
export function providerModels(
  provider: ChatProvider,
  providers: ChatProviderStatus | null,
): ProviderModelInfo[] {
  const models = provider === 'anthropic' ? providers?.anthropic.models : providers?.openai.models;
  return models ?? [];
}

/**
 * The model a choice would actually run, described.
 *
 * A null model means "let the backend decide", and for codex that is a model
 * the catalogue names (`isDefault`) — so the effort dial can still be right
 * rather than going blank the moment someone leaves the model on Automatic.
 * Null when the read-out has not landed, or when the backend never said.
 */
export function effectiveModel(
  choice: AgentChoice | null,
  providers: ChatProviderStatus | null,
): ProviderModelInfo | null {
  if (!choice) return null;
  const models = providerModels(choice.provider, providers);
  if (choice.model === null) return models.find((m) => m.isDefault === true) ?? null;
  return models.find((m) => m.id === choice.model) ?? null;
}

/**
 * The efforts to offer for a choice: exactly what that model declared, and
 * nothing when it declared none. A model that rejects an effort we offered is
 * a turn that fails for a reason the user could not have predicted, which is
 * the same rule that keeps invented model ids out of the picker.
 */
export function effortOptions(choice: AgentChoice | null, providers: ChatProviderStatus | null): EffortOption[] {
  return effectiveModel(choice, providers)?.efforts ?? [];
}

/**
 * What an effort token is called. codex ships a description per effort but no
 * display name, so the words are ours: sentence case, with the one token that
 * is not a word spelled out.
 */
export function effortDisplayName(id: string): string {
  if (id === 'xhigh') return 'Extra high';
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * What the selector pill says. Resolves the model id against the providers
 * read-out when available, falls back to known labels, then to the raw id,
 * then to the provider's name; a null choice reads as "Auto".
 */
export function modelChoiceLabel(choice: AgentChoice | null, providers: ChatProviderStatus | null): string {
  if (!choice) return 'Auto';
  if (choice.model === null) return providerDisplayName(choice.provider);
  const described = providerModels(choice.provider, providers).find((m) => m.id === choice.model);
  return described?.label ?? KNOWN_MODEL_LABELS[choice.model] ?? choice.model;
}

/** The effort word shown beside the model, or null when it doesn't apply. */
export function effortLabel(choice: AgentChoice | null): string | null {
  if (!choice || choice.effort === null || choice.provider !== 'openai') return null;
  return effortDisplayName(choice.effort);
}

/**
 * The choice to actually send with a turn.
 *
 * Reconciles the standing choice against what the backend now says it can do:
 * a stored effort that the chosen model does not list is dropped, so the turn
 * runs at the model's own default instead of failing on a token the user
 * picked back when a different model was selected. Only ever drops on
 * evidence — a model we have no catalogue for is left exactly as it is, and a
 * choice of null still sends nothing at all.
 */
export function agentForTurn(
  choice: AgentChoice | null,
  providers: ChatProviderStatus | null,
): AgentChoice | null {
  if (!choice || choice.effort === null) return choice;
  const efforts = effortOptions(choice, providers);
  if (efforts.length === 0 || efforts.some((e) => e.id === choice.effort)) return choice;
  return { ...choice, effort: null };
}

// ---------------------------------------------------------------------------
// Which models the user wants offered
//
// The catalogues only grow — one codex build already reports six models — and
// the composer's picker is a menu opened mid-sentence. So Settings can switch
// a model off, and the picker becomes the shortlist the person chose.
//
// Stored per machine in ~/.hearth/models.json (server/modelPrefs.ts) as the
// set that is OFF, so a model nobody has seen yet defaults to on. Mirrored in
// memory here because the picker reads it on every render and cannot wait for
// a fetch, and because this module is already the one place both the picker
// and the Settings pane agree about what a turn would carry.
// ---------------------------------------------------------------------------

/** `provider:modelId`, matching the key the server stores. */
export function modelKey(provider: ChatProvider, id: string): string {
  return `${provider}:${id}`;
}

let disabledModels: ReadonlySet<string> = new Set<string>();
let disabledFile = '';
const disabledListeners = new Set<() => void>();
let disabledRequest: Promise<void> | null = null;

export function getDisabledModels(): ReadonlySet<string> {
  return disabledModels;
}

/**
 * Where the list is written, as the SERVER spelled it, or '' before the read
 * lands. Asked for rather than composed, because the answer is
 * `~/.hearth/models.json` on one machine and `C:\Users\…\.hearth\models.json`
 * on another, and a client that wrote the first would be telling half its
 * users to go and look somewhere that does not exist.
 */
export function getModelPrefsFile(): string {
  return disabledFile;
}

/** Replace the mirror. Called after a read and after a successful write. */
export function setDisabledModels(keys: Iterable<string>, file?: string): void {
  disabledModels = new Set(keys);
  if (file !== undefined && file !== '') disabledFile = file;
  for (const listener of disabledListeners) listener();
}

/**
 * Read the list once per window, then share it. A failed read is not cached as
 * an answer: it leaves the set empty, which offers every model rather than
 * hiding models the user did switch off — the safe direction to fail in, since
 * the alternative is a picker that silently lost half its rows.
 */
function loadDisabledModels(): Promise<void> {
  disabledRequest ??= apiModelPrefs().then((prefs) => {
    if (prefs) setDisabledModels(prefs.disabled, prefs.file);
    else disabledRequest = null;
  });
  return disabledRequest;
}

/** React binding. Mounting anything that reads the list also asks for it. */
export function useDisabledModels(): ReadonlySet<string> {
  const [set, setSet] = useState(disabledModels);
  useEffect(() => {
    let alive = true;
    const settle = (): void => {
      if (alive) setSet(disabledModels);
    };
    disabledListeners.add(settle);
    void loadDisabledModels().then(settle);
    return () => {
      alive = false;
      disabledListeners.delete(settle);
    };
  }, []);
  return set;
}

/**
 * Is this model offered?
 *
 * The empty id is always yes. It is not a model, it is the row that hands the
 * choice back to the backend, and a picker with no way to say "you decide"
 * would be a worse menu than one with a model too many.
 */
export function isModelEnabled(
  provider: ChatProvider,
  id: string,
  disabled: ReadonlySet<string> = disabledModels,
): boolean {
  return id === '' || !disabled.has(modelKey(provider, id));
}

/** A catalogue with the switched-off entries taken out. */
export function enabledModels(
  provider: ChatProvider,
  models: readonly ProviderModelInfo[],
  disabled: ReadonlySet<string> = disabledModels,
): ProviderModelInfo[] {
  return models.filter((model) => isModelEnabled(provider, model.id, disabled));
}

/**
 * Nobody gets to switch everything off.
 *
 * A backend with no models left would leave the picker holding one row that
 * says "you decide" and nothing to decide between, which is a dead end the
 * user built by accident. This REFUSES rather than silently keeping one: the
 * last switch is shown off-limits with the reason attached, so the rule is
 * read before the click instead of discovered after it.
 *
 * Turning a model back ON is never refused, whatever the counts say.
 */
export function canSetModelEnabled(
  provider: ChatProvider,
  models: readonly ProviderModelInfo[],
  disabled: ReadonlySet<string>,
  id: string,
  enabled: boolean,
): boolean {
  if (enabled || id === '') return true;
  const remaining = enabledModels(provider, models, disabled).filter((m) => m.id !== '' && m.id !== id);
  return remaining.length > 0;
}

/**
 * The standing choice, after a model it names has been switched off.
 *
 * Falls back to that backend's own default (`model: null`) rather than to
 * another model or to nothing. Two reasons: the provider half of the choice is
 * still exactly what the person picked and is not what they just changed, and
 * the Automatic row is the one option that cannot itself be switched off. The
 * effort rides along untouched — `agentForTurn` already drops one the resolved
 * model does not accept, and duplicating that rule here is how the two would
 * eventually disagree.
 */
export function reconcileChoice(
  choice: AgentChoice | null,
  disabled: ReadonlySet<string> = disabledModels,
): AgentChoice | null {
  if (!choice || choice.model === null) return choice;
  if (isModelEnabled(choice.provider, choice.model, disabled)) return choice;
  return { ...choice, model: null };
}

/**
 * Switch one model on or off: the server first, the mirror second.
 *
 * Server-first because the server owns the merge — it holds entries for models
 * this window has never seen, and its answer is the whole list rather than the
 * one that changed. A failed write leaves the mirror alone, so the switch
 * springs back to what is actually saved instead of showing a change that did
 * not land.
 *
 * The standing choice is reconciled here, in the same step, because a model
 * that is no longer offered must not still be the thing the next turn sends.
 */
export async function setModelEnabled(provider: ChatProvider, id: string, enabled: boolean): Promise<boolean> {
  const prefs = await apiSetModelEnabled(modelKey(provider, id), enabled);
  if (!prefs) return false;
  setDisabledModels(prefs.disabled, prefs.file);
  const next = reconcileChoice(getModelChoice(), disabledModels);
  if (next !== getModelChoice()) setModelChoice(next);
  return true;
}
