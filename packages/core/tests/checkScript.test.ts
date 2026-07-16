/**
 * `checkScript`: a read-only pre-flight syntax check for a script, usable
 * with bare source text or an existing project script by path. Never
 * writes. Shared by editor lint, CLI, and MCP.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession } from '@hearth/core';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return { fs, session: HearthSession.fromStore(store, {}), store };
}

describe('checkScript', () => {
  it('reports a Lua syntax error with line and message matching luaparse', async () => {
    const { session } = await makeSession();
    const result = await session.execute<any>('checkScript', {
      source: 'local x = 1\nlocal y = 2\nif x then\n', // missing "end" -> error at line 4 (EOF)
      language: 'lua',
    });
    expect(result.success).toBe(true);
    expect(result.data.valid).toBe(false);
    expect(result.data.language).toBe('lua');
    expect(result.data.diagnostics.length).toBe(1);
    const diag = result.data.diagnostics[0];
    expect(diag.severity).toBe('error');
    expect(diag.line).toBe(4);
    expect(typeof diag.message).toBe('string');
    expect(diag.message.length).toBeGreaterThan(0);
  });

  it('reports a JS syntax error with line: null — a documented V8 limitation, not a bug (M-1)', async () => {
    const { session } = await makeSession();
    const result = await session.execute<any>('checkScript', {
      source: 'export default {\n  onUpdate(ctx, dt) {\n};\n', // unbalanced braces
      language: 'js',
    });
    expect(result.success).toBe(true);
    expect(result.data.valid).toBe(false);
    expect(result.data.language).toBe('js');
    expect(result.data.diagnostics.length).toBe(1);
    const diag = result.data.diagnostics[0];
    expect(diag.severity).toBe('error');
    // M-1 (waveG final review): `new Function(...)`'s compile-time
    // SyntaxError.stack never carries a `<anonymous>:LINE:COL` frame in
    // current V8 (only `at new Function (<anonymous>)`) — verified live
    // against Node 22 — so `extractJsErrorLine` never matches and every JS
    // syntax error's diagnostic carries `line: null`. This is a *pinned*
    // assertion of that documented behavior, not the old
    // `if (diag.line !== null) { ... }` guard, which could never fire (since
    // the value is always null) and so passed trivially without verifying
    // anything. A `node:vm`-based recompile can recover a real line number,
    // but was reverted after it broke `npm run build:editor` — see
    // `extractJsErrorLine`'s docstring in validate.ts for why. Lua is
    // unaffected: luaparse carries native line info (see the test above) and
    // is Hearth's default scripting language, so this stays documented
    // rather than fixed.
    expect(diag.line).toBeNull();
    expect(typeof diag.message).toBe('string');
    expect(diag.message.length).toBeGreaterThan(0);
  });

  it('valid Lua source -> valid: true, diagnostics: []', async () => {
    const { session } = await makeSession();
    const result = await session.execute<any>('checkScript', {
      source: 'local script = {}\nfunction script.onUpdate(ctx, dt)\nend\nreturn script\n',
      language: 'lua',
    });
    expect(result.success).toBe(true);
    expect(result.data.valid).toBe(true);
    expect(result.data.diagnostics).toEqual([]);
  });

  it('valid JS source -> valid: true, diagnostics: []', async () => {
    const { session } = await makeSession();
    const result = await session.execute<any>('checkScript', {
      source: 'export default {\n  onUpdate(ctx, dt) {}\n};\n',
      language: 'js',
    });
    expect(result.success).toBe(true);
    expect(result.data.valid).toBe(true);
    expect(result.data.diagnostics).toEqual([]);
  });

  it('bare source with no language defaults to lua', async () => {
    const { session } = await makeSession();
    const result = await session.execute<any>('checkScript', {
      source: 'local x = 1\n',
    });
    expect(result.success).toBe(true);
    expect(result.data.language).toBe('lua');
    expect(result.data.valid).toBe(true);
  });

  it('path mode reads an existing project script and infers language from extension', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', {
      name: 'bad-js',
      language: 'js',
      source: 'export default {\n  onUpdate(ctx, dt) {\n};\n',
    });
    const result = await session.execute<any>('checkScript', { path: 'scripts/bad-js.js' });
    expect(result.success).toBe(true);
    expect(result.data.language).toBe('js');
    expect(result.data.valid).toBe(false);
    expect(result.data.diagnostics.length).toBe(1);
  });

  it('path mode reports a missing required module with attempted path and line', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', {
      name: 'player',
      language: 'lua',
      source: 'local script = {}\nlocal noise = require("lib/missing")\nreturn script\n',
    });

    const result = await session.execute<any>('checkScript', { path: 'scripts/player.lua' });

    expect(result.success).toBe(true);
    expect(result.data.valid).toBe(false);
    expect(result.data.diagnostics).toEqual([
      {
        severity: 'error',
        line: 2,
        message: expect.stringContaining('scripts/lib/missing.lua'),
      },
    ]);
  });

  it('path mode reports a require cycle naming the cycle', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', {
      name: 'a',
      language: 'lua',
      source: 'local b = require("b")\nreturn {}\n',
    });
    await session.execute('createScript', {
      name: 'b',
      language: 'lua',
      source: 'local a = require("a")\nreturn {}\n',
    });

    const result = await session.execute<any>('checkScript', { path: 'scripts/a.lua' });

    expect(result.success).toBe(true);
    expect(result.data.valid).toBe(false);
    expect(result.data.diagnostics[0]).toMatchObject({
      severity: 'error',
      line: 1,
      message: expect.stringContaining('require cycle: scripts/a.lua -> scripts/b.lua -> scripts/a.lua'),
    });
  });

  it('path mode accepts a valid require', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', {
      name: 'noise',
      dir: 'lib',
      language: 'lua',
      source: 'return { value = 1 }\n',
    });
    await session.execute('createScript', {
      name: 'player',
      language: 'lua',
      source: 'local script = {}\nlocal noise = require("lib/noise")\nreturn script\n',
    });

    const result = await session.execute<any>('checkScript', { path: 'scripts/player.lua' });

    expect(result.success).toBe(true);
    expect(result.data.valid).toBe(true);
    expect(result.data.diagnostics).toEqual([]);
  });

  it('path mode never writes anything (read-only) even for a broken script', async () => {
    const { session, fs } = await makeSession();
    await session.execute('createScript', { name: 'bad-lua', language: 'lua', source: 'if x then\n' });
    const before = await fs.readFile('/proj/scripts/bad-lua.lua');
    const result = await session.execute<any>('checkScript', { path: 'scripts/bad-lua.lua' });
    expect(result.success).toBe(true);
    expect(result.data.valid).toBe(false);
    const after = await fs.readFile('/proj/scripts/bad-lua.lua');
    expect(after).toBe(before);
  });

  it('path outside scripts/ -> INVALID_INPUT', async () => {
    const { session } = await makeSession();
    const result = await session.execute<any>('checkScript', { path: 'hearth.json' });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_INPUT');
  });

  it('traversal payload scripts/../hearth.json -> INVALID_INPUT (never reads it)', async () => {
    const { session } = await makeSession();
    const result = await session.execute<any>('checkScript', { path: 'scripts/../hearth.json' });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_INPUT');
  });

  it('traversal payload scripts/../scenes/x.json -> INVALID_INPUT', async () => {
    const { session } = await makeSession();
    const result = await session.execute<any>('checkScript', { path: 'scripts/../scenes/x.json' });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_INPUT');
  });

  it('neither source nor path -> INVALID_INPUT', async () => {
    const { session } = await makeSession();
    const result = await session.execute<any>('checkScript', {});
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_INPUT');
  });

  it('is registered as read-only and non-mutating', async () => {
    const { session } = await makeSession();
    // read-only session should still be able to run it
    const readOnly = HearthSession.fromStore(session.store, { granted: ['read-only'] });
    const result = await readOnly.execute<any>('checkScript', { source: 'local x = 1\n' });
    expect(result.success).toBe(true);
  });
});
