/**
 * CodexDriver against a scripted app-server.
 *
 * The fake below speaks the real newline-delimited JSON-RPC over an in-memory
 * pipe, so the driver runs its REAL handshake, its real request correlation
 * and its real approval bookkeeping — there is no codex install, no
 * subprocess and no network involved, and nothing about the protocol is
 * stubbed out except the bytes' origin.
 *
 * What matters most here is the approval path: a codex approval is a
 * server->client REQUEST that PAUSES the turn, so the driver must always
 * answer it — with the user's decision when there is one, and with a denial
 * when there cannot be. An unanswered approval hangs the agent forever, which
 * is the failure this file exists to prevent.
 */
import { describe, expect, it } from 'vitest';
import { CodexDriver, codexSlashCommands, type CodexTransport } from '../server/chatDrivers/codex';
import { encodeRpc } from '../server/chatDrivers/codexWire';
import type { AgentTurnOptions, ChatEvent } from '../server/chat';
import type { PermissionMode } from '../server/permissionMode';

/**
 * A scripted `codex app-server`. `sent` records every line the driver wrote,
 * so a test can assert on what was asked as well as what was rendered.
 */
class FakeAppServer implements CodexTransport {
  sent: {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: { code?: number; message?: string };
  }[] = [];
  private onDataCb: ((chunk: string) => void) | null = null;
  private onCloseCb: ((reason: string) => void) | null = null;
  killed = false;
  /** Answer these methods automatically as codex would. */
  autoReply: Record<string, unknown> = {
    initialize: { userAgent: 'fake/0.144.5' },
    'thread/start': { thread: { id: 'thread-1' } },
    'thread/resume': { thread: { id: 'thread-resumed' } },
    'turn/start': { turn: { id: 'turn-1' } },
  };

  write(line: string): void {
    const message = JSON.parse(line.trim());
    this.sent.push(message);
    if (message.method && message.id !== undefined) {
      const reply = this.autoReply[message.method as string];
      if (reply !== undefined) this.respond(message.id, reply);
    }
  }
  onData(handler: (chunk: string) => void): void {
    this.onDataCb = handler;
  }
  onClose(handler: (reason: string) => void): void {
    this.onCloseCb = handler;
  }
  kill(): void {
    this.killed = true;
  }

  /** Push a server->client message at the driver. */
  emit(message: Record<string, unknown>): void {
    this.onDataCb?.(encodeRpc(message));
  }
  respond(id: number | string, result: unknown): void {
    this.emit({ id, result });
  }
  notify(method: string, params: unknown): void {
    this.emit({ method, params });
  }
  close(reason: string): void {
    this.onCloseCb?.(reason);
  }

  /** The last reply the driver sent for a given request id. */
  replyFor(id: number | string): unknown {
    return this.sent.filter((m) => m.id === id && m.method === undefined).pop()?.result;
  }
  errorFor(id: number | string): { code?: number; message?: string } | undefined {
    return this.sent.filter((m) => m.id === id && m.method === undefined).pop()?.error;
  }
  requestsFor(method: string): Record<string, unknown>[] {
    return this.sent.filter((m) => m.method === method).map((m) => m.params ?? {});
  }
}

/**
 * One long-lived reader over a driver's events.
 *
 * Deliberately NOT a `for await` per assertion: EventQueue closes itself when
 * an iterator is abandoned early (a `break` calls `return()`), so a second
 * loop over the same driver would silently read from a dead queue. Holding a
 * single iterator is what lets a test assert on one burst, act, and then
 * assert on the next.
 */
function reader(source: AsyncIterable<ChatEvent>): { next(count: number): Promise<ChatEvent[]> } {
  const iterator = source[Symbol.asyncIterator]();
  return {
    async next(count: number): Promise<ChatEvent[]> {
      const out: ChatEvent[] = [];
      while (out.length < count) {
        const result = await iterator.next();
        if (result.done) break;
        out.push(result.value);
      }
      return out;
    },
  };
}

