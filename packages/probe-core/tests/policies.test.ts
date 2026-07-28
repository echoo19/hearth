/**
 * Policies: the replay guarantee, the capability gate, and how the probe works
 * out which entity is the player without being told.
 */
import { describe, expect, it } from 'vitest';
import {
  createPolicy,
  createRng,
  InputQueue,
  makeSynthetic,
  policyRegistry,
  policyUnavailable,
  probeMovement,
  resolveAvatarRef,
  STEERING_POLICIES,
  type GameUnderTest,
  type PolicyContext,
  type ProbeCapabilities,
  type StepObservation,
  type TimedInput,
} from '@hearth/probe-core';

function context(over: Partial<PolicyContext> = {}): PolicyContext {
  const capabilities: ProbeCapabilities = {
    input: { actions: ['jump', 'left', 'right'], axes: ['tilt'], pointer: true },
    senses: {
      errors: true,
      scenes: true,
      events: true,
      entities: true,
      screenshot: true,
      nav: true,
      reset: true,
      states: false,
    },
    viewport: { width: 640, height: 480 },
  };
  return {
    capabilities,
    rng: createRng(1),
    seed: 1,
    actions: ['jump', 'left', 'right'],
    axes: ['tilt'],
    viewport: capabilities.viewport,
    avatarRef: 'avatar',
    basis: null,
    navGrid: null,
    cellSize: 32,
    ...over,
  };
}

/** Drive a policy for N steps against a live game and return its input timeline. */
async function drive(game: GameUnderTest, policyName: string, seed: number, steps: number): Promise<TimedInput[]> {
  await game.start();
  const policy = createPolicy(policyName);
  policy.init(context({ rng: createRng(seed), seed }));
  const input = new InputQueue();
  let obs: StepObservation = { frame: 0, newErrors: [], sceneId: null, newEvents: [] };
  for (let i = 0; i < steps; i++) {
    const entities = (await game.listEntities?.()) ?? null;
    const avatar = entities?.find((e) => e.id === 'avatar') ?? null;
    input.setFrame(i);
    policy.step({ instant: { frame: i }, obs, entities, avatar, navGrid: null, input });
    for (const m of input.drain()) {
      if (m.kind === 'action') await (m.down ? game.setActionDown(m.action) : game.setActionUp(m.action));
      else if (m.kind === 'axis') await game.setAxis(m.axis, m.value);
      else await game.sendPointer(m.x, m.y, m.pointer);
    }
    obs = await game.step();
  }
  await game.stop();
  return input.events;
}

describe('idle', () => {
  it('injects nothing at all', async () => {
    expect(await drive(makeSynthetic(), 'idle', 1, 200)).toEqual([]);
  });
});

describe('mash', () => {
  it('replays exactly: the same seed makes the same decisions', async () => {
    const a = await drive(makeSynthetic(), 'mash', 7, 400);
    const b = await drive(makeSynthetic(), 'mash', 7, 400);
    expect(a.length).toBeGreaterThan(20);
    expect(b).toEqual(a);
  });

  it('makes different decisions for a different seed', async () => {
    const a = await drive(makeSynthetic(), 'mash', 7, 400);
    const b = await drive(makeSynthetic(), 'mash', 8, 400);
    expect(b).not.toEqual(a);
  });

  it('replays the same even when the game answers differently', async () => {
    // The bot is deterministic; the game is not required to be. A broken build
    // must still produce the identical input timeline for a given seed, or a
    // reported seed is not a repro.
    const healthy = await drive(makeSynthetic('healthy'), 'mash', 5, 300);
    const broken = await drive(makeSynthetic('broken-input'), 'mash', 5, 300);
    expect(broken).toEqual(healthy);
  });

  it('only touches the declared vocabulary', async () => {
    const events = await drive(makeSynthetic(), 'mash', 3, 300);
    for (const e of events) {
      if (e.kind === 'action') expect(['jump', 'left', 'right']).toContain(e.action);
      if (e.kind === 'axis') expect(e.axis).toBe('tilt');
      if (e.kind === 'pointer') {
        expect(e.x).toBeGreaterThanOrEqual(0);
        expect(e.x).toBeLessThanOrEqual(640);
      }
    }
  });

  it('holds actions rather than flickering them every step', async () => {
    const events = (await drive(makeSynthetic(), 'mash', 11, 600)).filter((e) => e.kind === 'action');
    // ~1/30 flip chance per action per step over 600 steps and 3 actions.
    expect(events.length).toBeLessThan(120);
    expect(events.length).toBeGreaterThan(10);
  });

  it('clicks briskly when there is no avatar (a menu, probably)', async () => {
    const game = makeSynthetic();
    await game.start();
    const policy = createPolicy('mash');
    policy.init(context({ avatarRef: null, rng: createRng(2) }));
    const input = new InputQueue();
    for (let i = 0; i < 300; i++) {
      policy.step({
        instant: { frame: i },
        obs: { frame: i, newErrors: [], sceneId: null, newEvents: [] },
        entities: null,
        avatar: null,
        navGrid: null,
        input,
      });
      input.drain();
    }
    const clicks = input.events.filter((e) => e.kind === 'pointer').length;
    expect(clicks).toBeGreaterThan(10);
  });
});

