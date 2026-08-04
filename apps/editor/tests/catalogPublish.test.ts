/**
 * Publishing to the Hearth Catalog.
 *
 * What these pin, in the order they matter:
 *   1. the token is a bearer credential — a bad shape never reaches the
 *      network, a token the catalog refuses never reaches the disk, the file
 *      that does get written is 0600, and the raw value is in no response;
 *   2. `.hearth/` and `node_modules/` are never in a manifest — the first
 *      holds chat transcripts and the token file's sibling;
 *   3. the folder's stored ref makes a second publish an UPDATE: the same
 *      slug goes up, the same game id comes back, no `my-game-2`;
 *   4. every refusal is a sentence someone can act on, including the
 *      catalog's own, and none of them is a stack trace.
 *
 * The catalog is a stub: `fetch` is replaced and every request recorded, so
 * the whole three-step flow is checked without a network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  catalogAccountPath,
  clearAccount,
  getAccount,
  getProjectInfo,
  ownsCatalogPath,
  projectRefPath,
  publish,
  routeCatalog,
  saveAccount,
  type CatalogAccount,
  type CatalogHost,
  type CatalogProjectInfo,
  type CatalogResult,
  type PublishResult,
} from '../server/catalogPublish';

const API = 'http://catalog.test';
const TOKEN = `hpub_${'a1b2c3d4'.repeat(5)}`; // 40 hex characters

let tmp: string;
let home: string;
let folder: string;
let host: CatalogHost;

interface Payload {
  ok?: boolean;
  error?: string;
  username?: string | null;
  account?: CatalogAccount;
  info?: CatalogProjectInfo;
  result?: PublishResult;
}

const body = (result: CatalogResult): Payload => result.body as Payload;

// ---------------------------------------------------------------------------
// The stub catalog
// ---------------------------------------------------------------------------

interface Recorded {
  method: string;
  url: string;
  auth: string | null;
  contentType: string | null;
  json: Record<string, unknown> | null;
  bytes: number;
}

interface StubOptions {
  username?: string;
  /** Answer /api/v1/me with this instead of a user. */
  meError?: { status: number; code: string; message: string };
  /** Answer POST /api/v1/games with this instead of a game. */
  gamesError?: { status: number; code: string; message: string };
  /** Fail every PUT to a signed URL. */
  uploadsFail?: boolean;
}

let calls: Recorded[] = [];
/** slug → id, so republishing the same slug hands back the same game. */
let games: Map<string, string>;

