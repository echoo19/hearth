/**
 * The conversation backend: the push queue every driver emits through, the
 * always-available stub, per-folder key resolution, and the defensive mapping
 * from the Agent SDK's untyped message stream onto ChatEvents.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentSdkDriver,
  CLAUDE_RESUME_FAILED_NOTICE,
  commandLooksContained,
  isInsideRoot,
  sdkApprovalFor,
  sdkFileChange,
  sdkToolKind,
  EventQueue,
  SDK_EXITED_MESSAGE,
  STUB_REPLY,
  StubDriver,
  createChatDriver,
  describeToolInput,
  mapSdkMessage,
  readAppSettings,
  resolveApiKey,
  writeAppSettings,
  type ChatEvent,
} from '../server/chat';
import type { PermissionMode } from '../server/permissionMode';

/**
 * chat.ts bases the SDK driver's env on the login-shell PATH (shellEnv.ts),
 * the same seam the pty and codex paths use. Mocked so these tests never
 * spawn a real login shell, and so the merged PATH is a fact to assert on
 * rather than whatever the machine running the suite happens to have.
 */
vi.mock('../server/shellEnv', () => ({
  loginShellPathEnv: async (): Promise<NodeJS.ProcessEnv> => ({
    ...process.env,
    PATH: `/login-shell-bin:${process.env.PATH ?? ''}`,
  }),
}));

/**
 * A stand-in for the SDK's query stream that STAYS OPEN.
 *
 * The real one is long-lived: it is opened once and carries every turn of the
 * session. So a generator that yields its script and returns does not mean "no
 * more events", it means the backend exited, and the driver now ends the
 * conversation on it (see the pump in AgentSdkDriver). Anything exercising a
 * driver that is still in use has to keep the stream open, or it is testing a
 * dead agent.
 */
async function* liveStream(...events: unknown[]): AsyncGenerator<unknown> {
  yield* events;
  await new Promise<never>(() => {});
}

async function drain(source: AsyncIterable<ChatEvent>, until: number): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of source) {
    out.push(event);
    if (out.length >= until) break;
  }
  return out;
}

