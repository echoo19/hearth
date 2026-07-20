/**
 * Core surface: Lua-first script creation, per-script syntax
 * validation, updateSettings, inspectApi, and the regenerated agent docs.
 */
import { describe, it, expect } from 'vitest';
import {
  MemoryFileSystem,
  createProject,
  HearthSession,
  ProjectStore,
  CTX_API,
  generateAgentsMd,
} from '@hearth/core';

async function makeSession(granted?: any) {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return {
    fs,
    session: HearthSession.fromStore(store, granted ? { granted } : {}),
    store,
  };
}

describe('createScript language', () => {
  it('emits a .lua script from the Lua template by default', async () => {
    const { session } = await makeSession();
    const created = await session.execute<any>('createScript', { name: 'Coin Spin' });
    expect(created.success).toBe(true);
    expect(created.data.path).toBe('scripts/coin-spin.lua');
    expect(created.data.language).toBe('lua');

    const read = await session.execute<any>('readScript', { path: 'scripts/coin-spin.lua' });
    expect(read.success).toBe(true);
    expect(read.data.source).toContain('local script = {}');
    expect(read.data.source).toContain('return script');
    expect(read.data.source).toContain('function script.onUpdate(ctx, dt)');
    // The template documents the full ctx surface, incl. v2, and the dot-call rule.
    expect(read.data.source).toContain('ctx.scenes.load(idOrName)');
    expect(read.data.source).toContain('ctx.save(key, value)');
    expect(read.data.source).toContain('ctx.random.next()');
    expect(read.data.source).toContain('ctx.camera.follow(idOrName)');
    expect(read.data.source).toContain('dot, not a colon');
  });

  it('creates a Lua script in a nested scripts directory', async () => {
    const { session, fs } = await makeSession();
    const created = await session.execute<any>('createScript', { name: 'noise', dir: 'lib', language: 'lua' });
    expect(created.success).toBe(true);
    expect(created.data.path).toBe('scripts/lib/noise.lua');
    expect(await fs.exists('/proj/scripts/lib/noise.lua')).toBe(true);
  });

  it('keeps dir optional and creates flat Lua scripts by default', async () => {
    const { session, fs } = await makeSession();
    const created = await session.execute<any>('createScript', { name: 'player' });
    expect(created.success).toBe(true);
    expect(created.data.path).toBe('scripts/player.lua');
    expect(await fs.exists('/proj/scripts/player.lua')).toBe(true);
  });

  it('slugifies dir segments like script names', async () => {
    const { session, fs } = await makeSession();
    const created = await session.execute<any>('createScript', { name: 'noise', dir: 'My Libs', language: 'lua' });
    expect(created.success).toBe(true);
    expect(created.data.path).toBe('scripts/my-libs/noise.lua');
    expect(await fs.exists('/proj/scripts/my-libs/noise.lua')).toBe(true);
  });

  it('rejects traversal payloads in dir', async () => {
    const { session } = await makeSession();
    for (const dir of ['../..', '..', 'lib/../../x']) {
      const created = await session.execute<any>('createScript', { name: 'noise', dir, language: 'lua' });
      expect(created.success).toBe(false);
      expect(created.errors[0].code).toBe('INVALID_INPUT');
    }
  });

  it('normalizes "./lib" to "lib" instead of slugifying "." into "unnamed"', async () => {
    const { session, fs } = await makeSession();
    const created = await session.execute<any>('createScript', { name: 'noise', dir: './lib', language: 'lua' });
    expect(created.success).toBe(true);
    expect(created.data.path).toBe('scripts/lib/noise.lua');
    expect(await fs.exists('/proj/scripts/lib/noise.lua')).toBe(true);
  });

  it('normalizes internal ".." segments that stay inside scripts/', async () => {
    const { session, fs } = await makeSession();
    const created = await session.execute<any>('createScript', { name: 'noise', dir: 'lib/../lib', language: 'lua' });
    expect(created.success).toBe(true);
    expect(created.data.path).toBe('scripts/lib/noise.lua');
    expect(await fs.exists('/proj/scripts/lib/noise.lua')).toBe(true);
  });

  it('treats dir "." as the scripts root', async () => {
    const { session, fs } = await makeSession();
    const created = await session.execute<any>('createScript', { name: 'noise', dir: '.', language: 'lua' });
    expect(created.success).toBe(true);
    expect(created.data.path).toBe('scripts/noise.lua');
    expect(await fs.exists('/proj/scripts/noise.lua')).toBe(true);
  });

  it('rejects an absolute dir instead of silently relativizing it', async () => {
    const { session } = await makeSession();
    const created = await session.execute<any>('createScript', { name: 'noise', dir: '/etc', language: 'lua' });
    expect(created.success).toBe(false);
    expect(created.errors[0].code).toBe('INVALID_INPUT');
  });

  it('rejects creating over an existing nested script path', async () => {
    const { session } = await makeSession();
    await session.execute<any>('createScript', { name: 'noise', dir: 'lib', language: 'lua' });
    const duplicate = await session.execute<any>('createScript', { name: 'noise', dir: 'lib', language: 'lua' });
    expect(duplicate.success).toBe(false);
    expect(duplicate.errors[0].code).toBe('CONFLICT');
  });

  it('emits a .js script from the JS template with language "js"', async () => {
    const { session } = await makeSession();
    const created = await session.execute<any>('createScript', { name: 'Coin Spin', language: 'js' });
    expect(created.success).toBe(true);
    expect(created.data.path).toBe('scripts/coin-spin.js');

    const read = await session.execute<any>('readScript', { path: 'scripts/coin-spin.js' });
    expect(read.data.source).toContain('export default');
    // JS template documents the ctx v2 additions too.
    expect(read.data.source).toContain('ctx.scenes.load(idOrName)');
    expect(read.data.source).toContain('ctx.save(key, value)');
    expect(read.data.source).toContain('ctx.random.next()');
  });

  it('attachScript accepts .lua scripts', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', { name: 'mover' });
    const attach = await session.execute<any>('attachScript', {
      scene: 'Main',
      entity: 'Player',
      script: 'scripts/mover.lua',
    });
    expect(attach.success).toBe(true);
    expect(attach.data.script).toBe('scripts/mover.lua');
  });
});

