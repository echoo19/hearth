/**
 * Bot executor tests — deterministic mash/idle policies, novelty/stuck
 * detection, error verdicts, per-type objective evaluation, and avatar
 * resolution. Projects are built in memory the same way playtest.test.ts does.
 */
import { describe, it, expect } from 'vitest';
import {
  MemoryFileSystem,
  ProjectStore,
  SceneSchema,
  createProject,
} from '@hearth/core';
import { GameSession } from '@hearth/runtime';
import { runBotRun, resolveAvatar, type BotRunConfig } from '@hearth/playtest';

// --- scripts --------------------------------------------------------------

/** Moves right 2px/frame on its own — no input, so avatar auto-detection ignores it. */
const MOVER = `export default { onUpdate(ctx) { ctx.transform.position.x += 2; } };`;
/** Reads ctx.input, so avatar auto-detection picks it. */
const INPUT_MOVER = `export default {
  onUpdate(ctx) {
    if (ctx.input.isDown('right')) ctx.transform.position.x += 3;
    if (ctx.input.isDown('left')) ctx.transform.position.x -= 3;
  },
};`;
/** Emits 'ping' exactly once at frame 5. */
const EMITTER = `export default { onUpdate(ctx) { if (ctx.time.frame === 5) ctx.events.emit('ping'); } };`;
/** Destroys itself at frame 5. */
const SUICIDE = `export default { onUpdate(ctx) { if (ctx.time.frame === 5) ctx.destroySelf(); } };`;
/** Throws once frame >= 3. */
const THROWER = `export default { onUpdate(ctx) { if (ctx.time.frame >= 3) throw new Error('kaboom'); } };`;

// --- project builders -----------------------------------------------------

/** A one-scene project with a single Hero entity (optionally scripted). */
async function makeBotGame(
  heroScript: string | null,
  opts: { heroPos?: { x: number; y: number } } = {},
): Promise<ProjectStore> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/g', { name: 'Bot Game', starterScene: false });
  store.project.scenes.push({ id: 'scn_test', name: 'Test', path: 'scenes/test.scene.json' });
  store.project.initialScene = 'scn_test';
  const components: Record<string, unknown> = {
    Transform: { position: opts.heroPos ?? { x: 0, y: 0 } },
  };
  if (heroScript !== null) components.Script = { scriptPath: 'scripts/hero.js' };
  store.scenes.set(
    'scn_test',
    SceneSchema.parse({
      formatVersion: 1,
      id: 'scn_test',
      name: 'Test',
      entities: [
        { id: 'ent_hero', name: 'Hero', parentId: null, enabled: true, tags: [], components },
      ],
    }),
  );
  if (heroScript !== null) await fs.writeFile('/g/scripts/hero.js', heroScript);
  await store.save();
  return ProjectStore.load(fs, '/g');
}

/** A scene with two input-reading entities — an ambiguous avatar set. */
async function makeAmbiguousGame(): Promise<ProjectStore> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/g', { name: 'Ambiguous', starterScene: false });
  store.project.scenes.push({ id: 'scn_test', name: 'Test', path: 'scenes/test.scene.json' });
  store.project.initialScene = 'scn_test';
  const mk = (id: string, name: string) => ({
    id,
    name,
    parentId: null,
    enabled: true,
    tags: [],
    components: { Transform: { position: { x: 0, y: 0 } }, Script: { scriptPath: 'scripts/hero.js' } },
  });
  store.scenes.set(
    'scn_test',
    SceneSchema.parse({
      formatVersion: 1,
      id: 'scn_test',
      name: 'Test',
      entities: [mk('ent_a', 'PlayerA'), mk('ent_b', 'PlayerB')],
    }),
  );
  await fs.writeFile('/g/scripts/hero.js', INPUT_MOVER);
  await store.save();
  return ProjectStore.load(fs, '/g');
}

function baseConfig(over: Partial<BotRunConfig> = {}): BotRunConfig {
  return {
    scene: 'Test',
    policy: 'idle',
    seed: 1,
    maxFrames: 60,
    stuckAfter: 1000,
    objectives: [],
    ...over,
  };
}

