/**
 * How much the agent is allowed to do without asking, per project.
 *
 *   ~/.hearth/permissions.json    one entry per project folder, and nothing else
 *
 * THIS MUST NOT MOVE INTO `.hearth/project.json`. That file is designed to be
 * committed and shared; a repo shipping `skip` would hand whoever clones it an
 * agent running with `bypassPermissions` and `danger-full-access` on their own
 * machine. A permission decision is made by a person about their own computer,
 * so it lives in per-machine storage keyed by project path, beside skills and
 * model preferences. Anyone tidying this into the project file is handing out
 * remote code execution to everyone who clones the game.
 *
 * Three modes, one vocabulary across both backends. The mapping to each
 * backend's own words lives with that backend (`sdkPermissionMode` in chat.ts,
 * `codexPermissionParams` in chatDrivers/codexWire.ts); this file owns only
 * what the user chose and where it is written down.
 *
 *  - `ask`   every tool call raises an inline approval.
 *  - `auto`  the default and today's behaviour: work inside the open project
 *            folder proceeds silently, anything reaching outside asks.
 *  - `skip`  nothing asks.
 *
 * Four decisions worth naming, because each is the reason this is a file and
 * not a line somewhere else:
 *
 *  1. **Per project, not per machine.** Unlike models or personalization, this
 *     is not a fact about the person: `skip` in a scratch folder they made this
 *     morning is a different statement from `skip` in a checkout of somebody
 *     else's repository. A single machine-wide switch would carry the loosest
 *     answer the user ever gave into every folder they open next.
 *  2. **An unrecognised mode is REJECTED, never coerced.** Coercion here has
 *     exactly one plausible shape (fall back to the default) and it is a lie in
 *     the dangerous direction: a client that misspells `ask` would get `auto`
 *     while its UI says otherwise. A read of a corrupt FILE does fall back to
 *     the default, which is the same answer a project nobody has configured
 *     gets, and is the only safe thing to do with bytes we cannot parse.
 *  3. **The acknowledgement is stored beside the mode, not derived from it.**
 *     The client shows a confirm the first time `skip` is chosen. Deriving
 *     "have they been warned" from "is the mode skip" would re-warn on every
 *     switch back, and, worse, would forget the warning the moment someone
 *     flipped to `auto` for an afternoon.
 *  4. **Absent means default, always.** A project with no entry, a missing
 *     file, an unreadable one and a malformed one all read as `auto`. There is
 *     no state in which failing to read this file makes the agent MORE
 *     permissive than it is out of the box.
 *
 * NOT to be confused with `PermissionMode` from `@hearth/core`
 * (`read-only` | `safe-edit` | `code-edit` | `asset-edit` | `build`), which is
 * about what an MCP caller may ask the ENGINE to do. The names collide and the
 * concepts do not touch: that one is a capability grant on a session, this one
 * is how loudly the agent's own tool calls interrupt the person watching. A
 * file importing both should alias one of them.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { hearthHome } from './skills.js';

/** The three modes, in the order they escalate. */
export const PERMISSION_MODES = ['ask', 'auto', 'skip'] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * What a project gets before anyone chooses. `auto` is what Hearth has always
 * done, so an upgrade changes nothing for anybody, and it is the only one of
 * the three that is safe to arrive at by accident.
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** Where the entries live. Beside models.json and skills, for the same reasons. */
export function permissionModePath(): string {
  return path.join(hearthHome(), 'permissions.json');
}

/**
 * A ceiling, so a corrupt or hostile file cannot become unbounded work. Far
 * above any real machine: this counts folders a person has opened in Hearth and
 * then changed the default for.
 */
export const MAX_PERMISSION_PROJECTS = 500;

/** What is remembered about one folder. */
export interface PermissionState {
  mode: PermissionMode;
  /** The `skip` warning has been shown and accepted for this project. */
  skipAcknowledged: boolean;
}

export const DEFAULT_PERMISSION_STATE: PermissionState = {
  mode: DEFAULT_PERMISSION_MODE,
  skipAcknowledged: false,
};

/**
 * Shape only, and per entry. A file with one unreadable project still knows
 * about the other nine: dropping the whole map because one line rotted would
 * silently return every configured folder to the default.
 */
