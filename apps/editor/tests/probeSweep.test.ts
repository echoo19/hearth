/**
 * Playtesting from the app: the sweep route and the runner behind it.
 *
 * No browser is launched here — the runner's two probe entry points are
 * injected (the same seam `packageDesktop` uses), so what is under test is the
 * editor's part: resolving the game, serializing sweeps per folder, streaming
 * evidence to the journal the UI already tails, and recording what the adapter
 * declared it could sense.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectServerContext } from '../server/projectServer';
import {
  CAPABILITIES_FILE,
  DEFAULT_SWEEP_MAX_STEPS,
  DEFAULT_SWEEP_POLICIES,
  MAX_SWEEP_STEPS,
  SweepRunner,
  indexSweepShots,
  pickSweepShots,
  planSweep,
  readCapabilities,
  sensesFromCapabilities,
  writeCapabilities,
  type SweepDeps,
} from '../server/probeSweep';
import { NodeEvidenceStore } from '@hearth/probe-core';
import { parseEvidenceLines } from '../server/evidenceWatcher';
import type { GameUnderTest, ProbeCapabilities, SweepReport } from '@hearth/probe-core';

let tmp: string;
let root: string;

const CAPABILITIES: ProbeCapabilities = {
  input: { actions: ['jump'], axes: [], pointer: true },
  senses: { errors: true, scenes: false, events: false, entities: false, screenshot: true, nav: false, reset: true },
  viewport: { width: 960, height: 540 },
};

function withSenses(patch: Partial<ProbeCapabilities['senses']>): ProbeCapabilities {
  return { ...CAPABILITIES, senses: { ...CAPABILITIES.senses, ...patch } };
}

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-sweep-'));
  root = path.join(tmp, 'game');
  await fsp.mkdir(root, { recursive: true });
  await fsp.writeFile(path.join(root, 'index.html'), '<canvas></canvas>');
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

/** A game that does nothing, and a runSweep that writes one plausible journal. */
function fakeDeps(overrides: Partial<SweepDeps> = {}): Partial<SweepDeps> {
  return {
    async openGame() {
      return { capabilities: CAPABILITIES, shimDetected: false } as unknown as GameUnderTest & {
        shimDetected: boolean;
      };
    },
    async runSweep(_game, opts) {
      await opts.evidence.append({ kind: 'sweep-started' } as never);
      for (const policy of opts.policies) {
        for (const seed of opts.seeds) {
          await opts.evidence.append({ kind: 'run-finished', policy, seed } as never);
        }
      }
      await opts.evidence.append({ kind: 'sweep-finished' } as never);
      return { target: opts.target, runs: opts.policies.length * opts.seeds.length } as unknown as SweepReport;
    },
    ...overrides,
  };
}

describe('planSweep', () => {
  it('uses defaults sized for a button press when nothing is asked for', () => {
    expect(planSweep(undefined)).toEqual({
      policies: DEFAULT_SWEEP_POLICIES,
      seeds: [1, 2],
      maxSteps: DEFAULT_SWEEP_MAX_STEPS,
    });
  });

  it('takes what the caller asked for, de-duplicated', () => {
    expect(planSweep({ policies: ['mash', 'mash', 'wander'], seeds: [7, 7, 9], maxSteps: 120 })).toEqual({
      policies: ['mash', 'wander'],
      seeds: [7, 9],
      maxSteps: 120,
    });
  });

  it('clamps a request that would run for hours', () => {
    const plan = planSweep({ seeds: Array.from({ length: 40 }, (_, i) => i), maxSteps: 10_000_000 });
    expect(plan.seeds).toHaveLength(8);
    expect(plan.maxSteps).toBe(MAX_SWEEP_STEPS);
  });

  it('ignores junk instead of failing the press', () => {
    const plan = planSweep({ policies: ['', '  '], seeds: [Number.NaN], maxSteps: Number.NaN } as never);
    expect(plan.policies).toEqual(DEFAULT_SWEEP_POLICIES);
    expect(plan.seeds).toEqual([1, 2]);
    expect(plan.maxSteps).toBe(DEFAULT_SWEEP_MAX_STEPS);
  });
});

