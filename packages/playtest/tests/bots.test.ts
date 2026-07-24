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
import { runBotRun, resolveAvatar, interactiveUiCenters, type BotRunConfig } from '@hearth/playtest';

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
/** Fires two DISTINCT camera-effect kinds, at frames 3 and 6 — first-occurrence interaction novelty. */
const FX_DISTINCT = `export default { onUpdate(ctx) {
  if (ctx.time.frame === 3) ctx.camera.flash('#ffffff', 0.1);
  if (ctx.time.frame === 6) ctx.camera.shake(2, 0.1);
} };`;
/** Fires the SAME camera effect every frame — repetition, which must NOT keep resetting the stuck timer. */
const FX_LOOP = `export default { onUpdate(ctx) { ctx.camera.flash('#ffffff', 0.1); } };`;
/** Fades the screen fully opaque near the start and never lifts it — a hidden softlock. */
const FADE_STUCK = `export default { onUpdate(ctx) { if (ctx.time.frame === 1) ctx.camera.fade(1, 0.02); } };`;

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

/**
 * A scene with two input-reading entities — an ambiguous avatar set.
 * `taggedPlayer` tags the first entity `player`, giving a preference tiebreak.
 */
async function makeAmbiguousGame(opts: { taggedPlayer?: boolean } = {}): Promise<ProjectStore> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/g', { name: 'Ambiguous', starterScene: false });
  store.project.scenes.push({ id: 'scn_test', name: 'Test', path: 'scenes/test.scene.json' });
  store.project.initialScene = 'scn_test';
  const mk = (id: string, name: string, tags: string[] = []) => ({
    id,
    name,
    parentId: null,
    enabled: true,
    tags,
    components: { Transform: { position: { x: 0, y: 0 } }, Script: { scriptPath: 'scripts/hero.js' } },
  });
  store.scenes.set(
    'scn_test',
    SceneSchema.parse({
      formatVersion: 1,
      id: 'scn_test',
      name: 'Test',
      entities: [
        mk('ent_a', 'PlayerA', opts.taggedPlayer ? ['player'] : []),
        mk('ent_b', 'PlayerB'),
      ],
    }),
  );
  await fs.writeFile('/g/scripts/hero.js', INPUT_MOVER);
  await store.save();
  return ProjectStore.load(fs, '/g');
}

/** A menu scene: a Main Camera plus an interactive Start button whose click emits an event. */
async function makeMenuGame(): Promise<ProjectStore> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/g', { name: 'Menu Game', starterScene: false });
  store.project.scenes.push({ id: 'scn_menu', name: 'Menu', path: 'scenes/menu.scene.json' });
  store.project.initialScene = 'scn_menu';
  store.scenes.set(
    'scn_menu',
    SceneSchema.parse({
      formatVersion: 1,
      id: 'scn_menu',
      name: 'Menu',
      entities: [
        {
          id: 'ent_cam',
          name: 'Main Camera',
          parentId: null,
          enabled: true,
          tags: [],
          components: { Transform: { position: { x: 0, y: 0 } }, Camera: { isMain: true } },
        },
        {
          id: 'ent_start',
          name: 'Start',
          parentId: null,
          enabled: true,
          tags: [],
          components: {
            Transform: { position: { x: 0, y: 0 } },
            UIElement: { anchor: 'center', offset: { x: 0, y: 0 }, interactive: true },
            SpriteRenderer: { width: 200, height: 80 },
            Script: { scriptPath: 'scripts/start.js' },
          },
        },
      ],
    }),
  );
  // Clicking the button emits an event — progress novelty the sweep can see.
  await fs.writeFile(
    '/g/scripts/start.js',
    `export default { onUiEvent(ctx, event) { if (event.type === 'click') ctx.events.emit('started'); } };`,
  );
  await store.save();
  return ProjectStore.load(fs, '/g');
}

