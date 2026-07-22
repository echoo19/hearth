/**
 * Sweep + bake integration: the flagship bake round-trip (a mash run that
 * provokes a scripted crash bakes into a playtest that reproduces the crash at
 * the same frame), a passing bake staying green, the token-frugal sweep report
 * (failure cap, repro/bake strings, sequential report files), and coverage /
 * heatmap gating. Everything runs through the real RuntimeHooks + HearthSession,
 * so this exercises the whole command path end to end.
 *
 * Projects are built in memory the same way bots.test.ts / playtest.test.ts do.
 */
import { describe, it, expect } from 'vitest';
import {
  MemoryFileSystem,
  ProjectStore,
  SceneSchema,
  PlaytestSchema,
  createProject,
  HearthSession,
  type RuntimeHooks,
} from '@hearth/core';
import { createRuntimeHooks, runBotRun, type BotRunConfig } from '@hearth/playtest';

// --- scripts --------------------------------------------------------------

/** Moves right only while 'right' is held, then throws once it has gone too far. */
const RIGHT_THROWER = `export default {
  onUpdate(ctx) {
    if (ctx.input.isDown('right')) ctx.transform.position.x += 4;
    if (ctx.transform.position.x >= 12) throw new Error('too far right');
  },
};`;
/** Moves on input, never throws — a benign avatar for the passing-bake case. */
const INPUT_MOVER = `export default {
  onUpdate(ctx) {
    if (ctx.input.isDown('right')) ctx.transform.position.x += 3;
    if (ctx.input.isDown('left')) ctx.transform.position.x -= 3;
  },
};`;

// --- project builders -----------------------------------------------------

interface EntitySpec {
  id: string;
  name: string;
  components: Record<string, unknown>;
}

/** Build a one-scene in-memory project from entity specs + an optional Hero script. */
async function makeGame(entities: EntitySpec[], heroScript?: string): Promise<ProjectStore> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/g', { name: 'Sweep Game', starterScene: false });
  store.project.scenes.push({ id: 'scn_test', name: 'Test', path: 'scenes/test.scene.json' });
  store.project.initialScene = 'scn_test';
  store.scenes.set(
    'scn_test',
    SceneSchema.parse({
      formatVersion: 1,
      id: 'scn_test',
      name: 'Test',
      entities: entities.map((e) => ({
        id: e.id,
        name: e.name,
        parentId: null,
        enabled: true,
        tags: [],
        components: e.components,
      })),
    }),
  );
  if (heroScript) await fs.writeFile('/g/scripts/hero.js', heroScript);
  await store.save();
  return ProjectStore.load(fs, '/g');
}

/** A single scripted Hero avatar at the origin. */
function heroGame(script: string): Promise<ProjectStore> {
  return makeGame(
    [
      {
        id: 'ent_hero',
        name: 'Hero',
        components: {
          Transform: { position: { x: 0, y: 0 } },
          Script: { scriptPath: 'scripts/hero.js' },
        },
      },
    ],
    script,
  );
}

/** Hero avatar plus a static wall collider, so the scene has a real nav grid. */
function walledGame(script: string): Promise<ProjectStore> {
  return makeGame(
    [
      {
        id: 'ent_hero',
        name: 'Hero',
        components: {
          Transform: { position: { x: 0, y: 0 } },
          Script: { scriptPath: 'scripts/hero.js' },
        },
      },
      {
        id: 'ent_wall',
        name: 'Wall',
        components: {
          Transform: { position: { x: 96, y: 0 } },
          Collider: { shape: 'box', width: 64, height: 128 },
        },
      },
    ],
    script,
  );
}

function realSession(store: ProjectStore): HearthSession {
  const runtime: RuntimeHooks = createRuntimeHooks();
  return HearthSession.fromStore(store, { runtime, source: 'cli' });
}

const CRASH_CONFIG = (over: Partial<BotRunConfig> = {}): BotRunConfig => ({
  scene: 'scn_test',
  policy: 'mash',
  seed: 0,
  maxFrames: 200,
  stuckAfter: 180, // matches the bake default so a direct run reproduces exactly
  objectives: [],
  ...over,
});