describe('EventQueue', () => {
  it('buffers values pushed before anyone iterates', async () => {
    const queue = new EventQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();
    const seen: number[] = [];
    for await (const value of queue) seen.push(value);
    expect(seen).toEqual([1, 2]);
  });

  it('wakes a waiting consumer with a later push', async () => {
    const queue = new EventQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    queue.push(7);
    expect(await pending).toEqual({ value: 7, done: false });
  });

  it('ends the iteration on close and ignores pushes after it', async () => {
    const queue = new EventQueue<number>();
    queue.close();
    queue.push(1);
    const iterator = queue[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(true);
  });
});

describe('StubDriver', () => {
  it('streams the guidance reply and ends the turn', async () => {
    const driver = new StubDriver();
    await driver.start('s1', '/tmp');
    driver.send('make a shooter');
    const lines = STUB_REPLY.split('\n').length;
    const events = await drain(driver.events, lines + 1);
    expect(events[events.length - 1]).toEqual({ type: 'turn-complete' });
    const text = events
      .filter((e): e is { type: 'message-delta'; text: string } => e.type === 'message-delta')
      .map((e) => e.text)
      .join('');
    expect(text).toContain('Sign in to Claude Code');
    expect(text).toContain('API key');
    expect(text).toContain('terminal');
    driver.stop();
  });

  it('goes quiet after stop', async () => {
    const driver = new StubDriver();
    driver.stop();
    driver.send('anything');
    const iterator = driver.events[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(true);
  });
});

describe('per-folder settings', () => {
  let dir: string;
  const previousKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-chat-'));
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  });

  it('reports no settings for a folder that has none', async () => {
    expect(await readAppSettings(dir)).toEqual({});
    expect(await resolveApiKey(dir)).toBeNull();
  });

  it('round-trips a key through .hearth/app.json', async () => {
    await writeAppSettings(dir, { apiKey: 'sk-test' });
    expect(await readAppSettings(dir)).toEqual({ apiKey: 'sk-test' });
    expect(await resolveApiKey(dir)).toBe('sk-test');
    const raw = await fsp.readFile(path.join(dir, '.hearth', 'app.json'), 'utf8');
    expect(JSON.parse(raw).apiKey).toBe('sk-test');
  });

  it('guards the key file with a .gitignore that travels with the folder', async () => {
    await writeAppSettings(dir, { apiKey: 'sk-test' });
    const ignore = await fsp.readFile(path.join(dir, '.hearth', '.gitignore'), 'utf8');
    expect(ignore.split(/\r?\n/)).toContain('app.json');
    // Idempotent, and an existing .gitignore keeps its own lines.
    await fsp.writeFile(path.join(dir, '.hearth', '.gitignore'), 'evidence/\n');
    await writeAppSettings(dir, { apiKey: 'sk-test-2' });
    const merged = await fsp.readFile(path.join(dir, '.hearth', '.gitignore'), 'utf8');
    expect(merged.split(/\r?\n/)).toContain('evidence/');
    expect(merged.split(/\r?\n/)).toContain('app.json');
    await writeAppSettings(dir, { apiKey: 'sk-test-3' });
    expect(await fsp.readFile(path.join(dir, '.hearth', '.gitignore'), 'utf8')).toBe(merged);
  });

  it('clears the key when saved empty rather than storing a blank', async () => {
    await writeAppSettings(dir, { apiKey: 'sk-test' });
    await writeAppSettings(dir, { apiKey: '   ' });
    expect(await readAppSettings(dir)).toEqual({});
  });

  it("prefers the folder's key over the environment", async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env';
    expect(await resolveApiKey(dir)).toBe('sk-env');
    await writeAppSettings(dir, { apiKey: 'sk-folder' });
    expect(await resolveApiKey(dir)).toBe('sk-folder');
  });

  // Driver selection is deliberately exercised through its seams: this
  // machine may well have a working codex install and a signed-in ChatGPT
  // account, and a test that asserted "no key means the stub" would pass or
  // fail depending on whose laptop it ran on.
  const noBackends = { loadAgentSdk: async () => null, createCodexDriver: async () => null };

  it('falls back to the stub when no backend is available at all', async () => {
    const driver = await createChatDriver(dir, noBackends);
    expect(driver.kind).toBe('stub');
    driver.stop();
  });

  it('uses the Anthropic backend when a key and the SDK are both present', async () => {
    await writeAppSettings(dir, { apiKey: 'sk-folder' });
    const driver = await createChatDriver(dir, {
      ...noBackends,
      loadAgentSdk: async () => ({ query: () => (async function* () {})() }),
    });
    expect(driver.kind).toBe('agent-sdk');
    driver.stop();
  });

  it('honours an explicit OpenAI preference over a usable Anthropic key', async () => {
    await writeAppSettings(dir, { apiKey: 'sk-folder', provider: 'openai' });
    const codex = new StubDriver();
    const driver = await createChatDriver(dir, {
      loadAgentSdk: async () => ({ query: () => (async function* () {})() }),
      createCodexDriver: async () => codex,
    });
    expect(driver).toBe(codex);
    driver.stop();
  });

  it('falls through to the other provider when the preferred one is unusable', async () => {
    await writeAppSettings(dir, { apiKey: 'sk-folder', provider: 'openai' });
    const driver = await createChatDriver(dir, {
      loadAgentSdk: async () => ({ query: () => (async function* () {})() }),
      createCodexDriver: async () => null, // signed out / not installed
    });
    expect(driver.kind).toBe('agent-sdk');
    driver.stop();
  });
});

