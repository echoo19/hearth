/**
 * The report fold: verdict precedence and the caps that keep a sweep summary
 * small without letting one loud detector bury a quiet blocker.
 */
import { describe, expect, it } from 'vitest';
import {
  collectFailures,
  decideVerdict,
  emptyVerdictTally,
  foldFindings,
  foldSkipped,
  MAX_FAILURES,
  MAX_FINDINGS,
  MAX_PER_KIND,
  tallyVerdicts,
  type Finding,
  type RunResult,
  type Severity,
} from '@hearth/probe-core';

function finding(kind: string, severity: Severity, summary: string): Finding {
  return { kind, severity, summary };
}

function run(partial: Partial<RunResult>): RunResult {
  return {
    policy: 'mash',
    seed: 1,
    verdict: 'ran-clean',
    frames: 100,
    wallMs: 1,
    findings: [],
    skipped: [],
    objectives: [],
    coverageKeys: [],
    shots: [],
    ...partial,
  };
}

describe('decideVerdict', () => {
  it('follows error > stuck > objective-failed > completed > ran-clean', () => {
    const achieved = [{ achieved: true, failed: false }];
    const missed = [{ achieved: false, failed: false }];
    expect(decideVerdict({ hasError: true, stuck: true, objectives: achieved })).toBe('error');
    expect(decideVerdict({ hasError: false, stuck: true, objectives: achieved })).toBe('stuck');
    expect(decideVerdict({ hasError: false, stuck: false, objectives: missed })).toBe('objective-failed');
    expect(decideVerdict({ hasError: false, stuck: false, objectives: achieved })).toBe('completed');
    expect(decideVerdict({ hasError: false, stuck: false, objectives: [] })).toBe('ran-clean');
  });

  it('counts a failed-but-achieved objective as a failure', () => {
    expect(
      decideVerdict({ hasError: false, stuck: false, objectives: [{ achieved: true, failed: true }] }),
    ).toBe('objective-failed');
  });
});

describe('foldFindings', () => {
  it('dedupes by kind and summary', () => {
    const folded = foldFindings([
      finding('crash', 'blocker', 'boom'),
      finding('crash', 'blocker', 'boom'),
      finding('crash', 'blocker', 'other boom'),
    ]);
    expect(folded).toHaveLength(2);
  });

  it('sorts blockers before issues before notes', () => {
    const folded = foldFindings([
      finding('a', 'note', 'n'),
      finding('b', 'blocker', 'b'),
      finding('c', 'issue', 'i'),
    ]);
    expect(folded.map((f) => f.severity)).toEqual(['blocker', 'issue', 'note']);
  });

  it('caps each kind at MAX_PER_KIND so one detector cannot crowd out the rest', () => {
    const noisy = Array.from({ length: 10 }, (_, i) => finding('wall-bump', 'note', `bump ${i}`));
    const folded = foldFindings([...noisy, finding('crash', 'blocker', 'boom')]);
    expect(folded.filter((f) => f.kind === 'wall-bump')).toHaveLength(MAX_PER_KIND);
    expect(folded[0].kind).toBe('crash');
  });

  it('caps the total at MAX_FINDINGS', () => {
    const many: Finding[] = [];
    for (let k = 0; k < 6; k++) {
      for (let i = 0; i < 3; i++) many.push(finding(`kind-${k}`, 'issue', `summary ${k}-${i}`));
    }
    expect(foldFindings(many)).toHaveLength(MAX_FINDINGS);
  });

  it('keeps an empty list empty', () => {
    expect(foldFindings([])).toEqual([]);
  });
});

describe('foldSkipped', () => {
  it('dedupes by kind, keeping the first reason, sorted by kind', () => {
    const folded = foldSkipped([
      { kind: 'sealed-region', reason: 'first' },
      { kind: 'sealed-region', reason: 'second' },
      { kind: 'black-screen', reason: 'no screenshots' },
    ]);
    expect(folded).toEqual([
      { kind: 'black-screen', reason: 'no screenshots' },
      { kind: 'sealed-region', reason: 'first' },
    ]);
  });
});

describe('tallies and failures', () => {
  it('always reports every verdict key', () => {
    expect(Object.keys(emptyVerdictTally()).sort()).toEqual([
      'completed',
      'error',
      'objective-failed',
      'ran-clean',
      'stuck',
    ]);
    const tally = tallyVerdicts([run({ verdict: 'stuck' }), run({ verdict: 'stuck' }), run({})]);
    expect(tally.stuck).toBe(2);
    expect(tally['ran-clean']).toBe(1);
    expect(tally.error).toBe(0);
  });

  it('surfaces the worst failures first and caps them', () => {
    const runs = [
      run({ verdict: 'ran-clean', seed: 0 }),
      ...Array.from({ length: 6 }, (_, i) => run({ verdict: 'stuck', seed: i + 1 })),
      run({
        verdict: 'error',
        seed: 9,
        firstError: { message: 'boom', at: { frame: 12 } },
        shots: ['sweeps/0001/shots/a.png'],
      }),
    ];
    const failures = collectFailures(runs, 180);
    expect(failures).toHaveLength(MAX_FAILURES);
    expect(failures[0].verdict).toBe('error');
    expect(failures[0].detail).toBe('boom');
    expect(failures[0].at).toEqual({ frame: 12 });
    expect(failures[0].shot).toBe('sweeps/0001/shots/a.png');
    expect(failures[1].verdict).toBe('stuck');
    expect(failures[1].detail).toContain('180');
    // Ties inside a verdict break by seed, so the list is stable across sweeps.
    expect(failures.slice(1).map((f) => f.seed)).toEqual([1, 2, 3, 4]);
  });

  it('describes an objective failure by how many went unmet', () => {
    const failures = collectFailures(
      [
        run({
          verdict: 'objective-failed',
          objectives: [
            { objective: { type: 'event', event: 'win' }, achieved: false, failed: false },
            { objective: { type: 'event', event: 'x' }, achieved: true, failed: false },
          ],
        }),
      ],
      180,
    );
    expect(failures[0].detail).toContain('1 objective');
  });
});