describe('script syntax validation', () => {
  it('template scripts (both languages) validate clean', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', { name: 'lua-ok' });
    await session.execute('createScript', { name: 'js-ok', language: 'js' });
    const report = await session.execute<any>('validateProject');
    expect(report.data.errors.filter((e: any) => e.code === 'SCRIPT_SYNTAX_ERROR')).toEqual([]);
  });

  it('reports a Lua syntax error with path and line', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', {
      name: 'bad-lua',
      language: 'lua',
      source: 'local x = 1\nlocal y = 2\nif x then\n', // missing "end" -> error at line 4 (EOF)
    });
    const report = await session.execute<any>('validateProject');
    const issue = report.data.errors.find((e: any) => e.code === 'SCRIPT_SYNTAX_ERROR');
    expect(issue).toBeDefined();
    expect(issue.script).toBe('scripts/bad-lua.lua');
    expect(issue.severity).toBe('error');
    expect(typeof issue.line).toBe('number');
    expect(issue.line).toBe(4);
    expect(report.data.valid).toBe(false);
  });

  it('reports a JS syntax error with the script path', async () => {
    const { session } = await makeSession();
    await session.execute('createScript', {
      name: 'bad-js',
      language: 'js',
      source: 'export default {\n  onUpdate(ctx, dt) {\n};\n', // unbalanced braces
    });
    const report = await session.execute<any>('validateProject');
    const issue = report.data.errors.find((e: any) => e.code === 'SCRIPT_SYNTAX_ERROR');
    expect(issue).toBeDefined();
    expect(issue.script).toBe('scripts/bad-js.js');
    expect(issue.severity).toBe('error');
  });

  it('warns about scripts with unknown extensions', async () => {
    const { session, fs } = await makeSession();
    await fs.writeFile('/proj/scripts/typed.ts', 'export default {};\n');
    const report = await session.execute<any>('validateProject');
    const issue = report.data.warnings.find((w: any) => w.code === 'SCRIPT_UNKNOWN_EXTENSION');
    expect(issue).toBeDefined();
    expect(issue.script).toBe('scripts/typed.ts');
    // Unknown extension is a warning, not an error.
    expect(report.data.valid).toBe(true);
  });
});