describe('mapSdkMessage', () => {
  it('turns a partial content-block delta into text', () => {
    expect(
      mapSdkMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
      }),
    ).toEqual([{ type: 'message-delta', text: 'hi' }]);
  });

  it('turns a tool_use block into a tool-begin plus the file it changed', () => {
    expect(
      mapSdkMessage({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/w/game.js' } }] },
      }),
    ).toEqual([
      { type: 'tool-begin', toolId: 't1', kind: 'file-change', title: 'Write', detail: '/w/game.js' },
      { type: 'file-change', toolId: 't1', files: [{ path: '/w/game.js', kind: 'create' }] },
    ]);
  });

  it('titles a shell call with the command itself, so the row reads as what ran', () => {
    expect(
      mapSdkMessage({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] },
      }),
    ).toEqual([{ type: 'tool-begin', toolId: 't2', kind: 'command', title: 'npm test', detail: 'npm test' }]);
  });

  it('turns a Task call into a subagent rather than a tool row', () => {
    expect(
      mapSdkMessage({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'a1', name: 'Task', input: { subagent_type: 'Explore', description: 'Find the loop' } },
          ],
        },
      }),
    ).toEqual([{ type: 'subagent-start', agentId: 'a1', role: 'Explore', title: 'Find the loop' }]);
  });

  it('turns a tool_result into a tool-end carrying status', () => {
    expect(
      mapSdkMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }),
    ).toEqual([{ type: 'tool-end', toolId: 't1', status: 'ok', summary: undefined }]);
    expect(
      mapSdkMessage({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] },
      }),
    ).toEqual([{ type: 'tool-end', toolId: 't1', status: 'error', summary: undefined }]);
  });

  it('ends the turn on a result, and reports a failing one as an error', () => {
    expect(mapSdkMessage({ type: 'result' })).toEqual([{ type: 'turn-complete' }]);
    expect(mapSdkMessage({ type: 'result', is_error: true, result: 'rate limited' })).toEqual([
      { type: 'error', message: 'rate limited' },
    ]);
  });

  it('yields nothing (rather than throwing) on a shape it does not know', () => {
    expect(mapSdkMessage(null)).toEqual([]);
    expect(mapSdkMessage({ type: 'assistant' })).toEqual([]);
    expect(mapSdkMessage({ type: 'stream_event', event: { type: 'ping' } })).toEqual([]);
    expect(mapSdkMessage('nonsense')).toEqual([]);
  });
});

describe('describeToolInput', () => {
  it('prefers the field a person would recognise', () => {
    expect(describeToolInput({ file_path: '/w/a.js', other: 1 })).toBe('/w/a.js');
    expect(describeToolInput({ command: 'npm test' })).toBe('npm test');
  });

  it('says nothing when there is nothing readable', () => {
    expect(describeToolInput({ depth: 3 })).toBeUndefined();
    expect(describeToolInput(null)).toBeUndefined();
  });

  it('truncates a very long value rather than flooding the chip', () => {
    const detail = describeToolInput({ command: 'x'.repeat(400) })!;
    expect(detail.length).toBeLessThanOrEqual(160);
    expect(detail.endsWith('…')).toBe(true);
  });
});

