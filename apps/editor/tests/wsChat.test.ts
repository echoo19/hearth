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
  private finished = false;

  get events(): AsyncIterable<ChatEvent> {
    return this.queue;
  }

  get dead(): boolean {
    return this.finished;
  }

  async start(_sessionId: string, projectRoot: string): Promise<void> {
    this.startedIn = projectRoot;
    if (this.startError) throw new Error(this.startError);
  }

  send(text: string, agent?: AgentTurnOptions): void {
    if (this.finished) return; // a dead backend answers nothing, silently
    this.sent.push(text);
    this.sentAgents.push(agent);
    this.queue.push({ type: 'text-delta', text: `echo:${text}` });
    this.queue.push({ type: 'done' });
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
    this.queue.close();
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
      drivers.push(driver);
      return driver;
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  server.close();
  if (previousHome === undefined) delete process.env.HEARTH_HOME;
  else process.env.HEARTH_HOME = previousHome;
  await fsp.rm(tmp, { recursive: true, force: true });
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
