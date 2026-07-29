// @vitest-environment jsdom
/**
 * WHICH AGENT ANSWERS, and what survives being asked to change it.
 *
 * The composer used to list every vendor's models at once, so picking one was
 * also, silently, a way to change who answered: the pill said "Opus 5" while
 * the account row underneath still described a ChatGPT sign-in, and neither
 * surface was wrong on its own. One agent is active at a time now, every
 * surface reads that from the same place, and switching is its own act.
 *
 * These pin the four things that make the rule survive contact:
 *
 *   1. one answer to "who answers", with the standing choice ahead of the
 *      server's read-out and a real provider rather than null at the end of it;
 *   2. a switch carries NO model across, because a model belongs to the
 *      catalogue of the agent being left;
 *   3. a choice stored by a build that had a fourth field still loads;
 *   4. the switch takes effect in the window even when the folder refuses to
 *      record it, because a person who cannot write a file must still be able
 *      to change agent.
 *
 * jsdom because the store reaches localStorage and the DOM on import; the
 * assertions themselves are DOM-free.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  apiSaveProviderSettings: vi.fn(async () => ({ hasKey: true, source: 'project' })),
  apiChatProviders: vi.fn(async () => null),
}));

import { apiChatProviders, apiSaveProviderSettings } from '../src/api';
import {
  activeProvider,
  choiceForProvider,
  effortLabel,
  getModelChoice,
  parseStoredChoice,
  setModelChoice,
  EFFORT_AUTOMATIC_LABEL,
  rememberedChoiceFor,
} from '../src/chat/modelChoice';
import { useApp } from '../src/store';
import type { AgentChoice, ChatProviderStatus } from '../src/types';

function providers(over: Partial<ChatProviderStatus> = {}): ChatProviderStatus {
  return {
    anthropic: { hasKey: false, source: null, cli: false, loggedIn: false, email: null, planType: null },
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
 * One catalogue per side, shaped the way the two backends really answer: the
 * codex model declares its own efforts and its own default, and the Claude
 * models declare none at all. That asymmetry is the whole subject of the
 * effort assertions below, so it is in the fixture rather than in a mock.
 */
function bothReady(): ChatProviderStatus {
  return providers({
    anthropic: {
      hasKey: true,
      source: 'project',
      cli: false,
      loggedIn: false,
      email: null,
      planType: null,
      models: [
        { id: 'claude-opus-5', label: 'Opus 5', note: 'Most capable' },
        { id: 'claude-sonnet-5', label: 'Sonnet 5' },
      ],
    },
    openai: {
      ...providers().openai,
      installed: true,
      loggedIn: true,
      models: [
        {
          id: 'gpt-5.6-sol',
          label: 'GPT-5.6-Sol',
          isDefault: true,
          efforts: [{ id: 'low' }, { id: 'high' }],
          defaultEffort: 'low',
        },
      ],
    },
    active: 'anthropic',
  });
}

beforeEach(() => {
  localStorage.clear();
  // Module-level store: one test's pick outlives its test unless it is cleared.
  setModelChoice(null);
  vi.mocked(apiSaveProviderSettings).mockReset();
  vi.mocked(apiSaveProviderSettings).mockResolvedValue({ hasKey: true, source: 'project' });
  vi.mocked(apiChatProviders).mockReset();
  vi.mocked(apiChatProviders).mockResolvedValue(null);
  useApp.setState({ projectPath: null, projectName: null, providers: null, consoleEntries: [] });
});

afterEach(() => {
  setModelChoice(null);
  localStorage.clear();
});