// --- determinism ----------------------------------------------------------

describe('mash determinism', () => {
  it('same seed yields a deep-equal input timeline across two runs', async () => {
    const store = await makeBotGame(INPUT_MOVER);
    const cfg = baseConfig({ policy: 'mash', seed: 7, maxFrames: 120 });
    const a = await runBotRun(store, cfg);
    const b = await runBotRun(store, cfg);
    expect(a.timeline.length).toBeGreaterThan(0);
    expect(a.timeline).toEqual(b.timeline);
  });

  it('different seeds yield different timelines', async () => {
    const store = await makeBotGame(INPUT_MOVER);
    const a = await runBotRun(store, baseConfig({ policy: 'mash', seed: 7, maxFrames: 120 }));
    const b = await runBotRun(store, baseConfig({ policy: 'mash', seed: 8, maxFrames: 120 }));
    expect(a.timeline).not.toEqual(b.timeline);
  });
});

describe('idle policy', () => {
  it('emits no input at all', async () => {
    const store = await makeBotGame(MOVER);
    const result = await runBotRun(store, baseConfig({ policy: 'idle', maxFrames: 30 }));
    expect(result.timeline).toEqual([]);
  });
});

// --- stuck detection ------------------------------------------------------

describe('stuck detection', () => {
  it('fires exactly at stuckAfter on a static scene', async () => {
    const store = await makeBotGame(null); // Hero has no script ⇒ no novelty ever
    const result = await runBotRun(store, baseConfig({ policy: 'idle', stuckAfter: 10, maxFrames: 50 }));
    expect(result.verdict).toBe('stuck');
    expect(result.stuckAtFrame).toBe(10);
    expect(result.endFrame).toBe(10);
  });

  it('does not fire before stuckAfter is reached', async () => {
    const store = await makeBotGame(null);
    const result = await runBotRun(store, baseConfig({ policy: 'idle', stuckAfter: 10, maxFrames: 5 }));
    expect(result.verdict).toBe('ran-clean');
    expect(result.stuckAtFrame).toBeUndefined();
    expect(result.endFrame).toBe(5);
  });
});

// --- error verdict --------------------------------------------------------

describe('error verdict', () => {
  it('reports an error verdict with the first error frame', async () => {
    const store = await makeBotGame(THROWER);
    const result = await runBotRun(store, baseConfig({ policy: 'idle', maxFrames: 60 }));
    expect(result.verdict).toBe('error');
    expect(result.firstError).toBeDefined();
    expect(result.firstError!.message).toMatch(/kaboom/);
    expect(typeof result.firstError!.frame).toBe('number');
    expect(result.firstError!.frame).toBeGreaterThanOrEqual(3);
  });
});

// --- objectives -----------------------------------------------------------