function makeDriver(opts?: {
  resume?: string | null;
  onThreadId?: (id: string) => void;
  agent?: AgentTurnOptions | null;
  permissionMode?: PermissionMode;
}): {
  driver: CodexDriver;
  server: FakeAppServer;
} {
  const server = new FakeAppServer();
  const driver = new CodexDriver(
    '/fake/codex',
    {},
    opts?.resume ?? null,
    opts?.onThreadId ?? (() => undefined),
    () => server,
    opts?.agent ?? null,
    null,
    opts?.permissionMode,
  );
  return { driver, server };
}

describe('CodexDriver handshake', () => {
  it('initializes, announces itself, and starts a thread in the project folder', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');

    const methods = server.sent.filter((m) => m.method).map((m) => m.method);
    // Skills are registered between the handshake and the thread, so a turn
    // can use one on the very first message.
    expect(methods.slice(0, 4)).toEqual([
      'initialize',
      'initialized',
      'skills/extraRoots/set',
      'thread/start',
    ]);
    expect(server.requestsFor('initialize')[0].clientInfo).toMatchObject({ name: 'hearth' });
    expect(server.requestsFor('thread/start')[0].cwd).toBe('/w/game');
    driver.stop();
  });

  it('remembers the thread it bound, so the conversation can be resumed later', async () => {
    const seen: string[] = [];
    const { driver } = makeDriver({ onThreadId: (id) => seen.push(id) });
    await driver.start('chat-1', '/w/game');
    expect(seen).toEqual(['thread-1']);
    driver.stop();
  });

  it('resumes a known thread instead of starting a stranger', async () => {
    const { driver, server } = makeDriver({ resume: 'thread-old' });
    await driver.start('chat-1', '/w/game');
    expect(server.requestsFor('thread/resume')[0].threadId).toBe('thread-old');
    expect(server.requestsFor('thread/start')).toHaveLength(0);
    driver.stop();
  });

  it('falls back to a fresh thread when the remembered one is gone', async () => {
    const { driver, server } = makeDriver({ resume: 'thread-gone' });
    const events = reader(driver.events);
    // A codex that has forgotten the thread rejects the resume.
    server.autoReply['thread/resume'] = undefined as never;
    server.write = ((line: string) => {
      const message = JSON.parse(line.trim());
      server.sent.push(message);
      if (message.method === 'thread/resume') server.emit({ id: message.id, error: { message: 'no such thread' } });
      else if (message.method && message.id !== undefined && server.autoReply[message.method as string] !== undefined) {
        server.respond(message.id, server.autoReply[message.method as string]);
      }
    }) as typeof server.write;
    await driver.start('chat-1', '/w/game');
    expect(server.requestsFor('thread/start')).toHaveLength(1);
    expect(await events.next(1)).toEqual([
      { type: 'notice', text: 'Codex could not resume the saved thread, so this continues in a fresh Codex thread.' },
    ]);
    driver.stop();
  });
});

/**
 * The permission policy is fixed when the thread opens, so it has to be on the
 * request that opens it, either of them. Sending it on `thread/start` alone
 * left every RESUMED conversation running under whatever `~/.codex/config.toml`
 * defaults to, which for a folder codex does not trust is a READ-ONLY sandbox:
 * the user approves a patch and the turn dies trying to write it. That is a
 * bug Jake actually hit, and it would have read as intermittent because it only
 * struck conversations that had been reopened.
 */