/** A one-scene project: a Main Camera plus a scripted Hero (used for camera-effect novelty). */
async function makeCameraGame(heroScript: string): Promise<ProjectStore> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/g', { name: 'Camera Game', starterScene: false });
  store.project.scenes.push({ id: 'scn_test', name: 'Test', path: 'scenes/test.scene.json' });
  store.project.initialScene = 'scn_test';
  store.scenes.set(
    'scn_test',
    SceneSchema.parse({
      formatVersion: 1,
      id: 'scn_test',
      name: 'Test',
      entities: [
        {
          id: 'ent_cam',
          name: 'Main Camera',
          parentId: null,
          enabled: true,
          tags: [],
          components: { Transform: { position: { x: 0, y: 0 } }, Camera: { isMain: true } },
        },
        {
          id: 'ent_hero',
          name: 'Hero',
          parentId: null,
          enabled: true,
          tags: [],
          components: { Transform: { position: { x: 0, y: 0 } }, Script: { scriptPath: 'scripts/hero.js' } },
        },
      ],
    }),
  );
  await fs.writeFile('/g/scripts/hero.js', heroScript);
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
    // mash injects input; nothing responds, so no novelty ever — stuck. (idle is
    // exempt from stuck now, so the mechanism is exercised with an active policy.)
    const result = await runBotRun(store, baseConfig({ policy: 'mash', stuckAfter: 10, maxFrames: 50 }));
    expect(result.verdict).toBe('stuck');
    expect(result.stuckAtFrame).toBe(10);
    expect(result.endFrame).toBe(10);
  });

  it('does not fire before stuckAfter is reached', async () => {
    const store = await makeBotGame(null);
    const result = await runBotRun(store, baseConfig({ policy: 'mash', stuckAfter: 10, maxFrames: 5 }));
    expect(result.verdict).toBe('ran-clean');
    expect(result.stuckAtFrame).toBeUndefined();
    expect(result.endFrame).toBe(5);
  });
});

// --- F4: seek fails honestly ----------------------------------------------

describe('seek diagnostics (F4)', () => {
  it('a seek that stalls short of its target explains itself, not "no novelty"', async () => {
    // Hero moves only on the x axis (INPUT_MOVER). The target sits far below, so
    // seek can never close the y gap and stalls — the classic platformer case
    // where a nav route exists through the air but the walking bot can't follow.
    const store = await makeBotGame(INPUT_MOVER);
    const result = await runBotRun(
      store,
      baseConfig({
        policy: 'seek',
        avatar: 'Hero',
        target: { x: 0, y: 600 },
        stuckAfter: 20,
        maxFrames: 120,
      }),
    );
    expect(result.verdict).toBe('stuck');
    const f = result.findings.find((x) => x.kind === 'seek-unreachable');
    expect(f).toBeDefined();
    expect(f!.summary.toLowerCase()).toMatch(/seek|target|jump|reach/);
  });
});

// --- menu navigation: mash targets interactive UI -------------------------

describe('mash UI navigation (F3 root cause)', () => {
  it('interactiveUiCenters returns the screen center of an interactive button', async () => {
    const store = await makeMenuGame();
    const session = await GameSession.create(store, { scene: 'Menu' });
    const centers = interactiveUiCenters(
      session.runtime,
      store.project.buildSettings.width,
      store.project.buildSettings.height,
    );
    session.destroy();
    expect(centers.length).toBe(1);
    // Anchored center of a 800x600-ish viewport, roughly the middle.
    expect(centers[0].x).toBeGreaterThan(0);
    expect(centers[0].y).toBeGreaterThan(0);
  });

  it('mash navigates a menu by clicking the button instead of getting stuck', async () => {
    const store = await makeMenuGame();
    const result = await runBotRun(
      store,
      baseConfig({ scene: 'Menu', policy: 'mash', seed: 3, stuckAfter: 180, maxFrames: 600 }),
    );
    // Clicking Start fires 'started' — progress novelty — so the run isn't a false stuck.
    expect(result.verdict).not.toBe('stuck');
  });
});

// --- D4: fade-softlock ----------------------------------------------------

