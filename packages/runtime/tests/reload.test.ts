/**
 * Runtime hot-reload and live-patch seams (Wave H): SceneRuntime.reloadScript
 * swaps a script's hooks in place while PRESERVING vars/timers/tweens (onStart
 * does NOT re-run), keeps old code running on a compile failure, re-enables an
 * error-disabled script on success, and feeds newly spawned entities the new
 * hooks. SceneRuntime.patchComponent writes a component property live (including
 * camera props read every tick).
 */
import { describe, it, expect } from 'vitest';
import { SceneRuntime } from '@hearth/runtime';
import { makeStore, ent } from './helpers.js';

function scripted(name: string, scriptPath: string, components: Record<string, unknown> = {}) {
  return ent(name, { Transform: {}, Script: { scriptPath }, ...components });
}

const luaLines = (...lines: string[]) => lines.join('\n');

describe('SceneRuntime.reloadScript', () => {
  it('preserves ctx.vars and does not re-run onStart on reload', async () => {
    const { store } = await makeStore({
      entities: [scripted('Counter', 'scripts/counter.js')],
      scripts: {
        'counter.js': `export default {
          onStart(ctx) { ctx.log('started'); ctx.vars.n = 0; },
          onUpdate(ctx) { ctx.vars.n += 1; ctx.transform.position.x = ctx.vars.n; },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(3);
    expect(runtime.find('Counter')!.transform.position.x).toBe(3);

    const result = await runtime.reloadScript(
      'scripts/counter.js',
      `export default {
        onStart(ctx) { ctx.log('started'); ctx.vars.n = 999; },
        onUpdate(ctx) { ctx.vars.n += 10; ctx.transform.position.x = ctx.vars.n; },
      };`,
    );
    expect(result).toEqual({ ok: true, entities: 1 });

    runtime.run(1);
    // n continued from 3 (vars preserved), +10 = 13 — NOT reset to 999 by a
    // second onStart.
    expect(runtime.find('Counter')!.transform.position.x).toBe(13);
    expect(runtime.logs.filter((l) => l.message === 'started')).toHaveLength(1);
  });

  it('keeps a running timer and tween alive across a reload (scheduler survives)', async () => {
    const { store } = await makeStore({
      entities: [scripted('Timed', 'scripts/timed.js')],
      scripts: {
        'timed.js': `export default {
          onStart(ctx) {
            ctx.timers.after(5, () => { ctx.vars.fired = true; });
            ctx.tweens.to('Transform.position.x', 100, 5);
          },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    const id = runtime.find('Timed')!.id;
    runtime.run(30); // 0.5s
    const before = runtime.getSchedulerSnapshot(id)!;
    expect(before.timers).toHaveLength(1);
    expect(before.tweens).toHaveLength(1);
    const remainingBefore = before.timers[0].remaining;
    const elapsedBefore = before.tweens[0].elapsed;

    const result = await runtime.reloadScript(
      'scripts/timed.js',
      `export default { onUpdate(ctx) {} };`,
    );
    expect(result).toEqual({ ok: true, entities: 1 });

    // Reload leaves the scheduler untouched — same pending timer, same tween.
    const afterReload = runtime.getSchedulerSnapshot(id)!;
    expect(afterReload.timers).toHaveLength(1);
    expect(afterReload.tweens).toHaveLength(1);
    expect(afterReload.timers[0].remaining).toBeCloseTo(remainingBefore, 6);
    expect(afterReload.tweens[0].elapsed).toBeCloseTo(elapsedBefore, 6);

    // ...and it keeps advancing after the reload.
    runtime.run(30); // another 0.5s
    const later = runtime.getSchedulerSnapshot(id)!;
    expect(later.timers[0].remaining).toBeCloseTo(remainingBefore - 0.5, 5);
    expect(later.tweens[0].elapsed).toBeCloseTo(elapsedBefore + 0.5, 5);
  });

  it('updates every entity sharing the path and reports the count', async () => {
    const { store } = await makeStore({
      entities: [scripted('A', 'scripts/shared.js'), scripted('B', 'scripts/shared.js')],
      scripts: {
        'shared.js': `export default { onUpdate(ctx) { ctx.transform.position.x = 1; } };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    expect(runtime.find('A')!.transform.position.x).toBe(1);
    expect(runtime.find('B')!.transform.position.x).toBe(1);

    const result = await runtime.reloadScript(
      'scripts/shared.js',
      `export default { onUpdate(ctx) { ctx.transform.position.x = 5; } };`,
    );
    expect(result).toEqual({ ok: true, entities: 2 });

    runtime.run(1);
    expect(runtime.find('A')!.transform.position.x).toBe(5);
    expect(runtime.find('B')!.transform.position.x).toBe(5);
  });

  it('keeps old code running and reports the line when reload fails to compile', async () => {
    const { store } = await makeStore({
      entities: [ent('L', { Transform: {}, Script: { scriptPath: 'scripts/beh.lua' } })],
      scripts: {
        'beh.lua': luaLines(
          'local s = {}',
          'function s.onUpdate(ctx, dt)',
          '  ctx.transform.position.x = ctx.transform.position.x + 1',
          'end',
          'return s',
        ),
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(2);
    expect(runtime.find('L')!.transform.position.x).toBe(2);

    const result = await runtime.reloadScript(
      'scripts/beh.lua',
      luaLines('local s = {}', 'function s.onStart(ctx)', '  local = 5', 'end'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.line).toBe(3);
      expect(result.message).toMatch(/beh\.lua:3/);
    }
    const last = runtime.errors[runtime.errors.length - 1];
    expect(last).toMatchObject({ phase: 'reload', script: 'scripts/beh.lua', line: 3 });

    // Old compiled hooks keep running.
    runtime.run(1);
    expect(runtime.find('L')!.transform.position.x).toBe(3);
    runtime.destroy();
  });

  it('re-enables an error-disabled script on a successful reload', async () => {
    const { store } = await makeStore({
      entities: [scripted('Flaky', 'scripts/flaky.js')],
      scripts: {
        'flaky.js': `export default { onUpdate() { throw new Error('boom'); } };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(5); // 3 strikes -> disabled
    expect(runtime.errors).toHaveLength(3);

    const result = await runtime.reloadScript(
      'scripts/flaky.js',
      `export default { onUpdate(ctx) { ctx.transform.position.x = 7; } };`,
    );
    expect(result).toEqual({ ok: true, entities: 1 });

    runtime.run(1);
    // Script runs again (re-enabled) and no new errors accrue.
    expect(runtime.find('Flaky')!.transform.position.x).toBe(7);
    expect(runtime.errors).toHaveLength(3);
  });

  it('feeds newly spawned entities the reloaded hooks', async () => {
    const { store } = await makeStore({
      entities: [scripted('Host', 'scripts/host.js')],
      scripts: {
        'host.js': `export default {
          onUpdate(ctx) {
            if (ctx.time.frame === 2 && !ctx.vars.done) {
              ctx.vars.done = true;
              ctx.scene.spawn({ name: 'Child', components: { Transform: {}, Script: { scriptPath: 'scripts/behavior.js' } } });
            }
          },
        };`,
        'behavior.js': `export default { onUpdate(ctx) { ctx.transform.position.x = 1; } };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    const result = await runtime.reloadScript(
      'scripts/behavior.js',
      `export default { onUpdate(ctx) { ctx.transform.position.x = 99; } };`,
    );
    expect(result).toEqual({ ok: true, entities: 0 }); // nobody uses it yet

    runtime.run(5); // Child spawns at frame 2, then runs the NEW behavior
    expect(runtime.find('Child')!.transform.position.x).toBe(99);
  });

  it('records the error line for an ordinary hook failure', async () => {
    const { store } = await makeStore({
      entities: [scripted('Boom', 'scripts/boom.js')],
      scripts: {
        'boom.js': `export default {
          onUpdate() { throw new Error('kaboom'); },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(1);
    // The throw is on source line 2 of boom.js (line 1 is the export, line 2
    // the onUpdate/throw) — proving the JS wrapper offset maps back correctly.
    expect(runtime.errors[0].line).toBe(2);
  });
});

describe('SceneRuntime.patchComponent', () => {
  it('patches a top-level component property and a nested dot path', async () => {
    const { store } = await makeStore({
      entities: [ent('Cam', { Transform: { position: { x: 0, y: 0 } }, Camera: {} })],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    const cam = runtime.find('Cam')!;

    expect(runtime.patchComponent(cam.id, 'Camera', 'ambientLight', 0.5)).toBe(true);
    expect(cam.components.Camera!.ambientLight).toBe(0.5);

    expect(runtime.patchComponent(cam.id, 'Transform', 'position.x', 42)).toBe(true);
    expect(cam.transform.position.x).toBe(42);
  });

  it('resolves an entity by unique name when the ref is not an id', async () => {
    const { store } = await makeStore({
      entities: [ent('Solo', { Transform: { position: { x: 0, y: 0 } } })],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    expect(runtime.patchComponent('Solo', 'Transform', 'position.y', 9)).toBe(true);
    expect(runtime.find('Solo')!.transform.position.y).toBe(9);
  });

  it('writes an array element via a numeric segment', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Map', {
          Transform: {},
          Tilemap: { tileSize: 16, grid: ['aaa', 'bbb'], solid: false },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    expect(runtime.patchComponent('Map', 'Tilemap', 'grid.1', 'ccc')).toBe(true);
    expect((runtime.find('Map')!.components.Tilemap!.grid as string[])[1]).toBe('ccc');
  });

  it('returns false (silent skip) for a missing entity, component, or intermediate', async () => {
    const { store } = await makeStore({
      entities: [ent('E', { Transform: { position: { x: 0, y: 0 } } })],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    expect(runtime.patchComponent('nope', 'Transform', 'position.x', 1)).toBe(false);
    expect(runtime.patchComponent('E', 'Camera', 'ambientLight', 1)).toBe(false);
    // Missing intermediate is never created.
    expect(runtime.patchComponent('E', 'Transform', 'missing.deep', 1)).toBe(false);
    expect(runtime.find('E')!.components.Transform!).not.toHaveProperty('missing');
  });

  it('reflects a camera patch in runtime.camera immediately', async () => {
    const { store } = await makeStore({
      entities: [ent('Cam', { Transform: {}, Camera: {} })],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    expect(runtime.camera.ambientLight).toBe(1);
    expect(runtime.patchComponent(runtime.find('Cam')!.id, 'Camera', 'ambientLight', 0.25)).toBe(
      true,
    );
    expect(runtime.camera.ambientLight).toBe(0.25);
  });
});
