/**
 * Publishing a game to the Hearth Catalog, from inside the app.
 *
 *   GET  /api/catalog/account          → is a token stored, and whose is it
 *   POST /api/catalog/account          → store a token (verified before it is kept)
 *   POST /api/catalog/account/clear    → forget it
 *   GET  /api/catalog/project?project= → what would be published, and where it went last time
 *   POST /api/catalog/publish          → do it
 *
 * Two scopes on purpose, and they are not the same scope:
 *
 *  - **The token belongs to the person**, not the folder. It lives in
 *    `~/.hearth/catalog.json` beside skills.json and models.json, for the same
 *    reason those do: you sign in once, not once per game. It is a bearer
 *    credential, so the file is written 0600 and the raw value never leaves
 *    this module — every read path returns the username it resolves to and
 *    nothing else.
 *  - **Which listing a folder publishes to belongs to the folder.** That goes
 *    in `.hearth/catalog.json` inside the project, so publishing a second time
 *    UPDATES the game rather than making a new one at `my-game-2`. `.hearth/`
 *    is already gitignored by the marker the app writes on open.
 *
 * The upload is the catalog's own three-step API — declare the build, PUT each
 * file to a signed URL, then publish — which is what `publish.mjs` does and
 * what `/docs/publish` documents. Nothing here reimplements the wire format;
 * if the catalog changes it, this changes with it.
 *
 * Written against a host object rather than the http types so it is testable
 * without booting a server, the same shape skillsRoutes.ts and
 * harnessRegistry.ts use.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { hearthHome } from './skills.js';
import { GAME_ENTRY_CANDIDATES } from './agentFacts.js';

/** What the route layer needs from the project server. */
export interface CatalogHost {
  /** The open-folder jail. A project that is not open may not be published. */
  isOpenRoot(root: string): boolean;
}

/** Where a game went. Stored per project, so a republish updates in place. */
export interface PublishedRef {
  gameId: string;
  slug: string;
  url: string;
  publishedAt: string;
}

/** Whether this machine can publish, and as whom. The token is never returned. */
export interface CatalogAccount {
  connected: boolean;
  username: string | null;
  /** Which instance the token is for. Normally the hosted catalog. */
  api: string;
  /** Set when a stored token no longer works, in words for the person. */
  error?: string;
}

/** What a publish would send, read off disk before anything is uploaded. */
export interface CatalogProjectInfo {
  /** The entry HTML, relative to the project root, or null if there is no game yet. */
  entry: string | null;
  fileCount: number;
  totalBytes: number;
  /** The folder name, humanized — the title field's default. */
  suggestedTitle: string;
  /** Where this folder published last time, if it has. */
  published: PublishedRef | null;
}

export interface PublishRequest {
  project: string;
  title: string;
  slug?: string;
  tagline?: string;
  description?: string;
  instructions?: string;
  tags?: string[];
  /** A path inside the project, or an absolute path the user picked. */
  coverPath?: string;
  draft?: boolean;
}

export interface PublishResult {
  url: string;
  slug: string;
  gameId: string;
  fileCount: number;
  totalBytes: number;
  status: 'published' | 'draft';
}

