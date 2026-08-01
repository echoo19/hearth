/**
 * Conversations, on disk.
 *
 * A conversation is the app's primary artifact — it is what the user actually
 * made — so it outlives the process that streamed it. Layout, relative to a
 * project root:
 *
 *   .hearth/chats/
 *     index.json          — [{ id, title, kind, createdAt, updatedAt }], newest first
 *     <chatId>.jsonl      — one JSON line per turn/tool event
 *
 * A row can also be PENDING, which is the difference between a conversation
 * existing and a conversation having happened. A chat is minted the moment a
 * window needs somewhere to send (opening a project does exactly that), so
 * listing every row put a "New chat" in the sidebar for every window anyone
 * ever opened. A pending row is written and openable by id, and no list shows
 * it until its first user message. See `ChatIndexRow.pending`.
 *
 * `kind` is what the conversation IS: a chat with the built-in agent, or a
 * terminal session. It is written once, at creation, and no function here
 * changes it afterwards — reopening a conversation must give you back the
 * thing you left, not a surface that can be flipped into something else.
 * A terminal record stores no transcript: the shell's output belongs to a pty
 * that dies with the process, and pretending otherwise would be a fiction.
 *
 * The jsonl line shape deliberately mirrors what already crosses the socket
 * (server/chat.ts's `ChatEvent`), so replay is the same fold the live stream
 * goes through rather than a second, drifting representation:
 *
 *   { "role": "user",  "ts": "…", "text": "make a shooter" }
 *   { "role": "agent", "ts": "…", "event": { "type": "text-delta", … } }
 *
 * Only history is durable. A live ChatDriver holds an in-process agent and
 * dies with the server; reopening a chat replays the transcript and starts a
 * fresh driver, which is the honest thing to show.
 *
 * Every write for a given (root, chatId) is serialized through one promise
 * chain, so a streaming turn cannot interleave a half-written line with an
 * index update.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { endsTurn, type ChatEvent, type ChatProvider } from './chat.js';
import { parseStoredAttachments, type StoredAttachment } from './chatAttachments.js';

/** Relative location of the chat directory within a project. */
export const CHATS_DIR = path.join('.hearth', 'chats');

/** How much of the first user message becomes the conversation's name. */
export const TITLE_MAX = 60;

/** The default name a chat carries until its first user message names it. */
export const UNTITLED = 'New chat';

/**
 * The default name a terminal session carries. Terminal records are never
 * named by a first user message the way chats are — nothing is typed at
 * Hearth in one, it is typed at a shell — so this is the name it keeps until
 * someone renames it.
 */
export const UNTITLED_TERMINAL = 'Terminal';

/** The default name of a conversation orchestrated as a dev team. */
export const UNTITLED_DEVTEAM = 'Dev team';

/**
 * Which kind of conversation a record is.
 *
 * Decided when the conversation is created and never after. A chat is a chat
 * for its whole life and a terminal session is a terminal session: to work the
 * other way you start another conversation, which is why nothing in this
 * module takes a kind for a record that already exists.
 */
export type ChatKind = 'chat' | 'terminal' | 'devteam';

/** The name a conversation of this kind starts with. */
export function defaultChatTitle(kind: ChatKind): string {
  if (kind === 'terminal') return UNTITLED_TERMINAL;
  return kind === 'devteam' ? UNTITLED_DEVTEAM : UNTITLED;
}

/** One conversation, as the sidebar lists it. */
export interface ChatSummary {
  id: string;
  title: string;
  /**
   * Chat or terminal. Written at creation, carried forever, and settable
   * nowhere else — see ChatKind. Records written before this field existed
   * have none, and `parseChatIndex` reads those as 'chat' rather than
   * rewriting the file, so every summary that leaves this module has one.
   */
  kind: ChatKind;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  /**
   * The codex thread this conversation is, when it is being answered by the
   * OpenAI backend. A codex thread outlives our process, so remembering it is
   * what lets reopening a chat RESUME the agent's own context instead of
   * starting a stranger who has only read the transcript. Absent for every
   * other backend, and harmless when the thread has since been forgotten (the
   * driver falls back to a fresh thread).
   */
  codexThreadId?: string;
  /**
   * The Claude session this conversation is, when the Anthropic backend has
   * answered it before — `codexThreadId`'s twin for the other agent. The
   * Agent SDK's CLI persists sessions under ~/.claude and resumes one by id,
   * so remembering it is what lets reopening a chat continue the agent's own
   * memory instead of starting a stranger who has only read the transcript.
   * Harmless when the session has since been pruned: the driver falls back to
   * a fresh one, whose id then overwrites this.
   */
  claudeSessionId?: string;
  /** The backend that most recently received a user turn in this chat. */
  lastProvider?: ChatProvider;
}

/**
 * A row exactly as `index.json` holds it: a summary plus the one field that
 * never leaves this module.
 */
