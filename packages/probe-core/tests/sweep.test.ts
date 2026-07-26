/**
 * The point of the whole package: can a sweep tell a working game from a broken
 * one, and does it stay quiet when it cannot see?
 *
 * Every case below runs the real sweep against the in-memory fixture. The
 * healthy variant is the control — a detector that fires on it is a detector
 * that would cry wolf on someone's actual game, which is worse than missing a
 * bug. Rates are compared, not single runs, because the probe's whole design
 * treats one run as an anecdote.
 */
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET,
  EVIDENCE_DIR,
  makeSynthetic,
  NodeEvidenceStore,
  runSweep,
  type EvidenceEvent,
  type RunResult,
  type SweepOptions,
  type SweepReport,
  type SyntheticOptions,
  type SyntheticVariant,
} from '@hearth/probe-core';

const SEEDS = [1, 2, 3, 4, 5, 6];

interface Swept {
  report: SweepReport;
  runs: RunResult[];
  journal: EvidenceEvent[];
  root: string;
}

async function sweep(
  variant: SyntheticVariant,
  opts: Partial<SweepOptions> = {},
  fixture: SyntheticOptions = {},
): Promise<Swept> {
  const root = await mkdtemp(path.join(tmpdir(), 'probe-sweep-'));
  const store = new NodeEvidenceStore(root);
  const report = await runSweep(makeSynthetic(variant, fixture), {
    policies: ['mash', 'idle'],
    seeds: SEEDS,
    evidence: store,
    target: variant,
    ...opts,
  });
  const runsDir = path.join(report.evidenceDir, 'runs');
  const runs: RunResult[] = [];
  for (const file of (await readdir(runsDir)).sort()) {
    runs.push(JSON.parse(await readFile(path.join(runsDir, file), 'utf8')) as RunResult);
  }
  return { report, runs, journal: await store.readJournal(), root };
}

/** Stuck runs among the policies that actually press buttons. */
function stuckRate(runs: RunResult[], policy = 'mash'): number {
  const eligible = runs.filter((r) => r.policy === policy);
  return eligible.filter((r) => r.verdict === 'stuck').length / eligible.length;
}

describe('healthy — the control', () => {
  it('mostly runs clean, with no blockers and no invented findings', async () => {
    const { report, runs } = await sweep('healthy');
    expect(report.runs).toBe(12);
    expect(report.findings.filter((f) => f.severity === 'blocker')).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.verdicts.error).toBe(0);
    expect(report.verdicts['ran-clean']).toBeGreaterThanOrEqual(9);
    expect(stuckRate(runs)).toBeLessThanOrEqual(0.5);
    // idle is exempt from stuck by design: nothing was tried.
    expect(runs.filter((r) => r.policy === 'idle' && r.verdict === 'stuck')).toEqual([]);
  });

  it('explores: coverage keys accumulate and the report accounts for every step', async () => {
    const { report, runs } = await sweep('healthy', { policies: ['mash'], seeds: [1, 2] });
    for (const run of runs) expect(run.coverageKeys.length).toBeGreaterThan(20);
    expect(report.framesSimulated).toBe(runs.reduce((n, r) => n + r.frames, 0));
    expect(report.policies).toEqual(['mash']);
    expect(report.seeds).toEqual([1, 2]);
  });
});

describe('broken-input — a control wired to nothing', () => {
  it('names the dead control without condemning the working ones', async () => {
    const { report } = await sweep('broken-input', { policies: ['mash'], seeds: [1, 2] });
    const finding = report.findings.find((f) => f.kind === 'unresponsive-input');
    expect(finding).toBeDefined();
    expect(finding?.summary).toContain('right');
    expect(finding?.severity).toBe('issue');
    for (const f of report.findings) {
      expect(f.summary).not.toContain('"left"');
      expect(f.summary).not.toContain('"jump"');
    }
  });

  it('says nothing about input on the healthy build', async () => {
    const { report } = await sweep('healthy', { policies: ['mash'], seeds: [1, 2] });
    expect(report.findings.filter((f) => f.kind === 'unresponsive-input')).toEqual([]);
  });
});

