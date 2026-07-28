/**
 * The routes the app shell actually runs on: opening a plain folder (no
 * hearth.json anywhere), finding a game in it, listing its files, and serving
 * those files from the /game/ and /evidence/ static mounts.
 *
 * Handlers are functions on the context object, so no Vite or HTTP is needed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProjectServerContext,
  decodeRootKey,
  encodeRootKey,
  isHearthServerPath,
  newestMtimeMs,
  type ProjectServerContext,
} from '../server/projectServer';

let tmp: string;
let folder: string;
let ctx: ProjectServerContext;

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-workspace-'));
  folder = path.join(tmp, 'my-game');
  await fsp.mkdir(folder, { recursive: true });
  ctx = createProjectServerContext({
    recentsFile: path.join(tmp, 'recents.json'),
    repoRoot: tmp,
  });
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('root keys', () => {
  it('round-trip through base64url', () => {
    const key = encodeRootKey('/Users/someone/My Games/space shooter');
    expect(key).not.toContain('/');
    expect(key).not.toContain('+');
    expect(decodeRootKey(key)).toBe('/Users/someone/My Games/space shooter');
  });

  it('refuses an empty decode rather than resolving to the filesystem root', () => {
    expect(decodeRootKey('')).toBeNull();
  });
});

describe('isHearthServerPath', () => {
  it('claims the api and nothing else', () => {
    expect(isHearthServerPath('/api/meta')).toBe(true);
    expect(isHearthServerPath('/')).toBe(false);
    expect(isHearthServerPath('/assets/index-abc.js')).toBe(false);
  });

  it('does NOT claim the game or evidence mounts, which live on their own origin', () => {
    // Project bytes must never be served from the origin that runs commands
    // and spawns shells. See server/gameServer.ts.
    expect(isHearthServerPath('/game/abc/index.html')).toBe(false);
    expect(isHearthServerPath('/evidence/abc/shot.png')).toBe(false);
  });
});

describe('openWorkspace', () => {
  it('opens a folder with no hearth.json in it', async () => {
    const result = await ctx.openWorkspace(folder);
    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; path: string; name: string; isHearthProject: boolean };
    expect(body.ok).toBe(true);
    expect(body.path).toBe(folder);
    expect(body.name).toBe('my-game');
    expect(body.isHearthProject).toBe(false);
  });

  it('refuses a path that is not a folder', async () => {
    const result = await ctx.openWorkspace(path.join(tmp, 'nope'));
    expect(result.status).toBe(400);
    expect((result.body as { ok: boolean }).ok).toBe(false);
  });

  it('refuses a missing path', async () => {
    expect((await ctx.openWorkspace(undefined)).status).toBe(400);
    expect((await ctx.openWorkspace('  ')).status).toBe(400);
  });

  it('remembers the folder in recents', async () => {
    await ctx.openWorkspace(folder);
    const body = (await ctx.recentWorkspaces()).body as { projects: { path: string; exists: boolean }[] };
    expect(body.projects.some((p) => p.path === folder && p.exists)).toBe(true);
  });
});

describe('gameStatus', () => {
  it('reports no game for an empty folder', async () => {
    await ctx.openWorkspace(folder);
    const body = (await ctx.gameStatus(folder)).body as { present: boolean; entry: string | null };
    expect(body.present).toBe(false);
    expect(body.entry).toBeNull();
  });

  it('finds a game at the folder root and timestamps it', async () => {
    await fsp.writeFile(path.join(folder, 'index.html'), '<canvas id="c"></canvas>');
    const body = (await ctx.gameStatus(folder)).body as { present: boolean; entry: string; mtime: number };
    expect(body.present).toBe(true);
    expect(body.entry).toBe('index.html');
    expect(body.mtime).toBeGreaterThan(0);
  });

  it('prefers the root entry over a nested one', async () => {
    await fsp.mkdir(path.join(folder, 'game'), { recursive: true });
    await fsp.writeFile(path.join(folder, 'game', 'index.html'), '<p>nested</p>');
    const body = (await ctx.gameStatus(folder)).body as { entry: string };
    expect(body.entry).toBe('index.html');
  });

  it('refuses a folder that was never opened', async () => {
    expect((await ctx.gameStatus(path.join(tmp, 'unopened'))).status).toBe(403);
  });
});

describe('newestMtimeMs', () => {
  it('rises when a file in the tree is rewritten', async () => {
    const before = await newestMtimeMs(folder);
    await new Promise((resolve) => setTimeout(resolve, 12));
    await fsp.writeFile(path.join(folder, 'main.js'), '// v2');
    expect(await newestMtimeMs(folder)).toBeGreaterThan(before);
  });

  it('ignores the noise directories', async () => {
    const heavy = path.join(folder, 'node_modules', 'pkg');
    await fsp.mkdir(heavy, { recursive: true });
    const before = await newestMtimeMs(folder);
    await new Promise((resolve) => setTimeout(resolve, 12));
    await fsp.writeFile(path.join(heavy, 'index.js'), 'module.exports = 1');
    expect(await newestMtimeMs(folder)).toBe(before);
  });
});

describe('listFiles', () => {
  it('lists the folder, skipping the noise directories', async () => {
    const body = (await ctx.listFiles(folder)).body as { files: { path: string }[] };
    const paths = body.files.map((f) => f.path);
    expect(paths).toContain('index.html');
    expect(paths).toContain('main.js');
    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
  });

  it('refuses a folder that was never opened', async () => {
    expect((await ctx.listFiles(path.join(tmp, 'unopened'))).status).toBe(403);
  });
});

describe('probeStatus', () => {
  it('reports the senses a plain web game gives up', async () => {
    const body = (await ctx.probeStatus(folder)).body as { senses: string[] };
    expect(body.senses).toContain('preview');
  });
});

describe('static mounts', () => {
  it('serves the game entry as html', async () => {
    const result = await ctx.serveMounted('game', encodeRootKey(folder), 'index.html');
    expect(result.status).toBe(200);
    expect(result.contentType).toContain('text/html');
    expect(Buffer.from(result.data!).toString('utf8')).toContain('<canvas');
  });

  it('serves a nested asset so a game’s relative urls resolve', async () => {
    const result = await ctx.serveMounted('game', encodeRootKey(folder), 'game/index.html');
    expect(result.status).toBe(200);
  });

  it('serves evidence files from the evidence folder', async () => {
    await fsp.mkdir(path.join(folder, '.hearth', 'evidence', 'sweeps'), { recursive: true });
    await fsp.writeFile(path.join(folder, '.hearth', 'evidence', 'sweeps', 'a.png'), 'PNGDATA');
    const result = await ctx.serveMounted('evidence', encodeRootKey(folder), 'sweeps/a.png');
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('image/png');
  });

  it('refuses a path that escapes the mount', async () => {
    const result = await ctx.serveMounted('game', encodeRootKey(folder), '../../etc/passwd');
    expect(result.status).toBe(403);
  });

  it('refuses a folder that was never opened', async () => {
    const result = await ctx.serveMounted('game', encodeRootKey(path.join(tmp, 'unopened')), 'index.html');
    expect(result.status).toBe(403);
  });

  it('refuses a malformed key rather than guessing a root', async () => {
    const result = await ctx.serveMounted('game', '', 'index.html');
    expect(result.status).toBe(400);
  });

  it('404s a file that is not there', async () => {
    const result = await ctx.serveMounted('game', encodeRootKey(folder), 'missing.js');
    expect(result.status).toBe(404);
  });
});

describe('app settings route', () => {
  it('reports no key, saves one, then reports it as the folder’s', async () => {
    const before = (await ctx.getAppSettings(folder)).body as { hasKey: boolean; source: string | null };
    expect(before.hasKey).toBe(false);
    expect(before.source).toBeNull();

    const after = (await ctx.setAppSettings(folder, 'sk-test')).body as { hasKey: boolean; source: string };
    expect(after.hasKey).toBe(true);
    expect(after.source).toBe('project');
  });

  it('never returns the key itself', async () => {
    const body = (await ctx.getAppSettings(folder)).body;
    expect(JSON.stringify(body)).not.toContain('sk-test');
  });

  it('refuses to write into a folder that was never opened', async () => {
    expect((await ctx.setAppSettings(path.join(tmp, 'unopened'), 'sk-x')).status).toBe(403);
  });
});
