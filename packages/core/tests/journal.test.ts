/**
 * The command journal (`.hearth/log/commands.jsonl`) is a disk-backed,
 * append-only log of every command run through `HearthSession.execute` —
 * unlike `HistoryStore`, it records read-only allowlisted commands and
 * failures too, and it is never rewound by undo/redo. It feeds the editor's
 * trust timeline and external-change detection (later tasks).
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession, JournalStore, extractJournalDetail } from '@hearth/core';

async function makeSession(options: Parameters<typeof HearthSession.fromStore>[1] = {}) {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return { fs, session: HearthSession.fromStore(store, options), store };
}

describe('command journal', () => {
  it('a mutating command (createScene) appends an entry with seq 1, the session source, correct summary, ok=true', async () => {
    const { session } = await makeSession({ source: 'cli' });

    const created = await session.execute<any>('createScene', { name: 'Level 2' });
    expect(created.success).toBe(true);

    const list = await session.execute<any>('listJournal');
    expect(list.success).toBe(true);
    expect(list.data.entries.length).toBe(1);
    const entry = list.data.entries[0];
    expect(entry.seq).toBe(1);
    expect(entry.source).toBe('cli');
    expect(entry.command).toBe('createScene');
    expect(entry.summary).toContain('Level 2');
    expect(entry.ok).toBe(true);
    expect(entry.error).toBeUndefined();
    expect(list.data.lastSeq).toBe(1);
  });

  it('read-only, non-allowlisted commands (inspectProject) append nothing', async () => {
    const { session } = await makeSession();

    const inspected = await session.execute('inspectProject');
    expect(inspected.success).toBe(true);

    const list = await session.execute<any>('listJournal');
    expect(list.data.entries.length).toBe(0);
    expect(list.data.lastSeq).toBe(0);
  });

  it('runPlaytest appends with a passed/assertions/failures detail summary', async () => {
    const runtimeStub = {
      runPlaytest: async () => ({
        passed: false,
        playtestId: 'ptt_stub',
        name: 'Smoke Test',
        scene: 'Main',
        framesRun: 12,
        steps: [
          { index: 0, type: 'wait', passed: true },
          { index: 1, type: 'assertPosition', passed: false, message: 'out of tolerance' },
        ],
        errors: [],
      }),
    };
    const { session } = await makeSession({ runtime: runtimeStub as any });

    const created = await session.execute<any>('createPlaytest', { name: 'Smoke Test', scene: 'Main' });
    expect(created.success).toBe(true);

    const ran = await session.execute<any>('runPlaytest', { playtest: 'Smoke Test' });
    expect(ran.success).toBe(true);

    const list = await session.execute<any>('listJournal');
    const entry = list.data.entries.find((e: any) => e.command === 'runPlaytest');
    expect(entry).toBeDefined();
    expect(entry.ok).toBe(true);
    expect(entry.detail).toEqual({ passed: false, assertions: 2, failures: 1 });
  });

  it('validateProject appends with an errors/warnings detail summary', async () => {
    const { session } = await makeSession();

    const validated = await session.execute<any>('validateProject');
    expect(validated.success).toBe(true);

    const list = await session.execute<any>('listJournal');
    const entry = list.data.entries.find((e: any) => e.command === 'validateProject');
    expect(entry).toBeDefined();
    expect(entry.detail).toEqual({ errors: 0, warnings: 0 });
  });

  it('a failing mutating command (duplicate createScene) appends ok=false with the error code', async () => {
    const { session } = await makeSession();

    const first = await session.execute<any>('createScene', { name: 'Level 2' });
    expect(first.success).toBe(true);

    const dup = await session.execute<any>('createScene', { name: 'Level 2' });
    expect(dup.success).toBe(false);
    expect(dup.errors[0].code).toBe('CONFLICT');

    const list = await session.execute<any>('listJournal');
    expect(list.data.entries.length).toBe(2);
    const failedEntry = list.data.entries[1];
    expect(failedEntry.command).toBe('createScene');
    expect(failedEntry.ok).toBe(false);
    expect(failedEntry.error).toBe('CONFLICT');
  });

  it('rotates the file once past JOURNAL_ROTATE_MAX entries, keeping the newest JOURNAL_ROTATE_KEEP with continuous seqs', async () => {
    const fs = new MemoryFileSystem();
    await fs.mkdir('/proj');
    const journal = new JournalStore(fs, '/proj');

    for (let i = 0; i < 4001; i++) {
      await journal.append({
        ts: new Date().toISOString(),
        source: 'test',
        command: 'createScene',
        summary: `createScene Scene${i}`,
        ok: true,
      });
    }

    expect(await journal.lastSeq()).toBe(4001);
    const all = await journal.read();
    expect(all.length).toBe(2000);
    expect(all[0].seq).toBe(2002);
    expect(all[all.length - 1].seq).toBe(4001);
    // Continuous: no gaps between the retained seqs.
    for (let i = 1; i < all.length; i++) {
      expect(all[i].seq).toBe(all[i - 1].seq + 1);
    }
  });

  it('listJournal respects since/limit and reports lastSeq', async () => {
    const { session } = await makeSession();

    await session.execute('createScene', { name: 'Level 2' });
    await session.execute('createScene', { name: 'Level 3' });
    await session.execute('createScene', { name: 'Level 4' });

    const page1 = await session.execute<any>('listJournal', { limit: 2 });
    expect(page1.data.entries.length).toBe(2);
    expect(page1.data.entries[0].seq).toBe(1);
    expect(page1.data.entries[1].seq).toBe(2);
    expect(page1.data.lastSeq).toBe(3);

    const page2 = await session.execute<any>('listJournal', { since: 2 });
    expect(page2.data.entries.length).toBe(1);
    expect(page2.data.entries[0].seq).toBe(3);
    expect(page2.data.lastSeq).toBe(3);
  });

  it('cross-session: a second HearthSession.open on the same root continues seq from disk', async () => {
    const fs = new MemoryFileSystem();
    const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
    const session1 = HearthSession.fromStore(store, { source: 'editor' });

    const first = await session1.execute<any>('createScene', { name: 'Level 2' });
    expect(first.success).toBe(true);

    const session2 = await HearthSession.open(fs, '/proj', { source: 'mcp' });
    const second = await session2.execute<any>('createScene', { name: 'Level 3' });
    expect(second.success).toBe(true);

    const list = await session2.execute<any>('listJournal');
    expect(list.data.entries.length).toBe(2);
    expect(list.data.entries[0].seq).toBe(1);
    expect(list.data.entries[0].source).toBe('editor');
    expect(list.data.entries[1].seq).toBe(2);
    expect(list.data.entries[1].source).toBe('mcp');
  });

  it('a journal write failure does not fail an already-persisted mutation', async () => {
    const { session, fs, store } = await makeSession();

    // Inject a broken appendFile (disk full, permissions, etc.) — the
    // mutation has already run and been persisted, so a broken journal
    // must not turn that into a failed result.
    (fs as any).appendFile = async () => {
      throw new Error('disk full');
    };

    const result = await session.execute<any>('createScene', { name: 'Level 2' });
    expect(result.success).toBe(true);
    expect(result.warnings.some((w: any) => w.code === 'JOURNAL_RECORD_FAILED')).toBe(true);
    expect(store.getScene('Level 2')).toBeDefined();
  });

  it('extractJournalDetail omits detail when fields are malformed or missing', () => {
    // runPlaytest missing steps array
    expect(extractJournalDetail('runPlaytest', { passed: true })).toBeUndefined();
    // runPlaytest with wrong-typed passed field
    expect(extractJournalDetail('runPlaytest', { passed: 'yes', steps: [] })).toBeUndefined();
    // validateProject missing warnings array
    expect(extractJournalDetail('validateProject', { errors: [] })).toBeUndefined();
    // validateProject with wrong-typed errors field
    expect(extractJournalDetail('validateProject', { errors: 'none', warnings: [] })).toBeUndefined();
    // null data
    expect(extractJournalDetail('runPlaytest', null)).toBeUndefined();
    // non-object data
    expect(extractJournalDetail('runPlaytest', 'not an object')).toBeUndefined();
  });

  it('a failing allowlisted command (runPlaytest with nonexistent playtest) appends ok=false with error code and no detail', async () => {
    const runtimeStub = {
      runPlaytest: async () => ({
        passed: true,
        playtestId: 'ptt_stub',
        name: 'Test',
        scene: 'Main',
        framesRun: 0,
        steps: [],
        errors: [],
      }),
    };
    const { session } = await makeSession({ runtime: runtimeStub as any });

    const failed = await session.execute<any>('runPlaytest', { playtest: 'NonexistentPlaytest' });
    expect(failed.success).toBe(false);
    expect(failed.errors[0].code).toBe('NOT_FOUND');

    const list = await session.execute<any>('listJournal');
    expect(list.data.entries.length).toBe(1);
    const entry = list.data.entries[0];
    expect(entry.command).toBe('runPlaytest');
    expect(entry.ok).toBe(false);
    expect(entry.error).toBe('NOT_FOUND');
    expect(entry.detail).toBeUndefined();
  });
});
