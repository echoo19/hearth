/**
 * The per-turn agent choice: `agent: { provider, model, effort }` on a
 * chat-send frame.
 *
 * Two properties matter more than the plumbing:
 *
 *  1. **A frame without `agent` must behave exactly as it did before.** The
 *     field is additive, and an older client (or a renderer mid-update) sends
 *     nothing at all.
 *  2. **The turn's provider outranks the stored preference**, because the
 *     composer shows the user which model they picked — but only when that
 *     provider can actually answer, so a stale pick falls through instead of
 *     failing the conversation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentSdkDriver,
  EventQueue,
  createChatDriver,
  parseAgentOptions,
  writeAppSettings,
  type AgentTurnOptions,
  type ChatDriver,
  type ChatEvent,
} from '../server/chat';
import { openAiModels, ANTHROPIC_MODELS, OPENAI_FALLBACK_MODELS } from '../server/chatProviders';
import type { CodexStatus } from '../server/chatDrivers/codex';

describe('parseAgentOptions', () => {
  it('reads a full choice', () => {
    expect(parseAgentOptions({ provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' })).toEqual({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
  });

  it('treats a missing or empty field as "no choice"', () => {
    expect(parseAgentOptions(undefined)).toBeNull();
    expect(parseAgentOptions(null)).toBeNull();
    expect(parseAgentOptions({})).toBeNull();
    // model:null is the wire spelling of "the provider's default", which is
    // not a model choice.
    expect(parseAgentOptions({ model: null, effort: null })).toBeNull();
    expect(parseAgentOptions({ model: '   ' })).toBeNull();
  });

  it('drops values it does not recognise rather than failing the turn', () => {
    expect(parseAgentOptions({ provider: 'deepmind', model: 'claude-opus-5' })).toEqual({ model: 'claude-opus-5' });
    // Effort is NOT a closed set. A live `model/list` reports low, medium,
    // high, xhigh, max and ultra, with different per-model defaults, so a
    // hardcoded three-way union silently dropped the rest. The shape is still
    // checked — `effort: 9` below is still refused — but an unfamiliar WORD is
    // the binary's business, not ours.
    expect(parseAgentOptions({ effort: 'extreme' })).toEqual({ effort: 'extreme' });
    expect(parseAgentOptions({ model: 42 })).toBeNull();
    expect(parseAgentOptions('opus')).toBeNull();
    expect(parseAgentOptions(['opus'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Driver selection
// ---------------------------------------------------------------------------

class FakeCodexDriver implements ChatDriver {
  readonly kind = 'codex' as const;
  queue = new EventQueue<ChatEvent>();
  boundAgent: AgentTurnOptions | null = null;
  get events(): AsyncIterable<ChatEvent> {
    return this.queue;
  }
  async start(): Promise<void> {}
  send(): void {}
  stop(): void {
    this.queue.close();
  }
}

const fakeSdk = { query: () => new EventQueue<unknown>() };

let tmp: string;
let root: string;
let codexAvailable: boolean;
let lastCodexOpts: { agent?: AgentTurnOptions | null } | undefined;

function deps(): Parameters<typeof createChatDriver>[1] {
  return {
    loadAgentSdk: async () => fakeSdk,
    createCodexDriver: async (_root, opts) => {
      lastCodexOpts = opts;
      return codexAvailable ? new FakeCodexDriver() : null;
    },
  };
}

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-agentopts-'));
  root = path.join(tmp, 'game');
  await fsp.mkdir(root, { recursive: true });
  await writeAppSettings(root, { apiKey: 'sk-test' });
  codexAvailable = true;
  lastCodexOpts = undefined;
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('createChatDriver with a turn choice', () => {
  it('binds anthropic when nothing is chosen, exactly as before', async () => {
    const driver = await createChatDriver(root, deps());
    expect(driver.kind).toBe('agent-sdk');
  });

  it("honours the stored preference when the turn doesn't express one", async () => {
    await writeAppSettings(root, { provider: 'openai' });
    const driver = await createChatDriver(root, deps());
    expect(driver.kind).toBe('codex');
  });

  it('lets the turn override the stored preference', async () => {
    await writeAppSettings(root, { provider: 'openai' });
    const driver = await createChatDriver(root, { ...deps(), agent: { provider: 'anthropic', model: 'claude-opus-5' } });
    expect(driver.kind).toBe('agent-sdk');
  });

  it('falls through when the chosen provider cannot answer', async () => {
    codexAvailable = false;
    const driver = await createChatDriver(root, { ...deps(), agent: { provider: 'openai', model: 'gpt-5.6-sol' } });
    expect(driver.kind).toBe('agent-sdk');
  });

  it('hands the choice to the codex driver so it can apply it to the first turn', async () => {
    const agent: AgentTurnOptions = { provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' };
    await createChatDriver(root, { ...deps(), agent });
    expect(lastCodexOpts?.agent).toEqual(agent);
  });

  it('gives the SDK driver the model, and never a model meant for the other vendor', async () => {
    const chosen = await createChatDriver(root, { ...deps(), agent: { provider: 'anthropic', model: 'claude-opus-5' } });
    expect((chosen as AgentSdkDriver as unknown as { model: string | null }).model).toBe('claude-opus-5');

    codexAvailable = false;
    const crossed = await createChatDriver(root, { ...deps(), agent: { provider: 'openai', model: 'gpt-5.6-sol' } });
    expect((crossed as AgentSdkDriver as unknown as { model: string | null }).model).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The effort actually reaching the Agent SDK
// ---------------------------------------------------------------------------

/**
 * A query handle that records the control requests made on it and never ends.
 *
 * The real stream is long-lived and carries every turn of the session, so the
 * iterator here parks forever rather than returning — a handle that ends is a
 * dead backend, and the driver would stop accepting turns.
 */
