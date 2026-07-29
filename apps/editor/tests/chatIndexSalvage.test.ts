/**
 * The two ways the index recovery could still lose a conversation.
 *
 * Recovery exists because a torn `.hearth/chats/index.json` used to read as "no
 * chats" and get written over. These pin the parts of it that turned out to have
 * the same shape as the bug they were added to fix:
 *
 *  - A read that could not see the whole folder answers with what it salvaged,
 *    which is right for a LISTING and catastrophic as the basis of a WRITE.
 *    Every write path here is read-mutate-write, so a partial answer that
 *    reaches one is persisted as the whole truth, and because the result parses
 *    the folder rebuild never runs again.
 *  - The salvage scanner tracked string state across the whole document, so one
 *    unbalanced `"` inverted its idea of where strings were and it found no rows
 *    at all in a file full of them. A terminal session keeps no transcript, so
 *    the folder rebuild cannot see it: its row is the only evidence it exists.
 *
 * Kept out of chatStore.test.ts so the two files can be worked on separately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendChatRecord,
  chatIndexPath,
  createChat,
  deleteChat,
  listChats,
  markChatUsed,
  prunePendingChats,
  renameChat,
  setChatThreadId,
} from '../server/chatStore';

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-salvage-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(root, { recursive: true, force: true });
});

/** A folder that cannot be read right now, which says nothing about what is in it. */
function emfile(): NodeJS.ErrnoException {
  return Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
}

/** Four conversations, each with a message in it so each one is listed. */
async function fourConversations(): Promise<string[]> {
  const ids: string[] = [];
  for (let n = 1; n <= 4; n += 1) {
    const chat = await createChat(root);
    await appendChatRecord(root, chat.id, {
      role: 'user',
      ts: `2026-01-0${n}T00:00:00.000Z`,
      text: `conversation ${n}`,
    });
    ids.push(chat.id);
  }
  return ids;
}

/**
 * Tear the index so only the first `keep` rows survive whole, exactly as a kill
 * partway through a rewrite leaves it: the front of the file, then nothing.
 */
