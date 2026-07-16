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
import { resetLoginShellPathCacheForTests } from '../server/agentSetup';
import type { PtyBackend, PtyHandle } from '../server/ptyManager';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakePtyHandle implements PtyHandle {
  dataCbs: Array<(d: string) => void> = [];
  exitCbs: Array<(e: { exitCode: number }) => void> = [];
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;

  onData(cb: (d: string) => void): void {
    this.dataCbs.push(cb);
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCbs.push(cb);
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
  // GUI-launched-app fix in ws.ts/agentSetup.ts). Keep this suite hermetic
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
  attachWebSocket(server, ctx, backend);

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

describe('pty-* frame routing over /api/ws', () => {
  it('pty-start spawns via the backend with cwd=root, and pty-data/pty-exit flow back to the same socket', async () => {
    const client = await connect();
    const frames: WsFrame[] = [];
    client.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as WsFrame));

    client.send(JSON.stringify({ type: 'pty-start', command: 'shell' }));
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
    client.send(JSON.stringify({ type: 'pty-start', command: 'shell' }));
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
    client.send(JSON.stringify({ type: 'pty-start', command: 'shell' }));
    await wait(100);

    const handle = backend.spawns[backend.spawns.length - 1].handle;
    expect(handle.killed).toBe(false);

    client.close();
    await wait(100);

    expect(handle.killed).toBe(true);
  });

  it('pty-stop explicitly kills the pty without waiting for the socket to close', async () => {
    const client = await connect();
    client.send(JSON.stringify({ type: 'pty-start', command: 'shell' }));
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
    owner.send(JSON.stringify({ type: 'pty-start', command: 'shell' }));
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
    client.send(JSON.stringify({ type: 'pty-start', command: 'shell' }));
    await wait(100);
    const first = backend.spawns[backend.spawns.length - 1].handle;

    client.send(JSON.stringify({ type: 'pty-start', command: 'claude' }));
    await wait(100);

    expect(first.killed).toBe(true);
    expect(backend.spawns[backend.spawns.length - 1].file).toBe('claude');

    client.close();
    await wait(50);
  });

  it('a stale exit from a stopped pty does not disturb the replacement session', async () => {
    const client = await connect();
    const frames: WsFrame[] = [];
    client.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as WsFrame));

    client.send(JSON.stringify({ type: 'pty-start', command: 'shell' }));
    await wait(100);
    const first = backend.spawns[backend.spawns.length - 1].handle;

    client.send(JSON.stringify({ type: 'pty-stop' }));
    await wait(50);
    expect(first.killed).toBe(true);

    client.send(JSON.stringify({ type: 'pty-start', command: 'claude' }));
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
        client.send(JSON.stringify({ type: 'pty-start', command: 'claude' }));
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
