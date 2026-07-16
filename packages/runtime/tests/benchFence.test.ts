import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM bench helper, no type declarations.
import { evaluateFenceResults } from '../bench/fence.mjs';

describe('bench regression fence', () => {
  it('fails scenarios whose median mean frame time exceeds the budget', () => {
    const outcome = evaluateFenceResults(
      [
        {
          scenario: 'colliders-1500',
          budgetMeanMs: 15,
          runs: [
            { meanMs: 12 },
            { meanMs: 18 },
            { meanMs: 30 },
          ],
        },
      ],
    );

    expect(outcome.failed).toBe(true);
    expect(outcome.failures).toEqual([
      {
        scenario: 'colliders-1500',
        medianMeanMs: 18,
        budgetMeanMs: 15,
      },
    ]);
    expect(outcome.message).toContain('colliders-1500');
    expect(outcome.message).toContain('18.000ms median mean');
    expect(outcome.message).toContain('15.000ms budget');
  });
});
