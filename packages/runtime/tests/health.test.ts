/**
 * Health integration: damage/heal clamping, the `damaged`/`healed`/`died`
 * events, invulnerability frames counted down by the fixed step, every
 * deathAction, and the `enabled: false` escape hatch.
 *
 * Damage and heal are driven through ctx.health from a real script — the only
 * public path — triggered by runtime.emitEvent so each call lands on a frame
 * the test chose, with no test-only runtime API added.
 */
import { describe, expect, it } from 'vitest';
import { SceneRuntime } from '@hearth/runtime';
import type { GameEventRecord } from '@hearth/runtime';
import { ent, makeStore } from './helpers.js';

/**
 * A scripted remote control on its own entity (so it survives the target
 * being destroyed): emitEvent('cmd', {op, target, amount}) → ctx.health.
 */
const DRIVER = `export default {
  onStart(ctx) {
    ctx.events.on('cmd', (d) => {
      if (d.op === 'damage') ctx.health.damage(d.target, d.amount);
      else if (d.op === 'heal') ctx.health.heal(d.target, d.amount);
      else if (d.op === 'probe') {
        const hp = ctx.health.get(d.target);
        ctx.log('hp=' + hp.current + '/' + hp.max + ' inv=' + ctx.health.isInvulnerable(d.target));
      }
    });
  },
};`;

/** Scene: one 'Hero' carrying Health(overrides) plus the 'Driver'. */
async function makeHealthRuntime(
  health: Record<string, unknown>,
  heroExtra: Record<string, unknown> = {},
): Promise<SceneRuntime> {
  const { store } = await makeStore({
    entities: [
      ent('Hero', { Transform: {}, Health: health, ...heroExtra }),
      ent('Driver', { Transform: {}, Script: { scriptPath: 'scripts/driver.js' } }),
    ],
    scripts: { 'driver.js': DRIVER },
  });
  const runtime = await SceneRuntime.create(store, 'Test');
  runtime.run(1); // let Driver.onStart subscribe
  return runtime;
}

const hpOf = (rt: SceneRuntime) => rt.find('Hero')!.components.Health!;
const named = (rt: SceneRuntime, name: string): GameEventRecord[] =>
  rt.events.filter((e) => e.name === name);

const damage = (rt: SceneRuntime, amount: number, target = 'Hero') =>
  rt.emitEvent('cmd', { op: 'damage', target, amount });
const heal = (rt: SceneRuntime, amount: number, target = 'Hero') =>
  rt.emitEvent('cmd', { op: 'heal', target, amount });

describe('ctx.health.damage', () => {
  it('reduces current and emits damaged with entity, amount and current', async () => {
    const rt = await makeHealthRuntime({ max: 5, current: 5 });
    damage(rt, 2);
    expect(hpOf(rt).current).toBe(3);
    expect(named(rt, 'damaged').map((e) => e.data)).toEqual([
      { entity: 'Hero', amount: 2, current: 3 },
    ]);
    expect(rt.errors).toEqual([]);
  });

  it('clamps current at 0 rather than going negative', async () => {
    const rt = await makeHealthRuntime({ max: 5, current: 2 });
    damage(rt, 99);
    expect(hpOf(rt).current).toBe(0);
    // The event reports the RAW amount asked for, but the clamped current.
    expect(named(rt, 'damaged')[0].data).toEqual({ entity: 'Hero', amount: 99, current: 0 });
  });

  it('emits died once on the hit that takes current to 0', async () => {
    const rt = await makeHealthRuntime({ max: 3, current: 1 });
    damage(rt, 1);
    expect(hpOf(rt).current).toBe(0);
    expect(named(rt, 'died').map((e) => e.data)).toEqual([{ entity: 'Hero' }]);
    expect(rt.eventCounts.get('died')).toBe(1);
  });

  /**
   * KNOWN PRODUCT DEFECT (runtime.ts applyDamage, packages/runtime/src/runtime.ts:1058).
   *
   * `died` is emitted from the `hp.current === 0` branch on EVERY applied hit,
   * with no "was alive before this hit" guard. Under the default
   * deathAction 'event-only' the entity stays in the scene, so a hazard still
   * overlapping a corpse re-fires `died` on every subsequent hit — and any
   * `died` handler (play death sfx, decrement lives, load the game-over
   * scene) runs again each time. `deathAction: 'disable'` has the same
   * problem, because applyDamage never checks `entity.enabled`.
   *
   * The fix is a one-line guard: capture `hp.current > 0` before the subtract
   * and only emit `died` on the transition. Left failing deliberately rather
   * than fixed here — this file only writes tests.
   */
  it('does not re-emit died when an already-dead entity is damaged again', async () => {
    const rt = await makeHealthRuntime({ max: 3, current: 1 });
    damage(rt, 1);
    expect(named(rt, 'died').length).toBe(1);
    // Already at 0. `damaged` firing again is arguable; a second `died` is not.
    damage(rt, 1);
    rt.step();
    damage(rt, 1);
    expect(hpOf(rt).current).toBe(0);
    expect(rt.eventCounts.get('died')).toBe(1);
  });

  it('does not emit died on a hit that leaves current above 0', async () => {
    const rt = await makeHealthRuntime({ max: 3, current: 3 });
    damage(rt, 2);
    expect(hpOf(rt).current).toBe(1);
    expect(named(rt, 'died')).toEqual([]);
  });

  it('ignores a non-positive amount entirely', async () => {
    const rt = await makeHealthRuntime({ max: 5, current: 5 });
    damage(rt, 0);
    damage(rt, -3);
    expect(hpOf(rt).current).toBe(5);
    expect(named(rt, 'damaged')).toEqual([]);
  });

  it('throws a named error when the entity has no Health', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Rock', { Transform: {} }),
        ent('Driver', { Transform: {}, Script: { scriptPath: 'scripts/driver.js' } }),
      ],
      scripts: { 'driver.js': DRIVER },
    });
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(1);
    damage(rt, 1, 'Rock');
    // The throw surfaces through the script-error channel (emitEvent catches
    // handler throws), naming both the ctx method and the entity.
    expect(rt.errors.length).toBe(1);
    expect(rt.errors[0].message).toBe('ctx.health.damage: no Health on "Rock"');
    expect(rt.errors[0].phase).toBe('onEvent');
  });

  it('throws a named error for an unknown entity', async () => {
    const rt = await makeHealthRuntime({ max: 3, current: 3 });
    damage(rt, 1, 'Ghost');
    expect(rt.errors.map((e) => e.message)).toEqual([
      'ctx.health.damage: entity not found "Ghost"',
    ]);
  });
});

