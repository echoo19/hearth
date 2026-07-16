/**
 * Script modules, human surface (Wave N): the pure models behind the Code
 * panel's script tree and the library classification —
 *  - buildScriptRows: nested scripts/lib/noise.lua renders as a tree (folder
 *    rows + depth), never 25 flat rows; flat projects are unchanged.
 *  - librariesFrom / HOOK_SEARCH_PATTERN: a hookless script classifies as a
 *    library; classification fails SAFE (toward "behavior") on a capped
 *    search or a hook name in a comment.
 *  - lastScriptChangeSeq: the reclassify trigger follows script-touching
 *    journal entries only.
 */
import { describe, expect, it } from 'vitest';
import { buildScriptRows } from '../src/components/code/ScriptTree';
import { HOOK_SEARCH_PATTERN, librariesFrom, lastScriptChangeSeq } from '../src/scriptKinds';
import type { JournalEntry } from '../src/types';

const NESTED = ['scripts/player.lua', 'scripts/lib/noise.lua', 'scripts/lib/gen/cave.lua', 'scripts/enemy.lua'];

describe('buildScriptRows', () => {
  it('renders nested paths as a tree, not flat rows', () => {
    const rows = buildScriptRows(NESTED, new Set());
    const byId = new Map(rows.map((r) => [r.id, r]));
    // The folder exists as its own row…
    expect(byId.get('scripts/lib')).toMatchObject({ kind: 'folder', name: 'lib', depth: 0, hasChildren: true });
    // …and the nested script sits UNDER it, not beside the flat scripts.
    expect(byId.get('scripts/lib/noise.lua')).toMatchObject({
      kind: 'script',
      name: 'noise.lua',
      depth: 1,
      parentId: 'scripts/lib',
    });
    expect(byId.get('scripts/lib/gen/cave.lua')).toMatchObject({ depth: 2, parentId: 'scripts/lib/gen' });
    expect(byId.get('scripts/player.lua')).toMatchObject({ kind: 'script', depth: 0, parentId: null });
  });

  it('pre-orders folders first, then scripts, alphabetically', () => {
    const rows = buildScriptRows(NESTED, new Set());
    expect(rows.map((r) => r.id)).toEqual([
      'scripts/lib',
      'scripts/lib/gen',
      'scripts/lib/gen/cave.lua',
      'scripts/lib/noise.lua',
      'scripts/enemy.lua',
      'scripts/player.lua',
    ]);
  });

  it('hides the subtree of a collapsed folder', () => {
    const rows = buildScriptRows(NESTED, new Set(['scripts/lib']));
    expect(rows.map((r) => r.id)).toEqual(['scripts/lib', 'scripts/enemy.lua', 'scripts/player.lua']);
  });

  it('leaves a flat project as depth-0 script rows (no folders)', () => {
    const rows = buildScriptRows(['scripts/b.lua', 'scripts/a.lua'], new Set());
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === 'script' && r.depth === 0 && r.parentId === null)).toBe(true);
    expect(rows.map((r) => r.name)).toEqual(['a.lua', 'b.lua']);
  });
});

describe('HOOK_SEARCH_PATTERN', () => {
  const re = () => new RegExp(HOOK_SEARCH_PATTERN, 'g'); // same flags as the engine's caseSensitive regex mode

  it('matches every lifecycle hook declaration shape, in both languages', () => {
    for (const line of [
      'function script.onStart(ctx)', // Lua function statement
      'script.onUpdate = function(ctx, dt)', // Lua assignment
      'return { onCollision = function(ctx, other) end }', // Lua table field
      'onUiEvent(ctx, event) {', // JS shorthand method
      'onEvent: (ctx, name, data) => {},', // JS property arrow
    ]) {
      expect(line).toMatch(re());
    }
  });

  it('does not match a hookless library', () => {
    const noiseLua = ['local noise = {}', 'function noise.value(x, y, seed)', '  return 0.5', 'end', 'return noise'].join(
      '\n',
    );
    expect(noiseLua).not.toMatch(re());
    // Nor near-miss names — \b plus the trailing =/:/( keep these out.
    expect('function lib.onUpdater(x)').not.toMatch(re());
    expect('local honUpdate = 1').not.toMatch(re());
  });
});

describe('librariesFrom', () => {
  const scripts = ['scripts/player.lua', 'scripts/lib/noise.lua'];

  it('classifies the scripts with no hook match as libraries', () => {
    expect(librariesFrom(scripts, ['scripts/player.lua'], false)).toEqual(new Set(['scripts/lib/noise.lua']));
  });

  it('classifies nothing when the search was capped (classification unknown)', () => {
    expect(librariesFrom(scripts, ['scripts/player.lua'], true)).toEqual(new Set());
  });

  it('tolerates duplicate match paths (one per matching line)', () => {
    const matches = ['scripts/player.lua', 'scripts/player.lua', 'scripts/player.lua'];
    expect(librariesFrom(scripts, matches, false)).toEqual(new Set(['scripts/lib/noise.lua']));
  });
});

describe('lastScriptChangeSeq', () => {
  function entry(seq: number, command: string, ok = true): JournalEntry {
    return { seq, ts: '2026-07-15T00:00:00Z', source: 'cli', command, summary: '', ok };
  }

  it('returns the newest OK script-touching entry', () => {
    const feed = [entry(1, 'editScript'), entry(2, 'createEntity'), entry(3, 'replaceInScripts'), entry(4, 'moveEntity')];
    expect(lastScriptChangeSeq(feed)).toBe(3);
  });

  it('skips failed entries and returns 0 when nothing touched a script', () => {
    expect(lastScriptChangeSeq([entry(1, 'editScript', false), entry(2, 'createEntity')])).toBe(0);
    expect(lastScriptChangeSeq([])).toBe(0);
  });
});
