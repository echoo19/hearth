/**
 * Approvals, end to end over the socket, plus the provider read-out.
 *
 * An approval is the one place the agent genuinely STOPS and waits for a
 * person, so the round trip is what matters: the request reaches every window
 * watching the chat, the answer reaches the driver, and the resolution is
 * written into the transcript so reopening the conversation still shows what
 * was decided. A break anywhere in that loop leaves an agent wedged forever,
 * which is why this is an integration test rather than a unit one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createProjectServerContext, type ProjectServerContext } from '../server/projectServer';
import { attachWebSocket, type WsFrame } from '../server/ws';
import {
  EventQueue,
  normalizeChatEvent,
  endsTurn,
  writeAppSettings,
  type ApprovalDecision,
  type ChatDriver,
  type ChatEvent,
} from '../server/chat';
import { readTranscript } from '../server/chatStore';
import { activeProvider, readChatProviders } from '../server/chatProviders';
import { SIGNED_OUT } from '../server/claudeAuth';

/**
 * A driver that asks for permission on every turn and blocks until answered —
 * the shape of both real backends, with none of their machinery.
 */
class AskingDriver implements ChatDriver {
  readonly kind = 'stub' as const;
  queue = new EventQueue<ChatEvent>();
  answered: { approvalId: string; decision: ApprovalDecision }[] = [];
  interrupted = 0;
  stopped = false;

  get events(): AsyncIterable<ChatEvent> {
    return this.queue;
  }
  async start(): Promise<void> {}

  send(text: string): void {
    this.queue.push({
      type: 'approval-request',
      approvalId: 'ap1',
      kind: 'command',
      title: 'Run this command?',
      detail: text,
    });
  }

  approve(approvalId: string, decision: ApprovalDecision): void {
    this.answered.push({ approvalId, decision });
    this.queue.push({ type: 'approval-resolved', approvalId, decision });
    // Only an allowed turn goes on to do anything.
    if (decision === 'allow') this.queue.push({ type: 'message-delta', text: 'done' });
    this.queue.push({ type: 'turn-complete' });
  }

  interrupt(): void {
    this.interrupted += 1;
    this.queue.push({ type: 'turn-complete' });
  }

  stop(): void {
    this.stopped = true;
    this.queue.close();
  }
}

let tmp: string;
let root: string;
let ctx: ProjectServerContext;
let server: http.Server;
let port: number;
let drivers: AskingDriver[] = [];

