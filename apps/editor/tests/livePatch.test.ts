import { describe, it, expect } from 'vitest';
import { classifyLocal, classifyJournal, type LiveAction } from '../src/livePatch';
import type { JournalEntry } from '../src/types';

/**
 * Pure classification coverage for the live-update dispatcher. `classifyLocal`
 * turns a just-succeeded local exec (command + params + result data) into the
 * live actions the store applies against the running preview; `classifyJournal`
 * does the same for an external (CLI/MCP) journal entry pushed over the WS
 * channel. Both are pure — no store, no DOM, no runtime — so the whole
 * decision table is exercised here and the store wiring stays thin.
 *
 * Invariants that must never break:
 *  - Local property edits always carry the value (params are in scope), so
 *    live-patching works fully for anything done in the editor.
 *  - A mutating command we can't map to a patch/reload falls back to
 *    'structural' (restart badge) — never a guessed patch.
 *  - `source: 'editor'` journal entries produce nothing (they already came
 *    through exec()); failed external commands produce nothing.
 */

const kinds = (actions: LiveAction[]) => actions.map((a) => a.kind);

describe('classifyLocal', () => {
  it('setComponentProperty → one patch carrying the value', () => {
    const actions = classifyLocal(
      'setComponentProperty',
      { scene: 'main', entity: 'e1', property: 'Camera.ambientLight', value: 0.5 },
      { entityId: 'e1', property: 'Camera.ambientLight', value: 0.5 },
    );
    expect(actions).toEqual([
      { kind: 'patch', scene: 'main', entity: 'e1', property: 'Camera.ambientLight', value: 0.5, hasValue: true },
    ]);
  });

  it('setComponentProperty preserves falsy values (0/false/null) with hasValue true', () => {
    for (const value of [0, false, null, '']) {
      const [action] = classifyLocal(
        'setComponentProperty',
        { scene: 'main', entity: 'e1', property: 'SpriteRenderer.visible', value },
        {},
      );
      expect(action).toMatchObject({ kind: 'patch', value, hasValue: true });
    }
  });

  it('setProperties → one patch per key, each with its value', () => {
    const actions = classifyLocal(
      'setProperties',
      {
        scene: 'main',
        entity: 'e1',
        properties: { 'Transform.position.x': 100, 'SpriteRenderer.width': 64 },
      },
      {},
    );
    expect(actions).toEqual([
      { kind: 'patch', scene: 'main', entity: 'e1', property: 'Transform.position.x', value: 100, hasValue: true },
      { kind: 'patch', scene: 'main', entity: 'e1', property: 'SpriteRenderer.width', value: 64, hasValue: true },
    ]);
  });

  it('moveEntity with a position (no reparent) → a Transform.position patch', () => {
    const actions = classifyLocal(
      'moveEntity',
      { scene: 'main', entity: 'e1', position: { x: 12, y: 34 } },
      { entityId: 'e1', position: { x: 12, y: 34 }, parentId: null },
    );
    expect(actions).toEqual([
      { kind: 'patch', scene: 'main', entity: 'e1', property: 'Transform.position', value: { x: 12, y: 34 }, hasValue: true },
    ]);
  });

  it('moveEntity that reparents → structural (hierarchy change needs a restart)', () => {
    expect(kinds(classifyLocal('moveEntity', { scene: 'main', entity: 'e1', parent: 'e2' }, {}))).toEqual(['structural']);
    // position + reparent in one call is still structural (the reparent dominates).
    expect(
      kinds(classifyLocal('moveEntity', { scene: 'main', entity: 'e1', position: { x: 1, y: 2 }, parent: null }, {})),
    ).toEqual(['structural']);
  });

  it('editScript → reload, preferring the post-format path from result data', () => {
    const actions = classifyLocal(
      'editScript',
      { path: 'foo.lua', source: 'print(1)' },
      { path: 'scripts/foo.lua', lines: 1, source: 'print(1)\n', formatted: true },
    );
    expect(actions).toEqual([{ kind: 'reload', path: 'scripts/foo.lua' }]);
  });

  it('editScript falls back to the params path when result data is unusable', () => {
    const actions = classifyLocal('editScript', { path: 'scripts/bar.lua', source: 'x=1' }, null);
    expect(actions).toEqual([{ kind: 'reload', path: 'scripts/bar.lua' }]);
  });

  it('formatScript → a reload per changed file only', () => {
    const actions = classifyLocal('formatScript', {}, {
      results: [
        { path: 'scripts/a.lua', changed: true },
        { path: 'scripts/b.lua', changed: false },
        { path: 'scripts/c.lua', changed: true },
      ],
    });
    expect(actions).toEqual([
      { kind: 'reload', path: 'scripts/a.lua' },
      { kind: 'reload', path: 'scripts/c.lua' },
    ]);
  });

  it('replaceInScripts → a reload per file actually edited', () => {
    const actions = classifyLocal('replaceInScripts', {}, {
      applied: true,
      changes: [
        { path: 'scripts/a.lua', count: 3 },
        { path: 'scripts/b.lua', count: 0 },
      ],
    });
    expect(actions).toEqual([{ kind: 'reload', path: 'scripts/a.lua' }]);
  });

  it('replaceInScripts dry run → nothing (no reloads, no badge)', () => {
    const actions = classifyLocal('replaceInScripts', {}, { applied: false, changes: [{ path: 'scripts/a.lua', count: 3 }] });
    expect(actions).toEqual([]);
  });

  it('structural commands → a single structural action (restart badge)', () => {
    for (const cmd of ['createEntity', 'removeComponent', 'attachScript', 'updateSettings', 'importAsset', 'addComponent', 'deleteEntity', 'createScript']) {
      expect(kinds(classifyLocal(cmd, {}, {}))).toEqual(['structural']);
    }
  });

  it('an unknown mutating command → structural (fail safe, never a guessed patch)', () => {
    expect(kinds(classifyLocal('someFutureCommand', {}, {}))).toEqual(['structural']);
  });

  it('read-only commands → none', () => {
    for (const cmd of ['inspectScene', 'inspectProject', 'listScenes', 'readScript', 'validateProject', 'runScene']) {
      expect(kinds(classifyLocal(cmd, {}, {}))).toEqual(['none']);
    }
  });
});