describe('AgentSdkDriver', () => {
  /**
   * A turn must never overtake the one before it.
   *
   * Attachments have to be read off disk before the turn can be built, so a
   * plain message sent while that read is in flight used to be queued FIRST —
   * the agent answered the follow-up with no pictures in context, then found
   * pictures attached to nothing.
   */
  it('keeps turns in the order they were sent, even while a slow one is read', async () => {
    const prompts: unknown[] = [];
    const sdk = {
      query: (args: unknown) => {
        const stream = (args as { prompt: AsyncIterable<unknown> }).prompt;
        void (async () => {
          for await (const turn of stream) prompts.push(turn);
        })();
        return liveStream(); // no events needed: this is about input order
      },
    };
    const driver = new AgentSdkDriver(sdk, 'sk-test');
    await driver.start('s1', '/w/game');

    const attachment = {
      name: 'shot.png',
      mimeType: 'image/png',
      path: '/w/game/shot.png',
      relPath: 'shot.png',
      bytes: 3,
    };
    driver.send('FIRST, with a picture', undefined, [attachment]);
    driver.send('SECOND, plain');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const texts = prompts.map((turn) => {
      const content = (turn as { message: { content: unknown } }).message.content;
      return typeof content === 'string'
        ? content
        : (content as { type: string; text?: string }[]).map((block) => block.text ?? block.type).join('|');
    });
    expect(texts[0]).toContain('FIRST');
    expect(texts[1]).toContain('SECOND');
    driver.stop();
  });

  it('maps a scripted SDK stream onto chat events, cwd-bound to the folder', async () => {
    let options: Record<string, unknown> = {};
    const sdk = {
      query: (args: unknown) => {
        options = ((args as Record<string, unknown>).options ?? {}) as Record<string, unknown>;
        return (async function* () {
          yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } } };
          yield { type: 'result' };
        })();
      },
    };
    const driver = new AgentSdkDriver(sdk, 'sk-test');
    await driver.start('s1', '/w/game');
    const events = await drain(driver.events, 2);
    expect(events).toEqual([{ type: 'message-delta', text: 'ok' }, { type: 'turn-complete' }]);
    expect(options.cwd).toBe('/w/game');
    expect(options.permissionMode).toBe('acceptEdits');
    driver.stop();
  });

  /**
   * The SDK's generator RETURNS as readily as it throws: its subprocess exiting
   * (which is what an auth failure the SDK handles internally looks like from
   * out here) ends the stream with no error at all.
   *
   * That used to push nothing and close nothing, so ws.ts's drain sat on
   * `queue.next()` forever: the session was never cleaned up, the window span
   * on a turn that was not coming, and every message typed afterwards went into
   * `this.turns` with nothing on the other end. The driver has to say it is
   * finished, and it has to END, which is the only signal ws.ts gets.
   */
  it('ends the conversation when the SDK stream returns without an error', async () => {
    const sdk = { query: () => (async function* () {})() };
    const driver = new AgentSdkDriver(sdk, 'sk-test');
    await driver.start('s1', '/w/game');

    const seen: ChatEvent[] = [];
    for await (const event of driver.events) seen.push(event);
    expect(seen).toEqual([{ type: 'error', message: SDK_EXITED_MESSAGE }]);
    // Ended, not just quiet: ws.ts refuses to hand a turn to a driver that
    // reads dead, so a later message binds a fresh backend instead of
    // disappearing into this one.
    expect(driver.dead).toBe(true);
  });

  it('reads dead after a thrown backend failure too, and stops accepting turns', async () => {
    const turns: unknown[] = [];
    const sdk = {
      query: (args: unknown) => {
        void (async () => {
          for await (const turn of (args as { prompt: AsyncIterable<unknown> }).prompt) turns.push(turn);
        })();
        return (async function* (): AsyncGenerator<unknown> {
          throw new Error('backend exploded');
        })();
      },
    };
    const driver = new AgentSdkDriver(sdk, 'sk-test');
    await driver.start('s1', '/w/game');
    await drain(driver.events, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(driver.dead).toBe(true);
    driver.send('anyone there?');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(turns).toEqual([]);
  });

  it('reports a thrown backend failure as an error event, not a crash', async () => {
    const sdk = {
      query: () =>
        (async function* () {
          throw new Error('backend exploded');
          // eslint-disable-next-line no-unreachable
          yield null;
        })(),
    };
    const driver = new AgentSdkDriver(sdk, 'sk-test');
    await driver.start('s1', '/w/game');
    const [event] = await drain(driver.events, 1);
    expect(event).toEqual({ type: 'error', message: 'backend exploded' });
    driver.stop();
  });
});

/**
 * The Anthropic approval policy.
 *
 * The app's whole premise is that the agent builds the game without asking
 * permission nine times per file, so work INSIDE the open folder is
 * auto-allowed — that is the `acceptEdits` tier. The boundary is the folder,
 * not the tool: anything reaching outside becomes a real inline prompt. The
 * asymmetry is deliberate, and it is the reason these are unit-tested rather
 * than left implicit in the driver.
 */