function reply(status: number, payload: unknown): unknown {
  const text = JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function installCatalog(options: StubOptions = {}): void {
  calls = [];
  games = new Map();
  let nextId = 1;

  vi.stubGlobal('fetch', async (input: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const headers = init.headers ?? {};
    const raw = init.body;
    let json: Record<string, unknown> | null = null;
    if (typeof raw === 'string') {
      try {
        json = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        json = null;
      }
    }
    calls.push({
      method,
      url,
      auth: headers.authorization ?? null,
      contentType: headers['content-type'] ?? null,
      json,
      bytes: typeof raw === 'string' ? raw.length : ((raw as Uint8Array | undefined)?.byteLength ?? 0),
    });

    const route = url.startsWith(API) ? url.slice(API.length) : url;

    if (route === '/api/v1/me') {
      if (options.meError) return reply(options.meError.status, { error: options.meError });
      return reply(200, { user: { id: 'u1', username: options.username ?? 'jake' } });
    }

    if (route === '/api/v1/games' && method === 'POST') {
      if (options.gamesError) return reply(options.gamesError.status, { error: options.gamesError });
      const slug = typeof json?.slug === 'string' ? json.slug : slugify(String(json?.title ?? ''));
      const existing = games.get(slug);
      const id = existing ?? `game-${nextId++}`;
      games.set(slug, id);
      return reply(existing ? 200 : 201, {
        created: !existing,
        game: { id, slug, title: json?.title, status: 'draft' },
      });
    }

    const files = /^\/api\/v1\/games\/([^/]+)\/files$/.exec(route);
    if (files && method === 'POST') {
      const manifest = (json?.files ?? []) as { path: string }[];
      return reply(200, {
        entry: 'index.html',
        replace: true,
        stale: 0,
        expires_in: 900,
        uploads: manifest.map((f) => ({ path: f.path, url: `${API}/signed/${f.path}` })),
      });
    }

    const cover = /^\/api\/v1\/games\/([^/]+)\/cover$/.exec(route);
    if (cover && method === 'POST') {
      return reply(200, { cover: { path: 'c.png', url: `${API}/c.png`, bytes: 4 } });
    }

    const done = /^\/api\/v1\/games\/([^/]+)\/publish$/.exec(route);
    if (done && method === 'POST') {
      const id = done[1] as string;
      const slug = [...games.entries()].find(([, value]) => value === id)?.[0] ?? 'unknown';
      return reply(200, {
        url: `${API}/g/${slug}`,
        removed: 0,
        game: {
          id,
          slug,
          title: 'Whatever',
          status: json?.draft === true ? 'draft' : 'published',
          entry_path: json?.entry_path,
          file_count: 3,
          total_bytes: 1234,
          published_at: '2026-08-03T00:00:00.000Z',
        },
      });
    }

    if (route.startsWith(`${API}/signed/`) || url.startsWith(`${API}/signed/`)) {
      return options.uploadsFail ? reply(500, { error: 'nope' }) : reply(200, {});
    }

    return reply(404, { error: { code: 'not_found', message: `no stub for ${method} ${route}` } });
  });
}

/** Writes a token straight to disk, the state left by a successful connect. */
async function connect(username = 'jake'): Promise<void> {
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(
    catalogAccountPath(),
    JSON.stringify({ token: TOKEN, api: API, username }),
    { mode: 0o600 },
  );
}

async function write(rel: string, text: string): Promise<void> {
  const file = path.join(folder, ...rel.split('/'));
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text, 'utf8');
}

/** A folder that can actually be published: entry HTML plus noise to ignore. */
async function makeGame(): Promise<void> {
  await write('index.html', '<!doctype html><title>go</title>');
  await write('game.js', 'console.log(1)');
  await write('assets/sprite.png', 'PNG');
  await write('.hearth/chat/transcript.json', '{"secrets":"yes"}');
  await write('.hearth/catalog-notes.txt', 'private');
  await write('node_modules/left-pad/index.js', 'module.exports=1');
  await write('.env', 'API_KEY=hunter2');
}

const exists = async (file: string): Promise<boolean> =>
  fsp.access(file).then(() => true, () => false);

// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-catalog-'));
  home = path.join(tmp, 'home');
  folder = path.join(tmp, 'my-cool-game');
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(folder, { recursive: true });
  process.env.HEARTH_HOME = home;
  process.env.HEARTH_CATALOG_API = API;
  host = { isOpenRoot: (root: string) => root === folder };
  installCatalog();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.HEARTH_HOME;
  delete process.env.HEARTH_CATALOG_API;
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------

