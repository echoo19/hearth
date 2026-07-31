/**
 * Conversations on disk: `.hearth/chats/index.json` + one jsonl per chat.
 *
 * The rules under test are the ones a user would notice breaking: a chat is
 * named by what was first asked of it, the index tracks activity, a transcript
 * survives a restart intact, and nothing a client sends can write outside the
 * chats directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CORRUPT_INDEX_SUFFIX,
  PENDING_TTL_MS,
  UNTITLED,
  appendChatRecord,
  chatFilePath,
  chatIndexPath,
  chatTitleFrom,
  createChat,
  defaultChatTitle,
  deleteChat,
  getChat,
  listChats,
  markChatUsed,
  parseChatIndex,
  parseTranscript,
  prunePendingChats,
  readTranscript,
  renameChat,
  safeChatId,
  setChatProvider,
  setChatThreadId,
  sortChats,
} from '../server/chatStore';

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-chatstore-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

/** Every copy of an unreadable index the store has kept, oldest name first. */
async function keptCorruptIndexes(): Promise<string[]> {
  const dir = path.dirname(chatIndexPath(root));
  const names = await fsp.readdir(dir).catch((): string[] => []);
  return names
    .filter((name) => name.endsWith(CORRUPT_INDEX_SUFFIX))
    .sort()
    .map((name) => path.join(dir, name));
}

describe('chatTitleFrom', () => {
  it('names a chat after the first thing asked of it', () => {
    expect(chatTitleFrom('make a top-down shooter')).toBe('make a top-down shooter');
  });

  it('collapses whitespace so a pasted paragraph is still one line', () => {
    expect(chatTitleFrom('  make   a\n  shooter ')).toBe('make a shooter');
  });

  it('falls back rather than naming a chat with nothing', () => {
    expect(chatTitleFrom('   \n ')).toBe(UNTITLED);
  });

  it('truncates on a word boundary near the limit', () => {
    const title = chatTitleFrom('build me a sprawling roguelike with procedural dungeons and permadeath please');
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });

  it('still truncates when one word runs past the limit', () => {
    const title = chatTitleFrom('x'.repeat(200));
    expect(title).toBe(`${'x'.repeat(60)}…`);
  });
});

