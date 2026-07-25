/**
 * Determinism of scenes that USE the game primitives.
 *
 * goldenDeterminism.test.ts proves the primitives did not disturb the four
 * pinned scenarios, but none of those scenarios carries a CharacterController,
 * Health, Respawn, Checkpoint or a bound Text — so it says nothing about the new
 * code paths themselves. These are run-twice assertions rather than absolute
 * pinned hashes, so they are platform-independent (the project's determinism
 * contract is same-seed same-platform, and trig ULP differences are explicitly
 * out of scope).
 *
 * What could plausibly break determinism here and is therefore worth pinning:
 * the controller's coyote/jump-buffer counters live in a module-level WeakMap
 * rather than in component data, Health's invulnerability countdown lives in a
 * runtime Map keyed by entity id, and captured respawn points live in another.
 * All three are state outside the serialized scene, so a leak between runs
 * would show up as a divergence.
 */
import { describe, it, expect } from 'vitest';
import { GameSession } from '../src/index.js';
import { makeStore, ent } from './helpers.js';
import { stateHash } from './determinism.js';

const DRIVER = `
-- Deterministic input script: a fixed pattern of held actions, plus damage and
-- a respawn at known frames, so every run exercises the same code paths.
function onUpdate()
  local f = ctx.time.elapsed * 60
  if f > 10 and f < 30 then
    ctx.state.add('score', 1)
  end
  if math.floor(f) == 40 then
    ctx.health.damage(ctx.entity, 1)
  end
  if math.floor(f) == 70 then
    ctx.respawn(ctx.entity)
  end
end
`;

async function primitivesStore() {
  return makeStore({
    gameState: { score: { type: 'number', initial: 0 }, hearts: { type: 'number', initial: 3 } },
    actions: { left: ['ArrowLeft'], right: ['ArrowRight'], jump: ['Space'] },
    scripts: { 'scripts/driver.lua': DRIVER },
    entities: [
      ent('Player', {
        Transform: { position: { x: 40, y: 0 } },
        PhysicsBody: { bodyType: 'dynamic' },
        Collider: { shape: 'box', width: 16, height: 16 },
        CharacterController: {
          mode: 'platformer',
          speed: 120,
          jumpHeight: 48,
          coyoteFrames: 6,
          jumpBufferFrames: 4,
          maxFallSpeed: 400,
        },
        Health: { max: 3, current: 3, invulnerableFrames: 20, deathAction: 'event-only' },
        Respawn: { useSpawnPosition: true, resetVelocity: true },
        Script: { scriptPath: 'scripts/driver.lua', params: {} },
      }),
      ent('Ground', {
        Transform: { position: { x: 0, y: 120 } },
        PhysicsBody: { bodyType: 'static' },
        Collider: { shape: 'box', width: 600, height: 24 },
      }),
      ent('Flag', {
        Transform: { position: { x: 200, y: 96 } },
        Collider: { shape: 'box', width: 32, height: 32, isTrigger: true },
        Checkpoint: { target: 'Player' },
      }),
      ent('HUD', {
        Text: { content: '', binding: { key: 'score', format: 'Score: {value}', precision: 0 } },
      }),
    ],
  });
}

/** Run the scene with a fixed input pattern and hash the result. */
async function runWithInput(frames: number, pauseWindow?: [number, number]): Promise<string> {
  const { store } = await primitivesStore();
  const session = await GameSession.create(store, { scene: 'Test', seed: 4242 });
  try {
    for (let f = 0; f < frames; f++) {
      // A fixed, frame-derived input pattern: hold right, tap jump every 15th
      // frame. Deterministic by construction, no RNG.
      session.runtime.input.setActionDown('right');
      if (f % 15 === 0) session.runtime.input.setActionDown('jump');
      else session.runtime.input.setActionUp('jump');

      if (pauseWindow && f === pauseWindow[0]) session.setPaused(true);
      if (pauseWindow && f === pauseWindow[1]) session.setPaused(false);

      session.step();
    }
    return stateHash(session);
  } finally {
    session.destroy();
  }
}

describe('determinism of scenes using the game primitives', () => {
  it('two runs of the same seed and inputs are identical', async () => {
    const first = await runWithInput(120);
    const second = await runWithInput(120);
    expect(second).toBe(first);
  });

  it('is not accidentally identical regardless of input (the hash actually observes the run)', async () => {
    // Guards against a vacuous test: a shorter run must hash differently, or
    // stateHash is not seeing anything the primitives affect.
    const short = await runWithInput(40);
    const long = await runWithInput(120);
    expect(long).not.toBe(short);
  });

  it('a paused window is itself deterministic', async () => {
    const first = await runWithInput(120, [50, 80]);
    const second = await runWithInput(120, [50, 80]);
    expect(second).toBe(first);
  });

  it('pausing changes the outcome, so the freeze is really taking effect', async () => {
    const unpaused = await runWithInput(120);
    const paused = await runWithInput(120, [50, 80]);
    expect(paused).not.toBe(unpaused);
  });

  it('two sessions over one store reproduce each other', async () => {
    // Reusing a single store is the case where per-run bookkeeping could leak:
    // Health's invulnerability Map and the captured respawn points are keyed by
    // entity id, and ids are stable across sessions built from the same store.
    // (The controller's coyote/buffer WeakMap is keyed by the component object,
    // and the runtime structuredClones authored components per run, so those
    // keys cannot collide — this test does not cover that path.)
    const { store } = await primitivesStore();
    const hashes: string[] = [];
    for (let run = 0; run < 2; run++) {
      const session = await GameSession.create(store, { scene: 'Test', seed: 4242 });
      try {
        for (let f = 0; f < 90; f++) {
          session.runtime.input.setActionDown('right');
          if (f % 15 === 0) session.runtime.input.setActionDown('jump');
          else session.runtime.input.setActionUp('jump');
          session.step();
        }
        hashes.push(stateHash(session));
      } finally {
        session.destroy();
      }
    }
    expect(hashes[1]).toBe(hashes[0]);
  });
});
