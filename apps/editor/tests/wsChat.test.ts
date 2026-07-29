/**
 * Integration test for the `chat` channel over /api/ws: a bare node:http
 * server with attachWebSocket, a real `ws` client, and a scripted ChatDriver
 * injected through the test seam so no agent backend is ever resolved here.
 *
 * The channel shares its socket with the pty and journal channels, so these
 * also pin the separation: a conversation is per-socket, it dies with its
 * window, and tearing it down leaves the rest of the socket alone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createProjectServerContext, type ProjectServerContext } from '../server/projectServer';
import { attachWebSocket, type WsFrame } from '../server/ws';
import { EventQueue, type AgentTurnOptions, type ChatDriver, type ChatEvent } from '../server/chat';
import { deleteChat, listChats, readTranscript } from '../server/chatStore';
import { writePermissionMode, type PermissionMode } from '../server/permissionMode';

/** A driver that answers every turn with a fixed script, and records its life. */
class ScriptedDriver implements ChatDriver {
  readonly kind = 'stub' as const;
  queue = new EventQueue<ChatEvent>();
  sent: string[] = [];
  /** The per-turn model/effort choice each send carried, in order. */
  sentAgents: (AgentTurnOptions | undefined)[] = [];
  /** The choice this driver was BOUND with (decides which backend answers). */
  boundAgent: AgentTurnOptions | null | undefined;
  /** The permission mode this driver was BOUND with. Fixed for its lifetime. */
  boundPermissionMode: PermissionMode | null | undefined;
  startedIn: string | null = null;
  stopped = false;
  /** When set, `start` throws it: a backend that refuses to bind. */
  startError: string | null = null;
  /**
   * When set, a send is recorded and answered with nothing: a turn that went to
   * work. The default script answers instantly, which no real backend does.
   */
  silent = false;
  /** When set, the driver's last words reach its stream a tick after `stop()`. */
  slowTeardown = false;
  private finished = false;
  /** Set by `blockBind`: `start` waits on it, so a bind can be held open. */
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;
  /**
   * Set by `holdTeardown`: `stop()` returns at once but its last words wait
   * here. Same shape as `slowTeardown` with the timer replaced by the test, so
   * an ordering assertion is about the order and not about who won a race.
   */
  private teardownGate: Promise<void> | null = null;
  private openTeardown: (() => void) | null = null;
  /** Approvals raised and not yet answered, exactly as the real drivers hold them. */
  private pending = new Set<string>();

  get events(): AsyncIterable<ChatEvent> {
    return this.queue;
  }

  get dead(): boolean {
    return this.finished;
  }

  async start(_sessionId: string, projectRoot: string): Promise<void> {
    this.startedIn = projectRoot;
    if (this.startError) throw new Error(this.startError);
    if (this.gate) await this.gate;
  }

  /** Hold the bind open, the way a real backend takes a moment to come up. */
  blockBind(): void {
    this.gate = new Promise<void>((resolve) => {
      this.openGate = resolve;
    });
  }

  releaseBind(): void {
    this.openGate?.();
    this.openGate = null;
  }

  /** Hold this driver's last words back until the test asks for them. */
  holdTeardown(): void {
    this.teardownGate = new Promise<void>((resolve) => {
      this.openTeardown = resolve;
    });
  }

  releaseTeardown(): void {
    this.openTeardown?.();
    this.openTeardown = null;
  }

  send(text: string, agent?: AgentTurnOptions): void {
    if (this.finished) return; // a dead backend answers nothing, silently
    this.sent.push(text);
    this.sentAgents.push(agent);
    if (this.silent) return;
    this.queue.push({ type: 'text-delta', text: `echo:${text}` });
    this.queue.push({ type: 'done' });
  }

  /** Ask the windows for permission. The turn is blocked until it is answered. */
  ask(approvalId: string, title: string): void {
    this.pending.add(approvalId);
    this.queue.push({ type: 'approval-request', approvalId, kind: 'command', title, detail: 'rm -rf /tmp/x' });
  }

  approve(approvalId: string, decision: 'allow' | 'deny'): void {
    if (!this.pending.delete(approvalId)) return;
    this.queue.push({ type: 'approval-resolved', approvalId, decision });
  }

  /**
   * The backend goes away underneath a live conversation: the pipe to the child
   * drops, or the SDK's subprocess exits. Exactly what CodexDriver does on a
   * transport loss, which is to say what every driver now has to do.
   */
  die(reason: string): void {
    this.queue.push({ type: 'error', message: reason });
    this.finished = true;
    this.queue.close();
  }

  /**
   * A turn that starts and then goes silent: the stream ends mid-turn with no
   * error and no completion. This is the Agent SDK's generator returning, which
   * says nothing at all on its way out.
   */
  vanish(): void {
    this.queue.push({ type: 'text-delta', text: 'thinking' });
    this.finished = true;
    this.queue.close();
  }

  stop(): void {
    this.stopped = true;
    this.finished = true;
    const finish = (): void => {
      // What both real backends do on the way out: whatever was still blocking
      // the agent is answered `deny`, and the windows are told so, before the
      // stream ends. See AgentSdkDriver.stop and CodexDriver.stop.
      for (const approvalId of this.pending) {
        this.queue.push({ type: 'approval-resolved', approvalId, decision: 'deny' });
      }
      this.pending.clear();
      this.openGate?.(); // a bind held open must not outlive the driver
      this.queue.close();
    };
    // A backend does not always have its last words ready the instant it is
    // asked to stop: the Agent SDK answers a blocked permission callback
    // through a promise chain, so the resolution reaches the stream a tick
    // after `stop()` has returned.
    if (this.teardownGate) void this.teardownGate.then(finish);
    else if (this.slowTeardown) setTimeout(finish, 20);
    else finish();
  }
}

