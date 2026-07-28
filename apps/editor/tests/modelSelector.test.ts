/**
 * The composer's model selector, minus the render: which agents it lists, what
 * it says about each one's setup, which models each one can actually run, and
 * what a click on a row stores.
 *
 * The rules these pin:
 *
 *  - The menu never lies. A backend that cannot answer still lists its models
 *    — hiding them answers "why isn't Opus here?" with silence — but it says
 *    so, and picking one of its rows must not leave a choice behind that
 *    can't run.
 *  - The two backends are not a cross-product. A model belongs to the one
 *    thing that can run it, and no combination of clicks produces a pairing
 *    that would fail on send.
 *  - Efforts are the model's vocabulary. The picker offers exactly what a
 *    model declared and nothing when it declared none, because codex's own
 *    catalogue answers this per model.
 *  - A person who chose a model before any of this existed still has it.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_MODEL,
  FALLBACK_MODELS,
  choiceForModel,
  isChosen,
  modelGroups,
  modelIdFor,
  modelRowNote,
  providerAvailability,
} from '../src/components/chat/ModelSelector';
import {
  AGENT_BACKENDS,
  agentForTurn,
  backendFor,
  effectiveModel,
  effortDisplayName,
  effortOptions,
  parseStoredChoice,
} from '../src/chat/modelChoice';
import type { AgentChoice, ChatProviderStatus, ProviderModelInfo } from '../src/types';

function providers(over: Partial<ChatProviderStatus> = {}): ChatProviderStatus {
  return {
    anthropic: { hasKey: false, source: null },
    openai: {
      installed: false,
      version: null,
      loggedIn: false,
      authMode: null,
      email: null,
      planType: null,
      hasKey: false,
    },
    active: null,
    ...over,
  };
}

/**
 * Shaped like a real `model/list` read-out on codex-cli 0.144.5, down to the
 * part that matters most here: the two models do NOT accept the same efforts,
 * and they do not default to the same one.
 */
const CODEX_MODELS: ProviderModelInfo[] = [
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6-Sol',
    description: 'Latest frontier agentic coding model.',
    isDefault: true,
    efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }, { id: 'max' }, { id: 'ultra' }],
    defaultEffort: 'low',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4-Mini',
    description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
    efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }],
    defaultEffort: 'medium',
  },
];

/** A signed-in codex with the catalogue above, and Claude connected too. */
function bothReady(): ChatProviderStatus {
  return providers({
    anthropic: {
      hasKey: true,
      source: 'project',
      models: [
        { id: 'claude-opus-5', label: 'Opus 5', note: 'Most capable' },
        { id: 'claude-sonnet-5', label: 'Sonnet 5', note: 'Balanced' },
      ],
    },
    openai: { ...providers().openai, installed: true, loggedIn: true, models: CODEX_MODELS },
    active: 'anthropic',
  });
}

describe('agent backends', () => {
  it('names what runs the loop, one per provider, in a fixed order', () => {
    expect(AGENT_BACKENDS.map((b) => b.id)).toEqual(['claude-agent-sdk', 'codex-cli']);
    expect(AGENT_BACKENDS.map((b) => b.provider)).toEqual(['anthropic', 'openai']);
    expect(backendFor('anthropic').name).toBe('Claude Agent SDK');
    expect(backendFor('openai').name).toBe('Codex CLI');
  });
});

describe('providerAvailability', () => {
  it('reads Anthropic as the key it is', () => {
    expect(providerAvailability('anthropic', providers({ anthropic: { hasKey: true, source: 'project' } }))).toEqual({
      available: true,
      note: 'API key',
    });
    expect(providerAvailability('anthropic', providers())).toEqual({ available: false, note: 'Not set up' });
  });

  it('distinguishes every way OpenAI can be half set up', () => {
    const openai = (over: Partial<ChatProviderStatus['openai']>) =>
      providerAvailability('openai', providers({ openai: { ...providers().openai, ...over } }));

    expect(openai({ installed: false })).toEqual({ available: false, note: 'Not installed' });
    expect(openai({ installed: true })).toEqual({ available: false, note: 'Not signed in' });
    expect(openai({ installed: true, loggedIn: true })).toEqual({ available: true, note: 'Signed in' });
    expect(openai({ installed: true, hasKey: true })).toEqual({ available: true, note: 'API key' });
  });

  it('says "not set up" rather than guessing before the read-out lands', () => {
    expect(providerAvailability('anthropic', null).available).toBe(false);
    expect(providerAvailability('openai', null)).toEqual({ available: false, note: 'Not set up' });
  });
});