describe('fade-softlock (D4)', () => {
  it('flags a run stuck behind a full-screen fade that never lifted', async () => {
    const store = await makeCameraGame(FADE_STUCK);
    const result = await runBotRun(store, baseConfig({ policy: 'mash', seed: 1, stuckAfter: 6, maxFrames: 40 }));
    expect(result.verdict).toBe('stuck');
    const f = result.findings.find((x) => x.kind === 'fade-softlock');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('issue');
  });

  it('does not flag an ordinary stall with no fade', async () => {
    const store = await makeBotGame(null);
    const result = await runBotRun(store, baseConfig({ policy: 'mash', seed: 1, stuckAfter: 6, maxFrames: 40 }));
    expect(result.verdict).toBe('stuck');
    expect(result.findings.find((x) => x.kind === 'fade-softlock')).toBeUndefined();
  });
});

// --- F2/F3: tiered novelty ------------------------------------------------

describe('tiered novelty (F2/F3)', () => {
  it('F2: idle is never judged stuck (it injects no input)', async () => {
    const store = await makeBotGame(null); // fully static
    const result = await runBotRun(store, baseConfig({ policy: 'idle', stuckAfter: 10, maxFrames: 50 }));
    expect(result.verdict).not.toBe('stuck');
    expect(result.stuckAtFrame).toBeUndefined();
  });

  it('F3: a first-of-its-kind camera effect resets the stuck timer', async () => {
    // Distinct effects (flash, then shake) at frames 3 and 6 with no positional or
    // event novelty. Naive novelty (cells/events/scene only) would call this stuck
    // at frame 4; tiered novelty counts each first-seen effect, pushing the stall
    // past the last one.
    const store = await makeCameraGame(FX_DISTINCT);
    const result = await runBotRun(store, baseConfig({ policy: 'mash', seed: 1, stuckAfter: 4, maxFrames: 40 }));
    expect(result.verdict).toBe('stuck');
    expect(result.stuckAtFrame).toBeGreaterThan(6);
  });

  it('F3: a repeated camera effect does NOT keep resetting the timer (no masking)', async () => {
    // The same flash every frame is novel only the first time; after that the run
    // is genuinely stalled and must still be caught — an ambient effect can't mask it.
    const store = await makeCameraGame(FX_LOOP);
    const result = await runBotRun(store, baseConfig({ policy: 'mash', seed: 1, stuckAfter: 4, maxFrames: 40 }));
    expect(result.verdict).toBe('stuck');
    expect(result.stuckAtFrame).toBeLessThan(10);
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

// --- F1: avatar resolution scoped to steering policies --------------------

describe('avatar scoping (F1)', () => {
  it('mash does not throw on an ambiguous avatar set; it notes it and runs', async () => {
    const store = await makeAmbiguousGame(); // PlayerA + PlayerB, no player tag
    const result = await runBotRun(store, baseConfig({ policy: 'mash', seed: 2, maxFrames: 30 }));
    expect(result.verdict).toBeDefined();
    const note = result.findings.find((f) => f.kind === 'ambiguous-avatar');
    expect(note).toBeDefined();
    expect(note!.severity).toBe('note');
    expect(note!.summary).toMatch(/PlayerA.*PlayerB|PlayerB.*PlayerA/);
  });

  it('mash prefers a player-tagged entity over an ambiguous set (no note)', async () => {
    const store = await makeAmbiguousGame({ taggedPlayer: true });
    const result = await runBotRun(store, baseConfig({ policy: 'mash', seed: 2, maxFrames: 30 }));
    expect(result.findings.find((f) => f.kind === 'ambiguous-avatar')).toBeUndefined();
  });

  it('a steering policy still throws on an ambiguous avatar set', async () => {
    const store = await makeAmbiguousGame();
    await expect(
      runBotRun(store, baseConfig({ policy: 'wander', seed: 2, maxFrames: 30 })),
    ).rejects.toThrow(/ambiguous/);
  });
});