describe('the stored token', () => {
  it('refuses a token of the wrong shape without asking the catalog', async () => {
    const result = await saveAccount({ token: 'hpub_nope' });

    expect(body(result).ok).toBe(false);
    expect(body(result).error).toContain('hpub_');
    expect(calls).toHaveLength(0);
    expect(await exists(catalogAccountPath())).toBe(false);
  });

  it('refuses an empty body the same way', async () => {
    expect(body(await saveAccount({})).ok).toBe(false);
    expect(body(await saveAccount(null)).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('does not write a token the catalog rejects', async () => {
    installCatalog({ meError: { status: 401, code: 'unauthorized', message: 'Send a valid token.' } });

    const result = await saveAccount({ token: TOKEN });

    expect(body(result).ok).toBe(false);
    expect(body(result).error).toMatch(/rejected/i);
    expect(await exists(catalogAccountPath())).toBe(false);
    expect(calls.map((c) => c.url)).toEqual([`${API}/api/v1/me`]);
  });

  it('leaves a working token in place when a new one is refused', async () => {
    await connect('jake');
    installCatalog({ meError: { status: 401, code: 'unauthorized', message: 'nope' } });

    await saveAccount({ token: `hpub_${'f'.repeat(40)}` });

    expect(body(await getAccount()).account).toMatchObject({ connected: true, username: 'jake' });
  });

  it('verifies, then stores 0600, and never answers with the raw token', async () => {
    const saved = await saveAccount({ token: TOKEN });

    expect(body(saved).ok).toBe(true);
    expect(body(saved).username).toBe('jake');
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${API}/api/v1/me`, auth: `Bearer ${TOKEN}` });

    const stat = await fsp.stat(catalogAccountPath());
    expect(stat.mode & 0o777).toBe(0o600);
    expect(await fsp.readFile(catalogAccountPath(), 'utf8')).toContain(TOKEN);

    const account = await getAccount();
    expect(body(account).account).toMatchObject({ connected: true, username: 'jake', api: API });
    for (const result of [saved, account]) {
      expect(JSON.stringify(result.body)).not.toContain(TOKEN);
    }
  });

  it('answers from disk once the username is known, without a request', async () => {
    await connect('ada');
    calls = [];

    expect(body(await getAccount()).account).toMatchObject({ connected: true, username: 'ada' });
    expect(calls).toHaveLength(0);
  });

  it('resolves the username once for a file that was written by hand', async () => {
    await fsp.writeFile(catalogAccountPath(), JSON.stringify({ token: TOKEN, api: API }));

    expect(body(await getAccount()).account).toMatchObject({ connected: true, username: 'jake' });
    expect(calls).toHaveLength(1);

    calls = [];
    expect(body(await getAccount()).account).toMatchObject({ username: 'jake' });
    expect(calls).toHaveLength(0);
  });

  it('reads a missing, corrupt or tokenless file as nobody being connected', async () => {
    expect(body(await getAccount()).account).toMatchObject({ connected: false, username: null });

    await fsp.writeFile(catalogAccountPath(), 'not json at all');
    expect(body(await getAccount()).account).toMatchObject({ connected: false });

    await fsp.writeFile(catalogAccountPath(), JSON.stringify({ token: 'stolen-looking' }));
    expect(body(await getAccount()).account).toMatchObject({ connected: false });
    expect(calls).toHaveLength(0);
  });

  it('forgets the token on clear', async () => {
    await connect();

    expect(body(await clearAccount()).ok).toBe(true);
    expect(await exists(catalogAccountPath())).toBe(false);
    expect(body(await getAccount()).account).toMatchObject({ connected: false, username: null });
  });
});

// ---------------------------------------------------------------------------
// The folder
// ---------------------------------------------------------------------------

describe('what would be published', () => {
  it('refuses a folder that is not open', async () => {
    const result = await getProjectInfo(host, path.join(tmp, 'never-opened'));

    expect(result.status).toBe(403);
    expect(body(result).error).toMatch(/not open/i);
  });

  it('refuses a missing project argument', async () => {
    expect((await getProjectInfo(host, null)).status).toBe(400);
    expect((await getProjectInfo(host, '  ')).status).toBe(400);
  });

  it('finds the entry, counts only what would be sent, and suggests a title', async () => {
    await makeGame();

    const info = body(await getProjectInfo(host, folder)).info as CatalogProjectInfo;

    expect(info.entry).toBe('index.html');
    // index.html, game.js, assets/sprite.png — .hearth/, node_modules/ and
    // .env are not part of a build.
    expect(info.fileCount).toBe(3);
    expect(info.totalBytes).toBeGreaterThan(0);
    expect(info.suggestedTitle).toBe('My Cool Game');
    expect(info.published).toBeNull();
  });

  it('reports no entry rather than failing, for a folder with no game yet', async () => {
    await write('notes.md', 'someday');

    const info = body(await getProjectInfo(host, folder)).info as CatalogProjectInfo;
    expect(info.entry).toBeNull();
    expect(info.fileCount).toBe(1);
  });

  it('finds a game one folder down', async () => {
    await write('dist/index.html', '<title>built</title>');

    expect((body(await getProjectInfo(host, folder)).info as CatalogProjectInfo).entry)
      .toBe('dist/index.html');
  });
});

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

describe('publish', () => {
  it('refuses a folder that is not open, before it looks for a token', async () => {
    const result = await publish(host, { project: path.join(tmp, 'elsewhere'), title: 'Nope' });

    expect(result.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('says to connect when no token is stored', async () => {
    await makeGame();

    const result = await publish(host, { project: folder, title: 'My Cool Game' });

    expect(body(result).ok).toBe(false);
    expect(body(result).error).toMatch(/connect/i);
    expect(calls).toHaveLength(0);
  });

  it('names index.html when the folder holds no entry HTML', async () => {
    await connect();
    await write('readme.md', 'no game here');

    const result = await publish(host, { project: folder, title: 'My Cool Game' });

    expect(body(result).ok).toBe(false);
    expect(body(result).error).toContain('index.html');
    expect(calls).toHaveLength(0);
  });

  it('refuses an empty folder', async () => {
    await connect();

    expect(body(await publish(host, { project: folder, title: 'Empty' })).error)
      .toMatch(/nothing to publish/i);
  });

  it('runs the three steps and never puts .hearth or node_modules in the manifest', async () => {
    await connect();
    await makeGame();

    const result = await publish(host, { project: folder, title: 'My Cool Game' });
    expect(body(result).ok).toBe(true);

    const games = calls.find((c) => c.url === `${API}/api/v1/games`) as Recorded;
    expect(games.method).toBe('POST');
    expect(games.auth).toBe(`Bearer ${TOKEN}`);
    expect(games.json).toMatchObject({ title: 'My Cool Game', entry_path: 'index.html', made_with: 'hearth' });

    const manifest = calls.find((c) => c.url.endsWith('/files')) as Recorded;
    const paths = (manifest.json?.files as { path: string }[]).map((f) => f.path);
    expect(paths).toEqual(['assets/sprite.png', 'game.js', 'index.html']);
    expect(paths.some((p) => p.startsWith('.hearth/'))).toBe(false);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths).not.toContain('.env');
    expect(manifest.json?.replace).toBe(true);

    // Every declared file is PUT to its signed URL, with the content type
    // storage will serve it back as, and without the bearer token.
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.url).sort()).toEqual([
      `${API}/signed/assets/sprite.png`,
      `${API}/signed/game.js`,
      `${API}/signed/index.html`,
    ]);
    expect(puts.every((c) => c.auth === null)).toBe(true);
    expect(puts.find((c) => c.url.endsWith('.html'))?.contentType).toBe('text/html');
    expect(puts.find((c) => c.url.endsWith('.png'))?.contentType).toBe('image/png');

    const live = calls.find((c) => c.url.endsWith('/publish')) as Recorded;
    expect(live.json).toMatchObject({ entry_path: 'index.html', draft: false });

    expect(body(result).result).toMatchObject({
      slug: 'my-cool-game',
      url: `${API}/g/my-cool-game`,
      gameId: 'game-1',
      status: 'published',
      fileCount: 3,
    });
    expect(JSON.stringify(result.body)).not.toContain(TOKEN);
  });

  it('records where the folder went, and reports it next time it is asked', async () => {
    await connect();
    await makeGame();
    await publish(host, { project: folder, title: 'My Cool Game' });

    const ref = JSON.parse(await fsp.readFile(projectRefPath(folder), 'utf8')) as Record<string, string>;
    expect(ref).toMatchObject({ gameId: 'game-1', slug: 'my-cool-game', url: `${API}/g/my-cool-game` });
    expect(Date.parse(ref.publishedAt as string)).not.toBeNaN();
    expect(JSON.stringify(ref)).not.toContain(TOKEN);

    const info = body(await getProjectInfo(host, folder)).info as CatalogProjectInfo;
    expect(info.published).toMatchObject({ gameId: 'game-1', slug: 'my-cool-game' });
  });

  it('updates the same listing on a second publish, even when the title changes', async () => {
    await connect();
    await makeGame();
    const first = body(await publish(host, { project: folder, title: 'My Cool Game' })).result as PublishResult;

    calls = [];
    const second = body(await publish(host, { project: folder, title: 'A Totally New Name' })).result as PublishResult;

    // The stored slug goes up with the new title, so the catalog updates the
    // game instead of handing back my-cool-game-2 under a fresh id.
    const games = calls.find((c) => c.url === `${API}/api/v1/games`) as Recorded;
    expect(games.json).toMatchObject({ title: 'A Totally New Name', slug: 'my-cool-game' });
    expect(second.gameId).toBe(first.gameId);
    expect(second.slug).toBe('my-cool-game');
    expect(calls.some((c) => c.url === `${API}/api/v1/games/${first.gameId}/files`)).toBe(true);
    expect(calls.some((c) => c.url === `${API}/api/v1/games/${first.gameId}/publish`)).toBe(true);
  });

  it('lets an explicit slug win over the stored one', async () => {
    await connect();
    await makeGame();
    await publish(host, { project: folder, title: 'My Cool Game' });

    calls = [];
    await publish(host, { project: folder, title: 'My Cool Game', slug: 'somewhere-else' });

    const games = calls.find((c) => c.url === `${API}/api/v1/games`) as Recorded;
    expect(games.json).toMatchObject({ slug: 'somewhere-else' });
  });

  it('passes the catalog’s own words through, and writes no ref', async () => {
    await connect();
    await makeGame();
    installCatalog({
      gamesError: {
        status: 409,
        code: 'slug_taken',
        message: 'The slug "my-cool-game" belongs to another account. Choose a different one.',
      },
    });

    const result = await publish(host, { project: folder, title: 'My Cool Game' });

    expect(body(result).ok).toBe(false);
    expect(body(result).error).toBe(
      'The slug "my-cool-game" belongs to another account. Choose a different one.',
    );
    expect(await exists(projectRefPath(folder))).toBe(false);
  });

  it('says the token was rejected when the catalog answers 401 mid-publish', async () => {
    await connect();
    await makeGame();
    installCatalog({ gamesError: { status: 401, code: 'unauthorized', message: 'Send a valid token as…' } });

    const result = await publish(host, { project: folder, title: 'My Cool Game' });

    expect(body(result).error).toMatch(/rejected this token/i);
    expect(body(result).error).not.toMatch(/Bearer|hpub_/);
  });

  it('names an unreachable catalog instead of leaking the fetch error', async () => {
    await connect();
    await makeGame();
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });

    const result = await publish(host, { project: folder, title: 'My Cool Game' });

    expect(body(result).error).toContain('Could not reach the Hearth Catalog');
    expect(body(result).error).not.toContain('fetch failed');
  });

  it('reports a failed upload by name and does not claim success', async () => {
    await connect();
    await makeGame();
    installCatalog({ uploadsFail: true });

    const result = await publish(host, { project: folder, title: 'My Cool Game' });

    expect(body(result).ok).toBe(false);
    expect(body(result).error).toMatch(/Uploading/);
    expect(calls.some((c) => c.url.endsWith('/publish'))).toBe(false);
    expect(await exists(projectRefPath(folder))).toBe(false);
  });

  it('refuses a file the catalog could not name', async () => {
    await connect();
    await makeGame();
    await write('a"quote".js', 'nope');

    const result = await publish(host, { project: folder, title: 'My Cool Game' });

    expect(body(result).ok).toBe(false);
    expect(body(result).error).toContain('a"quote".js');
    expect(calls).toHaveLength(0);
  });

  it('sends a draft as a draft', async () => {
    await connect();
    await makeGame();

    const result = await publish(host, { project: folder, title: 'My Cool Game', draft: true });

    const live = calls.find((c) => c.url.endsWith('/publish')) as Recorded;
    expect(live.json).toMatchObject({ draft: true });
    expect((body(result).result as PublishResult).status).toBe('draft');
  });

  it('sends a cover as a raw image body, and refuses one that is not an image', async () => {
    await connect();
    await makeGame();
    await write('cover.png', 'PNGDATA');

    await publish(host, { project: folder, title: 'My Cool Game', coverPath: 'cover.png' });
    const cover = calls.find((c) => c.url.endsWith('/cover')) as Recorded;
    expect(cover.contentType).toBe('image/png');
    expect(cover.auth).toBe(`Bearer ${TOKEN}`);
    expect(cover.bytes).toBe(7);

    const refused = await publish(host, { project: folder, title: 'My Cool Game', coverPath: 'game.js' });
    expect(body(refused).error).toMatch(/\.png/);
  });

  it('will not upload a cover from outside the project, by path or by symlink', async () => {
    // Without this the route is an arbitrary-file-read with a public URL on
    // the end: the body names a path, the server reads it and puts it on the
    // internet. A path in a request body is not a permission.
    await connect();
    await makeGame();

    const outside = path.join(tmp, 'outside');
    await fsp.mkdir(outside, { recursive: true });
    const secret = path.join(outside, 'secret.png');
    await fsp.writeFile(secret, 'NOTYOURS');

    const byAbsolute = await publish(host, {
      project: folder,
      title: 'My Cool Game',
      coverPath: secret,
    });
    expect(body(byAbsolute).ok).toBe(false);
    expect(body(byAbsolute).error).toMatch(/inside the project folder/);

    const byTraversal = await publish(host, {
      project: folder,
      title: 'My Cool Game',
      coverPath: '../outside/secret.png',
    });
    expect(body(byTraversal).ok).toBe(false);

    // A symlink inside the project passes a string-prefix test and then reads
    // whatever it aimed at, which is why the check resolves before comparing.
    await fsp.symlink(secret, path.join(folder, 'cover.png'));
    const bySymlink = await publish(host, {
      project: folder,
      title: 'My Cool Game',
      coverPath: 'cover.png',
    });
    expect(body(bySymlink).ok).toBe(false);
    expect(body(bySymlink).error).toMatch(/inside the project folder/);

    expect(calls.some((c) => c.url.endsWith('/cover'))).toBe(false);
  });

  it('refuses a body that is not a publish request', async () => {
    expect((await publish(host, { title: 'no project' })).status).toBe(400);
    expect((await publish(host, { project: folder })).status).toBe(400);
    expect((await publish(host, null)).status).toBe(400);
  });
});

describe('the route layer', () => {
  interface Sent {
    status: number;
    headers: Record<string, string>;
    payload: Payload;
  }

  /** Enough of req/res for the handlers; the socket is not the thing under test. */
  async function call(method: string, url: string, json?: unknown): Promise<Sent> {
    const chunks = json === undefined ? [] : [Buffer.from(JSON.stringify(json), 'utf8')];
    const req = {
      method,
      url,
      async *[Symbol.asyncIterator]() {
        yield* chunks;
      },
    };
    const sent: Partial<Sent> = {};
    let text = '';
    const res = {
      writeHead(status: number, headers: Record<string, string>) {
        sent.status = status;
        sent.headers = headers;
      },
      end(chunk: string) {
        text = chunk;
      },
    };
    await routeCatalog(host, req as never, res as never, new URL(url, 'http://localhost').pathname);
    return { status: sent.status as number, headers: sent.headers as Record<string, string>, payload: JSON.parse(text) as Payload };
  }

  it('answers the account route as no-store JSON', async () => {
    await connect('ada');

    const sent = await call('GET', '/api/catalog/account');

    expect(sent.status).toBe(200);
    expect(sent.headers['Content-Type']).toBe('application/json');
    expect(sent.headers['Cache-Control']).toBe('no-store');
    expect(sent.payload.account).toMatchObject({ connected: true, username: 'ada' });
  });

  it('reads the project off the query string', async () => {
    await makeGame();

    const sent = await call('GET', `/api/catalog/project?project=${encodeURIComponent(folder)}`);

    expect(sent.payload.info).toMatchObject({ entry: 'index.html', fileCount: 3 });
  });

  it('carries a POST body to the handler, and refuses the wrong method', async () => {
    const saved = await call('POST', '/api/catalog/account', { token: TOKEN });
    expect(saved.payload).toMatchObject({ ok: true, username: 'jake' });

    const cleared = await call('POST', '/api/catalog/account/clear');
    expect(cleared.payload.ok).toBe(true);

    expect((await call('DELETE', '/api/catalog/publish')).status).toBe(405);
  });
});

describe('the route prefix', () => {
  it('owns exactly the four catalog paths', () => {
    for (const p of [
      '/api/catalog/account',
      '/api/catalog/account/clear',
      '/api/catalog/project',
      '/api/catalog/publish',
    ]) {
      expect(ownsCatalogPath(p)).toBe(true);
    }
    expect(ownsCatalogPath('/api/catalog')).toBe(false);
    expect(ownsCatalogPath('/api/catalog/account/../../secrets')).toBe(false);
  });
});