describe('modelGroups', () => {
  it('offers both agents, in a fixed order, each named with what runs it', () => {
    const groups = modelGroups(null);
    expect(groups.map((g) => g.provider)).toEqual(['anthropic', 'openai']);
    expect(groups.map((g) => g.title)).toEqual(['Claude', 'ChatGPT']);
    expect(groups.map((g) => g.backend)).toEqual(['Claude Agent SDK', 'Codex CLI']);
  });

  it('leads every group with the row that hands the choice back', () => {
    for (const group of modelGroups(bothReady())) {
      expect(group.models[0]).toEqual(AUTOMATIC_MODEL);
      expect(group.models.filter((m) => m.id === '')).toHaveLength(1);
    }
  });

  it('falls back to the curated Claude list before the server has described one', () => {
    const groups = modelGroups(null);
    expect(groups[0].models.slice(1)).toEqual(FALLBACK_MODELS.anthropic);
    expect(groups[0].models.map((m) => m.label)).toContain('Opus 5');
  });

  it('offers no invented ChatGPT model before the binary has been asked', () => {
    // Which models a codex build can run is the binary's answer. Until it has
    // given one there is exactly one honest row: let codex decide.
    expect(modelGroups(null)[1].models).toEqual([AUTOMATIC_MODEL]);
  });

  it('prefers what the server curated over the fallback', () => {
    const groups = modelGroups(
      providers({
        anthropic: { hasKey: true, source: 'project', models: [{ id: 'claude-x', label: 'X' }] },
      }),
    );
    expect(groups[0].models).toEqual([AUTOMATIC_MODEL, { id: 'claude-x', label: 'X' }]);
  });

  it('ignores an empty curated list rather than showing an empty group', () => {
    const groups = modelGroups(providers({ anthropic: { hasKey: true, source: 'project', models: [] } }));
    expect(groups[0].models.slice(1)).toEqual(FALLBACK_MODELS.anthropic);
  });

  it('renames a backend’s own passthrough row instead of showing two of them', () => {
    const status = providers({
      openai: { ...providers().openai, models: [{ id: '', label: 'Default' }, ...CODEX_MODELS] },
    });
    const openai = modelGroups(status)[1];
    expect(openai.models.filter((m) => m.id === '')).toEqual([AUTOMATIC_MODEL]);
    expect(openai.models.map((m) => m.id)).toEqual(['', 'gpt-5.6-sol', 'gpt-5.4-mini']);
  });

  it('never lists a model under the agent that cannot run it', () => {
    const groups = modelGroups(bothReady());
    const claude = groups[0].models.map((m) => m.id);
    const chatgpt = groups[1].models.map((m) => m.id);
    expect(claude).toEqual(['', 'claude-opus-5', 'claude-sonnet-5']);
    expect(chatgpt).toEqual(['', 'gpt-5.6-sol', 'gpt-5.4-mini']);
    // The one id they share is the passthrough row, which means something
    // different — and correct — on each side.
    expect(claude.filter((id) => chatgpt.includes(id))).toEqual(['']);
  });

  it('carries the availability of each group so the header can state it', () => {
    const groups = modelGroups(providers({ anthropic: { hasKey: true, source: 'environment' } }));
    expect(groups[0].availability).toEqual({ available: true, note: 'API key' });
    expect(groups[1].availability.available).toBe(false);
  });
});

describe('modelRowNote', () => {
  it('calls out the model the passthrough row would resolve to', () => {
    expect(modelRowNote(CODEX_MODELS[0])).toBe('Default');
    expect(modelRowNote(CODEX_MODELS[1])).toBeUndefined();
  });

  it('shows a curated note where the provider gave one instead', () => {
    expect(modelRowNote({ id: 'claude-opus-5', label: 'Opus 5', note: 'Most capable' })).toBe('Most capable');
  });
});