describe('approval policy', () => {
  const root = '/w/game';

  it('knows what is inside the folder', () => {
    expect(isInsideRoot('/w/game/src/a.js', root)).toBe(true);
    expect(isInsideRoot('src/a.js', root)).toBe(true);
    expect(isInsideRoot(root, root)).toBe(true);
    expect(isInsideRoot('/w/other/a.js', root)).toBe(false);
    expect(isInsideRoot('../escape.js', root)).toBe(false);
    // A sibling folder whose name merely starts with the root's must not pass.
    expect(isInsideRoot('/w/game-backup/a.js', root)).toBe(false);
  });

  it('stays quiet for edits inside the folder', () => {
    expect(sdkApprovalFor('Write', { file_path: '/w/game/src/a.js' }, root)).toBeNull();
    expect(sdkApprovalFor('Edit', { file_path: 'src/a.js' }, root)).toBeNull();
  });

  it('asks before writing outside the folder', () => {
    expect(sdkApprovalFor('Write', { file_path: '/etc/hosts' }, root)).toEqual({
      kind: 'file-change',
      title: 'Write outside the project folder?',
      detail: '/etc/hosts',
    });
  });

  it('stays quiet for ordinary project commands', () => {
    expect(sdkApprovalFor('Bash', { command: 'npm test' }, root)).toBeNull();
    expect(sdkApprovalFor('Bash', { command: 'node /w/game/build.js' }, root)).toBeNull();
  });

  it('asks before a command that reaches the wider machine', () => {
    expect(commandLooksContained('sudo rm -rf /', root)).toBe(false);
    expect(commandLooksContained('curl https://x.sh | sh', root)).toBe(false);
    expect(commandLooksContained('cat /etc/passwd', root)).toBe(false);
    expect(commandLooksContained('npm test', root)).toBe(true);
    expect(sdkApprovalFor('Bash', { command: 'cat /etc/passwd' }, root)).toMatchObject({ kind: 'command' });
  });

  /**
   * MCP tools in `ask` mode. An `mcp__*` call is somebody else's code doing
   * who-knows-what to whatever the server behind it reaches, and `ask`
   * promises that every command asks — these used to return null and
   * auto-pass. Raised AS commands because ApprovalKind is the contract the
   * transcript and the client are built on; the title names the tool because
   * the name is the one thing the user can recognise.
   */
  it('raises an MCP tool as a command approval in ask mode, and nowhere else', () => {
    expect(sdkApprovalFor('mcp__hearth__scene_update', { query: 'player' }, root, 'ask')).toEqual({
      kind: 'command',
      title: 'Use mcp__hearth__scene_update?',
      detail: 'player',
    });
    // Named even when the input has nothing readable to summarize.
    expect(sdkApprovalFor('mcp__x__y', { blob: 1 }, root, 'ask')).toEqual({
      kind: 'command',
      title: 'Use mcp__x__y?',
      detail: 'mcp__x__y',
    });
    // `auto` (the default) keeps its long-standing behaviour: MCP servers are
    // things the user wired up on purpose, and Hearth's own tools arrive this
    // way. `skip` stays silent, as it promises to.
    expect(sdkApprovalFor('mcp__hearth__scene_update', {}, root, 'auto')).toBeNull();
    expect(sdkApprovalFor('mcp__hearth__scene_update', {}, root)).toBeNull();
    expect(sdkApprovalFor('mcp__hearth__scene_update', {}, root, 'skip')).toBeNull();
  });

  it('classifies tools onto the provider-agnostic kinds', () => {
    expect(sdkToolKind('Bash')).toBe('command');
    expect(sdkToolKind('Edit')).toBe('file-change');
    expect(sdkToolKind('mcp__hearth__scene_list')).toBe('mcp');
    expect(sdkToolKind('WebSearch')).toBe('web-search');
    expect(sdkToolKind('Read')).toBe('other');
  });

  it('builds a file change, with a diff when the SDK gave it both sides', () => {
    expect(sdkFileChange('Write', { file_path: '/a.js' })).toEqual({ path: '/a.js', kind: 'create' });
    expect(sdkFileChange('Edit', { file_path: '/a.js', old_string: 'a', new_string: 'b' })).toEqual({
      path: '/a.js',
      kind: 'edit',
      diff: '-a\n+b',
    });
    expect(sdkFileChange('Bash', { command: 'ls' })).toBeNull();
  });
});