/** The envelope every handler here answers with, before it reaches the socket. */
export interface CatalogResult {
  status: number;
  body: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The catalog's rules
//
// Everything in this block is the catalog's, not ours: the server enforces the
// same limits, the same ignore list, the same path shape and the same MIME
// types, and a build that breaks one of them is refused there. It is repeated
// here so the refusal arrives before an upload starts rather than halfway
// through one. Keep it in step with publish.mjs.
// ---------------------------------------------------------------------------

const DEFAULT_API = 'https://catalog.hearthengine.com';

/** Which catalog this machine publishes to. A local instance and the tests move it. */
export function catalogApi(): string {
  const override = process.env.HEARTH_CATALOG_API?.trim();
  return (override && override !== '' ? override : DEFAULT_API).replace(/\/+$/, '');
}

/** `hpub_` and 40 hex characters. Checked before any request, so a typo costs nothing. */
const TOKEN_SHAPE = /^hpub_[0-9a-f]{40}$/;

const LIMITS = {
  maxFiles: 300,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxCoverBytes: 4 * 1024 * 1024,
};

/**
 * A tree far larger than any game build is a wrong folder, not a big game.
 * Stopping mid-walk keeps a mistaken "publish my home directory" from becoming
 * minutes of stat() before the file-count check would have refused it anyway.
 */
const MAX_WALK_FILES = 5000;

/** Never part of a playable build. Mirrors the ignore list in publish.mjs. */
const IGNORED: RegExp[] = [
  // Broader than publish.mjs's top-level-only rule, deliberately: `.hearth/`
  // holds chat transcripts, tester notes and the token file's sibling, and a
  // nested one belongs to whoever made it, not to the listing.
  /(^|\/)\.hearth\//,
  /(^|\/)node_modules\//,
  /^\.git\//,
  /(^|\/)\.DS_Store$/,
  /^\.vscode\//,
  /^\.idea\//,
  /(^|\/)Thumbs\.db$/,
  /^src-tauri\//,
  // Local-only files that would become world-readable if uploaded.
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)\.envrc$/,
  /(^|\/)publish\.mjs$/,
];

/** Mirrors isSafeRelPath in the catalog's games.ts — the server rejects the same names. */
function isSafeRelPath(p: string): boolean {
  if (!p || p.length > 200) return false;
  if (!/^[A-Za-z0-9._][A-Za-z0-9._\-/ ]*$/.test(p)) return false;
  if (p.startsWith('/') || p.includes('//') || p.includes('\\')) return false;
  return p
    .split('/')
    .every((s) => s.length > 0 && s !== '.' && s !== '..' && !s.startsWith(' ') && !s.endsWith(' '));
}

/** Storage serves these back verbatim, so the game only runs if they're right. */
const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript',
  css: 'text/css', json: 'application/json', map: 'application/json',
  wasm: 'application/wasm', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
  mp4: 'video/mp4', webm: 'video/webm', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf', txt: 'text/plain', md: 'text/plain',
  xml: 'application/xml', glb: 'model/gltf-binary', gltf: 'model/gltf+json',
  bin: 'application/octet-stream', data: 'application/octet-stream',
  pck: 'application/octet-stream', unityweb: 'application/octet-stream',
};

const COVER_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
};

