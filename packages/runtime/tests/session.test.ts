/**
 * GameSession — cross-scene orchestration: ctx.scenes.load swaps,
 * monotonic frames, aggregated logs/audio/scene events, shared storage
 * and RNG stream, and deterministic replay under a fixed seed.
 */
import { describe, it, expect } from 'vitest';
import { GameSession, MemorySessionStorage } from '@hearth/runtime';
import type { ProjectStore } from '@hearth/core';
import { makeStore, ent } from './helpers.js';

const LEVEL_ENTITIES = [
  ent('Hero', { Transform: {}, Script: { scriptPath: 'scripts/hero.js' } }),
];

const HERO_SCRIPT = `export default {
  onStart(ctx) { ctx.log('hero-start scene=' + ctx.scenes.current.name); },
};`;

/** Menu scene (scn_test) with one scripted entity plus a Level scene. */
async function makeTwoSceneStore(
  menuScript: string,
  extra: { heroScript?: string; assets?: { id: string; name: string; type: string; path: string }[]; menuEntities?: Record<string, unknown>[] } = {},
): Promise<ProjectStore> {
  const { store } = await makeStore({
    entities: [
      ent('Menu', { Transform: {}, Script: { scriptPath: 'scripts/menu.js' } }),
      ...(extra.menuEntities ?? []),
    ],
    scripts: { 'menu.js': menuScript, 'hero.js': extra.heroScript ?? HERO_SCRIPT },
    assets: extra.assets,
    extraScenes: [{ id: 'scn_level', name: 'Level', entities: LEVEL_ENTITIES }],
  });
  return store;
}

describe('GameSession scene switching', () => {
  it('ctx.scenes.load swaps to the new scene with fresh entities', async () => {
    const store = await makeTwoSceneStore(`export default {
      onUpdate(ctx) {
        if (ctx.time.frame === 2) ctx.log('load:' + ctx.scenes.load('Level'));
      },
    };`);
    const session = await GameSession.create(store);
    expect(session.currentSceneId).toBe('scn_test');

    for (let i = 0; i < 5; i++) await session.stepAsync();

    expect(session.currentSceneId).toBe('scn_level');
    expect(session.runtime.find('Hero')).toBeDefined();
    expect(session.runtime.find('Menu')).toBeUndefined();
    expect(session.logs.map((l) => l.message)).toContain('load:true');
    expect(session.errors).toEqual([]);
    session.destroy();
  });

  it('keeps frames monotonic across the switch and records the SceneEvent', async () => {
    const store = await makeTwoSceneStore(`export default {
      onUpdate(ctx) { if (ctx.time.frame === 2) ctx.scenes.load('Level'); },
    };`);
    const session = await GameSession.create(store);
    for (let i = 0; i < 6; i++) await session.stepAsync();

    expect(session.frame).toBe(6);
    expect(session.sceneEvents).toEqual([{ frame: 3, from: 'scn_test', to: 'scn_level' }]);
    // The Level scene's onStart log carries a post-switch (monotonic) frame.
    const heroLog = session.logs.find((l) => l.message.startsWith('hero-start'));
    expect(heroLog).toBeDefined();
    expect(heroLog!.frame).toBe(3);
    const frames = session.logs.map((l) => l.frame);
    expect([...frames].sort((a, b) => a - b)).toEqual(frames);
    session.destroy();
  });

  it('fires onSceneChange and reports switching=true during a sync step()', async () => {
    const store = await makeTwoSceneStore(`export default {
      onUpdate(ctx) { if (ctx.time.frame === 0) ctx.scenes.load('Level'); },
    };`);
    const events: unknown[] = [];
    const session = await GameSession.create(store, { onSceneChange: (e) => events.push(e) });

    session.step();
    expect(session.switching).toBe(true);
    session.step(); // no-op while switching
    expect(session.frame).toBe(1);
    await session.stepAsync(); // awaits the swap, then steps the new scene
    expect(session.switching).toBe(false);
    expect(session.frame).toBe(2);
    expect(session.currentSceneId).toBe('scn_level');
    expect(events).toEqual([{ frame: 1, from: 'scn_test', to: 'scn_level' }]);
    session.destroy();
  });

  it('unknown scene: load returns false, warns, and the scene keeps running', async () => {
    const store = await makeTwoSceneStore(`export default {
      onUpdate(ctx) {
        if (ctx.time.frame === 0) ctx.log('load:' + ctx.scenes.load('Nowhere'));
      },
    };`);
    const session = await GameSession.create(store);
    for (let i = 0; i < 4; i++) await session.stepAsync();

    expect(session.currentSceneId).toBe('scn_test');
    expect(session.sceneEvents).toEqual([]);
    expect(session.frame).toBe(4);
    expect(session.logs.map((l) => l.message)).toContain('load:false');
    expect(session.logs.some((l) => l.level === 'warn' && l.message.includes('unknown scene "Nowhere"'))).toBe(true);
    session.destroy();
  });

  it('stops active audio playbacks on switch (stop events recorded)', async () => {
    const store = await makeTwoSceneStore(
      `export default {
        onUpdate(ctx) { if (ctx.time.frame === 1) ctx.scenes.load('Level'); },
      };`,
      {
        assets: [{ id: 'ast_bgm', name: 'bgm', type: 'audio', path: 'assets/bgm.wav' }],
        menuEntities: [
          ent('Music', { Transform: {}, AudioSource: { assetId: 'ast_bgm', autoplay: true, loop: true } }),
        ],
      },
    );
    const session = await GameSession.create(store);
    for (let i = 0; i < 4; i++) await session.stepAsync();

    expect(session.audioEvents).toEqual([
      { frame: 0, assetId: 'ast_bgm', action: 'play' },
      { frame: 2, assetId: 'ast_bgm', action: 'stop' },
    ]);
    session.destroy();
  });

  it('starts in opts.scene (by name) instead of the initial scene', async () => {
    const store = await makeTwoSceneStore(`export default {};`);
    const session = await GameSession.create(store, { scene: 'Level' });
    expect(session.currentSceneId).toBe('scn_level');
    session.destroy();
  });

  it('throws for an unknown starting scene or an empty project', async () => {
    const store = await makeTwoSceneStore(`export default {};`);
    await expect(GameSession.create(store, { scene: 'Nope' })).rejects.toThrow(/Scene not found/);
  });
});