describe('safeChatId', () => {
  it('accepts the ids the store mints', () => {
    expect(safeChatId('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe('0f8fad5b-d9cb-469f-a165-70867728950e');
  });

  it('refuses anything that could name a file outside the chats directory', () => {
    for (const bad of ['../secrets', 'a/b', '.hidden', '', '   ', 'a b', 'a\u0000b']) {
      expect(safeChatId(bad)).toBeNull();
    }
    expect(safeChatId(42)).toBeNull();
  });
});

describe('parseTranscript', () => {
  it('reads both record shapes and skips what it cannot use', () => {
    const text = [
      JSON.stringify({ role: 'user', ts: 't1', text: 'hi' }),
      '',
      '{"role":"agent","ts":"t2","event":{"type":"text-delta","text":"yo"}}',
      '{"role":"agent","ts":"t3"}', // no event
      '{"role":"nobody","ts":"t4"}',
      '{"role":"user","ts":"t5"', // half-written trailing line
    ].join('\n');
    expect(parseTranscript(text)).toEqual([
      { role: 'user', ts: 't1', text: 'hi' },
      { role: 'agent', ts: 't2', event: { type: 'text-delta', text: 'yo' } },
    ]);
  });
});

describe('parseChatIndex / sortChats', () => {
  it('drops rows it cannot trust rather than failing the whole list', () => {
    const chats = parseChatIndex([
      { id: 'a', title: 'A', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: '../escape', title: 'nope' },
      'not an object',
    ]);
    expect(chats.map((chat) => chat.id)).toEqual(['a']);
  });

  it('orders newest activity first', () => {
    const chats = sortChats([
      { id: 'old', title: 'old', createdAt: 'x', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'new', title: 'new', createdAt: 'x', updatedAt: '2026-02-01T00:00:00.000Z' },
    ]);
    expect(chats.map((chat) => chat.id)).toEqual(['new', 'old']);
  });
});

describe('the store on disk', () => {
  it('creates an untitled chat with an empty transcript', async () => {
    const chat = await createChat(root);
    expect(chat.title).toBe(UNTITLED);
    expect(await getChat(root, chat.id)).toEqual(chat);
    expect(await readTranscript(root, chat.id)).toEqual([]);
    await expect(fsp.readFile(chatFilePath(root, chat.id), 'utf8')).resolves.toBe('');
  });

  it('names the chat from its first user message, and only that one', async () => {
    const chat = await createChat(root);
    await appendChatRecord(root, chat.id, { role: 'user', ts: 't1', text: 'make a shooter' });
    await appendChatRecord(root, chat.id, { role: 'user', ts: 't2', text: 'now add asteroids' });
    const [listed] = await listChats(root);
    expect(listed.title).toBe('make a shooter');
    expect(listed.updatedAt).toBe('t2');
  });

  it('replays a transcript in the order it was written', async () => {
    const chat = await createChat(root);
    await appendChatRecord(root, chat.id, { role: 'user', ts: 't1', text: 'hi' });
    await appendChatRecord(root, chat.id, { role: 'agent', ts: 't2', event: { type: 'text-delta', text: 'Buil' } });
    await appendChatRecord(root, chat.id, { role: 'agent', ts: 't3', event: { type: 'text-delta', text: 'ding.' } });
    await appendChatRecord(root, chat.id, {
      role: 'agent',
      ts: 't4',
      event: { type: 'tool-start', id: 'x', name: 'Write', detail: '/g/game.js' },
    });
    await appendChatRecord(root, chat.id, { role: 'agent', ts: 't5', event: { type: 'done' } });

    expect(await readTranscript(root, chat.id)).toEqual([
      { role: 'user', ts: 't1', text: 'hi' },
      { role: 'agent', ts: 't2', event: { type: 'text-delta', text: 'Buil' } },
      { role: 'agent', ts: 't3', event: { type: 'text-delta', text: 'ding.' } },
      { role: 'agent', ts: 't4', event: { type: 'tool-start', id: 'x', name: 'Write', detail: '/g/game.js' } },
      { role: 'agent', ts: 't5', event: { type: 'done' } },
    ]);
  });

  it('keeps every line when a whole turn streams at once', async () => {
    const chat = await createChat(root);
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        appendChatRecord(root, chat.id, {
          role: 'agent',
          ts: `t${i}`,
          event: { type: 'text-delta', text: String(i) },
        }),
      ),
    );
    const records = await readTranscript(root, chat.id);
    expect(records).toHaveLength(60);
    // Serialized writes: no line may be spliced into another.
    const raw = await fsp.readFile(chatFilePath(root, chat.id), 'utf8');
    expect(raw.split('\n').filter((line) => line.trim() !== '')).toHaveLength(60);
  });

  it('refuses to append to a chat that is not in the index', async () => {
    expect(await appendChatRecord(root, 'unknown-id', { role: 'user', ts: 't', text: 'hi' })).toBeNull();
    expect(await appendChatRecord(root, '../escape', { role: 'user', ts: 't', text: 'hi' })).toBeNull();
  });

  it('renames a chat without touching its transcript', async () => {
    const chat = await createChat(root);
    await appendChatRecord(root, chat.id, { role: 'user', ts: 't1', text: 'hi' });
    const renamed = await renameChat(root, chat.id, '  Asteroids   prototype ');
    expect(renamed?.title).toBe('Asteroids prototype');
    expect((await listChats(root))[0].title).toBe('Asteroids prototype');
    expect(await readTranscript(root, chat.id)).toHaveLength(1);
  });

  it('refuses an empty rename and an unknown chat', async () => {
    const chat = await createChat(root);
    expect(await renameChat(root, chat.id, '   ')).toBeNull();
    expect(await renameChat(root, 'nope', 'x')).toBeNull();
  });

  it('deletes the index entry and the transcript together', async () => {
    const chat = await createChat(root);
    await appendChatRecord(root, chat.id, { role: 'user', ts: 't1', text: 'hi' });
    expect(await deleteChat(root, chat.id)).toBe(true);
    expect(await listChats(root)).toEqual([]);
    await expect(fsp.stat(chatFilePath(root, chat.id))).rejects.toThrow();
    expect(await deleteChat(root, chat.id)).toBe(false);
  });

  it('survives a corrupt index rather than losing the app', async () => {
    await fsp.mkdir(path.dirname(chatIndexPath(root)), { recursive: true });
    await fsp.writeFile(chatIndexPath(root), '{ not json');
    expect(await listChats(root)).toEqual([]);
    const chat = await createChat(root);
    await appendChatRecord(root, chat.id, { role: 'user', ts: 't1', text: 'hi' });
    expect((await listChats(root)).map((listed) => listed.id)).toEqual([chat.id]);
  });

  it('lists nothing for a folder that has never been talked to', async () => {
    expect(await listChats(root)).toEqual([]);
    expect(await readTranscript(root, 'whatever')).toEqual([]);
  });
});

