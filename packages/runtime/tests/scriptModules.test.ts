import { describe, expect, it } from 'vitest';
import { ScriptModuleRegistry } from '../src/scriptModules.js';

const sources = new Map([
  ['scripts/lib/noise.lua', 'return { n = 1 }'],
  ['scripts/player.lua', 'return {}'],
]);

describe('ScriptModuleRegistry.resolve', () => {
  it('resolves a spec against the scripts root, inferring the requirer extension', () => {
    const r = new ScriptModuleRegistry(sources);
    expect(r.resolve('lib/noise', 'scripts/player.lua')).toBe('scripts/lib/noise.lua');
  });

  it('accepts an explicit extension', () => {
    const r = new ScriptModuleRegistry(sources);
    expect(r.resolve('lib/noise.lua', 'scripts/player.lua')).toBe('scripts/lib/noise.lua');
  });

  it('rejects escaping the scripts root', () => {
    const r = new ScriptModuleRegistry(sources);
    expect(() => r.resolve('../../secrets', 'scripts/player.lua')).toThrow(/outside/i);
  });

  it('rejects a cross-language require', () => {
    const r = new ScriptModuleRegistry(new Map([...sources, ['scripts/util.js', 'export default {}']]));
    expect(() => r.resolve('util.js', 'scripts/player.lua')).toThrow(/same language|\.lua/i);
  });

  it('names the missing path when unresolvable', () => {
    const r = new ScriptModuleRegistry(sources);
    expect(() => r.resolve('lib/missing', 'scripts/player.lua')).toThrow(/scripts\/lib\/missing\.lua/);
  });
});

describe('ScriptModuleRegistry.load', () => {
  it('runs a module body exactly once and memoizes its exports', () => {
    let runs = 0;
    const r = new ScriptModuleRegistry(sources);
    const compile = (path: string): unknown => { runs++; return { path }; };
    expect(r.load('scripts/lib/noise.lua', compile)).toEqual({ path: 'scripts/lib/noise.lua' });
    expect(r.load('scripts/lib/noise.lua', compile)).toEqual({ path: 'scripts/lib/noise.lua' });
    expect(runs).toBe(1);
  });

  it('throws naming the full cycle path', () => {
    const r = new ScriptModuleRegistry(sources);
    const compile = (path: string): unknown => {
      if (path === 'scripts/player.lua') return r.load('scripts/lib/noise.lua', compile);
      return r.load('scripts/player.lua', compile);
    };
    expect(() => r.load('scripts/player.lua', compile)).toThrow(/cycle/i);
  });

  it('records dependents for hot reload', () => {
    const r = new ScriptModuleRegistry(sources);
    r.load('scripts/player.lua', (path) => {
      if (path === 'scripts/player.lua') r.load('scripts/lib/noise.lua', () => ({}), 'scripts/player.lua');
      return {};
    });
    expect([...r.dependentsOf('scripts/lib/noise.lua')]).toContain('scripts/player.lua');
  });
});