describe('crash-at-100 — an exception mid-run', () => {
  it('verdicts error at the step it threw, in every run', async () => {
    const { report, runs } = await sweep('crash-at-100', { policies: ['mash', 'idle'], seeds: [1, 2, 3] });
    expect(report.verdicts.error).toBe(6);
    for (const run of runs) {
      expect(run.verdict).toBe('error');
      expect(run.frames).toBe(100);
      expect(run.firstError?.message).toMatch(/TypeError/);
    }
    const crash = report.findings.find((f) => f.kind === 'crash');
    expect(crash?.severity).toBe('blocker');
    expect(crash?.at?.frame).toBe(100);
    expect(report.failures[0]).toMatchObject({ verdict: 'error' });
  });

  it('drops the input probe rather than reporting through a crash', async () => {
    const { report } = await sweep('crash-at-100', { policies: ['mash'], seeds: [1] });
    expect(report.findings.filter((f) => f.kind === 'unresponsive-input')).toEqual([]);
    expect(report.skipped.find((s) => s.kind === 'unresponsive-input')?.reason).toMatch(/errored/);
  });
});

describe('softlock-pit — a hazard that freezes the game', () => {
  it('goes stuck far more often than the healthy build', async () => {
    const broken = await sweep('softlock-pit', { policies: ['mash'], seeds: SEEDS });
    const healthy = await sweep('healthy', { policies: ['mash'], seeds: SEEDS });
    expect(stuckRate(broken.runs)).toBeGreaterThanOrEqual(0.8);
    expect(stuckRate(healthy.runs)).toBeLessThanOrEqual(0.4);
    expect(stuckRate(broken.runs)).toBeGreaterThan(stuckRate(healthy.runs) + 0.3);
    expect(broken.report.failures[0]?.detail).toMatch(/no novelty/);
  });

  it('detects the freeze from pixels alone when there are no entities', async () => {
    const senses = { entities: false, nav: false, events: false, scenes: false };
    const broken = await sweep('softlock-pit', { policies: ['mash'], seeds: [1, 2, 3] }, { senses });
    const healthy = await sweep('healthy', { policies: ['mash'], seeds: [1, 2, 3] }, { senses });
    expect(stuckRate(broken.runs)).toBeGreaterThan(stuckRate(healthy.runs));
    // Pixel coverage keys, since there is nothing else to key on.
    for (const run of broken.runs) {
      expect(run.coverageKeys.every((k) => k.startsWith('h:'))).toBe(true);
    }
  });
});

describe('sealed-room — a goal walled off', () => {
  it('reports the unreachable region with sample coordinates', async () => {
    const { report } = await sweep('sealed-room', { policies: ['mash'], seeds: [1] });
    const finding = report.findings.find((f) => f.kind === 'sealed-region');
    expect(finding?.severity).toBe('issue');
    expect(finding?.summary).toMatch(/sealed off/);
    expect((finding?.evidence?.samples as unknown[]).length).toBeGreaterThan(0);
  });

  it('says nothing about geometry on the healthy build', async () => {
    const { report } = await sweep('healthy', { policies: ['mash'], seeds: [1] });
    expect(report.findings.filter((f) => f.kind === 'sealed-region')).toEqual([]);
  });
});

describe('blank rendering', () => {
  it('reports a black screen as a blocker', async () => {
    const { report } = await sweep('healthy', { policies: ['mash'], seeds: [1] }, { renderBlank: true });
    const finding = report.findings.find((f) => f.kind === 'black-screen');
    expect(finding?.severity).toBe('blocker');
    expect(finding?.summary).toMatch(/blank/);
  });
});

