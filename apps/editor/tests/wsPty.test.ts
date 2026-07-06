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
import type { PtyBackend, PtyHandle } from '../server/ptyManager';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakePtyHandle implements PtyHandle {
  dataCbs: Array<(d: string) => void> = [];
  exitCbs: Array<(e: { exitCode: number }) => void> = [];
  writes: string[] = [];
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
  resize(): void {}
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
  spawns: Array<{ file: string; args: string[]; opts: { cwd: string }; handle: FakePtyHandle }> = [];
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

beforeAll(async () => {
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
});