describe('modelIdFor', () => {
  it('reads the server default entry as "provider decides"', () => {
    expect(modelIdFor({ id: '', label: 'Default' })).toBeNull();
    expect(modelIdFor({ id: 'claude-opus-5', label: 'Opus 5' })).toBe('claude-opus-5');
  });
});

describe('isChosen', () => {
  it('matches on provider and model together', () => {
    const choice = { provider: 'anthropic' as const, model: 'claude-opus-5', effort: null };
    expect(isChosen(choice, 'anthropic', 'claude-opus-5')).toBe(true);
    expect(isChosen(choice, 'anthropic', 'claude-sonnet-5')).toBe(false);
    expect(isChosen(choice, 'openai', 'claude-opus-5')).toBe(false);
    expect(isChosen(null, 'anthropic', 'claude-opus-5')).toBe(false);
  });

  it('treats the provider default as a real, checkable choice', () => {
    expect(isChosen({ provider: 'openai', model: null, effort: null }, 'openai', null)).toBe(true);
  });
});

describe('choiceForModel', () => {
  it('carries effort across a ChatGPT model change', () => {
    const current = { provider: 'openai' as const, model: null, effort: 'high' };
    expect(choiceForModel(current, 'openai', 'gpt-x')).toEqual({ provider: 'openai', model: 'gpt-x', effort: 'high' });
  });

  it('drops effort when the answer moves to a provider that has no such dial', () => {
    const current = { provider: 'openai' as const, model: null, effort: 'high' };
    expect(choiceForModel(current, 'anthropic', 'claude-opus-5')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
      effort: null,
    });
  });

  it('starts a ChatGPT choice with no effort rather than inventing one', () => {
    const current = { provider: 'anthropic' as const, model: 'claude-opus-5', effort: null };
    expect(choiceForModel(current, 'openai', null).effort).toBeNull();
    expect(choiceForModel(null, 'openai', null).effort).toBeNull();
  });

  it('does not carry an effort onto a model that does not accept it', () => {
    // `ultra` is real on one codex model and absent on the next. Carrying it
    // across would build a choice that fails the moment it is sent.
    const current = { provider: 'openai' as const, model: 'gpt-5.6-sol', effort: 'ultra' };
    expect(choiceForModel(current, 'openai', 'gpt-5.4-mini', bothReady()).effort).toBeNull();
    expect(choiceForModel(current, 'openai', 'gpt-5.6-sol', bothReady()).effort).toBe('ultra');
  });

  it('leaves an effort alone when there is no catalogue to judge it by', () => {
    const current = { provider: 'openai' as const, model: null, effort: 'ultra' };
    expect(choiceForModel(current, 'openai', 'gpt-5.4-mini', null).effort).toBe('ultra');
  });
});

describe('effectiveModel', () => {
  it('describes the model a choice actually names', () => {
    const choice: AgentChoice = { provider: 'openai', model: 'gpt-5.4-mini', effort: null };
    expect(effectiveModel(choice, bothReady())?.label).toBe('GPT-5.4-Mini');
  });

  it('resolves "let it decide" to the model the backend says it would pick', () => {
    const choice: AgentChoice = { provider: 'openai', model: null, effort: null };
    expect(effectiveModel(choice, bothReady())?.id).toBe('gpt-5.6-sol');
  });

  it('knows nothing before the read-out lands, and says so', () => {
    expect(effectiveModel({ provider: 'openai', model: 'gpt-5.6-sol', effort: null }, null)).toBeNull();
    expect(effectiveModel(null, bothReady())).toBeNull();
  });
});

