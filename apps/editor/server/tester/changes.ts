/**
 * What happened to this game since the tester last played.
 *
 * Read from what the project itself recorded: the command journal
 * (`.hearth/log/commands.jsonl`) and the chat transcripts under
 * `.hearth/chats/`. Deliberately not a git diff. The tester's job is to say
 * whether your change helped, and a diff shows which lines moved while the
 * journal and the conversation carry what you were trying to do.
 *
 * Everything here is defensive about the files it reads. Both are append-only
 * logs that can be caught mid-write, and one half-written trailing line must not
 * cost the tester its entire sense of what changed.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/** How many entries reach the prompt. Older than this and it is not "your last change". */
const MAX_ENTRIES = 40;
/** A chat message is a paragraph, not a document; the tester needs the ask, not the essay. */
const MAX_MESSAGE_CHARS = 400;

interface Change {
  ts: string;
  text: string;
}

/** Parse a JSONL body into objects, skipping blanks and anything that will not parse. */
function parseLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      out.push(parsed as Record<string, unknown>);
    }
  }
  return out;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

async function readFileOrEmpty(file: string): Promise<string> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * The small facts a journal entry carries beside its summary.
 *
 * A summary is terse by design ("setComponentProperty Level 1") and the fact
 * that actually says what changed is in `detail`
 * ("CharacterController.jumpHeight"). Without this the tester is asked whether
 * your change helped while being told only that a command ran.
 */
function detailPhrase(detail: unknown): string {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
    // Scalars only. A nested object here is a whole component, and pasting one
    // into the prompt would bury the sentence it belongs to.
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** The journal's half: commands that ran, with the summary they recorded. */
async function journalChanges(root: string): Promise<Change[]> {
  const text = await readFileOrEmpty(path.join(root, '.hearth', 'log', 'commands.jsonl'));
  const out: Change[] = [];
  for (const entry of parseLines(text)) {
    const ts = readString(entry.ts);
    const summary = readString(entry.summary) ?? readString(entry.command);
    if (!ts || !summary) continue;
    // A command that failed changed nothing. Left in, because "someone tried
    // this and it did not work" is a fact about the project, but never as
    // something the tester should look for the effects of.
    const failed = entry.ok === false ? ' (this one failed and changed nothing)' : '';
    out.push({ ts, text: `${summary}${detailPhrase(entry.detail)}${failed}` });
  }
  return out;
}

/** The conversation's half: what was asked for, in the words it was asked in. */
async function chatChanges(root: string): Promise<Change[]> {
  const dir = path.join(root, '.hearth', 'chats');
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out: Change[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    for (const record of parseLines(await readFileOrEmpty(path.join(dir, entry)))) {
      if (record.role !== 'user') continue;
      const ts = readString(record.ts);
      const text = readString(record.text);
      if (!ts || !text) continue;
      const flat = text.replace(/\s+/g, ' ');
      out.push({
        ts,
        text: `asked for: ${flat.length > MAX_MESSAGE_CHARS ? `${flat.slice(0, MAX_MESSAGE_CHARS)}…` : flat}`,
      });
    }
  }
  return out;
}

/**
 * A plain-prose summary of everything recorded after `since`, or a sentence
 * saying nothing was. `since` is null the first time the tester plays, which
 * takes the whole record rather than none of it.
 */
export async function changesSince(root: string, since: string | null): Promise<string> {
  const all = [...(await journalChanges(root)), ...(await chatChanges(root))]
    .filter((change) => (since === null ? true : change.ts > since))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  if (all.length === 0) {
    return since === null
      ? 'Nothing has been recorded about this game yet. This is your first look at it.'
      : 'Nothing has been recorded in this project since you last played.';
  }
  // Newest last, so the prompt ends on the most recent change: that is the one
  // the verdict is supposed to be about.
  const kept = all.slice(-MAX_ENTRIES);
  return kept.map((change) => `- ${change.text}`).join('\n');
}