describe('steering policies', () => {
  it('wander explores far more of the map than random mashing, and finds nothing wrong', async () => {
    const wander = await sweep('healthy', { policies: ['wander'], seeds: [1, 2] });
    const mash = await sweep('healthy', { policies: ['mash'], seeds: [1, 2] });
    const keys = (runs: RunResult[]): number => Math.max(...runs.map((r) => r.coverageKeys.length));
    expect(keys(wander.runs)).toBeGreaterThan(keys(mash.runs));
    expect(wander.report.findings.filter((f) => f.severity === 'blocker')).toEqual([]);
    expect(wander.report.verdicts['ran-clean']).toBe(2);
  });

  it('seek drives toward a named entity and can satisfy a reach objective', async () => {
    const { report, runs } = await sweep('healthy', {
      policies: ['seek'],
      seeds: [1],
      seekTarget: 'prop-a',
      objectives: [{ type: 'reach', target: 'prop-a', tolerance: 48 }],
    });
    expect(report.policies).toEqual(['seek']);
    expect(runs[0].objectives[0].achieved).toBe(true);
    expect(report.verdicts.completed).toBe(1);
  });

  it('skips seek when no target was given instead of throwing', async () => {
    const { report } = await sweep('healthy', { policies: ['seek', 'mash'], seeds: [1] });
    expect(report.policies).toEqual(['mash']);
    expect(report.skipped.find((s) => s.kind === 'policy:seek')?.reason).toMatch(/needs a target/);
  });

  it('skips steering entirely when nothing measurably moves the avatar', async () => {
    // Every declared control does nothing: there is no basis to steer with.
    const inert = { input: { actions: ['ghost'], axes: [], pointer: false } };
    const { report } = await sweep('healthy', { policies: ['wander', 'mash'], seeds: [1] }, inert);
    expect(report.policies).toEqual(['mash']);
    expect(report.skipped.find((s) => s.kind === 'policy:wander')?.reason).toMatch(/measurably moved/);
  });
});

describe('capability honesty', () => {
  it('skips every detector and policy it cannot support, and invents no findings', async () => {
    const { report } = await sweep(
      'healthy',
      { policies: ['mash', 'idle', 'wander', 'seek'], seeds: [1], seekTarget: 'goal' },
      { senses: { entities: false, nav: false, screenshot: false } },
    );
    const skipped = new Map(report.skipped.map((s) => [s.kind, s.reason]));
    expect([...skipped.keys()].sort()).toEqual([
      'avatar-resolution',
      'black-screen',
      'policy:seek',
      'policy:wander',
      'sealed-region',
      'stuck',
      'unresponsive-input',
      'wall-bump',
    ]);
    expect(skipped.get('policy:wander')).toMatch(/entity enumeration and a nav grid/);
    expect(skipped.get('black-screen')).toMatch(/screenshots/);
    expect(skipped.get('wall-bump')).toMatch(/entity enumeration/);
    expect(skipped.get('unresponsive-input')).toMatch(/entity enumeration \(displacement\) or screenshots/);
    expect(report.findings).toEqual([]);
    expect(report.policies).toEqual(['mash', 'idle']);
  });

  it('keeps the pixel-only tier working, and marks its evidence as pixel-based', async () => {
    const { report } = await sweep(
      'broken-input',
      { policies: ['mash', 'wander'], seeds: [1] },
      { senses: { entities: false, nav: false } },
    );
    expect(report.skipped.find((s) => s.kind === 'policy:wander')?.reason).toMatch(/entity enumeration/);
    expect(report.policies).toEqual(['mash']);
    const finding = report.findings.find((f) => f.kind === 'unresponsive-input');
    if (finding) {
      expect(finding.detail).toMatch(/pixel-based/);
      expect(finding.evidence?.pixelBased).toBe(true);
    }
  });

  it('honors a caller who turns the input probe off', async () => {
    const { report } = await sweep('broken-input', { policies: ['mash'], seeds: [1], inputProbe: false });
    expect(report.skipped.find((s) => s.kind === 'unresponsive-input')?.reason).toMatch(/disabled/);
    expect(report.findings.filter((f) => f.kind === 'unresponsive-input')).toEqual([]);
  });
});