describe('CodexDriver permission policy', () => {
  it('sends the policy and the sandbox on a fresh thread', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    expect(server.requestsFor('thread/start')[0]).toMatchObject({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
    driver.stop();
  });

  it('sends them on a RESUME too, which is where the read-only default bites', async () => {
    const { driver, server } = makeDriver({ resume: 'thread-old' });
    await driver.start('chat-1', '/w/game');
    expect(server.requestsFor('thread/resume')[0]).toMatchObject({
      threadId: 'thread-old',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
    driver.stop();
  });

  it('carries the chosen mode onto both requests', async () => {
    for (const [mode, expected] of [
      ['ask', { approvalPolicy: 'untrusted', sandbox: 'workspace-write' }],
      ['skip', { approvalPolicy: 'never', sandbox: 'danger-full-access' }],
    ] as const) {
      const fresh = makeDriver({ permissionMode: mode });
      await fresh.driver.start('chat-1', '/w/game');
      expect(fresh.server.requestsFor('thread/start')[0]).toMatchObject(expected);
      fresh.driver.stop();

      const resumed = makeDriver({ permissionMode: mode, resume: 'thread-old' });
      await resumed.driver.start('chat-1', '/w/game');
      expect(resumed.server.requestsFor('thread/resume')[0]).toMatchObject(expected);
      resumed.driver.stop();
    }
  });
});

describe('CodexDriver turns', () => {
  it('discovers enabled skills dynamically and invokes them with Codex syntax', async () => {
    const { driver, server } = makeDriver();
    server.autoReply['skills/list'] = {
      data: [
        {
          cwd: '/w/game',
          errors: [],
          skills: [
            { name: 'ship', description: 'Ship the project', enabled: true, path: '/skills/ship', scope: 'user' },
            { name: 'off', description: 'Disabled', enabled: false, path: '/skills/off', scope: 'user' },
          ],
        },
      ],
    };
    await driver.start('chat-1', '/w/game');

    expect(await driver.commands()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'compact', source: 'builtin' }),
        expect.objectContaining({ name: 'review', source: 'builtin' }),
        expect.objectContaining({ name: 'ship', source: 'skill' }),
      ]),
    );
    driver.send('/ship production');
    expect(server.requestsFor('turn/start')[0].input).toEqual([
      { type: 'text', text: '$ship production', text_elements: [] },
    ]);
    driver.stop();
  });

  it('runs compact through the native app-server action', async () => {
    const { driver, server } = makeDriver();
    server.autoReply['thread/compact/start'] = {};
    await driver.start('chat-1', '/w/game');
    const completed = reader(driver.events).next(1);
    driver.send('/compact');

    expect(server.requestsFor('thread/compact/start')[0]).toEqual({ threadId: 'thread-1' });
    expect(await completed).toEqual([{ type: 'turn-complete' }]);
    expect(server.requestsFor('turn/start')).toHaveLength(0);
    driver.stop();
  });

  it('sends a turn and maps the stream onto the transcript vocabulary', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    driver.send('make a shooter');

    expect(server.requestsFor('turn/start')[0]).toMatchObject({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'make a shooter' }],
    });

    const events = reader(driver.events);
    const collected = events.next(5);
    server.notify('item/agentMessage/delta', { itemId: 'm1', delta: 'Building' });
    server.notify('item/started', { item: { type: 'commandExecution', id: 'c1', command: 'npm test', cwd: '/w' } });
    server.notify('item/commandExecution/outputDelta', { itemId: 'c1', delta: 'PASS\n' });
    server.notify('item/completed', {
      item: { type: 'commandExecution', id: 'c1', status: 'completed', exitCode: 0, aggregatedOutput: 'PASS' },
    });
    server.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1' } });

    expect(await collected).toEqual([
      { type: 'message-delta', text: 'Building' },
      { type: 'tool-begin', toolId: 'c1', kind: 'command', title: 'npm test', detail: '/w' },
      { type: 'tool-output-delta', toolId: 'c1', chunk: 'PASS\n' },
      { type: 'tool-end', toolId: 'c1', status: 'ok', exitCode: 0, summary: 'PASS' },
      { type: 'turn-complete' },
    ]);
    driver.stop();
  });

  it('settles image generation even when its external artifact cannot be staged', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    const collected = reader(driver.events).next(2);
    server.notify('item/completed', {
      item: {
        type: 'imageGeneration',
        id: 'image-1',
        status: 'completed',
        savedPath: '../missing-output.png',
      },
    });
    expect(await collected).toEqual([
      expect.objectContaining({ type: 'notice', text: expect.stringContaining('Could not stage') }),
      { type: 'tool-end', toolId: 'image-1', status: 'ok' },
    ]);
    driver.stop();
  });

  it('queues a turn sent before the thread finished binding', async () => {
    const server = new FakeAppServer();
    const driver = new CodexDriver('/fake/codex', {}, null, () => undefined, () => server);
    const starting = driver.start('chat-1', '/w/game');
    driver.send('too early'); // no thread yet
    await starting;
    expect(server.requestsFor('turn/start')).toHaveLength(1);
    driver.stop();
  });

  it('interrupts the running turn without ending the conversation', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    driver.send('go');
    server.notify('turn/started', { threadId: 'thread-1', turn: { id: 'turn-7' } });
    driver.interrupt();
    expect(server.requestsFor('turn/interrupt')[0]).toEqual({ threadId: 'thread-1', turnId: 'turn-7' });
    expect(server.killed).toBe(false); // the thread survives; the next send continues it
    driver.stop();
  });

  it('reports the child dying as an error rather than going silent', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    const collected = reader(driver.events).next(1);
    server.close('codex app-server exited (1)');
    expect(await collected).toEqual([{ type: 'error', message: 'codex app-server exited (1)' }]);
    driver.stop();
  });
});

