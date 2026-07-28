/**
 * The Playtesters screen's two folds: the server's, which puts a sweep's files
 * back together as one row per bot, and the client's, which decides what state
 * each row is in.
 *
 * Both are pure, so what is under test here is the honesty contract rather than
 * any plumbing:
 *
 *   - the report outranks the runner's forecast, always
 *   - a forecast is dropped the moment the bot it was about actually runs
 *   - the sweep is sequential, so exactly one row can be playing
 *   - a row only claims which seed it is on once a run of its own has landed
 *   - a policy nobody in this build has heard of still gets a row
 *
 * NOT run by this agent (another was working in the same tree); written so the
 * rules are pinned before the next person changes them.
 */
import { describe, expect, it } from 'vitest';
import { foldPlaytestSweep, skippedPolicyName } from '../server/playtestView';
import { playtestPanels, livePanel, playtestSummary } from '../src/components/playtest/playtestPanels';
import type { PlaytestView } from '../src/types';

const SEEDS = [1, 2];

function run(policy: string, seed: number, over: Record<string, unknown> = {}) {
  return { policy, seed, verdict: 'ran-clean', frames: 60, findings: [], ...over } as never;
}

function sweep(over: Partial<Parameters<typeof foldPlaytestSweep>[0]> = {}) {
  return foldPlaytestSweep({
    id: '0001',
    target: 'game',
    startedAt: 't',
    requested: ['idle', 'mash', 'wander'],
    seeds: SEEDS,
    runs: [],
    report: null,
    plan: null,
    ...over,
  });
}

function view(over: Partial<PlaytestView> = {}): PlaytestView {
  return { known: ['idle', 'mash', 'wander'], running: false, sweep: sweep(), ...over };
}

describe('skippedPolicyName', () => {
  it('reads the policy out of the kind the sweep writes today', () => {
    expect(skippedPolicyName({ kind: 'policy:wander', reason: 'x' })).toBe('wander');
  });

  it('prefers an explicit field, so a richer record keeps working', () => {
    expect(skippedPolicyName({ kind: 'policy:wander', policy: 'seek', reason: 'x' })).toBe('seek');
  });

  it('is not fooled by a detector skip, which is about no bot at all', () => {
    expect(skippedPolicyName({ kind: 'sealed-region', reason: 'needs a nav grid' })).toBeNull();
  });
});

describe('foldPlaytestSweep', () => {
  it('stands the bots in the order the sweep works through them', () => {
    expect(sweep().policies.map((p) => p.policy)).toEqual(['idle', 'mash', 'wander']);
  });

  it('gives a bot nobody asked for a row rather than dropping its runs', () => {
    const folded = sweep({ requested: ['idle'], runs: [run('somethingnew', 1)] });
    expect(folded.policies.map((p) => p.policy)).toEqual(['idle', 'somethingnew']);
    expect(folded.policies[1].runs).toHaveLength(1);
  });

  it('takes a skip reason from the forecast while the sweep is still going', () => {
    const folded = sweep({ plan: [{ policy: 'wander', unavailable: 'needs a nav grid' }] });
    const wander = folded.policies.find((p) => p.policy === 'wander')!;
    expect(wander).toMatchObject({ skipReason: 'needs a nav grid', skipSource: 'plan' });
  });

  it('lets the report overrule the forecast, because the report is the record', () => {
    const folded = sweep({
      plan: [{ policy: 'wander', unavailable: 'forecast said this' }],
      report: { skipped: [{ kind: 'policy:wander', reason: 'the sweep says this' }] },
    });
    expect(folded.policies.find((p) => p.policy === 'wander')).toMatchObject({
      skipReason: 'the sweep says this',
      skipSource: 'report',
    });
  });

  it('drops a forecast the moment the bot it was about actually plays', () => {
    const folded = sweep({
      plan: [{ policy: 'wander', unavailable: 'needs a nav grid' }],
      runs: [run('wander', 1)],
    });
    expect(folded.policies.find((p) => p.policy === 'wander')!.skipReason).toBeNull();
  });

  it('separates findings a run claims from ones no bot does', () => {
    const mine = { kind: 'stuck', severity: 'issue', summary: 'went nowhere' } as const;
    const prelude = { kind: 'unresponsive-input', severity: 'issue', summary: '"jump" did nothing' } as const;
    const folded = sweep({
      runs: [run('mash', 1, { findings: [mine] })],
      report: { findings: [mine, prelude] },
    });
    expect(folded.policies.find((p) => p.policy === 'mash')!.findings).toEqual([mine]);
    expect(folded.findings).toEqual([prelude]);
  });

  it('is finished exactly when there is a report, and not before', () => {
    expect(sweep().finished).toBe(false);
    expect(sweep({ report: {} }).finished).toBe(true);
  });
});