describe('activeProvider — one answer to "who answers"', () => {
  it('follows the standing choice, because that is what the send path reads', () => {
    // The server's read-out is `.hearth/app.json` as it was written weeks ago.
    // A window whose owner has just picked an agent is not overruled by it.
    const choice: AgentChoice = { provider: 'openai', model: null, effort: null };
    expect(activeProvider(choice, providers({ active: 'anthropic' }))).toBe('openai');
  });

  it('follows the server until someone has picked, so Settings is felt at once', () => {
    // A window that has never touched the picker still shows the agent the
    // project chose, rather than whatever this module's fallback happens to be.
    expect(activeProvider(null, providers({ active: 'openai' }))).toBe('openai');
    expect(activeProvider(null, providers({ active: 'anthropic' }))).toBe('anthropic');
  });

  it('names a provider rather than nothing when neither has spoken', () => {
    // Home has no folder open, so there is no read-out at all. A menu with no
    // catalogue in it while the fetch settles reads as broken, not as loading.
    expect(activeProvider(null, null)).toBe('anthropic');
    expect(activeProvider(null, providers())).toBe('anthropic');
  });
});

describe('choiceForProvider — a switch leaves the old catalogue behind', () => {
  it('carries no model across, because a codex turn naming a Claude model fails', () => {
    const claude: AgentChoice = { provider: 'anthropic', model: 'claude-opus-5', effort: null };
    const next = choiceForProvider('openai');
    expect(next).toEqual({ provider: 'openai', model: null, effort: null });
    // Said explicitly, because this is the bug: `claude-opus-5` is not a model
    // codex has ever heard of, and carrying it would build a turn that fails on
    // send for a reason the person could not have predicted from the pill.
    expect(next.model).not.toBe(claude.model);
    expect(next.model).toBeNull();
  });

  it('carries no effort across either, since the next model may not accept one', () => {
    // `high` is real on a codex model and meaningless to the Agent SDK. An
    // effort nobody can see and nobody chose is worse than no effort at all.
    const codex: AgentChoice = { provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' };
    expect(choiceForProvider('anthropic')).toEqual({ provider: 'anthropic', model: null, effort: null });
    expect(choiceForProvider('anthropic').effort).not.toBe(codex.effort);
  });
});

describe('parseStoredChoice — a choice written by a build with a fourth field', () => {
  it('keeps the provider, model and effort rather than rejecting the lot', () => {
    // Registering your own agent is gone, so a stored choice may still carry an
    // `agentId`. Throwing the whole value away would reset someone's model to
    // punish them for a feature that was removed underneath them.
    const stored = JSON.stringify({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      effort: 'high',
      agentId: 'my-own-agent',
    });
    expect(parseStoredChoice(stored)).toEqual({ provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' });
  });

  it('drops the field itself, so nothing downstream can read it back', () => {
    const parsed = parseStoredChoice(
      JSON.stringify({ provider: 'anthropic', model: 'claude-opus-5', effort: null, agentId: 'my-own-agent' }),
    );
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed as AgentChoice).sort()).toEqual(['effort', 'model', 'provider']);
    expect('agentId' in (parsed as object)).toBe(false);
  });
});

describe('effortLabel — the model decides whether there is a dial at all', () => {
  it('says nothing for a model that declared no efforts', () => {
    // Today's Claude models declare none, and this is the case that matters:
    // null is what keeps a permanent inert dial off the composer. It used to
    // test `provider === 'openai'`, which was true of every model with efforts
    // on the day it was written and is not a rule.
    expect(effortLabel({ provider: 'anthropic', model: 'claude-opus-5', effort: null }, bothReady())).toBeNull();
    expect(effortLabel({ provider: 'anthropic', model: 'claude-opus-5', effort: 'high' }, bothReady())).toBeNull();
  });

  it('says nothing before a catalogue has landed, or with nothing chosen', () => {
    expect(effortLabel({ provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' }, null)).toBeNull();
    expect(effortLabel(null, bothReady())).toBeNull();
  });

  it('reads Automatic when the model offers efforts and none is picked', () => {
    expect(effortLabel({ provider: 'openai', model: 'gpt-5.6-sol', effort: null }, bothReady())).toBe(
      EFFORT_AUTOMATIC_LABEL,
    );
    // Resolved through the backend's own default model too, so leaving the
    // model on nothing does not blank a dial that still applies.
    expect(effortLabel({ provider: 'openai', model: null, effort: null }, bothReady())).toBe(EFFORT_AUTOMATIC_LABEL);
  });

  it('names the effort that was picked', () => {
    expect(effortLabel({ provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' }, bothReady())).toBe('High');
  });

  it('reads Automatic for an effort the model does not declare, matching what is sent', () => {
    // `ultra` exists on other codex builds. The turn would run at the model's
    // own default, so the control must not claim otherwise.
    expect(effortLabel({ provider: 'openai', model: 'gpt-5.6-sol', effort: 'ultra' }, bothReady())).toBe(
      EFFORT_AUTOMATIC_LABEL,
    );
  });
});

describe('setChatProvider — the window first, the folder second', () => {
  it('writes the choice before anything can fail, so Home can switch with no folder', async () => {
    await useApp.getState().setChatProvider('openai');
    expect(getModelChoice()).toEqual({ provider: 'openai', model: null, effort: null });
    // Nothing open to save into, and nothing was asked of the server.
    expect(apiSaveProviderSettings).not.toHaveBeenCalled();
  });

  it('records it in the project too, so Settings and the pill cannot drift', async () => {
    useApp.setState({ projectPath: '/work/ember', projectName: 'ember' });
    await useApp.getState().setChatProvider('openai');
    expect(apiSaveProviderSettings).toHaveBeenCalledWith('/work/ember', { provider: 'openai' });
    // And the read-out is asked again, because the server's own answer to who
    // answers has just changed underneath every surface reading it.
    expect(apiChatProviders).toHaveBeenCalledWith('/work/ember');
  });

  it('leaves the local choice standing when the save fails', async () => {
    // Deliberate. Refusing the switch because a file could not be written would
    // leave the person unable to change agent at all, which is a worse outcome
    // than a preference that does not outlive the window. It says so instead.
    vi.mocked(apiSaveProviderSettings).mockResolvedValue(null);
    useApp.setState({ projectPath: '/work/ember', projectName: 'ember' });
    await useApp.getState().setChatProvider('openai');

    expect(getModelChoice()).toEqual({ provider: 'openai', model: null, effort: null });
    const messages = useApp.getState().consoleEntries.map((entry) => entry.message);
    expect(messages.some((message) => message.includes('this window only'))).toBe(true);
  });

  it('drops the model on the way out, even from a choice the person had picked', async () => {
    setModelChoice({ provider: 'anthropic', model: 'claude-opus-5', effort: null });
    await useApp.getState().setChatProvider('openai');
    expect(getModelChoice()?.model).toBeNull();
  });
});

/**
 * Switching agent drops the model but must not FORGET it.
 *
 * A Claude model id in a codex turn names a model codex has never heard of, so
 * the id genuinely cannot travel. But going Claude to codex and back used to
 * cost the Claude model every time, which made comparing two agents on the
 * same question a re-pick on every hop.
 */
describe('what an agent is left on', () => {
  beforeEach(() => {
    localStorage.clear();
    setModelChoice(null);
  });

  it('lands a first switch on nothing chosen yet', () => {
    expect(rememberedChoiceFor('openai')).toEqual({ provider: 'openai', model: null, effort: null });
  });

  it('restores each agent to where it was left, and never crosses them over', () => {
    setModelChoice({ provider: 'anthropic', model: 'sonnet', effort: 'xhigh' });
    setModelChoice({ provider: 'openai', model: 'gpt-5.4', effort: 'ultra' });

    // Each remembers its own. The crossing-over is the bug: `ultra` is codex
    // vocabulary and `sonnet` is not a codex model, so either one arriving on
    // the other agent would build a turn that fails on send.
    expect(rememberedChoiceFor('anthropic')).toEqual({
      provider: 'anthropic',
      model: 'sonnet',
      effort: 'xhigh',
    });
    expect(rememberedChoiceFor('openai')).toEqual({ provider: 'openai', model: 'gpt-5.4', effort: 'ultra' });
  });

  it('keeps the memory pure of whatever the active choice happens to be', () => {
    setModelChoice({ provider: 'anthropic', model: 'sonnet', effort: null });
    // Asked for the agent that has never been used: still nothing, rather than
    // the Claude row leaking across because it was the last thing written.
    expect(rememberedChoiceFor('openai')).toEqual({ provider: 'openai', model: null, effort: null });
  });
});
