/**
 * The harness registry, on disk and over HTTP.
 *
 * A folder's registry is the honest answer to "what can this Hearth reach, and
 * what does it know how to do?" — connectors and skills. It has two halves:
 *
 *   built-ins  — defined right here, never written to disk. They are facts
 *                about the app itself (the web-game probe exists; Godot does
 *                not yet), so persisting them would only let a stale project
 *                file disagree with the binary it is running under.
 *   the file   — `<project>/.hearth/harness.json`, everything the user
 *                registered. Recorded now, consumed later: the point of the
 *                slot is that an entry can exist before the wiring does, which
 *                is why nothing here ever claims a status the app can't back.
 *
 * GET  /api/harness/registry?project=… → built-ins merged over the file
 * POST /api/harness/registry           → upsert / remove ONE user entry
 *
 * Both are jailed to folders the user deliberately opened, like every other
 * project route, and the POST body is validated with zod before it reaches
 * the disk. Route handling is pure(ish) functions on a host object so the
 * tests exercise it without booting Vite or HTTP — the same shape as
 * projectServer.ts's own context.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  HARNESS_FILE,
  mergeRegistry,
  slugifyEntryId,
  uniqueEntryId,
  type ConnectorEntry,
  type HarnessRegistry,
  type HarnessRegistryPayload,
  type SkillEntry,
} from '../src/harness/registry.js';

export { HARNESS_FILE, HARNESS_ROUTE } from '../src/harness/registry.js';

/** Upper bound on user entries per collection: a sidebar list, not a database. */
export const MAX_USER_ENTRIES = 64;

// ---------------------------------------------------------------------------
// Built-ins
//
// What the app can honestly claim today. "Web games" is active because the
// built-in probe really does play any web game in the folder (see
// server/probeSweep.ts); Godot is named and not built, and says so.
// ---------------------------------------------------------------------------

export const BUILTIN_REGISTRY: HarnessRegistry = {
  connectors: [
    {
      id: 'web-games',
      name: 'Web games',
      kind: 'engine',
      status: 'active',
      detail: 'playtests any web game via the built-in probe',
    },
    { id: 'godot', name: 'Godot', kind: 'engine', status: 'coming-soon' },
    {
      id: 'playtesting',
      name: 'Playtesting',
      kind: 'builtin',
      status: 'active',
      detail: 'sweep, verdicts, evidence',
    },
  ],
  // Empty on purpose. This collection was the placeholder for "things the
  // agent knows how to do" before there was anywhere to put one; real skills
  // are folders on disk now (server/skills.ts) with their own route and their
  // own panel. The field stays so an existing harness.json still parses.
  skills: [],
};

const BUILTIN_CONNECTOR_IDS = new Set(BUILTIN_REGISTRY.connectors.map((c) => c.id));
const BUILTIN_SKILL_IDS = new Set(BUILTIN_REGISTRY.skills.map((s) => s.id));

