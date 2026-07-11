/**
 * Integration test for the WebSocket channel: a bare node:http server with
 * attachWebSocket, a real `ws` client, and a SECOND HearthSession (source
 * 'cli') mutating the same project root as the editor's context. Verifies
 * both halves of external-change awareness: the journal frame arrives over
 * the socket, and the editor context's cached session is invalidated so the
 * next /api/command reflects the change without a manual reopen.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';
import { createProject, HearthSession, PERMISSION_MODES } from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import { createProjectServerContext, type ProjectServerContext } from '../server/projectServer';
import { attachWebSocket, type WsFrame } from '../server/ws';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let tmpDir: string;
let projectRoot: string;
let ctx: ProjectServerContext;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-ws-test-'));
  const nodeFs = new NodeFileSystem();
  projectRoot = path.join(tmpDir, 'proj');
  await createProject(nodeFs, projectRoot, { name: 'WS Test Project' });

  ctx = createProjectServerContext({
    recentsFile: path.join(tmpDir, 'recent-projects.json'),
    repoRoot: tmpDir,
  });

  server = http.createServer((req, res) => {
    res.statusCode = 404;
    res.end();
  });
  attachWebSocket(server, ctx);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('attachWebSocket', () => {
  it('broadcasts journal frames for external mutations and reloads the cached session', async () => {
    // Establish the editor's own session for this root (source 'editor'),
    // as the real /api/command handler would on first use.
    const opened = await ctx.runCommand(projectRoot, 'inspectProject', {});
    expect((opened.body as { success: boolean }).success).toBe(true);
    expect(ctx.sessions.has(path.resolve(projectRoot))).toBe(true);

    const client = new WebSocket(`${baseUrl}/api/ws?project=${encodeURIComponent(projectRoot)}`);
    const frames: WsFrame[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on('open', resolve);
      client.on('error', reject);
    });
    client.on('message', (raw) => {
      frames.push(JSON.parse(raw.toString()) as WsFrame);
    });

    // A second, independent session on the same root, as the CLI would open.
    const nodeFs = new NodeFileSystem();
    const cliSession = await HearthSession.open(nodeFs, projectRoot, {
      granted: [...PERMISSION_MODES],
      source: 'cli',
    });
    const created = await cliSession.execute('createScene', { name: 'FromCli' });
    expect(created.success).toBe(true);

    // Give the watcher's debounce + broadcast a moment to run.
    await wait(500);

    const journalFrames = frames.filter((f): f is Extract<WsFrame, { type: 'journal' }> => f.type === 'journal');
    expect(journalFrames.length).toBeGreaterThan(0);
    const entries = journalFrames.flatMap((f) => f.entries);
    expect(entries.some((e) => e.command === 'createScene' && e.source === 'cli')).toBe(true);

    // The FIRST context's cached session must have been reloaded from disk,
    // so inspectProject through it now sees the externally created scene.
    const reInspected = await ctx.runCommand(projectRoot, 'inspectProject', {});
    const info = (reInspected.body as { data: { scenes: { name: string }[] } }).data;
    expect(info.scenes.some((s) => s.name === 'FromCli')).toBe(true);

    client.close();
  });

  it('does not reload the session for editor-sourced entries', async () => {
    const client = new WebSocket(`${baseUrl}/api/ws?project=${encodeURIComponent(projectRoot)}`);
    await new Promise<void>((resolve, reject) => {
      client.on('open', resolve);
      client.on('error', reject);
    });
    const frames: WsFrame[] = [];
    client.on('message', (raw) => {
      frames.push(JSON.parse(raw.toString()) as WsFrame);
    });

    const sessionBefore = ctx.sessions.get(path.resolve(projectRoot));
    expect(sessionBefore).toBeDefined();

    // Own-source mutation through the editor's own context/session.
    const result = await ctx.runCommand(projectRoot, 'createScene', { name: 'FromEditor' });
    expect((result.body as { success: boolean }).success).toBe(true);

    await wait(500);

    const journalFrames = frames.filter((f): f is Extract<WsFrame, { type: 'journal' }> => f.type === 'journal');
    const entries = journalFrames.flatMap((f) => f.entries);
    expect(entries.some((e) => e.command === 'createScene' && e.source === 'editor')).toBe(true);

    // Session identity unchanged: an editor-sourced entry must not have
    // triggered a cache invalidation/reload.
    expect(ctx.sessions.get(path.resolve(projectRoot))).toBe(sessionBefore);

    client.close();
  });

  it('rejects the upgrade when Origin is cross-site', async () => {
    const client = new WebSocket(`${baseUrl}/api/ws?project=${encodeURIComponent(projectRoot)}`, {
      headers: { Origin: 'https://evil.example' },
    });
    const failure = await new Promise<Error | null>((resolve) => {
      client.on('open', () => resolve(null));
      client.on('error', (err) => resolve(err));
    });
    expect(failure).not.toBeNull();
    client.close();
  });

  it('allows the upgrade with a localhost Origin and still carries journal frames', async () => {
    const client = new WebSocket(`${baseUrl}/api/ws?project=${encodeURIComponent(projectRoot)}`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    const frames: WsFrame[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on('open', resolve);
      client.on('error', reject);
    });
    client.on('message', (raw) => {
      frames.push(JSON.parse(raw.toString()) as WsFrame);
    });

    const nodeFs = new NodeFileSystem();
    const cliSession = await HearthSession.open(nodeFs, projectRoot, {
      granted: [...PERMISSION_MODES],
      source: 'cli',
    });
    const created = await cliSession.execute('createScene', { name: 'FromCliOriginTest' });
    expect(created.success).toBe(true);

    await wait(500);

    const journalFrames = frames.filter((f): f is Extract<WsFrame, { type: 'journal' }> => f.type === 'journal');
    expect(journalFrames.length).toBeGreaterThan(0);

    client.close();
  });
});
