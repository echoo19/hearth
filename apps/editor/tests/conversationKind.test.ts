// @vitest-environment jsdom
/**
 * A conversation has a KIND, and it has it for life.
 *
 * Starting a chat and starting a terminal session are two different acts that
 * make two different records; there is no way to turn one into the other,
 * because there never was one in any honest sense — a transcript and a pty are
 * not the same thing wearing two hats. What used to stand in for this was a
 * per-window toggle plus a `kind` field nobody wrote, which is why the project
 * screen's Terminal group was empty on every machine.
 *
 * These pin the four things that make the rule real rather than merely stated:
 *   1. a record written before kinds existed reads as a chat, and is neither
 *      dropped nor rewritten;
 *   2. a terminal record survives a round trip to disk as a terminal record;
 *   3. the project screen splits on the record's own field;
 *   4. nothing that writes to an existing record can change its kind.
 *
 * jsdom because groupChats lives in the project screen's module, which reaches
 * the store on import; the assertions themselves are DOM-free.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  UNTITLED,
  UNTITLED_TERMINAL,
  UNTITLED_DEVTEAM,
  appendChatRecord,
  chatIndexPath,
  createChat,
  defaultChatTitle,
  getChat,
  listChats,
  markChatUsed,
  parseChatIndex,
  renameChat,
  setChatThreadId,
  type ChatSummary,
} from '../server/chatStore';
import { conversationKind } from '../src/store';
import { groupChats } from '../src/components/project/ProjectHome';
import { CONVERSATION_KIND_ICON, CONVERSATION_KIND_LABEL, mergeRecentChats } from '../src/components/shell/Sidebar';

vi.mock('../src/components/agent/Terminal', () => ({
  Terminal: () => null,
  resendTerminalSizeThenFocus: () => {},
}));

import { conversationKindLabel } from '../src/components/chat/ConversationHead';

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-chatkind-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

/** A summary as the UI receives one, without spelling out the boring fields. */
function summary(over: Partial<ChatSummary> & { id: string }): ChatSummary {
  return {
    title: over.id,
    kind: 'chat',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('a record written before kinds existed', () => {
  it('reads as a chat rather than as nothing', () => {
    const chats = parseChatIndex([
      { id: 'legacy', title: 'A', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(chats).toHaveLength(1);
    expect(chats[0].kind).toBe('chat');
  });

  it('reads as a chat when the field is there but unrecognisable', () => {
    // The index is a file on disk that anything could have touched. A value
    // this module does not know is not a third kind, it is a missing answer.
    expect(parseChatIndex([{ id: 'odd', kind: 'shell' }])[0].kind).toBe('chat');
  });

  it('is not rewritten to add one: reading the index leaves the file alone', async () => {
    const file = chatIndexPath(root);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const raw = JSON.stringify([
      { id: 'legacy', title: 'A', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    await fsp.writeFile(file, raw, 'utf8');

    expect((await listChats(root))[0].kind).toBe('chat');
    expect(await fsp.readFile(file, 'utf8')).toBe(raw);
  });

  it('keeps the name it was given rather than being renamed by the default', () => {
    expect(parseChatIndex([{ id: 'legacy', title: 'Ember opening' }])[0].title).toBe('Ember opening');
  });
});

describe('a terminal record', () => {
  it('is created as one and comes back as one', async () => {
    const created = await createChat(root, { kind: 'terminal' });
    expect(created.kind).toBe('terminal');

    // Listed only once it has been typed into. A terminal is pending from
    // creation for the same reason a chat is: a shell somebody opened and
    // looked at is not a session they had.
    expect(await listChats(root)).toEqual([]);
    await markChatUsed(root, created.id);
    const [listed] = await listChats(root);
    expect(listed.kind).toBe('terminal');
    expect(listed.id).toBe(created.id);
  });

  it('survives being written and parsed again', async () => {
    const created = await createChat(root, { kind: 'terminal', title: 'Claude Code' });
    await markChatUsed(root, created.id);
    const raw: unknown = JSON.parse(await fsp.readFile(chatIndexPath(root), 'utf8'));
    const [parsed] = parseChatIndex(raw);
    expect(parsed).toEqual(created);
  });

  it('is named for what it is, since no first message will ever name it', async () => {
    // A chat is titled by what was first asked of it. Nothing is asked of a
    // shell through Hearth, so "New chat" forever would be the wrong name.
    expect((await createChat(root, { kind: 'terminal' })).title).toBe(UNTITLED_TERMINAL);
    expect((await createChat(root)).title).toBe(UNTITLED);
    expect(defaultChatTitle('terminal')).toBe(UNTITLED_TERMINAL);
    expect(defaultChatTitle('chat')).toBe(UNTITLED);
  });

  it('takes the name of the CLI started in it when one is given', async () => {
    expect((await createChat(root, { kind: 'terminal', title: 'Claude Code' })).title).toBe('Claude Code');
  });

  it('is a chat when the caller asks for nothing in particular', async () => {
    expect((await createChat(root)).kind).toBe('chat');
  });
});

describe('a dev team record', () => {
  it('parses only the exact persisted kind and defaults unknown values to chat', () => {
    expect(parseChatIndex([{ id: 'team', kind: 'devteam' }])[0].kind).toBe('devteam');
    expect(parseChatIndex([{ id: 'wrong-case', kind: 'DevTeam' }])[0].kind).toBe('chat');
    expect(parseChatIndex([{ id: 'missing' }])[0].kind).toBe('chat');
  });

  it('starts titled Dev team and is named by its first real user record', async () => {
    const chat = await createChat(root, { kind: 'devteam' });
    expect(chat).toMatchObject({ kind: 'devteam', title: UNTITLED_DEVTEAM });
    expect(defaultChatTitle('devteam')).toBe('Dev team');

    await appendChatRecord(root, chat.id, { role: 'user', ts: 't1', text: 'lead instructions', orchestration: true });
    expect((await getChat(root, chat.id))?.title).toBe('Dev team');
    await appendChatRecord(root, chat.id, { role: 'user', ts: 't2', text: 'Build a garden game' });
    expect((await listChats(root))[0]).toMatchObject({ kind: 'devteam', title: 'Build a garden game' });
  });
});

describe('the kind cannot be changed once the record exists', () => {
  it('survives a rename', async () => {
    const chat = await createChat(root, { kind: 'terminal' });
    await markChatUsed(root, chat.id);
    const renamed = await renameChat(root, chat.id, 'The long build');
    expect(renamed?.title).toBe('The long build');
    expect(renamed?.kind).toBe('terminal');
    expect((await listChats(root))[0].kind).toBe('terminal');
  });

  it('survives an appended record, and that record does not retitle it either', async () => {
    const chat = await createChat(root, { kind: 'terminal' });
    const after = await appendChatRecord(root, chat.id, {
      role: 'user',
      ts: '2026-02-01T00:00:00.000Z',
      text: 'make a shooter',
    });
    expect(after?.kind).toBe('terminal');
    // Titling is the chat rule: it names a conversation still called "New
    // chat", and a terminal session is not called that.
    expect(after?.title).toBe(UNTITLED_TERMINAL);
  });

  it('survives binding a backend thread', async () => {
    const chat = await createChat(root, { kind: 'terminal' });
    const bound = await setChatThreadId(root, chat.id, 'thread-1');
    expect(bound?.kind).toBe('terminal');
  });

  it('is offered by no writer at all: the only kind argument is on creation', async () => {
    // The guarantee is structural rather than defensive — there is nothing to
    // call that would change it — so what is checked here is that every writer
    // hands back the kind the record started with.
    const chat = await createChat(root, { kind: 'chat' });
    await renameChat(root, chat.id, 'still a chat');
    await appendChatRecord(root, chat.id, { role: 'user', ts: '2026-02-01T00:00:00.000Z', text: 'hello' });
    await setChatThreadId(root, chat.id, 'thread-2');
    expect((await listChats(root)).map((row) => row.kind)).toEqual(['chat']);
  });
});

describe('conversationKind', () => {
  it('answers with what the record says', () => {
    expect(conversationKind({ kind: 'terminal' })).toBe('terminal');
    expect(conversationKind({ kind: 'devteam' })).toBe('devteam');
    expect(conversationKind({ kind: 'chat' })).toBe('chat');
  });

  it('answers chat for a record that says nothing', () => {
    expect(conversationKind({})).toBe('chat');
  });
});

describe('groupChats — the project screen’s two lists', () => {
  it('splits on the record’s own field, so the Terminal group can fill', () => {
    const groups = groupChats([
      summary({ id: 'a', kind: 'chat' }),
      summary({ id: 'b', kind: 'terminal' }),
      summary({ id: 'c', kind: 'terminal' }),
      summary({ id: 'd', kind: 'devteam' }),
    ]);
    expect(groups.chat.map((row) => row.id)).toEqual(['a']);
    expect(groups.terminal.map((row) => row.id)).toEqual(['b', 'c']);
    expect(groups.devteam.map((row) => row.id)).toEqual(['d']);
  });

  it('puts a record with no kind in Chats rather than losing it', () => {
    // The bug this replaces: the field was read through a cast, off a summary
    // that never carried it, so every conversation landed in Chats and the
    // Terminal heading never appeared. Half of that is still the right answer.
    const groups = groupChats([{ ...summary({ id: 'legacy' }), kind: undefined } as unknown as ChatSummary]);
    expect(groups.chat.map((row) => row.id)).toEqual(['legacy']);
    expect(groups.terminal).toEqual([]);
    expect(groups.devteam).toEqual([]);
  });

  it('keeps the order it was given inside each group', () => {
    const groups = groupChats([summary({ id: 'new' }), summary({ id: 'old' })]);
    expect(groups.chat.map((row) => row.id)).toEqual(['new', 'old']);
  });
});

describe('the rail’s conversation list', () => {
  it('carries the kind through the fold-in, so a new session is marked at once', () => {
    const merged = mergeRecentChats(
      [
        {
          id: 'a',
          title: 'Older chat',
          kind: 'chat',
          updatedAt: '2026-01-01T00:00:00.000Z',
          project: { path: '/work/ember', name: 'Ember' },
        },
      ],
      [{ id: 'b', title: 'Claude Code', kind: 'terminal', updatedAt: '2026-02-01T00:00:00.000Z' }],
      { path: '/work/ember', name: 'Ember' },
    );
    expect(merged.map((row) => [row.id, row.kind])).toEqual([
      ['b', 'terminal'],
      ['a', 'chat'],
    ]);
  });

  it('marks a folder chat that predates kinds as a chat rather than as nothing', () => {
    const [row] = mergeRecentChats([], [{ id: 'legacy', title: 'A', updatedAt: '2026-01-01T00:00:00.000Z' }], {
      path: '/work/ember',
      name: 'Ember',
    });
    expect(row.kind).toBe('chat');
  });
});

describe('how a kind is drawn', () => {
  it('gives each kind its own glyph, or the mark says nothing', () => {
    expect(new Set(Object.values(CONVERSATION_KIND_ICON))).toHaveLength(3);
    expect(CONVERSATION_KIND_ICON.devteam).toBe('team');
  });

  it('gives each glyph a name, so the kind is never icon-only', () => {
    expect(CONVERSATION_KIND_LABEL.chat.trim()).not.toBe('');
    expect(CONVERSATION_KIND_LABEL.terminal.trim()).not.toBe('');
    expect(CONVERSATION_KIND_LABEL.devteam).toBe('Dev team');
  });

  it('names every conversation mode in the conversation header', () => {
    expect(['chat', 'terminal', 'devteam'].map((kind) => conversationKindLabel(kind as 'chat' | 'terminal' | 'devteam')))
      .toEqual(['Chat', 'Terminal', 'Dev team']);
  });
});
