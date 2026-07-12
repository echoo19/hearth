/**
 * Tests for the project server's desktop-export routes:
 *   - GET  /api/export/capability  (ctx.exportCapability)
 *   - POST /api/export/desktop      (ctx.startDesktopExport) — one job at a
 *     time, progress streamed over the WS as export-progress/-done/-error.
 *
 * The real @hearth/shipping packageDesktop spawns Electron, so a stub is
 * injected via createProjectServerContext({ packageDesktop }). The web build
 * still assembles for real, so HEARTH_TOOLS_DIR points at a stub player.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';
import type { DesktopBuildResult } from '@hearth/core';
import {
  createProjectServerContext,
  attachWebSocket,
  type ProjectServerContext,
  type PackageDesktopFn,
} from '../server/projectServer';
import type { WsFrame } from '../server/ws';

const STUB_PLAYER = 'window.HearthPlayer={boot(){}}';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Progress events + a release gate the stub packager honors, so tests can
// hold a job "in flight" long enough to observe the one-at-a-time rejection.
let hold: Promise<void> | null = null;
const stubPackageDesktop: PackageDesktopFn = async (opts) => {
  const [platform] = opts.spec.platforms;
  opts.onProgress?.({ platform, stage: 'stage', message: `staging ${platform}` });
  opts.onProgress?.({ platform, stage: 'package', message: `packaging ${platform}` });
  if (hold) await hold;
  return opts.spec.platforms.map((p): DesktopBuildResult => ({
    platform: p,
    appDir: `export/desktop/${p}/App.app`,
    zip: `export/desktop/${p}.zip`,
    signed: 'adhoc',
    notarized: false,
  }));
};

let tmpDir: string;
let toolsDir: string;
let projectPath: string;
let ctx: ProjectServerContext;
let savedToolsDir: string | undefined;

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-desktop-export-'));
  toolsDir = path.join(tmpDir, 'tools');
  await fsp.mkdir(toolsDir, { recursive: true });
  await fsp.writeFile(path.join(toolsDir, 'hearth-player.js'), STUB_PLAYER);

  savedToolsDir = process.env.HEARTH_TOOLS_DIR;
  process.env.HEARTH_TOOLS_DIR = toolsDir;

  ctx = createProjectServerContext({
    recentsFile: path.join(tmpDir, 'recent-projects.json'),
    repoRoot: tmpDir,
    packageDesktop: stubPackageDesktop,
  });
  const created = await ctx.createNewProject(path.join(tmpDir, 'projects'), 'Desktop Game');
  expect(created.status).toBe(200);
  projectPath = (created.body as { path: string }).path;
});

afterAll(async () => {
  if (savedToolsDir === undefined) delete process.env.HEARTH_TOOLS_DIR;
  else process.env.HEARTH_TOOLS_DIR = savedToolsDir;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  hold = null;
});

describe('GET /api/export/capability (ctx.exportCapability)', () => {
  it('returns the signing capability and the four platform ids', async () => {
    const result = await ctx.exportCapability();
    expect(result.status).toBe(200);
    const body = result.body as {
      ok: boolean;
      capability: { mode: string };
      platforms: string[];
    };
    expect(body.ok).toBe(true);
    expect(['adhoc', 'identity', 'identity+notarize']).toContain(body.capability.mode);
    expect(body.platforms).toEqual(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64']);
  });
});

describe('POST /api/export/desktop (ctx.startDesktopExport)', () => {
  it('starts a job, streams progress on the export bus, then export-done with the result', async () => {
    const frames: WsFrame[] = [];
    const listener = (payload: { root: string; frame: WsFrame }) => frames.push(payload.frame);
    ctx.exportBus.on('frame', listener);

    const start = await ctx.startDesktopExport(projectPath, undefined, ['darwin-arm64']);
    expect(start.status).toBe(200);
    const jobId = (start.body as { ok: boolean; jobId: string }).jobId;
    expect(typeof jobId).toBe('string');

    // Wait for the job to finish (stub resolves immediately: hold === null).
    for (let i = 0; i < 100 && !frames.some((f) => f.type === 'export-done'); i++) await wait(10);
    ctx.exportBus.off('frame', listener);

    const progress = frames.filter((f) => f.type === 'export-progress');
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress.every((f) => (f as { jobId: string }).jobId === jobId)).toBe(true);
    expect((progress[0] as { stage: string }).stage).toBe('stage');

    const done = frames.find((f) => f.type === 'export-done') as
      | { type: 'export-done'; jobId: string; result: { builds: DesktopBuildResult[] } }
      | undefined;
    expect(done).toBeDefined();
    expect(done!.jobId).toBe(jobId);
    expect(done!.result.builds[0].platform).toBe('darwin-arm64');
  });

  it('rejects a second start while one is running (409-style), then allows a new one after it finishes', async () => {
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = await ctx.startDesktopExport(projectPath, undefined, ['darwin-arm64']);
    expect(first.status).toBe(200);

    const second = await ctx.startDesktopExport(projectPath, undefined, ['darwin-arm64']);
    expect(second.status).toBe(409);
    expect((second.body as { ok: boolean }).ok).toBe(false);

    // Let the first job finish, then a fresh start must be accepted again.
    release();
    for (let i = 0; i < 100; i++) {
      const probe = await ctx.startDesktopExport(projectPath, undefined, ['darwin-arm64']);
      if (probe.status === 200) {
        // Drain this probe job too so it doesn't leak into later tests.
        for (let j = 0; j < 100; j++) await wait(10);
        return;
      }
      await wait(10);
    }
    throw new Error('a new export was never accepted after the first finished');
  });

  it('rejects a missing project path', async () => {
    const result = await ctx.startDesktopExport(undefined, undefined, undefined);
    expect(result.status).toBe(400);
    expect((result.body as { ok: boolean }).ok).toBe(false);
  });
});

describe('a per-platform packageDesktop failure attributes the platform in the export-error frame', () => {
  // packages/shipping's packageDesktop tags a per-platform failure (e.g. a
  // hard codesign failure) by throwing a DesktopPackageError whose message
  // is "packaging <platform> failed: ...". session.execute() flattens that
  // to a plain {code, message} CommandIssue (the .platform property does not
  // survive), so startDesktopExport recovers the platform id from the
  // message text (extractFailingPlatform in projectServer.ts) before
  // emitting the export-error frame. This stub packageDesktop mirrors that
  // shape without depending on @hearth/shipping's Electron toolchain.
  const failingPackageDesktop: PackageDesktopFn = async (opts) => {
    const [platform] = opts.spec.platforms;
    opts.onProgress?.({ platform, stage: 'sign', message: `signing ${platform}` });
    throw new Error(`packaging ${platform} failed: codesign failed`);
  };

  let failTmpDir: string;
  let failToolsDir: string;
  let failProjectPath: string;
  let failCtx: ProjectServerContext;

  beforeAll(async () => {
    failTmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-desktop-export-fail-'));
    failToolsDir = path.join(failTmpDir, 'tools');
    await fsp.mkdir(failToolsDir, { recursive: true });
    await fsp.writeFile(path.join(failToolsDir, 'hearth-player.js'), STUB_PLAYER);

    const savedDir = process.env.HEARTH_TOOLS_DIR;
    process.env.HEARTH_TOOLS_DIR = failToolsDir;
    failCtx = createProjectServerContext({
      recentsFile: path.join(failTmpDir, 'recent-projects.json'),
      repoRoot: failTmpDir,
      packageDesktop: failingPackageDesktop,
    });
    const created = await failCtx.createNewProject(path.join(failTmpDir, 'projects'), 'Fail Game');
    expect(created.status).toBe(200);
    failProjectPath = (created.body as { path: string }).path;
    if (savedDir === undefined) delete process.env.HEARTH_TOOLS_DIR;
    else process.env.HEARTH_TOOLS_DIR = savedDir;
  });

  afterAll(async () => {
    await fsp.rm(failTmpDir, { recursive: true, force: true });
  });

  it('emits export-error with platform populated', async () => {
    const savedDir = process.env.HEARTH_TOOLS_DIR;
    process.env.HEARTH_TOOLS_DIR = failToolsDir;
    try {
      const frames: WsFrame[] = [];
      const listener = (payload: { root: string; frame: WsFrame }) => frames.push(payload.frame);
      failCtx.exportBus.on('frame', listener);

      const start = await failCtx.startDesktopExport(failProjectPath, undefined, ['win32-x64']);
      expect(start.status).toBe(200);
      const jobId = (start.body as { jobId: string }).jobId;

      for (let i = 0; i < 100 && !frames.some((f) => f.type === 'export-error'); i++) await wait(10);
      failCtx.exportBus.off('frame', listener);

      const errorFrame = frames.find((f) => f.type === 'export-error') as
        | { type: 'export-error'; jobId: string; platform?: string; message: string }
        | undefined;
      expect(errorFrame).toBeDefined();
      expect(errorFrame!.jobId).toBe(jobId);
      expect(errorFrame!.platform).toBe('win32-x64');
      expect(errorFrame!.message).toMatch(/win32-x64/);
    } finally {
      if (savedDir === undefined) delete process.env.HEARTH_TOOLS_DIR;
      else process.env.HEARTH_TOOLS_DIR = savedDir;
    }
  });
});

describe('desktop export progress over the WebSocket', () => {
  it('delivers export-progress and export-done frames to a subscribed socket', async () => {
    const server = http.createServer((req, res) => {
      res.statusCode = 404;
      res.end();
    });
    attachWebSocket(server, ctx);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const client = new WebSocket(`ws://127.0.0.1:${port}/api/ws?project=${encodeURIComponent(projectPath)}`);
    const frames: WsFrame[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on('open', resolve);
      client.on('error', reject);
    });
    client.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as WsFrame));

    const start = await ctx.startDesktopExport(projectPath, undefined, ['linux-x64']);
    const jobId = (start.body as { jobId: string }).jobId;

    for (let i = 0; i < 100 && !frames.some((f) => f.type === 'export-done'); i++) await wait(10);

    const exportFrames = frames.filter((f) => f.type.startsWith('export-'));
    expect(exportFrames.some((f) => f.type === 'export-progress' && (f as { jobId: string }).jobId === jobId)).toBe(true);
    expect(exportFrames.some((f) => f.type === 'export-done' && (f as { jobId: string }).jobId === jobId)).toBe(true);

    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
