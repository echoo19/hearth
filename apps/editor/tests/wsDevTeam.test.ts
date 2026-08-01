import { afterEach, describe, expect, it } from 'vitest';
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
import { readDevTeamState, readEngineerRecords } from '../server/devTeamStore';
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
  private readonly startGate: Promise<void> | null;
  private releaseStartGate: (() => void) | null = null;

  constructor(holdStart = false) {
    this.startGate = holdStart
      ? new Promise<void>((resolve) => {
          this.releaseStartGate = resolve;
        })
      : null;
  }

  get events(): AsyncIterable<ChatEvent> {
    this.eventReaders += 1;
    return this.queue;
  }

  async start(id: string, root: string): Promise<void> {
    this.starts.push({ id, root });
    if (this.startGate) await this.startGate;
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
  }

  releaseStop(...events: ChatEvent[]): void {
    for (const event of events) this.queue.push(event);
    this.queue.close();
  }

  closeStream(): void {
    this.queue.close();
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
  connect(): Promise<Inbox>;
  close(): Promise<void>;
}

const openHarnesses = new Set<Harness>();

async function until(ready: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function makeHarness(
  factory?: (options: Harness['options'][number] | undefined) => Promise<ChatDriver>,
  hooks?: { beforeDevTeamReplaySend?: () => Promise<void> },
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
  attachWebSocket(server, ctx, new NoopPtyBackend(), async () => process.env, {
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
        async next(match, timeoutMs = 4000) {
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
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'done');
    const sentBeforeFollowup = harness.drivers[1].sent.length;
    inbox.socket.send(JSON.stringify({
      type: 'chat-send',
      text: 'ordinary follow-up',
      agent: { provider: 'anthropic', model: 'model-b' },
    }));
    await until(() => harness.drivers[1].sent.length === sentBeforeFollowup + 1);
    expect(harness.drivers[1].sent.at(-1)?.text).toBe('ordinary follow-up');
    expect(await readDevTeamState(harness.root, chatId)).toMatchObject({ runId, phase: 'done' });
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
    await until(async () => (await readDevTeamState(harness.root, chatId)).steering.length === 1);
    const interrupted = await readDevTeamState(harness.root, chatId);
    expect(interrupted.resumePhase).toBe('planning');
    expect(interrupted.steering.map((item) => item.text)).toEqual(['new provider detail']);
    expect(harness.drivers[1].sent).toEqual([]);

    await fsp.writeFile(path.join(harness.root, '.hearth', 'devteam', chatId, 'plan.json'), JSON.stringify({
      version: 1,
      roles: [{ id: 'maker', name: 'Maker', focus: 'Build.' }],
      milestones: [{
        id: 'm1', title: 'Build', goal: 'Build.',
        tasks: [{ id: 't1', title: 'Implement', roleId: 'maker', detail: 'Implement.', scope: ['src'] }],
      }],
    }));
    harness.drivers[0].releaseStop({ type: 'turn-complete' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await readDevTeamState(harness.root, chatId)).phase).toBe('interrupted');

    const beforeResume = harness.drivers[1].sent.length;
    inbox.socket.send(JSON.stringify({ type: 'devteam-resume' }));
    await until(() => harness.drivers[1].sent.length === beforeResume + 1);
    expect(harness.drivers[1].sent).toHaveLength(beforeResume + 1);
    expect(harness.drivers[1].sent[0].text).toContain('new provider detail');
    harness.drivers[1].holdStop = true;
    inbox.socket.send(JSON.stringify({
      type: 'chat-send', text: 'second provider detail', agent: { provider: 'anthropic', model: 'model-c' },
    }));
    await until(() => harness.drivers.length === 3);
    await until(async () => (await readDevTeamState(harness.root, chatId)).phase === 'interrupted');
    await until(async () => (await readDevTeamState(harness.root, chatId)).steering.length === 2);
    expect((await readDevTeamState(harness.root, chatId)).steering.map((item) => item.text)).toEqual([
      'new provider detail',
      'second provider detail',
    ]);
    expect(harness.drivers[2].sent).toEqual([]);
    harness.drivers[1].releaseStop({ type: 'turn-complete' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await readDevTeamState(harness.root, chatId)).phase).toBe('interrupted');

    inbox.socket.send(JSON.stringify({ type: 'devteam-resume' }));
    await until(() => harness.drivers[2].sent.length === 1);
    expect(harness.drivers[2].sent[0].text).toContain('new provider detail');
    expect(harness.drivers[2].sent[0].text).toContain('second provider detail');
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
    inbox.socket.send(JSON.stringify({ type: 'chat-open', chatId }));
    await until(() =>
      inbox.frames.some((frame) => frame.type === 'chat-opened') &&
      inbox.frames.some((frame) => frame.type === 'devteam-state' && frame.state.phase === 'paused'),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(inbox.frames.filter((frame) => frame.type === 'devteam-state' && frame.state.phase === 'paused')).toHaveLength(1);
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

  it('interrupts an active run when the server closes', async () => {
    const harness = await makeHarness();
    const inbox = await harness.connect();
    const chatId = await newDevTeam(inbox);
    inbox.socket.send(JSON.stringify({ type: 'chat-send', text: 'start it' }));
    await inbox.next((frame) => frame.type === 'devteam-state' && frame.state.phase === 'interviewing');
    await until(() => harness.drivers[0].sent.length === 1);
    inbox.socket.terminate();
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    await until(async () => (await readDevTeamState(harness.root, chatId)).phase === 'interrupted');
    expect((await readDevTeamState(harness.root, chatId)).error).toContain('closed');
  });

  it('disposes active engineer work before deleting a dev team conversation', async () => {
    const harness = await makeHarness();
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

    const deleted = await harness.ctx.deleteProjectChat(harness.root, chatId);

    expect(deleted.status).toBe(200);
    expect(await getChat(harness.root, chatId)).toBeNull();
    expect(engineer.interrupted).toBe(true);
    expect(engineer.stopped).toBe(true);
    expect(harness.drivers).toHaveLength(2);
    expect(await readEngineerRecords(harness.root, chatId, engineerId)).toContainEqual({
      role: 'agent',
      ts: expect.any(String),
      event: { type: 'approval-resolved', approvalId: 'delete-approval', decision: 'withdrawn' },
    });
    expect(await readDevTeamState(harness.root, chatId)).toMatchObject({
      phase: 'interrupted',
      tasks: [
        expect.objectContaining({ taskId: 't1', status: 'interrupted' }),
        expect.objectContaining({ taskId: 't2', status: 'pending' }),
      ],
    });

    engineer.emit({ type: 'turn-complete' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.drivers).toHaveLength(2);
    expect((await readDevTeamState(harness.root, chatId)).phase).toBe('interrupted');
    inbox.socket.close();
  });
});
