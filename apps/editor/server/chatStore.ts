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
import { endsTurn, type ChatEvent } from './chat.js';
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

/**
 * Which kind of conversation a record is.
 *
 * Decided when the conversation is created and never after. A chat is a chat
 * for its whole life and a terminal session is a terminal session: to work the
 * other way you start another conversation, which is why nothing in this
 * module takes a kind for a record that already exists.
 */
export type ChatKind = 'chat' | 'terminal';

/** The name a conversation of this kind starts with. */
export function defaultChatTitle(kind: ChatKind): string {
  return kind === 'terminal' ? UNTITLED_TERMINAL : UNTITLED;
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
  | { role: 'user'; ts: string; text: string; attachments?: StoredAttachment[] }
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
    const kind: ChatKind = row.kind === 'terminal' ? 'terminal' : 'chat';
    const summary: ChatIndexRow = {
      id,
      title: typeof row.title === 'string' && row.title.trim() !== '' ? row.title : defaultChatTitle(kind),
      kind,
      createdAt,
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : createdAt,
    };
    // Carried through rather than defaulted: an index written by an older
    // build simply has no thread to remember.
    if (typeof row.codexThreadId === 'string' && row.codexThreadId !== '') summary.codexThreadId = row.codexThreadId;
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
async function readIndexUnlocked(root: string): Promise<ChatIndexRow[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(chatIndexPath(root), 'utf8');
  } catch {
    return []; // absent: a project that has never been talked to
  }
  try {
    return parseChatRows(JSON.parse(raw));
  } catch {
    return recoverIndexUnlocked(root, raw);
  }
}

/** Where an index.json that could not be parsed is kept. */
export function corruptIndexPath(root: string): string {
  return `${chatIndexPath(root)}.corrupt`;
}

/**
 * Rebuild the index from the transcripts sitting next to it.
 *
 * Everything a conversation IS lives in its `.jsonl`: who said what, in what
 * order, and when. The index is a listing of those files, so an unreadable one
 * is recoverable rather than fatal, and the rebuild is what makes a torn write
 * cost an ordering and a couple of names instead of a person's whole history.
 *
 * Two things do not come back, and both are deliberate. A transcript with
 * nothing in it is skipped: it is a chat that was opened and never spoken into
 * (which the index hides anyway), and recovering those would fill the sidebar
 * with "New chat" rows for windows nobody remembers opening. And a codex
 * thread binding is not in the transcript, so a recovered conversation starts a
 * fresh thread with its history replayed rather than resuming the old one.
 *
 * The unreadable file is kept, not deleted: this function can only read what it
 * understands, and a person (or a later build) may get more out of it.
 */
async function recoverIndexUnlocked(root: string, raw: string): Promise<ChatIndexRow[]> {
  await fsp.writeFile(corruptIndexPath(root), raw, 'utf8').catch(() => undefined);
  const dir = chatsDir(root);
  const rows: ChatIndexRow[] = [];
  for (const name of await fsp.readdir(dir).catch((): string[] => [])) {
    if (!name.endsWith('.jsonl')) continue;
    const id = safeChatId(name.slice(0, -'.jsonl'.length));
    if (!id) continue;
    const records = parseTranscript(await fsp.readFile(path.join(dir, name), 'utf8').catch(() => ''));
    if (records.length === 0) continue;
    const first = records.find((record) => record.role === 'user');
    rows.push({
      id,
      title: first?.role === 'user' ? userRecordTitle(first) : UNTITLED,
      // A terminal session keeps no transcript (its output belongs to a pty
      // that died with the process), so anything with one was a chat.
      kind: 'chat',
      createdAt: records[0].ts,
      updatedAt: records[records.length - 1].ts,
    });
  }
  const recovered = sortChats(rows);
  // Written back here rather than left to the next write: `listChats` does not
  // write at all, so a recovery that only returned rows would rebuild them on
  // every read and leave the folder with no index at all.
  await writeIndexUnlocked(root, recovered);
  return recovered;
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
  return serialize(root, async () => visibleChats(await readIndexUnlocked(root)));
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
    const row = (await readIndexUnlocked(root)).find((chat) => chat.id === id);
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
  const kind: ChatKind = options.kind === 'terminal' ? 'terminal' : 'chat';
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
    // Pending unless the record is already something someone asked for. A
    // terminal session IS the conversation the moment it exists (its shell is
    // running, and no first message will ever name it), and a chat created
    // with a title was named on purpose. An unnamed chat has nothing in it and
    // nothing to call it, so it waits to be spoken into.
    if (kind === 'chat' && named === '') row.pending = true;
    await writeIndexUnlocked(root, [row, ...(await readIndexUnlocked(root))]);
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
    const rows = await readIndexUnlocked(root);
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
 */
export function appendChatRecord(root: string, chatId: string, record: ChatRecord): Promise<ChatSummary | null> {
  const id = safeChatId(chatId);
  if (!id) return Promise.resolve(null);
  return serialize(root, async () => {
    const chats = await readIndexUnlocked(root);
    const index = chats.findIndex((chat) => chat.id === id);
    if (index === -1) return null;
    const file = chatFilePath(root, id);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
    // Spread first, so `kind` (and anything else the record already carries)
    // survives every append: activity changes when a conversation last moved,
    // never what kind of conversation it is.
    const next: ChatIndexRow = { ...chats[index], updatedAt: record.ts };
    if (record.role === 'user') {
      // A message is what turns a chat into a conversation, so this is the
      // moment it joins the lists, under the name that message gives it. An
      // agent record deliberately does NOT do this: a driver can emit before
      // the user's own line has landed, and a chat appearing in the sidebar
      // with nothing anyone typed in it is what the flag exists to prevent.
      delete next.pending;
      if (next.kind === 'chat' && next.title === UNTITLED) next.title = userRecordTitle(record);
    }
    // The line is on disk either way; only the listing is skipped.
    if (!indexMoved(chats[index], record)) return withoutPending(chats[index]);
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
    const chats = await readIndexUnlocked(root);
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
    const chats = await readIndexUnlocked(root);
    const index = chats.findIndex((chat) => chat.id === id);
    if (index === -1 || chats[index].codexThreadId === threadId) return null;
    chats[index] = { ...chats[index], codexThreadId: threadId };
    await writeIndexUnlocked(root, chats);
    return withoutPending(chats[index]);
  });
}

/** Forget a conversation: its index entry and its transcript. */
export function deleteChat(root: string, chatId: string): Promise<boolean> {
  const id = safeChatId(chatId);
  if (!id) return Promise.resolve(false);
  return serialize(root, async () => {
    const chats = await readIndexUnlocked(root);
    const next = chats.filter((chat) => chat.id !== id);
    if (next.length === chats.length) return false;
    await writeIndexUnlocked(root, next);
    await fsp.rm(chatFilePath(root, id), { force: true });
    return true;
  });
}
