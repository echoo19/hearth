/**
 * Conversations, on disk.
 *
 * A conversation is the app's primary artifact — it is what the user actually
 * made — so it outlives the process that streamed it. Layout, relative to a
 * project root:
 *
 *   .hearth/chats/
 *     index.json          — [{ id, title, createdAt, updatedAt }], newest first
 *     <chatId>.jsonl      — one JSON line per turn/tool event
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

/** Relative location of the chat directory within a project. */
export const CHATS_DIR = path.join('.hearth', 'chats');

/** How much of the first user message becomes the conversation's name. */
export const TITLE_MAX = 60;

/** The default name a chat carries until its first user message names it. */
export const UNTITLED = 'New chat';

/** One conversation, as the sidebar lists it. */
export interface ChatSummary {
  id: string;
  title: string;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
}

/** One line of a transcript. */
export type ChatRecord =
  | { role: 'user'; ts: string; text: string }
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
      out.push({ role: 'user', ts, text: (record as { text: string }).text });
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
    out.push({
      id,
      title: typeof row.title === 'string' && row.title.trim() !== '' ? row.title : UNTITLED,
      createdAt,
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : createdAt,
    });
  }
  return sortChats(out);
}

/** Newest activity first; ties break on id so the order is stable. */
export function sortChats(chats: ChatSummary[]): ChatSummary[] {
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

/** Start a conversation. It is listed immediately, named on its first turn. */
export function createChat(root: string, title = UNTITLED): Promise<ChatSummary> {
  return serialize(root, async () => {
    const now = new Date().toISOString();
    const chat: ChatSummary = { id: randomUUID(), title, createdAt: now, updatedAt: now };
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
    const next: ChatSummary = { ...chats[index], updatedAt: record.ts };
    if (record.role === 'user' && next.title === UNTITLED) next.title = chatTitleFrom(record.text);
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