describe('AgentSdkDriver approvals', () => {
  /** Capture the `canUseTool` callback, and the options, the driver hands the SDK. */
  function driverWithPermission(mode?: PermissionMode): {
    driver: AgentSdkDriver;
    ask: (tool: string, input: unknown) => Promise<unknown>;
    options: () => Record<string, unknown>;
  } {
    let canUseTool: ((tool: string, input: unknown) => Promise<unknown>) | null = null;
    let captured: Record<string, unknown> = {};
    const sdk = {
      query: (args: unknown) => {
        const options = (args as { options: Record<string, unknown> }).options;
        captured = options;
        canUseTool = options.canUseTool as typeof canUseTool;
        return liveStream();
      },
    };
    const driver = new AgentSdkDriver(sdk, 'sk-test', null, null, mode);
    return { driver, ask: (tool, input) => canUseTool!(tool, input), options: () => captured };
  }

  /**
   * The SDK's own switch and Hearth's approval callback are two levers on the
   * same decision, and a build where they disagree is worse than either one
   * being wrong: the transcript would show approvals for work the SDK had
   * already waved through, or none for work it was asking about.
   */
  it('sets the SDK’s permissionMode from the project’s mode, and the callback to match', async () => {
    for (const [mode, expected] of [
      ['ask', 'default'],
      ['auto', 'acceptEdits'],
      ['skip', 'bypassPermissions'],
    ] as const) {
      const { driver, options } = driverWithPermission(mode);
      await driver.start('s1', '/w/game');
      expect(options().permissionMode).toBe(expected);
      driver.stop();
    }
  });

  it('asks about work inside the folder in ask mode, and about nothing in skip', async () => {
    const asking = driverWithPermission('ask');
    await asking.driver.start('s1', '/w/game');
    const iterator = asking.driver.events[Symbol.asyncIterator]();
    void asking.ask('Write', { file_path: '/w/game/a.js' });
    expect((await iterator.next()).value).toMatchObject({ type: 'approval-request', kind: 'file-change' });
    asking.driver.stop();

    const skipping = driverWithPermission('skip');
    await skipping.driver.start('s1', '/w/game');
    expect(await skipping.ask('Bash', { command: 'sudo rm -rf /' })).toMatchObject({ behavior: 'allow' });
    skipping.driver.stop();
  });

  it('auto-allows work inside the folder without troubling the user', async () => {
    const { driver, ask } = driverWithPermission();
    await driver.start('s1', '/w/game');
    expect(await ask('Write', { file_path: '/w/game/a.js' })).toMatchObject({ behavior: 'allow' });
    driver.stop();
  });

  it('raises an inline approval and BLOCKS until it is answered', async () => {
    const { driver, ask } = driverWithPermission();
    await driver.start('s1', '/w/game');

    const iterator = driver.events[Symbol.asyncIterator]();
    const decision = ask('Write', { file_path: '/etc/hosts' });
    const request = (await iterator.next()).value as { type: string; approvalId: string };
    expect(request.type).toBe('approval-request');

    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false); // the agent really is waiting

    driver.approve(request.approvalId, 'allow');
    expect(await decision).toMatchObject({ behavior: 'allow' });
    expect((await iterator.next()).value).toEqual({
      type: 'approval-resolved',
      approvalId: request.approvalId,
      decision: 'allow',
    });
    driver.stop();
  });

  it('denies with a message the agent can read', async () => {
    const { driver, ask } = driverWithPermission();
    await driver.start('s1', '/w/game');
    const iterator = driver.events[Symbol.asyncIterator]();
    const decision = ask('Bash', { command: 'sudo reboot' });
    const request = (await iterator.next()).value as { approvalId: string };
    driver.approve(request.approvalId, 'deny');
    expect(await decision).toMatchObject({ behavior: 'deny' });
    driver.stop();
  });

  it('withdraws anything still pending on stop — the SDK unblocks, and no Deny is forged', async () => {
    const { driver, ask } = driverWithPermission();
    await driver.start('s1', '/w/game');
    const iterator = driver.events[Symbol.asyncIterator]();
    const decision = ask('Bash', { command: 'sudo reboot' });
    const request = (await iterator.next()).value as { approvalId: string };
    driver.stop();
    // The SDK-side promise still resolves as a deny: nothing may run on a
    // question nobody answered.
    expect(await decision).toMatchObject({ behavior: 'deny' });
    // But the transcript says what actually happened — the session ended
    // under the question. A `deny` here would forge a decision: reread later
    // it claims the user refused something they never answered.
    expect((await iterator.next()).value).toEqual({
      type: 'approval-resolved',
      approvalId: request.approvalId,
      decision: 'withdrawn',
    });
  });

  it('closes a Task as a subagent rather than as a tool row', async () => {
    const sdk = {
      query: () =>
        (async function* () {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'tool_use', id: 'a1', name: 'Task', input: { subagent_type: 'Explore' } }] },
          };
          yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a1' }] } };
        })(),
    };
    const driver = new AgentSdkDriver(sdk, 'sk-test');
    await driver.start('s1', '/w/game');
    const events = await drain(driver.events, 2);
    expect(events[0]).toMatchObject({ type: 'subagent-start', agentId: 'a1', role: 'Explore' });
    expect(events[1]).toMatchObject({ type: 'subagent-end', agentId: 'a1', status: 'ok' });
    driver.stop();
  });
});

