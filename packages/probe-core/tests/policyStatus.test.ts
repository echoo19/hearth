/**
 * The capability gate's asymmetry, and the per-policy record it produces.
 *
 * Two rules are pinned here because both were once wrong in a way nobody could
 * see from the outside: seek must NOT need a nav grid (entities are enough to
 * try), and a policy that ran with less than it wanted must say so in the
 * report rather than leaving a `direct` result to be read as a `full` one.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPolicyStatus,
  DIRECT_MODE_NOTE,
  makeSynthetic,
  policyMode,
  policyUnavailable,
  type RunResult,
} from '@hearth/probe-core';

function run(over: Partial<RunResult> & Pick<RunResult, 'policy'>): RunResult {
  return {
    seed: 1,
    verdict: 'ran-clean',
    frames: 10,
    wallMs: 1,
    findings: [],
    skipped: [],
    objectives: [],
    coverageKeys: [],
    shots: [],
    ...over,
  };
}

describe('the nav gate is seek-exempt', () => {
  it('lets seek run on a game with entities but no nav grid', () => {
    const noNav = makeSynthetic('healthy', { senses: { nav: false } });
    expect(policyUnavailable('seek', noNav.capabilities)).toBeNull();
  });

  it('still blocks wander there, and says the grid is what is missing', () => {
    const noNav = makeSynthetic('healthy', { senses: { nav: false } });
    expect(policyUnavailable('wander', noNav.capabilities)).toMatch(/nav grid/);
  });

  it('blocks both when the game cannot enumerate entities at all', () => {
    const blind = makeSynthetic('healthy', { senses: { entities: false, nav: false } });
    expect(policyUnavailable('seek', blind.capabilities)).toMatch(/entity enumeration/);
    expect(policyUnavailable('wander', blind.capabilities)).toMatch(/entity enumeration/);
  });
});

describe('policyMode', () => {
  it('calls a gridless seek degraded, and names what it cannot do', () => {
    expect(policyMode('seek', null)).toEqual({ mode: 'direct', note: DIRECT_MODE_NOTE });
    expect(DIRECT_MODE_NOTE).toMatch(/not proof/);
  });

  it('leaves everything else at full, including seek with a grid', () => {
    expect(policyMode('seek', { cols: 1 }).mode).toBe('full');
    expect(policyMode('wander', null).mode).toBe('full');
    expect(policyMode('mash', null).mode).toBe('full');
  });
});

describe('buildPolicyStatus', () => {
  const requested = ['mash', 'seek', 'wander'];
  const runs = [
    run({ policy: 'mash', seed: 1 }),
    run({ policy: 'mash', seed: 2 }),
    run({ policy: 'seek', seed: 1, mode: 'direct' }),
  ];
  const skipReasons = new Map([['wander', 'steering needs a nav grid, which this game does not declare']]);

  it('keeps one row per requested policy, in the order asked', () => {
    expect(buildPolicyStatus(requested, runs, skipReasons).map((p) => p.policy)).toEqual(requested);
  });

  it('counts the runs a policy completed', () => {
    const status = buildPolicyStatus(requested, runs, skipReasons);
    expect(status[0]).toEqual({ policy: 'mash', status: 'ran', runs: 2, mode: 'full' });
  });

  it('carries the degraded mode and its note', () => {
    const seek = buildPolicyStatus(requested, runs, skipReasons)[1]!;
    expect(seek.status).toBe('ran');
    expect(seek.mode).toBe('direct');
    expect(seek.modeNote).toBe(DIRECT_MODE_NOTE);
  });

  it('carries the skip reason for a policy that never played', () => {
    const wander = buildPolicyStatus(requested, runs, skipReasons)[2]!;
    expect(wander).toEqual({
      policy: 'wander',
      status: 'skipped',
      runs: 0,
      reason: 'steering needs a nav grid, which this game does not declare',
    });
  });

  it('never leaves a skip unexplained, even when the sweep forgot to say why', () => {
    const [only] = buildPolicyStatus(['seek'], [], new Map());
    expect(only!.status).toBe('skipped');
    expect(only!.reason).toBeTruthy();
  });
});