function mimeFor(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The folder name as a title someone would have typed. Same rule publish.mjs uses. */
function humanize(name: string): string {
  const words = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return 'Untitled game';
  return words.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// The token, which is the person's
// ---------------------------------------------------------------------------

/** Beside skills.json and models.json, for the same reason. */
export function catalogAccountPath(): string {
  return path.join(hearthHome(), 'catalog.json');
}

interface StoredAccount {
  token: string;
  /** The instance the token was minted by; a token is not portable between them. */
  api: string;
  /** Resolved once, at connect, so opening a pane costs no request. */
  username: string | null;
}

/**
 * Read the stored credential. Missing, unreadable, malformed and "holds
 * something that is not a token" all read the same way — as nobody being
 * signed in — because every one of them means the same thing to the person.
 */
async function readStoredAccount(): Promise<StoredAccount | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(catalogAccountPath(), 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const token = typeof record.token === 'string' ? record.token.trim() : '';
  if (!TOKEN_SHAPE.test(token)) return null;
  const api = typeof record.api === 'string' && record.api.trim() !== ''
    ? record.api.trim().replace(/\/+$/, '')
    : catalogApi();
  const username = typeof record.username === 'string' && record.username !== ''
    ? record.username
    : null;
  return { token, api, username };
}

/**
 * Write the credential so nobody else on the machine can read it, and so a
 * reader sees all of the old file or all of the new. `writeFile`'s mode only
 * applies when it CREATES the file and a rename carries the temp file's bits
 * across, so the mode is set on the temp file and set again explicitly rather
 * than trusted to either.
 */
async function writeStoredAccount(account: StoredAccount): Promise<void> {
  const file = catalogAccountPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(temp, `${JSON.stringify(account, null, 2)}\n`, { mode: 0o600 });
    await fsp.chmod(temp, 0o600);
    await fsp.rename(temp, file);
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Which listing a folder updates, which is the folder's
// ---------------------------------------------------------------------------

/** Inside the project, under the `.hearth/` the app already gitignores. */
export function projectRefPath(root: string): string {
  return path.join(root, '.hearth', 'catalog.json');
}

async function readPublishedRef(root: string): Promise<PublishedRef | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(projectRefPath(root), 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const text = (key: string): string | null =>
    typeof r[key] === 'string' && (r[key] as string).trim() !== '' ? (r[key] as string) : null;
  const gameId = text('gameId');
  const slug = text('slug');
  // A ref that cannot name the game it points at is no ref: publishing with
  // half of one would silently fork a second listing, which is the exact
  // failure this file exists to prevent.
  if (!gameId || !slug) return null;
  return {
    gameId,
    slug,
    url: text('url') ?? `${catalogApi()}/g/${slug}`,
    publishedAt: text('publishedAt') ?? '',
  };
}

async function writePublishedRef(root: string, ref: PublishedRef): Promise<void> {
  const file = projectRefPath(root);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(ref, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// The build folder
// ---------------------------------------------------------------------------

interface BuildFile {
  path: string;
  size: number;
}

interface Build {
  files: BuildFile[];
  /** Names the catalog will not take. Reported by publish, never sent. */
  unsafe: string[];
}

/** A message already written for the person. Thrown by everything below. */
class CatalogError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function shouldIgnore(rel: string): boolean {
  return IGNORED.some((re) => re.test(rel));
}

/**
 * Every file that would be uploaded, relative to the root, sorted.
 *
 * Symlinks are followed only while they stay inside the folder: a link to
 * somewhere else on disk must never publish someone else's files under this
 * person's name. One that points out is dropped, and dropped quietly — the
 * count the pane shows comes from this same walk, so what it says is what
 * gets sent either way.
 */
async function walkBuild(root: string): Promise<Build> {
  const files: BuildFile[] = [];
  const unsafe: string[] = [];
  let realRoot: string;
  try {
    realRoot = await fsp.realpath(root);
  } catch {
    throw new CatalogError('That folder is not on disk any more.');
  }

  const stack: string[] = [''];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await fsp.readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      throw new CatalogError(
        `Could not read ${dir === '' ? 'the project folder' : dir}. Check its permissions and try again.`,
      );
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      let isDirectory = entry.isDirectory();
      let size = 0;

      if (entry.isSymbolicLink()) {
        let real: string;
        try {
          real = await fsp.realpath(path.join(root, rel));
        } catch {
          continue;
        }
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) continue;
        try {
          const target = await fsp.stat(real);
          isDirectory = target.isDirectory();
          if (!isDirectory && !target.isFile()) continue;
          size = target.size;
        } catch {
          continue;
        }
      } else if (entry.isFile()) {
        try {
          size = (await fsp.stat(path.join(root, rel))).size;
        } catch {
          continue;
        }
      } else if (!isDirectory) {
        continue;
      }

      if (isDirectory) {
        if (!shouldIgnore(`${rel}/`)) stack.push(rel);
        continue;
      }
      if (shouldIgnore(rel)) continue;
      if (!isSafeRelPath(rel)) {
        unsafe.push(rel);
        continue;
      }
      files.push({ path: rel, size });
      if (files.length > MAX_WALK_FILES) {
        throw new CatalogError(
          `This folder holds more than ${MAX_WALK_FILES} files, far past the ${LIMITS.maxFiles} a game may publish. Publish the built game folder instead.`,
        );
      }
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, unsafe };
}

/** The catalog's own rule, over the same candidate list the game pane serves from. */
function detectEntry(paths: string[]): string | null {
  for (const candidate of GAME_ENTRY_CANDIDATES) {
    if (paths.includes(candidate)) return candidate;
  }
  const topLevelHtml = paths.filter((p) => p.endsWith('.html') && !p.includes('/'));
  return topLevelHtml.length === 1 ? (topLevelHtml[0] as string) : null;
}

// ---------------------------------------------------------------------------
// The catalog API
// ---------------------------------------------------------------------------

interface CallOptions {
  json?: unknown;
  body?: Uint8Array;
  contentType?: string;
}

/**
 * One request to the catalog, with the failure already turned into a sentence.
 *
 * Errors arrive as `{ error: { code, message } }` and those messages are
 * written for a person, so they are passed straight through. What never
 * escapes is the transport's own words: "fetch failed" and a stack tell the
 * person nothing they can act on, so an unreachable catalog is named as one.
 */
async function callCatalog(
  api: string,
  token: string,
  method: string,
  route: string,
  options: CallOptions = {},
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let body: string | Uint8Array | undefined;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.body !== undefined) {
    if (options.contentType) headers['content-type'] = options.contentType;
    body = options.body;
  }

  let response: Response;
  try {
    // The cast is the DOM lib's `BodyInit` meeting Node's `Buffer`: fetch takes
    // the bytes at runtime, the two type worlds disagree on which ArrayBuffer.
    response = await globalThis.fetch(`${api}${route}`, {
      method,
      headers,
      body: body as BodyInit | undefined,
    });
  } catch {
    throw new CatalogError(
      `Could not reach the Hearth Catalog at ${api}. Check your connection and try again.`,
      502,
    );
  }

  const text = await response.text().catch(() => '');
  let payload: Record<string, unknown> | null = null;
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new CatalogError(
        `The Hearth Catalog rejected this token. Create a new one at ${api}/settings/tokens and connect again.`,
        401,
      );
    }
    const detail = payload?.error as { message?: unknown } | undefined;
    const message = typeof detail?.message === 'string' && detail.message.trim() !== ''
      ? detail.message
      : `The Hearth Catalog answered ${response.status}. Try again in a moment.`;
    throw new CatalogError(message, response.status >= 500 ? 502 : 400);
  }

  return payload ?? {};
}

