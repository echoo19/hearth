/**
 * ctx.scene.findPath — grid A* pathfinding over the *live* running scene
 * (solid tilemaps + static, non-trigger colliders currently present), as
 * opposed to inspectPath which reads authored scene data. Covers wall
 * avoidance, per-frame grid memoization/invalidation, and the >512x512
 * grid-too-large failure mode.
 */
import { describe, it, expect } from 'vitest';
import { SceneRuntime } from '../src/runtime.js';
import { makeStore, ent } from './helpers.js';

function scripted(name: string, scriptPath: string, components: Record<string, unknown> = {}) {
  return ent(name, { Transform: {}, Script: { scriptPath }, ...components });
}

describe('ctx.scene.findPath', () => {
  it('finds a route around a solid tilemap wall between the entity and a target', async () => {
    const { store } = await makeStore({
      entities: [
        scripted('Seeker', 'scripts/seeker.js', {
          Transform: { position: { x: 16, y: 16 } },
        }),
        ent('Maze', {
          Transform: {},
          Tilemap: {
            tileSize: 32,
            solid: true,
            grid: ['.....', '.###.', '.....'],
          },
        }),
      ],
      scripts: {
        'seeker.js': `
          export default {
            onStart(ctx) {
              const path = ctx.scene.findPath({ x: 16, y: 16 }, { x: 144, y: 144 });
              ctx.log(path && path.length);
            },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    expect(runtime.logs).toHaveLength(1);
    const len = Number(runtime.logs[0].message);
    expect(Number.isFinite(len)).toBe(true);
    expect(len).toBeGreaterThan(0);
  });

  it('returns different results after a static wall entity is destroyed and a frame passes', async () => {
    const { store } = await makeStore({
      entities: [
        scripted('Seeker', 'scripts/seeker.js'),
        ent('Wall', {
          Transform: { position: { x: 50, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 1000, offset: { x: 0, y: 0 } },
        }),
      ],
      scripts: {
        'seeker.js': `
          export default {
            onStart(ctx) {
              const path = ctx.scene.findPath({ x: 0, y: 0 }, { x: 100, y: 0 });
              ctx.log('first', path && path.length);
            },
            onUpdate(ctx, dt) {
              if (ctx.time.frame === 0) {
                const wall = ctx.scene.find('Wall');
                if (wall) wall.destroy();
              }
              if (ctx.time.frame === 1) {
                const path = ctx.scene.findPath({ x: 0, y: 0 }, { x: 100, y: 0 });
                ctx.log('second', path && path.length);
              }
            },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(2);
    expect(runtime.errors).toEqual([]);
    const firstLog = runtime.logs.find((l) => l.message.startsWith('first'));
    const secondLog = runtime.logs.find((l) => l.message.startsWith('second'));
    expect(firstLog).toBeDefined();
    expect(secondLog).toBeDefined();
    const firstLen = Number(firstLog!.message.split(' ')[1]);
    const secondLen = Number(secondLog!.message.split(' ')[1]);
    expect(Number.isFinite(firstLen)).toBe(true);
    expect(Number.isFinite(secondLen)).toBe(true);
    // With the wall present, the route must detour around it; once the wall
    // is destroyed (and a frame boundary has passed so the grid is rebuilt),
    // the direct route is shorter.
    expect(secondLen).toBeLessThan(firstLen);
  });

  it('returns null and warns "nav grid too large" for a scene spanning too many cells', async () => {
    const { store } = await makeStore({
      entities: [
        scripted('Seeker', 'scripts/seeker.js'),
        ent('Ground', {
          Transform: {},
          Tilemap: { tileSize: 16, solid: true, grid: ['#'] },
        }),
        ent('WallA', {
          Transform: { position: { x: 0, y: 0 } },
          Collider: { shape: 'box', width: 16, height: 16 },
        }),
        ent('WallB', {
          Transform: { position: { x: 100000, y: 0 } },
          Collider: { shape: 'box', width: 16, height: 16 },
        }),
      ],
      scripts: {
        'seeker.js': `
          export default {
            onStart(ctx) {
              const path = ctx.scene.findPath({ x: 0, y: 0 }, { x: 100, y: 0 });
              ctx.log('result', path);
            },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    const resultLog = runtime.logs.find((l) => l.message.startsWith('result'));
    expect(resultLog).toBeDefined();
    expect(resultLog!.message).toBe('result null');
    const warnLog = runtime.logs.find((l) => l.level === 'warn');
    expect(warnLog).toBeDefined();
    expect(warnLog!.message).toContain('nav grid too large');
  });

  it('recovers within the same frame after a far-out query fails the grid cap', async () => {
    const { store } = await makeStore({
      entities: [
        scripted('Seeker', 'scripts/seeker.js'),
        ent('Wall', {
          Transform: { position: { x: 0, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 32 },
        }),
      ],
      scripts: {
        'seeker.js': `
          export default {
            onStart(ctx) {
              const far = ctx.scene.findPath({ x: 0, y: 0 }, { x: 100000, y: 0 });
              ctx.log('far', far);
              const near = ctx.scene.findPath({ x: 0, y: 64 }, { x: 100, y: 64 });
              ctx.log('near', near && near.length);
            },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    const farLog = runtime.logs.find((l) => l.message.startsWith('far'));
    const nearLog = runtime.logs.find((l) => l.message.startsWith('near'));
    expect(farLog).toBeDefined();
    expect(farLog!.message).toBe('far null');
    const warnLog = runtime.logs.find((l) => l.level === 'warn');
    expect(warnLog).toBeDefined();
    expect(warnLog!.message).toContain('nav grid too large');
    // The failed far-out build must not poison the rest of the frame: a
    // second query with modest points rebuilds and succeeds.
    expect(nearLog).toBeDefined();
    const nearLen = Number(nearLog!.message.split(' ')[1]);
    expect(Number.isFinite(nearLen)).toBe(true);
    expect(nearLen).toBeGreaterThan(0);
  });

  it('rebuilds within the same frame when a later query falls outside the cached grid bounds', async () => {
    const { store } = await makeStore({
      entities: [scripted('Seeker', 'scripts/seeker.js')],
      scripts: {
        'seeker.js': `
          export default {
            onStart(ctx) {
              const a = ctx.scene.findPath({ x: 0, y: 0 }, { x: 64, y: 0 });
              const b = ctx.scene.findPath({ x: 5000, y: 0 }, { x: 5100, y: 0 });
              ctx.log('a', a && a.length);
              ctx.log('b', b && b.length);
            },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    const aLog = runtime.logs.find((l) => l.message.startsWith('a '));
    const bLog = runtime.logs.find((l) => l.message.startsWith('b '));
    expect(aLog).toBeDefined();
    expect(bLog).toBeDefined();
    // The first grid's bounds cover only the area around the origin; the
    // second query's points lie well outside it, so the call must trigger a
    // same-frame rebuild rather than returning null off the stale grid.
    const aLen = Number(aLog!.message.split(' ')[1]);
    const bLen = Number(bLog!.message.split(' ')[1]);
    expect(aLen).toBeGreaterThan(0);
    expect(bLen).toBeGreaterThan(0);
  });

  it('reflects a tilemap.grid swap done in the SAME frame before findPath', async () => {
    const { store } = await makeStore({
      entities: [
        scripted('Seeker', 'scripts/seeker.js'),
        ent('Maze', {
          Transform: {},
          Tilemap: {
            tileSize: 32,
            solid: true,
            // Fully open to start: the direct row-0 route is unobstructed.
            grid: ['.....', '.....', '.....'],
          },
        }),
      ],
      scripts: {
        'seeker.js': `
          export default {
            onStart(ctx) {
              const from = { x: 16, y: 16 };
              const to = { x: 144, y: 16 };
              const open = ctx.scene.findPath(from, to);
              ctx.log('open', open && open.length);
              // Swap in a wall (col 2, rows 0-1) that blocks the direct route,
              // then re-query in the SAME frame. The nav grid was already built
              // and cached for this frame by the first findPath; without keying
              // the cache on the grid reference this returns the stale open grid.
              const maze = ctx.scene.find('Maze');
              maze.getComponent('Tilemap').grid = ['..#..', '..#..', '.....'];
              const walled = ctx.scene.findPath(from, to);
              ctx.log('walled', walled && walled.length);
            },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    const openLog = runtime.logs.find((l) => l.message.startsWith('open'));
    const walledLog = runtime.logs.find((l) => l.message.startsWith('walled'));
    expect(openLog).toBeDefined();
    expect(walledLog).toBeDefined();
    const openLen = Number(openLog!.message.split(' ')[1]);
    const walledLen = Number(walledLog!.message.split(' ')[1]);
    expect(Number.isFinite(openLen)).toBe(true);
    expect(Number.isFinite(walledLen)).toBe(true);
    // The post-swap query must detour around the freshly-added wall, so its
    // path is strictly longer than the open route (proving it saw the new grid
    // instead of the cached open one).
    expect(walledLen).toBeGreaterThan(openLen);
  });

  it('memoization smoke check: two calls with the same points in the same frame both succeed', async () => {
    const { store } = await makeStore({
      entities: [scripted('Seeker', 'scripts/seeker.js')],
      scripts: {
        'seeker.js': `
          export default {
            onStart(ctx) {
              const a = ctx.scene.findPath({ x: 0, y: 0 }, { x: 64, y: 0 });
              const b = ctx.scene.findPath({ x: 0, y: 0 }, { x: 64, y: 0 });
              ctx.log('a', a && a.length);
              ctx.log('b', b && b.length);
            },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    const aLog = runtime.logs.find((l) => l.message.startsWith('a '));
    const bLog = runtime.logs.find((l) => l.message.startsWith('b '));
    expect(aLog).toBeDefined();
    expect(bLog).toBeDefined();
    expect(aLog!.message).not.toContain('null');
    expect(bLog!.message).not.toContain('null');
    expect(bLog!.message.split(' ')[1]).toBe(aLog!.message.split(' ')[1]);
  });
});