describe('sensesFromCapabilities', () => {
  it('claims nothing when there is no game', () => {
    expect(sensesFromCapabilities(null, false)).toEqual([]);
  });

  it('claims the three a web game gives up for free, even before any sweep', () => {
    expect(sensesFromCapabilities(null, true)).toEqual(['preview', 'errors', 'screenshots']);
  });

  it('claims the deeper senses only when the adapter declared them', () => {
    const record = {
      ts: 't',
      target: 'game',
      shimDetected: true,
      capabilities: withSenses({ entities: true, events: true, scenes: true }),
    };
    expect(sensesFromCapabilities(record, true)).toEqual([
      'preview',
      'errors',
      'screenshots',
      'entities',
      'events',
      'scenes',
    ]);
  });

  it('does not claim entities just because a sweep ran', () => {
    const record = { ts: 't', target: 'game', shimDetected: false, capabilities: CAPABILITIES };
    expect(sensesFromCapabilities(record, true)).toEqual(['preview', 'errors', 'screenshots']);
  });
});

describe('capabilities.json', () => {
  it('round-trips, and reads back as nothing when it is unusable', async () => {
    await writeCapabilities(root, { ts: 't', target: 'game', shimDetected: true, capabilities: CAPABILITIES });
    expect(await readCapabilities(root)).toEqual({
      ts: 't',
      target: 'game',
      shimDetected: true,
      capabilities: CAPABILITIES,
    });
    await fsp.writeFile(path.join(root, CAPABILITIES_FILE), 'not json');
    expect(await readCapabilities(root)).toBeNull();
  });
});

describe('sweep frames reach the feed', () => {
  it('picks the most progressed frame of each run, capped', () => {
    const picked = pickSweepShots(
      [
        { policy: 'mash', seed: 1, shots: ['a-1.png', 'a-2.png'] },
        { policy: 'idle', seed: 2, shots: [] },
        { policy: 'idle', seed: 3, shots: ['c-1.png'] },
      ],
      2,
    );
    expect(picked).toEqual([
      { path: 'a-2.png', caption: 'mash · seed 1' },
      { path: 'c-1.png', caption: 'idle · seed 3' },
    ]);
  });

  it('journals a shot line per run, so the rail can render what was captured', async () => {
    const evidence = new NodeEvidenceStore(root);
    const { sweepId, dir } = await evidence.beginSweep('game', ['mash'], [1]);
    await evidence.writeRun(sweepId, {
      policy: 'mash',
      seed: 1,
      shots: ['sweeps/0001/shots/mash-1-00060.png'],
    } as never);

    expect(await indexSweepShots(evidence, dir)).toBe(1);
    const events = parseEvidenceLines(
      await fsp.readFile(path.join(root, '.hearth', 'evidence', 'journal.jsonl'), 'utf8'),
      0,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'shot',
      sweepId,
      path: 'sweeps/0001/shots/mash-1-00060.png',
      caption: 'mash · seed 1',
    });
  });

  it('treats a sweep with no readable runs as a sweep with no frames', async () => {
    const evidence = new NodeEvidenceStore(root);
    expect(await indexSweepShots(evidence, path.join(root, 'nowhere'))).toBe(0);
  });
});

describe('SweepRunner', () => {
  it('streams the sweep into the evidence journal the UI already tails', async () => {
    const runner = new SweepRunner(fakeDeps());
    const job = runner.start({ root, dir: root, target: 'game', plan: planSweep(undefined) });
    await job.promise;
    const text = await fsp.readFile(path.join(root, '.hearth', 'evidence', 'journal.jsonl'), 'utf8');
    const events = parseEvidenceLines(text, 0);
    expect(events.map((event) => event.kind)).toEqual([
      'sweep-started',
      'run-finished',
      'run-finished',
      'run-finished',
      'run-finished',
      'sweep-finished',
    ]);
  });

  it('records what the adapter declared once the sweep finishes', async () => {
    const runner = new SweepRunner(
      fakeDeps({
        async openGame() {
          return {
            capabilities: withSenses({ entities: true, events: true }),
            shimDetected: true,
          } as unknown as GameUnderTest & { shimDetected: boolean };
        },
      }),
    );
    await runner.start({ root, dir: root, target: 'game', plan: planSweep(undefined) }).promise;
    const record = await readCapabilities(root);
    expect(record?.shimDetected).toBe(true);
    expect(sensesFromCapabilities(record, true)).toContain('entities');
  });

  it('runs one sweep at a time per folder, and frees the folder afterwards', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new SweepRunner(
      fakeDeps({
        async runSweep() {
          await gate;
          return { runs: 0 } as unknown as SweepReport;
        },
      }),
    );
    const first = runner.start({ root, dir: root, target: 'game', plan: planSweep(undefined) });
    expect(runner.isBusy(root)).toBe(true);
    expect(() => runner.start({ root, dir: root, target: 'game', plan: planSweep(undefined) })).toThrow(
      /already running/i,
    );
    release();
    await first.promise;
    expect(runner.isBusy(root)).toBe(false);
    expect(() => runner.start({ root, dir: root, target: 'game', plan: planSweep(undefined) })).not.toThrow();
  });

  it('says so in the journal when the game cannot even be opened', async () => {
    const runner = new SweepRunner(
      fakeDeps({
        async openGame() {
          throw new Error('Chrome or Chromium is not installed');
        },
      }),
    );
    await expect(runner.start({ root, dir: root, target: 'game', plan: planSweep(undefined) }).promise).rejects.toThrow(
      /Chromium/,
    );
    const text = await fsp.readFile(path.join(root, '.hearth', 'evidence', 'journal.jsonl'), 'utf8');
    expect(text).toContain('Playtest could not start');
    expect(runner.isBusy(root)).toBe(false);
  });
});

