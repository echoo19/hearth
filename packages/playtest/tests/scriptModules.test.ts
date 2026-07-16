/**
 * Script modules through the playtest loop — the agent-facing verification
 * path. runPlaytest drives a GameSession (shared Lua engine handed to every
 * scene), so a behavior that `require`s a scripts/lib/ helper must load and
 * actually execute here, not only in a standalone SceneRuntime. This is the
 * host that let "require works in unit tests, fails everywhere real" ship;
 * assertNoErrors turns a silent require load-failure into a red playtest.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, ProjectStore, createProject, HearthSession } from '@hearth/core';
import { runPlaytest, createRuntimeHooks } from '@hearth/playtest';

interface Fixture {
  store: ProjectStore;
  session: HearthSession;
}

/** Starter project (Main scene: Camera, Ground, Player) with a lib + behavior pair. */
async function makeRequireProject(
  language: 'lua' | 'js',
  librarySource: string,
  behaviorSource: string,
): Promise<Fixture> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Require Game' });
  const session = HearthSession.fromStore(store, { runtime: createRuntimeHooks() });
  const lib = await session.execute<{ path: string }>('createScript', {
    name: 'walk speed',
    dir: 'lib',
    language,
    source: librarySource,
  });
  expect(lib.success).toBe(true);
  expect(lib.data!.path).toBe(`scripts/lib/walk-speed.${language}`);
  const behavior = await session.execute<{ path: string }>('createScript', {
    name: 'walker',
    language,
    source: behaviorSource,
  });
  expect(behavior.success).toBe(true);
  const attached = await session.execute('attachScript', {
    scene: 'Main',
    entity: 'Player',
    script: behavior.data!.path,
  });
  expect(attached.success).toBe(true);
  return { store, session };
}

/** A playtest that fails on ANY runtime error and requires the walk to have happened. */
async function runWalkPlaytest(fixture: Fixture): Promise<void> {
  const created = await fixture.session.execute<{ playtestId: string }>('createPlaytest', {
    name: 'walk via required helper',
    scene: 'Main',
    steps: [
      { type: 'wait', frames: 60 },
      // Player starts at x=400; the helper's speed (50/s) must have moved it.
      { type: 'assertProperty', entity: 'Player', property: 'Transform.position.x', greaterThan: 430 },
      { type: 'assertNoErrors' },
    ],
  });
  expect(created.success).toBe(true);

  const result = await runPlaytest(fixture.store, 'walk via required helper');
  expect(result.errors).toEqual([]);
  expect(result.steps.map((s) => `${s.type}:${s.passed}`)).toEqual([
    'wait:true',
    'assertProperty:true',
    'assertNoErrors:true',
  ]);
  expect(result.passed).toBe(true);
}

describe('playtests over projects that use require', () => {
  it('a Lua behavior requiring scripts/lib/ passes a playtest end-to-end', async () => {
    const fixture = await makeRequireProject(
      'lua',
      'return { speed = function() return 50 end }',
      [
        "local lib = require('lib/walk-speed')",
        'local script = {}',
        'function script.onUpdate(ctx, dt)',
        '  ctx.transform.position.x = ctx.transform.position.x + lib.speed() * dt',
        'end',
        'return script',
      ].join('\n'),
    );
    await runWalkPlaytest(fixture);
  });

  it('a JS behavior requiring scripts/lib/ passes a playtest end-to-end', async () => {
    const fixture = await makeRequireProject(
      'js',
      'export default { speed() { return 50; } };',
      `const lib = require('lib/walk-speed');
export default {
  onUpdate(ctx, dt) {
    ctx.transform.position.x += lib.speed() * dt;
  },
};`,
    );
    await runWalkPlaytest(fixture);
  });
});