/** The username a token publishes as. `GET /api/v1/me` is the only way to know. */
async function resolveUsername(api: string, token: string): Promise<string | null> {
  const me = await callCatalog(api, token, 'GET', '/api/v1/me');
  const user = me.user as { username?: unknown } | undefined;
  return typeof user?.username === 'string' ? user.username : null;
}

/**
 * PUT one file to its signed URL. The token is deliberately absent: the URL
 * already carries its own, and sending a bearer credential to storage would
 * spread it further than it needs to go.
 */
async function putFile(url: string, rel: string, bytes: Uint8Array, attempt = 1): Promise<void> {
  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      method: 'PUT',
      headers: {
        'content-type': mimeFor(rel),
        'cache-control': 'max-age=3600',
        'x-upsert': 'true',
      },
      body: bytes as BodyInit,
    });
  } catch {
    // One retry, because a single dropped connection in a 200-file build is
    // ordinary and re-running the whole publish over it is not.
    if (attempt === 1) return putFile(url, rel, bytes, 2);
    throw new CatalogError(`Uploading “${rel}” failed. Check your connection and publish again.`, 502);
  }
  if (!response.ok) {
    if (attempt === 1) return putFile(url, rel, bytes, 2);
    throw new CatalogError(
      `Uploading “${rel}” failed with ${response.status}. Try publishing again.`,
      502,
    );
  }
}

interface Upload {
  path: string;
  url: string;
}

/** Four at a time, the same width publish.mjs uses. */
async function uploadAll(root: string, uploads: Upload[]): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= uploads.length) return;
      const upload = uploads[index] as Upload;
      let bytes: Uint8Array;
      try {
        bytes = await fsp.readFile(path.join(root, ...upload.path.split('/')));
      } catch {
        throw new CatalogError(`“${upload.path}” could not be read. It may have moved mid-publish.`);
      }
      await putFile(upload.url, upload.path, bytes);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, uploads.length) }, worker));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function ok(body: Record<string, unknown>): CatalogResult {
  return { status: 200, body: { ok: true, ...body } };
}

function fail(status: number, error: string): CatalogResult {
  return { status, body: { ok: false, error } };
}

/** Turn anything thrown below into the sentence, never the stack. */
function refuse(err: unknown): CatalogResult {
  if (err instanceof CatalogError) return fail(err.status, err.message);
  return fail(500, 'Something went wrong while publishing. Try again.');
}

/**
 * Is a token stored, and whose is it.
 *
 * Answered from disk. The username was resolved when the token was connected,
 * so opening the publish pane — which happens far more often than publishing
 * — costs nothing and works on a plane. A token revoked since then is caught
 * by the publish itself, which is the only moment the distinction matters and
 * where the message can say what to do about it.
 */