describe('the policy gate', () => {
  it('registers exactly the four policies', () => {
    expect(Object.keys(policyRegistry).sort()).toEqual(['idle', 'mash', 'seek', 'wander']);
    expect([...STEERING_POLICIES].sort()).toEqual(['seek', 'wander']);
  });

  it('refuses an unknown policy loudly', () => {
    expect(() => createPolicy('vibes')).toThrow(/unknown probe policy/);
  });

  it('lets idle and mash run against anything with inputs', () => {
    const game = makeSynthetic('healthy', { senses: { entities: false, nav: false, screenshot: false } });
    expect(policyUnavailable('idle', game.capabilities)).toBeNull();
    expect(policyUnavailable('mash', game.capabilities)).toBeNull();
  });

  it('blocks steering when entities or nav are missing, naming what is missing', () => {
    const noNav = makeSynthetic('healthy', { senses: { nav: false } });
    expect(policyUnavailable('wander', noNav.capabilities)).toMatch(/nav grid/);
    const noEntities = makeSynthetic('healthy', { senses: { entities: false } });
    expect(policyUnavailable('seek', noEntities.capabilities)).toMatch(/entity enumeration/);
    expect(policyUnavailable('wander', makeSynthetic().capabilities)).toBeNull();
  });

  it('blocks mash when the game declares no way to be played', () => {
    const mute = makeSynthetic('healthy', { input: { actions: [], axes: [], pointer: false } });
    expect(policyUnavailable('mash', mute.capabilities)).toMatch(/nothing to mash/);
  });

  it('refuses to steer without a measured basis', () => {
    expect(() => createPolicy('wander').init(context({ basis: null }))).toThrow(/movement basis/);
    expect(() => createPolicy('wander').init(context({ basis: { entries: [] } }))).toThrow(/movement basis/);
  });

  it('refuses to seek without a target', () => {
    const basis = { entries: [{ input: { kind: 'action' as const, action: 'right' }, dx: 10, dy: 0 }] };
    expect(() => createPolicy('seek').init(context({ basis }))).toThrow(/needs a target/);
  });
});

describe('avatar resolution', () => {
  it('honors an explicit ref', async () => {
    const game = makeSynthetic();
    await game.start();
    expect(await resolveAvatarRef(game, 'Goal')).toEqual({ ref: 'goal', how: 'explicit' });
    await expect(resolveAvatarRef(game, 'nobody')).rejects.toThrow(/not found/);
  });

  it('falls back to a player tag', async () => {
    const game = makeSynthetic();
    await game.start();
    expect(await resolveAvatarRef(game)).toEqual({ ref: 'avatar', how: 'tag' });
  });

  it('resolves nothing when there are no entities to look at', async () => {
    const game = makeSynthetic('healthy', { senses: { entities: false } });
    await game.start();
    expect(await resolveAvatarRef(game)).toEqual({ ref: null, how: 'none' });
  });

  it('finds the avatar by probing which entity the controls move', async () => {
    const game = makeSynthetic();
    await game.start();
    const probe = await probeMovement(game, { actions: ['jump', 'left', 'right'], axes: [] });
    expect(probe.aborted).toBe(false);
    expect(probe.ref).toBe('avatar');
    expect(probe.how).toBe('largest-mover');

    // The basis is control-subtracted, so gravity is not mistaken for steering.
    const byInput = new Map(
      (probe.basis?.entries ?? []).map((e) => [e.input.kind === 'action' ? e.input.action : e.input.axis, e]),
    );
    expect(byInput.get('left')?.dx).toBeLessThan(0);
    expect(byInput.get('right')?.dx).toBeGreaterThan(0);
    expect(byInput.get('jump')?.dy).toBeLessThan(0);
    expect(Math.abs(byInput.get('left')?.dy ?? 99)).toBeLessThan(2);
  });

  it('leaves a dead control out of the movement basis', async () => {
    const game = makeSynthetic('broken-input');
    await game.start();
    const probe = await probeMovement(game, { actions: ['jump', 'left', 'right'], axes: [] });
    const actions = (probe.basis?.entries ?? []).map((e) => (e.input.kind === 'action' ? e.input.action : ''));
    expect(actions).not.toContain('right');
    expect(actions).toContain('left');
  });

  it('aborts rather than reporting a basis measured through a crash', async () => {
    const game = makeSynthetic('crash-at-100', { crashAt: 40 });
    await game.start();
    const probe = await probeMovement(game, { actions: ['jump', 'left', 'right'], axes: [] });
    expect(probe.aborted).toBe(true);
    expect(probe.basis).toBeNull();
  });
});
