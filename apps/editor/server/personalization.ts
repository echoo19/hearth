/**
 * Personalization: the two things that are about the person, not the game.
 *
 *   ~/.hearth/personalization.json    what to call you
 *   ~/.hearth/AGENTS.md               standing instructions for every project
 *
 * Like skills — and for the same reason — these are NOT scoped to a project.
 * A name you gave once should still be your name in the next game you start,
 * and jailing that per folder would mean re-typing it every time. Splitting
 * them across two files is deliberate rather than tidy-minded: the
 * instructions are markdown a person writes and rereads, and a `\n` inside a
 * JSON string is not something anyone should have to edit by hand. AGENTS.md
 * is also the name every agent already knows, which keeps the file useful to a
 * CLI run outside this app.
 *
 * Because there is no project jail here, the validation carries the whole
 * weight: both values are capped, the name is stripped of anything that isn't
 * a plain line of text, and the request shape is checked with zod before
 * anything touches the disk. Writes go through a temp file and a rename, so a
 * crash mid-save leaves the previous text rather than half of the new one.
 *
 * REACH, stated plainly because a settings field nothing reads is worse than
 * no field at all: `personalPrompt` below composes these two values into one
 * short block, and both backends put that block in the agent's SYSTEM prompt
 * when a conversation binds — the Agent SDK by appending to its preset, codex
 * by passing `developerInstructions` on `thread/start`. Neither ever prepends
 * it to the user's message: the transcript is what the person reads back, and
 * pushing house rules into it would make every conversation open with words
 * they did not type.
 *
 * Read at BIND, not at boot, for the same reason `syncSkillsIntoProject` is:
 * the files are plain text a person edits while the app is running, and a
 * value cached at startup would go stale silently. The cost is that a
 * conversation already open keeps whatever it bound with, which the
 * Personalization pane says out loud.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { hearthHome } from './skills.js';

/** Where the name lives. Beside the skills folder, never inside it. */
export function personalizationPath(): string {
  return path.join(hearthHome(), 'personalization.json');
}

/** Where the standing instructions live — the filename every agent knows. */
export function personalInstructionsPath(): string {
  return path.join(hearthHome(), 'AGENTS.md');
}

/** A name is a label, not a paragraph. */
export const MAX_NAME = 60;

/**
 * Instructions are read by an agent on every turn, so the ceiling is about
 * what a model can usefully carry rather than about disk. Long enough for a
 * page of house rules, short enough that it can never become the prompt.
 */
export const MAX_INSTRUCTIONS = 20_000;

export interface Personalization {
  /** What the agent should call the user. Empty means "no preference". */
  name: string;
  /** Standing instructions that apply to every project. Markdown. */
  instructions: string;
}

