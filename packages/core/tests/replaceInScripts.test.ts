/**
 * replaceInScripts: mutating find-and-replace across script files.
 * Surgical (never re-formats), line-based (no multiline patterns), and
 * dryRun short-circuits before any write / ctx.changed / journal path.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession, extractJournalDetail } from '@hearth/core';

async function makeSession(granted?: any) {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return { fs, session: HearthSession.fromStore(store, granted ? { granted } : {}), store };
}

describe('replaceInScripts', () => {
  it('replaces plain-text matches, case-insensitive by default', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', { name: 'mover', source: 'ctx.log("Hello world")\n', format: false });

    const res = await session.execute<any>('replaceInScripts', { query: 'hello', replacement: 'Goodbye' });
    expect(res.success).toBe(true);
    expect(res.data.applied).toBe(true);
    expect(res.data.total).toBe(1);
    expect(res.data.changes).toHaveLength(1);
    expect(res.data.changes[0].path).toBe('scripts/mover.lua');
    expect(res.data.changes[0].count).toBe(1);

    const read = await session.execute<any>('readScript', { path: 'scripts/mover.lua' });
    expect(read.data.source).toBe('ctx.log("Goodbye world")\n');
    expect(res.changed).toEqual([{ kind: 'script', path: 'scripts/mover.lua', action: 'modified' }]);
  });

  it('caseSensitive:true only matches the exact case', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', {
      name: 'mover',
      source: 'local Hello = 1\nlocal hello = 2\n',
      format: false,
    });

    const res = await session.execute<any>('replaceInScripts', {
      query: 'hello',
      replacement: 'greeting',
      caseSensitive: true,
    });
    expect(res.success).toBe(true);
    expect(res.data.total).toBe(1);
    const read = await session.execute<any>('readScript', { path: 'scripts/mover.lua' });
    expect(read.data.source).toBe('local Hello = 1\nlocal greeting = 2\n');
  });

  it('regex mode supports $1 capture-group references in the replacement', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', {
      name: 'mover',
      source: 'ctx.timers.after(1, fn)\nctx.timers.after(2, fn)\n',
      format: false,
    });

    const res = await session.execute<any>('replaceInScripts', {
      query: 'ctx\\.timers\\.after\\((\\d+), fn\\)',
      replacement: 'ctx.timers.after($1, callback)',
      regex: true,
    });
    expect(res.success).toBe(true);
    expect(res.data.total).toBe(2);
    const read = await session.execute<any>('readScript', { path: 'scripts/mover.lua' });
    expect(read.data.source).toBe('ctx.timers.after(1, callback)\nctx.timers.after(2, callback)\n');
  });

  it('pathGlob restricts which scripts are touched', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', { name: 'goblin', source: 'local x = 1\n', format: false });
    await session.execute('createScript', { name: 'mover', source: 'local x = 1\n', format: false });

    const res = await session.execute<any>('replaceInScripts', {
      query: 'x',
      replacement: 'y',
      pathGlob: 'scripts/gob*',
    });
    expect(res.success).toBe(true);
    expect(res.data.changes.map((c: any) => c.path)).toEqual(['scripts/goblin.lua']);

    const goblin = await session.execute<any>('readScript', { path: 'scripts/goblin.lua' });
    expect(goblin.data.source).toBe('local y = 1\n');
    const mover = await session.execute<any>('readScript', { path: 'scripts/mover.lua' });
    expect(mover.data.source).toBe('local x = 1\n');
  });

  it('invalid regex surfaces INVALID_INPUT carrying the engine message', async () => {
    const { session } = await makeSession();
    const res = await session.execute<any>('replaceInScripts', { query: '(', replacement: 'x', regex: true });
    expect(res.success).toBe(false);
    expect(res.errors[0].code).toBe('INVALID_INPUT');
    expect(res.errors[0].message).toContain('Invalid regular expression');
  });

  it('dryRun previews counts, returns applied:false, and touches nothing on disk', async () => {
    const { session, fs } = await makeSession();
    await session.execute('createScript', { name: 'mover', source: 'local x = 1\n', format: false });
    const before = await fs.readFile('/proj/scripts/mover.lua');

    const res = await session.execute<any>('replaceInScripts', { query: 'x', replacement: 'y', dryRun: true });
    expect(res.success).toBe(true);
    expect(res.data.applied).toBe(false);
    expect(res.data.changes).toHaveLength(1);
    expect(res.data.changes[0]).toMatchObject({ path: 'scripts/mover.lua', count: 1 });
    expect(res.data.total).toBe(1);
    expect(res.changed).toEqual([]); // no ctx.changed on a dryRun

    expect(await fs.readFile('/proj/scripts/mover.lua')).toBe(before);
  });

  it('a real N-file replace undoes atomically with ONE undo', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', { name: 'a', source: 'local x = 1\n', format: false });
    await session.execute('createScript', { name: 'b', source: 'local x = 2\n', format: false });

    const res = await session.execute<any>('replaceInScripts', { query: 'x', replacement: 'y' });
    expect(res.success).toBe(true);
    expect((await session.execute<any>('readScript', { path: 'scripts/a.lua' })).data.source).toBe('local y = 1\n');
    expect((await session.execute<any>('readScript', { path: 'scripts/b.lua' })).data.source).toBe('local y = 2\n');

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(true);
    expect(undo.data.undone).toBe('replaceInScripts');
    expect((await session.execute<any>('readScript', { path: 'scripts/a.lua' })).data.source).toBe('local x = 1\n');
    expect((await session.execute<any>('readScript', { path: 'scripts/b.lua' })).data.source).toBe('local x = 2\n');
  });

  it('is surgical: leaves formatting untouched, and suggests formatScript when files changed', async () => {
    const { session } = await makeSession();
    // Deliberately messy indentation the formatter would normally fix — the
    // query only targets the quoted literal, so it must NOT touch anything
    // else, including the unindented body.
    const messy = 'local script = {}\nfunction script.onStart(ctx)\nctx.log("x")\nend\nreturn script\n';
    await session.execute('createScript', { name: 'mover', source: messy, format: false });

    const res = await session.execute<any>('replaceInScripts', { query: '"x"', replacement: '"y"' });
    expect(res.success).toBe(true);
    const read = await session.execute<any>('readScript', { path: 'scripts/mover.lua' });
    expect(read.data.source).toBe('local script = {}\nfunction script.onStart(ctx)\nctx.log("y")\nend\nreturn script\n');
    expect(res.suggestions).toContain('formatScript');
  });

  it('no matches: real run still reports applied:true with an empty changes list', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', { name: 'mover', source: 'local a = 1\n', format: false });
    const res = await session.execute<any>('replaceInScripts', { query: 'zzz', replacement: 'y' });
    expect(res.success).toBe(true);
    expect(res.data.applied).toBe(true);
    expect(res.data.changes).toEqual([]);
    expect(res.data.total).toBe(0);
    expect(res.suggestions).not.toContain('formatScript');
  });

  it('requires code-edit permission', async () => {
    const { session } = await makeSession(['read-only']);
    const res = await session.execute('replaceInScripts', { query: 'x', replacement: 'y' });
    expect(res.success).toBe(false);
    expect(res.errors[0].code).toBe('PERMISSION_DENIED');
  });
});

describe('extractJournalDetail — replaceInScripts', () => {
  it('records changed paths (count > 0) on a real run', () => {
    const detail = extractJournalDetail('replaceInScripts', {
      applied: true,
      total: 2,
      changes: [
        { path: 'scripts/a.lua', count: 1 },
        { path: 'scripts/b.lua', count: 3 },
      ],
    });
    expect(detail).toEqual({ paths: ['scripts/a.lua', 'scripts/b.lua'] });
  });

  it('records no paths on a dryRun (applied:false), even if changes lists would-be edits', () => {
    const detail = extractJournalDetail('replaceInScripts', {
      applied: false,
      total: 1,
      changes: [{ path: 'scripts/a.lua', count: 1 }],
    });
    expect(detail).toEqual({ paths: [] });
  });
});