// --- flagship: bake round-trip -------------------------------------------

describe('bake round-trip', () => {
  it('reproduces a mash-provoked crash at the same frame', async () => {
    const store = await heroGame(RIGHT_THROWER);

    // Ground truth: a direct run with the exact config bake will use.
    const direct = await runBotRun(store, CRASH_CONFIG());
    expect(direct.verdict).toBe('error');
    expect(direct.firstError).toBeDefined();
    // Crash lands before any stuck window, so bake's fixed stuckAfter is moot.
    expect(direct.firstError!.frame).toBeLessThan(180);

    const session = realSession(store);
    const baked = await session.execute<any>('bakePlaytest', {
      name: 'crash',
      scene: 'Test',
      policy: 'mash',
      seed: 0,
      maxFrames: 200,
    });
    expect(baked.success).toBe(true);

    const run = await session.execute<any>('runPlaytest', { playtest: 'crash' });
    expect(run.success).toBe(true);
    // The baked playtest is RED and fails at the very same frame.
    expect(run.data.passed).toBe(false);
    expect(run.data.errors.length).toBeGreaterThan(0);
    expect(run.data.errors[0].frame).toBe(direct.firstError!.frame);
    // Its closing step is assertNoErrors, and it failed.
    const last = run.data.steps[run.data.steps.length - 1];
    expect(last.type).toBe('assertNoErrors');
    expect(last.passed).toBe(false);
  });

  it('bakes a passing run into a green playtest', async () => {
    const store = await heroGame(INPUT_MOVER);
    const session = realSession(store);
    const baked = await session.execute<any>('bakePlaytest', {
      name: 'clean',
      scene: 'Test',
      policy: 'mash',
      seed: 3,
      maxFrames: 120,
    });
    expect(baked.success).toBe(true);

    const run = await session.execute<any>('runPlaytest', { playtest: 'clean' });
    expect(run.data.passed).toBe(true);
    expect(run.data.errors).toEqual([]);
  });

  it('produces a baked file valid per PlaytestSchema, closing with assertNoErrors', async () => {
    const store = await heroGame(RIGHT_THROWER);
    const session = realSession(store);
    await session.execute('bakePlaytest', { name: 'valid', scene: 'Test', policy: 'mash', seed: 0, maxFrames: 200 });
    const pt = store.getPlaytest('valid');
    expect(pt).toBeDefined();
    expect(PlaytestSchema.safeParse(pt).success).toBe(true);
    expect(pt!.seed).toBe(0);
    expect(pt!.steps[pt!.steps.length - 1].type).toBe('assertNoErrors');
    // Only the input/wait/assert step types baking emits.
    const allowed = new Set(['setAction', 'setAxis', 'setPointer', 'wait', 'assertNoErrors', 'assertPositionNear', 'assertEntityExists', 'assertEventCount', 'assertProperty']);
    for (const step of pt!.steps) expect(allowed.has(step.type)).toBe(true);
  });

  it('bakes reach objectives into a closing assertPositionNear', async () => {
    const store = await heroGame(INPUT_MOVER);
    const session = realSession(store);
    await session.execute('bakePlaytest', {
      name: 'reach',
      scene: 'Test',
      policy: 'mash',
      seed: 1,
      maxFrames: 80,
      objectives: [{ type: 'reach', target: { x: 40, y: 0 }, tolerance: 24 }],
    });
    const pt = store.getPlaytest('reach')!;
    const near = pt.steps.find((s) => s.type === 'assertPositionNear') as any;
    expect(near).toBeDefined();
    expect(near.entity).toBe('Hero');
    expect(near.x).toBe(40);
    expect(near.tolerance).toBe(24);
  });
});

// --- sweep report ---------------------------------------------------------

