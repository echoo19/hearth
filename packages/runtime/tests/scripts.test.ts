/**
 * Script engine: lifecycle hooks, ctx surface (vars, input, scene queries,
 * spawn/destroy, logging), collision events, and error handling.
 */
import { describe, it, expect } from 'vitest';
import { SceneRuntime, type RuntimeLog } from '@hearth/runtime';
import { makeStore, ent } from './helpers.js';

function scripted(name: string, scriptPath: string, components: Record<string, unknown> = {}) {
  return ent(name, { Transform: {}, Script: { scriptPath }, ...components });
}

describe('script lifecycle and ctx', () => {
  it('persists ctx.vars across frames and runs onStart once', async () => {
    const { store } = await makeStore({
      entities: [scripted('Counter', 'scripts/counter.js')],
      scripts: {
        'counter.js': `
          export default {
            onStart(ctx) { ctx.vars.n = 100; },
            onUpdate(ctx) { ctx.vars.n += 1; ctx.transform.position.x = ctx.vars.n; },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(10);
    expect(runtime.find('Counter')!.transform.position.x).toBe(110);
    expect(runtime.errors).toEqual([]);
  });

  it('moves an entity from input actions (setActionDown / justPressed)', async () => {
    const { store } = await makeStore({
      actions: { right: ['ArrowRight'] },
      entities: [scripted('Player', 'scripts/move.js')],
      scripts: {
        'move.js': `
          export default {
            onUpdate(ctx) {
              if (ctx.input.isDown('right')) ctx.transform.position.x += 5;
              if (ctx.input.justPressed('right')) {
                ctx.vars.presses = (ctx.vars.presses ?? 0) + 1;
                ctx.transform.position.y = ctx.vars.presses;
              }
            },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.input.setActionDown('right');
    runtime.run(5);
    const player = runtime.find('Player')!;
    expect(player.transform.position.x).toBe(25);
    expect(player.transform.position.y).toBe(1); // justPressed only on the first frame
    runtime.input.setActionUp('right');
    runtime.run(5);
    expect(player.transform.position.x).toBe(25);
    // Pressing again registers a second justPressed.
    runtime.input.setActionDown('right');
    runtime.run(1);
    expect(player.transform.position.y).toBe(2);
  });

  it('drives a kinematic body from a script', async () => {
    const { store } = await makeStore({
      entities: [
        scripted('Platform', 'scripts/platform.js', {
          Collider: { shape: 'box', width: 64, height: 16 },
          PhysicsBody: { bodyType: 'kinematic' },
        }),
      ],
      scripts: {
        'platform.js': `
          export default {
            onStart(ctx) { ctx.getComponent('PhysicsBody').velocity.x = 60; },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(60);
    expect(runtime.find('Platform')!.transform.position.x).toBeCloseTo(60, 3);
    expect(runtime.find('Platform')!.transform.position.y).toBe(0);
  });

  it('spawns and destroys entities via ctx.scene', async () => {
    const { store } = await makeStore({
      entities: [scripted('Spawner', 'scripts/spawner.js')],
      scripts: {
        'spawner.js': `
          export default {
            onStart(ctx) {
              const h = ctx.scene.spawn({
                name: 'Spawned',
                position: { x: 10, y: 20 },
                tags: ['loot'],
                components: { SpriteRenderer: { color: '#ff0000' } },
              });
              ctx.log('spawned', h.name);
            },
            onUpdate(ctx) {
              if (ctx.time.frame === 3) ctx.scene.destroy(ctx.scene.find('Spawned'));
            },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(2);
    const spawned = runtime.find('Spawned');
    expect(spawned).toBeDefined();
    expect(spawned!.transform.position).toEqual({ x: 10, y: 20 });
    expect(spawned!.components.SpriteRenderer!.color).toBe('#ff0000');
    expect(runtime.findByTag('loot').length).toBe(1);
    runtime.run(2); // frames 2 and 3 — destroyed on frame 3
    expect(runtime.find('Spawned')).toBeUndefined();
    expect(runtime.findByTag('loot').length).toBe(0);
    expect(runtime.errors).toEqual([]);
  });

  it('supports destroySelf', async () => {
    const { store } = await makeStore({
      entities: [scripted('Bomb', 'scripts/bomb.js')],
      scripts: {
        'bomb.js': `
          export default {
            onUpdate(ctx) { if (ctx.time.frame >= 2) ctx.destroySelf(); },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(2);
    expect(runtime.find('Bomb')).toBeDefined();
    runtime.run(1);
    expect(runtime.find('Bomb')).toBeUndefined();
  });

  it('captures ctx.log with frame numbers and forwards to onLog', async () => {
    const received: RuntimeLog[] = [];
    const { store } = await makeStore({
      entities: [scripted('Logger', 'scripts/logger.js')],
      scripts: {
        'logger.js': `
          export default {
            onUpdate(ctx) { if (ctx.time.frame === 2) ctx.log('hello', { a: 1 }); },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test', { onLog: (e) => received.push(e) });
    runtime.run(5);
    expect(runtime.logs).toEqual([{ frame: 2, level: 'info', message: 'hello {"a":1}' }]);
    expect(received).toEqual(runtime.logs);
  });
});

describe('collision events', () => {
  it('fires onCollision once per new contact pair, on both entities', async () => {
    const { store } = await makeStore({
      entities: [
        scripted('Ground', 'scripts/hit.js', {
          Collider: { shape: 'box', width: 200, height: 32 },
          PhysicsBody: { bodyType: 'static' },
          Transform: { position: { x: 0, y: 100 } },
        }),
        scripted('Faller', 'scripts/hit.js', {
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic' },
          Transform: { position: { x: 0, y: 0 } },
        }),
      ],
      scripts: {
        'hit.js': `
          export default {
            onCollision(ctx, other) { ctx.log(ctx.entity.name + ' hit ' + other.name); },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(120); // lands and rests — contact persists but stays one pair
    const messages = runtime.logs.map((l) => l.message);
    expect(messages).toContain('Faller hit Ground');
    expect(messages).toContain('Ground hit Faller');
    expect(messages.length).toBe(2);
    expect(runtime.errors).toEqual([]);
  });

  it('exposes collisions and isGrounded to scripts', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Ground', {
          Transform: { position: { x: 0, y: 100 } },
          Collider: { shape: 'box', width: 200, height: 32 },
          PhysicsBody: { bodyType: 'static' },
        }),
        scripted('Faller', 'scripts/grounded.js', {
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic' },
        }),
      ],
      scripts: {
        'grounded.js': `
          export default {
            onUpdate(ctx) {
              if (ctx.isGrounded() && !ctx.vars.logged) {
                ctx.vars.logged = true;
                ctx.log('grounded on ' + ctx.collisions[0].other.name);
              }
            },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(120);
    expect(runtime.logs.map((l) => l.message)).toContain('grounded on Ground');
  });
});

describe('script errors', () => {
  it('captures hook errors and disables the script after 3 consecutive failures', async () => {
    const { store } = await makeStore({
      entities: [scripted('Broken', 'scripts/broken.js')],
      scripts: {
        'broken.js': `
          export default {
            onUpdate() { throw new Error('boom'); },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(10);
    expect(runtime.errors.length).toBe(3);
    expect(runtime.errors[0]).toMatchObject({
      frame: 0,
      message: 'boom',
      entity: 'Broken',
      script: 'scripts/broken.js',
      phase: 'onUpdate',
    });
    expect(runtime.logs.some((l) => l.level === 'warn' && /disabled after 3/.test(l.message))).toBe(
      true,
    );
  });

  it('records a load error for scripts that fail to compile', async () => {
    const { store } = await makeStore({
      entities: [scripted('Bad', 'scripts/bad.js')],
      scripts: { 'bad.js': 'export default {{{ not javascript' },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(5);
    expect(runtime.errors.length).toBe(1);
    expect(runtime.errors[0].phase).toBe('load');
    expect(runtime.errors[0].script).toBe('scripts/bad.js');
  });
});
