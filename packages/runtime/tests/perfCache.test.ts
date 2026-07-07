/**
 * Task 9 perf caches: frame-scoped getEntities() cache + tilemap collider
 * cache. These tests pin exact behavior BEFORE the perf change (spawn
 * mid-frame visibility) and exercise every invalidation trigger the cache
 * must honor — a stale getEntities()/tilemap box set is a gameplay bug, not
 * just a slowdown, so every test here asserts observable state, not just
 * that the caches exist.
 */
import { describe, expect, it } from 'vitest';
import { SceneRuntime } from '@hearth/runtime';
import { makeStore, ent } from './helpers.js';

describe('getEntities() frame-scoped cache', () => {
  it('returns the same array reference across calls within a frame (no allocation per call)', async () => {
    const { store } = await makeStore({
      entities: [ent('A', { Transform: { position: { x: 0, y: 0 } } })],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    const first = runtime.getEntities();
    const second = runtime.getEntities();
    expect(second).toBe(first);
  });

  it('keeps the same reference across a step() that neither spawns nor destroys anything', async () => {
    // A step with no spawn/destroy touches nothing the cache depends on
    // (flushDestroyed no-ops when destroyedIds is empty) — the whole point
    // of caching is to NOT reallocate on frames where nothing changed.
    const { store } = await makeStore({
      entities: [ent('A', { Transform: { position: { x: 0, y: 0 } } })],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    const before = runtime.getEntities();
    runtime.step();
    const after = runtime.getEntities();
    expect(after).toBe(before);
    expect(after.map((e) => e.name)).toEqual(['A']);
  });

  it('changes reference (and never re-includes the old array) once a spawn happens', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Spawner', { Transform: { position: { x: 0, y: 0 } }, Script: { scriptPath: 'scripts/spawner.js' } }),
      ],
      scripts: {
        'spawner.js': `export default {
          onStart(ctx) { ctx.scene.spawn({ name: 'Spawned' }); },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    const before = runtime.getEntities();
    runtime.step(); // Spawner's onStart spawns 'Spawned'
    const after = runtime.getEntities();
    expect(after).not.toBe(before);
    expect(after.map((e) => e.name).sort()).toEqual(['Spawned', 'Spawner']);
    // The pre-spawn snapshot is untouched — proves getEntities() never
    // handed out `this.entities` itself (which the later spawn's push
    // would otherwise have silently grown).
    expect(before.map((e) => e.name)).toEqual(['Spawner']);
  });

  it('pins current spawn-mid-frame semantics: a same-frame spawn is invisible to the ' +
    'already-running onStart pass but visible to that same frame\'s onUpdate pass', async () => {
    const { store } = await makeStore({
      entities: [ent('Spawner', { Transform: { position: { x: 0, y: 0 } }, Script: { scriptPath: 'scripts/spawner.js' } })],
      scripts: {
        'spawner.js': `export default {
          onStart(ctx) {
            ctx.scene.spawn({
              name: 'Spawned',
              components: { Script: { scriptPath: 'scripts/spawned.js' }, Text: { content: '' } },
            });
          },
        };`,
        'spawned.js': `export default {
          onStart(ctx) {
            ctx.getComponent('Text').content = 'started:' + ctx.time.frame;
          },
          onUpdate(ctx) {
            const t = ctx.getComponent('Text');
            t.content = (t.content ? t.content + ';' : '') + 'update:' + ctx.time.frame;
          },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');

    // Frame 0: Spawner's onStart spawns 'Spawned' mid-loop, after the
    // onStart pass already captured its entity list — so 'Spawned' gets no
    // onStart this frame. The onUpdate pass re-reads the entity list AFTER
    // the spawn and calls onUpdate unconditionally (no `started` gate), so
    // 'Spawned' DOES get onUpdate this same frame.
    runtime.step();
    let spawned = runtime.find('Spawned');
    expect(spawned).toBeDefined();
    expect(spawned!.components.Text!.content).toBe('update:0');

    // Frame 1: the onStart pass now finds `started === false` and fires
    // onStart (one frame late), then onUpdate runs again.
    runtime.step();
    spawned = runtime.find('Spawned');
    expect(spawned!.components.Text!.content).toBe('started:1;update:1');
  });

  it('a destroyed entity disappears from find()/getEntities() immediately (before flushDestroyed runs)', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Killer', {
          Transform: { position: { x: 0, y: 0 } },
          Script: { scriptPath: 'scripts/killer.js' },
          Text: { content: '' },
        }),
        ent('Victim', { Transform: { position: { x: 0, y: 0 } } }),
      ],
      scripts: {
        'killer.js': `export default {
          onUpdate(ctx) {
            if (ctx.time.frame === 2) {
              ctx.scene.destroy(ctx.scene.find('Victim'));
              // destroyEntity only marks destroyedIds — flushDestroyed runs
              // later, at end of step(). The cache must exclude Victim from
              // this very next call, in the same onUpdate, same frame.
              const stillFound = ctx.scene.find('Victim') !== null;
              ctx.getComponent('Text').content = stillFound ? 'still-there' : 'gone';
            }
          },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(3); // frames 0, 1, 2 — destroy requested during frame 2's onUpdate
    expect(runtime.find('Killer')!.components.Text!.content).toBe('gone');
    expect(runtime.find('Victim')).toBeUndefined();
    expect(runtime.getEntities().map((e) => e.name)).toEqual(['Killer']);
  });
});

describe('tilemap collider cache', () => {
  it('invalidates when a script replaces Tilemap.grid at runtime (a stale box set would be a gameplay bug)', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Map', {
          Transform: { position: { x: 0, y: 0 } },
          Tilemap: { tileSize: 32, tileAssets: {}, grid: ['..', '..'], solid: true },
        }),
        ent('Patcher', {
          Transform: { position: { x: 0, y: 0 } },
          Script: { scriptPath: 'scripts/patcher.js' },
        }),
        ent('Sitter', {
          // Centered exactly on the (0,0) tile — overlaps it fully once solid.
          Transform: { position: { x: 16, y: 16 } },
          Collider: { shape: 'box', width: 8, height: 8 },
          PhysicsBody: { bodyType: 'kinematic', velocity: { x: 0, y: 0 } },
        }),
      ],
      scripts: {
        'patcher.js': `export default {
          onUpdate(ctx) {
            if (ctx.time.frame === 2) {
              ctx.scene.find('Map').getComponent('Tilemap').grid = ['##', '##'];
            }
          },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(2); // frames 0-1: grid is still all empty
    expect(runtime.find('Sitter')!.collisions.length).toBe(0);
    // Frame 2: patcher's onUpdate replaces the grid BEFORE this same frame's
    // physics pass runs (onUpdate precedes stepPhysics in step()), so the
    // new grid must already be in effect this frame, not the next one.
    runtime.step();
    expect(runtime.find('Sitter')!.collisions.length).toBe(1);
  });

  it('invalidates when a Tilemap\'s parent moves (getWorldPosition changes, grid/tileSize/solid do not)', async () => {
    const { store } = await makeStore({
      entities: [
        ent(
          'Parent',
          {
            Transform: { position: { x: 0, y: 0 } },
            Script: { scriptPath: 'scripts/slide.js' },
          },
          { id: 'ent_parent' },
        ),
        ent(
          'Map',
          {
            Transform: { position: { x: 0, y: 0 } },
            Tilemap: { tileSize: 32, tileAssets: {}, grid: ['#'], solid: true },
          },
          { parentId: 'ent_parent' },
        ),
        ent('Detector', {
          // Matches the lone tile's world box (center 16,16) only once
          // Parent.position.x reaches 500 (tile center = parent.x + 16).
          Transform: { position: { x: 516, y: 16 } },
          Collider: { shape: 'box', width: 32, height: 32, isTrigger: true },
          PhysicsBody: { bodyType: 'kinematic', velocity: { x: 0, y: 0 } },
        }),
      ],
      scripts: {
        'slide.js': `export default {
          onUpdate(ctx) {
            ctx.transform.position.x = ctx.time.frame * 100;
          },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    for (let i = 0; i < 5; i++) {
      runtime.step();
      expect(runtime.find('Detector')!.collisions.length).toBe(0);
    }
    runtime.step(); // frame 5: Parent.position.x === 500, tile now under Detector
    const detector = runtime.find('Detector')!;
    expect(detector.collisions.length).toBe(1);
    expect(detector.collisions[0]!.trigger).toBe(true);
  });
});