describe('codex command catalogue', () => {
  it('always exposes native actions and ignores disabled or duplicate skills', () => {
    expect(
      codexSlashCommands({
        data: [
          {
            skills: [
              { name: 'compact', description: 'duplicate', enabled: true },
              { name: 'live', description: 'Live skill', enabled: true },
              { name: 'off', description: 'Off skill', enabled: false },
            ],
          },
        ],
      }).map((command) => command.name),
    ).toEqual(['compact', 'review', 'live']);
  });
});

describe('CodexDriver approvals', () => {
  it('surfaces an approval request and answers it with the user decision', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    driver.send('go');

    const events = reader(driver.events);
    const request = events.next(1);
    server.emit({
      id: 99,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 't', itemId: 'i1', startedAtMs: 0, reason: 'Runs a script' },
    });
    const [event] = await request;
    expect(event).toMatchObject({ type: 'approval-request', kind: 'command', title: 'Runs a script' });
    const approvalId = (event as { approvalId: string }).approvalId;

    const resolved = events.next(1);
    driver.approve(approvalId, 'allow');
    // The paused turn is released with codex's own v2 vocabulary...
    expect(server.replyFor(99)).toEqual({ decision: 'accept' });
    // ...and every window watching the chat sees it settle.
    expect(await resolved).toEqual([{ type: 'approval-resolved', approvalId, decision: 'allow' }]);
    driver.stop();
  });

  it('answers for the user under skip instead of putting a prompt on screen', async () => {
    // The thread was started with `approvalPolicy: 'never'`, so codex should
    // not ask. But `never` governs commands and patches, and this protocol has
    // other things it can ask about, so a request CAN still arrive. Showing it
    // would put Allow / Deny on screen under a pill that reads "No checks".
    const { driver, server } = makeDriver({ permissionMode: 'skip' });
    await driver.start('chat-1', '/w/game');
    driver.send('go');

    const events = reader(driver.events);
    server.emit({
      id: 42,
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', turnId: 't', itemId: 'i9', startedAtMs: 0 },
    });
    // Answered immediately, and with an allow: the user already said yes once,
    // for the whole project.
    expect(server.replyFor(42)).toEqual({ decision: 'accept' });

    // And nothing reached the transcript. A turn-complete is pushed after, so
    // the read below settles rather than hanging on an empty queue.
    server.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 't', status: 'completed', items: [] } } });
    const [next] = await events.next(1);
    expect(next).toEqual({ type: 'turn-complete' });
    driver.stop();
  });

  it('answers a denial with decline', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    const request = reader(driver.events).next(1);
    server.emit({
      id: 7,
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', turnId: 't', itemId: 'i2', startedAtMs: 0 },
    });
    const approvalId = ((await request)[0] as { approvalId: string }).approvalId;
    driver.approve(approvalId, 'deny');
    expect(server.replyFor(7)).toEqual({ decision: 'decline' });
    driver.stop();
  });

  it('returns an exact server-offered approval value through the shared allow decision', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    const request = reader(driver.events).next(1);
    server.emit({
      id: 8,
      method: 'item/commandExecution/requestApproval',
      params: {
        reason: 'Run the formatter',
        command: ['npm', 'run', 'format'],
        availableDecisions: ['acceptForSession', 'decline'],
      },
    });
    const approvalId = ((await request)[0] as { approvalId: string }).approvalId;
    driver.approve(approvalId, 'allow');
    expect(server.replyFor(8)).toEqual({ decision: 'acceptForSession' });
    driver.stop();
  });

  it('withdraws anything still pending on stop — codex unwinds, and no Deny is forged', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    const events = reader(driver.events);
    const request = events.next(1);
    server.emit({
      id: 11,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 't', itemId: 'i3', startedAtMs: 0 },
    });
    const approvalId = ((await request)[0] as { approvalId: string }).approvalId;
    // Codex hears `decline` so the child never sits on a paused turn, but the
    // event stream — and through it the transcript — records `withdrawn`: the
    // session ended before the person decided, and writing `deny` there would
    // put a decision in their mouth they never made.
    const resolved = events.next(1);
    driver.stop();
    expect(server.replyFor(11)).toEqual({ decision: 'decline' });
    expect(await resolved).toEqual([{ type: 'approval-resolved', approvalId, decision: 'withdrawn' }]);
  });

  it('rejects an unknown server request explicitly and makes the incompatibility visible', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    const events = reader(driver.events).next(1);
    server.emit({ id: 42, method: 'some/futureRequest', params: {} });
    expect(server.replyFor(42)).toBeUndefined();
    expect(server.errorFor(42)).toEqual({
      code: -32601,
      message: 'Unsupported codex server request: some/futureRequest',
    });
    expect(await events).toEqual([
      { type: 'notice', text: 'Codex asked Hearth to handle an unsupported request: some/futureRequest.' },
    ]);
    driver.stop();
  });

  it('rejects malformed interactive requests instead of acknowledging them as success', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    const events = reader(driver.events).next(1);
    server.emit({ id: 46, method: 'item/tool/requestUserInput', params: { questions: [] } });
    expect(server.errorFor(46)).toEqual({
      code: -32602,
      message: 'Invalid codex server request: item/tool/requestUserInput',
    });
    expect(await events).toEqual([
      { type: 'notice', text: 'Codex sent an interactive request Hearth could not safely display.' },
    ]);
    driver.stop();
  });

  it('answers currentTime/read with whole Unix seconds', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    const before = Math.floor(Date.now() / 1000);
    server.emit({ id: 41, method: 'currentTime/read', params: {} });
    const after = Math.floor(Date.now() / 1000);
    expect(server.replyFor(41)).toMatchObject({ currentTimeAt: expect.any(Number) });
    const currentTimeAt = (server.replyFor(41) as { currentTimeAt: number }).currentTimeAt;
    expect(currentTimeAt).toBeGreaterThanOrEqual(before);
    expect(currentTimeAt).toBeLessThanOrEqual(after);
    driver.stop();
  });

  it('blocks on requestUserInput and sends the exact submitted answer shape', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    const events = reader(driver.events);
    const requested = events.next(1);
    server.emit({
      id: 43,
      method: 'item/tool/requestUserInput',
      params: {
        questions: [
          {
            id: 'style',
            header: 'Art',
            question: 'Pixel art or vector?',
            isOther: true,
            options: [{ label: 'Pixel' }, { label: 'Vector' }],
          },
        ],
      },
    });
    const [event] = await requested;
    expect(event).toMatchObject({
      type: 'input-request',
      title: 'Art',
      questions: [
        {
          id: 'style',
          label: 'Pixel art or vector?',
          type: 'choice',
          options: [
            { value: 'Pixel', label: 'Pixel' },
            { value: 'Vector', label: 'Vector' },
          ],
        },
      ],
    });
    expect(server.replyFor(43)).toBeUndefined();

    const inputId = (event as { inputId: string }).inputId;
    const resolved = events.next(1);
    driver.answerInput(inputId, { action: 'submit', answers: { style: 'Pixel' } });
    expect(server.replyFor(43)).toEqual({ answers: { style: { answers: ['Pixel'] } } });
    expect(await resolved).toEqual([{ type: 'input-resolved', inputId, action: 'submit' }]);
    driver.stop();
  });

  it('answers MCP forms exactly, without writing submitted values into events', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    const events = reader(driver.events);
    const requested = events.next(1);
    server.emit({
      id: 'mcp-1',
      method: 'mcpServer/elicitation/request',
      params: {
        serverName: 'deploy',
        mode: 'form',
        message: 'Configure deployment',
        requestedSchema: {
          type: 'object',
          required: ['region'],
          properties: {
            region: { type: 'string', title: 'Region' },
            replicas: { type: 'integer', title: 'Replicas' },
          },
        },
      },
    });
    const [event] = await requested;
    expect(event).toMatchObject({
      type: 'input-request',
      title: 'deploy',
      description: 'Configure deployment',
    });
    const inputId = (event as { inputId: string }).inputId;
    const resolved = events.next(1);
    driver.answerInput(inputId, { action: 'submit', answers: { region: 'us-west', replicas: 3 } });
    expect(server.replyFor('mcp-1')).toEqual({
      action: 'accept',
      content: { region: 'us-west', replicas: 3 },
      _meta: null,
    });
    expect(await resolved).toEqual([{ type: 'input-resolved', inputId, action: 'submit' }]);
    driver.stop();
  });

  it('cancels MCP elicitations with the protocol cancel result', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    const requested = reader(driver.events).next(1);
    server.emit({
      id: 'mcp-2',
      method: 'mcpServer/elicitation/request',
      params: {
        serverName: 'deploy',
        mode: 'form',
        message: 'Configure deployment',
        requestedSchema: { type: 'object', properties: { region: { type: 'string' } } },
      },
    });
    const inputId = ((await requested)[0] as { inputId: string }).inputId;
    driver.answerInput(inputId, { action: 'cancel' });
    expect(server.replyFor('mcp-2')).toEqual({ action: 'cancel', content: null, _meta: null });
    driver.stop();
  });

  it('withdraws a pending input when codex resolves the server request itself', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    const events = reader(driver.events);
    const requested = events.next(1);
    server.emit({
      id: 44,
      method: 'item/tool/requestUserInput',
      params: { questions: [{ id: 'name', question: 'Name?' }] },
    });
    const inputId = ((await requested)[0] as { inputId: string }).inputId;
    const resolved = events.next(1);
    server.notify('serverRequest/resolved', { requestId: 44 });
    expect(await resolved).toEqual([{ type: 'input-resolved', inputId, action: 'withdrawn' }]);
    driver.answerInput(inputId, { action: 'submit', answers: { name: 'late' } });
    expect(server.replyFor(44)).toBeUndefined();
    driver.stop();
  });

  it('withdraws a pending approval when codex resolves the server request itself', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    const events = reader(driver.events);
    const requested = events.next(1);
    server.emit({
      id: 47,
      method: 'item/commandExecution/requestApproval',
      params: { reason: 'Run it?', command: ['npm', 'test'] },
    });
    const approvalId = ((await requested)[0] as { approvalId: string }).approvalId;
    const resolved = events.next(1);
    server.notify('serverRequest/resolved', { requestId: 47 });
    expect(await resolved).toEqual([{ type: 'approval-resolved', approvalId, decision: 'withdrawn' }]);
    driver.approve(approvalId, 'allow');
    expect(server.replyFor(47)).toBeUndefined();
    driver.stop();
  });

  it('cancels every pending input on stop and records withdrawal rather than an answer', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    const events = reader(driver.events);
    const requested = events.next(1);
    server.emit({
      id: 45,
      method: 'item/tool/requestUserInput',
      params: { questions: [{ id: 'token', question: 'Token?', isSecret: true }] },
    });
    const inputId = ((await requested)[0] as { inputId: string }).inputId;
    const resolved = events.next(1);
    driver.stop();
    expect(server.replyFor(45)).toEqual({ answers: {} });
    expect(await resolved).toEqual([{ type: 'input-resolved', inputId, action: 'withdrawn' }]);
  });
});

