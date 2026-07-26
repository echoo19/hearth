/**
 * End-to-end discrimination: does driving the *same* scripted run against a
 * healthy game and against broken variants produce observably different
 * evidence through the contract?
 *
 * NOTE FOR THE CONTROLLER: `@hearth/probe-core`'s `runSweep` did not exist
 * yet when this package was written (no `packages/probe-core/src/sweep.ts`),
 * so these tests drive the adapter directly through the `GameUnderTest`
 * contract with a fixed 200-step script and assert on the observations. Once
 * the sweep engine lands, the same three fixtures (`?variant=healthy`,
 * `broken-jump`, `pit-softlock`, plus `crash`) are ready to be re-run through
 * `runSweep` and should separate on verdict distribution the same way they
 * separate here on raw observations.
 */
import { describe, it, expect } from 'vitest';
import type { StepObservation } from '@hearth/probe-core';
import { canLaunchChromium, type WebGameUnderTest } from '../src/index.js';
import { RUNNER_DIR, openFixture } from './support.js';

const hasChromium = await canLaunchChromium();

const MAX_STEPS = 200;
/** Player x where jumping clears the pit (pit spans world x 320..400). */
const JUMP_ZONE = { from: 250, to: 316 };
/** The player's resting center y; anything meaningfully above it is airborne. */
const GROUND_CENTER_Y = 384;

interface RunTrace {
  steps: number;
  events: string[];
  scenes: string[];
  errors: string[];
  xs: number[];
}

/**
 * One scripted run: hold right, and jump when standing on the ground just
 * short of the pit. Identical script for every variant — only the game
 * differs, which is the whole point.
 */
async function scriptedRun(game: WebGameUnderTest, maxSteps = MAX_STEPS): Promise<RunTrace> {
  const trace: RunTrace = { steps: 0, events: [], scenes: [], errors: [], xs: [] };
  await game.setActionDown('right');
  let jumping = false;

  for (let i = 0; i < maxSteps; i++) {
    const player = (await game.listEntities!()).find((e) => e.id === 'player');
    if (player) {
      trace.xs.push(player.x);
      const grounded = player.y >= GROUND_CENTER_Y - 1;
      const shouldJump = grounded && player.x > JUMP_ZONE.from && player.x < JUMP_ZONE.to;
      if (shouldJump && !jumping) {
        await game.setActionDown('jump');
        jumping = true;
      } else if (jumping) {
        await game.setActionUp('jump');
        jumping = false;
      }
    }

    const obs: StepObservation = await game.step();
    trace.steps += 1;
    trace.events.push(...obs.newEvents);
    if (obs.sceneId && trace.scenes[trace.scenes.length - 1] !== obs.sceneId) {
      trace.scenes.push(obs.sceneId);
    }
    trace.errors.push(...obs.newErrors.map((e) => e.message));
    if (obs.newEvents.includes('goal')) break;
  }

  await game.setActionUp('right');
  await game.setActionUp('jump');
  return trace;
}

function spread(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.max(...values) - Math.min(...values);
}

describe('scripted-run discrimination (healthy vs broken variants)', () => {
  it.skipIf(!hasChromium)(
    'healthy: clears the pit, reaches the goal, changes scene, never errors',
    async () => {
      const { game, close } = await openFixture(RUNNER_DIR, { variant: 'healthy' });
      try {
        const trace = await scriptedRun(game);
        expect(trace.errors).toEqual([]);
        expect(trace.events).toContain('jump');
        expect(trace.events).toContain('goal');
        expect(trace.events).not.toContain('respawn');
        expect(trace.scenes).toEqual(['level1', 'cleared']);
        expect(Math.max(...trace.xs)).toBeGreaterThan(650);
        expect(trace.steps).toBeLessThan(MAX_STEPS);
      } finally {
        await close();
      }
    },
    180000,
  );

  it.skipIf(!hasChromium)(
    'broken-jump: input is dead, so the goal is unreachable and the player loops',
    async () => {
      const { game, close } = await openFixture(RUNNER_DIR, { variant: 'broken-jump' });
      try {
        const trace = await scriptedRun(game);
        expect(trace.steps).toBe(MAX_STEPS);
        expect(trace.events).not.toContain('goal');
        // The jump action was pressed and the game never acknowledged it.
        expect(trace.events).not.toContain('jump');
        expect(trace.events).toContain('respawn');
        expect(trace.scenes).toEqual(['level1']);
        // Never gets past the pit, but keeps moving (falls, respawns, walks).
        // Its x drifts a little beyond the pit's far edge (320..400) while
        // falling — what it never does is get anywhere near the goal at 700.
        expect(Math.max(...trace.xs)).toBeLessThan(500);
        expect(spread(trace.xs.slice(-60))).toBeGreaterThan(20);
      } finally {
        await close();
      }
    },
    180000,
  );

  it.skipIf(!hasChromium)(
    'pit-softlock: the run freezes — no goal, no events, no motion at all',
    async () => {
      const { game, close } = await openFixture(RUNNER_DIR, { variant: 'pit-softlock' });
      try {
        // Walk straight into the pit: no jump, so the softlock is guaranteed.
        await game.setActionDown('right');
        const xs: number[] = [];
        const events: string[] = [];
        for (let i = 0; i < MAX_STEPS; i++) {
          const obs = await game.step();
          events.push(...obs.newEvents);
          const player = (await game.listEntities!()).find((e) => e.id === 'player');
          if (player) xs.push(player.x);
        }
        await game.setActionUp('right');

        expect(events).not.toContain('goal');
        expect(events).not.toContain('respawn');
        // Frozen: the last third of the run shows no movement whatsoever.
        const tail = xs.slice(-Math.floor(xs.length / 3));
        expect(tail.length).toBeGreaterThan(20);
        expect(spread(tail)).toBeLessThan(0.5);
        // ...and it froze inside the pit, short of the goal.
        expect(Math.max(...xs)).toBeLessThan(420);
      } finally {
        await close();
      }
    },
    180000,
  );
});