async function tearAfter(keep: number): Promise<string> {
  const whole = await fsp.readFile(chatIndexPath(root), 'utf8');
  const starts = [...whole.matchAll(/\n {2}\{/g)].map((match) => match.index ?? 0);
  const torn = `${whole.slice(0, starts[keep])}\n  {\n    "id": "0f`;
  await fsp.writeFile(chatIndexPath(root), torn, 'utf8');
  return torn;
}

describe('a torn index read while the folder cannot be listed', () => {
  it('answers a listing with the salvage and refuses to write it back', async () => {
    const made = await fourConversations();
    const torn = await tearAfter(2);

    const readdir = vi.spyOn(fsp, 'readdir').mockRejectedValue(emfile());
    // Half the listing, which is the honest answer to "what can you see".
    expect(await listChats(root)).toHaveLength(2);
    // And a new conversation started while the folder is still unreadable must
    // not persist that half as the whole index. It used to, and because the
    // result parsed, the folder rebuild never ran again: the other two
    // conversations were unreachable for good, with their transcripts sitting
    // in the same folder.
    await expect(createChat(root)).rejects.toThrow(/could not be read/i);
    expect(await fsp.readFile(chatIndexPath(root), 'utf8')).toBe(torn);
    readdir.mockRestore();

    // The machine recovers, and nothing was lost: the folder is still the truth
    // about which conversations exist.
    expect((await listChats(root)).map((chat) => chat.id).sort()).toEqual([...made].sort());
  });

  it('refuses every other write that would shrink the listing', async () => {
    const made = await fourConversations();
    const torn = await tearAfter(2);
    const readdir = vi.spyOn(fsp, 'readdir').mockRejectedValue(emfile());

    await expect(renameChat(root, made[3], 'renamed')).rejects.toThrow(/could not be read/i);
    await expect(setChatThreadId(root, made[3], 'thread-1')).rejects.toThrow(/could not be read/i);
    await expect(deleteChat(root, made[3])).rejects.toThrow(/could not be read/i);
    // A sweep of rows nobody spoke into has nothing to sweep either: it cannot
    // tell an unused row from one it simply did not see.
    expect(await prunePendingChats(root, { ttlMs: 0 })).toEqual([]);
    expect(await fsp.readFile(chatIndexPath(root), 'utf8')).toBe(torn);
    readdir.mockRestore();

    expect((await listChats(root)).map((chat) => chat.id).sort()).toEqual([...made].sort());
  });

  it('still writes the transcript line, which is the record, without rewriting the listing', async () => {
    const made = await fourConversations();
    const torn = await tearAfter(2);
    const readdir = vi.spyOn(fsp, 'readdir').mockRejectedValue(emfile());

    // The row for this one IS in the salvage, so the append knows where the
    // words go. Appending never destroys anything; rewriting the index would.
    const stored = await appendChatRecord(root, made[3], {
      role: 'user',
      ts: '2026-02-01T00:00:00.000Z',
      text: 'still talking',
    });
    expect(stored?.id).toBe(made[3]);
    expect(await fsp.readFile(chatIndexPath(root), 'utf8')).toBe(torn);
    readdir.mockRestore();

    const listed = await listChats(root);
    expect(listed.map((chat) => chat.id).sort()).toEqual([...made].sort());
  });
});

describe('a torn index with one unbalanced quote in it', () => {
  it('keeps the terminal session and the codex thread the rows are the only record of', async () => {
    const terminal = await createChat(root, { kind: 'terminal', title: 'my shell' });
    // Used, so it is a session someone had rather than a shell they glanced at.
    // A terminal is pending until its first keystroke; salvage has to carry a
    // real one through, which is what this is here to prove.
    await markChatUsed(root, terminal.id);
    const chat = await createChat(root);
    await appendChatRecord(root, chat.id, { role: 'user', ts: '2026-01-01T00:00:00.000Z', text: 'hello there' });
    await setChatThreadId(root, chat.id, 'thread-abc-123');

    // One stray `"` ahead of every row. A scanner carrying string state across
    // the whole document reads every following quote inverted, so it finds no
    // object at all and the salvage comes back empty. The terminal has an empty
    // transcript and always will, so an empty salvage deletes it.
    const whole = await fsp.readFile(chatIndexPath(root), 'utf8');
    await fsp.writeFile(chatIndexPath(root), whole.replace('[\n', '[\n  "\n'), 'utf8');

    const listed = await listChats(root);
    expect(listed.find((row) => row.id === terminal.id)).toMatchObject({ kind: 'terminal', title: 'my shell' });
    expect(listed.find((row) => row.id === chat.id)).toMatchObject({
      kind: 'chat',
      title: 'hello there',
      codexThreadId: 'thread-abc-123',
    });
  });

  it('loses only the row the damage is inside', async () => {
    const first = await createChat(root, { kind: 'terminal', title: 'first shell' });
    const second = await createChat(root, { kind: 'terminal', title: 'second shell' });
    await markChatUsed(root, first.id);
    await markChatUsed(root, second.id);

    const whole = await fsp.readFile(chatIndexPath(root), 'utf8');
    // Whichever row the file happens to hold second: the damage below lands in
    // the first one, and this is the one that must not go down with it.
    const survivor = whole.indexOf(first.id) < whole.indexOf(second.id) ? second : first;
    // An extra quote inside the first row, so that row cannot parse and its
    // braces stop balancing. Read as one document, that took the rest of the
    // file with it.
    await fsp.writeFile(chatIndexPath(root), whole.replace('"kind"', '"ki"nd"'), 'utf8');

    const listed = await listChats(root);
    expect(listed.map((row) => row.id)).toEqual([survivor.id]);
    expect(listed[0]).toMatchObject({ kind: 'terminal', title: survivor.title });
  });
});