export interface ChatIndexRow extends ChatSummary {
  /**
   * Created, but never spoken into.
   *
   * The window that started this chat is sitting in it right now, so the row
   * has to exist (a send needs somewhere to land). Nobody else has any reason
   * to know about it: it has no title anyone chose, no transcript, and until
   * someone types it is indistinguishable from every other empty chat. So it
   * is written and left out of every list, and `appendChatRecord` clears the
   * flag on the first user message, which is the moment it became a
   * conversation.
   *
   * Only ever `true`. A row that was never pending carries no field at all,
   * which is what every index written before this existed looks like, so
   * nothing already on disk is hidden by it.
   */
  pending?: true;
}

/** One line of a transcript. */
export type ChatRecord =
  | { role: 'user'; ts: string; text: string; attachments?: StoredAttachment[]; orchestration?: true }
  | { role: 'agent'; ts: string; event: ChatEvent };

export function chatsDir(root: string): string {
  return path.join(root, CHATS_DIR);
}

export function chatIndexPath(root: string): string {
  return path.join(chatsDir(root), 'index.json');
}

/**
 * A chat id is used as a filename, so it must never escape the chats
 * directory. Ids this module mints are already safe; ids arriving from a
 * client are run through here and rejected (null) when they are not.
 */
export function safeChatId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (id === '' || id.length > 128) return null;
  return /^[A-Za-z0-9._-]+$/.test(id) && !id.startsWith('.') ? id : null;
}

export function chatFilePath(root: string, chatId: string): string {
  return path.join(chatsDir(root), `${chatId}.jsonl`);
}

/**
 * Name a conversation after what was first asked of it. One line, collapsed
 * whitespace, cut on a word boundary where one is near the limit — a title is
 * a label, not a preview.
 */
export function chatTitleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line === '') return UNTITLED;
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > TITLE_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * What names a conversation whose first message was a file with no words —
 * dropping a screenshot in and pressing send is a real way to start, and
 * "New chat" forever is not a name.
 */
export function userRecordTitle(record: { text: string; attachments?: readonly StoredAttachment[] }): string {
  if (record.text.trim() !== '') return chatTitleFrom(record.text);
  const names = (record.attachments ?? []).map((a) => a.name).join(', ');
  return names === '' ? UNTITLED : chatTitleFrom(names);
}

/** Parse a transcript body, skipping blank and malformed lines. */
export function parseTranscript(text: string): ChatRecord[] {
  const out: ChatRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // a half-written trailing line, or corruption: skip it
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as Partial<ChatRecord> & { role?: string };
    const ts = typeof record.ts === 'string' ? record.ts : new Date(0).toISOString();
    if (record.role === 'user' && typeof (record as { text?: unknown }).text === 'string') {
      const attachments = parseStoredAttachments((record as { attachments?: unknown }).attachments);
      out.push({
        role: 'user',
        ts,
        text: (record as { text: string }).text,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...((record as { orchestration?: unknown }).orchestration === true ? { orchestration: true as const } : {}),
      });
    } else if (record.role === 'agent') {
      const event = (record as { event?: unknown }).event;
      if (event && typeof event === 'object' && typeof (event as { type?: unknown }).type === 'string') {
        out.push({ role: 'agent', ts, event: event as ChatEvent });
      }
    }
  }
  return out;
}

/**
 * Coerce whatever is in index.json into the rows it holds, pending included,
 * dropping unusable ones. Internal: everything outside this module reads the
 * index through `parseChatIndex`, which is the same thing minus the rows that
 * are not conversations yet.
 */
function parseChatRows(raw: unknown): ChatIndexRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatIndexRow[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Partial<ChatIndexRow>;
    const id = safeChatId(row.id);
    if (!id) continue;
    const createdAt = typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString();
    // Defaulted rather than carried through, and the default is deliberate:
    // every index written before `kind` existed holds conversations that were
    // chats, so a missing (or unrecognised) value reads as 'chat'. The row is
    // never dropped for it and the file is never rewritten to add it — the
    // next write does that on its own.
    const kind: ChatKind = row.kind === 'terminal' || row.kind === 'devteam' ? row.kind : 'chat';
    const summary: ChatIndexRow = {
      id,
      title: typeof row.title === 'string' && row.title.trim() !== '' ? row.title : defaultChatTitle(kind),
      kind,
      createdAt,
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : createdAt,
    };
    // Carried through rather than defaulted: an index written by an older
    // build simply has no thread (or session) to remember.
    if (typeof row.codexThreadId === 'string' && row.codexThreadId !== '') summary.codexThreadId = row.codexThreadId;
    if (typeof row.claudeSessionId === 'string' && row.claudeSessionId !== '') {
      summary.claudeSessionId = row.claudeSessionId;
    }
    if (row.lastProvider === 'anthropic' || row.lastProvider === 'openai') {
      summary.lastProvider = row.lastProvider;
    }
    // A literal `true` and nothing else: a row that says `pending: false`
    // describes a conversation that has happened, and carrying a field through
    // that reads as the opposite of what it means would put it on the wire.
    if (row.pending === true) summary.pending = true;
    out.push(summary);
  }
  return sortChats(out);
}

/**
 * Coerce whatever is in index.json into the conversations a list may show.
 *
 * Rows that were started and never spoken into are dropped rather than
 * defaulted: they are not conversations yet, and the whole point of the flag
 * is that nothing outside this module has to know they exist.
 */