/**
 * Transcript compatibility across the vocabulary change.
 *
 * The extended event union is ADDITIVE: chats written before it exists hold
 * `text-delta` / `tool-start` / `tool-end{id,ok}` / `done` lines, and those
 * files are never rewritten. Replay must therefore keep accepting them
 * verbatim — a user's history is the one thing in this app that must not be
 * lost to a refactor.
 */
describe('transcript vocabulary compatibility', () => {
  it('replays a transcript written by the OLD build, untouched', () => {
    const legacy = [
      '{"role":"user","ts":"t0","text":"make a shooter"}',
      '{"role":"agent","ts":"t1","event":{"type":"text-delta","text":"Building."}}',
      '{"role":"agent","ts":"t2","event":{"type":"tool-start","id":"t1","name":"Write","detail":"/w/game.js"}}',
      '{"role":"agent","ts":"t3","event":{"type":"tool-end","id":"t1","ok":true}}',
      '{"role":"agent","ts":"t4","event":{"type":"done"}}',
    ].join('\n');
    const records = parseTranscript(legacy);
    expect(records).toHaveLength(5);
    expect(records[1]).toEqual({ role: 'agent', ts: 't1', event: { type: 'text-delta', text: 'Building.' } });
    expect(records[4]).toEqual({ role: 'agent', ts: 't4', event: { type: 'done' } });
  });

  it('replays the extended vocabulary, including a mixed old/new file', () => {
    const mixed = [
      '{"role":"user","ts":"t0","text":"go"}',
      // written by the old build...
      '{"role":"agent","ts":"t1","event":{"type":"text-delta","text":"old"}}',
      // ...and everything after it by the new one.
      '{"role":"agent","ts":"t2","event":{"type":"message-delta","text":"new"}}',
      '{"role":"agent","ts":"t3","event":{"type":"reasoning-delta","text":"hmm"}}',
      '{"role":"agent","ts":"t4","event":{"type":"tool-begin","toolId":"c1","kind":"command","title":"npm test"}}',
      '{"role":"agent","ts":"t5","event":{"type":"tool-output-delta","toolId":"c1","chunk":"PASS"}}',
      '{"role":"agent","ts":"t6","event":{"type":"tool-end","toolId":"c1","status":"ok","exitCode":0}}',
      '{"role":"agent","ts":"t7","event":{"type":"file-change","toolId":"f1","files":[{"path":"a.js","kind":"edit"}]}}',
      '{"role":"agent","ts":"t8","event":{"type":"approval-request","approvalId":"a1","kind":"command","title":"Run?","detail":"rm"}}',
      '{"role":"agent","ts":"t9","event":{"type":"approval-resolved","approvalId":"a1","decision":"deny"}}',
      '{"role":"agent","ts":"t10","event":{"type":"subagent-start","agentId":"s1","title":"Explore"}}',
      '{"role":"agent","ts":"t11","event":{"type":"subagent-end","agentId":"s1","status":"ok"}}',
      '{"role":"agent","ts":"t12","event":{"type":"turn-complete"}}',
    ].join('\n');
    const records = parseTranscript(mixed);
    expect(records).toHaveLength(13);
    expect(records.map((r) => (r.role === 'agent' ? r.event.type : 'user'))).toEqual([
      'user',
      'text-delta',
      'message-delta',
      'reasoning-delta',
      'tool-begin',
      'tool-output-delta',
      'tool-end',
      'file-change',
      'approval-request',
      'approval-resolved',
      'subagent-start',
      'subagent-end',
      'turn-complete',
    ]);
  });

  it('keeps an event kind it has never seen, rather than dropping the line', () => {
    // A transcript written by a NEWER build must not lose turns when opened
    // here; the renderer ignores what it can't draw.
    const records = parseTranscript('{"role":"agent","ts":"t1","event":{"type":"hologram","x":1}}');
    expect(records).toHaveLength(1);
  });
});

/**
 * A conversation exists from the moment a window needs somewhere to send, and
 * that is not the moment it becomes something a person would recognise. These
 * pin the difference: the sidebar shows what was said, not what was opened.
 */