describe('classifyJournal', () => {
  const entry = (over: Partial<JournalEntry>): JournalEntry => ({
    seq: 1,
    ts: '2026-01-01T00:00:00.000Z',
    source: 'cli',
    command: 'editScript',
    summary: '',
    ok: true,
    ...over,
  });

  it('editor-sourced entries → none (they already came through exec)', () => {
    expect(kinds(classifyJournal(entry({ source: 'editor', command: 'setComponentProperty' })))).toEqual(['none']);
  });

  it('failed external commands → none (nothing landed to mirror)', () => {
    expect(kinds(classifyJournal(entry({ ok: false, command: 'editScript', detail: { path: 'scripts/a.lua' } })))).toEqual(['none']);
  });

  it('external editScript → reload from detail.path', () => {
    expect(classifyJournal(entry({ command: 'editScript', detail: { path: 'scripts/a.lua' } }))).toEqual([
      { kind: 'reload', path: 'scripts/a.lua' },
    ]);
  });

  it('external formatScript → a reload per changed path in detail.paths', () => {
    expect(
      classifyJournal(entry({ command: 'formatScript', detail: { paths: ['scripts/a.lua', 'scripts/b.lua'] } })),
    ).toEqual([
      { kind: 'reload', path: 'scripts/a.lua' },
      { kind: 'reload', path: 'scripts/b.lua' },
    ]);
  });

  it('external property edits carry no journal detail → structural (honest fallback)', () => {
    // setComponentProperty/setProperties emit no journal detail in core, so an
    // external one is indistinguishable from any other mutating command: badge.
    expect(kinds(classifyJournal(entry({ command: 'setComponentProperty' })))).toEqual(['structural']);
    expect(kinds(classifyJournal(entry({ command: 'setProperties' })))).toEqual(['structural']);
  });

  it('an unknown external mutating command with no detail → structural', () => {
    expect(kinds(classifyJournal(entry({ command: 'someFutureCommand' })))).toEqual(['structural']);
  });

  it('read-only journaled commands (validateProject) → none', () => {
    expect(kinds(classifyJournal(entry({ command: 'validateProject', detail: { errors: 0, warnings: 0 } })))).toEqual(['none']);
  });

  it('a detail carrying an explicit patch target → a valueless patch (resolved post-refresh)', () => {
    // Forward-compatible: if a command ever records {scene,entity,property} in
    // its journal detail, mirror it as a patch with hasValue:false so the store
    // resolves the current value after refresh(). No core command emits this today.
    expect(
      classifyJournal(entry({ command: 'someLiveCommand', detail: { scene: 'main', entity: 'e1', property: 'Camera.ambientLight' } })),
    ).toEqual([{ kind: 'patch', scene: 'main', entity: 'e1', property: 'Camera.ambientLight', hasValue: false }]);
  });
});