export function parseChatIndex(raw: unknown): ChatSummary[] {
  return visibleChats(parseChatRows(raw));
}

/** The rows a list may show, in the order they were given. */
function visibleChats(rows: readonly ChatIndexRow[]): ChatSummary[] {
  return rows.filter((row) => row.pending !== true);
}

/**
 * A row as everything outside this module sees it.
 *
 * Spread and delete rather than rebuilt from named fields: `codexThreadId`
 * (and whatever a later change adds) has to survive being handed out, and a
 * rebuild is a list that silently stops matching the type it copies.
 */
function withoutPending(row: ChatIndexRow): ChatSummary {
  if (row.pending === undefined) return row;
  const chat: ChatIndexRow = { ...row };
  delete chat.pending;
  return chat;
}

/**
 * Newest activity first; ties break on id so the order is stable.
 *
 * Generic over the two fields it actually reads, so ordering is one rule
 * rather than a rule about summaries — and so a caller holding a richer row
 * gets its own type back rather than a widened one.
 */
export function sortChats<T extends { id: string; updatedAt: string }>(chats: T[]): T[] {
  return chats
    .slice()
    .sort((a, b) => (a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : b.updatedAt.localeCompare(a.updatedAt)));
}

// ---------------------------------------------------------------------------
// Write serialization
//
// One promise chain per project root. Appends and index rewrites share the
// chain: an index update that raced a streaming append could otherwise write a
// stale `updatedAt` back over a newer one.
// ---------------------------------------------------------------------------

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
 * What a read of the index saw, and whether it saw all of it.
 *
 * `whole` is false only when a recovery could not finish: the folder that says
 * which conversations exist could not be listed, or a transcript in it could not
 * be read. The rows are still the best answer to "what is there", which is what
 * a LISTING wants. No WRITE may be built on them. See `readIndexForWrite`.
 */
interface IndexRead {
  rows: ChatIndexRow[];
  whole: boolean;
}

/**
 * What every write path says when the listing could not be read in full.
 *
 * Stated rather than swallowed, because the alternative is worse than an error:
 * every write here is read-mutate-write, so a partial read that reaches one is
 * persisted as the whole truth, and the result is valid JSON, so the folder
 * rebuild that would have put the missing conversations back never runs again.
 */
export const INDEX_UNREADABLE_MESSAGE =
  'The conversation list could not be read in full, so nothing was changed. Try again in a moment.';

/** Thrown by every write path on a read that could not see the whole picture. */
export class ChatIndexUnreadableError extends Error {
  constructor() {
    super(INDEX_UNREADABLE_MESSAGE);
    this.name = 'ChatIndexUnreadableError';
  }
}

/**
 * The whole index, pending rows included. Every write path reads through here
 * rather than through `parseChatIndex`: an index rewritten from the filtered
 * view would delete the conversation the window that asked for the write is
 * sitting in.
 *
 * An ABSENT file is the normal state of a project nobody has talked to, and
 * reads as no conversations. A file that is THERE and does not parse is not
 * that, and treating the two the same is what turned one torn write into "every
 * conversation you ever had is gone": the empty answer went straight back out
 * to a `createChat` that wrote a single row over the wreck, while the
 * transcripts holding the actual conversations sat beside it, unlisted and
 * unreachable. The transcripts are the record, so that case rebuilds from them
 * (see `recoverIndexUnlocked`).
 */
async function readIndexUnlocked(root: string): Promise<IndexRead> {
  let raw: string;
  try {
    raw = await fsp.readFile(chatIndexPath(root), 'utf8');
  } catch {
    return { rows: [], whole: true }; // absent: a project that has never been talked to
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return recoverIndexUnlocked(root, raw);
  }
  const rows = Array.isArray(parsed) ? parseChatRows(parsed) : null;
  // Parsing is not the same as being this file. Something that is not a list at
  // all, or a list with not one usable row in it, describes no conversation and
  // would be written over by the next save, which is the same loss a torn file
  // used to cause. An EMPTY list is different and legitimate: it is a project
  // whose conversations were all deleted.
  if (rows && (rows.length > 0 || (parsed as unknown[]).length === 0)) return { rows, whole: true };
  return recoverIndexUnlocked(root, raw);
}

/**
 * The index, for a caller that is about to write it back.
 *
 * THE RULE: a read that could not see the whole picture never becomes the basis
 * of a write. A salvage is what this module could still make out of a damaged
 * file while the folder beside it was unreadable; saving it turns "could not
 * see" into "does not exist", permanently, for every conversation the salvage
 * happened to miss.
 */
async function readIndexForWrite(root: string): Promise<ChatIndexRow[]> {
  const read = await readIndexUnlocked(root);
  if (!read.whole) throw new ChatIndexUnreadableError();
  return read.rows;
}

/** The extension every kept copy of an unreadable index ends in. */
export const CORRUPT_INDEX_SUFFIX = '.corrupt';

/**
 * Where an index.json that could not be parsed is kept.
 *
 * Stamped with the moment it was found, because the copy worth having is the
 * FIRST one. Under one fixed name the second failure overwrote the first, and
 * by then the file being saved was a copy of an index this module had already
 * rebuilt: the evidence of what actually went missing was gone, replaced by
 * evidence of the recovery. These are small and nobody writes them on a good
 * day, so keeping all of them costs nothing worth counting.
 */