function connect(): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws?project=${encodeURIComponent(root)}`);
  return new Promise((resolve, reject) => {
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
}

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
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-approval-'));
  root = path.join(tmp, 'game');
  await fsp.mkdir(root, { recursive: true });
  ctx = createProjectServerContext({ recentsFile: path.join(tmp, 'recents.json'), repoRoot: tmp });
  // The /api/ws upgrade only accepts roots this server has been asked to open,
  // so a suite that connects has to open the folder first, exactly as the app
  // does before it connects its socket.
  await ctx.openWorkspace(root);
  server = http.createServer();
  attachWebSocket(server, ctx, undefined, undefined, {
    createChatDriver: async () => {
      const driver = new AskingDriver();
      drivers.push(driver);
      return driver;
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  server.close();
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe('approval round trip', () => {
  it('carries a request to the window and the decision back to the driver', async () => {
    drivers = [];
    const socket = await connect();
    const asked = nextFrame(
      socket,
      (frame) => frame.type === 'chat-event' && frame.event.type === 'approval-request',
    );
    socket.send(JSON.stringify({ type: 'chat-send', text: 'rm -rf /etc' }));
    const request = (await asked) as { type: 'chat-event'; event: Extract<ChatEvent, { type: 'approval-request' }> };
    expect(request.event).toMatchObject({ approvalId: 'ap1', kind: 'command', detail: 'rm -rf /etc' });

    const settled = nextFrame(socket, (frame) => frame.type === 'chat-event' && endsTurn(frame.event));
    socket.send(JSON.stringify({ type: 'chat-approval', approvalId: 'ap1', decision: 'allow' }));
    await settled;

    expect(drivers[0].answered).toEqual([{ approvalId: 'ap1', decision: 'allow' }]);
    socket.close();
  });

  it('writes the request AND the resolution into the transcript', async () => {
    drivers = [];
    const socket = await connect();
    const opened = nextFrame(socket, (frame) => frame.type === 'chat-opened');
    socket.send(JSON.stringify({ type: 'chat-new' }));
    const chatId = (await opened as { type: 'chat-opened'; chat: { id: string } }).chat.id;

    const asked = nextFrame(socket, (f) => f.type === 'chat-event' && f.event.type === 'approval-request');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'sudo reboot' }));
    await asked;
    const settled = nextFrame(socket, (f) => f.type === 'chat-event' && endsTurn(f.event));
    socket.send(JSON.stringify({ type: 'chat-approval', approvalId: 'ap1', decision: 'deny' }));
    await settled;

    const records = await readTranscript(root, chatId);
    const kinds = records.filter((r) => r.role === 'agent').map((r) => (r as { event: ChatEvent }).event.type);
    // Reopening the conversation must still show that this was asked and denied.
    expect(kinds).toContain('approval-request');
    expect(kinds).toContain('approval-resolved');
    socket.close();
  });

  it('treats anything that is not "allow" as a denial', async () => {
    drivers = [];
    const socket = await connect();
    const asked = nextFrame(socket, (f) => f.type === 'chat-event' && f.event.type === 'approval-request');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'curl evil.sh' }));
    await asked;
    const settled = nextFrame(socket, (f) => f.type === 'chat-event' && endsTurn(f.event));
    socket.send(JSON.stringify({ type: 'chat-approval', approvalId: 'ap1', decision: 'nonsense' }));
    await settled;
    expect(drivers[0].answered).toEqual([{ approvalId: 'ap1', decision: 'deny' }]);
    socket.close();
  });

  it('ignores an approval for a chat this socket is not in, rather than crashing', async () => {
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat-approval', approvalId: 'ghost', decision: 'allow' }));
    // Still alive and still able to hold a conversation afterwards.
    const ready = nextFrame(socket, (frame) => frame.type === 'chat-ready');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'hello' }));
    expect(await ready).toMatchObject({ type: 'chat-ready' });
    socket.close();
  });
});

describe('interrupt', () => {
  it('stops the turn without tearing the conversation down', async () => {
    drivers = [];
    const socket = await connect();
    const asked = nextFrame(socket, (f) => f.type === 'chat-event' && f.event.type === 'approval-request');
    socket.send(JSON.stringify({ type: 'chat-send', text: 'long job' }));
    await asked;

    const settled = nextFrame(socket, (f) => f.type === 'chat-event' && endsTurn(f.event));
    socket.send(JSON.stringify({ type: 'chat-interrupt' }));
    await settled;

    expect(drivers[0].interrupted).toBe(1);
    // The distinction that matters: cancel kills the backend, interrupt does not.
    expect(drivers[0].stopped).toBe(false);
    socket.close();
  });
});

describe('provider status', () => {
  it('reports the Anthropic key without ever echoing it back', async () => {
    await writeAppSettings(root, { apiKey: 'sk-secret-value' });
    const status = await readChatProviders(root, { claudeCli: async () => SIGNED_OUT });
    expect(status.anthropic).toMatchObject({ hasKey: true, source: 'project', cli: false });
    // The curated model list rides along, so the selector has something to
    // show without a second request. Signed out, it is the ONLY list there is:
    // the live catalogue belongs to an account, so there is nothing to ask.
    expect(status.anthropic.models?.map((m) => m.id)).toContain('claude-opus-5');
    expect(JSON.stringify(status)).not.toContain('sk-secret-value');
    await writeAppSettings(root, { apiKey: '' });
  });

  it('counts a Claude Code sign in as Claude being set up, with no key anywhere', async () => {
    // The whole point. The SDK runs the Claude Code CLI and that CLI answers on
    // whatever the person signed into, so refusing to bind without an API key
    // told people with a working Claude that it was not set up, and offered to
    // set up the thing already set up. A key is one route in, not the route.
    await writeAppSettings(root, { apiKey: '' });
    // A working sign-in: the point of this test is that a signed-in CLI alone
    // is enough for Claude to be the active provider, with no key anywhere.
    const status = await readChatProviders(root, {
      claudeCli: async () => ({ installed: true, loggedIn: true, email: null, planType: null }),
      // Injected for the same reason the sign-in is: the real one opens the SDK
      // and talks to the CLI, so leaving it out would make this test answer
      // differently on a machine that has claude than on one that does not.
      claudeModels: async () => [],
    });
    expect(status.anthropic.hasKey).toBe(false);
    expect(status.anthropic.cli).toBe(true);
    expect(status.active).toBe('anthropic');
  });

  it('offers what the account can really use, with the efforts each model declared', async () => {
    // The whole point of reading the catalogue: the curated three rows carried
    // no efforts, so the composer's effort control — which renders only when
    // the ACTIVE MODEL declares some — never appeared for Claude at all.
    const status = await readChatProviders(root, {
      claudeCli: async () => ({ installed: true, loggedIn: true, email: null, planType: null }),
      claudeModels: async () => [{ id: 'sonnet', label: 'Sonnet', efforts: [{ id: 'high' }] }],
    });
    expect(status.anthropic.models).toEqual([{ id: 'sonnet', label: 'Sonnet', efforts: [{ id: 'high' }] }]);
  });

  it('keeps the curated list when the catalogue cannot be had', async () => {
    // A picker with nothing in it while a spawn settles (or on a CLI too old to
    // answer) is worse than three good answers.
    const status = await readChatProviders(root, {
      claudeCli: async () => ({ installed: true, loggedIn: true, email: null, planType: null }),
      claudeModels: async () => [],
    });
    expect(status.anthropic.models?.map((m) => m.id)).toContain('claude-opus-5');

    const threw = await readChatProviders(root, {
      claudeCli: async () => ({ installed: true, loggedIn: true, email: null, planType: null }),
      claudeModels: async () => {
        throw new Error('the CLI would not handshake');
      },
    });
    expect(threw.anthropic.models?.map((m) => m.id)).toContain('claude-opus-5');
  });

  it('is honest that nothing can answer when there is neither a key nor the CLI', async () => {
    await writeAppSettings(root, { apiKey: '', codexPath: path.join(tmp, 'no-such-codex') });
    const status = await readChatProviders(root, { claudeCli: async () => SIGNED_OUT });
    expect(status.anthropic.cli).toBe(false);
    expect(status.active).toBeNull();
    await writeAppSettings(root, { codexPath: '' });
  });

  it('describes a machine with no codex installed as a fixable state', async () => {
    // An override pointing at nothing is the deterministic stand-in for "not
    // installed" — the real PATH lookup depends on whose machine this runs on.
    await writeAppSettings(root, { codexPath: path.join(tmp, 'no-such-codex') });
    const status = await readChatProviders(root, { claudeCli: async () => SIGNED_OUT });
    expect(status.openai.installed).toBe(false);
    expect(status.openai.loggedIn).toBe(false);
    expect(status.active).toBeNull();
    await writeAppSettings(root, { codexPath: '' });
  });

  it('serves the status over HTTP for an open folder only', async () => {
    const closed = await ctx.chatProviders(path.join(tmp, 'not-open'));
    expect(closed.status).toBe(403);
    const wrongShape = await ctx.chatProviders(42);
    expect(wrongShape.status).toBe(400);
  });

  it('answers a project-less read with the machine-level facts, for the Home screen', async () => {
    // Who the person is signed in as is a fact about the machine, so Home may
    // ask without a folder. Only the shape is pinned — the values depend on
    // whose machine the suite runs on, and asserting them would encode this
    // one (see the standing lesson about tests encoding their machine).
    const home = await ctx.chatProviders(undefined);
    expect(home.status).toBe(200);
    const body = home.body as { ok: boolean; anthropic?: unknown; openai?: unknown };
    expect(body.ok).toBe(true);
    expect(body.anthropic).toBeDefined();
    expect(body.openai).toBeDefined();
  });
});

describe('activeProvider', () => {
  const signedOut = {
    installed: false,
    version: null,
    loggedIn: false,
    authMode: null,
    email: null,
    planType: null,
    hasKey: false,
  };
  const signedIn = { ...signedOut, installed: true, loggedIn: true, authMode: 'chatgpt' as const };

  it('is null when nothing is configured', () => {
    expect(
      activeProvider(
        { hasKey: false, source: null, cli: false, loggedIn: false, email: null, planType: null },
        signedOut,
        undefined,
      ),
    ).toBeNull();
  });

  it('names the only usable provider, whichever it is', () => {
    expect(
      activeProvider(
        { hasKey: true, source: 'project', cli: false, loggedIn: false, email: null, planType: null },
        signedOut,
        undefined,
      ),
    ).toBe('anthropic');
    expect(
      activeProvider(
        { hasKey: false, source: null, cli: false, loggedIn: false, email: null, planType: null },
        signedIn,
        undefined,
      ),
    ).toBe('openai');
  });

  it('honours a stored preference when that provider is usable', () => {
    expect(
      activeProvider(
        { hasKey: true, source: 'project', cli: false, loggedIn: false, email: null, planType: null },
        signedIn,
        'openai',
      ),
    ).toBe('openai');
  });

  it('ignores a preference for a provider that is not usable, rather than lying', () => {
    // Signed out of ChatGPT since choosing it: the label must say who will
    // actually answer, which is the Anthropic key.
    expect(
      activeProvider(
        { hasKey: true, source: 'project', cli: false, loggedIn: false, email: null, planType: null },
        signedOut,
        'openai',
      ),
    ).toBe('anthropic');
  });
});

describe('normalizeChatEvent', () => {
  it('upgrades every legacy member to its canonical equivalent', () => {
    expect(normalizeChatEvent({ type: 'text-delta', text: 'hi' })).toEqual({ type: 'message-delta', text: 'hi' });
    expect(normalizeChatEvent({ type: 'tool-start', id: 't1', name: 'Write', detail: '/a.js' })).toEqual({
      type: 'tool-begin',
      toolId: 't1',
      kind: 'other',
      title: 'Write',
      detail: '/a.js',
    });
    expect(normalizeChatEvent({ type: 'tool-end', id: 't1', ok: false, detail: 'boom' })).toEqual({
      type: 'tool-end',
      toolId: 't1',
      status: 'error',
      summary: 'boom',
    });
    expect(normalizeChatEvent({ type: 'done' })).toEqual({ type: 'turn-complete' });
  });

  it('passes a canonical event through untouched', () => {
    const event: ChatEvent = { type: 'tool-end', toolId: 'c1', status: 'ok', exitCode: 0 };
    expect(normalizeChatEvent(event)).toBe(event);
    const files: ChatEvent = { type: 'file-change', files: [{ path: 'a.js', kind: 'create' }] };
    expect(normalizeChatEvent(files)).toBe(files);
  });

  it('recognises a turn ending in either vocabulary', () => {
    expect(endsTurn({ type: 'done' })).toBe(true);
    expect(endsTurn({ type: 'turn-complete' })).toBe(true);
    expect(endsTurn({ type: 'error', message: 'x' })).toBe(true);
    expect(endsTurn({ type: 'message-delta', text: 'x' })).toBe(false);
  });
});