function flagRecordingSdk(applyFlagSettings?: (settings: { effortLevel: string | null }) => Promise<unknown>) {
  const applied: { effortLevel: string | null }[] = [];
  const turns: unknown[] = [];
  const sdk = {
    query: (args: unknown) => {
      void (async () => {
        for await (const turn of (args as { prompt: AsyncIterable<unknown> }).prompt) turns.push(turn);
      })();
      return {
        ...(applyFlagSettings
          ? { applyFlagSettings }
          : {
              applyFlagSettings: async (settings: { effortLevel: string | null }) => {
                applied.push(settings);
              },
            }),
        [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}) }),
      };
    },
  };
  return { sdk, applied, turns };
}

/** The sends chain is async; let it settle before reading what it did. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('AgentSdkDriver effort', () => {
  it('puts the chosen effort on the session before the turn goes out', async () => {
    // The model is fixed when the stream opens, but the effort is not:
    // `applyFlagSettings` merges into a settings layer on the live query, which
    // is the SDK's own answer to changing it mid-session. Before this, an
    // effort the composer sent was parsed and then dropped on the floor.
    const { sdk, applied, turns } = flagRecordingSdk();
    const driver = new AgentSdkDriver(sdk, 'sk-test');
    await driver.start('s1', '/w/game');
    driver.send('think hard', { effort: 'xhigh' });
    await settle();
    expect(applied).toEqual([{ effortLevel: 'xhigh' }]);
    expect(turns).toHaveLength(1);
    driver.stop();
  });

  it('drops an effort the SDK would refuse rather than failing the turn', async () => {
    // `ultra` is codex's, and a choice made there can survive a switch to
    // Claude. Sending it would fail the turn on a word the user never saw as
    // invalid; the turn still runs, at whatever effort the session already had.
    const { sdk, applied, turns } = flagRecordingSdk();
    const driver = new AgentSdkDriver(sdk, 'sk-test');
    await driver.start('s1', '/w/game');
    driver.send('go', { effort: 'ultra' });
    driver.send('go again', { effort: 'DEFCON-1' });
    await settle();
    expect(applied).toEqual([]);
    expect(turns).toHaveLength(2);
    driver.stop();
  });

  it('clears the effort when a later turn expresses none', async () => {
    // The flag layer outlives the turn. Without the explicit null, an effort
    // chosen once quietly applied to the rest of the conversation — and
    // `undefined` would not do it, since JSON serialization drops it.
    const { sdk, applied } = flagRecordingSdk();
    const driver = new AgentSdkDriver(sdk, 'sk-test');
    await driver.start('s1', '/w/game');
    driver.send('deep one', { effort: 'high' });
    await settle();
    driver.send('ordinary one');
    await settle();
    expect(applied).toEqual([{ effortLevel: 'high' }, { effortLevel: null }]);
    driver.stop();
  });

  it('says nothing when nothing changed', async () => {
    // A control request per turn for a dial nobody moved is a round trip the
    // turn waits on for no reason.
    const { sdk, applied } = flagRecordingSdk();
    const driver = new AgentSdkDriver(sdk, 'sk-test');
    await driver.start('s1', '/w/game');
    driver.send('one', { effort: 'low' });
    driver.send('two', { effort: 'low' });
    driver.send('three');
    driver.send('four');
    await settle();
    expect(applied).toEqual([{ effortLevel: 'low' }, { effortLevel: null }]);
    driver.stop();
  });

  it('still sends the message when the control request fails', async () => {
    // An older SDK has no `applyFlagSettings` at all, and a live one can refuse
    // the request. Either way the message must go: a turn lost to a dial is a
    // far worse outcome than a turn that runs at the default effort.
    const failing = flagRecordingSdk(async () => {
      throw new Error('control request failed');
    });
    const driver = new AgentSdkDriver(failing.sdk, 'sk-test');
    await driver.start('s1', '/w/game');
    driver.send('hello', { effort: 'max' });
    await settle();
    expect(failing.turns).toHaveLength(1);

    const olderTurns: unknown[] = [];
    const older = {
      query: (args: unknown) => {
        void (async () => {
          for await (const turn of (args as { prompt: AsyncIterable<unknown> }).prompt) olderTurns.push(turn);
        })();
        return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}) }) };
      },
    };
    const legacy = new AgentSdkDriver(older, 'sk-test');
    await legacy.start('s1', '/w/game');
    legacy.send('hello', { effort: 'max' });
    await settle();
    expect(olderTurns).toHaveLength(1);
    driver.stop();
    legacy.stop();
  });
});

// ---------------------------------------------------------------------------
// The curated model lists the selector renders
// ---------------------------------------------------------------------------

function codexStatus(over: Partial<CodexStatus> = {}): CodexStatus {
  return {
    installed: true,
    version: 'codex-cli 0.144.5',
    loggedIn: true,
    authMode: 'chatgpt',
    email: null,
    planType: null,
    hasKey: false,
    ...over,
  };
}

describe('provider model lists', () => {
  it('offers the three curated Anthropic models', () => {
    expect(ANTHROPIC_MODELS.map((m) => m.id)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
    ]);
    expect(ANTHROPIC_MODELS.map((m) => m.label)).toEqual(['Opus 5', 'Sonnet 5', 'Haiku 4.5']);
  });

  it('leads the OpenAI list with Default and then whatever the binary reported', () => {
    const models = openAiModels(codexStatus({ models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', note: 'Default' }] }));
    expect(models[0]).toEqual({ id: '', label: 'Default' });
    expect(models[1]).toEqual({ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', note: 'Default' });
  });

  it('falls back to Default alone when codex could not be asked', () => {
    expect(openAiModels(codexStatus({ installed: false, loggedIn: false }))).toEqual(OPENAI_FALLBACK_MODELS);
    expect(openAiModels(codexStatus({ models: [] }))).toEqual(OPENAI_FALLBACK_MODELS);
  });
});