function builtinIds(): { connectors: string[]; skills: string[] } {
  return {
    connectors: [...BUILTIN_CONNECTOR_IDS],
    skills: [...BUILTIN_SKILL_IDS],
  };
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const ID = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase letters, digits and dashes');

/** What lands in the file. Read leniently (bad rows are dropped, not fatal). */
const PersistedConnector = z.object({
  id: ID,
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['builtin', 'mcp', 'engine']),
  status: z.enum(['active', 'available', 'coming-soon']),
  detail: z.string().trim().max(200).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const PersistedSkill = z.object({
  id: ID,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(280).optional(),
  source: z.enum(['builtin', 'project']),
  status: z.enum(['active', 'coming-soon']),
});

/**
 * What a client may send. Note what is NOT here: `status`. A user entry's
 * status is the server's to assign, because it describes what the app does
 * with the entry — and today the app does nothing with it yet.
 */
const ConnectorDraft = z.object({
  id: ID.optional(),
  name: z.string().trim().min(1, 'a connector needs a name').max(80),
  kind: z.enum(['mcp', 'engine']).optional(),
  detail: z.string().trim().max(200).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const SkillDraft = z.object({
  id: ID.optional(),
  name: z.string().trim().min(1, 'a skill needs a name').max(80),
  description: z.string().trim().max(280).optional(),
});

const Envelope = z.object({
  project: z.string().trim().min(1, 'missing "project" (absolute folder)'),
  action: z.enum(['upsert', 'remove']),
  collection: z.enum(['connectors', 'skills']),
});

const RemoveDraft = z.object({ id: ID });

/** One readable line out of a zod failure — the first issue, with its path. */
export function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid request.';
  const where = issue.path.filter((p) => p !== '').join('.');
  return where === '' ? issue.message : `${where}: ${issue.message}`;
}

export interface JsonResult {
  status: number;
  body: unknown;
}

const ok = (payload: HarnessRegistryPayload): JsonResult => ({ status: 200, body: { ok: true, ...payload } });
const fail = (status: number, error: string): JsonResult => ({ status, body: { ok: false, error } });

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

export function harnessFilePath(root: string): string {
  return path.join(root, ...HARNESS_FILE.split('/'));
}

/**
 * Serialize writes per project root. An "add" is a read-modify-write of one
 * small file, and two of them racing (the sidebar has two sections, each with
 * its own add form) would silently drop one entry. Same promise-chain idiom as
 * server/chatStore.ts.
 */
const tails = new Map<string, Promise<unknown>>();

function serialize<T>(root: string, task: () => Promise<T>): Promise<T> {
  const prev = tails.get(root) ?? Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.catch(() => undefined);
  tails.set(root, tail);
  void tail.then(() => {
    if (tails.get(root) === tail) tails.delete(root);
  });
  return run;
}

/**
 * Coerce whatever is in harness.json into a registry, dropping rows that don't
 * parse. A hand-edited (or agent-edited) file with one bad row must not blank
 * the whole sidebar — the same leniency chatStore applies to its index.
 */
export function parseRegistryFile(raw: unknown): HarnessRegistry {
  const source = (raw ?? {}) as { connectors?: unknown; skills?: unknown };
  const connectors: ConnectorEntry[] = [];
  const skills: SkillEntry[] = [];
  const seenConnectors = new Set<string>();
  const seenSkills = new Set<string>();
  if (Array.isArray(source.connectors)) {
    for (const row of source.connectors) {
      const parsed = PersistedConnector.safeParse(row);
      if (!parsed.success || seenConnectors.has(parsed.data.id)) continue;
      seenConnectors.add(parsed.data.id);
      connectors.push(parsed.data);
    }
  }
  if (Array.isArray(source.skills)) {
    for (const row of source.skills) {
      const parsed = PersistedSkill.safeParse(row);
      if (!parsed.success || seenSkills.has(parsed.data.id)) continue;
      seenSkills.add(parsed.data.id);
      // A project file doesn't get to call its own entry built-in: that word
      // means "the app ships this", and the app is the only one who knows.
      skills.push({ ...parsed.data, source: 'project' });
    }
  }
  return { connectors, skills };
}

async function readFileUnlocked(root: string): Promise<HarnessRegistry> {
  try {
    return parseRegistryFile(JSON.parse(await fsp.readFile(harnessFilePath(root), 'utf8')));
  } catch {
    return { connectors: [], skills: [] }; // absent or unreadable: nothing registered
  }
}

async function writeFileUnlocked(root: string, registry: HarnessRegistry): Promise<void> {
  const file = harnessFilePath(root);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

/** Everything this folder registered, as written (built-ins not included). */
export function readUserRegistry(root: string): Promise<HarnessRegistry> {
  return serialize(root, () => readFileUnlocked(root));
}

// ---------------------------------------------------------------------------
// The jail
// ---------------------------------------------------------------------------

/**
 * The slice of projectServer's context this module needs. Structural, so the
 * real context satisfies it without either file importing the other's types.
 */
export interface HarnessHost {
  serveMounted(
    mount: 'game' | 'evidence',
    key: string,
    rel: string,
  ): Promise<{ status: number; body?: unknown }>;
}

/** Same encoding projectServer's static mounts use for a root. */
function rootKey(root: string): string {
  return Buffer.from(root, 'utf8').toString('base64url');
}

/**
 * Is `root` a folder the user deliberately opened this run?
 *
 * The open-roots set lives in a closure inside `createProjectServerContext`
 * and is not exported; `serveMounted` is the public surface that consults it,
 * and it answers 403 for any root outside the jail BEFORE it touches the
 * disk. Asking it for a path that cannot exist therefore separates the two
 * cases at the cost of one failed stat: 403 = not open, 404 = open but (of
 * course) no such file. Cheaper than it looks, and it keeps this route's jail
 * identical to every other route's by construction rather than by copy.
 */
async function isOpenRoot(host: HarnessHost, root: string): Promise<boolean> {
  const probe = await host.serveMounted('evidence', rootKey(root), '__hearth_open_probe__');
  return probe.status !== 403;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** GET: built-ins merged with the folder's own entries. */
export async function getHarnessRegistry(host: HarnessHost, project: unknown): Promise<JsonResult> {
  if (typeof project !== 'string' || project.trim() === '') {
    return fail(400, 'Missing "project".');
  }
  const root = path.resolve(project);
  if (!(await isOpenRoot(host, root))) return fail(403, 'Folder is not open.');
  const user = await readUserRegistry(root);
  return ok({ registry: mergeRegistry(BUILTIN_REGISTRY, user), builtins: builtinIds() });
}

/** POST: upsert or remove exactly one user entry, then answer with the merged view. */
export async function postHarnessRegistry(host: HarnessHost, body: unknown): Promise<JsonResult> {
  const envelope = Envelope.safeParse(body ?? {});
  if (!envelope.success) return fail(400, describeZodError(envelope.error));
  const { project, action, collection } = envelope.data;
  const root = path.resolve(project);
  if (!(await isOpenRoot(host, root))) return fail(403, 'Folder is not open.');

  const raw = (body ?? {}) as { entry?: unknown; id?: unknown };

  if (action === 'remove') {
    const parsed = RemoveDraft.safeParse({ id: raw.id });
    if (!parsed.success) return fail(400, describeZodError(parsed.error));
    const id = parsed.data.id;
    const builtin = collection === 'connectors' ? BUILTIN_CONNECTOR_IDS : BUILTIN_SKILL_IDS;
    if (builtin.has(id)) return fail(400, `“${id}” is built in , it can't be removed.`);
    return serialize(root, async () => {
      const user = await readFileUnlocked(root);
      const before = user[collection].length;
      const next: HarnessRegistry = {
        connectors: user.connectors.filter((c) => collection !== 'connectors' || c.id !== id),
        skills: user.skills.filter((s) => collection !== 'skills' || s.id !== id),
      };
      if (next[collection].length === before) return fail(404, `No entry “${id}” to remove.`);
      await writeFileUnlocked(root, next);
      return ok({ registry: mergeRegistry(BUILTIN_REGISTRY, next), builtins: builtinIds() });
    });
  }

  // --- upsert ---
  if (collection === 'connectors') {
    const parsed = ConnectorDraft.safeParse(raw.entry ?? {});
    if (!parsed.success) return fail(400, describeZodError(parsed.error));
    const draft = parsed.data;
    if (draft.id && BUILTIN_CONNECTOR_IDS.has(draft.id)) {
      return fail(400, `“${draft.id}” is built in , it can't be edited.`);
    }
    return serialize(root, async () => {
      const user = await readFileUnlocked(root);
      const existing = draft.id ? user.connectors.find((c) => c.id === draft.id) : undefined;
      if (draft.id && !existing) return fail(404, `No connector “${draft.id}” to update.`);
      if (!existing && user.connectors.length >= MAX_USER_ENTRIES) {
        return fail(400, `This folder already registers ${MAX_USER_ENTRIES} connectors.`);
      }
      const kind = existing?.kind ?? draft.kind;
      if (!kind) return fail(400, 'entry.kind: a new connector needs a kind (mcp or engine)');
      const entry: ConnectorEntry = {
        id:
          existing?.id ??
          uniqueEntryId(slugifyEntryId(draft.name), [
            ...BUILTIN_CONNECTOR_IDS,
            ...user.connectors.map((c) => c.id),
          ]),
        name: draft.name,
        kind: draft.kind ?? kind,
        // Registered, not running: nothing consumes a user connector yet, and
        // the row says so rather than lighting up as if it did.
        status: existing?.status ?? 'available',
      };
      // A rename sends only { id, name }; carrying the rest over is what keeps
      // it a rename instead of a quiet wipe of the connector's settings.
      const detail = draft.detail ?? existing?.detail;
      const config = draft.config ?? existing?.config;
      if (detail !== undefined) entry.detail = detail;
      if (config !== undefined) entry.config = config;
      const next: HarnessRegistry = {
        connectors: existing
          ? user.connectors.map((c) => (c.id === entry.id ? entry : c))
          : [...user.connectors, entry],
        skills: user.skills,
      };
      await writeFileUnlocked(root, next);
      return ok({ registry: mergeRegistry(BUILTIN_REGISTRY, next), builtins: builtinIds() });
    });
  }

  const parsed = SkillDraft.safeParse(raw.entry ?? {});
  if (!parsed.success) return fail(400, describeZodError(parsed.error));
  const draft = parsed.data;
  if (draft.id && BUILTIN_SKILL_IDS.has(draft.id)) {
    return fail(400, `“${draft.id}” is built in , it can't be edited.`);
  }
  return serialize(root, async () => {
    const user = await readFileUnlocked(root);
    const existing = draft.id ? user.skills.find((s) => s.id === draft.id) : undefined;
    if (draft.id && !existing) return fail(404, `No skill “${draft.id}” to update.`);
    if (!existing && user.skills.length >= MAX_USER_ENTRIES) {
      return fail(400, `This folder already registers ${MAX_USER_ENTRIES} skills.`);
    }
    const entry: SkillEntry = {
      id:
        existing?.id ??
        uniqueEntryId(slugifyEntryId(draft.name), [...BUILTIN_SKILL_IDS, ...user.skills.map((s) => s.id)]),
      name: draft.name,
      source: 'project',
      // Same honesty as a user connector: recorded, not yet run.
      status: existing?.status ?? 'coming-soon',
    };
    const description = draft.description ?? existing?.description;
    if (description !== undefined) entry.description = description;
    const next: HarnessRegistry = {
      connectors: user.connectors,
      skills: existing ? user.skills.map((s) => (s.id === entry.id ? entry : s)) : [...user.skills, entry],
    };
    await writeFileUnlocked(root, next);
    return ok({ registry: mergeRegistry(BUILTIN_REGISTRY, next), builtins: builtinIds() });
  });
}

// ---------------------------------------------------------------------------
// HTTP glue
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

/**
 * The whole route, mounted from projectServer.ts in one line. Origin has
 * already been checked by the caller (route() does it first, for everything).
 */
export async function routeHarnessRegistry(
  host: HarnessHost,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (req.method === 'GET') {
      const project = new URL(req.url ?? '/', 'http://localhost').searchParams.get('project');
      const result = await getHarnessRegistry(host, project);
      return sendJson(res, result.status, result.body);
    }
    if (req.method === 'POST') {
      const result = await postHarnessRegistry(host, await readJsonBody(req));
      return sendJson(res, result.status, result.body);
    }
    return sendJson(res, 405, { ok: false, error: `Method not allowed: ${req.method}` });
  } catch (err) {
    // Whatever went wrong here is a JS error message, and the rail renders
    // this string verbatim to a person making a game. Keep the detail in the
    // server log and answer with a sentence someone can act on.
    console.error('harness registry: request failed', err);
    return sendJson(res, 400, { ok: false, error: 'That request could not be read.' });
  }
}