/**
 * Per-turn model and reasoning effort.
 *
 * `TurnStartParams` on CODEX_TESTED_VERSION really does carry `model` and
 * `effort` (verified against that build's own `codex app-server generate-ts`
 * output — see the codexWire header), and both override the thread's setting
 * for the turn. What has to stay true is the negative case: a turn with no
 * choice must send NEITHER key, so codex keeps using the user's own config.
 */
describe('CodexDriver model and effort', () => {
  it('puts the turn choice on turn/start', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    driver.send('make a shooter', { provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' });
    expect(server.requestsFor('turn/start')[0]).toMatchObject({
      threadId: 'thread-1',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
    driver.stop();
  });

  it('sends no override at all when the turn expressed no choice', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    driver.send('make a shooter');
    const params = server.requestsFor('turn/start')[0];
    expect(params).not.toHaveProperty('model');
    expect(params).not.toHaveProperty('effort');
    driver.stop();
  });

  it('applies the choice the conversation was bound with to turns that carry none', async () => {
    const { driver, server } = makeDriver({ agent: { provider: 'openai', model: 'gpt-5.6-luna', effort: 'low' } });
    await driver.start('chat-1', '/w/game');
    driver.send('first');
    driver.send('second', { provider: 'openai', model: 'gpt-5.6-sol' });
    const [first, second] = server.requestsFor('turn/start');
    expect(first).toMatchObject({ model: 'gpt-5.6-luna', effort: 'low' });
    expect(second).toMatchObject({ model: 'gpt-5.6-sol' });
    expect(second).not.toHaveProperty('effort');
    driver.stop();
  });

  it('keeps the choice with a turn queued before the thread was ready', async () => {
    const server = new FakeAppServer();
    const driver = new CodexDriver('/fake/codex', {}, null, () => undefined, () => server, null);
    // Sending before start() means the turn sits in the backlog; the choice
    // must survive the wait rather than being dropped on the way through.
    driver.send('early', { provider: 'openai', model: 'gpt-5.6-sol', effort: 'medium' });
    await driver.start('chat-1', '/w/game');
    expect(server.requestsFor('turn/start')[0]).toMatchObject({ model: 'gpt-5.6-sol', effort: 'medium' });
    driver.stop();
  });
});

/**
 * What happens when the child goes away.
 *
 * A transport loss is not a hiccup, it is the end of the conversation's
 * backend, and the whole app depends on the driver saying so. It used to push
 * an error and close its queue and nothing else: `stopped` stayed false, so the
 * driver still LOOKED alive to ws.ts, which kept the session in its map and
 * handed the next message straight to the corpse. That message was appended to
 * the transcript, pushed into a closed queue, and dropped without a word, and
 * every message after it evaporated before it ever reached disk.
 */
describe('CodexDriver when the app-server dies', () => {
  it('does not report a deliberate stop closed until the transport actually exits', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    let closed = false;
    void driver.closed.then(() => {
      closed = true;
    });
    driver.stop();
    await Promise.resolve();
    expect(closed).toBe(false);
    server.close('codex app-server exited (signal)');
    await driver.closed;
    expect(closed).toBe(true);
  });

  it('reports the loss, ends its stream, and reads dead', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    expect(driver.dead).toBe(false);

    const seen: ChatEvent[] = [];
    const drained = (async () => {
      for await (const event of driver.events) seen.push(event);
    })();

    server.close('codex app-server exited');
    await drained; // the stream ENDS; before the fix it stayed open forever

    expect(seen).toEqual([{ type: 'error', message: 'codex app-server exited' }]);
    expect(driver.dead).toBe(true);
    expect(server.killed).toBe(true); // and the child is not left behind
  });

  it('does not accept a turn afterwards, so nothing is sent into the void', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    server.close('pipe closed');
    const before = server.requestsFor('turn/start').length;
    driver.send('are you still there?');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.requestsFor('turn/start')).toHaveLength(before);
  });
});