function corruptIndexPath(root: string, at: Date = new Date(), attempt = 0): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  return `${chatIndexPath(root)}.${stamp}${attempt > 0 ? `-${attempt}` : ''}${CORRUPT_INDEX_SUFFIX}`;
}

/**
 * Keep the unreadable file, without ever writing over a copy already there.
 * `wx` is what makes that a property of the filesystem rather than of a check
 * that could race with another window on the same project.
 */
async function archiveCorruptIndex(root: string, raw: string): Promise<void> {
  const found = new Date();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fsp.writeFile(corruptIndexPath(root, found, attempt), raw, { encoding: 'utf8', flag: 'wx' });
      return;
    } catch (err) {
      // Anything but a name that is taken is a disk we cannot write to, and the
      // recovery below matters more than the keepsake.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return;
    }
  }
}

/**
 * Every whole `{...}` object in a torn index, in the order it was written.
 *
 * A row is the ONLY place some things live: which kind of conversation it is,
 * the codex thread it resumes, the name someone typed for it. None of that is
 * in a transcript, so a rebuild that reads transcripts alone quietly demotes
 * every terminal session in the folder to a chat and then drops it for having
 * no lines. An index killed mid-write is not garbage though: it is the front of
 * a good file, so the whole objects in it are read back and only the torn one
 * at the end is lost.
 *
 * Brace counting rather than a JSON parser, because there is no valid document
 * here to parse; strings are tracked so a `{` inside a title is not mistaken
 * for a row.
 *
 * Each candidate is measured ON ITS OWN, from its own `{`, and that is the
 * load-bearing part. One pass that carried string state across the whole
 * document read every quote after a single unbalanced one inverted, so a `"`
 * anywhere near the front meant no object was found in a file full of them, and
 * the empty salvage went on to delete every terminal session in the folder (a
 * terminal keeps no transcript, so its row is the only evidence it exists).
 * Damage now costs the row it is inside and nothing else.
 */
function salvageIndexRows(raw: string): ChatIndexRow[] {
  const found: unknown[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '{') continue;
    const end = objectEnd(raw, i);
    if (end === -1) continue; // nothing whole starts here; the next `{` might
    try {
      found.push(JSON.parse(raw.slice(i, end + 1)));
      i = end; // taken whole, so nothing inside it is a candidate of its own
    } catch {
      // Not a row, or a damaged one. Left to the scan to step into: a `{` this
      // one swallowed may still be a whole object.
    }
  }
  return parseChatRows(found);
}

/**
 * Where the `{...}` that starts at `from` closes, or -1 when no whole one does.
 *
 * Starts with a FRESH idea of where strings are, which is what keeps one
 * object's damage out of the next one's reading.
 */
