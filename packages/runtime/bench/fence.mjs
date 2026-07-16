export const FENCE_RUNS = 3;
export const FENCE_SCENARIOS = ['colliders-1500', 'mixed-horde'];

// Loose absolute CI fences: roughly 5x the Apple M3 Pro reference means
// (2.912ms and 2.717ms). These are regression tripwires for order-of-magnitude
// losses like dropping the spatial-hash broadphase, not profiling targets.
export const FENCE_BUDGETS_MS = {
  'colliders-1500': 15,
  'mixed-horde': 14,
};

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function evaluateFenceResults(entries) {
  const failures = entries
    .map((entry) => ({
      scenario: entry.scenario,
      medianMeanMs: median(entry.runs.map((run) => run.meanMs)),
      budgetMeanMs: entry.budgetMeanMs,
    }))
    .filter((entry) => entry.medianMeanMs > entry.budgetMeanMs);

  return {
    failed: failures.length > 0,
    failures,
    message:
      failures.length === 0
        ? 'bench regression fence passed'
        : [
            'bench regression fence failed:',
            ...failures.map(
              (failure) =>
                `  ${failure.scenario}: ${failure.medianMeanMs.toFixed(3)}ms median mean > ${failure.budgetMeanMs.toFixed(3)}ms budget`,
            ),
          ].join('\n'),
  };
}