describe('updateSettings', () => {
  it('deep-merges partial buildSettings including loading', async () => {
    const { session } = await makeSession();
    const first = await session.execute<any>('updateSettings', {
      buildSettings: { title: 'My Game', loading: { spinner: true } },
    });
    expect(first.success).toBe(true);
    expect(first.data.buildSettings.title).toBe('My Game');
    expect(first.data.buildSettings.loading.spinner).toBe(true);
    // Untouched fields keep their defaults.
    expect(first.data.buildSettings.width).toBe(800);
    expect(first.data.buildSettings.loading.backgroundColor).toBe('#000000');

    // A second partial update must not clobber the earlier one.
    const second = await session.execute<any>('updateSettings', {
      buildSettings: { loading: { backgroundColor: '#123456' } },
    });
    expect(second.data.buildSettings.loading.backgroundColor).toBe('#123456');
    expect(second.data.buildSettings.loading.spinner).toBe(true);
    expect(second.data.buildSettings.title).toBe('My Game');
  });

  it('persists settings to hearth.json (reloadable round-trip)', async () => {
    const { session, fs } = await makeSession();
    await session.execute('updateSettings', {
      buildSettings: { width: 1024, loading: { spinner: true } },
    });
    const reloaded = await ProjectStore.load(fs, '/proj');
    expect(reloaded.project.buildSettings.width).toBe(1024);
    expect(reloaded.project.buildSettings.loading.spinner).toBe(true);
  });

  it('sets initialScene by name and validates it exists', async () => {
    const { session, store } = await makeSession();
    await session.execute('createScene', { name: 'Menu' });
    const ok = await session.execute<any>('updateSettings', { initialScene: 'Menu' });
    expect(ok.success).toBe(true);
    expect(ok.data.initialScene).toBe(store.getScene('Menu')!.id);

    const bad = await session.execute('updateSettings', { initialScene: 'NoSuchScene' });
    expect(bad.success).toBe(false);
    expect(bad.errors[0].code).toBe('NOT_FOUND');
  });

  it('replaces input actions per action; empty keys removes', async () => {
    const { session } = await makeSession();
    const set = await session.execute<any>('updateSettings', {
      inputMappings: { actions: { dash: ['ShiftLeft'] } },
    });
    expect(set.success).toBe(true);
    expect(set.data.inputActions.dash).toEqual(['ShiftLeft']);
    // Pre-existing actions survive.
    expect(Object.keys(set.data.inputActions).length).toBeGreaterThan(1);

    const removed = await session.execute<any>('updateSettings', {
      inputMappings: { actions: { dash: [] } },
    });
    expect(removed.data.inputActions.dash).toBeUndefined();
  });

  it('a failed update leaves nothing half-applied', async () => {
    const { session, store } = await makeSession();
    const before = structuredClone(store.project.buildSettings);
    const bad = await session.execute('updateSettings', {
      buildSettings: { title: 'Should Not Stick' },
      initialScene: 'NoSuchScene',
    });
    expect(bad.success).toBe(false);
    expect(store.project.buildSettings).toEqual(before);
  });

  it('requires safe-edit', async () => {
    const { session } = await makeSession(['read-only']);
    const result = await session.execute('updateSettings', { buildSettings: { title: 'x' } });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('PERMISSION_DENIED');
  });

  it('a fresh project defaults codeStyle.formatOnSave to true', async () => {
    const { store } = await makeSession();
    expect(store.project.codeStyle).toEqual({ formatOnSave: true });
  });

  it('deep-merges partial codeStyle', async () => {
    const { session, store } = await makeSession();
    const result = await session.execute<any>('updateSettings', { codeStyle: { formatOnSave: false } });
    expect(result.success).toBe(true);
    expect(result.data.codeStyle).toEqual({ formatOnSave: false });
    expect(store.project.codeStyle.formatOnSave).toBe(false);

    // Passing an empty patch leaves the existing value untouched.
    const again = await session.execute<any>('updateSettings', { codeStyle: {} });
    expect(again.data.codeStyle).toEqual({ formatOnSave: false });
  });
});

describe('inspectApi', () => {
  it('returns the full ctx API with languages and notes', async () => {
    const { session } = await makeSession();
    const result = await session.execute<any>('inspectApi');
    expect(result.success).toBe(true);
    expect(result.data.languages).toEqual(['lua', 'js']);
    expect(result.data.notes.some((n: string) => n.includes('dot'))).toBe(true);
    expect(result.data.api.length).toBe(CTX_API.length);

    const byPath = new Map(result.data.api.map((e: any) => [e.path, e]));
    const scenesLoad = byPath.get('scenes.load') as any;
    expect(scenesLoad.kind).toBe('method');
    expect(scenesLoad.signature).toBe('load(idOrName: string): boolean');
    expect(scenesLoad.example.lua).toContain('ctx.scenes.load(');

    const save = byPath.get('save') as any;
    expect(save.signature).toBe('save(key: string, value: unknown): void');

    const randomNext = byPath.get('random.next') as any;
    expect(randomNext.signature).toBe('next(): number');
    expect(randomNext.description).toContain('deterministic');
  });

  it('is available read-only', async () => {
    const { session } = await makeSession(['read-only']);
    const result = await session.execute('inspectApi');
    expect(result.success).toBe(true);
  });
});

describe('generated agent docs', () => {
  it('AGENTS.md is Lua-first and points at the on-demand ctx reference', () => {
    const md = generateAgentsMd('Doc Game');
    expect(md).toContain('Lua by default');
    expect(md).toContain('dot, not a colon');
    expect(md).toContain('local script = {}');
    expect(md).toContain('ctx.scenes.load("Level")');
    expect(md).toContain('ctx.save("bestScore", score)');
    expect(md).toContain('--language js');
    // The full 81-entry ctx signature dump is no longer inlined every session:
    // AGENTS.md points at `hearth inspect api --json` — the canonical, live
    // reference with per-member Lua/JS examples — so the agent loads exact
    // signatures on demand (when scripting) instead of relearning them on every
    // boot. Accuracy is preserved (inspect api is generated from the same
    // CTX_API); the eager re-read is what's gone.
    expect(md).toContain('hearth inspect api --json');
    expect(CTX_API.length).toBeGreaterThan(0); // inspect api still renders these
  });
});