function objectEnd(raw: string, from: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * What a conversation was, according to the torn index, plus what its
 * transcript says has happened in it since.
 *
 * The row wins on identity (kind, name, codex thread) and the transcript wins
 * on activity: a row written when the chat was created says `pending` and calls
 * it "New chat", and the file next to it may hold a conversation that happened
 * after that row was last written.
 */
function mergeRecoveredRow(row: ChatIndexRow, records: readonly ChatRecord[]): ChatIndexRow {
  if (records.length === 0) return row;
  const first = records.find((record) => record.role === 'user' && record.orchestration !== true);
  const last = records[records.length - 1];
  const merged: ChatIndexRow = {
    ...row,
    // A chat still carrying the name it was born with is named by what was
    // first asked of it, exactly as `appendChatRecord` would have. One somebody
    // titled keeps that title.
    title:
      row.title === defaultChatTitle(row.kind) && first?.role === 'user' ? userRecordTitle(first) : row.title,
    createdAt: row.createdAt < records[0].ts ? row.createdAt : records[0].ts,
    updatedAt: row.updatedAt > last.ts ? row.updatedAt : last.ts,
  };
  // Spoken into, so not pending, whatever the row was written thinking. A USER
  // record is what counts, the same rule `appendChatRecord` clears the flag by:
  // a driver can write its own line before the person's has landed, and a
  // transcript holding only that is still a conversation nobody has had. This
  // used to clear the flag for any transcript with a line in it, so an index
  // torn at that moment brought the chat back listed, named "New chat", with
  // nothing anybody typed in it.
  if (first !== undefined) delete merged.pending;
  return merged;
}

/**
 * Rebuild the index from the folder it lives in.
 *
 * Two sources, and each is authoritative for a different thing. The FOLDER says
 * which conversations exist: every one of them has a `.jsonl`, written the
 * moment it was created, and a row for a file that is not there describes
 * something that was deleted. The TORN INDEX says what each of them is, which
 * is the half no transcript can answer: a terminal session keeps no transcript
 * at all (its output belonged to a pty that died with the process), and kind,
 * codex thread and chosen title are index-only for chats too. Reading only the
 * transcripts is what turned one torn write into "every named terminal in this
 * project is gone, permanently, and every codex thread with them".
 *
 * One thing still does not come back: a chat that was opened, never spoken
 * into, and whose row did not survive. It has an empty file and nothing else,
 * it is indistinguishable from every other empty chat, and the index hides
 * those anyway. Everything with a byte in it is kept, even when not one line
 * of it parses, because a file with bytes in it is somebody's conversation.
 *
 * The unreadable index is kept, not deleted: this function can only read what
 * it understands, and a person (or a later build) may get more out of it.
 */
async function recoverIndexUnlocked(root: string, raw: string): Promise<IndexRead> {
  await archiveCorruptIndex(root, raw);
  const dir = chatsDir(root);
  const salvaged = new Map<string, ChatIndexRow>();
  for (const row of salvageIndexRows(raw)) salvaged.set(row.id, row);

  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // The folder could not be READ (a descriptor limit under load, a
      // permission, a volume that went away). "No conversations here" would be
      // a conclusion drawn from a failure, so answer with the salvage and say
      // it is PARTIAL: a listing may show it, and no write may be built on it.
      // Returning it as if it were the whole file is how one unreadable moment
      // became permanent loss, because the next write persisted the salvage and
      // the valid JSON it left behind stopped the folder rebuild ever running
      // again. The file is left exactly as it is: the next read tries again
      // against a filesystem that may be well.
      return { rows: sortChats([...salvaged.values()]), whole: false };
    }
    names = []; // absent: nothing was ever written here
  }

  // Set by any transcript this pass could not read. Same rule as the folder: a
  // rebuild missing a file it could not open must not be saved over one that
  // still describes it.
  let partial = false;
  const rows: ChatIndexRow[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const id = safeChatId(name.slice(0, -'.jsonl'.length));
    if (!id) continue;
    const file = path.join(dir, name);
    const body = await fsp.readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
      // Gone between the listing and the read is a conversation that was
      // deleted. Anything else is this process failing to look.
      if (err.code !== 'ENOENT') partial = true;
      return null;
    });
    const records = parseTranscript(body ?? '');
    const known = salvaged.get(id);
    if (known) {
      rows.push(mergeRecoveredRow(known, records));
      continue;
    }
    if (records.length > 0) {
      const first = records.find((record) => record.role === 'user');
      rows.push({
        id,
        title: first?.role === 'user' ? userRecordTitle(first) : UNTITLED,
        // Nothing left says otherwise, and a chat is the thing a transcript
        // belongs to.
        kind: 'chat',
        createdAt: records[0].ts,
        updatedAt: records[records.length - 1].ts,
      });
      continue;
    }
    // Nothing readable in it and no row to say what it was. An empty file is a
    // chat nobody ever spoke into; a file that has bytes this build cannot
    // parse (or could not read at all) is not, and dropping it would delete a
    // conversation for being damaged.
    if (body !== null && body.trim() === '') continue;
    const at = await fsp
      .stat(file)
      .then((stats) => stats.mtime.toISOString())
      .catch(() => new Date().toISOString());
    rows.push({ id, title: UNTITLED, kind: 'chat', createdAt: at, updatedAt: at });
  }

  const recovered = sortChats(rows);
  // Written back here rather than left to the next write: `listChats` does not
  // write at all, so a recovery that only returned rows would rebuild them on
  // every read and leave the folder with no index at all. Skipped when a file
  // could not be read, for the same reason the write paths refuse a partial
  // read: rebuilding again next time costs a directory listing, and saving an
  // incomplete rebuild costs a conversation.
  if (!partial) await writeIndexUnlocked(root, recovered);
  return { rows: recovered, whole: !partial };
}

/**
 * Write the index so a reader sees all of the new file or all of the old, never
 * the middle of a save.
 *
 * Same temp-and-rename as personalization, modelPrefs and permissionMode, and
 * for a sharper reason than any of them: this is the one file that says which
 * conversations exist. A bare truncating write that is killed halfway (a quit,
 * a crash, a machine losing power) leaves invalid JSON where the whole history
 * of a project used to be. The temp file sits in the same directory because a
 * rename is only atomic within one filesystem.
 */