const Entry = z
  .object({
    mode: z.enum(PERMISSION_MODES).optional(),
    skipAcknowledged: z.boolean().optional(),
  })
  .passthrough();

/**
 * The key for a folder. Resolved, so `/w/game`, `/w/game/` and a relative path
 * from the same cwd are one project rather than three, and a mode set through
 * one spelling is honoured when the driver binds through another.
 *
 * NOT case-folded, even on macOS. Two spellings of one path resolving to two
 * entries costs a re-ask; folding them would mean a case-sensitive filesystem
 * silently sharing one answer between genuinely different folders.
 */
export function permissionKey(projectRoot: string): string {
  return path.resolve(projectRoot);
}

type StateMap = Map<string, PermissionState>;

/** Anything at all, reduced to entries we can use. */
function cleanFile(raw: unknown): StateMap {
  const out: StateMap = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const projects = (raw as Record<string, unknown>).projects;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return out;
  for (const [key, value] of Object.entries(projects as Record<string, unknown>)) {
    if (key.trim() === '') continue;
    const parsed = Entry.safeParse(value);
    if (!parsed.success) continue;
    out.set(key, {
      mode: parsed.data.mode ?? DEFAULT_PERMISSION_MODE,
      skipAcknowledged: parsed.data.skipAcknowledged === true,
    });
    if (out.size >= MAX_PERMISSION_PROJECTS) break;
  }
  return out;
}

async function readFileMap(): Promise<StateMap> {
  try {
    return cleanFile(JSON.parse(await fsp.readFile(permissionModePath(), 'utf8')));
  } catch {
    return new Map();
  }
}

/**
 * Write so a reader sees all of the new file or all of the old, never the
 * middle of a save. Same temp-and-rename as modelPrefs, and the temp file sits
 * in the same directory because a rename is only atomic within one filesystem.
 */