describe('sweep report', () => {
  it('reports an error failure with repro + bake strings and writes a report file', async () => {
    const store = await heroGame(RIGHT_THROWER);
    const session = realSession(store);
    const result = await session.execute<any>('sweepScene', {
      scene: 'Test',
      policies: ['mash'],
      seeds: 3,
      maxFrames: 200,
    });
    expect(result.success).toBe(true);
    const data = result.data;
    expect(data.runs).toBe(3);
    expect(data.verdicts.error).toBeGreaterThan(0);
    expect(data.failures.length).toBeGreaterThan(0);

    const first = data.failures[0];
    expect(first.verdict).toBe('error');
    // Repro strings carry the real scene name (the CLI resolves names, not slugs).
    expect(first.repro).toContain('hearth sweep Test ');
    expect(first.repro).toContain('--policies mash');
    expect(first.repro).toContain(`--seed-start ${first.seed}`);
    expect(first.bake).toContain('--bake mash-seed-');

    // Report file written and referenced.
    expect(data.reportFile).toBe('.hearth/sweeps/test-0001.json');
    expect(await store.fs.exists('/g/.hearth/sweeps/test-0001.json')).toBe(true);
    expect(result.changed).toContainEqual({
      kind: 'file',
      path: '.hearth/sweeps/test-0001.json',
      action: 'created',
    });
  });

  it('assigns sequential report ids across sweeps', async () => {
    const store = await heroGame(RIGHT_THROWER);
    const session = realSession(store);
    const a = await session.execute<any>('sweepScene', { scene: 'Test', seeds: 1, maxFrames: 100 });
    const b = await session.execute<any>('sweepScene', { scene: 'Test', seeds: 1, maxFrames: 100 });
    expect(a.data.reportFile).toBe('.hearth/sweeps/test-0001.json');
    expect(b.data.reportFile).toBe('.hearth/sweeps/test-0002.json');
  });

  it('caps failures at 5 even when every run fails', async () => {
    const store = await heroGame(RIGHT_THROWER);
    const session = realSession(store);
    const result = await session.execute<any>('sweepScene', {
      scene: 'Test',
      policies: ['mash'],
      seeds: 8,
      maxFrames: 200,
    });
    expect(result.data.verdicts.error).toBe(8);
    expect(result.data.failures.length).toBe(5);
  });
});

// --- coverage + heatmap gating -------------------------------------------

describe('coverage and heatmap', () => {
  it('includes coverage but omits the heatmap by default', async () => {
    const store = await walledGame(INPUT_MOVER);
    const session = realSession(store);
    const result = await session.execute<any>('sweepScene', {
      scene: 'Test',
      policies: ['mash'],
      seeds: 2,
      maxFrames: 120,
      avatar: 'Hero',
    });
    expect(result.data.coverage).toBeDefined();
    expect(result.data.coverage.cellsReachable).toBeGreaterThan(0);
    expect(result.data.coverage.pct).toBeGreaterThanOrEqual(0);
    expect(result.data.coverage.pct).toBeLessThanOrEqual(1);
    expect(result.data.heatmap).toBeUndefined();
  });

  it('includes the ASCII heatmap when requested', async () => {
    const store = await walledGame(INPUT_MOVER);
    const session = realSession(store);
    const result = await session.execute<any>('sweepScene', {
      scene: 'Test',
      policies: ['mash'],
      seeds: 2,
      maxFrames: 120,
      avatar: 'Hero',
      heatmap: true,
    });
    expect(typeof result.data.heatmap).toBe('string');
    expect(result.data.heatmap.length).toBeGreaterThan(0);
  });

  it('omits coverage when the scene has no nav grid (no solids)', async () => {
    const store = await heroGame(INPUT_MOVER);
    const session = realSession(store);
    const result = await session.execute<any>('sweepScene', {
      scene: 'Test',
      policies: ['mash'],
      seeds: 1,
      maxFrames: 60,
    });
    expect(result.data.coverage).toBeUndefined();
  });
});

describe('cliQuote', () => {
  it('leaves slug-safe names bare and quotes everything else', async () => {
    const { cliQuote } = await import('../src/bots/sweep.js');
    expect(cliQuote('Test')).toBe('Test');
    expect(cliQuote('level_1')).toBe('level_1');
    expect(cliQuote('Level 1')).toBe('"Level 1"');
    expect(cliQuote('say "hi"')).toBe('"say \\"hi\\""');
  });
});
