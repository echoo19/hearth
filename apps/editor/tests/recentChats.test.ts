/**
 * The global chat history (GET /api/chats/recent).
 *
 * The sidebar's Recents list spans folders, so this walks every recent
 * workspace and merges their `.hearth/chats` indexes. The failure mode that
 * matters is a stale recents entry: a folder the user moved or deleted must
 * cost the list nothing at all, because a machine with one dead entry would
 * otherwise show no history whatsoever.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RECENT_CHATS_LIMIT, createProjectServerContext, type RecentChatEntry } from '../server/projectServer';

let tmp: string;
let recentsFile: string;

/** Write a folder's chat index directly — the shape chatStore reads back. */
async function writeChatIndex(
  root: string,
  chats: { id: string; title: string; createdAt: string; updatedAt: string }[],
): Promise<void> {
  const dir = path.join(root, '.hearth', 'chats');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'index.json'), JSON.stringify(chats, null, 2));
}

async function writeRecents(entries: { path: string; name: string }[]): Promise<void> {
  await fsp.writeFile(
    recentsFile,
    JSON.stringify(
      entries.map((e) => ({ ...e, openedAt: new Date().toISOString() })),
      null,
      2,
    ),
  );
}

function chatsFrom(body: unknown): RecentChatEntry[] {
  return (body as { ok: boolean; chats: RecentChatEntry[] }).chats;
}

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-recentchats-'));
  recentsFile = path.join(tmp, 'recents.json');
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('recentChats', () => {
  it('merges every recent folder and sorts by activity, newest first', async () => {
    const alpha = path.join(tmp, 'alpha');
    const beta = path.join(tmp, 'beta');
    await fsp.mkdir(alpha, { recursive: true });
    await fsp.mkdir(beta, { recursive: true });
    await writeChatIndex(alpha, [
      { id: 'a1', title: 'Slime platformer', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z' },
      { id: 'a2', title: 'Old idea', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    await writeChatIndex(beta, [
      { id: 'b1', title: 'Space pirates', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-04T00:00:00.000Z' },
    ]);
    await writeRecents([
      { path: alpha, name: 'alpha' },
      { path: beta, name: 'beta' },
    ]);

    const ctx = createProjectServerContext({ recentsFile, repoRoot: tmp });
    const chats = chatsFrom((await ctx.recentChats()).body);
    expect(chats.map((c) => c.id)).toEqual(['b1', 'a1', 'a2']);
    expect(chats[0]).toEqual({
      id: 'b1',
      title: 'Space pirates',
      // Every record written before the field existed is a chat, and the rail
      // marks a row by kind, so the entry has to carry it out of here.
      kind: 'chat',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-04T00:00:00.000Z',
      project: { path: beta, name: 'beta' },
    });
  });

  it('skips folders that are gone, unreadable, or have never been talked to', async () => {
    const live = path.join(tmp, 'live');
    const empty = path.join(tmp, 'empty');
    const broken = path.join(tmp, 'broken');
    await fsp.mkdir(live, { recursive: true });
    await fsp.mkdir(empty, { recursive: true });
    await fsp.mkdir(broken, { recursive: true });
    await writeChatIndex(live, [
      { id: 'l1', title: 'Still here', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
    ]);
    // Present but not JSON — a half-written index must not fail the request.
    await fsp.mkdir(path.join(broken, '.hearth', 'chats'), { recursive: true });
    await fsp.writeFile(path.join(broken, '.hearth', 'chats', 'index.json'), '{ not json');
    await writeRecents([
      { path: path.join(tmp, 'deleted-long-ago'), name: 'deleted-long-ago' },
      { path: broken, name: 'broken' },
      { path: empty, name: 'empty' },
      { path: live, name: 'live' },
    ]);

    const ctx = createProjectServerContext({ recentsFile, repoRoot: tmp });
    const result = await ctx.recentChats();
    expect(result.status).toBe(200);
    expect(chatsFrom(result.body).map((c) => c.id)).toEqual(['l1']);
  });

  it('returns an empty list rather than failing when there are no recents at all', async () => {
    const ctx = createProjectServerContext({ recentsFile: path.join(tmp, 'nothing-here.json'), repoRoot: tmp });
    const result = await ctx.recentChats();
    expect(result.status).toBe(200);
    expect(chatsFrom(result.body)).toEqual([]);
  });

  it('caps the list, keeping the most recent conversations', async () => {
    const many = path.join(tmp, 'many');
    await fsp.mkdir(many, { recursive: true });
    const total = RECENT_CHATS_LIMIT + 15;
    await writeChatIndex(
      many,
      Array.from({ length: total }, (_, i) => {
        const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
        return { id: `c${String(i).padStart(3, '0')}`, title: `Chat ${i}`, createdAt: stamp, updatedAt: stamp };
      }),
    );
    await writeRecents([{ path: many, name: 'many' }]);

    const ctx = createProjectServerContext({ recentsFile, repoRoot: tmp });
    const chats = chatsFrom((await ctx.recentChats()).body);
    expect(chats).toHaveLength(RECENT_CHATS_LIMIT);
    // The newest one survives the cap; the oldest does not.
    expect(chats[0].id).toBe(`c${String(total - 1).padStart(3, '0')}`);
    expect(chats.some((c) => c.id === 'c000')).toBe(false);
  });
});