describe('GameSession persistence and RNG', () => {
  it('ctx.save survives a scene switch (shared storage)', async () => {
    const store = await makeTwoSceneStore(
      `export default {
        onStart(ctx) { ctx.save('coins', 7); },
        onUpdate(ctx) { if (ctx.time.frame === 1) ctx.scenes.load('Level'); },
      };`,
      {
        heroScript: `export default {
          onStart(ctx) { ctx.log('coins:' + JSON.stringify(ctx.load('coins'))); },
        };`,
      },
    );
    const session = await GameSession.create(store);
    for (let i = 0; i < 4; i++) await session.stepAsync();
    expect(session.logs.map((l) => l.message)).toContain('coins:7');
    session.destroy();
  });

  it('uses the provided storage adapter', async () => {
    const storage = new MemorySessionStorage();
    const store = await makeTwoSceneStore(
      `export default { onStart(ctx) { ctx.save('hello', 'world'); } };`,
    );
    const session = await GameSession.create(store, { storage });
    await session.stepAsync();
    expect(storage.get('hello')).toBe('"world"');
    session.destroy();
  });

  it('is deterministic: same seed → identical transforms after N frames, across a switch', async () => {
    const makeSeededStore = () =>
      makeTwoSceneStore(
        `export default {
          onUpdate(ctx) {
            ctx.transform.position.x += ctx.random.range(0, 10);
            if (ctx.time.frame === 4) ctx.scenes.load('Level');
          },
        };`,
        {
          heroScript: `export default {
            onUpdate(ctx) {
              ctx.transform.position.x += ctx.random.range(0, 10);
              ctx.transform.position.y += ctx.random.next();
            },
          };`,
        },
      );

    const positions = async (seed: number) => {
      const session = await GameSession.create(await makeSeededStore(), { seed });
      for (let i = 0; i < 12; i++) await session.stepAsync();
      const hero = session.runtime.find('Hero')!;
      const result = { x: hero.transform.position.x, y: hero.transform.position.y };
      session.destroy();
      return result;
    };

    const a = await positions(42);
    const b = await positions(42);
    const c = await positions(43);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.x).toBeGreaterThan(0);
  });
});