describe('objectives', () => {
  it('completes when every objective is met and fails when one is not', async () => {
    const reachable = await sweep('healthy', {
      policies: ['mash'],
      seeds: [1],
      objectives: [{ type: 'survive', frames: 50 }],
    });
    expect(reachable.report.verdicts.completed).toBe(1);
    expect(reachable.runs[0].objectives[0].achieved).toBe(true);

    const impossible = await sweep('healthy', {
      policies: ['mash'],
      seeds: [1],
      objectives: [{ type: 'event', event: 'never-happens', count: 1 }],
    });
    expect(impossible.report.verdicts['objective-failed']).toBe(1);
    expect(impossible.report.failures[0].detail).toMatch(/objective/);
  });
});

describe('the sweep contract itself', () => {
  it('fails fast when the run budget would be blown', async () => {
    const store = new NodeEvidenceStore(await mkdtemp(path.join(tmpdir(), 'probe-budget-')));
    await expect(
      runSweep(makeSynthetic(), {
        policies: ['mash', 'idle', 'wander'],
        seeds: Array.from({ length: 200 }, (_, i) => i),
        maxSteps: 1000,
        evidence: store,
      }),
    ).rejects.toThrow(/budget exceeded/);
    expect(DEFAULT_BUDGET).toBe(400_000);
  });

  it('refuses an empty sweep', async () => {
    const store = new NodeEvidenceStore(await mkdtemp(path.join(tmpdir(), 'probe-empty-')));
    await expect(runSweep(makeSynthetic(), { policies: [], seeds: [1], evidence: store })).rejects.toThrow(
      /no policies/,
    );
    await expect(runSweep(makeSynthetic(), { policies: ['mash'], seeds: [], evidence: store })).rejects.toThrow(
      /no seeds/,
    );
  });

  it('writes every artifact the UI reads', async () => {
    const { report, journal, root } = await sweep('softlock-pit', { policies: ['mash'], seeds: [1, 2] });
    const evidence = path.join(root, EVIDENCE_DIR);
    expect(report.evidenceDir).toBe(path.join(evidence, 'sweeps', '0001'));
    expect((await stat(path.join(report.evidenceDir, 'report.json'))).isFile()).toBe(true);
    expect((await readdir(path.join(report.evidenceDir, 'runs'))).sort()).toEqual(['mash-1.json', 'mash-2.json']);
    const shots = await readdir(path.join(report.evidenceDir, 'shots'));
    expect(shots.length).toBeGreaterThan(0);
    for (const shot of shots) expect(shot.endsWith('.png')).toBe(true);

    const kinds = journal.map((e) => e.kind);
    expect(kinds[0]).toBe('sweep-started');
    expect(kinds.filter((k) => k === 'run-finished')).toHaveLength(2);
    expect(kinds[kinds.length - 1]).toBe('sweep-finished');
    const finished = journal[journal.length - 1];
    expect(finished.kind === 'sweep-finished' && finished.reportPath).toBe(
      path.join(report.evidenceDir, 'report.json'),
    );

    // Findings point at shots that really exist, relative to the evidence dir.
    for (const run of [...(await readdir(path.join(report.evidenceDir, 'runs')))]) {
      const parsed = JSON.parse(await readFile(path.join(report.evidenceDir, 'runs', run), 'utf8')) as RunResult;
      for (const shot of parsed.shots) expect((await stat(path.join(evidence, shot))).isFile()).toBe(true);
    }
  });

  it('runs one live game sequentially and leaves it stopped', async () => {
    const game = makeSynthetic();
    const store = new NodeEvidenceStore(await mkdtemp(path.join(tmpdir(), 'probe-seq-')));
    let concurrent = 0;
    let maxConcurrent = 0;
    const originalStep = game.step.bind(game);
    game.step = async () => {
      maxConcurrent = Math.max(maxConcurrent, ++concurrent);
      try {
        return await originalStep();
      } finally {
        concurrent--;
      }
    };
    await runSweep(game, { policies: ['mash'], seeds: [1, 2], maxSteps: 200, evidence: store });
    expect(maxConcurrent).toBe(1);
  });
});