async function writeAtomic(file: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(temp, text, 'utf8');
    await fsp.rename(temp, file);
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Read one project's whole state. Everything that can go wrong reads as the
 * default, per note (4) at the top.
 */
export async function readPermissionState(projectRoot: string): Promise<PermissionState> {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') return { ...DEFAULT_PERMISSION_STATE };
  const map = await readFileMap();
  return { ...DEFAULT_PERMISSION_STATE, ...map.get(permissionKey(projectRoot)) };
}

/**
 * Change part of one project's state, leaving every other project exactly as it
 * was. Read-modify-write in one pass so a change to both fields is one save
 * rather than two, and so a second field never lands against a stale first.
 */
async function patchPermissionState(
  projectRoot: string,
  patch: Partial<PermissionState>,
): Promise<PermissionState> {
  const key = permissionKey(projectRoot);
  const map = await readFileMap();
  const next: PermissionState = { ...DEFAULT_PERMISSION_STATE, ...map.get(key), ...patch };
  map.delete(key);
  // Re-inserted last, so the entry just touched is the newest in file order and
  // survives the trim below. Insertion order is the only recency signal here,
  // and it is not worth a timestamp on every row to improve on it.
  map.set(key, next);
  // A project back at the factory setting is an entry worth nothing. Deleting
  // it keeps the file to folders someone actually decided something about, and
  // reads identically to keeping it.
  if (next.mode === DEFAULT_PERMISSION_MODE && !next.skipAcknowledged) map.delete(key);
  // At the ceiling, the OLDEST entries go rather than the write being refused.
  // A dropped entry falls back to the default, which is the same answer a
  // folder nobody has configured gets; refusing the write would mean the mode
  // the user just picked never took effect while the UI said it had.
  const entries = [...map.entries()];
  const kept = entries.slice(Math.max(0, entries.length - MAX_PERMISSION_PROJECTS));
  if (kept.length === 0) {
    await fsp.rm(permissionModePath(), { force: true });
    return next;
  }
  const body = { projects: Object.fromEntries(kept) };
  await writeAtomic(permissionModePath(), `${JSON.stringify(body, null, 2)}\n`);
  return next;
}

/** The mode for one project. Unknown project or unreadable file returns the default. */
export async function readPermissionMode(projectRoot: string): Promise<PermissionMode> {
  return (await readPermissionState(projectRoot)).mode;
}

/**
 * Store it. Returns what was stored.
 *
 * Throws on a mode this build does not know, rather than falling back: see note
 * (2). The route rejects those before they get here, and a caller inside the
 * server that invents one is a bug that should be loud.
 */
export async function writePermissionMode(projectRoot: string, mode: PermissionMode): Promise<PermissionMode> {
  if (!isPermissionMode(mode)) throw new Error(`Not a permission mode: ${String(mode)}`);
  return (await patchPermissionState(projectRoot, { mode })).mode;
}

/** Whether this project has acknowledged the `skip` warning. */
export async function readSkipAcknowledged(projectRoot: string): Promise<boolean> {
  return (await readPermissionState(projectRoot)).skipAcknowledged;
}

export async function writeSkipAcknowledged(projectRoot: string, acknowledged: boolean): Promise<boolean> {
  return (await patchPermissionState(projectRoot, { skipAcknowledged: acknowledged === true })).skipAcknowledged;
}

// ---------------------------------------------------------------------------
// Over HTTP
//
//   GET  /api/permission-mode?project=<abs path>  -> { ok, mode, skipAcknowledged }
//   POST /api/permission-mode { project, mode?, skipAcknowledged? } -> the same
//
// Both fields are optional on the POST because the two things the client
// changes are independent: accepting the warning is not choosing the mode, and
// the confirm has to be able to record the acknowledgement in the same request
// that sets `skip` without a second round trip deciding which won.
// ---------------------------------------------------------------------------

export interface PermissionModeResult {
  status: number;
  body: unknown;
}

/**
 * `project` is validated the way every other project-scoped route here does it:
 * a non-empty string, resolved to an absolute path. Existence on disk is
 * deliberately NOT required: this is a preference ABOUT a path, and a folder
 * that is being created, or that lives on a volume that is not mounted right
 * now, still has a mode.
 */
const Patch = z
  .object({
    project: z.string().min(1).max(4096),
    // `z.enum` is what rejects an unrecognised mode. It must stay an enum: a
    // `z.string()` here would let anything through to be coerced later, which
    // is the failure note (2) exists to prevent.
    mode: z.enum(PERMISSION_MODES).optional(),
    skipAcknowledged: z.boolean().optional(),
  })
  .strict();

function payload(state: PermissionState): PermissionModeResult {
  return { status: 200, body: { ok: true, mode: state.mode, skipAcknowledged: state.skipAcknowledged } };
}

export async function getPermissionMode(project: unknown): Promise<PermissionModeResult> {
  if (typeof project !== 'string' || project.trim() === '') {
    return { status: 400, body: { ok: false, error: 'Missing "project".' } };
  }
  return payload(await readPermissionState(project));
}

export async function postPermissionMode(raw: unknown): Promise<PermissionModeResult> {
  const parsed = Patch.safeParse(raw);
  if (!parsed.success) {
    return {
      status: 400,
      body: { ok: false, error: 'Send a project path, and a mode of "ask", "auto" or "skip".' },
    };
  }
  const { project, mode, skipAcknowledged } = parsed.data;
  const patch: Partial<PermissionState> = {};
  if (mode !== undefined) patch.mode = mode;
  if (skipAcknowledged !== undefined) patch.skipAcknowledged = skipAcknowledged;
  // A body carrying neither field is a read: harmless, and cheaper to answer
  // than to argue with.
  if (Object.keys(patch).length === 0) return payload(await readPermissionState(project));
  return payload(await patchPermissionState(project, patch));
}

/** A JSON body, capped. The biggest thing that arrives is one path. */
async function readBody(req: IncomingMessage, limit = 16 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('That request was too large.');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** The http adapter. Everything above it is plain functions. */
export async function routePermissionMode(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (result: PermissionModeResult): void => {
    res.statusCode = result.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result.body));
  };
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://localhost');
      return send(await getPermissionMode(url.searchParams.get('project')));
    }
    if (req.method === 'POST') return send(await postPermissionMode(await readBody(req)));
    return send({ status: 405, body: { ok: false, error: 'Use GET or POST.' } });
  } catch (err) {
    send({ status: 400, body: { ok: false, error: (err as Error).message } });
  }
}
