/**
 * Asking the tester to play, stopping it, and reading what it said.
 *
 * The routes are pure functions on the context object, so no HTTP server is
 * needed. The session itself runs against an injected game and driver: a route
 * test that launched Chromium and spent someone's quota would be a bad trade for
 * what it proves.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectServerContext, type ProjectServerContext } from '../server/projectServer';
import { EventQueue, type ChatDriver, type ChatEvent } from '../server/chat';
import type { TesterGame } from '../server/tester/session';

let tmp: string;
let root: string;
let ctx: ProjectServerContext;
/** Resolves once the running session has taken its first turn. */
let firstTurn: Promise<void>;

/** Answers every turn instantly, so a route test never waits on a model. */
class ScriptedDriver implements ChatDriver {
  readonly kind = 'stub' as const;
  private readonly queue = new EventQueue<ChatEvent>();
  constructor(private readonly replies: string[]) {}
  get events(): AsyncIterable<ChatEvent> {
    return this.queue;
  }
  async start(): Promise<void> {}
  send(): void {
    this.queue.push({ type: 'message-delta', text: this.replies.shift() ?? 'DONE' });
    this.queue.push({ type: 'turn-complete' });
  }
  stop(): void {
    this.queue.close();
  }
}

function slowGame(onTurn: () => void): TesterGame {
  return {
    capabilities: { input: { actions: ['right'], axes: [], pointer: true } },
    start: async () => {},
    stop: async () => {},
    // Slow on purpose: the session has to still be running when the second
    // play arrives and when stop is called.
    step: async () => {
      onTurn();
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {};
    },
    setActionDown: async () => {},
    setActionUp: async () => {},
    setAxis: async () => {},
    sendPointer: async () => {},
    screenshot: async () => new Uint8Array([1]),
  };
}

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'tester-routes-'));
  root = path.join(tmp, 'game');
  await fsp.mkdir(root, { recursive: true });
  await fsp.writeFile(path.join(root, 'index.html'), '<canvas></canvas>');
  let reached: () => void = () => {};
  firstTurn = new Promise<void>((resolve) => {
    reached = resolve;
  });
  ctx = createProjectServerContext({
    recentsFile: path.join(tmp, 'recent.json'),
    repoRoot: tmp,
    testerDeps: {
      createDriver: async () => new ScriptedDriver(Array.from({ length: 40 }, () => 'ACTION: right')),
      openGame: async () => slowGame(reached),
    },
  });
  await ctx.openWorkspace(root);
});

afterEach(async () => {
  await ctx.stopTesterSession(root);
  await ctx.testerJob(root)?.catch(() => {});
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('tester routes', () => {
  it('starts a session and says so', async () => {
    const result = await ctx.startTesterSession(root, 4);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, session: 1 });
  });

  it('refuses a second session while one is playing', async () => {
    await ctx.startTesterSession(root, 20);
    await firstTurn;
    const second = await ctx.startTesterSession(root, 20);
    expect(second.status).toBe(409);
  });

  it('stops a session that is playing, and the note still lands', async () => {
    await ctx.startTesterSession(root, 40);
    await firstTurn;
    const stop = await ctx.stopTesterSession(root);
    expect(stop.status).toBe(200);
    await ctx.testerJob(root);
    const history = await ctx.testerHistory(root);
    const body = history.body as { sessions: { session: number; stopped: string }[] };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].stopped).toBe('user');
  });

  it('reads the history oldest first, so it reads as a history', async () => {
    await ctx.startTesterSession(root, 2);
    await ctx.testerJob(root);
    await ctx.startTesterSession(root, 2);
    await ctx.testerJob(root);
    const history = await ctx.testerHistory(root);
    const body = history.body as { ok: boolean; sessions: { session: number }[] };
    expect(body.sessions.map((s) => s.session)).toEqual([1, 2]);
  });

  it('says nothing has played yet rather than erroring on a fresh folder', async () => {
    const history = await ctx.testerHistory(root);
    expect(history.status).toBe(200);
    expect(history.body).toMatchObject({ ok: true, sessions: [], running: false });
  });

  it('turns away a folder nobody opened', async () => {
    const other = path.join(tmp, 'elsewhere');
    await fsp.mkdir(other, { recursive: true });
    expect((await ctx.startTesterSession(other, 4)).status).toBe(403);
    expect((await ctx.stopTesterSession(other)).status).toBe(403);
    expect((await ctx.testerHistory(other)).status).toBe(403);
  });

  it('refuses to play a folder with no game in it', async () => {
    const empty = path.join(tmp, 'empty');
    await fsp.mkdir(empty, { recursive: true });
    await ctx.openWorkspace(empty);
    const result = await ctx.startTesterSession(empty, 4);
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toMatch(/no game/i);
  });

  it('carries the thinking and the frames out to whoever is watching', async () => {
    const thoughts: unknown[] = [];
    const frames: unknown[] = [];
    ctx.testerBus.on('frame', (message: { root: string; frame: unknown }) => thoughts.push(message.frame));
    ctx.probeBus.on('frame', (message: { root: string; frame: unknown }) => frames.push(message.frame));
    await ctx.startTesterSession(root, 2);
    await ctx.testerJob(root);
    expect(thoughts.some((f) => (f as { type: string }).type === 'tester-thought')).toBe(true);
    expect(thoughts.some((f) => (f as { type: string }).type === 'tester-done')).toBe(true);
    // The probe stream is told the picture is over, so the pane hands the
    // stage back to the person's own game instead of holding the last frame.
    expect(frames.some((f) => (f as { type: string }).type === 'probe-end')).toBe(true);
  });
});
