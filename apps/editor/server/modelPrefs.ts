/**
 * Which models the user wants to see.
 *
 *   ~/.hearth/models.json    the models switched off, and nothing else
 *
 * Codex already reports six models and that list only grows; Anthropic's grows
 * too. The composer's picker is a menu you open mid-sentence, so it should be
 * the shortlist the person chose rather than every id their backends know. This
 * file is that shortlist, stored as its complement.
 *
 * Four decisions, each of which is the whole reason this is a file and not a
 * line in some other one:
 *
 *  1. **Per machine, not per project.** Like skills and personalization, a
 *     preference about which models you want to be offered is about you, not
 *     about the folder that happens to be open. It lives beside them in
 *     `~/.hearth/`, takes no `project`, and touches nothing inside one.
 *  2. **DISABLED is stored, never enabled.** A model nobody has seen yet has to
 *     default to available: storing the enabled set would mean every model a
 *     provider ships next month arrived switched off, and the user would have
 *     to come here to turn on a thing they never turned off.
 *  3. **An id Hearth does not recognise is kept, not dropped.** Validation here
 *     is about SHAPE only, because there is no catalogue on this side to check
 *     membership against, and there must not be: a model that disappears from a
 *     provider's list for a week and comes back has to come back still off. The
 *     failure this avoids has already happened once in this app, to the stored
 *     effort value, and it cost the user their model along with it.
 *  4. **A patch, not a replacement.** The wire takes one model and one boolean.
 *     A client that sent the whole list could only send the models it could see,
 *     which would quietly prune every id from (3) the moment anyone toggled
 *     anything.
 *
 * What is NOT enforced here: that a provider keeps at least one usable model.
 * That rule needs the provider's live catalogue, which only the client has, so
 * the client enforces it (see chat/modelChoice.ts) and this file stays honest
 * about what it can actually check.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { hearthHome } from './skills.js';

/** Where the list lives. Beside skills.json, for the same reasons. */
export function modelPrefsPath(): string {
  return path.join(hearthHome(), 'models.json');
}

/**
 * A ceiling, so a corrupt or hostile file cannot become unbounded work. Far
 * above any real catalogue: two providers offering a dozen models each would
 * use a twelfth of it.
 */
export const MAX_DISABLED_MODELS = 200;

/**
 * `provider:modelId`. Scoped by provider because the same id under two
 * backends would be two different models, and because an unscoped list could
 * not say which one was meant.
 *
 * The id half is deliberately permissive: it is the backend's vocabulary, not
 * ours, and a shape check that guessed at it would reject models that have not
 * shipped yet. It only has to be short, printable, and free of anything that
 * would argue with JSON or a path.
 */
const MODEL_KEY = /^(anthropic|openai):[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

/** The one way a key is built. Both sides of the wire use this shape. */
export function modelKey(provider: string, id: string): string {
  return `${provider}:${id}`;
}

export function isModelKey(value: unknown): value is string {
  return typeof value === 'string' && MODEL_KEY.test(value);
}

export interface ModelPrefs {
  /** Keys of the models the user switched off. Sorted, unique, capped. */
  disabled: string[];
}

/**
 * Anything at all, reduced to a usable list. Junk entries are skipped one by
 * one rather than failing the read: a file with one bad line still knows about
 * the other nine, and the alternative is silently re-enabling everything.
 */
export function cleanDisabled(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys = new Set<string>();
  for (const entry of value) {
    if (isModelKey(entry)) keys.add(entry);
    if (keys.size >= MAX_DISABLED_MODELS) break;
  }
  return [...keys].sort();
}

/**
 * Read the list. Missing, unreadable or malformed all read as "nothing is
 * switched off", which is the correct answer and the normal one: nobody has
 * been here yet.
 */
export async function readModelPrefs(): Promise<ModelPrefs> {
  try {
    const raw: unknown = JSON.parse(await fsp.readFile(modelPrefsPath(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { disabled: [] };
    return { disabled: cleanDisabled((raw as Record<string, unknown>).disabled) };
  } catch {
    return { disabled: [] };
  }
}

/**
 * Write so a reader sees all of the new file or all of the old, never the
 * middle of a save. Same temp-and-rename as personalization, and the temp file
 * sits in the same directory because a rename is only atomic within one
 * filesystem.
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
 * Switch one model off or back on, leaving every other entry exactly as it was
 * — including entries for models this client has never heard of. That merge is
 * the point of the whole module; see note (4) at the top.
 *
 * An empty list deletes the file rather than leaving `{"disabled": []}` on
 * disk. "Nothing switched off" and "no file" are the same state, and only one
 * of them is worth keeping.
 */
export async function setModelDisabled(key: string, disabled: boolean): Promise<ModelPrefs> {
  const current = await readModelPrefs();
  const keys = new Set(current.disabled);
  if (disabled) {
    if (keys.size >= MAX_DISABLED_MODELS && !keys.has(key)) return current;
    keys.add(key);
  } else {
    keys.delete(key);
  }
  const next: ModelPrefs = { disabled: [...keys].sort() };
  if (next.disabled.length === 0) await fsp.rm(modelPrefsPath(), { force: true });
  else await writeAtomic(modelPrefsPath(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// ---------------------------------------------------------------------------
// Over HTTP
//
//   GET  /api/model-prefs  → { ok, disabled, file }
//   POST /api/model-prefs  → the same, after switching one model
//
// The path rides along because the pane says where the choice landed, and only
// the server knows whether HEARTH_HOME has been pointed somewhere.
// ---------------------------------------------------------------------------

export interface ModelPrefsResult {
  status: number;
  body: unknown;
}

const Patch = z
  .object({
    model: z.string().max(128),
    enabled: z.boolean(),
  })
  .strict();

function payload(prefs: ModelPrefs): ModelPrefsResult {
  return { status: 200, body: { ok: true, disabled: prefs.disabled, file: modelPrefsPath() } };
}

export async function getModelPrefs(): Promise<ModelPrefsResult> {
  return payload(await readModelPrefs());
}

export async function postModelPrefs(raw: unknown): Promise<ModelPrefsResult> {
  const parsed = Patch.safeParse(raw);
  if (!parsed.success) {
    return { status: 400, body: { ok: false, error: 'Send a model id and whether it is enabled.' } };
  }
  if (!isModelKey(parsed.data.model)) {
    return { status: 400, body: { ok: false, error: 'That is not a model Hearth can store a preference for.' } };
  }
  return payload(await setModelDisabled(parsed.data.model, !parsed.data.enabled));
}

/** A JSON body, capped. The biggest thing that arrives is one model id. */
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
export async function routeModelPrefs(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (result: ModelPrefsResult): void => {
    res.statusCode = result.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result.body));
  };
  try {
    if (req.method === 'GET') return send(await getModelPrefs());
    if (req.method === 'POST') return send(await postModelPrefs(await readBody(req)));
    return send({ status: 405, body: { ok: false, error: 'Use GET or POST.' } });
  } catch (err) {
    send({ status: 400, body: { ok: false, error: (err as Error).message } });
  }
}
