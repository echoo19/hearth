/**
 * searchScripts: read-only search across scripts/ for a plain-text or
 * regex query, returning 1-based line/column plus a centered preview per
 * match. Matching is line-based (no multiline patterns).
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession } from '@hearth/core';

async function makeSession(granted?: any) {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return { fs, session: HearthSession.fromStore(store, granted ? { granted } : {}), store };
}

const LUA_SOURCE = ['local script = {}', 'function script.onUpdate(ctx, dt)', '  ctx.log("update tick")', 'end', 'return script', ''].join(
  '\n',
);

const JS_SOURCE = ['export default {', '  onUpdate(ctx, dt) {', '    ctx.log("update tick");', '  },', '};', ''].join('\n');

describe('searchScripts', () => {
  it('finds plain-text matches across lua and js with 1-based line/column and a preview', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', { name: 'mover', source: LUA_SOURCE, format: false });
    await session.execute('createScript', { name: 'mover-js', language: 'js', source: JS_SOURCE, format: false });

    const res = await session.execute<any>('searchScripts', { query: 'update tick' });
    expect(res.success).toBe(true);
    expect(res.data.total).toBe(2);
    expect(res.data.capped).toBe(false);

    const byPath = new Map(res.data.matches.map((m: any) => [m.path, m]));
    const luaMatch = byPath.get('scripts/mover.lua')!;
    expect(luaMatch.line).toBe(3);
    expect(luaMatch.column).toBe(LUA_SOURCE.split('\n')[2].indexOf('update tick') + 1);
    expect(luaMatch.preview).toContain('update tick');

    const jsMatch = byPath.get('scripts/mover-js.js')!;
    expect(jsMatch.line).toBe(3);
    expect(jsMatch.column).toBe(JS_SOURCE.split('\n')[2].indexOf('update tick') + 1);
  });

  it('is case-insensitive by default; caseSensitive:true narrows to an exact-case match', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', { name: 'mover', source: LUA_SOURCE, format: false });

    const insensitive = await session.execute<any>('searchScripts', { query: 'UPDATE TICK' });
    expect(insensitive.success).toBe(true);
    expect(insensitive.data.total).toBe(1);

    const sensitive = await session.execute<any>('searchScripts', { query: 'UPDATE TICK', caseSensitive: true });
    expect(sensitive.success).toBe(true);
    expect(sensitive.data.total).toBe(0);
  });

  it('regex mode matches a pattern', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', { name: 'mover', source: LUA_SOURCE, format: false });

    const res = await session.execute<any>('searchScripts', { query: 'onUpdate\\(ctx, \\w+\\)', regex: true });
    expect(res.success).toBe(true);
    expect(res.data.total).toBe(1);
    expect(res.data.matches[0].line).toBe(2);
  });

  it('pathGlob filters to matching scripts only', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', { name: 'goblin', source: LUA_SOURCE, format: false });
    await session.execute('createScript', { name: 'mover', source: LUA_SOURCE, format: false });

    const res = await session.execute<any>('searchScripts', { query: 'update tick', pathGlob: 'scripts/gob*' });
    expect(res.success).toBe(true);
    expect(res.data.total).toBe(1);
    expect(res.data.matches.every((m: any) => m.path === 'scripts/goblin.lua')).toBe(true);
  });

  it('invalid regex surfaces INVALID_INPUT carrying the engine message, no stack', async () => {
    const { session } = await makeSession();
    const res = await session.execute<any>('searchScripts', { query: '[', regex: true });
    expect(res.success).toBe(false);
    expect(res.errors[0].code).toBe('INVALID_INPUT');
    expect(res.errors[0].message).toContain('Invalid regular expression');
    expect(res.errors[0].message).not.toContain('    at '); // no stack frames leaked into the message
  });

  it('caps matches at 500 and flags capped:true with a narrowing suggestion', async () => {
    const { session } = await makeSession();
    const lines = Array.from({ length: 501 }, () => 'ctx.log("marker")');
    await session.execute('createScript', { name: 'many', source: lines.join('\n'), format: false });

    const res = await session.execute<any>('searchScripts', { query: 'marker' });
    expect(res.success).toBe(true);
    expect(res.data.matches.length).toBe(500);
    expect(res.data.total).toBe(501);
    expect(res.data.capped).toBe(true);
    expect(res.suggestions.some((s: string) => s.toLowerCase().includes('pathglob'))).toBe(true);
  });

  it('centers and trims the preview to at most 120 chars', async () => {
    const { session } = await makeSession();
    const longLine = 'local pad = "' + 'a'.repeat(200) + 'MARKER' + 'b'.repeat(200) + '"';
    await session.execute('createScript', { name: 'long', source: longLine, format: false });

    const res = await session.execute<any>('searchScripts', { query: 'MARKER' });
    expect(res.success).toBe(true);
    expect(res.data.matches.length).toBe(1);
    const preview = res.data.matches[0].preview;
    expect(preview.length).toBeLessThanOrEqual(120);
    expect(preview).toContain('MARKER');
  });
});