describe('a chat nobody has spoken into', () => {
  it('is not in the list, but is still open-able by the window sitting in it', async () => {
    const chat = await createChat(root);
    expect(await listChats(root)).toEqual([]);
    expect((await getChat(root, chat.id))?.id).toBe(chat.id);
  });

  it('appears, named by the message, the moment one is sent', async () => {
    const chat = await createChat(root);
    const after = await appendChatRecord(root, chat.id, { role: 'user', ts: 't1', text: 'make a shooter' });
    expect(after?.title).toBe('make a shooter');
    const listed = await listChats(root);
    expect(listed.map((row) => row.id)).toEqual([chat.id]);
    expect(listed[0].title).toBe('make a shooter');
  });

  it('stays hidden while only the agent has said anything', async () => {
    // A driver can emit before the user's own line has landed. A chat turning
    // up in the sidebar with nothing anyone typed in it is the thing the rule
    // exists to prevent, so an agent record alone must not reveal it.
    const chat = await createChat(root);
    await appendChatRecord(root, chat.id, { role: 'agent', ts: 't1', event: { type: 'text-delta', text: 'hi' } });
    expect(await listChats(root)).toEqual([]);
  });

  it('stays out of the list when the flag was lost with the index it was written in', async () => {
    // The recovery path used to clear `pending` for any transcript with a line
    // in it, so a chat the driver had spoken into first came back listed with
    // nothing anybody typed in it. The rule is the same one appendChatRecord
    // follows: a USER record is what makes a conversation.
    const chat = await createChat(root);
    await appendChatRecord(root, chat.id, { role: 'agent', ts: 't1', event: { type: 'text-delta', text: 'hi' } });
    const whole = await fsp.readFile(chatIndexPath(root), 'utf8');
    await fsp.writeFile(chatIndexPath(root), whole.slice(0, whole.lastIndexOf(']')), 'utf8');
    expect(await listChats(root)).toEqual([]);
  });

  it('is left out even when the row predates the flag entirely', async () => {
    // What is actually on disk in projects made before pending existed: a row
    // with no flag at all, its default name, and a transcript of nothing. The
    // filter reads a missing flag as "not pending", so these are the rows the
    // rail shows as "New chat" for good. Nobody ever sent anything, so nobody
    // should ever see them.
    await fsp.mkdir(path.dirname(chatIndexPath(root)), { recursive: true });
    const ghost = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      title: defaultChatTitle('chat'),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await fsp.writeFile(chatIndexPath(root), JSON.stringify([ghost]), 'utf8');
    await fsp.writeFile(chatFilePath(root, ghost.id), '', 'utf8');
    expect(await listChats(root)).toEqual([]);
    // Still openable by id, exactly like a pending row: a window sitting in it
    // has to keep working.
    expect((await getChat(root, ghost.id))?.id).toBe(ghost.id);
  });

  it('does not hide an old row that was spoken into', async () => {
    // The other half of the rule above. A conversation with a message in it is
    // listed whatever its index says about flags, including nothing at all.
    await fsp.mkdir(path.dirname(chatIndexPath(root)), { recursive: true });
    const old = {
      id: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee',
      title: defaultChatTitle('chat'),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await fsp.writeFile(chatIndexPath(root), JSON.stringify([old]), 'utf8');
    await fsp.writeFile(
      chatFilePath(root, old.id),
      `${JSON.stringify({ role: 'user', ts: '2026-01-01T00:00:00.000Z', text: 'hello' })}\n`,
      'utf8',
    );
    expect((await listChats(root)).map((row) => row.id)).toEqual([old.id]);
  });

  it('is the same for a terminal, which is a session only once it is typed into', async () => {
    // This used to assert the opposite, on the grounds that a terminal's shell
    // is running the moment the record exists. True, and beside the point:
    // opening a terminal and looking at the prompt is the same act as opening
    // a chat and not typing, and it left a row in the rail every time.
    const terminal = await createChat(root, { kind: 'terminal', title: 'Claude Code' });
    expect(await listChats(root)).toEqual([]);
    // A title does not make it real either. A terminal is named after the CLI
    // Hearth is about to type, which is decided before anything has happened.
    expect(await markChatUsed(root, terminal.id)).toBe(true);
    expect((await listChats(root)).map((row) => row.id)).toEqual([terminal.id]);
    // Idempotent: every keystroke after the first calls this and does nothing.
    expect(await markChatUsed(root, terminal.id)).toBe(false);
    expect((await listChats(root)).map((row) => row.id)).toEqual([terminal.id]);
  });

  it('answers false for a conversation that is not there, rather than throwing', async () => {
    // Called from a keystroke handler: a terminal whose conversation was
    // deleted in another window must not fail the key.
    expect(await markChatUsed(root, 'de1e7ed0-0000-4000-8000-000000000000')).toBe(false);
  });

  it('never carries the flag out of the store, so nothing else has to know', async () => {
    const chat = await createChat(root);
    expect(Object.hasOwn(chat, 'pending')).toBe(false);
    expect(Object.hasOwn((await getChat(root, chat.id)) ?? {}, 'pending')).toBe(false);
    const after = await appendChatRecord(root, chat.id, { role: 'user', ts: 't1', text: 'hi' });
    expect(Object.hasOwn(after ?? {}, 'pending')).toBe(false);
  });

  it('keeps its kind, its name and its thread when the flag goes', async () => {
    const chat = await createChat(root);
    await setChatThreadId(root, chat.id, 'thread-abc');
    await appendChatRecord(root, chat.id, { role: 'user', ts: 't1', text: 'make a shooter' });
    const [listed] = await listChats(root);
    expect(listed).toEqual({
      id: chat.id,
      title: 'make a shooter',
      kind: 'chat',
      createdAt: chat.createdAt,
      updatedAt: 't1',
      codexThreadId: 'thread-abc',
    });
  });
});

/**
 * Every index on disk was written before any of this existed, and a row with
 * no flag means a conversation someone had. Nothing may disappear for it.
 */
describe('an index written by an older build', () => {
  it('lists a row that says nothing about pending', async () => {
    await fsp.mkdir(path.dirname(chatIndexPath(root)), { recursive: true });
    await fsp.writeFile(
      chatIndexPath(root),
      JSON.stringify([
        { id: 'legacy', title: 'Ember opening', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' },
      ]),
      'utf8',
    );
    expect((await listChats(root)).map((row) => row.id)).toEqual(['legacy']);
    // Old enough for any sweep, and untouchable: it is not pending.
    expect(await prunePendingChats(root, { ttlMs: 0 })).toEqual([]);
    expect((await listChats(root)).map((row) => row.id)).toEqual(['legacy']);
  });

  it('reads pending: false as a conversation, not as a flag to carry', () => {
    const [parsed] = parseChatIndex([{ id: 'a', title: 'A', createdAt: 't', updatedAt: 't', pending: false }]);
    expect(parsed.id).toBe('a');
    expect(Object.hasOwn(parsed, 'pending')).toBe(false);
  });
});

describe('pruning conversations that were never used', () => {
  it('forgets a pending chat once it is older than the ttl, transcript and all', async () => {
    const chat = await createChat(root);
    expect(await prunePendingChats(root, { now: Date.now() + PENDING_TTL_MS + 1000 })).toEqual([chat.id]);
    expect(await getChat(root, chat.id)).toBeNull();
    await expect(fsp.stat(chatFilePath(root, chat.id))).rejects.toThrow();
  });

  it('leaves one a window is still sitting in, however old it is', async () => {
    const chat = await createChat(root);
    const kept = await prunePendingChats(root, { keepIds: [chat.id], now: Date.now() + PENDING_TTL_MS * 100 });
    expect(kept).toEqual([]);
    expect((await getChat(root, chat.id))?.id).toBe(chat.id);
  });

  it('leaves a young one alone: it is the chat the window it was made for is in', async () => {
    const chat = await createChat(root);
    expect(await prunePendingChats(root)).toEqual([]);
    expect((await getChat(root, chat.id))?.id).toBe(chat.id);
  });

  it('never takes a conversation that was spoken into', async () => {
    const chat = await createChat(root);
    await appendChatRecord(root, chat.id, { role: 'user', ts: 't1', text: 'make a shooter' });
    expect(await prunePendingChats(root, { ttlMs: 0 })).toEqual([]);
    expect((await listChats(root)).map((row) => row.id)).toEqual([chat.id]);
  });

  it('refuses to date a row it cannot read, rather than deleting on a guess', async () => {
    const chat = await createChat(root);
    const raw = JSON.parse(await fsp.readFile(chatIndexPath(root), 'utf8')) as { createdAt: string }[];
    raw[0].createdAt = 'whenever';
    await fsp.writeFile(chatIndexPath(root), JSON.stringify(raw), 'utf8');
    expect(await prunePendingChats(root, { ttlMs: 0 })).toEqual([]);
    expect((await getChat(root, chat.id))?.id).toBe(chat.id);
  });
});

describe('codex thread binding', () => {
  it('remembers a thread against a chat, and survives a reload', async () => {
    const chat = await createChat(root);
    expect(chat.codexThreadId).toBeUndefined();
    await setChatThreadId(root, chat.id, 'thread-abc');
    const reloaded = await getChat(root, chat.id);
    expect(reloaded?.codexThreadId).toBe('thread-abc');
  });

  it('does not count binding a backend as conversation activity', async () => {
    const chat = await createChat(root);
    await setChatThreadId(root, chat.id, 'thread-abc');
    const reloaded = await getChat(root, chat.id);
    // Bumping updatedAt here would reorder the sidebar for something the user
    // never did.
    expect(reloaded?.updatedAt).toBe(chat.updatedAt);
  });

  it('refuses an unknown chat and an unsafe id', async () => {
    expect(await setChatThreadId(root, 'nope', 'thread-abc')).toBeNull();
    expect(await setChatThreadId(root, '../escape', 'thread-abc')).toBeNull();
  });

  it('carries an index written without a thread through unchanged', () => {
    const parsed = parseChatIndex([{ id: 'a', title: 'x', createdAt: 't', updatedAt: 't' }]);
    expect(parsed[0].codexThreadId).toBeUndefined();
  });
});

describe('last provider binding', () => {
  it('remembers the provider without moving conversation activity', async () => {
    const chat = await createChat(root);
    expect(chat.lastProvider).toBeUndefined();
    await setChatProvider(root, chat.id, 'anthropic');
    expect(await getChat(root, chat.id)).toMatchObject({
      lastProvider: 'anthropic',
      updatedAt: chat.updatedAt,
    });
    await setChatProvider(root, chat.id, 'openai');
    expect((await getChat(root, chat.id))?.lastProvider).toBe('openai');
  });

  it('ignores absent legacy metadata and refuses unsafe ids', async () => {
    expect(parseChatIndex([{ id: 'a', title: 'x', createdAt: 't', updatedAt: 't' }])[0].lastProvider).toBeUndefined();
    expect(await setChatProvider(root, '../escape', 'anthropic')).toBeNull();
  });
});

/**
 * The index is a listing. The transcripts are the record.
 *
 * index.json used to be written with a bare truncating `writeFile`, on EVERY
 * streamed agent event, which is a few times a second for the one file that
 * says which conversations exist. A kill inside any of those left invalid JSON,
 * the read caught the parse error and answered "no chats", and the next
 * `createChat` wrote a single row over the wreck: every conversation the person
 * had ever had, gone without a word, while the `.jsonl` files holding them sat
 * in the same folder. Both halves are fixed here, and both are load-bearing.
 */
describe('an index.json that was torn in half', () => {
  it('rebuilds the conversations from the transcripts beside it', async () => {
    const first = await createChat(root);
    await appendChatRecord(root, first.id, { role: 'user', ts: '2026-01-01T00:00:00.000Z', text: 'make a shooter' });
    await appendChatRecord(root, first.id, {
      role: 'agent',
      ts: '2026-01-01T00:00:09.000Z',
      event: { type: 'turn-complete' },
    });
    const second = await createChat(root);
    await appendChatRecord(root, second.id, { role: 'user', ts: '2026-01-02T00:00:00.000Z', text: 'now a platformer' });

    // Exactly what a kill mid-write leaves: the front of a rewrite.
    const whole = await fsp.readFile(chatIndexPath(root), 'utf8');
    await fsp.writeFile(chatIndexPath(root), whole.slice(0, Math.floor(whole.length / 2)), 'utf8');

    const listed = await listChats(root);
    expect(listed.map((chat) => chat.title)).toEqual(['now a platformer', 'make a shooter']);
    expect(listed.map((chat) => chat.id).sort()).toEqual([first.id, second.id].sort());
    // Recovered by name AND by content: the conversations are still openable.
    expect(await readTranscript(root, first.id)).toHaveLength(2);

    // And a chat started afterwards joins them rather than replacing them.
    const third = await createChat(root, { title: 'a third' });
    expect((await listChats(root)).map((chat) => chat.id).sort()).toEqual(
      [first.id, second.id, third.id].sort(),
    );
  });

  it('keeps the unreadable file instead of deleting it', async () => {
    const chat = await createChat(root);
    await appendChatRecord(root, chat.id, { role: 'user', ts: '2026-01-01T00:00:00.000Z', text: 'hi' });
    await fsp.writeFile(chatIndexPath(root), '[{"id":"broke', 'utf8');
    await listChats(root);
    const kept = await keptCorruptIndexes();
    expect(kept).toHaveLength(1);
    await expect(fsp.readFile(kept[0], 'utf8')).resolves.toBe('[{"id":"broke');
    // Named for when it was found, so the next failure cannot land on it.
    expect(path.basename(kept[0])).toMatch(/^index\.json\.\d{4}-\d{2}-\d{2}T[\d-]+Z\.corrupt$/);
  });

  it('keeps EVERY unreadable file, so a second failure is not the end of the first', async () => {
    const chat = await createChat(root);
    await appendChatRecord(root, chat.id, { role: 'user', ts: '2026-01-01T00:00:00.000Z', text: 'hi' });
    // The one that cost something: the whole listing, torn.
    await fsp.writeFile(chatIndexPath(root), '[{"id":"the original wreck', 'utf8');
    await listChats(root);
    // And a second failure some time later, holding far less.
    await fsp.writeFile(chatIndexPath(root), 'garbage', 'utf8');
    await listChats(root);

    const kept = await keptCorruptIndexes();
    expect(kept).toHaveLength(2);
    const bodies = await Promise.all(kept.map((file) => fsp.readFile(file, 'utf8')));
    expect(bodies.sort()).toEqual(['[{"id":"the original wreck', 'garbage'].sort());
  });

  it('rebuilds a terminal session and a codex thread, which no transcript holds', async () => {
    const terminal = await createChat(root, { kind: 'terminal', title: 'my shell' });
    await markChatUsed(root, terminal.id);
    const chat = await createChat(root);
    await appendChatRecord(root, chat.id, { role: 'user', ts: '2026-01-01T00:00:00.000Z', text: 'hello there' });
    await setChatThreadId(root, chat.id, 'thread-abc-123');

    // Truncated: the rows are all there, the document is not.
    const whole = await fsp.readFile(chatIndexPath(root), 'utf8');
    await fsp.writeFile(chatIndexPath(root), whole.slice(0, whole.lastIndexOf(']')), 'utf8');

    const listed = await listChats(root);
    const shell = listed.find((row) => row.id === terminal.id);
    // The terminal is still there, still a terminal, still called what it was
    // called. It has an empty transcript and always will: recovering it from
    // one is impossible, so the row is where it has to come from.
    expect(shell).toMatchObject({ kind: 'terminal', title: 'my shell' });
    expect(listed.find((row) => row.id === chat.id)).toMatchObject({
      kind: 'chat',
      title: 'hello there',
      codexThreadId: 'thread-abc-123',
    });
    // And the rebuild is on disk, so the next read is a plain parse.
    expect(await listChats(root)).toEqual(listed);
  });

  it('rebuilds from an index that parses but says nothing about any conversation', async () => {
    const chat = await createChat(root);
    await appendChatRecord(root, chat.id, { role: 'user', ts: '2026-01-01T00:00:00.000Z', text: 'hi' });
    // Valid JSON, and not this file. Read as "no chats" it would be written
    // over by the next save, which is the loss the whole recovery exists for.
    await fsp.writeFile(chatIndexPath(root), '{"chats":[]}', 'utf8');
    expect((await listChats(root)).map((listed) => listed.id)).toEqual([chat.id]);
  });

  it('keeps a chat whose transcript is damaged rather than dropping it', async () => {
    const chat = await createChat(root);
    await appendChatRecord(root, chat.id, { role: 'user', ts: '2026-01-01T00:00:00.000Z', text: 'hi' });
    // Bytes, but not one line this build can read.
    await fsp.writeFile(chatFilePath(root, chat.id), 'ÿÿ not json at all\n', 'utf8');
    await fsp.writeFile(chatIndexPath(root), 'not json at all', 'utf8');
    expect((await listChats(root)).map((listed) => listed.id)).toEqual([chat.id]);
  });

  it('does not write an empty listing when the folder could not be read', async () => {
    const chat = await createChat(root);
    await appendChatRecord(root, chat.id, { role: 'user', ts: '2026-01-01T00:00:00.000Z', text: 'hi' });
    const whole = await fsp.readFile(chatIndexPath(root), 'utf8');
    const torn = whole.slice(0, whole.lastIndexOf(']'));
    await fsp.writeFile(chatIndexPath(root), torn, 'utf8');

    // EMFILE under load: transient, and says nothing about what is in the
    // folder. Answering "no conversations" AND writing that back would be the
    // deletion the recovery exists to prevent.
    const readdir = vi.spyOn(fsp, 'readdir').mockRejectedValueOnce(
      Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }),
    );
    expect((await listChats(root)).map((listed) => listed.id)).toEqual([chat.id]);
    readdir.mockRestore();

    // The torn file is untouched, so the read that comes after the machine
    // recovers still has everything to work from.
    expect(await fsp.readFile(chatIndexPath(root), 'utf8')).toBe(torn);
    expect((await listChats(root)).map((listed) => listed.id)).toEqual([chat.id]);
  });

  it('does not resurrect chats nobody ever spoke into', async () => {
    const spoken = await createChat(root);
    await appendChatRecord(root, spoken.id, { role: 'user', ts: '2026-01-01T00:00:00.000Z', text: 'hi' });
    await createChat(root); // opened, never used: its transcript is empty
    await fsp.writeFile(chatIndexPath(root), 'not json at all', 'utf8');
    expect((await listChats(root)).map((chat) => chat.id)).toEqual([spoken.id]);
  });

  it('leaves nothing half-written behind after a normal write', async () => {
    const chat = await createChat(root);
    await appendChatRecord(root, chat.id, { role: 'user', ts: '2026-01-01T00:00:00.000Z', text: 'hi' });
    const names = await fsp.readdir(path.dirname(chatIndexPath(root)));
    expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    // Parses, every time: the rename is what makes that true even under a kill.
    expect(JSON.parse(await fsp.readFile(chatIndexPath(root), 'utf8'))).toHaveLength(1);
  });
});

