/**
 * Integration test for pty-* frame routing over the /api/ws channel: a bare
 * node:http server with attachWebSocket, a real `ws` client, and a fake
 * PtyBackend injected so no real pseudo-terminal is ever spawned here (real
 * @lydell/node-pty is exercised only via manual smoke testing).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';
import { createProject } from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import { createProjectServerContext, type ProjectServerContext } from '../server/projectServer';
import { attachWebSocket, type WsFrame } from '../server/ws';
import { resetLoginShellPathCacheForTests } from '../server/shellEnv';
import { resolveShell, type PtyBackend, type PtyHandle } from '../server/ptyManager';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakePtyHandle implements PtyHandle {
  dataCbs: Array<(d: string) => void> = [];
  exitCbs: Array<(e: { exitCode: number }) => void> = [];
  errorCbs: Array<(error: Error) => void> = [];
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;

  onData(cb: (d: string) => void): void {
    this.dataCbs.push(cb);
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCbs.push(cb);
  }
  onError(cb: (error: Error) => void): void {
    this.errorCbs.push(cb);
  }
  write(d: string): void {
    this.writes.push(d);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  kill(): void {
    this.killed = true;
  }
  emitData(d: string): void {
    for (const cb of this.dataCbs) cb(d);
  }
  emitExit(code: number): void {
    for (const cb of this.exitCbs) cb({ exitCode: code });
  }
  emitError(error: Error): void {
    for (const cb of this.errorCbs) cb(error);
  }
}

class FakeBackend implements PtyBackend {
  spawns: Array<{
    file: string;
    args: string[];
    opts: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv };
    handle: FakePtyHandle;
  }> = [];
  spawn(file: string, args: string[], opts: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }): PtyHandle {
    const handle = new FakePtyHandle();
    this.spawns.push({ file, args, opts, handle });
    return handle;
  }
}

let tmpDir: string;
let projectRoot: string;
let ctx: ProjectServerContext;
let server: http.Server;
let baseUrl: string;
let backend: FakeBackend;

let savedShell: string | undefined;

beforeAll(async () => {
  // The pty env now consults the user's login shell for its PATH (the
  // GUI-launched-app fix in ws.ts/shellEnv.ts). Keep this suite hermetic
  // and timing-stable: point $SHELL at an inert binary so no real rc files
  // ever run here, and clear the per-process cache.
  savedShell = process.env.SHELL;
  process.env.SHELL = '/usr/bin/false';
  resetLoginShellPathCacheForTests();

  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-ws-pty-test-'));
  const nodeFs = new NodeFileSystem();
  projectRoot = path.join(tmpDir, 'proj');
  await createProject(nodeFs, projectRoot, { name: 'WS Pty Test Project' });

  ctx = createProjectServerContext({
    recentsFile: path.join(tmpDir, 'recent-projects.json'),
    repoRoot: tmpDir,
  });

  backend = new FakeBackend();
  server = http.createServer((req, res) => {
    res.statusCode = 404;
    res.end();
  });
  // Resolve the pty env instantly for this suite. These tests exercise frame
  // ROUTING, not env resolution (that has its own describe below), and the real
  // getPtyEnv spawns a login shell — a variable delay that raced the fixed
  // `wait()` after `pty-start` and flaked the spawn assertions on slow CI.
  attachWebSocket(server, ctx, backend, () => Promise.resolve(process.env));

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (savedShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = savedShell;
  resetLoginShellPathCacheForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(`${baseUrl}/api/ws?project=${encodeURIComponent(projectRoot)}`);
    client.on('open', () => resolve(client));
    client.on('error', reject);
  });
}

async function startOwnServer(
  ownBackend: FakeBackend,
  ptyEnv: () => Promise<NodeJS.ProcessEnv>,
  opts?: { detachLingerMs?: number },
): Promise<{ server: http.Server; connect: () => Promise<WebSocket> }> {
  const ownServer = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  attachWebSocket(ownServer, ctx, ownBackend, ptyEnv, opts);
  await new Promise<void>((resolve) => ownServer.listen(0, '127.0.0.1', resolve));
  const address = ownServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    server: ownServer,
    connect: () => new Promise((resolve, reject) => {
      const client = new WebSocket(
        `ws://127.0.0.1:${port}/api/ws?project=${encodeURIComponent(projectRoot)}`,
      );
      client.on('open', () => resolve(client));
      client.on('error', reject);
    }),
  };
}

describe('pty-* frame routing over /api/ws', () => {
  it('pty-start spawns via the backend with cwd=root, and pty-data/pty-exit flow back to the same socket', async () => {
    const client = await connect();
    const frames: WsFrame[] = [];
    client.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as WsFrame));

    client.send(JSON.stringify({ type: 'pty-start' }));
    await wait(100);

    expect(backend.spawns).toHaveLength(1);
    expect(backend.spawns[0].opts.cwd).toBe(path.resolve(projectRoot));

    const handle = backend.spawns[0].handle;
    handle.emitData('hello from pty\n');
    await wait(50);
    expect(frames.some((f) => f.type === 'pty-data' && f.data === 'hello from pty\n')).toBe(true);

    handle.emitExit(0);
    await wait(50);
    expect(frames.some((f) => f.type === 'pty-exit' && f.code === 0)).toBe(true);

    client.close();
    await wait(50);
  });

  it('pty-input writes to the backend handle for that project root', async () => {
    const client = await connect();
    client.send(JSON.stringify({ type: 'pty-start' }));
    await wait(100);

    const handle = backend.spawns[backend.spawns.length - 1].handle;
    client.send(JSON.stringify({ type: 'pty-input', data: 'echo hi\r' }));
    await wait(50);

    expect(handle.writes).toEqual(['echo hi\r']);

    client.close();
    await wait(50);
  });

  it('closing the owning socket kills its pty (no orphans)', async () => {
    const client = await connect();
    client.send(JSON.stringify({ type: 'pty-start' }));
    await wait(100);

    const handle = backend.spawns[backend.spawns.length - 1].handle;
    expect(handle.killed).toBe(false);

    client.close();
    await wait(100);

    expect(handle.killed).toBe(true);
  });

  it('pty-stop explicitly kills the pty without waiting for the socket to close', async () => {
    const client = await connect();
    client.send(JSON.stringify({ type: 'pty-start' }));
    await wait(100);

    const handle = backend.spawns[backend.spawns.length - 1].handle;
    expect(handle.killed).toBe(false);

    client.send(JSON.stringify({ type: 'pty-stop' }));
    await wait(50);

    expect(handle.killed).toBe(true);
    expect(client.readyState).toBe(WebSocket.OPEN);

    client.close();
    await wait(50);
  });

  it('pty-input and pty-resize from a non-owning socket on the same project are silent no-ops', async () => {
    const owner = await connect();
    owner.send(JSON.stringify({ type: 'pty-start' }));
    await wait(100);

    const handle = backend.spawns[backend.spawns.length - 1].handle;

    // A second socket on the SAME project root — e.g. another browser tab —
    // must not be able to inject keystrokes into, resize, or (per the
    // existing pty-stop guarantee) kill the owner's terminal session.
    const intruder = await connect();
    intruder.send(JSON.stringify({ type: 'pty-input', data: 'rm -rf /\r' }));
    intruder.send(JSON.stringify({ type: 'pty-resize', cols: 999, rows: 999 }));
    intruder.send(JSON.stringify({ type: 'pty-stop' }));
    await wait(50);

    expect(handle.writes).toEqual([]);
    expect(handle.resizes).toEqual([]);
    expect(handle.killed).toBe(false);

    // The legitimate owner's input still reaches the same pty.
    owner.send(JSON.stringify({ type: 'pty-input', data: 'echo hi\r' }));
    await wait(50);
    expect(handle.writes).toEqual(['echo hi\r']);

    owner.close();
    intruder.close();
    await wait(50);
  });

  it('a second pty-start on the same root kills the previous pty before spawning a new one', async () => {
    const client = await connect();
    client.send(JSON.stringify({ type: 'pty-start' }));
    await wait(100);
    const first = backend.spawns[backend.spawns.length - 1].handle;

    client.send(JSON.stringify({ type: 'pty-start' }));
    await wait(100);

    expect(first.killed).toBe(true);
    // Platform-specific shell (powershell.exe on Windows): derive it the same
    // way the server does so this holds on the Windows release CI too.
    expect(backend.spawns[backend.spawns.length - 1].file).toBe(resolveShell(os.platform(), process.env).file);

    client.close();
    await wait(50);
  });

  it('keeps same-project sockets independent, including input and stop', async () => {
    const firstClient = await connect();
    const secondClient = await connect();

    firstClient.send(JSON.stringify({ type: 'pty-start' }));
    secondClient.send(JSON.stringify({ type: 'pty-start' }));
    await wait(100);

    const [first, second] = backend.spawns.slice(-2).map((spawn) => spawn.handle);
    expect(first.killed).toBe(false);
    expect(second.killed).toBe(false);

    firstClient.send(JSON.stringify({ type: 'pty-input', data: 'first\r' }));
    secondClient.send(JSON.stringify({ type: 'pty-input', data: 'second\r' }));
    await wait(50);
    expect(first.writes).toEqual(['first\r']);
    expect(second.writes).toEqual(['second\r']);

    firstClient.send(JSON.stringify({ type: 'pty-stop' }));
    await wait(50);
    expect(first.killed).toBe(true);
    expect(second.killed).toBe(false);

    firstClient.close();
    secondClient.close();
    await wait(50);
  });

  it('a stale exit from a stopped pty does not disturb the replacement session', async () => {
    const client = await connect();
    const frames: WsFrame[] = [];
    client.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as WsFrame));

    client.send(JSON.stringify({ type: 'pty-start' }));
    await wait(100);
    const first = backend.spawns[backend.spawns.length - 1].handle;

    client.send(JSON.stringify({ type: 'pty-stop' }));
    await wait(50);
    expect(first.killed).toBe(true);

    client.send(JSON.stringify({ type: 'pty-start' }));
    await wait(100);
    const second = backend.spawns[backend.spawns.length - 1].handle;

    // The killed process exits asynchronously (real ptys always do): its
    // late events must not reach the client as if the new session ended.
    const exitsBefore = frames.filter((f) => f.type === 'pty-exit').length;
    first.emitData('late output from the dead pty');
    first.emitExit(0);
    await wait(50);
    expect(frames.filter((f) => f.type === 'pty-exit').length).toBe(exitsBefore);
    expect(frames.some((f) => f.type === 'pty-data' && f.data.includes('dead pty'))).toBe(false);

    // ...and ownership of the replacement stays intact: Stop still works.
    client.send(JSON.stringify({ type: 'pty-stop' }));
    await wait(50);
    expect(second.killed).toBe(true);

    client.close();
    await wait(50);
  });

  it('forwards an async pty spawn error and cleans up the failed session', async () => {
    const client = await connect();
    const frames: WsFrame[] = [];
    client.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as WsFrame));
    try {
      client.send(JSON.stringify({ type: 'pty-start' }));
      await wait(100);
      const handle = backend.spawns[backend.spawns.length - 1].handle;

      handle.emitError(new Error('native pty unavailable'));
      client.send(JSON.stringify({ type: 'pty-input', data: 'must be dropped' }));
      await wait(50);

      expect(frames).toContainEqual({ type: 'pty-error', message: 'native pty unavailable' });
      expect(handle.writes).toEqual([]);
    } finally {
      client.close();
      await wait(50);
    }
  });
});

describe('detach/reattach: a dropped socket keeps its session-tokened pty alive', () => {
  it('detaches on socket close, then reattaches by sessionId with a pty-attach replay and live routing', async () => {
    const client = await connect();
    client.send(JSON.stringify({ type: 'pty-start', sessionId: 'reattach-sess-1' }));
    await wait(100);
    const spawnsBefore = backend.spawns.length;
    const handle = backend.spawns[backend.spawns.length - 1].handle;
    handle.emitData('before drop\n');
    await wait(50);

    // The socket drops (sleep/wake, network blip): the pty must SURVIVE.
    client.close();
    await wait(100);
    expect(handle.killed).toBe(false);

    // Output produced while nobody is attached is buffered, not lost.
    handle.emitData('while detached\n');

    // A new socket presenting the same sessionId gets the same pty back.
    const client2 = await connect();
    const frames2: WsFrame[] = [];
    client2.on('message', (raw) => frames2.push(JSON.parse(raw.toString()) as WsFrame));
    client2.send(JSON.stringify({ type: 'pty-start', sessionId: 'reattach-sess-1' }));
    await wait(100);

    expect(backend.spawns.length).toBe(spawnsBefore); // reattached, not respawned
    const attach = frames2.find((f) => f.type === 'pty-attach');
    expect(attach).toBeDefined();
    expect(attach && attach.type === 'pty-attach' && attach.replay).toBe(
      'before drop\nwhile detached\n',
    );
    expect(attach && attach.type === 'pty-attach' && attach.dropped).toBe(0);

    // Live output and input both route to/from the new socket.
    handle.emitData('after reattach\n');
    client2.send(JSON.stringify({ type: 'pty-input', data: 'still here\r' }));
    await wait(50);
    expect(frames2.some((f) => f.type === 'pty-data' && f.data === 'after reattach\n')).toBe(true);
    expect(handle.writes).toContain('still here\r');

    client2.send(JSON.stringify({ type: 'pty-stop' }));
    await wait(50);
    expect(handle.killed).toBe(true);
    client2.close();
    await wait(50);
  });

  it('jiggles the pty size on the first same-size resize after reattach so full-screen TUIs repaint', async () => {
    const client = await connect();
    client.send(JSON.stringify({ type: 'pty-start', sessionId: 'reattach-sess-2' }));
    await wait(100);
    const handle = backend.spawns[backend.spawns.length - 1].handle;
    client.send(JSON.stringify({ type: 'pty-resize', cols: 100, rows: 30 }));
    await wait(50);
    expect(handle.resizes).toEqual([{ cols: 100, rows: 30 }]);

    client.close();
    await wait(100);

    const client2 = await connect();
    client2.send(JSON.stringify({ type: 'pty-start', sessionId: 'reattach-sess-2' }));
    await wait(100);
    // Same size as before the drop: a plain TIOCSWINSZ would not deliver
    // SIGWINCH, so the TUI would never repaint over the raw replay bytes.
    client2.send(JSON.stringify({ type: 'pty-resize', cols: 100, rows: 30 }));
    await wait(50);
    expect(handle.resizes.slice(1)).toEqual([
      { cols: 100, rows: 31 },
      { cols: 100, rows: 30 },
    ]);

    // Only the first post-reattach resize jiggles; later ones pass through.
    client2.send(JSON.stringify({ type: 'pty-resize', cols: 100, rows: 30 }));
    await wait(50);
    expect(handle.resizes.slice(3)).toEqual([{ cols: 100, rows: 30 }]);

    client2.send(JSON.stringify({ type: 'pty-stop' }));
    client2.close();
    await wait(50);
  });

  it('a size that actually changed after reattach resizes once, without a jiggle', async () => {
    const client = await connect();
    client.send(JSON.stringify({ type: 'pty-start', sessionId: 'reattach-sess-3' }));
    await wait(100);
    const handle = backend.spawns[backend.spawns.length - 1].handle;
    client.send(JSON.stringify({ type: 'pty-resize', cols: 100, rows: 30 }));
    await wait(50);
    client.close();
    await wait(100);

    const client2 = await connect();
    client2.send(JSON.stringify({ type: 'pty-start', sessionId: 'reattach-sess-3' }));
    await wait(100);
    client2.send(JSON.stringify({ type: 'pty-resize', cols: 120, rows: 40 }));
    await wait(50);
    // A real size change delivers SIGWINCH by itself — no jiggle needed.
    expect(handle.resizes.slice(1)).toEqual([{ cols: 120, rows: 40 }]);

    client2.send(JSON.stringify({ type: 'pty-stop' }));
    client2.close();
    await wait(50);
  });

  it('an unknown sessionId spawns a fresh shell with no pty-attach', async () => {
    const client = await connect();
    const frames: WsFrame[] = [];
    client.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as WsFrame));
    const spawnsBefore = backend.spawns.length;
    client.send(JSON.stringify({ type: 'pty-start', sessionId: 'never-seen-before' }));
    await wait(100);

    expect(backend.spawns.length).toBe(spawnsBefore + 1);
    expect(frames.some((f) => f.type === 'pty-attach')).toBe(false);

    client.send(JSON.stringify({ type: 'pty-stop' }));
    client.close();
    await wait(50);
  });

  it('a pty that exits while detached is gone: reattaching spawns fresh', async () => {
    const client = await connect();
    client.send(JSON.stringify({ type: 'pty-start', sessionId: 'reattach-sess-4' }));
    await wait(100);
    const handle = backend.spawns[backend.spawns.length - 1].handle;
    client.close();
    await wait(100);
    expect(handle.killed).toBe(false);

    handle.emitExit(0); // the shell died on its own while nobody was attached

    const client2 = await connect();
    const frames2: WsFrame[] = [];
    client2.on('message', (raw) => frames2.push(JSON.parse(raw.toString()) as WsFrame));
    const spawnsBefore = backend.spawns.length;
    client2.send(JSON.stringify({ type: 'pty-start', sessionId: 'reattach-sess-4' }));
    await wait(100);

    expect(backend.spawns.length).toBe(spawnsBefore + 1);
    expect(frames2.some((f) => f.type === 'pty-attach')).toBe(false);

    client2.send(JSON.stringify({ type: 'pty-stop' }));
    client2.close();
    await wait(50);
  });

  it('pty-stop still kills a session-tokened pty immediately (no linger)', async () => {
    const client = await connect();
    client.send(JSON.stringify({ type: 'pty-start', sessionId: 'reattach-sess-5' }));
    await wait(100);
    const handle = backend.spawns[backend.spawns.length - 1].handle;

    client.send(JSON.stringify({ type: 'pty-stop' }));
    await wait(50);
    expect(handle.killed).toBe(true);

    // Reattach after an explicit stop must spawn fresh, not resurrect.
    const frames: WsFrame[] = [];
    client.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as WsFrame));
    const spawnsBefore = backend.spawns.length;
    client.send(JSON.stringify({ type: 'pty-start', sessionId: 'reattach-sess-5' }));
    await wait(100);
    expect(backend.spawns.length).toBe(spawnsBefore + 1);
    expect(frames.some((f) => f.type === 'pty-attach')).toBe(false);

    client.send(JSON.stringify({ type: 'pty-stop' }));
    client.close();
    await wait(50);
  });

  it('replay is capped server-side: pty-attach reports dropped bytes past the cap', async () => {
    const client = await connect();
    client.send(JSON.stringify({ type: 'pty-start', sessionId: 'reattach-sess-6' }));
    await wait(100);
    const handle = backend.spawns[backend.spawns.length - 1].handle;
    // 200KB cap + 16KB slack: push well past both so a trim must have happened.
    handle.emitData('x'.repeat(150 * 1024));
    handle.emitData('y'.repeat(150 * 1024));
    client.close();
    await wait(100);

    const client2 = await connect();
    const frames2: WsFrame[] = [];
    client2.on('message', (raw) => frames2.push(JSON.parse(raw.toString()) as WsFrame));
    client2.send(JSON.stringify({ type: 'pty-start', sessionId: 'reattach-sess-6' }));
    await wait(100);

    const attach = frames2.find((f) => f.type === 'pty-attach');
    expect(attach && attach.type === 'pty-attach' && attach.replay.length).toBe(200 * 1024);
    expect(attach && attach.type === 'pty-attach' && attach.dropped).toBe(100 * 1024);

    client2.send(JSON.stringify({ type: 'pty-stop' }));
    client2.close();
    await wait(50);
  });

  it('kills a detached pty after the linger timeout', async () => {
    const ownBackend = new FakeBackend();
    const own = await startOwnServer(ownBackend, () => Promise.resolve(process.env), {
      detachLingerMs: 80,
    });
    try {
      const client = await own.connect();
      client.send(JSON.stringify({ type: 'pty-start', sessionId: 'linger-sess' }));
      await wait(100);
      const handle = ownBackend.spawns[0].handle;
      client.close();
      await wait(30);
      expect(handle.killed).toBe(false); // still inside the linger window

      await wait(150);
      expect(handle.killed).toBe(true); // linger expired with nobody reattached

      // A late reattach finds nothing and spawns fresh.
      const client2 = await own.connect();
      const frames2: WsFrame[] = [];
      client2.on('message', (raw) => frames2.push(JSON.parse(raw.toString()) as WsFrame));
      client2.send(JSON.stringify({ type: 'pty-start', sessionId: 'linger-sess' }));
      await wait(100);
      expect(ownBackend.spawns.length).toBe(2);
      expect(frames2.some((f) => f.type === 'pty-attach')).toBe(false);
      client2.close();
      await wait(50);
    } finally {
      await new Promise<void>((resolve) => own.server.close(() => resolve()));
    }
  });

  it('closing the http server kills detached ptys too (no orphans on app quit)', async () => {
    const ownBackend = new FakeBackend();
    const own = await startOwnServer(ownBackend, () => Promise.resolve(process.env));
    const client = await own.connect();
    client.send(JSON.stringify({ type: 'pty-start', sessionId: 'quit-sess' }));
    await wait(100);
    const handle = ownBackend.spawns[0].handle;
    client.close();
    await wait(100);
    expect(handle.killed).toBe(false); // detached, still alive

    await new Promise<void>((resolve) => own.server.close(() => resolve()));
    expect(handle.killed).toBe(true);
  });
});

describe('pty-start while environment resolution is pending', () => {
  it('buffers input and only the latest resize until the pty starts', async () => {
    const env = deferred<NodeJS.ProcessEnv>();
    const ownBackend = new FakeBackend();
    const own = await startOwnServer(ownBackend, () => env.promise);
    const client = await own.connect();
    try {
      client.send(JSON.stringify({ type: 'pty-start' }));
      client.send(JSON.stringify({ type: 'pty-input', data: 'echo buffered\r' }));
      client.send(JSON.stringify({ type: 'pty-resize', cols: 90, rows: 30 }));
      client.send(JSON.stringify({ type: 'pty-resize', cols: 120, rows: 40 }));
      await wait(25);
      expect(ownBackend.spawns).toHaveLength(0);

      env.resolve({ PATH: '/test/bin' });
      await wait(25);
      expect(ownBackend.spawns).toHaveLength(1);
      expect(ownBackend.spawns[0].handle.writes).toEqual(['echo buffered\r']);
      expect(ownBackend.spawns[0].handle.resizes).toEqual([{ cols: 120, rows: 40 }]);
    } finally {
      client.close();
      await new Promise<void>((resolve) => own.server.close(() => resolve()));
    }
  });

  it('does not spawn after stop, close, or a superseding start cancels the pending request', async () => {
    const env = deferred<NodeJS.ProcessEnv>();
    const ownBackend = new FakeBackend();
    const own = await startOwnServer(ownBackend, () => env.promise);
    const stopped = await own.connect();
    const closed = await own.connect();
    const superseded = await own.connect();
    try {
      stopped.send(JSON.stringify({ type: 'pty-start' }));
      stopped.send(JSON.stringify({ type: 'pty-stop' }));
      closed.send(JSON.stringify({ type: 'pty-start' }));
      closed.close();
      superseded.send(JSON.stringify({ type: 'pty-start' }));
      superseded.send(JSON.stringify({ type: 'pty-start' }));
      await wait(25);

      env.resolve({ PATH: '/test/bin' });
      await wait(25);
      expect(ownBackend.spawns).toHaveLength(1);
    } finally {
      stopped.close();
      superseded.close();
      await new Promise<void>((resolve) => own.server.close(() => resolve()));
    }
  });
});

describe('pty env under a GUI-app (minimal) PATH', () => {
  // A Finder-launched Electron app gets only the system PATH; the pty must be
  // spawned with the login-shell PATH merged in, or `claude`/`codex`/`hearth`
  // ENOENT for every real desktop user. Own server instance: getPtyEnv is
  // memoized per attachWebSocket, and the login-shell cache is per-process.
  it.skipIf(process.platform === 'win32')(
    'merges the login-shell PATH into the env the pty is spawned with',
    async () => {
      const fakeBinDir = path.join(tmpDir, 'login-only-bin');
      await fsp.mkdir(fakeBinDir, { recursive: true });
      const fakeShell = path.join(tmpDir, 'fake-login-shell');
      await fsp.writeFile(
        fakeShell,
        '#!/bin/sh\n' +
          'echo "rc banner noise"\n' +
          `PATH="${fakeBinDir}:$PATH"\n` +
          'export PATH\n' +
          'for last in "$@"; do :; done\n' +
          'eval "$last"\n',
      );
      await fsp.chmod(fakeShell, 0o755);

      const prevShell = process.env.SHELL;
      process.env.SHELL = fakeShell;
      resetLoginShellPathCacheForTests();

      const ownBackend = new FakeBackend();
      const ownServer = http.createServer((_req, res) => {
        res.statusCode = 404;
        res.end();
      });
      attachWebSocket(ownServer, ctx, ownBackend);
      await new Promise<void>((resolve) => ownServer.listen(0, '127.0.0.1', resolve));
      const address = ownServer.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      try {
        const client = await new Promise<WebSocket>((resolve, reject) => {
          const c = new WebSocket(
            `ws://127.0.0.1:${port}/api/ws?project=${encodeURIComponent(projectRoot)}`,
          );
          c.on('open', () => resolve(c));
          c.on('error', reject);
        });
        client.send(JSON.stringify({ type: 'pty-start' }));
        // The first pty-start resolves the login shell + hearth shim; poll
        // instead of a fixed wait so a slow spawn can't flake this.
        let spawned = ownBackend.spawns.length > 0;
        for (let i = 0; i < 100 && !spawned; i++) {
          await wait(50);
          spawned = ownBackend.spawns.length > 0;
        }
        expect(spawned).toBe(true);
        const env = ownBackend.spawns[0].opts.env;
        expect(env.PATH?.split(path.delimiter)).toContain(fakeBinDir);
        client.close();
        await wait(50);
      } finally {
        if (prevShell === undefined) delete process.env.SHELL;
        else process.env.SHELL = prevShell;
        resetLoginShellPathCacheForTests();
        await new Promise<void>((resolve) => ownServer.close(() => resolve()));
      }
    },
  );
});