/** A name reduced to one plain line, or '' when there is nothing usable left. */
export function cleanName(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Control bytes and newlines out: this ends up inside a sentence, and a name
  // carrying a line break would tear whatever renders it in half.
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

/**
 * Instructions, normalized to LF, capped, and trimmed at both ends. Otherwise
 * left exactly as typed — this is a person's markdown, not a config value.
 *
 * The trim is what makes the stored form and the read-back form the same
 * string. The file on disk always ends in one newline, the way a text file
 * should; without trimming, every reload would hand the editor a value one
 * character off from what it just saved and provoke a second, pointless save.
 */
export function cleanInstructions(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').slice(0, MAX_INSTRUCTIONS).trim();
}

/**
 * Write a file so that a reader either sees all of the new text or all of the
 * old — never the middle of a save. The temp file sits in the same directory
 * on purpose: a rename is only atomic within one filesystem.
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
 * Read both. Anything missing, unreadable or the wrong shape reads as empty,
 * which is a complete answer — nobody has set this yet is the normal state.
 */
export async function readPersonalization(): Promise<Personalization> {
  const [name, instructions] = await Promise.all([
    fsp
      .readFile(personalizationPath(), 'utf8')
      .then((raw): string => {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
        return cleanName((parsed as Record<string, unknown>).name);
      })
      .catch(() => ''),
    fsp
      .readFile(personalInstructionsPath(), 'utf8')
      .then((raw) => cleanInstructions(raw))
      .catch(() => ''),
  ]);
  return { name, instructions };
}

/**
 * Change one or both. Merges rather than replaces — saving instructions must
 * not silently drop the name — and an explicitly empty string really does
 * clear a field, because "I would rather you didn't call me anything" is a
 * choice the pane has to be able to send.
 *
 * A cleared field deletes its file instead of leaving an empty one behind: an
 * empty AGENTS.md in the home folder is a thing other agents would go and read
 * for nothing.
 */
export async function writePersonalization(patch: Partial<Personalization>): Promise<Personalization> {
  const current = await readPersonalization();
  const next: Personalization = {
    name: patch.name === undefined ? current.name : cleanName(patch.name),
    instructions: patch.instructions === undefined ? current.instructions : cleanInstructions(patch.instructions),
  };
  if (patch.name !== undefined && next.name !== current.name) {
    if (next.name === '') await fsp.rm(personalizationPath(), { force: true });
    else await writeAtomic(personalizationPath(), `${JSON.stringify({ name: next.name }, null, 2)}\n`);
  }
  if (patch.instructions !== undefined && next.instructions !== current.instructions) {
    if (next.instructions === '') await fsp.rm(personalInstructionsPath(), { force: true });
    else await writeAtomic(personalInstructionsPath(), `${next.instructions}\n`);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Reaching the agent
// ---------------------------------------------------------------------------

/**
 * The framing that goes above whatever the person wrote.
 *
 * Two jobs, and no more than two: say WHOSE words these are, and say that they
 * are standing preferences rather than the thing being asked for right now. An
 * agent handed a paragraph with no frame reads it as part of the request.
 */
const PREAMBLE =
  'Standing preferences from the person you are working with. They set these once in Hearth and they apply to every project of theirs, so treat them as background rather than as this turn’s request.';

/**
 * Where user-level and project-level instructions disagree, the project wins.
 *
 * This is not a nicety. A project's own AGENTS.md is committed with the game,
 * is written about that game, and is the more specific of the two; a
 * preference typed once in Settings months ago must not quietly override it.
 * Stating the order inside the block is the only place it CAN be stated —
 * neither backend gives us a precedence knob, so the ordering has to be
 * something the model is told rather than something the plumbing enforces.
 *
 * Only emitted alongside instructions. A name cannot contradict a project.
 */
const PRECEDENCE =
  'The open project’s own AGENTS.md is the more specific instruction. Follow the project wherever the two disagree.';

/**
 * Compose the block to hand an agent, or null when there is nothing to say.
 *
 * Null rather than an empty string on purpose: the callers use it to decide
 * whether to add a key at all, so a user who has set no personalization gets
 * exactly the options Hearth sent before this existed.
 *
 * Both values are re-cleaned here even though `readPersonalization` already
 * cleans them. These are plain files in the user's home, editable by any
 * editor and by any other agent, so the cap that was applied on write is not a
 * cap that still holds on read — and this text goes into a context window
 * where every token is one the person's actual request does not get.
 */
export function personalPrompt(personalization: Personalization): string | null {
  const name = cleanName(personalization.name);
  const instructions = cleanInstructions(personalization.instructions);
  if (name === '' && instructions === '') return null;

  const parts: string[] = [PREAMBLE];
  if (name !== '') parts.push(`Call them ${name}.`);
  if (instructions !== '') {
    parts.push('Their standing instructions, in their own words:', instructions, PRECEDENCE);
  }
  return parts.join('\n\n');
}

/**
 * Read the files and compose the block, fresh. Never throws: an unreadable or
 * missing home means "no personalization", never a conversation that failed to
 * start. `readPersonalization` already swallows a missing or malformed file;
 * the guard here is for the layer under it (a `HEARTH_HOME` that cannot be
 * resolved at all), because the caller is a driver's `start()`.
 */
export async function readPersonalPrompt(): Promise<string | null> {
  try {
    return personalPrompt(await readPersonalization());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Over HTTP
//
//   GET  /api/personalization  → { ok, personalization, files }
//   POST /api/personalization  → the same, after applying a patch
//
// The paths ride along on both because the pane shows where the text landed,
// and only the server knows whether HEARTH_HOME has been pointed somewhere.
// ---------------------------------------------------------------------------

export interface PersonalizationResult {
  status: number;
  body: unknown;
}

const Patch = z
  .object({
    name: z.string().max(MAX_NAME * 4).optional(),
    instructions: z.string().max(MAX_INSTRUCTIONS * 2).optional(),
  })
  .strict();

function payload(personalization: Personalization): PersonalizationResult {
  return {
    status: 200,
    body: {
      ok: true,
      personalization,
      files: { name: personalizationPath(), instructions: personalInstructionsPath() },
    },
  };
}

export async function getPersonalization(): Promise<PersonalizationResult> {
  return payload(await readPersonalization());
}

export async function postPersonalization(raw: unknown): Promise<PersonalizationResult> {
  const parsed = Patch.safeParse(raw);
  if (!parsed.success) {
    return { status: 400, body: { ok: false, error: parsed.error.issues[0]?.message ?? 'Unusable request.' } };
  }
  // Nothing named means nothing to change. Answering with the current values
  // is more useful than a 400: the pane can treat it as a refresh.
  return payload(await writePersonalization(parsed.data));
}

/** A JSON body, capped — the biggest thing that arrives is a page of markdown. */
async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** The http adapter. Everything above it is plain functions. */
export async function routePersonalization(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (result: PersonalizationResult): void => {
    res.statusCode = result.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result.body));
  };
  try {
    if (req.method === 'GET') return send(await getPersonalization());
    if (req.method === 'POST') return send(await postPersonalization(await readBody(req)));
    return send({ status: 405, body: { ok: false, error: 'Use GET or POST.' } });
  } catch (err) {
    send({ status: 400, body: { ok: false, error: (err as Error).message } });
  }
}
