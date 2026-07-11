/**
 * Safety net for the "formatting NEVER blocks a save" invariant when the
 * formatter MODULE ITSELF can't be loaded (e.g. a packaged bundle that ships
 * without the stylua/prettier node_modules and without the inline shim). A
 * module-resolution failure must degrade to a verbatim write + FORMAT_FAILED
 * warning, exactly like an unformattable source does — it must never reject
 * the save.
 *
 * We simulate the missing module by mocking the stylua import to throw the
 * same ERR_MODULE_NOT_FOUND-shaped error Node raises when the package isn't
 * installed. Isolated in its own file so the mock doesn't leak into the real
 * formatter tests.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@johnnymorganz/stylua', () => {
  throw new Error("Cannot find package '@johnnymorganz/stylua' imported from format.js");
});

const { MemoryFileSystem, createProject, HearthSession, FormatError, formatSource } = await import('@hearth/core');

const MESSY_LUA = ['local script = {}', 'function script.onStart(ctx)', 'ctx.log("hi")', 'end', 'return script', ''].join(
  '\n',
);

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return { fs, session: HearthSession.fromStore(store, {}) };
}

describe('formatter loader failure (missing module)', () => {
  it('formatSource surfaces the load failure as a FormatError naming the module', async () => {
    await expect(formatSource('lua', MESSY_LUA)).rejects.toBeInstanceOf(FormatError);
    await expect(formatSource('lua', MESSY_LUA)).rejects.toThrow(/@johnnymorganz\/stylua/);
  });

  it('editScript still writes verbatim + FORMAT_FAILED warning (never blocks the save)', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', { name: 'mover', source: 'return {}\n', format: false });

    const res = await session.execute<any>('editScript', { path: 'scripts/mover.lua', source: MESSY_LUA });
    expect(res.success).toBe(true);
    expect(res.data.formatted).toBe(false);
    expect(res.data.source).toBe(MESSY_LUA);
    expect(res.warnings.some((w: any) => w.code === 'FORMAT_FAILED')).toBe(true);

    const read = await session.execute<any>('readScript', { path: 'scripts/mover.lua' });
    expect(read.data.source).toBe(MESSY_LUA);
  });
});