/**
 * How often the listing is rewritten.
 *
 * Every rewrite is a window in which losing the process loses the index, and a
 * streaming turn used to open one per event. Nothing a person can see depends
 * on `updatedAt` moving mid-turn (the sidebar is redrawn when the turn ends),
 * so the row moves when the conversation visibly moves and not on every delta.
 * The transcript is still appended for all of them, which is the part that is
 * the record.
 */
describe('the index during a streaming turn', () => {
  const at = (seconds: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

  it('is not rewritten for every delta', async () => {
    const chat = await createChat(root);
    await appendChatRecord(root, chat.id, { role: 'user', ts: at(0), text: 'make a shooter' });
    const before = await fsp.readFile(chatIndexPath(root), 'utf8');

    for (let i = 1; i <= 4; i += 1) {
      await appendChatRecord(root, chat.id, {
        role: 'agent',
        ts: at(i),
        event: { type: 'message-delta', text: `chunk ${i}` },
      });
    }
    expect(await fsp.readFile(chatIndexPath(root), 'utf8')).toBe(before);
    // Every one of them is on disk, which is the promise that matters.
    expect(await readTranscript(root, chat.id)).toHaveLength(5);
  });

  it('is rewritten when the turn ends', async () => {
    const chat = await createChat(root);
    await appendChatRecord(root, chat.id, { role: 'user', ts: at(0), text: 'make a shooter' });
    await appendChatRecord(root, chat.id, { role: 'agent', ts: at(1), event: { type: 'message-delta', text: 'ok' } });
    await appendChatRecord(root, chat.id, { role: 'agent', ts: at(2), event: { type: 'turn-complete' } });
    expect((await listChats(root))[0].updatedAt).toBe(at(2));
  });

  it('is rewritten once a long turn has made the stored time stale', async () => {
    const chat = await createChat(root);
    await appendChatRecord(root, chat.id, { role: 'user', ts: at(0), text: 'make a shooter' });
    await appendChatRecord(root, chat.id, { role: 'agent', ts: at(1), event: { type: 'message-delta', text: 'a' } });
    expect((await listChats(root))[0].updatedAt).toBe(at(0));
    await appendChatRecord(root, chat.id, { role: 'agent', ts: at(30), event: { type: 'message-delta', text: 'b' } });
    expect((await listChats(root))[0].updatedAt).toBe(at(30));
  });
});