describe('Health.invulnerableFrames', () => {
  it('blocks damage for exactly invulnerableFrames steps, then lets it land again', async () => {
    const rt = await makeHealthRuntime({ max: 10, current: 10, invulnerableFrames: 3 });
    damage(rt, 1);
    expect(hpOf(rt).current).toBe(9);

    // Frames 1..3 of immunity: each step decrements the counter, and every
    // hit in between is swallowed.
    for (let i = 0; i < 3; i++) {
      damage(rt, 1);
      expect(hpOf(rt).current, `hit ${i + 1} should be blocked`).toBe(9);
      rt.step();
    }
    // Only three `damaged` events so far (the initial hit); blocked hits emit
    // nothing at all.
    expect(named(rt, 'damaged').length).toBe(1);

    // The third step's countdown deleted the entry, so this hit lands.
    damage(rt, 1);
    expect(hpOf(rt).current).toBe(8);
    expect(named(rt, 'damaged').length).toBe(2);
  });

  it('reports isInvulnerable through ctx.health while the window is open', async () => {
    const rt = await makeHealthRuntime({ max: 10, current: 10, invulnerableFrames: 2 });
    rt.emitEvent('cmd', { op: 'probe', target: 'Hero' });
    damage(rt, 1);
    rt.emitEvent('cmd', { op: 'probe', target: 'Hero' });
    rt.step(); // 2 -> 1
    rt.emitEvent('cmd', { op: 'probe', target: 'Hero' });
    rt.step(); // 1 -> deleted
    rt.emitEvent('cmd', { op: 'probe', target: 'Hero' });
    expect(rt.logs.map((l) => l.message)).toEqual([
      'hp=10/10 inv=false',
      'hp=9/10 inv=true',
      'hp=9/10 inv=true',
      'hp=9/10 inv=false',
    ]);
  });

  it('does not count the invulnerability window down while paused', async () => {
    const rt = await makeHealthRuntime({ max: 10, current: 10, invulnerableFrames: 2 });
    damage(rt, 1);
    rt.paused = true;
    rt.run(30); // frozen simulation: the window must not expire
    damage(rt, 1);
    expect(hpOf(rt).current).toBe(9);
    rt.paused = false;
    rt.run(2);
    damage(rt, 1);
    expect(hpOf(rt).current).toBe(8);
  });

  it('invulnerableFrames: 0 lets consecutive hits land in the same frame', async () => {
    const rt = await makeHealthRuntime({ max: 10, current: 10, invulnerableFrames: 0 });
    damage(rt, 1);
    damage(rt, 1);
    expect(hpOf(rt).current).toBe(8);
  });
});