describe('effortOptions', () => {
  it('offers exactly what the chosen model declared, in its own order', () => {
    const choice: AgentChoice = { provider: 'openai', model: 'gpt-5.4-mini', effort: null };
    expect(effortOptions(choice, bothReady()).map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('offers the six a bigger model declared, including the ones no union had', () => {
    const choice: AgentChoice = { provider: 'openai', model: 'gpt-5.6-sol', effort: null };
    expect(effortOptions(choice, bothReady()).map((e) => e.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
  });

  it('offers none where the backend never described one', () => {
    // Claude runs through the Agent SDK, which has no effort option at all —
    // so there is no dial to show, rather than a disabled one to explain.
    expect(effortOptions({ provider: 'anthropic', model: 'claude-opus-5', effort: null }, bothReady())).toEqual([]);
    expect(effortOptions({ provider: 'openai', model: 'gpt-5.6-sol', effort: null }, null)).toEqual([]);
  });
});

describe('effortDisplayName', () => {
  it('spells out the token that is not a word', () => {
    expect(effortDisplayName('xhigh')).toBe('Extra high');
    expect(effortDisplayName('medium')).toBe('Medium');
    expect(effortDisplayName('ultra')).toBe('Ultra');
  });
});

describe('parseStoredChoice — a choice made before any of this still holds', () => {
  it('loads the shape older builds wrote, unchanged', () => {
    expect(parseStoredChoice(JSON.stringify({ provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' }))).toEqual({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
    expect(parseStoredChoice(JSON.stringify({ provider: 'anthropic', model: 'claude-opus-5', effort: null }))).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
      effort: null,
    });
  });

  it('reads the old spelling of "the provider decides"', () => {
    expect(parseStoredChoice(JSON.stringify({ provider: 'openai', model: '', effort: null }))).toEqual({
      provider: 'openai',
      model: null,
      effort: null,
    });
  });

  it('keeps the model when it does not recognise the effort', () => {
    // Efforts used to be validated against a hardcoded low/medium/high. The
    // real vocabulary is the model's, so an unfamiliar one must not throw the
    // whole choice — the model included — away.
    expect(parseStoredChoice(JSON.stringify({ provider: 'openai', model: 'gpt-5.6-sol', effort: 'ultra' }))).toEqual({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
    });
  });

  it('drops an effort that is not a token a backend could have named', () => {
    const choice = parseStoredChoice(JSON.stringify({ provider: 'openai', model: 'gpt-5.6-sol', effort: 42 }));
    expect(choice).toEqual({ provider: 'openai', model: 'gpt-5.6-sol', effort: null });
  });

  it('yields no choice at all rather than half of one', () => {
    expect(parseStoredChoice(null)).toBeNull();
    expect(parseStoredChoice('')).toBeNull();
    expect(parseStoredChoice('not json')).toBeNull();
    expect(parseStoredChoice(JSON.stringify(['openai']))).toBeNull();
    expect(parseStoredChoice(JSON.stringify({ model: 'gpt-5.6-sol' }))).toBeNull();
    expect(parseStoredChoice(JSON.stringify({ provider: 'deepmind', model: 'x' }))).toBeNull();
  });
});

describe('agentForTurn', () => {
  it('sends nothing at all when nothing was chosen', () => {
    expect(agentForTurn(null, bothReady())).toBeNull();
    expect(agentForTurn(null, null)).toBeNull();
  });

  it('sends a choice through untouched when the model accepts it', () => {
    const choice: AgentChoice = { provider: 'openai', model: 'gpt-5.6-sol', effort: 'ultra' };
    expect(agentForTurn(choice, bothReady())).toEqual(choice);
  });

  it('drops an effort the chosen model has stopped accepting', () => {
    // Stored while Sol was selected; Mini does not take `ultra`.
    const choice: AgentChoice = { provider: 'openai', model: 'gpt-5.4-mini', effort: 'ultra' };
    expect(agentForTurn(choice, bothReady())).toEqual({ ...choice, effort: null });
  });

  it('drops nothing on a hunch — no catalogue means no evidence', () => {
    const choice: AgentChoice = { provider: 'openai', model: 'gpt-5.6-sol', effort: 'ultra' };
    expect(agentForTurn(choice, null)).toEqual(choice);
    expect(agentForTurn({ provider: 'anthropic', model: 'claude-opus-5', effort: null }, bothReady())).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
      effort: null,
    });
  });
});
