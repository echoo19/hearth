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
import { CodexDriver, type CodexTransport } from '../server/chatDrivers/codex';
import { encodeRpc } from '../server/chatDrivers/codexWire';
import type { ChatEvent } from '../server/chat';

/**
 * A scripted `codex app-server`. `sent` records every line the driver wrote,
 * so a test can assert on what was asked as well as what was rendered.
 */
class FakeAppServer implements CodexTransport {
  sent: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown }[] = [];
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

function makeDriver(opts?: { resume?: string | null; onThreadId?: (id: string) => void }): {
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
  );
  return { driver, server };
}

describe('CodexDriver handshake', () => {
  it('initializes, announces itself, and starts a thread in the project folder', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');

    const methods = server.sent.filter((m) => m.method).map((m) => m.method);
    expect(methods.slice(0, 3)).toEqual(['initialize', 'initialized', 'thread/start']);
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
    driver.stop();
  });
});

describe('CodexDriver turns', () => {
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

  it('denies anything still pending on stop, so the child never sits on a paused turn', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    const request = reader(driver.events).next(1);
    server.emit({
      id: 11,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 't', itemId: 'i3', startedAtMs: 0 },
    });
    await request;
    driver.stop();
    expect(server.replyFor(11)).toEqual({ decision: 'decline' });
  });

  it('answers an unknown server request rather than leaving it hanging', async () => {
    const { driver, server } = makeDriver();
    await driver.start('chat-1', '/w/game');
    server.emit({ id: 42, method: 'some/futureRequest', params: {} });
    expect(server.replyFor(42)).toEqual({});
    driver.stop();
  });
});
