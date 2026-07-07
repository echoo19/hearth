/**
 * Smoke test for the bench harness's scenario builders (packages/runtime/bench).
 * Guards against harness rot: every scenario must build a valid project and
 * step cleanly, independent of whether `npm run bench` itself is ever run in
 * this suite.
 */
import { describe, expect, it } from 'vitest';
import { GameSession } from '@hearth/runtime';
// @ts-expect-error -- plain ESM bench script, no type declarations.
import { SCENARIOS } from '../bench/scenarios.mjs';

describe('bench scenarios', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name} builds a valid project and steps 10 frames`, async () => {
      const store = await scenario.build();
      const session = await GameSession.create(store, { seed: 1 });
      for (let i = 0; i < 10; i++) session.step();
      expect(session.errors).toEqual([]);
      expect(session.runtime.getEntities().length).toBeGreaterThan(0);
      session.destroy();
    });
  }
});
