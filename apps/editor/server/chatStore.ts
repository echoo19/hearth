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
import type { ChatEvent } from './chat.js';
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

/** Coerce whatever is in index.json into summaries, dropping unusable rows. */
export function parseChatIndex(raw: unknown): ChatSummary[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatSummary[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Partial<ChatSummary>;
    const id = safeChatId(row.id);
    if (!id) continue;
    const createdAt = typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString();
    // Defaulted rather than carried through, and the default is deliberate:
    // every index written before `kind` existed holds conversations that were
    // chats, so a missing (or unrecognised) value reads as 'chat'. The row is
    // never dropped for it and the file is never rewritten to add it — the
    // next write does that on its own.
    const kind: ChatKind = row.kind === 'terminal' ? 'terminal' : 'chat';
    const summary: ChatSummary = {
      id,
      title: typeof row.title === 'string' && row.title.trim() !== '' ? row.title : defaultChatTitle(kind),
      kind,
      createdAt,
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : createdAt,
    };
    // Carried through rather than defaulted: an index written by an older
    // build simply has no thread to remember.
    if (typeof row.codexThreadId === 'string' && row.codexThreadId !== '') summary.codexThreadId = row.codexThreadId;
    out.push(summary);
  }
  return sortChats(out);
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

async function readIndexUnlocked(root: string): Promise<ChatSummary[]> {
  try {
    return parseChatIndex(JSON.parse(await fsp.readFile(chatIndexPath(root), 'utf8')));
  } catch {
    return []; // absent (a project that has never been talked to) or unreadable
  }
}

async function writeIndexUnlocked(root: string, chats: ChatSummary[]): Promise<void> {
  const file = chatIndexPath(root);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(sortChats(chats), null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Every conversation this project has, newest activity first. */
export function listChats(root: string): Promise<ChatSummary[]> {
  return serialize(root, () => readIndexUnlocked(root));
}

/**
 * Start a conversation. It is listed immediately, and a chat is named on its
 * first turn.
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
    const chat: ChatSummary = {
      id: randomUUID(),
      title: named === '' ? defaultChatTitle(kind) : named,
      kind,
      createdAt: now,
      updatedAt: now,
    };
    await writeIndexUnlocked(root, [chat, ...(await readIndexUnlocked(root))]);
    // Touch the transcript so an opened-but-silent chat reads back as empty
    // rather than missing.
    await fsp.writeFile(chatFilePath(root, chat.id), '', { flag: 'a' });
    return chat;
  });
}

/**
 * Append one record and bump the chat's `updatedAt`. The first user message
 * also names an as-yet-unnamed chat — which is the whole titling rule.
 * Returns the chat's summary after the write, or null when it is unknown.
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
    const next: ChatSummary = { ...chats[index], updatedAt: record.ts };
    if (record.role === 'user' && next.kind === 'chat' && next.title === UNTITLED) {
      next.title = userRecordTitle(record);
    }
    chats[index] = next;
    await writeIndexUnlocked(root, chats);
    return next;
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
    return chats[index];
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
    return chats[index];
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