async function writeIndexUnlocked(root: string, chats: ChatIndexRow[]): Promise<void> {
  const file = chatIndexPath(root);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(temp, `${JSON.stringify(sortChats(chats), null, 2)}\n`, 'utf8');
    await fsp.rename(temp, file);
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Every conversation this project has had, newest activity first.
 *
 * "Has had", not "holds": a chat nobody has typed into yet is left out. It is
 * still openable by id (see `getChat`), which is what lets the window that
 * started it keep working while no list mentions it.
 */
export function listChats(root: string): Promise<ChatSummary[]> {
  // Deliberately the plain read, partial or not: showing what could be seen is
  // the right answer for a listing, and this path writes nothing, so a partial
  // answer cannot become the file.
  return serialize(root, async () => {
    const rows = visibleChats((await readIndexUnlocked(root)).rows);
    const ghosts = await Promise.all(rows.map((row) => neverSpokenInto(root, row)));
    return rows.filter((_row, at) => !ghosts[at]);
  });
}

/**
 * Whether a row is a conversation that never happened, judged by the file
 * rather than by the flag.
 *
 * The flag alone cannot answer this. `pending` was added after people had
 * already been using the app, and a row written before it exists carries no
 * field at all — which every listing reads as "not pending" and shows. What
 * they look like is exactly what the flag was invented to hide: created when a
 * window needed somewhere to send, never sent into, still called "New chat".
 * They are the rows a person sees stacked up in the rail having never started
 * those conversations.
 *
 * Two cheap conditions before anything is opened, so a listing does not pay a
 * stat per conversation: the row still carries the name it was born with (the
 * first message renames a chat, so anything spoken into has another name), and
 * it is a chat rather than a terminal, which IS a conversation from the moment
 * it exists. Then the file decides, and only a file that is definitely empty
 * counts. A transcript that could not be read at all is left alone: not
 * knowing is not the same as knowing there is nothing, and the wrong answer
 * here hides somebody's work.
 */
async function neverSpokenInto(root: string, row: { id: string; title: string; kind: ChatKind }): Promise<boolean> {
  if (row.kind === 'terminal' || row.title !== defaultChatTitle(row.kind)) return false;
  const stat = await fsp.stat(chatFilePath(root, row.id)).catch(() => null);
  return stat !== null && stat.size === 0;
}

/**
 * One conversation by id, listed or not.
 *
 * The socket has to be able to open a conversation no list shows: a chat is
 * pending from the moment it is created until its first message, and a window
 * is sitting in it for the whole of that time. Looking it up through
 * `listChats` would find nothing and the send would have nowhere to land.
 */
export function getChat(root: string, chatId: string): Promise<ChatSummary | null> {
  const id = safeChatId(chatId);
  if (!id) return Promise.resolve(null);
  return serialize(root, async () => {
    const row = (await readIndexUnlocked(root)).rows.find((chat) => chat.id === id);
    return row ? withoutPending(row) : null;
  });
}

/**
 * Start a conversation. A chat is named, and listed, on its first message.
 *
 * `kind` is the one thing decided here that can never be decided again: this
 * is the only place a record's kind is written, which is what makes "a chat is
 * a chat forever" a property of the store rather than a habit of the UI.
 */
export function createChat(
  root: string,
  options: { title?: string; kind?: ChatKind } = {},
): Promise<ChatSummary> {
  const kind: ChatKind = options.kind === 'terminal' || options.kind === 'devteam' ? options.kind : 'chat';
  const named = options.title?.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) ?? '';
  return serialize(root, async () => {
    const now = new Date().toISOString();
    const row: ChatIndexRow = {
      id: randomUUID(),
      title: named === '' ? defaultChatTitle(kind) : named,
      kind,
      createdAt: now,
      updatedAt: now,
    };
    // Pending until someone actually uses it, and that now includes a terminal.
    //
    // It used to read "a terminal session IS the conversation the moment it
    // exists", on the grounds that its shell is running and no first message
    // will ever name it. Both halves are true and the conclusion was still
    // wrong: opening a terminal and looking at the prompt is the same act as
    // opening a chat and not typing, and it left a row in the rail for it every
    // single time. A shell that was started and never typed into is not a
    // session anyone had.
    //
    // What clears it is the first thing typed at the pty (`markChatUsed`, from
    // the socket's `pty-input`), which is this kind's equivalent of a first
    // message.
    //
    // A terminal is pending even when it HAS a title, which is the one place
    // the two kinds differ: a terminal's title is the CLI Hearth is about to
    // type, decided before anything has happened, so it says nothing about
    // whether the session was used. A chat's title, by contrast, is only ever
    // set by something that already knows what the conversation is for
    // (`approveProposals` writes its first message in the same breath), so a
    // named chat is real from the start.
    if (kind === 'terminal' || named === '') row.pending = true;
    await writeIndexUnlocked(root, [row, ...(await readIndexForWrite(root))]);
    // Touch the transcript so an opened-but-silent chat reads back as empty
    // rather than missing.
    await fsp.writeFile(chatFilePath(root, row.id), '', { flag: 'a' });
    // Handed back without the flag: the caller opens this conversation and
    // sends it to a window, and whether the index still hides it is between
    // this module and the index.
    return withoutPending(row);
  });
}

/**
 * This conversation has now been used. Clears `pending`, once.
 *
 * A TERMINAL's first message. A chat joins the lists when a user record lands
 * (`appendChatRecord`), and a terminal has no records at all — its scrollback
 * is the pty's, not the transcript's — so without this it would either be
 * listed from the moment it was created, which is what it used to do and what
 * left a row behind for every shell anyone glanced at, or never be listed at
 * all.
 *
 * The trigger is the first byte the person types at the prompt, which is the
 * closest true equivalent of a first message: the shell's own output is not
 * it, since a prompt draws itself whether or not anybody is there.
 *
 * Cheap and idempotent. Almost every call is on a conversation that is already
 * listed — every keystroke after the first — so it reads, sees no flag, and
 * writes nothing.
 *
 * Answers false when there was nothing to do, including for an id that no
 * longer has a row: this is called from a keystroke handler, and a terminal
 * whose conversation was deleted in another window is not an error worth
 * failing a keystroke over.
 */
