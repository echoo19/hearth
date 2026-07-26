/**
 * The harness registry route.
 *
 * What these pin, in the order they matter:
 *   1. built-ins are facts about the app, merged over whatever the folder
 *      wrote — and a project file can never shadow one (or claim `active` for
 *      a skill nothing runs);
 *   2. an upsert records a user entry with a status the app can back
 *      ('available' / 'coming-soon'), and a rename keeps the rest of it;
 *   3. remove takes user entries only;
 *   4. the jail: every operation refuses a folder that was never opened;
 *   5. the body is validated before anything reaches the disk;
 *   6. the one-line mount in projectServer.ts really does serve the route,
 *      proven over real HTTP rather than by reading the source.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProjectServerContext,
  handleApiRequest,
  type ProjectServerContext,
} from '../server/projectServer';
import {
  BUILTIN_REGISTRY,
  getHarnessRegistry,
  harnessFilePath,
  parseRegistryFile,
  postHarnessRegistry,
  readUserRegistry,
  type JsonResult,
} from '../server/harnessRegistry';
import { mergeRegistry, type HarnessRegistry } from '../src/harness/registry';

let tmp: string;
let folder: string;
let sealed: string;
let ctx: ProjectServerContext;

interface Payload {
  ok?: boolean;
  error?: string;
  registry?: HarnessRegistry;
  builtins?: { connectors: string[]; skills: string[] };
}

const body = (result: JsonResult): Payload => result.body as Payload;

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-harness-'));
  folder = path.join(tmp, 'my-game');
  sealed = path.join(tmp, 'never-opened');
  await fsp.mkdir(folder, { recursive: true });
  await fsp.mkdir(sealed, { recursive: true });
  ctx = createProjectServerContext({ recentsFile: path.join(tmp, 'recents.json'), repoRoot: tmp });
  await ctx.openWorkspace(folder);
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await fsp.rm(path.join(folder, '.hearth'), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('merge', () => {
  it('answers with the built-ins when the folder has registered nothing', async () => {
    const result = await getHarnessRegistry(ctx, folder);
    expect(result.status).toBe(200);
    const payload = body(result);
    expect(payload.registry?.connectors.map((c) => c.id)).toEqual(['web-games', 'godot']);
    expect(payload.registry?.skills.map((s) => s.id)).toEqual(['playtesting']);
    expect(payload.builtins).toEqual({ connectors: ['web-games', 'godot'], skills: ['playtesting'] });
  });

  it('says what is actually running, and what is only named', async () => {
    const payload = body(await getHarnessRegistry(ctx, folder));
    const web = payload.registry?.connectors.find((c) => c.id === 'web-games');
    const godot = payload.registry?.connectors.find((c) => c.id === 'godot');
    expect(web).toMatchObject({
      name: 'Web games',
      kind: 'engine',
      status: 'active',
      detail: 'playtests any web game via the built-in probe',
    });
    expect(godot).toMatchObject({ name: 'Godot', kind: 'engine', status: 'coming-soon' });
    expect(payload.registry?.skills[0]).toMatchObject({
      name: 'Playtesting',
      source: 'builtin',
      status: 'active',
      description: 'sweep, verdicts, evidence',
    });
  });

  it('puts the folder’s own entries after the built-ins', async () => {
    await postHarnessRegistry(ctx, {
      project: folder,
      action: 'upsert',
      collection: 'connectors',
      entry: { name: 'Acme MCP', kind: 'mcp' },
    });
    const payload = body(await getHarnessRegistry(ctx, folder));
    expect(payload.registry?.connectors.map((c) => c.id)).toEqual(['web-games', 'godot', 'acme-mcp']);
  });

  it('refuses to let a project file shadow a built-in id', () => {
    const user: HarnessRegistry = {
      connectors: [{ id: 'web-games', name: 'Impostor', kind: 'mcp', status: 'active' }],
      skills: [{ id: 'playtesting', name: 'Impostor', source: 'project', status: 'active' }],
    };
    const merged = mergeRegistry(BUILTIN_REGISTRY, user);
    expect(merged.connectors).toHaveLength(2);
    expect(merged.connectors[0].name).toBe('Web games');
    expect(merged.skills).toHaveLength(1);
    expect(merged.skills[0].name).toBe('Playtesting');
  });

  it('drops unparseable rows instead of blanking the file', () => {
    const parsed = parseRegistryFile({
      connectors: [
        { id: 'good', name: 'Good', kind: 'mcp', status: 'available' },
        { id: 'no-name', kind: 'mcp', status: 'available' },
        'nonsense',
        { id: 'good', name: 'Duplicate', kind: 'mcp', status: 'available' },
      ],
      skills: [{ id: 'mine', name: 'Mine', source: 'builtin', status: 'coming-soon' }],
    });
    expect(parsed.connectors.map((c) => c.id)).toEqual(['good']);
    // A project file doesn't get to call its own entry built-in.
    expect(parsed.skills[0].source).toBe('project');
  });
});

describe('upsert', () => {
  it('records a connector as registered, not running, and persists it', async () => {
    const result = await postHarnessRegistry(ctx, {
      project: folder,
      action: 'upsert',
      collection: 'connectors',
      entry: { name: 'Acme MCP', kind: 'mcp', config: { command: 'npx acme-mcp' } },
    });
    expect(result.status).toBe(200);
    const added = body(result).registry?.connectors.find((c) => c.id === 'acme-mcp');
    expect(added).toMatchObject({
      id: 'acme-mcp',
      name: 'Acme MCP',
      kind: 'mcp',
      status: 'available',
      config: { command: 'npx acme-mcp' },
    });

    const onDisk = JSON.parse(await fsp.readFile(harnessFilePath(folder), 'utf8')) as HarnessRegistry;
    // Built-ins are facts about the app, never written into a project file.
    expect(onDisk.connectors.map((c) => c.id)).toEqual(['acme-mcp']);
    expect(onDisk.skills).toEqual([]);
  });

  it('records a skill as this project’s, and not yet available', async () => {
    const result = await postHarnessRegistry(ctx, {
      project: folder,
      action: 'upsert',
      collection: 'skills',
      entry: { name: 'Level balancing', description: 'tune difficulty curves' },
    });
    expect(body(result).registry?.skills.find((s) => s.id === 'level-balancing')).toMatchObject({
      name: 'Level balancing',
      description: 'tune difficulty curves',
      source: 'project',
      status: 'coming-soon',
    });
  });

  it('gives a second entry of the same name its own id', async () => {
    for (const _ of [0, 1]) {
      await postHarnessRegistry(ctx, {
        project: folder,
        action: 'upsert',
        collection: 'connectors',
        entry: { name: 'Acme MCP', kind: 'mcp' },
      });
    }
    const user = await readUserRegistry(folder);
    expect(user.connectors.map((c) => c.id)).toEqual(['acme-mcp', 'acme-mcp-2']);
  });

  it('renames without wiping what the entry already held', async () => {
    await postHarnessRegistry(ctx, {
      project: folder,
      action: 'upsert',
      collection: 'connectors',
      entry: { name: 'Acme MCP', kind: 'mcp', config: { command: 'npx acme-mcp' } },
    });
    const renamed = await postHarnessRegistry(ctx, {
      project: folder,
      action: 'upsert',
      collection: 'connectors',
      entry: { id: 'acme-mcp', name: 'Acme tools' },
    });
    expect(body(renamed).registry?.connectors.find((c) => c.id === 'acme-mcp')).toMatchObject({
      name: 'Acme tools',
      kind: 'mcp',
      status: 'available',
      config: { command: 'npx acme-mcp' },
    });
  });

  it('refuses to edit a built-in', async () => {
    const result = await postHarnessRegistry(ctx, {
      project: folder,
      action: 'upsert',
      collection: 'connectors',
      entry: { id: 'web-games', name: 'Mine now' },
    });
    expect(result.status).toBe(400);
    expect(body(result).error).toContain('built in');
  });

  it('refuses an update to an id the folder never registered', async () => {
    const result = await postHarnessRegistry(ctx, {
      project: folder,
      action: 'upsert',
      collection: 'skills',
      entry: { id: 'ghost', name: 'Ghost' },
    });
    expect(result.status).toBe(404);
  });
});

describe('remove', () => {
  it('forgets a user entry, on disk and in the answer', async () => {
    await postHarnessRegistry(ctx, {
      project: folder,
      action: 'upsert',
      collection: 'connectors',
      entry: { name: 'Acme MCP', kind: 'mcp' },
    });
    const result = await postHarnessRegistry(ctx, {
      project: folder,
      action: 'remove',
      collection: 'connectors',
      id: 'acme-mcp',
    });
    expect(result.status).toBe(200);
    expect(body(result).registry?.connectors.map((c) => c.id)).toEqual(['web-games', 'godot']);
    expect((await readUserRegistry(folder)).connectors).toEqual([]);
  });

  it('refuses to remove a built-in', async () => {
    const result = await postHarnessRegistry(ctx, {
      project: folder,
      action: 'remove',
      collection: 'skills',
      id: 'playtesting',
    });
    expect(result.status).toBe(400);
    expect(body(result).error).toContain('built in');
  });

  it('404s on an id that isn’t there', async () => {
    const result = await postHarnessRegistry(ctx, {
      project: folder,
      action: 'remove',
      collection: 'connectors',
      id: 'nothing-here',
    });
    expect(result.status).toBe(404);
  });
});

describe('the jail', () => {
  it('refuses to read a folder nobody opened', async () => {
    const result = await getHarnessRegistry(ctx, sealed);
    expect(result.status).toBe(403);
    expect(body(result).error).toContain('not open');
  });

  it('refuses to write into a folder nobody opened', async () => {
    const result = await postHarnessRegistry(ctx, {
      project: sealed,
      action: 'upsert',
      collection: 'connectors',
      entry: { name: 'Sneaky', kind: 'mcp' },
    });
    expect(result.status).toBe(403);
    await expect(fsp.access(harnessFilePath(sealed))).rejects.toThrow();
  });

  it('wants a project at all', async () => {
    expect((await getHarnessRegistry(ctx, undefined)).status).toBe(400);
    expect((await postHarnessRegistry(ctx, { action: 'upsert', collection: 'skills' })).status).toBe(400);
  });
});

describe('validation', () => {
  it('rejects an unknown action or collection', async () => {
    expect((await postHarnessRegistry(ctx, { project: folder, action: 'nuke', collection: 'skills' })).status).toBe(400);
    expect(
      (await postHarnessRegistry(ctx, { project: folder, action: 'upsert', collection: 'gadgets' })).status,
    ).toBe(400);
  });

  it('rejects a nameless entry, and says which field', async () => {
    const result = await postHarnessRegistry(ctx, {
      project: folder,
      action: 'upsert',
      collection: 'connectors',
      entry: { kind: 'mcp' },
    });
    expect(result.status).toBe(400);
    expect(body(result).error).toContain('name');
  });

  it('rejects a new connector with no kind', async () => {
    const result = await postHarnessRegistry(ctx, {
      project: folder,
      action: 'upsert',
      collection: 'connectors',
      entry: { name: 'Kindless' },
    });
    expect(result.status).toBe(400);
    expect(body(result).error).toContain('kind');
  });

  it('rejects a kind the app doesn’t offer (including "builtin")', async () => {
    for (const kind of ['builtin', 'telepathy']) {
      const result = await postHarnessRegistry(ctx, {
        project: folder,
        action: 'upsert',
        collection: 'connectors',
        entry: { name: 'Nope', kind },
      });
      expect(result.status).toBe(400);
    }
    expect(await readUserRegistry(folder)).toEqual({ connectors: [], skills: [] });
  });

  it('rejects an id shaped like a path escape', async () => {
    const result = await postHarnessRegistry(ctx, {
      project: folder,
      action: 'remove',
      collection: 'skills',
      id: '../../etc/passwd',
    });
    expect(result.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The mount itself
// ---------------------------------------------------------------------------

describe('GET/POST /api/harness/registry over HTTP', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      handleApiRequest(ctx, req, res).catch((err: unknown) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('is reachable, and round-trips one entry', async () => {
    const url = `${baseUrl}/api/harness/registry`;
    const post = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: folder,
        action: 'upsert',
        collection: 'skills',
        entry: { name: 'Balance pass' },
      }),
    });
    expect(post.status).toBe(200);

    const get = await fetch(`${url}?project=${encodeURIComponent(folder)}`);
    expect(get.status).toBe(200);
    const payload = (await get.json()) as Payload;
    expect(payload.ok).toBe(true);
    expect(payload.registry?.skills.map((s) => s.id)).toEqual(['playtesting', 'balance-pass']);
  });

  it('refuses a method it doesn’t serve', async () => {
    const res = await fetch(`${baseUrl}/api/harness/registry`, { method: 'DELETE' });
    expect(res.status).toBe(405);
  });
});