export async function getAccount(): Promise<CatalogResult> {
  const stored = await readStoredAccount();
  if (!stored) {
    return ok({ account: { connected: false, username: null, api: catalogApi() } satisfies CatalogAccount });
  }
  if (stored.username) {
    return ok({
      account: { connected: true, username: stored.username, api: stored.api } satisfies CatalogAccount,
    });
  }
  // A file written by hand knows the token but not the name it publishes as.
  try {
    const username = await resolveUsername(stored.api, stored.token);
    if (username) await writeStoredAccount({ ...stored, username });
    return ok({ account: { connected: true, username, api: stored.api } satisfies CatalogAccount });
  } catch (err) {
    const message = err instanceof CatalogError ? err.message : 'That token could not be checked.';
    const rejected = err instanceof CatalogError && err.status === 401;
    return ok({
      account: {
        connected: !rejected,
        username: null,
        api: stored.api,
        error: message,
      } satisfies CatalogAccount,
    });
  }
}

const TokenBody = z.object({ token: z.string().max(200) });

/**
 * Store a token, after the catalog has agreed it is one.
 *
 * The verification is the point: a mistyped token that is only discovered at
 * the end of an upload has cost the person the whole upload, and a stored
 * credential that has never worked is worse than none.
 */
export async function saveAccount(body: unknown): Promise<CatalogResult> {
  const parsed = TokenBody.safeParse(body ?? {});
  if (!parsed.success) return fail(400, 'Send the publish token to store.');
  const token = parsed.data.token.trim();
  if (!TOKEN_SHAPE.test(token)) {
    return fail(
      400,
      'That does not look like a Hearth Catalog token. They start with “hpub_” and are followed by 40 hex characters.',
    );
  }

  const api = catalogApi();
  try {
    const username = await resolveUsername(api, token);
    await writeStoredAccount({ token, api, username });
    return ok({ username });
  } catch (err) {
    // Nothing has been written: a token the catalog will not take never
    // reaches the disk, so a failed connect leaves the last good one alone.
    return refuse(err);
  }
}

export async function clearAccount(): Promise<CatalogResult> {
  try {
    await fsp.rm(catalogAccountPath(), { force: true });
  } catch {
    return fail(500, 'Could not remove the stored token. Check the permissions on ~/.hearth.');
  }
  return ok({});
}

/** What a publish would send, and where this folder went last time. */
export async function getProjectInfo(
  host: CatalogHost,
  project: unknown,
): Promise<CatalogResult> {
  if (typeof project !== 'string' || project.trim() === '') return fail(400, 'Missing “project”.');
  const root = path.resolve(project);
  if (!host.isOpenRoot(root)) return fail(403, 'That folder is not open in Hearth.');

  try {
    const build = await walkBuild(root);
    const info: CatalogProjectInfo = {
      entry: detectEntry(build.files.map((f) => f.path)),
      fileCount: build.files.length,
      totalBytes: build.files.reduce((sum, f) => sum + f.size, 0),
      suggestedTitle: humanize(path.basename(root)),
      published: await readPublishedRef(root),
    };
    return ok({ info });
  } catch (err) {
    return refuse(err);
  }
}

const PublishBody = z.object({
  project: z.string().min(1),
  title: z.string().min(1).max(400),
  slug: z.string().max(200).optional(),
  tagline: z.string().max(2000).optional(),
  description: z.string().max(40000).optional(),
  instructions: z.string().max(20000).optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
  coverPath: z.string().max(4096).optional(),
  draft: z.boolean().optional(),
});

/**
 * Declare the build, PUT every file, then flip it live — the catalog's own
 * three steps, in that order, because each one depends on the last having
 * landed. Everything that can be refused locally is refused before the first
 * request, so a build that cannot publish costs nothing but a walk of the
 * folder.
 */
