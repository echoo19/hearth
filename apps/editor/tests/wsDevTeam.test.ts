import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { EventQueue, StubDriver, type AgentTurnOptions, type ChatDriver, type ChatEvent, type InputResponse } from '../server/chat';
import { createProjectServerContext } from '../server/projectServer';
import { attachWebSocket, type WsFrame } from '../server/ws';
import { getChat, readTranscript } from '../server/chatStore';
import { buildInterviewPrompt } from '../server/devTeamRuntime';
import { readDevTeamState, writeDevTeamState } from '../server/devTeamStore';
import { writePermissionMode, type PermissionMode } from '../server/permissionMode';
import type { PtyBackend, PtyHandle } from '../server/ptyManager';

class NoopPtyHandle implements PtyHandle {
  onData(_listener: (data: string) => void): void {}
  onExit(_listener: (event: { exitCode: number }) => void): void {}
  onError(_listener: (error: Error) => void): void {}
  write(_data: string): void {}
  resize(_cols: number, _rows: number): void {}
  kill(): void {}
}

class NoopPtyBackend implements PtyBackend {
  spawn(): PtyHandle {
    return new NoopPtyHandle();
  }
}

class FakeDriver implements ChatDriver {
  readonly kind = 'agent-sdk' as const;
  readonly queue = new EventQueue<ChatEvent>();
  readonly sent: Array<{ text: string; agent?: AgentTurnOptions }> = [];
  readonly approvals: Array<{ id: string; decision: string; choiceId?: string }> = [];
  readonly inputs: Array<{ id: string; response: InputResponse }> = [];
  starts: Array<{ id: string; root: string }> = [];
  eventReaders = 0;
  stopped = false;
  interrupted = false;
  holdStop = false;
  closedBeforeStartNever = false;
  private readonly startGate: Promise<void> | null;
  private startCompleted = false;
  private readonly actualClosed: Promise<void>;
  private releaseStartGate: (() => void) | null = null;
  private resolveClosed!: () => void;

  constructor(holdStart = false) {
    this.actualClosed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    this.startGate = holdStart
      ? new Promise<void>((resolve) => {
          this.releaseStartGate = resolve;
        })
      : null;
  }

  get closed(): Promise<void> {
    return this.closedBeforeStartNever && !this.startCompleted
      ? new Promise<void>(() => undefined)
      : this.actualClosed;
  }

  get events(): AsyncIterable<ChatEvent> {
    this.eventReaders += 1;
    return this.queue;
  }

  async start(id: string, root: string): Promise<void> {
    this.starts.push({ id, root });
    if (this.startGate) await this.startGate;
    this.startCompleted = true;
  }

  releaseStart(): void {
    this.releaseStartGate?.();
    this.releaseStartGate = null;
  }

  send(text: string, agent?: AgentTurnOptions): void {
    this.sent.push({ text, agent });
  }

  approve(id: string, decision: 'allow' | 'deny', choiceId?: string): void {
    this.approvals.push({ id, decision, choiceId });
  }

  answerInput(id: string, response: InputResponse): void {
    this.inputs.push({ id, response });
  }

  interrupt(): void {
    this.interrupted = true;
  }

  stop(): void {
    this.stopped = true;
    if (this.holdStop) return;
    this.queue.close();
    this.resolveClosed();
  }

  releaseStop(...events: ChatEvent[]): void {
    for (const event of events) this.queue.push(event);
    this.queue.close();
    this.resolveClosed();
  }

  closeStream(): void {
    this.queue.close();
    this.resolveClosed();
  }

  emit(event: ChatEvent): void {
    this.queue.push(event);
  }
}

interface Inbox {
  socket: WebSocket;
  frames: WsFrame[];
  next(match: (frame: WsFrame) => boolean, timeoutMs?: number): Promise<WsFrame>;
}

interface Harness {
  tmp: string;
  root: string;
  server: http.Server;
  port: number;
  drivers: FakeDriver[];
  options: Array<{
    agent?: AgentTurnOptions | null;
    permissionMode?: PermissionMode | null;
    resumeThreadId?: string | null;
    resumeSessionId?: string | null;
    onThreadId?: (id: string) => void;
    onSessionId?: (id: string) => void;
  }>;
  ctx: ReturnType<typeof createProjectServerContext>;
  wsClosed: Promise<void>;
  connect(): Promise<Inbox>;
  close(): Promise<void>;
}

const openHarnesses = new Set<Harness>();

