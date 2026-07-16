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

describe('ScriptModuleRegistry hot-reload seams', () => {
  it('recordEdge records a dependent without loading (the Lua path)', () => {
    const r = new ScriptModuleRegistry(sources);
    r.recordEdge('scripts/lib/noise.lua', 'scripts/player.lua');
    expect([...r.dependentsOf('scripts/lib/noise.lua')]).toEqual(['scripts/player.lua']);
    expect([...r.transitiveDependentsOf('scripts/lib/noise.lua')]).toEqual(['scripts/player.lua']);
  });

  it('clearEdgesFrom drops only the given paths\' OUTGOING edges', () => {
    const r = new ScriptModuleRegistry(sources);
    r.recordEdge('scripts/lib/noise.lua', 'scripts/player.lua');
    r.recordEdge('scripts/lib/noise.lua', 'scripts/enemy.lua');
    r.clearEdgesFrom(['scripts/player.lua']);
    expect([...r.dependentsOf('scripts/lib/noise.lua')]).toEqual(['scripts/enemy.lua']);
  });

  it('stageFor shares memoized values except the invalidated paths and never mutates the parent', () => {
    const r = new ScriptModuleRegistry(sources);
    let libRuns = 0;
    const lib = r.load('scripts/lib/noise.lua', () => { libRuns++; return { n: 1 }; });
    r.load('scripts/player.lua', () => ({ p: 1 }));

    const stagedSources = new Map(sources);
    const staging = r.stageFor(stagedSources, ['scripts/player.lua']);
    // Unaffected module: memo shared, body does NOT re-run, same instance.
    expect(staging.load('scripts/lib/noise.lua', () => { libRuns++; return { n: 2 }; })).toBe(lib);
    expect(libRuns).toBe(1);
    // Invalidated path recompiles in staging...
    const newPlayer = staging.load('scripts/player.lua', () => ({ p: 2 }));
    expect(newPlayer).toEqual({ p: 2 });
    // ...without touching the parent's memo or graph.
    expect(r.load('scripts/player.lua', () => ({ p: 3 }))).toEqual({ p: 1 });
    staging.recordEdge('scripts/lib/noise.lua', 'scripts/player.lua');
    expect(r.dependentsOf('scripts/lib/noise.lua').size).toBe(0);
  });

  it('absorbEdges merges a staging graph; setExport replaces a memoized value', () => {
    const r = new ScriptModuleRegistry(sources);
    const staging = r.stageFor(new Map(sources), []);
    staging.recordEdge('scripts/lib/noise.lua', 'scripts/player.lua');
    r.absorbEdges(staging);
    expect([...r.dependentsOf('scripts/lib/noise.lua')]).toEqual(['scripts/player.lua']);

    r.setExport('scripts/lib/noise.lua', { n: 9 });
    expect(r.load('scripts/lib/noise.lua', () => ({ n: 0 }))).toEqual({ n: 9 });
  });
});