export function markChatUsed(root: string, chatId: string): Promise<boolean> {
  const id = safeChatId(chatId);
  if (!id) return Promise.resolve(false);
  return serialize(root, async () => {
    const read = await readIndexUnlocked(root);
    const index = read.rows.findIndex((chat) => chat.id === id);
    if (index === -1 || read.rows[index].pending !== true) return false;
    // Only ever on a whole read. Rewriting an index we could not fully see is
    // how the salvage path lost chats, and the flag is not worth that risk:
    // the next keystroke tries again, and the pending sweep keeps this
    // conversation as long as a window is sitting in it.
    if (!read.whole) return false;
    const next = { ...read.rows[index] };
    delete next.pending;
    read.rows[index] = next;
    await writeIndexUnlocked(root, read.rows);
    return true;
  });
}

/**
 * How long a conversation nobody has spoken into is kept. See
 * `prunePendingChats`.
 */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Forget conversations that were started and never used.
 *
 * Nothing in the UI can clear a pending row, because nothing in the UI can see
 * one: without this, every window that opened a project and closed it again
 * would leave a row and an empty transcript behind for good. Two rules keep it
 * from taking something real:
 *
 *  - `keepIds` names every conversation a window is currently sitting in. Those
 *    are the ones a person can still type into, so they are never touched, at
 *    any age.
 *  - Everything else must have been created longer ago than `ttlMs`. A chat
 *    with not one word in it a day later is not one anybody is waiting on.
 *
 * Returns the ids it forgot.
 */
export function prunePendingChats(
  root: string,
  options: { keepIds?: Iterable<string>; ttlMs?: number; now?: number } = {},
): Promise<string[]> {
  const keep = new Set(options.keepIds ?? []);
  const ttlMs = options.ttlMs ?? PENDING_TTL_MS;
  const now = options.now ?? Date.now();
  return serialize(root, async () => {
    const read = await readIndexUnlocked(root);
    // A sweep is the one write with nothing to report and nobody waiting on it,
    // so a read that could not see the whole folder simply means nothing is
    // swept this time. There is no way to tell a row nobody used from a row
    // this pass did not see.
    if (!read.whole) return [];
    const rows = read.rows;
    const stale = new Set(
      rows
        .filter((row) => {
          if (row.pending !== true || keep.has(row.id)) return false;
          const created = Date.parse(row.createdAt);
          // An unreadable date is not evidence of age: leave the row rather
          // than delete a conversation on a guess.
          return Number.isFinite(created) && now - created > ttlMs;
        })
        .map((row) => row.id),
    );
    if (stale.size === 0) return [];
    await writeIndexUnlocked(
      root,
      rows.filter((row) => !stale.has(row.id)),
    );
    for (const id of stale) await fsp.rm(chatFilePath(root, id), { force: true });
    return [...stale];
  });
}

/**
 * How stale a streaming conversation's `updatedAt` may get. See `indexMoved`.
 */
export const INDEX_TOUCH_MS = 5_000;

/**
 * Is this append worth rewriting index.json for?
 *
 * It used to be rewritten for EVERY streamed agent event: a whole-file,
 * pretty-printed rewrite several times a second, of the one file that says
 * which conversations exist. Every one of those is a window in which losing
 * the process loses the index, and almost none of them changes anything a
 * person can see, because nobody reads the sidebar's ordering mid-turn.
 *
 * So the rewrite happens when the row genuinely moves: a user message (which
 * lists and names the chat), the end of a turn (which is when ws.ts pushes a
 * fresh list out to every window), or a turn that has been streaming long
 * enough for the stored timestamp to be visibly stale. The transcript itself is
 * still appended for every single event, which is the part that is the record.
 */
function indexMoved(stored: ChatIndexRow, record: ChatRecord): boolean {
  if (record.role === 'user') return true;
  if (endsTurn(record.event)) return true;
  const was = Date.parse(stored.updatedAt);
  const now = Date.parse(record.ts);
  // An unreadable timestamp on either side: write, rather than leave a row
  // pinned to a value nothing will ever correct.
  if (!Number.isFinite(was) || !Number.isFinite(now)) return true;
  return now - was >= INDEX_TOUCH_MS;
}

/**
 * Append one record and bump the chat's `updatedAt`. The first user message
 * also names an as-yet-unnamed chat — which is the whole titling rule.
 *
 * Returns the chat's summary after the write, or NULL when the chat has no
 * index row, in which case nothing was written at all. Callers must check it:
 * a null means the conversation was deleted (in another window, this run) and
 * every message and event from here on would go nowhere, silently.
 *
 * The one append that is not a rewrite: the transcript line always lands, even
 * on a read that could not see the whole listing, because appending cannot
 * destroy anything and the transcript is the record. Only the index rewrite is
 * held back. A row that is simply MISSING from a partial read is the one case
 * with no honest answer, since "deleted" and "not seen" look the same, so that
 * one is refused rather than guessed.
 */
