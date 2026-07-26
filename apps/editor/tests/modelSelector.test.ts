/**
 * The composer's model selector, minus the render: which vendors it groups,
 * what it says about each one's setup, and what a click on a row stores.
 *
 * The rule these pin is that the menu never lies. A provider that cannot
 * answer still lists its models — hiding them answers "why isn't Opus here?"
 * with silence — but it says so in the group header, and picking one of its
 * rows must not leave a choice behind that can't run.
 */
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_MODELS,
  choiceForModel,
  isChosen,
  modelGroups,
  modelIdFor,
  providerAvailability,
} from '../src/components/chat/ModelSelector';
import type { ChatProviderStatus } from '../src/types';

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
  it('always offers both vendors, in a fixed order', () => {
    const groups = modelGroups(null);
    expect(groups.map((g) => g.provider)).toEqual(['anthropic', 'openai']);
    expect(groups.map((g) => g.title)).toEqual(['Claude', 'ChatGPT']);
  });

  it('falls back to the curated list before the server has described one', () => {
    const groups = modelGroups(null);
    expect(groups[0].models).toEqual(FALLBACK_MODELS.anthropic);
    expect(groups[0].models.map((m) => m.label)).toContain('Opus 5');
  });

  it('prefers what the server curated over the fallback', () => {
    const groups = modelGroups(
      providers({
        anthropic: { hasKey: true, source: 'project', models: [{ id: 'claude-x', label: 'X' }] },
      }),
    );
    expect(groups[0].models).toEqual([{ id: 'claude-x', label: 'X' }]);
  });

  it('ignores an empty curated list rather than showing an empty group', () => {
    const groups = modelGroups(providers({ anthropic: { hasKey: true, source: 'project', models: [] } }));
    expect(groups[0].models).toEqual(FALLBACK_MODELS.anthropic);
  });

  it('carries the availability of each group so the header can state it', () => {
    const groups = modelGroups(providers({ anthropic: { hasKey: true, source: 'environment' } }));
    expect(groups[0].availability).toEqual({ available: true, note: 'API key' });
    expect(groups[1].availability.available).toBe(false);
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
    const current = { provider: 'openai' as const, model: null, effort: 'high' as const };
    expect(choiceForModel(current, 'openai', 'gpt-x')).toEqual({ provider: 'openai', model: 'gpt-x', effort: 'high' });
  });

  it('drops effort when the answer moves to a provider that has no such dial', () => {
    const current = { provider: 'openai' as const, model: null, effort: 'high' as const };
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
});