describe('playtestPanels', () => {
  it('says nothing at all before a read has come back', () => {
    expect(playtestPanels(null)).toEqual([]);
  });

  it('has exactly one panel playing, because the sweep runs one bot at a time', () => {
    const panels = playtestPanels(view({ running: true }));
    expect(panels.filter((p) => p.state.kind === 'playing')).toHaveLength(1);
    expect(livePanel(panels)).toBe(0);
    expect(panels[1].state.kind).toBe('waiting');
  });

  it('does not claim a seed until a run of that bot has actually finished', () => {
    const first = playtestPanels(view({ running: true }))[0].state;
    expect(first).toMatchObject({ kind: 'playing', certain: false });

    const second = playtestPanels(
      view({ running: true, sweep: sweep({ runs: [run('idle', 1)] }) }),
    )[0].state;
    expect(second).toMatchObject({ kind: 'playing', certain: true, runIndex: 1, seed: 2 });
  });

  it('skips past a bot the sweep has evidently dropped, rather than calling it live', () => {
    // mash has a run, so the sweep is past idle even though idle has none.
    const panels = playtestPanels(view({ running: true, sweep: sweep({ runs: [run('mash', 1)] }) }));
    expect(panels[0].state.kind).toBe('passed');
    expect(panels[1].state).toMatchObject({ kind: 'playing', certain: true });
  });

  it('calls a bot played once it has done every seed', () => {
    const panels = playtestPanels(
      view({ running: true, sweep: sweep({ runs: [run('idle', 1), run('idle', 2)] }) }),
    );
    expect(panels[0].state).toMatchObject({ kind: 'played' });
    expect(panels[1].state).toMatchObject({ kind: 'playing' });
  });

  it('carries the reason through to the panel, in the sweep’s own words', () => {
    const panels = playtestPanels(
      view({ sweep: sweep({ report: { skipped: [{ kind: 'policy:wander', reason: 'needs a nav grid' }] } }) }),
    );
    expect(panels[2].state).toEqual({ kind: 'skipped', reason: 'needs a nav grid', source: 'report' });
  });

  it('keeps a registered bot this sweep never asked for, marked as such', () => {
    const panels = playtestPanels(view({ known: ['idle', 'mash', 'wander', 'seek'] }));
    expect(panels.map((p) => p.policy)).toEqual(['idle', 'mash', 'wander', 'seek']);
    expect(panels[3].state.kind).toBe('unasked');
  });

  it('shows every known bot, and nothing playing, when no sweep has ever run', () => {
    const panels = playtestPanels(view({ sweep: null }));
    expect(panels.every((p) => p.state.kind === 'unasked')).toBe(true);
    expect(livePanel(panels)).toBe(-1);
  });
});

describe('playtestSummary', () => {
  it('says plainly that nothing has run rather than reporting zeroes', () => {
    expect(playtestSummary(view({ sweep: null }), [])).toMatch(/No playtest has run/);
  });

  it('counts the skipped bots out loud, because that is the finding', () => {
    const v = view({ sweep: sweep({ report: { skipped: [{ kind: 'policy:wander', reason: 'r' }] } }) });
    expect(playtestSummary(v, playtestPanels(v))).toMatch(/1 skipped/);
  });

  it('never says "last playtest" about one that is still going', () => {
    const v = view({ running: true });
    expect(playtestSummary(v, playtestPanels(v))).toMatch(/^Playing now/);
  });
});