/**
 * A thread id is the one thing a turn cannot be sent without.
 *
 * `start` used to become ready whether or not it had found one, and `startTurn`
 * opened with a bare `if (!conn || !this.threadId) return;`, so against a codex
 * build whose reply shape had drifted, every message was written to the
 * transcript, drawn in the window, and thrown away in silence. Failing the bind
 * is what turns that into something a person can see and act on.
 */
describe('CodexDriver without a thread id', () => {
  it('fails the bind rather than accepting turns it will never send', async () => {
    const { driver, server } = makeDriver();
    server.autoReply['thread/start'] = { somethingElse: true };
    await expect(driver.start('chat-1', '/w/game')).rejects.toThrow(/did not say which one/);
    driver.stop();
  });

  it('keeps a resumed conversation on the thread it asked to resume', async () => {
    const { driver, server } = makeDriver({ resume: 'thread-earlier' });
    // A reply this build cannot read the id out of. The resume SUCCEEDED, so
    // the thread is the one we named, and the conversation carries on.
    server.autoReply['thread/resume'] = { ok: true };
    await driver.start('chat-1', '/w/game');
    driver.send('carry on');
    expect(server.requestsFor('turn/start')[0]).toMatchObject({ threadId: 'thread-earlier' });
    driver.stop();
  });
});
