/**
 * ctx v2 stdlib surface: seeded RNG, easings, timers, tweens, save/load
 * persistence, and camera control — all deterministic under the fixed step
 * (default project settings: 60 Hz, so dt = 1/60).
 */
import { describe, it, expect } from 'vitest';
import {
  EASINGS,
  EntityScheduler,
  MemorySessionStorage,
  SceneRuntime,
  createRng,
  resolveNumericTarget,
} from '@hearth/runtime';
import { makeStore, ent } from './helpers.js';

const messages = (runtime: SceneRuntime) => runtime.logs.map((l) => l.message);

async function runScript(
  source: string,
  frames: number,
  opts: { entities?: Record<string, unknown>[]; seed?: number; storage?: MemorySessionStorage } = {},
): Promise<SceneRuntime> {
  const { store } = await makeStore({
    entities: [
      ent('Subject', { Transform: {}, Script: { scriptPath: 'scripts/main.js' } }),
      ...(opts.entities ?? []),
    ],
    scripts: { 'main.js': source },
  });
  const runtime = await SceneRuntime.create(store, 'Test', {
    seed: opts.seed,
    storage: opts.storage,
  });
  runtime.run(frames);
  return runtime;
}

describe('createRng', () => {
  it('same seed produces the same sequence, in [0, 1)', () => {
    const a = createRng(123);
    const b = createRng(123);
    for (let i = 0; i < 20; i++) {
      const value = a();
      expect(b()).toBe(value);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('different seeds diverge', () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });
});

describe('EASINGS', () => {
  it('all easings hit 0 at t=0, 1 at t=1, and are monotonic', () => {
    for (const easing of Object.values(EASINGS)) {
      expect(easing(0)).toBeCloseTo(0, 12);
      expect(easing(1)).toBeCloseTo(1, 12);
      let prev = easing(0);
      for (let i = 1; i <= 100; i++) {
        const next = easing(i / 100);
        expect(next).toBeGreaterThanOrEqual(prev);
        prev = next;
      }
    }
  });
});

describe('resolveNumericTarget', () => {
  it('resolves nested numeric paths and rejects everything else', () => {
    const components = { Transform: { position: { x: 4, y: 5 } }, Text: { content: 'hi' } };
    const hit = resolveNumericTarget(components, 'Transform.position.x');
    expect(hit).not.toBeNull();
    expect(hit!.holder[hit!.key]).toBe(4);
    expect(resolveNumericTarget(components, 'Transform.position.z')).toBeNull();
    expect(resolveNumericTarget(components, 'Text.content')).toBeNull();
    expect(resolveNumericTarget(components, 'Nope.x')).toBeNull();
    expect(resolveNumericTarget(components, '')).toBeNull();
  });
});

describe('ctx.timers', () => {
  it('after() fires once at a deterministic frame', async () => {
    const runtime = await runScript(
      `export default {
        onStart(ctx) { ctx.timers.after(3 / 60, () => ctx.log('after:' + ctx.time.frame)); },
      };`,
      10,
    );
    expect(runtime.errors).toEqual([]);
    expect(messages(runtime)).toEqual(['after:2']);
  });

  it('every() fires repeatedly at deterministic frames', async () => {
    const runtime = await runScript(
      `export default {
        onStart(ctx) { ctx.timers.every(2 / 60, () => ctx.log('tick:' + ctx.time.frame)); },
      };`,
      6,
    );
    expect(messages(runtime)).toEqual(['tick:1', 'tick:3', 'tick:5']);
  });

  it('cancel() stops a pending timer', async () => {
    const runtime = await runScript(
      `export default {
        onStart(ctx) { ctx.vars.id = ctx.timers.after(10 / 60, () => ctx.log('fired')); },
        onUpdate(ctx) { if (ctx.time.frame === 3) ctx.timers.cancel(ctx.vars.id); },
      };`,
      30,
    );
    expect(messages(runtime)).toEqual([]);
  });

  it('timers die with their entity', async () => {
    const runtime = await runScript(
      `export default {
        onStart(ctx) {
          ctx.timers.after(10 / 60, () => ctx.log('fired'));
          ctx.destroySelf();
        },
      };`,
      30,
    );
    expect(messages(runtime)).toEqual([]);
    expect(runtime.find('Subject')).toBeUndefined();
  });
});

describe('ctx.tweens', () => {
  it('reaches the target exactly at duration, monotonically, then completes', async () => {
    const runtime = await runScript(
      `export default {
        onStart(ctx) {
          ctx.tweens.to('Transform.position.x', 100, 0.5, {
            easing: 'easeOut',
            onComplete: () => ctx.log('done'),
          });
        },
        onUpdate(ctx) { ctx.log('x:' + ctx.transform.position.x); },
      };`,
      40,
    );
    expect(runtime.errors).toEqual([]);
    const xs = messages(runtime)
      .filter((m) => m.startsWith('x:'))
      .map((m) => Number(m.slice(2)));
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
    expect(xs[xs.length - 1]).toBe(100);
    expect(runtime.find('Subject')!.transform.position.x).toBe(100);
    expect(messages(runtime)).toContain('done');
  });

  it('cancel() freezes the value and skips onComplete', async () => {
    const runtime = await runScript(
      `export default {
        onStart(ctx) {
          ctx.vars.id = ctx.tweens.to('Transform.position.x', 100, 0.5, {
            onComplete: () => ctx.log('done'),
          });
        },
        onUpdate(ctx) { if (ctx.time.frame === 5) ctx.tweens.cancel(ctx.vars.id); },
      };`,
      60,
    );
    const x = runtime.find('Subject')!.transform.position.x;
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(100);
    expect(messages(runtime)).not.toContain('done');
  });

  it('warns and returns "" for unknown or non-numeric paths', async () => {
    const runtime = await runScript(
      `export default {
        onStart(ctx) {
          ctx.log('id:[' + ctx.tweens.to('Nope.x', 1, 0.5) + ']');
          ctx.log('id:[' + ctx.tweens.to('Text.content', 1, 0.5) + ']');
        },
      };`,
      2,
    );
    expect(messages(runtime).filter((m) => m === 'id:[]')).toHaveLength(2);
    expect(runtime.logs.filter((l) => l.level === 'warn' && l.message.includes('tweens.to'))).toHaveLength(2);
    expect(runtime.errors).toEqual([]);
  });
});

describe('ctx.random', () => {
  const RANDOM_SCRIPT = `export default {
    onStart(ctx) {
      ctx.log('n:' + ctx.random.next());
      ctx.log('r:' + ctx.random.range(10, 20));
      ctx.log('i:' + ctx.random.int(1, 6));
    },
  };`;

  it('is seeded and deterministic: same seed, same sequence', async () => {
    const a = await runScript(RANDOM_SCRIPT, 1, { seed: 7 });
    const b = await runScript(RANDOM_SCRIPT, 1, { seed: 7 });
    expect(messages(a)).toEqual(messages(b));
    // The stream is exactly createRng(seed).
    const rng = createRng(7);
    expect(messages(a)[0]).toBe('n:' + rng());
  });

  it('different seeds produce different sequences, within bounds', async () => {
    const a = await runScript(RANDOM_SCRIPT, 1, { seed: 1 });
    const b = await runScript(RANDOM_SCRIPT, 1, { seed: 2 });
    expect(messages(a)).not.toEqual(messages(b));
    for (const runtime of [a, b]) {
      const range = Number(messages(runtime)[1].slice(2));
      const int = Number(messages(runtime)[2].slice(2));
      expect(range).toBeGreaterThanOrEqual(10);
      expect(range).toBeLessThan(20);
      expect(Number.isInteger(int)).toBe(true);
      expect(int).toBeGreaterThanOrEqual(1);
      expect(int).toBeLessThanOrEqual(6);
    }
  });
});

describe('ctx.save / ctx.load / ctx.clearSave', () => {
  it('round-trips JSON values and returns null when absent', async () => {
    const runtime = await runScript(
      `export default {
        onStart(ctx) {
          ctx.save('score', { best: 42 });
          ctx.log('loaded:' + JSON.stringify(ctx.load('score')));
          ctx.log('missing:' + JSON.stringify(ctx.load('nope')));
          ctx.clearSave('score');
          ctx.log('cleared:' + JSON.stringify(ctx.load('score')));
        },
      };`,
      1,
    );
    expect(messages(runtime)).toEqual([
      'loaded:{"best":42}',
      'missing:null',
      'cleared:null',
    ]);
  });

  it('clearSave() with no key clears everything', async () => {
    const runtime = await runScript(
      `export default {
        onStart(ctx) {
          ctx.save('a', 1);
          ctx.save('b', 2);
          ctx.clearSave();
          ctx.log('a:' + JSON.stringify(ctx.load('a')) + ' b:' + JSON.stringify(ctx.load('b')));
        },
      };`,
      1,
    );
    expect(messages(runtime)).toEqual(['a:null b:null']);
  });

  it('returns null and warns for unparseable stored values', async () => {
    const storage = new MemorySessionStorage();
    storage.set('bad', '{not json');
    const runtime = await runScript(
      `export default {
        onStart(ctx) { ctx.log('bad:' + JSON.stringify(ctx.load('bad'))); },
      };`,
      1,
      { storage },
    );
    expect(messages(runtime)).toContain('bad:null');
    expect(runtime.logs.some((l) => l.level === 'warn' && l.message.includes('could not parse'))).toBe(true);
  });
});

describe('ctx.camera', () => {
  const CAMERA = ent('Cam', { Transform: {}, Camera: { isMain: true } });

  it('setPosition/getPosition and setZoom/getZoom hit the main camera', async () => {
    const runtime = await runScript(
      `export default {
        onStart(ctx) {
          ctx.camera.setPosition(50, 60);
          const pos = ctx.camera.getPosition();
          ctx.log('pos:' + pos.x + ',' + pos.y);
          ctx.camera.setZoom(2);
          ctx.log('zoom:' + ctx.camera.getZoom());
        },
      };`,
      1,
      { entities: [CAMERA] },
    );
    expect(runtime.errors).toEqual([]);
    expect(messages(runtime)).toEqual(['pos:50,60', 'zoom:2']);
    const cam = runtime.find('Cam')!;
    expect(cam.transform.position).toEqual({ x: 50, y: 60 });
    expect(cam.components.Camera!.zoom).toBe(2);
  });

  it('follow() copies the target world position after physics each frame', async () => {
    const runtime = await runScript(
      `export default {
        onStart(ctx) { ctx.camera.follow('Subject'); },
        onUpdate(ctx) { ctx.transform.position.x += 10; },
      };`,
      3,
      { entities: [CAMERA] },
    );
    expect(runtime.find('Subject')!.transform.position.x).toBe(30);
    expect(runtime.find('Cam')!.transform.position).toEqual({ x: 30, y: 0 });
  });

  it('follow(null) stops following; unknown target warns', async () => {
    const runtime = await runScript(
      `export default {
        onStart(ctx) { ctx.camera.follow('Subject'); },
        onUpdate(ctx) {
          ctx.transform.position.x += 10;
          if (ctx.time.frame === 1) ctx.camera.follow(null);
          if (ctx.time.frame === 2) ctx.camera.follow('Ghost');
        },
      };`,
      5,
      { entities: [CAMERA] },
    );
    // Followed at end of frame 0 (x=10); follow(null) during frame 1's
    // update stops the copy before that frame ends, so the camera stays put.
    expect(runtime.find('Cam')!.transform.position.x).toBe(10);
    expect(runtime.logs.some((l) => l.level === 'warn' && l.message.includes('camera.follow: entity not found'))).toBe(true);
  });

  it('warns once and no-ops when the scene has no camera', async () => {
    const runtime = await runScript(
      `export default {
        onStart(ctx) {
          ctx.camera.setPosition(1, 2);
          ctx.camera.setZoom(3);
          ctx.log('zoom:' + ctx.camera.getZoom());
        },
      };`,
      1,
    );
    expect(runtime.errors).toEqual([]);
    const warns = runtime.logs.filter((l) => l.level === 'warn' && l.message.includes('no Camera entity'));
    expect(warns).toHaveLength(1);
    expect(messages(runtime)).toContain('zoom:1'); // build-settings default view
  });
});

describe('EntityScheduler.listTimers / listTweens', () => {
  it('returns plain serializable data with closures omitted', () => {
    const scheduler = new EntityScheduler();
    scheduler.after(1, () => {});
    scheduler.every(0.5, () => {});
    const holder = { x: 0 };
    scheduler.tweenTo(holder, 'x', 10, 1, EASINGS.linear, () => {});
    scheduler.step(0.1, () => {});

    const timers = scheduler.listTimers();
    expect(timers).toHaveLength(2);
    for (const timer of timers) {
      expect(Object.keys(timer).sort()).toEqual(['id', 'interval', 'remaining', 'repeat']);
    }
    const after = timers.find((t) => !t.repeat)!;
    expect(after.interval).toBe(1);
    expect(after.remaining).toBeCloseTo(0.9, 10);
    const every = timers.find((t) => t.repeat)!;
    expect(every.interval).toBe(0.5);
    expect(every.remaining).toBeCloseTo(0.4, 10);

    const tweens = scheduler.listTweens();
    expect(tweens).toHaveLength(1);
    for (const tween of tweens) {
      expect(Object.keys(tween).sort()).toEqual(['duration', 'elapsed', 'from', 'id', 'key', 'to']);
    }
    expect(tweens[0]).toMatchObject({ key: 'x', from: 0, to: 10, duration: 1 });
    expect(tweens[0].elapsed).toBeCloseTo(0.1, 10);
  });

  it('lists timers/tweens with no fn/onComplete/holder present anywhere', () => {
    const scheduler = new EntityScheduler();
    scheduler.after(1, () => {
      throw new Error('should never be inspected, only invoked');
    });
    scheduler.tweenTo({ x: 0 }, 'x', 1, 1, EASINGS.linear, () => {});
    const [timer] = scheduler.listTimers();
    const [tween] = scheduler.listTweens();
    expect('fn' in timer).toBe(false);
    expect('onComplete' in tween).toBe(false);
    expect('holder' in tween).toBe(false);
  });
});

describe('SceneRuntime.getSchedulerSnapshot', () => {
  it('snapshots a scripted entity\'s pending timers and active tween', async () => {
    const runtime = await runScript(
      `export default {
        onStart(ctx) {
          ctx.timers.after(1, () => {});
          ctx.timers.every(0.5, () => {});
          ctx.tweens.to('Transform.position.x', 100, 1, { easing: 'linear' });
        },
      };`,
      3,
    );
    const entity = runtime.find('Subject')!;
    const snapshot = runtime.getSchedulerSnapshot(entity.id);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.timers).toHaveLength(2);
    const after = snapshot!.timers.find((t) => !t.repeat)!;
    expect(after.interval).toBe(1);
    expect(after.remaining).toBeCloseTo(1 - 3 / 60, 10);
    const every = snapshot!.timers.find((t) => t.repeat)!;
    expect(every.remaining).toBeCloseTo(0.5 - 3 / 60, 10);

    expect(snapshot!.tweens).toHaveLength(1);
    expect(snapshot!.tweens[0]).toMatchObject({ key: 'x', from: 0, to: 100, duration: 1 });
    expect(snapshot!.tweens[0].elapsed).toBeCloseTo(3 / 60, 10);
  });

  it('returns null for an unknown entity id', async () => {
    const runtime = await runScript(`export default {};`, 1);
    expect(runtime.getSchedulerSnapshot('nope')).toBeNull();
  });
});