export async function publish(host: CatalogHost, body: unknown): Promise<CatalogResult> {
  const parsed = PublishBody.safeParse(body ?? {});
  if (!parsed.success) return fail(400, 'A publish needs a project folder and a title.');
  const request = parsed.data;

  const root = path.resolve(request.project);
  if (!host.isOpenRoot(root)) return fail(403, 'That folder is not open in Hearth.');

  const account = await readStoredAccount();
  if (!account) {
    return fail(401, 'No Hearth Catalog token is stored. Connect your catalog account, then publish.');
  }

  try {
    const build = await walkBuild(root);
    const firstUnsafe = build.unsafe[0];
    if (firstUnsafe !== undefined) {
      throw new CatalogError(
        `“${firstUnsafe}” has a name the catalog cannot publish. Paths may use letters, numbers, dots, dashes, underscores and spaces, separated by single “/”. Rename it and publish again.`,
      );
    }
    if (build.files.length === 0) {
      throw new CatalogError('There is nothing to publish in this folder yet.');
    }
    if (build.files.length > LIMITS.maxFiles) {
      throw new CatalogError(
        `This build has ${build.files.length} files, and the catalog takes ${LIMITS.maxFiles} per game.`,
      );
    }
    const oversized = build.files.find((f) => f.size > LIMITS.maxFileBytes);
    if (oversized) {
      throw new CatalogError(
        `“${oversized.path}” is ${formatBytes(oversized.size)}, and the per-file limit is ${formatBytes(LIMITS.maxFileBytes)}.`,
      );
    }
    const totalBytes = build.files.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > LIMITS.maxTotalBytes) {
      throw new CatalogError(
        `This build is ${formatBytes(totalBytes)}, and the limit is ${formatBytes(LIMITS.maxTotalBytes)}.`,
      );
    }

    const entry = detectEntry(build.files.map((f) => f.path));
    if (!entry) {
      throw new CatalogError(
        `No entry HTML in this folder. Add an index.html at the top level (or ${GAME_ENTRY_CANDIDATES.slice(1).join(', ')}) and publish again.`,
      );
    }

    const cover = request.coverPath ? await readCover(root, request.coverPath) : null;
    const published = await readPublishedRef(root);
    const { api, token } = account;

    // --- the listing ------------------------------------------------------
    // The stored slug is what makes this an update. Without it a renamed
    // title would derive a new slug and the catalog would hand back a second
    // game at `my-game-2`, leaving the first one live and stale.
    const metadata: Record<string, unknown> = {
      title: request.title.trim(),
      entry_path: entry,
      made_with: 'hearth',
    };
    const slug = request.slug?.trim() || published?.slug;
    if (slug) metadata.slug = slug;
    if (request.tagline !== undefined) metadata.tagline = request.tagline;
    if (request.description !== undefined) metadata.description = request.description;
    if (request.instructions !== undefined) metadata.instructions = request.instructions;
    if (request.tags !== undefined) metadata.tags = request.tags;

    const created = await callCatalog(api, token, 'POST', '/api/v1/games', { json: metadata });
    const game = created.game as { id?: unknown } | undefined;
    const gameId = typeof game?.id === 'string' ? game.id : null;
    if (!gameId) throw new CatalogError('The catalog did not return a game to publish to. Try again.');

    // --- the files --------------------------------------------------------
    const manifest = await callCatalog(api, token, 'POST', `/api/v1/games/${gameId}/files`, {
      json: { files: build.files, replace: true },
    });
    const uploads = Array.isArray(manifest.uploads)
      ? (manifest.uploads as Upload[]).filter(
          (u) => u && typeof u.path === 'string' && typeof u.url === 'string',
        )
      : [];
    await uploadAll(root, uploads);

    if (cover) {
      await callCatalog(api, token, 'POST', `/api/v1/games/${gameId}/cover`, {
        body: cover.bytes,
        contentType: cover.contentType,
      });
    }

    // --- live -------------------------------------------------------------
    const manifestEntry = typeof manifest.entry === 'string' ? manifest.entry : entry;
    const done = await callCatalog(api, token, 'POST', `/api/v1/games/${gameId}/publish`, {
      json: { entry_path: manifestEntry, draft: Boolean(request.draft) },
    });
    const live = (done.game ?? {}) as Record<string, unknown>;
    const liveSlug = typeof live.slug === 'string' ? live.slug : (slug ?? '');
    const url = typeof done.url === 'string' ? done.url : `${api}/g/${liveSlug}`;

    const ref: PublishedRef = {
      gameId,
      slug: liveSlug,
      url,
      publishedAt: new Date().toISOString(),
    };
    // Written after the catalog says the game is live, so a failed publish
    // never leaves the folder pointing at a listing that does not exist.
    await writePublishedRef(root, ref);

    const result: PublishResult = {
      url,
      slug: liveSlug,
      gameId,
      fileCount: typeof live.file_count === 'number' ? live.file_count : build.files.length,
      totalBytes: typeof live.total_bytes === 'number' ? live.total_bytes : totalBytes,
      status: live.status === 'draft' ? 'draft' : 'published',
    };
    return ok({ result });
  } catch (err) {
    return refuse(err);
  }
}

