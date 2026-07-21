/**
 * Steering-bot tests — movement probe, and the wander/seek policies built on it.
 * Probe derives an avatar's control scheme from short trial runs; wander and
 * seek then steer with that basis. Everything must be deterministic: the same
 * seed produces a byte-identical input timeline. Projects are built in memory
 * the same way bots.test.ts does.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, ProjectStore, SceneSchema, createProject } from '@hearth/core';
import { runBotRun, type BotRunConfig } from '@hearth/playtest';
// probeMovement is not yet re-exported from the package barrel (index.ts is
// owned by a parallel task); import it from source until that export lands.
import { probeMovement } from '../src/bots/probe.js';

// --- scripts --------------------------------------------------------------

/** Four-directional walker: reads input, moves 3px/frame per held direction. */
const WALKER = `export default {
  onUpdate(ctx) {
    if (ctx.input.isDown('right')) ctx.transform.position.x += 3;
    if (ctx.input.isDown('left')) ctx.transform.position.x -= 3;
    if (ctx.input.isDown('up')) ctx.transform.position.y -= 3;
    if (ctx.input.isDown('down')) ctx.transform.position.y += 3;
  },
};`;

/** Reads input but never moves — a control scheme with no movement basis. */
const INERT = `export default {
  onUpdate(ctx) { if (ctx.input.isDown('right')) { /* no movement */ } },
};`;

// --- project builder ------------------------------------------------------

interface EntitySpec {
  id: string;
  name: string;
  components: Record<string, unknown>;
}

/** A one-scene project ("Test") with the given entities and script sources. */
async function makeGame(
  entities: EntitySpec[],
  scripts: Record<string, string> = {},
): Promise<ProjectStore> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/g', { name: 'Steer Game', starterScene: false });
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
  for (const [path, source] of Object.entries(scripts)) {
    await fs.writeFile(`/g/${path}`, source);
  }
  await store.save();
  return ProjectStore.load(fs, '/g');
}

/** A lone walker hero at the given position. */
function walkerGame(pos = { x: 0, y: 0 }): Promise<ProjectStore> {
  return makeGame(
    [
      {
        id: 'ent_hero',
        name: 'Hero',
        components: {
          Transform: { position: pos },
          Script: { scriptPath: 'scripts/hero.js' },
        },
      },
    ],
    { 'scripts/hero.js': WALKER },
  );
}

function baseConfig(over: Partial<BotRunConfig> = {}): BotRunConfig {
  return {
    scene: 'Test',
    policy: 'idle',
    seed: 1,
    maxFrames: 120,
    stuckAfter: 100000,
    objectives: [],
    ...over,
  };
}

// --- probe ----------------------------------------------------------------

describe('probeMovement', () => {
  it('measures the moving inputs and excludes no-op actions', async () => {
    const store = await walkerGame();
    const basis = await probeMovement(store, 'Test', 'Hero');

    const actionNames = basis.entries
      .filter((e) => e.input.kind === 'action')
      .map((e) => (e.input.kind === 'action' ? e.input.action : ''));
    // The walker moves on right/left/up/down but not jump/action.
    expect(actionNames).toContain('right');
    expect(actionNames).not.toContain('jump');
    expect(actionNames).not.toContain('action');

    const right = basis.entries.find((e) => e.input.kind === 'action' && e.input.action === 'right');
    expect(right).toBeDefined();
    expect(right!.dx).toBeGreaterThan(2);
    expect(Math.abs(right!.dy)).toBeLessThan(0.001);
  });

  it('throws, listing what was probed, when nothing moves the avatar', async () => {
    const store = await makeGame(
      [
        {
          id: 'ent_hero',
          name: 'Hero',
          components: { Transform: { position: { x: 0, y: 0 } }, Script: { scriptPath: 'scripts/hero.js' } },
        },
      ],
      { 'scripts/hero.js': INERT },
    );
    await expect(probeMovement(store, 'Test', 'Hero')).rejects.toThrow(/no movement basis.*probed/s);
  });
});

// --- seek -----------------------------------------------------------------

describe('seek policy', () => {
  it('reaches a target down a corridor', async () => {
    // A horizontal corridor: solid tile rows above and below an open lane.
    const store = await makeGame(
      [
        {
          id: 'ent_hero',
          name: 'Hero',
          components: {
            Transform: { position: { x: 48, y: 48 } },
            Script: { scriptPath: 'scripts/hero.js' },
          },
        },
        {
          id: 'ent_walls',
          name: 'Walls',
          components: {
            Transform: { position: { x: 0, y: 0 } },
            Tilemap: {
              tileSize: 32,
              solid: true,
              grid: ['#########', '.........', '#########'],
            },
          },
        },
      ],
      { 'scripts/hero.js': WALKER },
    );

    const result = await runBotRun(
      store,
      baseConfig({
        policy: 'seek',
        seed: 3,
        avatar: 'Hero',
        target: { x: 240, y: 48 },
        maxFrames: 250,
        objectives: [{ type: 'reach', target: { x: 240, y: 48 }, tolerance: 24 }],
      }),
    );

    expect(result.verdict).toBe('completed');
    expect(result.objectives[0].achievedAtFrame).not.toBeNull();
  });

  it('throws without an avatar', async () => {
    // No script reads input, so no avatar can be inferred and none is passed.
    const store = await makeGame([
      { id: 'ent_prop', name: 'Prop', components: { Transform: { position: { x: 0, y: 0 } } } },
    ]);
    await expect(
      runBotRun(store, baseConfig({ policy: 'seek', target: { x: 100, y: 0 } })),
    ).rejects.toThrow(/seek.*avatar/s);
  });
});

// --- wander ---------------------------------------------------------------

describe('wander policy', () => {
  it('visits strictly more cells than idle on an open scene', async () => {
    const store = await walkerGame();
    const wander = await runBotRun(store, baseConfig({ policy: 'wander', seed: 5, avatar: 'Hero', maxFrames: 200 }));
    const idle = await runBotRun(store, baseConfig({ policy: 'idle', avatar: 'Hero', maxFrames: 200 }));
    expect(wander.cellsVisited).toBeGreaterThan(idle.cellsVisited);
  });

  it('throws without an avatar', async () => {
    const store = await makeGame([
      { id: 'ent_prop', name: 'Prop', components: { Transform: { position: { x: 0, y: 0 } } } },
    ]);
    await expect(runBotRun(store, baseConfig({ policy: 'wander' }))).rejects.toThrow(/wander.*avatar/s);
  });
});

// --- determinism ----------------------------------------------------------

describe('steering determinism', () => {
  it('wander produces a deep-equal timeline across two same-seed runs', async () => {
    const store = await walkerGame();
    const cfg = baseConfig({ policy: 'wander', seed: 9, avatar: 'Hero', maxFrames: 200 });
    const a = await runBotRun(store, cfg);
    const b = await runBotRun(store, cfg);
    expect(a.timeline.length).toBeGreaterThan(0);
    expect(a.timeline).toEqual(b.timeline);
  });

  it('seek produces a deep-equal timeline across two same-seed runs', async () => {
    const store = await walkerGame({ x: 0, y: 0 });
    const cfg = baseConfig({
      policy: 'seek',
      seed: 11,
      avatar: 'Hero',
      target: { x: 300, y: 0 },
      maxFrames: 200,
    });
    const a = await runBotRun(store, cfg);
    const b = await runBotRun(store, cfg);
    expect(a.timeline.length).toBeGreaterThan(0);
    expect(a.timeline).toEqual(b.timeline);
  });
});
