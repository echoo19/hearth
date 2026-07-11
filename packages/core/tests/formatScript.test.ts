/**
 * Format-on-save in editScript/createScript, and the standalone formatScript
 * command. Formatting never blocks a save: an unformattable-but-writeable
 * source falls back to a verbatim write plus a warnings[] entry.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession } from '@hearth/core';

const MESSY_LUA = [
  'local script = {}',
  'function script.onStart(ctx)',
  'ctx.log("hi")',
  'end',
  'return script',
  '',
].join('\n');

const CLEAN_LUA = [
  'local script = {}',
  'function script.onStart(ctx)',
  '  ctx.log("hi")',
  'end',
  'return script',
  '',
].join('\n');

const MESSY_JS = 'export default {onStart(ctx){ctx.log("hi")}}\n';

// Missing "end" — stylua cannot format it, but editScript must still save it.
const BROKEN_LUA = 'local x = 1\nif x then\n';

async function makeSession(granted?: any) {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return {
    fs,
    session: HearthSession.fromStore(store, granted ? { granted } : {}),
    store,
  };
}

describe('editScript format-on-save', () => {
  it('reformats a messy lua file on save and returns formatted:true + final source', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', { name: 'mover', source: 'return {}\n' });
    const res = await session.execute<any>('editScript', { path: 'scripts/mover.lua', source: MESSY_LUA });
    expect(res.success).toBe(true);
    expect(res.data.formatted).toBe(true);
    expect(res.data.source).toBe(CLEAN_LUA);

    const read = await session.execute<any>('readScript', { path: 'scripts/mover.lua' });
    expect(read.data.source).toBe(CLEAN_LUA);
  });

  it('reformats messy JS on save', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', { name: 'mover', language: 'js', source: 'export default {};\n' });
    const res = await session.execute<any>('editScript', { path: 'scripts/mover.js', source: MESSY_JS });
    expect(res.success).toBe(true);
    expect(res.data.formatted).toBe(true);
    expect(res.data.source).toContain('  onStart(ctx) {');
    expect(res.data.source).toContain('ctx.log("hi");');
  });

  it('format:false writes verbatim even when formatOnSave is on', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', { name: 'mover', source: 'return {}\n' });
    const res = await session.execute<any>('editScript', {
      path: 'scripts/mover.lua',
      source: MESSY_LUA,
      format: false,
    });
    expect(res.data.formatted).toBe(false);
    expect(res.data.source).toBe(MESSY_LUA);
    const read = await session.execute<any>('readScript', { path: 'scripts/mover.lua' });
    expect(read.data.source).toBe(MESSY_LUA);
  });

  it('project codeStyle.formatOnSave:false writes verbatim by default, format:true forces', async () => {
    const { session } = await makeSession();
    await session.execute('updateSettings', { codeStyle: { formatOnSave: false } });
    await session.execute('createScript', { name: 'mover', source: 'return {}\n' });

    const off = await session.execute<any>('editScript', { path: 'scripts/mover.lua', source: MESSY_LUA });
    expect(off.data.formatted).toBe(false);
    expect(off.data.source).toBe(MESSY_LUA);

    const forced = await session.execute<any>('editScript', {
      path: 'scripts/mover.lua',
      source: MESSY_LUA,
      format: true,
    });
    expect(forced.data.formatted).toBe(true);
    expect(forced.data.source).toBe(CLEAN_LUA);
  });

  it('formatter failure falls back to a verbatim write plus a warning (never blocks the save)', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', { name: 'mover', source: 'return {}\n' });
    const res = await session.execute<any>('editScript', { path: 'scripts/mover.lua', source: BROKEN_LUA });
    expect(res.success).toBe(true);
    expect(res.data.formatted).toBe(false);
    expect(res.data.source).toBe(BROKEN_LUA);
    expect(res.warnings.some((w: any) => w.code === 'FORMAT_FAILED')).toBe(true);

    const read = await session.execute<any>('readScript', { path: 'scripts/mover.lua' });
    expect(read.data.source).toBe(BROKEN_LUA);
  });
});

describe('createScript format-on-save', () => {
  it('formats custom source and returns { source, formatted }', async () => {
    const { session } = await makeSession();
    const res = await session.execute<any>('createScript', { name: 'mover', source: MESSY_LUA });
    expect(res.success).toBe(true);
    expect(res.data.formatted).toBe(true);
    expect(res.data.source).toBe(CLEAN_LUA);
    const read = await session.execute<any>('readScript', { path: 'scripts/mover.lua' });
    expect(read.data.source).toBe(CLEAN_LUA);
  });

  it('formatter failure on custom source falls back to a verbatim write plus a warning', async () => {
    const { session } = await makeSession();
    const res = await session.execute<any>('createScript', { name: 'broken', source: BROKEN_LUA });
    expect(res.success).toBe(true);
    expect(res.data.formatted).toBe(false);
    expect(res.data.source).toBe(BROKEN_LUA);
    expect(res.warnings.some((w: any) => w.code === 'FORMAT_FAILED')).toBe(true);
  });
});

describe('formatScript command', () => {
  it('requires exactly one of path or all (INVALID_INPUT otherwise)', async () => {
    const { session } = await makeSession();
    const none = await session.execute('formatScript', {});
    expect(none.success).toBe(false);
    expect(none.errors[0].code).toBe('INVALID_INPUT');

    await session.execute('createScript', { name: 'mover', source: 'return {}\n' });
    const both = await session.execute('formatScript', { path: 'scripts/mover.lua', all: true });
    expect(both.success).toBe(false);
    expect(both.errors[0].code).toBe('INVALID_INPUT');
  });

  it('formats a single path and reports changed accurately', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', { name: 'mover', source: MESSY_LUA, format: false });

    const res = await session.execute<any>('formatScript', { path: 'scripts/mover.lua' });
    expect(res.success).toBe(true);
    expect(res.data.results).toEqual([{ path: 'scripts/mover.lua', changed: true }]);
    const read = await session.execute<any>('readScript', { path: 'scripts/mover.lua' });
    expect(read.data.source).toBe(CLEAN_LUA);

    // Re-running on an already-clean file reports changed:false.
    const again = await session.execute<any>('formatScript', { path: 'scripts/mover.lua' });
    expect(again.data.results).toEqual([{ path: 'scripts/mover.lua', changed: false }]);
  });

  it('all: reformats every .lua/.js under scripts/, skips .ts with a warning', async () => {
    const { session, fs } = await makeSession();
    await session.execute('createScript', { name: 'a', source: MESSY_LUA, format: false });
    await session.execute('createScript', { name: 'b', language: 'js', source: MESSY_JS, format: false });
    await fs.writeFile('/proj/scripts/typed.ts', 'export default {}\n');

    const res = await session.execute<any>('formatScript', { all: true });
    expect(res.success).toBe(true);
    const byPath = new Map(res.data.results.map((r: any) => [r.path, r.changed]));
    expect(byPath.get('scripts/a.lua')).toBe(true);
    expect(byPath.get('scripts/b.js')).toBe(true);
    expect(byPath.has('scripts/typed.ts')).toBe(false);
    expect(res.warnings.some((w: any) => w.message.includes('typed.ts'))).toBe(true);
  });

  it('path pointing at a non-formattable extension (.ts) is skipped with a warning, not misformatted', async () => {
    const { session, fs } = await makeSession();
    const original = 'export default {}\n';
    await fs.writeFile('/proj/scripts/typed.ts', original);

    const res = await session.execute<any>('formatScript', { path: 'scripts/typed.ts' });
    expect(res.success).toBe(true);
    // Matches the all branch: skipped files are excluded from results entirely.
    expect(res.data.results).toEqual([]);
    expect(
      res.warnings.some((w: any) => w.code === 'SCRIPT_UNKNOWN_EXTENSION' && w.message.includes('typed.ts')),
    ).toBe(true);
    // Bytes untouched.
    expect(await fs.readFile('/proj/scripts/typed.ts')).toBe(original);
  });

  it('formatter failure warns and leaves that file unchanged', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', { name: 'broken', source: BROKEN_LUA });
    const res = await session.execute<any>('formatScript', { path: 'scripts/broken.lua' });
    expect(res.success).toBe(true);
    expect(res.data.results).toEqual([{ path: 'scripts/broken.lua', changed: false }]);
    expect(res.warnings.some((w: any) => w.code === 'FORMAT_FAILED')).toBe(true);
  });

  it('suggests validateProject', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', { name: 'mover', source: MESSY_LUA, format: false });
    const res = await session.execute<any>('formatScript', { path: 'scripts/mover.lua' });
    expect(res.suggestions).toContain('validateProject');
  });

  it('one formatScript touching N files undoes atomically with ONE undo', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', { name: 'a', source: MESSY_LUA, format: false });
    await session.execute('createScript', { name: 'b', source: MESSY_LUA, format: false });

    const res = await session.execute<any>('formatScript', { all: true });
    expect(res.success).toBe(true);
    expect((await session.execute<any>('readScript', { path: 'scripts/a.lua' })).data.source).toBe(CLEAN_LUA);
    expect((await session.execute<any>('readScript', { path: 'scripts/b.lua' })).data.source).toBe(CLEAN_LUA);

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(true);
    expect(undo.data.undone).toBe('formatScript');
    expect((await session.execute<any>('readScript', { path: 'scripts/a.lua' })).data.source).toBe(MESSY_LUA);
    expect((await session.execute<any>('readScript', { path: 'scripts/b.lua' })).data.source).toBe(MESSY_LUA);
  });

  it('requires code-edit permission', async () => {
    const { session } = await makeSession(['read-only']);
    const res = await session.execute('formatScript', { all: true });
    expect(res.success).toBe(false);
    expect(res.errors[0].code).toBe('PERMISSION_DENIED');
  });
});

describe('extractJournalDetail — formatScript', () => {
  it('records only the changed paths', async () => {
    const { extractJournalDetail } = await import('@hearth/core');
    const detail = extractJournalDetail('formatScript', {
      results: [
        { path: 'scripts/a.lua', changed: true },
        { path: 'scripts/b.lua', changed: false },
      ],
    });
    expect(detail).toEqual({ paths: ['scripts/a.lua'] });
  });
});