/**
 * The cover image, checked here so a 4 MB refusal does not arrive after the
 * upload.
 *
 * The cover must live INSIDE the project. Without that rule this route is an
 * arbitrary-file-read with a public URL on the end of it: the body names a
 * path, the server reads it and uploads it to the open internet, and the only
 * thing standing between "my cover" and someone else's file is an extension
 * check. The whole reason the rest of this module takes a root and asks
 * `isOpenRoot` about it is that a path in a request body is not a permission,
 * and a cover is not the exception. A picker that wants a file from elsewhere
 * copies it into the project first, which is also where a cover belongs.
 *
 * `realpath` before comparing, because a symlink inside the project pointing
 * out of it passes a string-prefix test and then reads whatever it aimed at.
 */
async function readCover(
  root: string,
  coverPath: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const abs = path.resolve(root, coverPath);
  let real: string;
  let realRoot: string;
  try {
    real = await fsp.realpath(abs);
    realRoot = await fsp.realpath(root);
  } catch {
    throw new CatalogError(`Could not read the cover image at ${abs}.`);
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new CatalogError(
      'The cover image has to be a file inside the project folder. Copy it in and pick it again.',
    );
  }
  const ext = real.split('.').pop()?.toLowerCase() ?? '';
  const contentType = COVER_MIME[ext];
  if (!contentType) throw new CatalogError('The cover must be a .png, .jpg, .webp or .gif image.');
  let bytes: Uint8Array;
  try {
    // The resolved path, not the one that was asked for: whatever is read has
    // to be the file the containment check just approved.
    bytes = await fsp.readFile(real);
  } catch {
    throw new CatalogError(`Could not read the cover image at ${abs}.`);
  }
  if (bytes.byteLength > LIMITS.maxCoverBytes) {
    throw new CatalogError(
      `That cover is ${formatBytes(bytes.byteLength)}, and the limit is ${formatBytes(LIMITS.maxCoverBytes)}.`,
    );
  }
  return { bytes, contentType };
}

// ---------------------------------------------------------------------------
// Route layer
// ---------------------------------------------------------------------------

/** Paths this module owns. projectServer delegates the whole prefix. */
export function ownsCatalogPath(pathname: string): boolean {
  return pathname === '/api/catalog/account'
    || pathname === '/api/catalog/account/clear'
    || pathname === '/api/catalog/project'
    || pathname === '/api/catalog/publish';
}

export async function routeCatalog(
  host: CatalogHost,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  const send = (result: CatalogResult) => {
    res.writeHead(result.status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(result.body));
  };

  try {
    if (req.method === 'GET' && pathname === '/api/catalog/account') {
      return send(await getAccount());
    }
    if (req.method === 'GET' && pathname === '/api/catalog/project') {
      const project = new URL(req.url ?? '/', 'http://localhost').searchParams.get('project');
      return send(await getProjectInfo(host, project));
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (pathname === '/api/catalog/account') return send(await saveAccount(body));
      if (pathname === '/api/catalog/account/clear') return send(await clearAccount());
      if (pathname === '/api/catalog/publish') return send(await publish(host, body));
    }
    return send({ status: 405, body: { ok: false, error: 'Method not allowed.' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return send({ status: 500, body: { ok: false, error: message } });
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    // A metadata body is small; anything larger is a mistake or an attack, and
    // the files never come through this route at all — they go straight to the
    // catalog's signed URLs.
    if (total > 1_000_000) throw new Error('Request body is too large.');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}