describe('POST /api/probe/sweep', () => {
  async function openedContext() {
    const ctx = createProjectServerContext({
      recentsFile: path.join(tmp, 'recents.json'),
      repoRoot: tmp,
      sweepDeps: fakeDeps(),
    });
    await ctx.openWorkspace(root);
    return ctx;
  }

  it('refuses a folder that was never opened', async () => {
    const ctx = createProjectServerContext({ recentsFile: path.join(tmp, 'recents.json'), repoRoot: tmp });
    expect((await ctx.startProbeSweep(root, {})).status).toBe(403);
  });

  it('refuses a folder with nothing to play, without pretending it started', async () => {
    const empty = path.join(tmp, 'empty');
    await fsp.mkdir(empty, { recursive: true });
    const ctx = createProjectServerContext({
      recentsFile: path.join(tmp, 'recents.json'),
      repoRoot: tmp,
      sweepDeps: fakeDeps(),
    });
    await ctx.openWorkspace(empty);
    const result = await ctx.startProbeSweep(empty, {});
    expect(result.status).toBe(400);
    expect(String((result.body as { error: string }).error)).toMatch(/No game/i);
  });

  it('starts the sweep and answers with what it will run', async () => {
    const ctx = await openedContext();
    const result = await ctx.startProbeSweep(root, { seeds: [4] });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, started: true, seeds: [4] });
    await ctx.sweepJob(root)?.promise;
  });

  it('answers 409 while one is already running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx = createProjectServerContext({
      recentsFile: path.join(tmp, 'recents.json'),
      repoRoot: tmp,
      sweepDeps: fakeDeps({
        async runSweep() {
          await gate;
          return { runs: 0 } as unknown as SweepReport;
        },
      }),
    });
    await ctx.openWorkspace(root);
    expect((await ctx.startProbeSweep(root, {})).status).toBe(200);
    const second = await ctx.startProbeSweep(root, {});
    expect(second.status).toBe(409);
    release();
    await ctx.sweepJob(root)?.promise;
  });

  it('reports a running sweep on the status route, so a reload keeps the spinner', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx = createProjectServerContext({
      recentsFile: path.join(tmp, 'recents.json'),
      repoRoot: tmp,
      sweepDeps: fakeDeps({
        async runSweep() {
          await gate;
          return { runs: 0 } as unknown as SweepReport;
        },
      }),
    });
    await ctx.openWorkspace(root);
    expect((await ctx.probeStatus(root)).body).toMatchObject({ playing: false });
    await ctx.startProbeSweep(root, {});
    expect((await ctx.probeStatus(root)).body).toMatchObject({ playing: true });
    release();
    await ctx.sweepJob(root)?.promise;
    expect((await ctx.probeStatus(root)).body).toMatchObject({ playing: false });
  });

  it('reports the senses a plain web game gives up, and no more', async () => {
    const ctx = await openedContext();
    expect((await ctx.probeStatus(root)).body).toMatchObject({
      ok: true,
      senses: ['preview', 'errors', 'screenshots'],
      shimDetected: false,
    });
  });
});
