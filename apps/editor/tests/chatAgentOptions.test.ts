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

  it('reads the id of one of the user own agents, and only a plausible one', () => {
    expect(parseAgentOptions({ agentId: 'my-agent' })).toEqual({ agentId: 'my-agent' });
    expect(parseAgentOptions({ provider: 'anthropic', agentId: 'my-agent' })).toEqual({
      provider: 'anthropic',
      agentId: 'my-agent',
    });
    // A shape the registry could never have minted is dropped, so nothing
    // downstream has to defend against a path or an injection in an id.
    expect(parseAgentOptions({ agentId: '../../etc/passwd' })).toBeNull();
    expect(parseAgentOptions({ agentId: 'Shouty Agent' })).toBeNull();
    expect(parseAgentOptions({ agentId: 7 })).toBeNull();
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

/** One of the user's own agents, from chatDrivers/custom.ts's point of view. */
class FakeCustomDriver implements ChatDriver {
  readonly kind = 'custom' as const;
  queue = new EventQueue<ChatEvent>();
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
let lastCustomOpts: { agent?: AgentTurnOptions | null; permissionMode?: unknown } | undefined;
/** What the custom seam does: a driver, nothing, or a refusal. */
let customBehaviour: 'driver' | 'none' | 'refuse';

function deps(): Parameters<typeof createChatDriver>[1] {
  return {
    loadAgentSdk: async () => fakeSdk,
    createCodexDriver: async (_root, opts) => {
      lastCodexOpts = opts;
      return codexAvailable ? new FakeCodexDriver() : null;
    },
    createCustomDriver: async (_root, opts) => {
      lastCustomOpts = opts;
      if (!opts?.agent?.agentId) return null;
      if (customBehaviour === 'refuse') throw new Error('That agent is not registered on this machine.');
      return customBehaviour === 'driver' ? new FakeCustomDriver() : null;
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
  lastCustomOpts = undefined;
  customBehaviour = 'driver';
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

  it('never asks the custom seam for a turn that named no agent', async () => {
    const driver = await createChatDriver(root, { ...deps(), agent: { provider: 'anthropic' } });
    expect(driver.kind).toBe('agent-sdk');
    expect(lastCustomOpts?.agent).toEqual({ provider: 'anthropic' });
  });

  it("binds one of the user's own agents AHEAD of both vendors", async () => {
    const driver = await createChatDriver(root, { ...deps(), agent: { provider: 'anthropic', agentId: 'my-agent' } });
    expect(driver.kind).toBe('custom');
  });

  it('hands the permission mode to it, the same one every other backend gets', async () => {
    await createChatDriver(root, { ...deps(), agent: { agentId: 'my-agent' }, permissionMode: 'skip' });
    expect(lastCustomOpts?.permissionMode).toBe('skip');
  });

  it('REPORTS a refusal rather than quietly answering as somebody else', async () => {
    // The rule this whole path exists for: a composer showing "My agent" while
    // Claude answers is the app lying about who is doing the work.
    customBehaviour = 'refuse';
    await expect(createChatDriver(root, { ...deps(), agent: { agentId: 'my-agent' } })).rejects.toThrow(
      /not registered/,
    );
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
