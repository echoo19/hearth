/**
 * Usage — the counting, and what it does when the disk lies.
 *
 * Two properties matter more than any individual number here. The first is
 * that it never throws: this runs when a settings dialog opens, over folders
 * the user may have deleted or half-written, and a broken folder must cost its
 * own row and nothing else. The second is that a fresh machine answers with
 * zeroes rather than failing — "nothing yet" is a state, not an error.
 *
 * The three skills homes are pointed at temp folders for the same reason
 * skills.test.ts does it: leaving them alone would have the suite count
 * whatever skills the machine running it happens to own.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectUsage,
  countPlaytests,
  displayPath,
  readChatCounts,
  readJournalSeq,
  readRecentRows,
  SWEEPS_DIR,
} from '../server/usage';

const HOMES = ['HEARTH_HOME', 'HEARTH_CLAUDE_HOME', 'HEARTH_CODEX_HOME'] as const;

let tmp = '';
let recentsFile = '';
const previous: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-usage-'));
  recentsFile = path.join(tmp, 'home', '.hearth', 'recent-projects.json');
  for (const key of HOMES) {
    previous[key] = process.env[key];
    const home = path.join(tmp, 'agent-homes', key);
    await fsp.mkdir(home, { recursive: true });
    process.env[key] = home;
  }
});

afterEach(async () => {
  for (const key of HOMES) {
    const was = previous[key];
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  await fsp.rm(tmp, { recursive: true, force: true });
});

/** Write the recents list the way projectServer's `addRecent` does. */
async function writeRecents(entries: { path: string; name: string; openedAt: string }[]): Promise<void> {
  await fsp.mkdir(path.dirname(recentsFile), { recursive: true });
  await fsp.writeFile(recentsFile, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

/** A project folder with as much or as little in it as the test needs. */
async function makeProject(
  name: string,
  content: {
    chats?: { id: string; createdAt: string; updatedAt: string }[];
    /** Raw text for index.json, for the corruption cases. */
    rawIndex?: string;
    sweeps?: number;
    /** Journal lines, each given only a seq — nothing here reads the rest. */
    journalSeqs?: number[];
  } = {},
): Promise<string> {
  const root = path.join(tmp, 'projects', name);
  await fsp.mkdir(root, { recursive: true });

  if (content.chats || content.rawIndex !== undefined) {
    const dir = path.join(root, '.hearth', 'chats');
    await fsp.mkdir(dir, { recursive: true });
    const text =
      content.rawIndex ??
      JSON.stringify((content.chats ?? []).map((chat) => ({ ...chat, title: chat.id })), null, 2);
    await fsp.writeFile(path.join(dir, 'index.json'), text, 'utf8');
  }

  for (let n = 1; n <= (content.sweeps ?? 0); n += 1) {
    await fsp.mkdir(path.join(root, SWEEPS_DIR, String(n).padStart(4, '0'), 'shots'), { recursive: true });
  }

  if (content.journalSeqs) {
    const file = path.join(root, '.hearth', 'log', 'commands.jsonl');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const lines = content.journalSeqs.map((seq) => JSON.stringify({ seq, name: 'setComponent', ts: '' }));
    await fsp.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  }

  return root;
}

/** Put a skill in one of the temp homes, the way the Skills screen would find it. */
async function putSkill(homeKey: (typeof HOMES)[number], id: string): Promise<void> {
  const dir = path.join(process.env[homeKey] ?? '', 'skills', id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: d\n---\nbody\n`, 'utf8');
}

describe('an empty machine', () => {
  it('answers with zeroes rather than failing when nothing has been opened', async () => {
    const report = await collectUsage({ recentsFile, home: path.join(tmp, 'home') });
    expect(report.projects).toEqual([]);
    expect(report.totals).toEqual({ projects: 0, missing: 0, chats: 0, playtests: 0, changes: 0 });
    expect(report.skills).toEqual({ total: 0, enabled: 0 });
    expect(report.firstChatAt).toBeNull();
    expect(report.lastActivityAt).toBeNull();
    expect(Number.isFinite(Date.parse(report.gatheredAt))).toBe(true);
  });

  it('reads an unparseable recents file as no folders rather than throwing', async () => {
    await fsp.mkdir(path.dirname(recentsFile), { recursive: true });
    await fsp.writeFile(recentsFile, '{ this is not the list', 'utf8');
    const report = await collectUsage({ recentsFile });
    expect(report.totals.projects).toBe(0);
  });

  it('reads a recents file that is an object rather than a list as no folders', async () => {
    await fsp.mkdir(path.dirname(recentsFile), { recursive: true });
    await fsp.writeFile(recentsFile, '{"path":"/somewhere"}', 'utf8');
    expect(await readRecentRows(recentsFile)).toEqual([]);
  });

  it('drops a recents row with no path but keeps the rows around it', async () => {
    await writeRecents([]);
    await fsp.writeFile(
      recentsFile,
      JSON.stringify([{ name: 'nameless' }, { path: '/a/b', name: 'b', openedAt: 'x' }, null, 7]),
      'utf8',
    );
    const rows = await readRecentRows(recentsFile);
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe('/a/b');
  });
});

describe('recentsFile default honors HEARTH_HOME', () => {
  // Confirmed finding: collectUsage's recentsFile default hardcoded
  // path.join(home, '.hearth', 'recent-projects.json') where `home` falls
  // back to os.homedir() — so an isolated instance still read the REAL
  // machine's project list even with HEARTH_HOME pointed elsewhere. Every
  // other test in this file passes `recentsFile` explicitly (see
  // `beforeEach` above), which is exactly what let that hardcoding go
  // unnoticed; this one deliberately does not.
  it('reads the default recents file from HEARTH_HOME rather than the real ~/.hearth', async () => {
    const isolatedHome = process.env.HEARTH_HOME!;
    const isolatedRecents = path.join(isolatedHome, 'recent-projects.json');
    await fsp.writeFile(
      isolatedRecents,
      JSON.stringify([{ path: '/only/in/isolated/home', name: 'x', openedAt: '2026-01-01T00:00:00.000Z' }]),
      'utf8',
    );
    const report = await collectUsage({});
    expect(report.totals.projects).toBe(1);
    expect(report.projects[0].path).toBe('/only/in/isolated/home');
  });
});

describe('counting one folder', () => {
  it('counts conversations off the index without opening a transcript', async () => {
    const root = await makeProject('shooter', {
      chats: [
        { id: 'a', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
        { id: 'b', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' },
      ],
    });
    expect(await readChatCounts(root)).toEqual({
      chats: 2,
      firstChatAt: '2026-01-01T00:00:00.000Z',
      lastChatAt: '2026-03-01T00:00:00.000Z',
    });
  });

  it('counts one sweep directory per playtest, ignoring loose files beside them', async () => {
    const root = await makeProject('platformer', { sweeps: 3 });
    await fsp.writeFile(path.join(root, SWEEPS_DIR, 'notes.txt'), 'x', 'utf8');
    expect(await countPlaytests(root)).toBe(3);
  });

  it('has no playtests when the game has never been played', async () => {
    expect(await countPlaytests(await makeProject('quiet'))).toBe(0);
  });

  it('reads the journal total off its last seq, not by counting lines', async () => {
    // Seqs survive rotation, so a rotated journal holding two lines can still
    // honestly report the four hundred changes it has recorded.
    const root = await makeProject('rotated', { journalSeqs: [399, 400] });
    expect(await readJournalSeq(root)).toBe(400);
  });

  it('reads no changes from a folder with no journal', async () => {
    expect(await readJournalSeq(await makeProject('fresh'))).toBe(0);
  });

  it('falls back past a half-written last line rather than answering zero', async () => {
    // A journal being appended to while the dialog opens has a torn bottom
    // line. One entry behind is a far better answer than "no changes at all".
    const root = await makeProject('torn', { journalSeqs: [1, 2] });
    await fsp.appendFile(path.join(root, '.hearth', 'log', 'commands.jsonl'), '{"seq":3,"na', 'utf8');
    expect(await readJournalSeq(root)).toBe(2);
  });

  it('reads no changes from a journal that is nothing but nonsense', async () => {
    const root = await makeProject('junk', { journalSeqs: [] });
    await fsp.writeFile(path.join(root, '.hearth', 'log', 'commands.jsonl'), 'not json\nstill not\n', 'utf8');
    expect(await readJournalSeq(root)).toBe(0);
  });

  it('writes a path under the home directory as ~', () => {
    const home = path.join(path.sep, 'Users', 'someone');
    expect(displayPath(path.join(home, 'Hearth', 'shooter'), home)).toBe(
      `~${path.sep}Hearth${path.sep}shooter`,
    );
    expect(displayPath(path.join(path.sep, 'tmp', 'elsewhere'), home)).toBe(
      path.join(path.sep, 'tmp', 'elsewhere'),
    );
  });
});

describe('the whole machine', () => {
  it('adds up a known set of folders', async () => {
    const shooter = await makeProject('shooter', {
      chats: [
        { id: 'a', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-05T00:00:00.000Z' },
        { id: 'b', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-06T00:00:00.000Z' },
      ],
      sweeps: 2,
      journalSeqs: [11],
    });
    const puzzle = await makeProject('puzzle', {
      chats: [{ id: 'c', createdAt: '2025-12-01T00:00:00.000Z', updatedAt: '2025-12-02T00:00:00.000Z' }],
      sweeps: 1,
      journalSeqs: [4],
    });
    await writeRecents([
      { path: shooter, name: 'shooter', openedAt: '2026-01-06T00:00:00.000Z' },
      { path: puzzle, name: 'puzzle', openedAt: '2025-12-02T00:00:00.000Z' },
    ]);

    const report = await collectUsage({ recentsFile, home: path.join(tmp, 'home') });
    expect(report.totals).toEqual({ projects: 2, missing: 0, chats: 3, playtests: 3, changes: 15 });
    expect(report.firstChatAt).toBe('2025-12-01T00:00:00.000Z');
    expect(report.lastActivityAt).toBe('2026-01-06T00:00:00.000Z');
    // Newest activity first, so the folder you were just in is at the top.
    expect(report.projects.map((p) => p.name)).toEqual(['shooter', 'puzzle']);
    expect(report.projects[0]).toMatchObject({ exists: true, chats: 2, playtests: 2, changes: 11 });
  });

  it('skips a folder that has been deleted without losing the other totals', async () => {
    const kept = await makeProject('kept', {
      chats: [{ id: 'a', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      sweeps: 1,
      journalSeqs: [9],
    });
    await writeRecents([
      { path: path.join(tmp, 'projects', 'thrown-away'), name: 'thrown-away', openedAt: '2026-02-01T00:00:00.000Z' },
      { path: kept, name: 'kept', openedAt: '2026-01-01T00:00:00.000Z' },
    ]);

    const report = await collectUsage({ recentsFile });
    expect(report.totals).toEqual({ projects: 2, missing: 1, chats: 1, playtests: 1, changes: 9 });
    const gone = report.projects.find((p) => p.name === 'thrown-away');
    expect(gone).toMatchObject({ exists: false, chats: 0, playtests: 0, changes: 0 });
    // It still shows up, because deleting a game does not mean it never happened.
    expect(report.projects).toHaveLength(2);
  });

  it('skips a corrupt chat index without breaking the folder beside it', async () => {
    const broken = await makeProject('broken', { rawIndex: '[{"id":"a", oh no', sweeps: 1 });
    const fine = await makeProject('fine', {
      chats: [{ id: 'a', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
    });
    await writeRecents([
      { path: broken, name: 'broken', openedAt: '2026-01-02T00:00:00.000Z' },
      { path: fine, name: 'fine', openedAt: '2026-01-01T00:00:00.000Z' },
    ]);

    const report = await collectUsage({ recentsFile });
    expect(report.totals.chats).toBe(1);
    // The rest of the broken folder is still counted: one bad file is not a
    // reason to forget that a playtest ran in there.
    expect(report.projects.find((p) => p.name === 'broken')).toMatchObject({
      exists: true,
      chats: 0,
      playtests: 1,
    });
  });

  it('drops the unusable rows of a half-corrupt chat index and keeps the rest', async () => {
    const root = await makeProject('mixed', {
      rawIndex: JSON.stringify([
        { id: 'good', title: 'g', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        { title: 'no id at all' },
        'not even an object',
      ]),
    });
    expect((await readChatCounts(root)).chats).toBe(1);
  });

  it('does not count a chat nobody has spoken into', async () => {
    // `pending` rows exist so a first message has somewhere to land, and every
    // other surface hides them. Counting them here would put a figure in
    // Settings larger than the number of conversations on screen, which reads
    // as a broken count rather than as a different question. The Usage pane's
    // wording ("Every chat started in those folders") is what overstates it.
    const root = await makeProject('half-started', {
      rawIndex: JSON.stringify([
        { id: 'spoken', title: 's', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'silent', title: 'x', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', pending: true },
      ]),
    });
    expect((await readChatCounts(root)).chats).toBe(1);
  });

  it('counts skills the way the Skills screen does, including another agent’s', async () => {
    await putSkill('HEARTH_HOME', 'pixel-art');
    await putSkill('HEARTH_CLAUDE_HOME', 'impeccable');
    await fsp.writeFile(
      path.join(process.env.HEARTH_HOME ?? '', 'skills.json'),
      JSON.stringify({ disabled: ['pixel-art'] }),
      'utf8',
    );

    const report = await collectUsage({ recentsFile });
    expect(report.skills.total).toBe(2);
    expect(report.skills.enabled).toBe(1);
  });
});