describe('objectives', () => {
  it('reach: achieved when the avatar gets within tolerance', async () => {
    const store = await makeBotGame(MOVER); // Hero drifts +2px/frame from x=0
    const result = await runBotRun(
      store,
      baseConfig({ avatar: 'Hero', maxFrames: 100, objectives: [{ type: 'reach', target: { x: 100, y: 0 }, tolerance: 24 }] }),
    );
    expect(result.verdict).toBe('completed');
    expect(result.objectives[0].achievedAtFrame).not.toBeNull();
  });

  it('reach: objective-failed when the target is never reached', async () => {
    const store = await makeBotGame(MOVER);
    const result = await runBotRun(
      store,
      baseConfig({ avatar: 'Hero', maxFrames: 10, objectives: [{ type: 'reach', target: { x: 100, y: 0 }, tolerance: 24 }] }),
    );
    expect(result.verdict).toBe('objective-failed');
    expect(result.objectives[0].achievedAtFrame).toBeNull();
  });

  it('survive: achieved when the entity lives through the target frame', async () => {
    const store = await makeBotGame(MOVER);
    const result = await runBotRun(
      store,
      baseConfig({ avatar: 'Hero', maxFrames: 20, objectives: [{ type: 'survive', frames: 10 }] }),
    );
    expect(result.verdict).toBe('completed');
    expect(result.objectives[0].achievedAtFrame).not.toBeNull();
    expect(result.objectives[0].failed).toBe(false);
  });

  it('survive: fails the run when the entity disappears early', async () => {
    const store = await makeBotGame(SUICIDE); // Hero destroys itself at frame 5
    const result = await runBotRun(
      store,
      baseConfig({ avatar: 'Hero', maxFrames: 30, objectives: [{ type: 'survive', frames: 10 }] }),
    );
    expect(result.verdict).toBe('objective-failed');
    expect(result.objectives[0].failed).toBe(true);
    expect(result.objectives[0].achievedAtFrame).toBeNull();
  });

  it('event: achieved when the event fires enough times', async () => {
    const store = await makeBotGame(EMITTER);
    const result = await runBotRun(
      store,
      baseConfig({ maxFrames: 20, objectives: [{ type: 'event', event: 'ping', count: 1 }] }),
    );
    expect(result.verdict).toBe('completed');
    expect(result.objectives[0].achievedAtFrame).not.toBeNull();
  });

  it('event: objective-failed when the count is never met', async () => {
    const store = await makeBotGame(EMITTER); // emits 'ping' once
    const result = await runBotRun(
      store,
      baseConfig({ maxFrames: 20, objectives: [{ type: 'event', event: 'ping', count: 5 }] }),
    );
    expect(result.verdict).toBe('objective-failed');
    expect(result.objectives[0].achievedAtFrame).toBeNull();
  });

  it('property: achieved when the comparator holds', async () => {
    const store = await makeBotGame(MOVER);
    const result = await runBotRun(
      store,
      baseConfig({
        avatar: 'Hero',
        maxFrames: 100,
        objectives: [{ type: 'property', entity: 'Hero', property: 'Transform.position.x', greaterThan: 50 }],
      }),
    );
    expect(result.verdict).toBe('completed');
    expect(result.objectives[0].achievedAtFrame).not.toBeNull();
  });

  it('property: objective-failed when the comparator never holds', async () => {
    const store = await makeBotGame(MOVER);
    const result = await runBotRun(
      store,
      baseConfig({
        avatar: 'Hero',
        maxFrames: 30,
        objectives: [{ type: 'property', entity: 'Hero', property: 'Transform.position.x', greaterThan: 9999 }],
      }),
    );
    expect(result.verdict).toBe('objective-failed');
    expect(result.objectives[0].achievedAtFrame).toBeNull();
  });
});

// --- avatar resolution ----------------------------------------------------

describe('resolveAvatar', () => {
  it('picks the sole input-reading entity', async () => {
    const store = await makeBotGame(INPUT_MOVER);
    const session = await GameSession.create(store, { scene: 'Test' });
    expect(await resolveAvatar(store, session)).toBe('ent_hero');
    session.destroy();
  });

  it('returns null when no entity reads input', async () => {
    const store = await makeBotGame(MOVER);
    const session = await GameSession.create(store, { scene: 'Test' });
    expect(await resolveAvatar(store, session)).toBeNull();
    session.destroy();
  });

  it('resolves an explicit avatar ref', async () => {
    const store = await makeBotGame(MOVER);
    const session = await GameSession.create(store, { scene: 'Test' });
    expect(await resolveAvatar(store, session, 'Hero')).toBe('ent_hero');
    session.destroy();
  });

  it('throws on an ambiguous avatar set, listing candidates', async () => {
    const store = await makeAmbiguousGame();
    const session = await GameSession.create(store, { scene: 'Test' });
    await expect(resolveAvatar(store, session)).rejects.toThrow(/ambiguous.*PlayerA.*PlayerB/);
    session.destroy();
  });

  it('mash tolerates a null avatar', async () => {
    const store = await makeBotGame(MOVER); // no input-reading entity
    const result = await runBotRun(store, baseConfig({ policy: 'mash', seed: 3, maxFrames: 30 }));
    expect(result.verdict).toBeDefined();
  });
});