/**
 * Stop on a Claude chat used to be a demolition: the driver had no interrupt,
 * so ws.ts tore the whole backend down and the next send handed a fresh agent
 * a transcript to read. The SDK's query has its own `interrupt()` control
 * request (sdk.d.ts) — the turn ends, the stream stays open, and the session
 * keeps its memory.
 */
describe('AgentSdkDriver interrupt', () => {
  it('ends the turn through the SDK and keeps the session alive', async () => {
    let interrupts = 0;
    const sdk = {
      query: () =>
        Object.assign(liveStream(), {
          interrupt: async () => {
            interrupts += 1;
          },
        }),
    };
    const driver = new AgentSdkDriver(sdk, 'sk-test');
    await driver.start('s1', '/w/game');
    driver.interrupt();
    expect(interrupts).toBe(1);
    // Alive, deliberately: the next send continues THIS conversation.
    expect(driver.dead).toBe(false);
    driver.stop();
  });

  it('withdraws a blocking approval when the turn it belongs to is interrupted', async () => {
    let canUseTool: ((tool: string, input: unknown) => Promise<unknown>) | null = null;
    const sdk = {
      query: (args: unknown) => {
        canUseTool = (args as { options: Record<string, unknown> }).options.canUseTool as typeof canUseTool;
        return Object.assign(liveStream(), { interrupt: async () => undefined });
      },
    };
    const driver = new AgentSdkDriver(sdk, 'sk-test');
    await driver.start('s1', '/w/game');
    const iterator = driver.events[Symbol.asyncIterator]();
    const decision = canUseTool!('Bash', { command: 'sudo reboot' });
    const request = (await iterator.next()).value as { approvalId: string };
    driver.interrupt();
    // Unblocked (the SDK's own abort waits on this callback), and recorded as
    // a withdrawal — the person pressed Stop, not Deny.
    expect(await decision).toMatchObject({ behavior: 'deny' });
    expect((await iterator.next()).value).toEqual({
      type: 'approval-resolved',
      approvalId: request.approvalId,
      decision: 'withdrawn',
    });
    expect(driver.dead).toBe(false);
    driver.stop();
  });

  it('falls back to the coarse teardown when the SDK has no interrupt', async () => {
    const sdk = { query: () => liveStream() };
    const driver = new AgentSdkDriver(sdk, 'sk-test');
    await driver.start('s1', '/w/game');
    const iterator = driver.events[Symbol.asyncIterator]();
    driver.interrupt();
    // The turn is reported over, THEN the stream ends — the same shape as
    // ws.ts's own fallback, so a window never spins on a turn nobody will end.
    expect((await iterator.next()).value).toEqual({ type: 'turn-complete' });
    expect((await iterator.next()).done).toBe(true);
    expect(driver.dead).toBe(true);
  });
});

/**
 * The Claude session a conversation resumes. The SDK's CLI persists every
 * session and `query({options: {resume}})` reloads one (sdk.d.ts), which is
 * what keeps a reopened chat's agent from having amnesia about a transcript
 * the window still shows in full.
 */