// See the note on WAIT_FOR in devTeamRuntime.test.ts: an integration poll that
// only fits on an idle machine is a CI failure waiting to happen.
async function until(ready: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function makeHarness(
  factory?: (options: Harness['options'][number] | undefined) => Promise<ChatDriver>,
  hooks?: {
    beforeDevTeamReplaySend?: () => Promise<void>;
    onDevTeamControlQueued?: (type: string) => void;
    onChatSendQueued?: () => void;
    beforeChatSendPersist?: () => Promise<void>;
    teardownFlushMs?: number;
  },
): Promise<Harness> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-wsdevteam-'));
  const root = path.join(tmp, 'game');
  await fsp.mkdir(root, { recursive: true });
  const oldHome = process.env.HEARTH_HOME;
  process.env.HEARTH_HOME = path.join(tmp, 'home');
  const ctx = createProjectServerContext({ recentsFile: path.join(tmp, 'recents.json'), repoRoot: tmp });
  await ctx.openWorkspace(root);
  const server = http.createServer();
  const drivers: FakeDriver[] = [];
  const options: Harness['options'] = [];
  const sockets = new Set<WebSocket>();
  const wsHandle = attachWebSocket(server, ctx, new NoopPtyBackend(), async () => process.env, {
    chatDetachLingerMs: 50,
    createChatDriver: async (_root, driverOptions) => {
      options.push(driverOptions ?? {});
      const driver = factory ? await factory(driverOptions) : new FakeDriver();
      if (driver instanceof FakeDriver) drivers.push(driver);
      return driver;
    },
    ...hooks,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  let closed = false;
  const harness: Harness = {
    tmp,
    root,
    server,
    port,
    drivers,
    options,
    ctx,
    wsClosed: wsHandle.closed,
    async connect() {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws?project=${encodeURIComponent(root)}`);
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      const frames: WsFrame[] = [];
      socket.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as WsFrame));
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
      return {
        socket,
        frames,
        async next(match, timeoutMs = 15_000) {
          let found: WsFrame | undefined;
          await until(() => {
            const index = frames.findIndex(match);
            if (index < 0) return false;
            [found] = frames.splice(index, 1);
            return true;
          }, timeoutMs);
          return found!;
        },
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await wsHandle.closed;
      if (oldHome === undefined) delete process.env.HEARTH_HOME;
      else process.env.HEARTH_HOME = oldHome;
      await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
      openHarnesses.delete(harness);
    },
  };
  openHarnesses.add(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of [...openHarnesses]) await harness.close();
});

async function newDevTeam(inbox: Inbox): Promise<string> {
  inbox.socket.send(JSON.stringify({ type: 'chat-new', kind: 'devteam' }));
  const opened = await inbox.next((frame) => frame.type === 'chat-opened');
  if (opened.type !== 'chat-opened') throw new Error('expected chat-opened');
  return opened.chat.id;
}

describe('dev team websocket integration', () => {
  it('accepts devteam at creation and defaults an invalid kind to chat', async () => {
    const harness = await makeHarness();
    const inbox = await harness.connect();
    inbox.socket.send(JSON.stringify({ type: 'chat-new', kind: 'devteam' }));
    const team = await inbox.next((frame) => frame.type === 'chat-opened');
    expect(team.type === 'chat-opened' && team.chat.kind).toBe('devteam');
    inbox.socket.send(JSON.stringify({ type: 'chat-new', kind: 'not-real' }));
    const fallback = await inbox.next((frame) => frame.type === 'chat-opened');
    expect(fallback.type === 'chat-opened' && fallback.chat.kind).toBe('chat');
    inbox.socket.close();
  });

  it('ignores stale dev team controls without binding a provider', async () => {
    const harness = await makeHarness();
    const inbox = await harness.connect();
    inbox.socket.send(JSON.stringify({ type: 'chat-new' }));
    await inbox.next((frame) => frame.type === 'chat-opened');
    inbox.socket.send(JSON.stringify({ type: 'devteam-approve-spec' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.drivers).toHaveLength(0);

    const chatId = await newDevTeam(inbox);
    const deleted = await harness.ctx.deleteProjectChat(harness.root, chatId);
    expect(deleted.status).toBe(200);
    inbox.socket.send(JSON.stringify({ type: 'devteam-resume' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.drivers).toHaveLength(0);
    inbox.socket.close();
  });

  it('records the first request and exact orchestration prompt separately and consumes the lead stream once', async () => {
    const harness = await makeHarness();
    const inbox = await harness.connect();
    const chatId = await newDevTeam(inbox);
    const request = 'Build a tiny game with a surprising interaction.';
    const agent = { provider: 'anthropic' as const, model: 'claude-test', effort: 'high' as const };
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: request, agent }));
    const state = await inbox.next(
      (frame) => frame.type === 'devteam-state' && frame.chatId === chatId && frame.state.phase === 'interviewing',
    );
    expect(state.type === 'devteam-state' && state.state.phase).toBe('interviewing');
    await until(() => harness.drivers[0].sent.length === 1);
    expect(harness.drivers[0].sent).toEqual([{ text: buildInterviewPrompt(chatId, request), agent }]);
    expect(harness.drivers[0].eventReaders).toBe(1);
    const records = await readTranscript(harness.root, chatId);
    expect(records.filter((record) => record.role === 'user')).toEqual([
      expect.objectContaining({ role: 'user', text: request }),
      expect.objectContaining({ role: 'user', text: buildInterviewPrompt(chatId, request), orchestration: true }),
    ]);
    inbox.socket.close();
  });

  it('keeps a stub-backed dev team idle and surfaces the ordinary connection guidance', async () => {
    const harness = await makeHarness(async () => new StubDriver());
    const inbox = await harness.connect();
    const chatId = await newDevTeam(inbox);
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'build this' }));
    await inbox.next((frame) => frame.type === 'chat-event' && frame.chatId === chatId && frame.event.type === 'turn-complete');
    expect((await readDevTeamState(harness.root, chatId)).phase).toBe('idle');
    expect((await readTranscript(harness.root, chatId)).some((record) => record.role === 'user' && record.orchestration)).toBe(false);
    inbox.socket.close();
  });

  it('preserves one runtime across a model rebind and routes run controls', async () => {
    const harness = await makeHarness();
    const inbox = await harness.connect();
    const chatId = await newDevTeam(inbox);
    inbox.socket.send(JSON.stringify({
      type: 'chat-send',
      text: 'first brief',
      agent: { provider: 'anthropic', model: 'model-a' },
    }));
    const first = await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'interviewing');
    await until(() => harness.drivers[0].sent.length === 1);
    const runId = first.type === 'devteam-state' ? first.state.runId : '';
    inbox.socket.send(JSON.stringify({
      type: 'chat-send',
      text: 'one more detail',
      agent: { provider: 'anthropic', model: 'model-b' },
    }));
    await until(() => harness.drivers.length === 2 && harness.drivers[1].sent.length === 1);
    expect((await readDevTeamState(harness.root, chatId)).runId).toBe(runId);
    inbox.socket.send(JSON.stringify({ type: 'devteam-pause' }));
    const paused = await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'paused');
    expect(paused.type === 'devteam-state' && paused.chatId).toBe(chatId);
    inbox.socket.send(JSON.stringify({ type: 'devteam-resume' }));
    const resumed = await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'interviewing');
    expect(resumed.type === 'devteam-state' && resumed.state.runId).toBe(runId);
    inbox.socket.send(JSON.stringify({ type: 'devteam-stop' }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'interrupted');
    // Stop parks the run rather than ending it, and a parked run is picked back
    // up by being spoken to. What is typed is both the note and the restart: it
    // goes into the steering queue and the step the run was parked in runs
    // again carrying it. Nothing else can pick it up, because the board has no
    // Resume button to press.
    const sentBeforeFollowup = harness.drivers[1].sent.length;
    inbox.socket.send(JSON.stringify({
      type: 'chat-send',
      text: 'ordinary follow-up',
      agent: { provider: 'anthropic', model: 'model-b' },
    }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'interviewing');
    await until(() => harness.drivers[1].sent.length === sentBeforeFollowup + 1);
    expect(harness.drivers[1].sent[sentBeforeFollowup].text).toContain('ordinary follow-up');
    const restarted = await readDevTeamState(harness.root, chatId);
    expect(restarted).toMatchObject({ runId, phase: 'interviewing' });
    inbox.socket.close();
  });

  it('ignores a retired lead binding tail and refreshes engineer binding options after rebind', async () => {
    const harness = await makeHarness();
    const inbox = await harness.connect();
    const chatId = await newDevTeam(inbox);
    inbox.socket.send(JSON.stringify({
      type: 'chat-send', text: 'initial brief', agent: { provider: 'anthropic', model: 'model-a' },
    }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'interviewing');
    await until(() => harness.drivers[0].sent.length === 1);
    harness.drivers[0].holdStop = true;
    await writePermissionMode(harness.root, 'skip');
    inbox.socket.send(JSON.stringify({
      type: 'chat-send', text: 'replacement detail', agent: { provider: 'openai', model: 'model-b', effort: 'medium' },
    }));
    await until(() => harness.drivers.length === 2 && harness.drivers[1].sent.length === 1);
    await fsp.mkdir(path.join(harness.root, '.hearth', 'devteam', chatId), { recursive: true });
    await fsp.writeFile(path.join(harness.root, '.hearth', 'devteam', chatId, 'spec.md'), '# Updated spec\n');

    harness.drivers[0].releaseStop({ type: 'turn-complete' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await readDevTeamState(harness.root, chatId)).phase).toBe('interviewing');

    harness.drivers[1].emit({ type: 'turn-complete' });
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'spec-review');
    inbox.socket.send(JSON.stringify({ type: 'devteam-approve-spec' }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'planning');
    await fsp.writeFile(path.join(harness.root, '.hearth', 'devteam', chatId, 'plan.json'), JSON.stringify({
      version: 1,
      roles: [{ id: 'maker', name: 'Maker', focus: 'Build.' }],
      milestones: [{
        id: 'm1', title: 'Build', goal: 'Build.',
        tasks: [{ id: 't1', title: 'Implement', roleId: 'maker', detail: 'Implement.', scope: ['src'] }],
      }],
    }));
    harness.drivers[1].emit({ type: 'turn-complete' });
    await until(() => harness.drivers.length === 3 && harness.drivers[2].sent.length === 1);
    expect(harness.options[2]?.agent).toEqual({ provider: 'openai', model: 'model-b', effort: 'medium' });
    expect(harness.options[2]?.permissionMode).toBe('skip');
    inbox.socket.close();
  });

  it('interrupts the matching run when its live lead stream closes silently', async () => {
    const harness = await makeHarness();
    const inbox = await harness.connect();
    const chatId = await newDevTeam(inbox);
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'start this' }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'interviewing');
    await until(() => harness.drivers[0].sent.length === 1);
    harness.drivers[0].closeStream();
    await until(async () => (await readDevTeamState(harness.root, chatId)).phase === 'interrupted');
    expect((await readDevTeamState(harness.root, chatId)).error).toContain('stopped answering');
    inbox.socket.close();
  });

  it('interrupts planning on lead rebind and resumes the handshake exactly once on the replacement', async () => {
    let driverNumber = 0;
    const harness = await makeHarness(async () => new FakeDriver(++driverNumber === 2));
    const inbox = await harness.connect();
    const chatId = await newDevTeam(inbox);
    inbox.socket.send(JSON.stringify({
      type: 'chat-send', text: 'brief', agent: { provider: 'anthropic', model: 'model-a' },
    }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'interviewing');
    await until(() => harness.drivers[0].sent.length === 1);
    await fsp.mkdir(path.join(harness.root, '.hearth', 'devteam', chatId), { recursive: true });
    await fsp.writeFile(path.join(harness.root, '.hearth', 'devteam', chatId, 'spec.md'), '# Spec\n');
    harness.drivers[0].emit({ type: 'turn-complete' });
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'spec-review');
    inbox.socket.send(JSON.stringify({ type: 'devteam-approve-spec' }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'planning');
    harness.drivers[0].holdStop = true;

    inbox.socket.send(JSON.stringify({
      type: 'chat-send', text: 'new provider detail', agent: { provider: 'openai', model: 'model-b' },
    }));
    await until(() => harness.drivers.length === 2);
    await until(async () => (await readDevTeamState(harness.root, chatId)).phase === 'interrupted');
    expect((await readDevTeamState(harness.root, chatId)).steering).toEqual([]);
    harness.drivers[1].releaseStart();

    // The message that caused the rebind is the message that picks the run back
    // up: planning runs again on the replacement, once, carrying what was typed
    // into the prompt. It used to park here and wait for a Resume press, which
    // is a dead end now that the run is governed by talking to the lead.
    await until(() => harness.drivers[1].sent.length === 1);
    expect(harness.drivers[1].sent[0].text).toContain('new provider detail');
    expect((await readDevTeamState(harness.root, chatId)).phase).toBe('planning');

    await fsp.writeFile(path.join(harness.root, '.hearth', 'devteam', chatId, 'plan.json'), JSON.stringify({
      version: 1,
      roles: [{ id: 'maker', name: 'Maker', focus: 'Build.' }],
      milestones: [{
        id: 'm1', title: 'Build', goal: 'Build.',
        tasks: [{ id: 't1', title: 'Implement', roleId: 'maker', detail: 'Implement.', scope: ['src'] }],
      }],
    }));
    // The retired driver's turn lands afterwards and belongs to nobody: it must
    // neither finish the run's planning step nor start a second handshake.
    harness.drivers[0].releaseStop({ type: 'turn-complete' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await readDevTeamState(harness.root, chatId)).phase).toBe('planning');
    expect(harness.drivers[1].sent).toHaveLength(1);

    harness.drivers[1].holdStop = true;
    inbox.socket.send(JSON.stringify({
      type: 'chat-send', text: 'second provider detail', agent: { provider: 'anthropic', model: 'model-c' },
    }));
    await until(() => harness.drivers.length === 3);
    // Nothing typed is lost across a rebind: the first note has still not been
    // read by a turn that finished, so it goes on the replacement's prompt too.
    await until(() => harness.drivers[2].sent.length === 1);
    expect(harness.drivers[2].sent[0].text).toContain('new provider detail');
    expect(harness.drivers[2].sent[0].text).toContain('second provider detail');
    expect((await readDevTeamState(harness.root, chatId)).steering.map((item) => item.text)).toEqual([
      'new provider detail',
      'second provider detail',
    ]);
    harness.drivers[1].releaseStop({ type: 'turn-complete' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await readDevTeamState(harness.root, chatId)).phase).toBe('planning');
    expect(harness.drivers[2].sent).toHaveLength(1);

    harness.drivers[2].emit({ type: 'turn-complete' });
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'building');
    expect((await readDevTeamState(harness.root, chatId)).steering).toEqual([]);
    inbox.socket.close();
  });

  it('deduplicates a state persisted while the same conversation is reopened', async () => {
    const harness = await makeHarness();
    const inbox = await harness.connect();
    const chatId = await newDevTeam(inbox);
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'start this' }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'interviewing');
    await until(() => harness.drivers[0].sent.length === 1);
    inbox.frames.length = 0;
    inbox.socket.send(JSON.stringify({ type: 'devteam-pause' }));
    inbox.socket.send(JSON.stringify({ type: 'chat-open', chatId: ` ${chatId} ` }));
    await until(() =>
      inbox.frames.some((frame) => frame.type === 'chat-opened') &&
      inbox.frames.some((frame) => frame.type === 'devteam-state' && frame.state.phase === 'paused'),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(inbox.frames.filter((frame) => frame.type === 'devteam-state' && frame.state.phase === 'paused')).toHaveLength(1);
    inbox.socket.close();
  });

  it('keeps replay suppression until every overlapping open of the same conversation finishes', async () => {
    let replayArmed = false;
    let replayReached!: () => void;
    let releaseReplay!: () => void;
    const reachedReplay = new Promise<void>((resolve) => { replayReached = resolve; });
    const replayRelease = new Promise<void>((resolve) => { releaseReplay = resolve; });
    const harness = await makeHarness(undefined, {
      beforeDevTeamReplaySend: async () => {
        if (!replayArmed) return;
        replayReached();
        await replayRelease;
      },
    });
    const inbox = await harness.connect();
    const chatId = await newDevTeam(inbox);
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'start this' }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'interviewing');
    inbox.socket.send(JSON.stringify({ type: 'devteam-pause' }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'paused');

    inbox.frames.length = 0;
    replayArmed = true;
    inbox.socket.send(JSON.stringify({ type: 'chat-open', chatId }));
    await reachedReplay;
    inbox.socket.send(JSON.stringify({ type: 'chat-open', chatId }));
    inbox.socket.send(JSON.stringify({ type: 'devteam-resume' }));
    releaseReplay();
    await until(() => inbox.frames.filter((frame) => frame.type === 'chat-opened').length === 2);
    await until(() => inbox.frames.some(
      (frame) => frame.type === 'devteam-state' && frame.state.phase === 'interviewing',
    ));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(inbox.frames.filter((frame) => frame.type === 'devteam-state')).toEqual([
      expect.objectContaining({ chatId, state: expect.objectContaining({ phase: 'paused' }) }),
      expect.objectContaining({ chatId, state: expect.objectContaining({ phase: 'interviewing' }) }),
    ]);
    inbox.socket.close();
  });

  it('does not let an overlapping open of another conversation clear replay suppression', async () => {
    const harness = await makeHarness();
    const inbox = await harness.connect();
    const firstChatId = await newDevTeam(inbox);
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'start first' }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'interviewing');
    const secondChatId = await newDevTeam(inbox);
    inbox.socket.send(JSON.stringify({ type: 'chat-open', chatId: firstChatId }));
    await inbox.next((frame) => frame.type === 'chat-opened' && frame.chat.id === firstChatId);
    inbox.frames.length = 0;

    inbox.socket.send(JSON.stringify({ type: 'devteam-pause' }));
    inbox.socket.send(JSON.stringify({ type: 'chat-open', chatId: firstChatId }));
    inbox.socket.send(JSON.stringify({ type: 'chat-open', chatId: secondChatId }));
    await until(() => inbox.frames.some(
      (frame) => frame.type === 'chat-opened' && frame.chat.id === secondChatId,
    ));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(inbox.frames.filter(
      (frame) => frame.type === 'devteam-state' && frame.chatId === firstChatId && frame.state.phase === 'paused',
    )).toHaveLength(1);
    inbox.socket.close();
  });

  it('broadcasts correlated engineer activity, routes asks, queues steering, and replays state before activity', async () => {
    let replayArmed = false;
    let replayReached!: () => void;
    let releaseReplay!: () => void;
    const reachedReplay = new Promise<void>((resolve) => { replayReached = resolve; });
    const replayRelease = new Promise<void>((resolve) => { releaseReplay = resolve; });
    const harness = await makeHarness(undefined, {
      beforeDevTeamReplaySend: async () => {
        if (!replayArmed) return;
        replayReached();
        await replayRelease;
      },
    });
    const inbox = await harness.connect();
    const chatId = await newDevTeam(inbox);
    const agent = { provider: 'openai' as const, model: 'codex-test', effort: 'medium' as const };
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'make the project', agent }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'interviewing');
    await until(() => harness.drivers[0].sent.length === 1);
    await fsp.mkdir(path.join(harness.root, '.hearth', 'devteam', chatId), { recursive: true });
    await fsp.writeFile(path.join(harness.root, '.hearth', 'devteam', chatId, 'spec.md'), '# Spec\nBuild it.\n');
    harness.drivers[0].emit({ type: 'turn-complete' });
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'spec-review');
    inbox.socket.send(JSON.stringify({ type: 'devteam-approve-spec' }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'planning');
    expect((await readTranscript(harness.root, chatId)).some(
      (record) => record.role === 'user' && record.text === 'Approve & build',
    )).toBe(true);
    const approvalReplay = await harness.connect();
    approvalReplay.socket.send(JSON.stringify({ type: 'chat-open', chatId }));
    const approvalOpened = await approvalReplay.next((frame) => frame.type === 'chat-opened');
    expect(approvalOpened.type === 'chat-opened' && approvalOpened.records.some(
      (record) => record.role === 'user' && record.text === 'Approve & build',
    )).toBe(true);
    approvalReplay.socket.close();
    const plan = {
      version: 1,
      roles: [{ id: 'builder', name: 'Builder', focus: 'Implement the project.' }],
      milestones: [{
        id: 'm1', title: 'Build', goal: 'Finish the project.',
        tasks: [{ id: 'task1', title: 'Implement', roleId: 'builder', detail: 'Implement the approved specification.', scope: ['src'], effort: 'high' }],
      }],
    };
    await fsp.writeFile(path.join(harness.root, '.hearth', 'devteam', chatId, 'plan.json'), JSON.stringify(plan));
    harness.drivers[0].emit({ type: 'turn-complete' });
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'building');
    await until(() => harness.drivers.length === 2 && harness.drivers[1].sent.length === 1);
    expect(harness.options[1]?.agent).toEqual(agent);
    expect(harness.drivers[1].sent[0].agent).toEqual({ ...agent, effort: 'high' });
    harness.options[1]?.onThreadId?.('thread-task1');
    await until(async () => (await readDevTeamState(harness.root, chatId)).tasks[0]?.continuationId === 'thread-task1');

    const stateRace = await harness.connect();
    harness.options[1]?.onThreadId?.('thread-a');
    stateRace.socket.send(JSON.stringify({ type: 'chat-open', chatId }));
    harness.options[1]?.onThreadId?.('thread-b');
    await until(() => stateRace.frames.filter((frame) => frame.type === 'devteam-state').length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const racedStates = stateRace.frames.filter((frame) => frame.type === 'devteam-state');
    const lastRacedState = racedStates.at(-1);
    expect(lastRacedState?.type === 'devteam-state' && lastRacedState.state.tasks[0]?.continuationId).toBe('thread-b');
    expect(racedStates.findIndex((frame) =>
      frame.type === 'devteam-state' && frame.state.tasks[0]?.continuationId === 'thread-b',
    )).toBe(racedStates.length - 1);
    stateRace.socket.close();

    const eventRace = await harness.connect();
    replayArmed = true;
    eventRace.socket.send(JSON.stringify({ type: 'chat-open', chatId }));
    await reachedReplay;
    harness.drivers[1].emit({ type: 'message-delta', text: 'race-marker' });
    releaseReplay();
    await until(() => eventRace.frames.some((frame) => frame.type === 'chat-opened'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(eventRace.frames.filter((frame) =>
      frame.type === 'devteam-event' && frame.event.type === 'message-delta' && frame.event.text === 'race-marker',
    )).toHaveLength(1);
    eventRace.socket.close();

    const engineerId = (await readDevTeamState(harness.root, chatId)).tasks[0].engineerId;
    harness.drivers[1].emit({
      type: 'approval-request', approvalId: 'approval-1', kind: 'command', title: 'Run check', detail: 'npm test',
    });
    const approval = await inbox.next(
      (frame) => frame.type === 'devteam-event' && frame.engineerId === engineerId && frame.event.type === 'approval-request',
    );
    expect(approval.type === 'devteam-event' && approval.chatId).toBe(chatId);
    inbox.socket.send(JSON.stringify({
      type: 'devteam-engineer-approval', engineerId, approvalId: 'approval-1', decision: 'allow', choiceId: 'once',
    }));
    await until(() => harness.drivers[1].approvals.length === 1);
    expect(harness.drivers[1].approvals[0]).toEqual({ id: 'approval-1', decision: 'allow', choiceId: 'once' });

    harness.drivers[1].emit({
      type: 'input-request', inputId: 'input-1', questions: [{ id: 'name', label: 'Name', type: 'text' }], allowCancel: true,
    });
    await inbox.next((frame) => frame.type === 'devteam-event' && frame.event.type === 'input-request');
    inbox.socket.send(JSON.stringify({
      type: 'devteam-engineer-input', engineerId, inputId: 'input-1', action: 'submit', answers: { name: 'Hearth' },
    }));
    await until(() => harness.drivers[1].inputs.length === 1);

    const leadSends = harness.drivers[0].sent.length;
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'Keep the interface quiet.' }));
    await until(async () => (await readDevTeamState(harness.root, chatId)).steering.length === 1);
    expect(harness.drivers[0].sent).toHaveLength(leadSends);
    expect((await readTranscript(harness.root, chatId)).some((record) => record.role === 'user' && record.text === 'Keep the interface quiet.')).toBe(true);

    const second = await harness.connect();
    second.socket.send(JSON.stringify({ type: 'chat-open', chatId }));
    await until(() => second.frames.some((frame) => frame.type === 'devteam-event'));
    const openedIndex = second.frames.findIndex((frame) => frame.type === 'chat-opened');
    const stateIndex = second.frames.findIndex((frame) => frame.type === 'devteam-state');
    const eventIndex = second.frames.findIndex((frame) => frame.type === 'devteam-event');
    expect([openedIndex, stateIndex, eventIndex]).toEqual([0, 1, 2]);
    second.socket.close();
    inbox.socket.close();
  });

  it('acknowledges a steering note and stays silent for a send that reaches the driver', async () => {
    const harness = await makeHarness();
    const inbox = await harness.connect();
    const chatId = await newDevTeam(inbox);
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'build the thing' }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'interviewing');
    await until(() => harness.drivers[0].sent.length === 1);
    // The opening request became the interview prompt, so a turn really is
    // running and the window must keep waiting on it.
    expect(inbox.frames.filter((frame) => frame.type === 'devteam-steering-accepted')).toEqual([]);

    await fsp.mkdir(path.join(harness.root, '.hearth', 'devteam', chatId), { recursive: true });
    await fsp.writeFile(path.join(harness.root, '.hearth', 'devteam', chatId, 'spec.md'), '# Spec\nBuild it.\n');
    harness.drivers[0].emit({ type: 'turn-complete' });
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'spec-review');
    inbox.socket.send(JSON.stringify({ type: 'devteam-approve-spec' }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'planning');
    await until(() => harness.drivers[0].sent.length === 2);

    const leadSends = harness.drivers[0].sent.length;
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'Keep the interface quiet.' }));
    const ack = await inbox.next((frame) => frame.type === 'devteam-steering-accepted');
    expect(ack).toEqual({ type: 'devteam-steering-accepted', chatId });
    expect((await readDevTeamState(harness.root, chatId)).steering.map((item) => item.text)).toEqual([
      'Keep the interface quiet.',
    ]);
    expect(harness.drivers[0].sent).toHaveLength(leadSends);
    // The note is still in the transcript: the ack ends the turn, it does not
    // undo the send.
    expect((await readTranscript(harness.root, chatId)).some(
      (record) => record.role === 'user' && record.text === 'Keep the interface quiet.',
    )).toBe(true);

    // A second note lands the same way rather than waiting on a turn end.
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'And keep it small.' }));
    await inbox.next((frame) => frame.type === 'devteam-steering-accepted');
    expect((await readDevTeamState(harness.root, chatId)).steering.map((item) => item.text)).toEqual([
      'Keep the interface quiet.',
      'And keep it small.',
    ]);
    inbox.socket.close();
  });

  it('does not acknowledge a spec revision, which starts a real lead turn', async () => {
    const harness = await makeHarness();
    const inbox = await harness.connect();
    const chatId = await newDevTeam(inbox);
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'build the thing' }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'interviewing');
    await until(() => harness.drivers[0].sent.length === 1);
    await fsp.mkdir(path.join(harness.root, '.hearth', 'devteam', chatId), { recursive: true });
    await fsp.writeFile(path.join(harness.root, '.hearth', 'devteam', chatId, 'spec.md'), '# Spec\nBuild it.\n');
    harness.drivers[0].emit({ type: 'turn-complete' });
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'spec-review');

    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'Cut the multiplayer part.' }));
    await until(() => harness.drivers[0].sent.length === 2);
    expect(harness.drivers[0].sent[1].text).toContain('Cut the multiplayer part.');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(inbox.frames.filter((frame) => frame.type === 'devteam-steering-accepted')).toEqual([]);
    inbox.socket.close();
  });

  it('answers a send into a conversation that is being deleted instead of dropping it', async () => {
    const harness = await makeHarness(undefined, { teardownFlushMs: 30 });
    const inbox = await harness.connect();
    const chatId = await newDevTeam(inbox);
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'start it' }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'interviewing');
    await until(() => harness.drivers[0].sent.length === 1);
    harness.drivers[0].holdStop = true;

    const blocked = await harness.ctx.deleteProjectChat(harness.root, chatId);
    expect(blocked.status).toBe(409);

    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'typed into a closing chat' }));
    const refusal = await inbox.next(
      (frame) => frame.type === 'chat-event' && frame.chatId === chatId && frame.event.type === 'error',
    );
    expect(refusal.type === 'chat-event' && refusal.event.type === 'error' && refusal.event.message).toBe(
      'This conversation is being deleted. Its agent is still stopping.',
    );
    expect((await readTranscript(harness.root, chatId)).some(
      (record) => record.role === 'user' && record.text === 'typed into a closing chat',
    )).toBe(false);
    harness.drivers[0].releaseStop();
    await harness.drivers[0].closed;
    inbox.socket.close();
  });

  it('leaves a refused delete on a resumable run and says so', async () => {
    const harness = await makeHarness(undefined, { teardownFlushMs: 30 });
    const inbox = await harness.connect();
    const chatId = await newDevTeam(inbox);
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'start it' }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'interviewing');
    await until(() => harness.drivers[0].sent.length === 1);
    // A provider whose close never settles is the whole reason the delete is
    // refused.
    harness.drivers[0].holdStop = true;

    const blocked = await harness.ctx.deleteProjectChat(harness.root, chatId);

    expect(blocked).toMatchObject({
      status: 409,
      body: {
        ok: false,
        error:
          'The conversation was not deleted because an agent provider did not stop in time. Its run was interrupted; reopen it to resume or try deleting again.',
      },
    });
    expect(await getChat(harness.root, chatId)).not.toBeNull();
    await until(async () => (await readDevTeamState(harness.root, chatId)).phase === 'interrupted');
    expect(await readDevTeamState(harness.root, chatId)).toMatchObject({
      phase: 'interrupted',
      resumePhase: 'interviewing',
    });
    harness.drivers[0].releaseStop();
    await harness.drivers[0].closed;
    inbox.socket.close();
  });

  it('does not gate an ordinary conversation on a provider that is still working', async () => {
    const harness = await makeHarness(undefined, { teardownFlushMs: 30 });
    const inbox = await harness.connect();
    inbox.socket.send(JSON.stringify({ type: 'chat-new' }));
    const opened = await inbox.next((frame) => frame.type === 'chat-opened');
    if (opened.type !== 'chat-opened') throw new Error('expected chat-opened');
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'answer slowly' }));
    await until(() => harness.drivers.length === 1 && harness.drivers[0].sent.length === 1);
    harness.drivers[0].holdStop = true;

    const deleted = await harness.ctx.deleteProjectChat(harness.root, opened.chat.id);

    expect(deleted.status).toBe(200);
    expect(await getChat(harness.root, opened.chat.id)).toBeNull();
    harness.drivers[0].releaseStop();
    inbox.socket.close();
  });

  it('replays the tail of a long engineer lane and says where the rest is', async () => {
    const harness = await makeHarness();
    const inbox = await harness.connect();
    const chatId = await newDevTeam(inbox);
    const engineerId = 'engineer-long';
    const runDir = path.join(harness.root, '.hearth', 'devteam', chatId);
    await fsp.mkdir(path.join(runDir, 'engineers'), { recursive: true });
    const lines: string[] = [];
    for (let index = 0; index < 3000; index += 1) {
      lines.push(JSON.stringify({
        role: 'agent',
        ts: '2026-07-31T00:00:00.000Z',
        event: { type: 'message-delta', text: `line ${index}` },
      }));
    }
    await fsp.writeFile(path.join(runDir, 'engineers', `${engineerId}.jsonl`), `${lines.join('\n')}\n`);
    const stored = await readDevTeamState(harness.root, chatId);
    await writeDevTeamState(harness.root, chatId, {
      ...stored,
      runId: 'run-long',
      phase: 'done',
      tasks: [{ taskId: 't1', engineerId, status: 'done' }],
    });

    const reader = await harness.connect();
    reader.socket.send(JSON.stringify({ type: 'chat-open', chatId }));
    await reader.next((frame) => frame.type === 'devteam-state');
    await until(() => reader.frames.filter((frame) => frame.type === 'devteam-event').length >= 2001);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const events = reader.frames.filter((frame) => frame.type === 'devteam-event');
    expect(events).toHaveLength(2001);
    expect(events[0]).toEqual({
      type: 'devteam-event',
      chatId,
      engineerId,
      event: {
        type: 'message-delta',
        text: `…earlier activity in this lane is in .hearth/devteam/${chatId}/engineers/${engineerId}.jsonl\n`,
      },
    });
    const last = events[events.length - 1];
    expect(last.type === 'devteam-event' && last.event.type === 'message-delta' && last.event.text).toBe('line 2999');
    const first = events[1];
    expect(first.type === 'devteam-event' && first.event.type === 'message-delta' && first.event.text).toBe('line 1000');
    reader.socket.close();
    inbox.socket.close();
  });

  it('interrupts an active run when the server closes', async () => {
    const harness = await makeHarness();
    const inbox = await harness.connect();
    const chatId = await newDevTeam(inbox);
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'start it' }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'interviewing');
    await until(() => harness.drivers[0].sent.length === 1);
    inbox.socket.terminate();
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    await harness.wsClosed;
    expect((await readDevTeamState(harness.root, chatId)).phase).toBe('interrupted');
    expect((await readDevTeamState(harness.root, chatId)).error).toContain('closed');
  });

  it('does not let queued open and control work recreate a runtime during shutdown', async () => {
    let replayArmed = false;
    let shutdownQueueArmed = false;
    let replayReached!: () => void;
    let releaseReplay!: () => void;
    let controlQueued!: () => void;
    let sendQueued!: () => void;
    const reachedReplay = new Promise<void>((resolve) => { replayReached = resolve; });
    const replayRelease = new Promise<void>((resolve) => { releaseReplay = resolve; });
    const queuedControl = new Promise<void>((resolve) => { controlQueued = resolve; });
    const queuedSend = new Promise<void>((resolve) => { sendQueued = resolve; });
    const harness = await makeHarness(undefined, {
      beforeDevTeamReplaySend: async () => {
        if (!replayArmed) return;
        replayReached();
        await replayRelease;
      },
      onDevTeamControlQueued: () => controlQueued(),
      onChatSendQueued: () => {
        if (shutdownQueueArmed) sendQueued();
      },
    });
    const inbox = await harness.connect();
    const chatId = await newDevTeam(inbox);
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'start it' }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'interviewing');

    replayArmed = true;
    shutdownQueueArmed = true;
    inbox.socket.send(JSON.stringify({ type: 'chat-open', chatId }));
    await reachedReplay;
    inbox.socket.send(JSON.stringify({ type: 'devteam-stop' }));
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'late shutdown send' }));
    await queuedControl;
    await queuedSend;
    inbox.socket.terminate();
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    releaseReplay();
    await harness.wsClosed;

    expect((await readDevTeamState(harness.root, chatId)).phase).toBe('interrupted');
    expect((await readTranscript(harness.root, chatId)).some(
      (record) => record.role === 'user' && record.text === 'late shutdown send',
    )).toBe(false);
    expect(harness.drivers).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await readDevTeamState(harness.root, chatId)).phase).toBe('interrupted');
  });

  it('does not persist or deliver a prepared send after shutdown starts', async () => {
    let gateArmed = false;
    let sendReached!: () => void;
    let releaseSend!: () => void;
    const reached = new Promise<void>((resolve) => { sendReached = resolve; });
    const released = new Promise<void>((resolve) => { releaseSend = resolve; });
    const harness = await makeHarness(undefined, {
      beforeChatSendPersist: async () => {
        if (!gateArmed) return;
        sendReached();
        await released;
      },
    });
    const inbox = await harness.connect();
    inbox.socket.send(JSON.stringify({ type: 'chat-new' }));
    const opened = await inbox.next((frame) => frame.type === 'chat-opened');
    if (opened.type !== 'chat-opened') throw new Error('expected chat-opened');
    gateArmed = true;
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'must not land' }));
    await reached;

    inbox.socket.terminate();
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    releaseSend();
    await harness.wsClosed;

    expect((await readTranscript(harness.root, opened.chat.id)).some(
      (record) => record.role === 'user' && record.text === 'must not land',
    )).toBe(false);
    expect(harness.drivers[0].sent).toEqual([]);
  });

  it('bounds shutdown when a provider ignores stop', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = await makeHarness(undefined, { teardownFlushMs: 30 });
    const inbox = await harness.connect();
    const chatId = await newDevTeam(inbox);
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'start it' }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'interviewing');
    harness.drivers[0].holdStop = true;

    inbox.socket.terminate();
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    await harness.wsClosed;

    expect((await readDevTeamState(harness.root, chatId)).phase).toBe('interrupted');
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('did not close'));
    harness.drivers[0].releaseStop();
    await harness.drivers[0].closed;
  });

  it('does not await closed on a driver shutdown catches before start', async () => {
    let factoryReached!: () => void;
    let releaseFactory!: () => void;
    const reached = new Promise<void>((resolve) => { factoryReached = resolve; });
    const released = new Promise<void>((resolve) => { releaseFactory = resolve; });
    const driver = new FakeDriver();
    driver.closedBeforeStartNever = true;
    const harness = await makeHarness(async () => {
      factoryReached();
      await released;
      return driver;
    }, { teardownFlushMs: 30 });
    const inbox = await harness.connect();
    inbox.socket.send(JSON.stringify({ type: 'chat-new' }));
    await inbox.next((frame) => frame.type === 'chat-opened');
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'start binding' }));
    await reached;

    inbox.socket.terminate();
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    releaseFactory();
    await harness.wsClosed;

    expect(driver.starts).toEqual([]);
    expect(driver.stopped).toBe(true);
  });

  it('disposes active engineer work before deleting a dev team conversation', async () => {
    const harness = await makeHarness(undefined, { teardownFlushMs: 30 });
    const inbox = await harness.connect();
    const chatId = await newDevTeam(inbox);
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'build this' }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'interviewing');
    await until(() => harness.drivers[0].sent.length === 1);
    await fsp.mkdir(path.join(harness.root, '.hearth', 'devteam', chatId), { recursive: true });
    await fsp.writeFile(path.join(harness.root, '.hearth', 'devteam', chatId, 'spec.md'), '# Spec\n');
    harness.drivers[0].emit({ type: 'turn-complete' });
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'spec-review');
    inbox.socket.send(JSON.stringify({ type: 'devteam-approve-spec' }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'planning');
    await fsp.writeFile(path.join(harness.root, '.hearth', 'devteam', chatId, 'plan.json'), JSON.stringify({
      version: 1,
      roles: [{ id: 'maker', name: 'Maker', focus: 'Build.' }],
      milestones: [{
        id: 'm1', title: 'Build', goal: 'Build.',
        tasks: [
          { id: 't1', title: 'First', roleId: 'maker', detail: 'First.', scope: ['src/first'] },
          { id: 't2', title: 'Second', roleId: 'maker', detail: 'Second.', dependsOn: ['t1'], scope: ['src/second'] },
        ],
      }],
    }));
    harness.drivers[0].emit({ type: 'turn-complete' });
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'building');
    await until(() => harness.drivers.length === 2 && harness.drivers[1].sent.length === 1);
    const engineer = harness.drivers[1];
    engineer.emit({
      type: 'approval-request', approvalId: 'delete-approval', kind: 'command', title: 'Write a file', detail: 'src/first',
    });
    await inbox.next((frame) => frame.type === 'devteam-event' && frame.event.type === 'approval-request');
    const engineerId = (await readDevTeamState(harness.root, chatId)).tasks[0].engineerId;
    const runDir = path.join(harness.root, '.hearth', 'devteam', chatId);

    engineer.holdStop = true;
    const blocked = await harness.ctx.deleteProjectChat(harness.root, ` ${chatId} `);

    expect(blocked).toMatchObject({
      status: 409,
      body: { ok: false, error: expect.stringContaining('provider') },
    });
    expect(await getChat(harness.root, chatId)).not.toBeNull();
    expect(await fsp.stat(runDir).catch(() => null)).not.toBeNull();
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'must wait for the old provider' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.drivers).toHaveLength(2);
    expect((await readTranscript(harness.root, chatId)).some(
      (record) => record.role === 'user' && record.text === 'must wait for the old provider',
    )).toBe(false);
    engineer.releaseStop();
    await engineer.closed;

    const deleted = await harness.ctx.deleteProjectChat(harness.root, ` ${chatId} `);

    expect(deleted.status).toBe(200);
    expect(await getChat(harness.root, chatId)).toBeNull();
    expect(engineer.interrupted).toBe(true);
    expect(engineer.stopped).toBe(true);
    expect(harness.drivers).toHaveLength(2);
    expect(inbox.frames).toContainEqual({
      type: 'devteam-event',
      chatId,
      engineerId,
      event: { type: 'approval-resolved', approvalId: 'delete-approval', decision: 'withdrawn' },
    });
    expect(await fsp.stat(runDir).catch(() => null)).toBeNull();

    engineer.emit({ type: 'turn-complete' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.drivers).toHaveLength(2);
    expect(await fsp.stat(runDir).catch(() => null)).toBeNull();
    inbox.socket.close();
  });
});