let tmp: string;
let root: string;
let ctx: ProjectServerContext;
let server: http.Server;
let port: number;
let drivers: ScriptedDriver[] = [];
let previousHome: string | undefined;
/** Applied to the NEXT driver the server binds, then cleared. */
let nextBindFails: string | null = null;
/** Run against the NEXT driver the server binds, before it is started. */
let nextDriverSetup: ((driver: ScriptedDriver) => void) | null = null;

/** Poll until `ready` is true, so a test waits on a fact rather than a delay. */
async function until(ready: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function connect(): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws?project=${encodeURIComponent(root)}`);
  return new Promise((resolve, reject) => {
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
}

/** Resolve once a frame matching `match` arrives, else reject on timeout. */
function nextFrame(socket: WebSocket, match: (frame: WsFrame) => boolean, timeoutMs = 4000): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('timed out waiting for frame'));
    }, timeoutMs);
    function onMessage(raw: WebSocket.RawData): void {
      let frame: WsFrame;
      try {
        frame = JSON.parse(raw.toString()) as WsFrame;
      } catch {
        return;
      }
      if (!match(frame)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(frame);
    }
    socket.on('message', onMessage);
  });
}

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-wschat-'));
  root = path.join(tmp, 'game');
  await fsp.mkdir(root, { recursive: true });
  // Per-machine preferences (the permission mode among them) are read while a
  // driver binds, so the whole file runs against a throwaway ~/.hearth rather
  // than whatever the person running the suite has chosen.
  previousHome = process.env.HEARTH_HOME;
  process.env.HEARTH_HOME = path.join(tmp, 'hearth-home');
  ctx = createProjectServerContext({ recentsFile: path.join(tmp, 'recents.json'), repoRoot: tmp });
  // The /api/ws upgrade only accepts roots this server has been asked to open,
  // so a suite that connects has to open the folder first, exactly as the app
  // does before it connects its socket.
  await ctx.openWorkspace(root);
  server = http.createServer();
  attachWebSocket(server, ctx, undefined, undefined, {
    createChatDriver: async (_root, options) => {
      const driver = new ScriptedDriver();
      driver.boundAgent = options?.agent;
      driver.boundPermissionMode = options?.permissionMode;
      driver.startError = nextBindFails;
      nextBindFails = null;
      nextDriverSetup?.(driver);
      nextDriverSetup = null;
      drivers.push(driver);
      return driver;
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  // Awaited, not fired. Chat writes are deliberately detached (see
  // `enqueueChatLane` and `endChatTurn` in server/ws.ts): a turn's last
  // records are still being appended after the socket is done with them, by
  // design. So the folder has to stop being written to before it is removed.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousHome === undefined) delete process.env.HEARTH_HOME;
  else process.env.HEARTH_HOME = previousHome;
  // `maxRetries` is Node's answer to the Windows rule that a directory with an
  // open handle cannot be removed. On POSIX an in-flight append is invisible
  // here, because unlinking an open file is allowed; on Windows the same race
  // is `ENOTEMPTY: rmdir ...\.hearth\chats`, which failed the release build
  // with all 4493 tests passing and nothing wrong with any of them.
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe('chat channel', () => {
  it('binds a driver on the first send and reports which one answered', async () => {
    drivers = [];
    const socket = await connect();
    const ready = nextFrame(socket, (frame) => frame.type === 'chat-ready');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'make a shooter' }));
    expect(await ready).toEqual({ type: 'chat-ready', driver: 'stub' });
    expect(drivers).toHaveLength(1);
    expect(drivers[0].startedIn).toBe(root);
    socket.close();
  });

  it('streams the turn back as chat-event frames', async () => {
    drivers = [];
    const socket = await connect();
    const done = new Promise<ChatEvent[]>((resolve) => {
      const seen: ChatEvent[] = [];
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as WsFrame;
        if (frame.type !== 'chat-event') return;
        seen.push(frame.event);
        if (frame.event.type === 'done') resolve(seen);
      });
    });
    socket.send(JSON.stringify({ type: 'chat-send', text: 'hello' }));
    expect(await done).toEqual([{ type: 'text-delta', text: 'echo:hello' }, { type: 'done' }]);
    socket.close();
  });

  it('reuses the same driver for later turns on the same socket', async () => {
    drivers = [];
    const socket = await connect();
    await nextFrame(socket, (frame) => frame.type === 'chat-ready', 4000).catch(() => null);
    socket.send(JSON.stringify({ type: 'chat-send', text: 'one' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'two' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    expect(drivers).toHaveLength(1);
    expect(drivers[0].sent).toEqual(['one', 'two']);
    socket.close();
  });

  it('carries the turn’s agent choice to the binding and to the send', async () => {
    drivers = [];
    const socket = await connect();
    const agent = { provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' };
    socket.send(JSON.stringify({ type: 'chat-send', text: 'make a shooter', agent }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    expect(drivers[0].boundAgent).toEqual(agent);
    expect(drivers[0].sentAgents).toEqual([agent]);
    socket.close();
  });

  it('behaves exactly as before when the frame carries no agent field', async () => {
    drivers = [];
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-send', text: 'no choice here' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    expect(drivers[0].boundAgent).toBeNull();
    expect(drivers[0].sentAgents).toEqual([undefined]);
    socket.close();
  });

  it('drops an unusable agent field rather than failing the turn', async () => {
    drivers = [];
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-send', text: 'still works', agent: { provider: 'nobody', effort: 9 } }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    expect(drivers[0].boundAgent).toBeNull();
    expect(drivers[0].sent).toEqual(['still works']);
    socket.close();
  });

  it('ignores an empty send rather than binding a backend for nothing', async () => {
    drivers = [];
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-send', text: '   ' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(drivers).toHaveLength(0);
    socket.close();
  });

  it('gives each window its own conversation', async () => {
    drivers = [];
    const a = await connect();
    const b = await connect();
    a.send(JSON.stringify({ type: 'chat-send', text: 'from a' }));
    b.send(JSON.stringify({ type: 'chat-send', text: 'from b' }));
    await nextFrame(a, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    await nextFrame(b, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    expect(drivers).toHaveLength(2);
    expect(drivers.map((driver) => driver.sent)).toEqual([['from a'], ['from b']]);
    a.close();
    b.close();
  });

  it('stops the driver when the conversation is cancelled', async () => {
    drivers = [];
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-send', text: 'hi' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    socket.send(JSON.stringify({ type: 'chat-cancel' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(drivers[0].stopped).toBe(true);
    socket.close();
  });

  it('stops the driver when the socket drops — a conversation is not resumable', async () => {
    drivers = [];
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-send', text: 'hi' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(drivers[0].stopped).toBe(true);
  });
});

/**
 * Changing the permission mode has to take effect on the NEXT turn.
 *
 * Neither backend can be told about it mid-session: codex fixes the policy at
 * `thread/start` and the Agent SDK at `query()`. So a mode change that only
 * applied to the following conversation would be a permission control that
 * silently does nothing, which is worse than not offering one. ws.ts rebinds
 * instead, and these pin both halves of that: it rebinds when the mode moved,
 * and it does NOT when it did not (a rebind per turn would restart the agent
 * and lose everything it had in context).
 */
describe('a permission mode change', () => {
  it('binds the stored mode, and today’s default when nothing is stored', async () => {
    drivers = [];
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-send', text: 'one' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    expect(drivers[0].boundPermissionMode).toBe('auto');
    socket.close();
  });

  it('rebuilds the driver before the next turn, and hands the new mode to it', async () => {
    drivers = [];
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-send', text: 'one' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');

    await writePermissionMode(root, 'skip');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'two' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');

    expect(drivers).toHaveLength(2);
    expect(drivers[0].stopped).toBe(true);
    expect(drivers[1].boundPermissionMode).toBe('skip');
    // The turn that triggered the rebind is answered by the NEW driver, not
    // lost and not delivered to the one that was already torn down.
    expect(drivers[1].sent).toEqual(['two']);
    expect(drivers[0].sent).toEqual(['one']);

    await writePermissionMode(root, 'auto');
    socket.close();
  });

  it('keeps the same driver when the mode has not moved', async () => {
    drivers = [];
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-send', text: 'one' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'two' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    expect(drivers).toHaveLength(1);
    expect(drivers[0].sent).toEqual(['one', 'two']);
    socket.close();
  });
});

/**
 * Picking a different agent mid-conversation, which is the same argument as the
 * mode above and bites harder.
 *
 * Which program answers is fixed when a driver is built, and the composer's
 * pill NAMES the agent it believes is answering. A pick that only took effect
 * on the next conversation would leave the app showing one agent's name while
 * another one did the work, which is the exact failure the whole
 * bring-your-own-agent path is written to prevent.
 */
describe('a change of agent', () => {
  it('rebinds when the turn names a different agent, and hands it the id', async () => {
    drivers = [];
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-send', text: 'one', agent: { agentId: 'my-agent' } }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    expect(drivers[0].boundAgent).toEqual({ agentId: 'my-agent' });

    socket.send(JSON.stringify({ type: 'chat-send', text: 'two', agent: { agentId: 'other-agent' } }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    expect(drivers).toHaveLength(2);
    expect(drivers[0].stopped).toBe(true);
    expect(drivers[1].boundAgent).toEqual({ agentId: 'other-agent' });
    expect(drivers[1].sent).toEqual(['two']);
    socket.close();
  });

  it('rebinds when the turn goes back to a vendor model', async () => {
    drivers = [];
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-send', text: 'one', agent: { agentId: 'my-agent' } }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    socket.send(
      JSON.stringify({ type: 'chat-send', text: 'two', agent: { provider: 'anthropic', model: 'claude-opus-5' } }),
    );
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    expect(drivers).toHaveLength(2);
    expect(drivers[1].boundAgent).toEqual({ provider: 'anthropic', model: 'claude-opus-5' });
    socket.close();
  });

  it('keeps the driver for the same agent, and for a turn that chooses nothing', async () => {
    // A rebind per turn would restart the agent and lose everything it held in
    // context, and a client that predates the selector sends no `agent` at all.
    drivers = [];
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-send', text: 'one', agent: { agentId: 'my-agent' } }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'two', agent: { agentId: 'my-agent' } }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'three' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    expect(drivers).toHaveLength(1);
    expect(drivers[0].sent).toEqual(['one', 'two', 'three']);
    socket.close();
  });
});

/**
 * History is the part that outlives the process. These pin the promise the
 * sidebar makes: every turn is on disk as it streams, reopening a chat replays
 * it, and the index tracks what happened without the client maintaining it.
 */
describe('chat history', () => {
  it('creates a chat on chat-new and answers with an empty transcript', async () => {
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-new' }));
    const opened = await nextFrame(socket, (frame) => frame.type === 'chat-opened');
    if (opened.type !== 'chat-opened') throw new Error('wrong frame');
    expect(opened.records).toEqual([]);
    expect(opened.chat.title).toBe('New chat');
    // Opened, and in no list. A conversation nobody has said anything in is
    // not one the sidebar should be offering to go back to.
    expect((await listChats(root)).some((chat) => chat.id === opened.chat.id)).toBe(false);
    socket.close();
  });

  it('lists the chat as soon as something is said in it, without being asked again', async () => {
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-new' }));
    const opened = await nextFrame(socket, (frame) => frame.type === 'chat-opened');
    if (opened.type !== 'chat-opened') throw new Error('wrong frame');

    // The rail redraws on the broadcast, so the message landing has to be what
    // sends it: nothing else is going to come along and refresh the list.
    const listed = nextFrame(
      socket,
      (frame) => frame.type === 'chat-list' && frame.chats.some((chat) => chat.id === opened.chat.id),
    );
    socket.send(JSON.stringify({ type: 'chat-send', text: 'make a shooter' }));
    const frame = await listed;
    if (frame.type !== 'chat-list') throw new Error('wrong frame');
    expect(frame.chats.find((chat) => chat.id === opened.chat.id)?.title).toBe('make a shooter');
    socket.close();
  });

  it('appends every turn and tool event to the transcript as it streams', async () => {
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-new' }));
    const opened = await nextFrame(socket, (frame) => frame.type === 'chat-opened');
    if (opened.type !== 'chat-opened') throw new Error('wrong frame');

    socket.send(JSON.stringify({ type: 'chat-send', text: 'make a shooter' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    // The `done` frame is sent after its own append, but give the index write
    // (which follows) a tick to land.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const records = await readTranscript(root, opened.chat.id);
    expect(records[0]).toMatchObject({ role: 'user', text: 'make a shooter' });
    expect(records.slice(1).map((record) => (record.role === 'agent' ? record.event : null))).toEqual([
      { type: 'text-delta', text: 'echo:make a shooter' },
      { type: 'done' },
    ]);
    socket.close();
  });

  it('names the chat from the first user message and reports it as a chat-list', async () => {
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-new' }));
    const opened = await nextFrame(socket, (frame) => frame.type === 'chat-opened');
    if (opened.type !== 'chat-opened') throw new Error('wrong frame');

    socket.send(JSON.stringify({ type: 'chat-send', text: 'a top-down space shooter' }));
    const listed = await nextFrame(
      socket,
      (frame) => frame.type === 'chat-list' && frame.chats.some((chat) => chat.title === 'a top-down space shooter'),
    );
    if (listed.type !== 'chat-list') throw new Error('wrong frame');
    expect(listed.chats.find((chat) => chat.id === opened.chat.id)?.title).toBe('a top-down space shooter');
    socket.close();
  });

  it('replays a chat from disk when a NEW socket opens it — live state is not required', async () => {
    const first = await connect();
    first.send(JSON.stringify({ type: 'chat-new' }));
    const opened = await nextFrame(first, (frame) => frame.type === 'chat-opened');
    if (opened.type !== 'chat-opened') throw new Error('wrong frame');
    first.send(JSON.stringify({ type: 'chat-send', text: 'hello' }));
    await nextFrame(first, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    await new Promise((resolve) => setTimeout(resolve, 150));
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const second = await connect();
    second.send(JSON.stringify({ type: 'chat-open', chatId: opened.chat.id }));
    const replay = await nextFrame(second, (frame) => frame.type === 'chat-opened');
    if (replay.type !== 'chat-opened') throw new Error('wrong frame');
    expect(replay.chat.id).toBe(opened.chat.id);
    expect(replay.records.map((record) => record.role)).toEqual(['user', 'agent', 'agent']);
    expect(replay.records[0]).toMatchObject({ role: 'user', text: 'hello' });
    second.close();
  });

  it('ignores a chat-open for an id that is not in the index', async () => {
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-open', chatId: '../escape' }));
    socket.send(JSON.stringify({ type: 'chat-open', chatId: 'does-not-exist' }));
    await expect(nextFrame(socket, (frame) => frame.type === 'chat-opened', 400)).rejects.toThrow();
    socket.close();
  });

  it('keeps two chats on one folder separate, each with its own driver', async () => {
    drivers = [];
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-new' }));
    const a = await nextFrame(socket, (frame) => frame.type === 'chat-opened');
    if (a.type !== 'chat-opened') throw new Error('wrong frame');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'in a' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');

    socket.send(JSON.stringify({ type: 'chat-new' }));
    const b = await nextFrame(socket, (frame) => frame.type === 'chat-opened');
    if (b.type !== 'chat-opened') throw new Error('wrong frame');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'in b' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(a.chat.id).not.toBe(b.chat.id);
    expect(drivers).toHaveLength(2);
    expect((await readTranscript(root, a.chat.id))[0]).toMatchObject({ text: 'in a' });
    expect((await readTranscript(root, b.chat.id))[0]).toMatchObject({ text: 'in b' });
    socket.close();
  });
});

/**
 * A backend that goes away must not eat everything typed after it.
 *
 * This is the failure the whole chat channel was quietly built on. A driver
 * whose transport died closed its event stream and nothing else: the session
 * stayed in the server's map, so the next message was handed to a driver that
 * could no longer answer, appended to the transcript, and dropped. Nothing came
 * back, so the composer stayed busy and diverted every message after that into
 * a queue that was never drained. One message orphaned unanswered, the rest
 * gone before they ever touched disk, and reconnecting rejoined the same corpse.
 *
 * Three things have to be true, and each of them is one of these tests: the
 * session is gone, the window is told, and the next message binds a fresh
 * backend and is answered by it.
 */
describe('a conversation whose backend dies', () => {
  it('tells the window the turn is over instead of leaving it waiting', async () => {
    drivers = [];
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-send', text: 'hello' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');

    const failed = nextFrame(
      socket,
      (frame) => frame.type === 'chat-event' && frame.event.type === 'error',
    );
    drivers[0].die('codex app-server exited');
    const frame = await failed;
    if (frame.type !== 'chat-event' || frame.event.type !== 'error') throw new Error('wrong frame');
    expect(frame.event.message).toBe('codex app-server exited');
    socket.close();
  });

  it('binds a fresh backend for the next message, and answers it', async () => {
    drivers = [];
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-new' }));
    const opened = await nextFrame(socket, (frame) => frame.type === 'chat-opened');
    if (opened.type !== 'chat-opened') throw new Error('wrong frame');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'one' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');

    drivers[0].die('the pipe closed');
    await new Promise((resolve) => setTimeout(resolve, 150));

    socket.send(JSON.stringify({ type: 'chat-send', text: 'two' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    await new Promise((resolve) => setTimeout(resolve, 150));

    // A SECOND driver answered, and it got the message the first one could not.
    expect(drivers).toHaveLength(2);
    expect(drivers[0].sent).toEqual(['one']);
    expect(drivers[1].sent).toEqual(['two']);
    // And every word of it is on disk, in order, under the right chat.
    const records = await readTranscript(root, opened.chat.id);
    const said = records.filter((record) => record.role === 'user').map((record) =>
      record.role === 'user' ? record.text : '',
    );
    expect(said).toEqual(['one', 'two']);
    socket.close();
  });

  it('stops the dead driver and lets the transcript keep the failure', async () => {
    drivers = [];
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-new' }));
    const opened = await nextFrame(socket, (frame) => frame.type === 'chat-opened');
    if (opened.type !== 'chat-opened') throw new Error('wrong frame');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'hello' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');

    drivers[0].die('backend went away');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(drivers[0].stopped).toBe(true);

    // What the window saw live is what it finds when it comes back.
    const records = await readTranscript(root, opened.chat.id);
    expect(records[records.length - 1]).toMatchObject({
      role: 'agent',
      event: { type: 'error', message: 'backend went away' },
    });
    socket.close();
  });

  it('reports a stream that simply STOPS, so nothing spins forever', async () => {
    drivers = [];
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-send', text: 'hello' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');

    const ended = nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'error');
    // A turn starts and the stream ends under it: no error, no explanation.
    // The server has to name it, or the window waits on a turn nobody will end.
    drivers[0].vanish();
    const frame = await ended;
    if (frame.type !== 'chat-event' || frame.event.type !== 'error') throw new Error('wrong frame');
    expect(frame.event.message).toMatch(/stopped answering/);
    socket.close();
  });
});

/**
 * A bind that fails takes the backend down with it and keeps what was typed.
 *
 * CodexDriver spawns its child BEFORE the handshake, so a driver that is not
 * stopped when `start()` throws leaves a `codex app-server` running forever,
 * one per attempt. And the message that triggered the bind is a message the
 * person wrote: the failure is not theirs, so it must not cost them their words.
 */
describe('a backend that refuses to bind', () => {
  it('stops the driver rather than orphaning its child', async () => {
    drivers = [];
    nextBindFails = 'codex initialize timed out';
    const socket = await connect();
    const failed = nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'error');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'make a shooter' }));
    const frame = await failed;
    if (frame.type !== 'chat-event' || frame.event.type !== 'error') throw new Error('wrong frame');
    expect(frame.event.message).toBe('codex initialize timed out');
    expect(drivers[0].stopped).toBe(true);
    socket.close();
  });

  it('still writes down the message the user typed', async () => {
    drivers = [];
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-new' }));
    const opened = await nextFrame(socket, (frame) => frame.type === 'chat-opened');
    if (opened.type !== 'chat-opened') throw new Error('wrong frame');

    nextBindFails = 'no agent backend is reachable';
    socket.send(JSON.stringify({ type: 'chat-send', text: 'a top-down space shooter' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'error');
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await readTranscript(root, opened.chat.id)).toMatchObject([
      { role: 'user', text: 'a top-down space shooter' },
    ]);
    // And it named the conversation, so the sidebar shows what was asked.
    expect((await listChats(root)).find((chat) => chat.id === opened.chat.id)?.title).toBe(
      'a top-down space shooter',
    );
    socket.close();
  });
});

/**
 * Interrupting a conversation two windows are watching.
 *
 * The Agent SDK has no interrupt, so the fallback is a coarse teardown. It used
 * to be `stopChat`, which with a second socket present only removes THIS window
 * from the session: the window that asked for silence got it by going deaf,
 * while the agent carried on talking to the other one. The teardown has to take
 * the whole session, and both windows have to come back onto the next driver.
 */
describe('chat-interrupt with two windows on one conversation', () => {
  it('ends the turn for both of them and rebinds them together', async () => {
    drivers = [];
    const a = await connect();
    a.send(JSON.stringify({ type: 'chat-new' }));
    const opened = await nextFrame(a, (frame) => frame.type === 'chat-opened');
    if (opened.type !== 'chat-opened') throw new Error('wrong frame');
    a.send(JSON.stringify({ type: 'chat-send', text: 'one' }));
    await nextFrame(a, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');

    const b = await connect();
    b.send(JSON.stringify({ type: 'chat-open', chatId: opened.chat.id }));
    await nextFrame(b, (frame) => frame.type === 'chat-opened');

    const aEnded = nextFrame(a, (frame) => frame.type === 'chat-event' && frame.event.type === 'turn-complete');
    const bEnded = nextFrame(b, (frame) => frame.type === 'chat-event' && frame.event.type === 'turn-complete');
    a.send(JSON.stringify({ type: 'chat-interrupt' }));
    await Promise.all([aEnded, bEnded]); // the OTHER window hears it too
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(drivers[0].stopped).toBe(true);

    // The next message binds a fresh backend, and B is still watching: it sees
    // the answer without having to reopen anything.
    const bSees = nextFrame(b, (frame) => frame.type === 'chat-event' && frame.event.type === 'text-delta');
    a.send(JSON.stringify({ type: 'chat-send', text: 'two' }));
    await nextFrame(a, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    const seen = await bSees;
    if (seen.type !== 'chat-event' || seen.event.type !== 'text-delta') throw new Error('wrong frame');
    expect(seen.event.text).toBe('echo:two');
    expect(drivers).toHaveLength(2);
    a.close();
    b.close();
  });
});

/**
 * Two windows sending into one conversation while its backend is still coming up.
 *
 * A conversation binds ONE driver, lazily, on the first send, and a backend
 * takes as long as it takes to start. The second window's send used to arrive
 * inside that window, find the half-built session, and hand its message to a
 * `driver` that was still null: the optional chain swallowed it, the transcript
 * recorded it anyway, and the agent never saw a word of it. Silent loss is bad;
 * silent loss that leaves evidence it worked is worse, because nothing on
 * screen or on disk gives the person any reason to say it again.
 */
describe('two windows sending while the backend binds', () => {
  it('holds the second message for the bind and delivers it, in the order it was typed', async () => {
    drivers = [];
    const a = await connect();
    a.send(JSON.stringify({ type: 'chat-new' }));
    const opened = await nextFrame(a, (frame) => frame.type === 'chat-opened');
    if (opened.type !== 'chat-opened') throw new Error('wrong frame');
    const b = await connect();
    b.send(JSON.stringify({ type: 'chat-open', chatId: opened.chat.id }));
    await nextFrame(b, (frame) => frame.type === 'chat-opened');

    // A sends first and its bind hangs, the way a backend that has to start a
    // child process does. It also carries a picture, so landing it means
    // writing a file first: a send is not one atomic act, and the amount of
    // work between "typed" and "written down" is not the same for every one.
    nextDriverSetup = (driver) => driver.blockBind();
    const picture = {
      name: 'shot.png',
      mimeType: 'image/png',
      data: Buffer.from('pretend this is a screenshot').toString('base64'),
    };
    a.send(JSON.stringify({ type: 'chat-send', text: 'FROM-A', attachments: [picture] }));
    await until(() => drivers.length === 1);
    // B types into the same chat while that is still in flight.
    b.send(JSON.stringify({ type: 'chat-send', text: 'FROM-B' }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(drivers[0].sent).toEqual([]); // nothing has bound yet, so nothing was sent

    drivers[0].releaseBind();
    await until(() => drivers[0].sent.length === 2);

    // One conversation, one agent, both messages.
    expect(drivers).toHaveLength(1);
    expect(drivers[0].sent).toEqual(['FROM-A', 'FROM-B']);

    // And the transcript agrees with the agent about what was said, and when.
    // Both messages are on disk before either is handed over, so there is
    // nothing to wait for here.
    const records = await readTranscript(root, opened.chat.id);
    const said = records.flatMap((record) => (record.role === 'user' ? [record.text] : []));
    expect(said).toEqual(['FROM-A', 'FROM-B']);
    a.close();
    b.close();
  });
});

/**
 * Stopping a conversation that is blocked on an approval.
 *
 * A driver's teardown is not silent: stopping it answers whatever was blocking
 * the agent, so its own turn can unwind, and that answer is an event. The drain
 * loop used to stop reading the moment the session left the live map, which is
 * the FIRST thing a teardown does, so every one of those events was dropped:
 * never written, never broadcast. The prompt stayed on screen with Allow and
 * Deny live, in every window and on every reload after, wired to a session that
 * no longer existed. It has to be answered, and answered BEFORE the turn is
 * reported over, because a client stops applying events to a turn that ended.
 */
describe('stopping a conversation with an approval on screen', () => {
  it('answers the prompt on the way out, in the window and in the transcript', async () => {
    drivers = [];
    nextDriverSetup = (driver) => {
      driver.silent = true; // the turn goes to work rather than answering at once
      driver.slowTeardown = true; // and its last words take a tick, as a real one's do
    };
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-new' }));
    const opened = await nextFrame(socket, (frame) => frame.type === 'chat-opened');
    if (opened.type !== 'chat-opened') throw new Error('wrong frame');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'run the build' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-ready');

    const asked = nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'approval-request');
    await until(() => drivers.length === 1 && drivers[0].sent.length === 1);
    drivers[0].ask('a1', 'Runs a script');
    await asked;

    // Everything the window is told from here, in order.
    const seen: ChatEvent[] = [];
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as WsFrame;
      if (frame.type === 'chat-event') seen.push(frame.event);
    });
    const ended = nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'turn-complete');
    socket.send(JSON.stringify({ type: 'chat-interrupt' })); // the Stop button
    await ended;

    expect(drivers[0].stopped).toBe(true);
    // The answer arrives, and arrives first: after a turn-complete the client
    // applies nothing more to that turn, so the other order leaves the prompt
    // exactly as stuck as dropping it did.
    expect(seen.map((event) => event.type)).toEqual(['approval-resolved', 'turn-complete']);
    expect(seen[0]).toEqual({ type: 'approval-resolved', approvalId: 'a1', decision: 'deny' });

    // And what the window saw live is what it finds on reload: no request in
    // the transcript is left without its answer. Each of those frames is sent
    // after its own append, so the file is already whole.
    const records = await readTranscript(root, opened.chat.id);
    const events = records.flatMap((record) => (record.role === 'agent' ? [record.event] : []));
    const requested = events.filter((event) => event.type === 'approval-request');
    const answered = events.filter((event) => event.type === 'approval-resolved');
    expect(requested).toHaveLength(1);
    expect(answered).toEqual([{ type: 'approval-resolved', approvalId: 'a1', decision: 'deny' }]);
    expect(events[events.length - 1]).toEqual({ type: 'turn-complete' });
    socket.close();
  });
});

/**
 * Talking into a conversation that was deleted underneath you.
 *
 * `appendChatRecord` writes NOTHING when the chat has no index row, and both
 * call sites used to ignore that. Delete a chat in one window while another has
 * it open and the second window kept talking: every message and every event
 * went nowhere, silently, until it reloaded and found the whole thing gone.
 */
describe('a conversation deleted in another window', () => {
  it('says so rather than writing the next message nowhere', async () => {
    drivers = [];
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-new' }));
    const opened = await nextFrame(socket, (frame) => frame.type === 'chat-opened');
    if (opened.type !== 'chat-opened') throw new Error('wrong frame');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'one' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');

    expect(await deleteChat(root, opened.chat.id)).toBe(true);

    const refused = nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'error');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'two' }));
    const frame = await refused;
    if (frame.type !== 'chat-event' || frame.event.type !== 'error') throw new Error('wrong frame');
    expect(frame.event.message).toMatch(/deleted/);
    // And the turn was never started: nothing pretends to be answering.
    expect(drivers[0].sent).toEqual(['one']);
    socket.close();
  });
});

/**
 * Where the DEFERRED end of a turn lands.
 *
 * Reporting a turn over waits for the driver's last words (up to
 * TEARDOWN_FLUSH_MS), and that wait used to run detached, outside the
 * conversation's chain, while the retired session was already out of the live
 * map. So the next message bound a fresh backend straight through it and the old
 * turn's `turn-complete` arrived INSIDE the new turn: chat-ready, then the
 * ending. The client clears `chatBusy` on it and, by its own rule, stops
 * applying events to that turn, so the rest of the live answer never reaches the
 * screen. The transcript keeps the wrong order for good.
 *
 * Everything except Codex is affected, because CodexDriver is the only one that
 * implements `interrupt()`; every other backend falls back to this teardown.
 */
describe('interrupting and typing again straight away', () => {
  it('reports the old turn over before the new one starts', async () => {
    drivers = [];
    nextDriverSetup = (driver) => {
      driver.silent = true; // the turn went to work, as a real one does
      driver.holdTeardown(); // and its last words are not instant
    };
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-new' }));
    const opened = await nextFrame(socket, (frame) => frame.type === 'chat-opened');
    if (opened.type !== 'chat-opened') throw new Error('wrong frame');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'one' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-ready');
    await until(() => drivers.length === 1 && drivers[0].sent.length === 1);

    // The two frames whose order is the whole point.
    const order: string[] = [];
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as WsFrame;
      if (frame.type === 'chat-ready') order.push('chat-ready');
      if (frame.type === 'chat-event' && frame.event.type === 'turn-complete') order.push('turn-complete');
    });

    socket.send(JSON.stringify({ type: 'chat-interrupt' }));
    socket.send(JSON.stringify({ type: 'chat-send', text: 'two' }));
    // The old backend takes its time letting go, which is exactly the window
    // the ending used to fall through.
    await new Promise((resolve) => setTimeout(resolve, 50));
    drivers[0].releaseTeardown();

    await until(() => order.includes('chat-ready') && order.includes('turn-complete'));
    expect(order).toEqual(['turn-complete', 'chat-ready']);
    // And the file agrees with what the window was shown.
    const records = await readTranscript(root, opened.chat.id);
    const said = records.map((record) => (record.role === 'user' ? record.text : record.event.type));
    expect(said.indexOf('turn-complete')).toBeLessThan(said.lastIndexOf('two'));
    socket.close();
  });
});

/**
 * A retired session still holding the sockets that have moved on.
 *
 * `retireChatSession` takes the session out of the live map and nothing clears
 * its socket set, and `leaveChat` only walks the sessions that are still IN that
 * map, so a window that interrupts and then opens another conversation is still
 * a broadcast target of the one it left. A `chat-event` carries no chat id, so
 * the client has no way to tell: the old conversation's last words were rendered
 * into the new one and cleared its busy state.
 */
describe('interrupting one conversation and opening another', () => {
  it('does not deliver the old conversation’s last words into the new one', async () => {
    drivers = [];
    nextDriverSetup = (driver) => {
      driver.silent = true;
      driver.holdTeardown();
    };
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-new' }));
    const first = await nextFrame(socket, (frame) => frame.type === 'chat-opened');
    if (first.type !== 'chat-opened') throw new Error('wrong frame');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'one' }));
    await nextFrame(socket, (frame) => frame.type === 'chat-ready');
    await until(() => drivers.length === 1 && drivers[0].sent.length === 1);
    drivers[0].ask('a1', 'Runs a script');
    await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'approval-request');

    // Everything the window is told from here, in the order it is told.
    const trail: string[] = [];
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as WsFrame;
      if (frame.type === 'chat-opened') trail.push(`opened:${frame.chat.id}`);
      else if (frame.type === 'chat-event') trail.push(`event:${frame.event.type}`);
    });

    // Stop, and move to a different conversation while the old backend is still
    // letting go of the last one.
    socket.send(JSON.stringify({ type: 'chat-interrupt' }));
    socket.send(JSON.stringify({ type: 'chat-new' }));
    const second = await nextFrame(socket, (frame) => frame.type === 'chat-opened' && frame.chat.id !== first.chat.id);
    if (second.type !== 'chat-opened') throw new Error('wrong frame');

    drivers[0].releaseTeardown();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const movedOn = trail.indexOf(`opened:${second.chat.id}`);
    expect(movedOn).toBeGreaterThanOrEqual(0);
    // Nothing from the conversation this window is no longer in.
    expect(trail.slice(movedOn + 1)).toEqual([]);
    socket.close();
  });

  it('names the conversation every chat-event belongs to', async () => {
    drivers = [];
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-new' }));
    const opened = await nextFrame(socket, (frame) => frame.type === 'chat-opened');
    if (opened.type !== 'chat-opened') throw new Error('wrong frame');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'hello' }));
    const event = await nextFrame(socket, (frame) => frame.type === 'chat-event' && frame.event.type === 'done');
    if (event.type !== 'chat-event') throw new Error('wrong frame');
    // Without this a client cannot tell a stray event from a live one, whatever
    // the server does about delivery. It is the structural half of the fix.
    expect(event.chatId).toBe(opened.chat.id);
    socket.close();
  });
});

/**
 * The conversation lane and the OTHER window's chat-open.
 *
 * Sends are serialized per conversation, which is right: two windows in one chat
 * drive the same driver and write the same file. But the whole of a send sat on
 * the sending socket's own chain too, so a second window's send waiting on the
 * first window's bind held up everything that window asked for afterwards,
 * including switching to a different conversation. With codex that is a 60s
 * start timeout of a dead-looking app. `ensureChat` used to return null at once
 * while a bind was in flight, which is how this stayed hidden.
 */
describe('one window binding while the other wants to switch conversations', () => {
  it('opens the other conversation without waiting for the bind', async () => {
    drivers = [];
    const a = await connect();
    a.send(JSON.stringify({ type: 'chat-new' }));
    const one = await nextFrame(a, (frame) => frame.type === 'chat-opened');
    if (one.type !== 'chat-opened') throw new Error('wrong frame');
    a.send(JSON.stringify({ type: 'chat-new' }));
    const two = await nextFrame(a, (frame) => frame.type === 'chat-opened' && frame.chat.id !== one.chat.id);
    if (two.type !== 'chat-opened') throw new Error('wrong frame');
    a.send(JSON.stringify({ type: 'chat-open', chatId: one.chat.id }));
    await nextFrame(a, (frame) => frame.type === 'chat-opened' && frame.chat.id === one.chat.id);

    const b = await connect();
    b.send(JSON.stringify({ type: 'chat-open', chatId: one.chat.id }));
    await nextFrame(b, (frame) => frame.type === 'chat-opened' && frame.chat.id === one.chat.id);

    // A's backend hangs coming up, the way `codex app-server` can.
    nextDriverSetup = (driver) => driver.blockBind();
    a.send(JSON.stringify({ type: 'chat-send', text: 'FROM-A' }));
    await until(() => drivers.length === 1);

    // B types into the same conversation, which correctly queues behind the
    // bind, and then wants to look at the other conversation. That is not a
    // send and has no business waiting on one.
    b.send(JSON.stringify({ type: 'chat-send', text: 'FROM-B' }));
    const switched = nextFrame(b, (frame) => frame.type === 'chat-opened' && frame.chat.id === two.chat.id, 1500);
    b.send(JSON.stringify({ type: 'chat-open', chatId: two.chat.id }));
    await switched;

    // And the message B typed is still delivered to the conversation it was
    // typed into, once that backend finally comes up.
    drivers[0].releaseBind();
    await until(() => drivers[0].sent.length === 2);
    expect(drivers[0].sent).toEqual(['FROM-A', 'FROM-B']);
    a.close();
    b.close();
  });
});