export function appendChatRecord(root: string, chatId: string, record: ChatRecord): Promise<ChatSummary | null> {
  const id = safeChatId(chatId);
  if (!id) return Promise.resolve(null);
  return serialize(root, async () => {
    const read = await readIndexUnlocked(root);
    const chats = read.rows;
    const index = chats.findIndex((chat) => chat.id === id);
    if (index === -1) {
      if (!read.whole) throw new ChatIndexUnreadableError();
      return null;
    }
    const file = chatFilePath(root, id);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
    // Spread first, so `kind` (and anything else the record already carries)
    // survives every append: activity changes when a conversation last moved,
    // never what kind of conversation it is.
    const next: ChatIndexRow = { ...chats[index], updatedAt: record.ts };
    if (record.role === 'user' && record.orchestration !== true) {
      // A message is what turns a chat into a conversation, so this is the
      // moment it joins the lists, under the name that message gives it. An
      // agent record deliberately does NOT do this: a driver can emit before
      // the user's own line has landed, and a chat appearing in the sidebar
      // with nothing anyone typed in it is what the flag exists to prevent.
      delete next.pending;
      if ((next.kind === 'chat' || next.kind === 'devteam') && next.title === defaultChatTitle(next.kind)) {
        next.title = userRecordTitle(record);
      }
    }
    // The line is on disk either way; only the listing is skipped.
    if (!read.whole || !indexMoved(chats[index], record)) return withoutPending(chats[index]);
    chats[index] = next;
    await writeIndexUnlocked(root, chats);
    return withoutPending(next);
  });
}

/** Everything said in a conversation, oldest first. */
export function readTranscript(root: string, chatId: string): Promise<ChatRecord[]> {
  const id = safeChatId(chatId);
  if (!id) return Promise.resolve([]);
  return serialize(root, async () => {
    try {
      return parseTranscript(await fsp.readFile(chatFilePath(root, id), 'utf8'));
    } catch {
      return [];
    }
  });
}

/** Rename a conversation. Returns null when the id is unknown or the name empty. */
export function renameChat(root: string, chatId: string, title: string): Promise<ChatSummary | null> {
  const id = safeChatId(chatId);
  const name = title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX * 2);
  if (!id || name === '') return Promise.resolve(null);
  return serialize(root, async () => {
    const chats = await readIndexForWrite(root);
    const index = chats.findIndex((chat) => chat.id === id);
    if (index === -1) return null;
    chats[index] = { ...chats[index], title: name };
    await writeIndexUnlocked(root, chats);
    return withoutPending(chats[index]);
  });
}

/**
 * Remember which codex thread answers this conversation, so reopening it
 * resumes rather than restarts. Deliberately does NOT touch `updatedAt`:
 * binding a backend is not conversation activity, and bumping it would
 * reorder the sidebar for something the user didn't do.
 */
export function setChatThreadId(root: string, chatId: string, threadId: string): Promise<ChatSummary | null> {
  const id = safeChatId(chatId);
  if (!id || threadId === '') return Promise.resolve(null);
  return serialize(root, async () => {
    const chats = await readIndexForWrite(root);
    const index = chats.findIndex((chat) => chat.id === id);
    if (index === -1 || chats[index].codexThreadId === threadId) return null;
    chats[index] = { ...chats[index], codexThreadId: threadId };
    await writeIndexUnlocked(root, chats);
    return withoutPending(chats[index]);
  });
}

/**
 * Remember which Claude session answers this conversation —
 * `setChatThreadId`'s twin for the Anthropic backend, with the same deliberate
 * refusal to touch `updatedAt`: binding a backend is not conversation
 * activity, and bumping it would reorder the sidebar for something the user
 * didn't do.
 */
export function setChatClaudeSessionId(
  root: string,
  chatId: string,
  sessionId: string,
): Promise<ChatSummary | null> {
  const id = safeChatId(chatId);
  if (!id || sessionId === '') return Promise.resolve(null);
  return serialize(root, async () => {
    const chats = await readIndexForWrite(root);
    const index = chats.findIndex((chat) => chat.id === id);
    if (index === -1 || chats[index].claudeSessionId === sessionId) return null;
    chats[index] = { ...chats[index], claudeSessionId: sessionId };
    await writeIndexUnlocked(root, chats);
    return withoutPending(chats[index]);
  });
}

/** Remember the actual backend that received the latest turn. */
export function setChatProvider(
  root: string,
  chatId: string,
  provider: ChatProvider,
): Promise<ChatSummary | null> {
  const id = safeChatId(chatId);
  if (!id) return Promise.resolve(null);
  return serialize(root, async () => {
    const chats = await readIndexForWrite(root);
    const index = chats.findIndex((chat) => chat.id === id);
    if (index === -1 || chats[index].lastProvider === provider) return null;
    chats[index] = { ...chats[index], lastProvider: provider };
    await writeIndexUnlocked(root, chats);
    return withoutPending(chats[index]);
  });
}

/** Forget a conversation: its index entry and its transcript. */
export function deleteChat(root: string, chatId: string): Promise<boolean> {
  const id = safeChatId(chatId);
  if (!id) return Promise.resolve(false);
  return serialize(root, async () => {
    const chats = await readIndexForWrite(root);
    const next = chats.filter((chat) => chat.id !== id);
    if (next.length === chats.length) return false;
    await writeIndexUnlocked(root, next);
    await fsp.rm(chatFilePath(root, id), { force: true });
    return true;
  });
}