describe('AgentSdkDriver session resume', () => {
  it('passes the remembered session to the SDK, and no resume when there is none', async () => {
    const captured: Record<string, unknown>[] = [];
    const sdk = {
      query: (args: unknown) => {
        captured.push((args as { options: Record<string, unknown> }).options);
        return liveStream();
      },
    };
    const resumed = new AgentSdkDriver(sdk, 'sk-test', null, null, undefined, 'sess-1');
    await resumed.start('s1', '/w/game');
    expect(captured[0].resume).toBe('sess-1');
    resumed.stop();

    // A fresh conversation must carry NO resume key at all: an empty or null
    // one is not the same as none to a CLI that validates its options.
    const fresh = new AgentSdkDriver(sdk, 'sk-test');
    await fresh.start('s2', '/w/game');
    expect('resume' in captured[1]).toBe(false);
    fresh.stop();
  });

  it('persists the session id the init message names — and only a changed one', async () => {
    const init = { type: 'system', subtype: 'init', session_id: 'sess-2' };
    const sdk = { query: () => liveStream(init) };

    const seen: string[] = [];
    const driver = new AgentSdkDriver(sdk, 'sk-test', null, null, undefined, null, (id) => seen.push(id));
    await driver.start('s1', '/w/game');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual(['sess-2']);
    driver.stop();

    // A successful resume echoes the id it was asked for; re-persisting it on
    // every bind would rewrite the chat index for nothing.
    const echoed: string[] = [];
    const resumed = new AgentSdkDriver(sdk, 'sk-test', null, null, undefined, 'sess-2', (id) => echoed.push(id));
    await resumed.start('s1', '/w/game');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(echoed).toEqual([]);
    resumed.stop();
  });

  it('falls back to a fresh session when the resume fails, keeping the queued turn', async () => {
    const attempts: (string | undefined)[] = [];
    const delivered: unknown[] = [];
    const sdk = {
      query: (args: unknown) => {
        const { prompt, options } = args as { prompt: AsyncIterable<unknown>; options: Record<string, unknown> };
        attempts.push(options.resume as string | undefined);
        if (attempts.length === 1) {
          // What a refused resume looks like from out here: the subprocess
          // exits before ever sending its init message.
          return (async function* (): AsyncGenerator<unknown> {
            throw new Error('No conversation found with session ID: stale');
          })();
        }
        void (async () => {
          for await (const turn of prompt) delivered.push(turn);
        })();
        return liveStream();
      },
    };
    const driver = new AgentSdkDriver(sdk, 'sk-test', null, null, undefined, 'stale');
    await driver.start('s1', '/w/game');
    driver.send('hello again');
    // Said out loud: the transcript still reads as one conversation, and an
    // agent that silently lost its memory of it reads as one lying about it.
    const [notice] = await drain(driver.events, 1);
    expect(notice).toEqual({ type: 'notice', text: CLAUDE_RESUME_FAILED_NOTICE });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // One retry, fresh — and the conversation is alive, not stranded.
    expect(attempts).toEqual(['stale', undefined]);
    expect(driver.dead).toBe(false);
    // The message typed while the first attempt was dying reaches the second.
    expect(delivered).toHaveLength(1);
    driver.stop();
  });
});

/**
 * The env the agent's own Bash runs in. A Finder-launched packaged app
 * inherits the minimal system PATH, so basing the driver env on raw
 * process.env made node/npm/git installed via nvm or homebrew invisible to
 * the agent — while the embedded terminal, which merges the login-shell PATH,
 * found them fine. Same seam, same fix (shellEnv.ts, mocked above).
 */
describe('AgentSdkDriver environment', () => {
  it('bases the agent env on the login-shell PATH, with the shim dir first', async () => {
    let options: Record<string, unknown> = {};
    const sdk = {
      query: (args: unknown) => {
        options = (args as { options: Record<string, unknown> }).options;
        return liveStream();
      },
    };
    const driver = new AgentSdkDriver(sdk, 'sk-test', null, { shimDir: '/shim', probeCli: false });
    await driver.start('s1', '/w/game');
    const env = options.env as NodeJS.ProcessEnv;
    expect(env.PATH!.startsWith('/shim')).toBe(true); // hearth tools still win
    expect(env.PATH).toContain('/login-shell-bin'); // the user's real PATH rides along
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test'); // the key rule is untouched
    driver.stop();
  });
});