describe('ctx.health.heal', () => {
  it('clamps at max and reports the clamped current', async () => {
    const rt = await makeHealthRuntime({ max: 5, current: 1 });
    heal(rt, 99);
    expect(hpOf(rt).current).toBe(5);
    expect(named(rt, 'healed')[0].data).toEqual({ entity: 'Hero', amount: 99, current: 5 });
  });

  it('emits nothing when already at max', async () => {
    const rt = await makeHealthRuntime({ max: 5, current: 5 });
    heal(rt, 3);
    expect(hpOf(rt).current).toBe(5);
    expect(named(rt, 'healed')).toEqual([]);
    expect(rt.eventCounts.get('healed')).toBeUndefined();
  });

  it('is not blocked by an open invulnerability window', async () => {
    const rt = await makeHealthRuntime({ max: 5, current: 5, invulnerableFrames: 10 });
    damage(rt, 3);
    expect(hpOf(rt).current).toBe(2);
    heal(rt, 1); // invulnerability is about damage only
    expect(hpOf(rt).current).toBe(3);
  });

  it('throws a named error when the entity has no Health', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Rock', { Transform: {} }),
        ent('Driver', { Transform: {}, Script: { scriptPath: 'scripts/driver.js' } }),
      ],
      scripts: { 'driver.js': DRIVER },
    });
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(1);
    heal(rt, 1, 'Rock');
    expect(rt.errors.map((e) => e.message)).toEqual(['ctx.health.heal: no Health on "Rock"']);
  });
});

describe('Health.deathAction', () => {
  it("'event-only' (the default) leaves the entity alone", async () => {
    const rt = await makeHealthRuntime({ max: 1, current: 1 });
    expect(hpOf(rt).deathAction).toBe('event-only');
    damage(rt, 1);
    rt.run(2); // give flushDestroyed two chances to reap it
    const hero = rt.find('Hero');
    expect(hero).toBeDefined();
    expect(hero!.enabled).toBe(true);
    expect(hero!.components.Health!.current).toBe(0);
  });

  it("'destroy' removes the entity", async () => {
    const rt = await makeHealthRuntime({ max: 1, current: 1, deathAction: 'destroy' });
    damage(rt, 1);
    expect(rt.find('Hero')).toBeUndefined();
    rt.run(2);
    expect(rt.find('Hero')).toBeUndefined();
    expect(rt.getEntities().map((e) => e.name)).toEqual(['Driver']);
  });

  it("'disable' keeps the entity but clears enabled", async () => {
    const rt = await makeHealthRuntime({ max: 1, current: 1, deathAction: 'disable' });
    damage(rt, 1);
    rt.run(2);
    const hero = rt.find('Hero');
    expect(hero).toBeDefined();
    expect(hero!.enabled).toBe(false);
    expect(hero!.components.Health!.current).toBe(0);
  });

  it("'destroy' is skipped when a died handler revives by healing", async () => {
    const { store } = await makeStore({
      entities: [
        ent('Hero', { Transform: {}, Health: { max: 3, current: 1, deathAction: 'destroy' } }),
        ent('Medic', { Transform: {}, Script: { scriptPath: 'scripts/medic.js' } }),
        ent('Driver', { Transform: {}, Script: { scriptPath: 'scripts/driver.js' } }),
      ],
      scripts: {
        'driver.js': DRIVER,
        'medic.js': `export default {
          onStart(ctx) { ctx.events.on('died', (d) => ctx.health.heal(d.entity, 3)); },
        };`,
      },
    });
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(1);
    damage(rt, 1);
    // deathAction is read AFTER `died` delivery, so the revive wins.
    expect(rt.find('Hero')).toBeDefined();
    expect(hpOf(rt).current).toBe(3);
    expect(rt.errors).toEqual([]);
  });
});

describe('Health.enabled', () => {
  it('makes damage and heal no-ops without removing the component', async () => {
    const rt = await makeHealthRuntime({ max: 5, current: 3, enabled: false });
    damage(rt, 2);
    heal(rt, 2);
    expect(hpOf(rt).current).toBe(3);
    expect(named(rt, 'damaged')).toEqual([]);
    expect(named(rt, 'healed')).toEqual([]);
    // Still readable — disabled, not absent.
    rt.emitEvent('cmd', { op: 'probe', target: 'Hero' });
    expect(rt.logs.map((l) => l.message)).toEqual(['hp=3/5 inv=false']);
    expect(rt.errors).toEqual([]);
  });

  it('re-enabling restores damage', async () => {
    const rt = await makeHealthRuntime({ max: 5, current: 3, enabled: false });
    damage(rt, 2);
    expect(hpOf(rt).current).toBe(3);
    hpOf(rt).enabled = true;
    damage(rt, 2);
    expect(hpOf(rt).current).toBe(1);
  });
});
