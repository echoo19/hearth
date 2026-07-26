/** Shared fixtures for the probe-tools tests (not a test file itself). */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Finding, SkippedDetector, SweepFailure, SweepReport, Verdict } from '@hearth/probe-core';
import type { CliIo } from '../src/cli.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The adapter's own fixtures — the only real game this package tests against. */
export const RUNNER_DIR = path.resolve(HERE, '../../adapter-web/fixtures/runner');

export function emptyVerdicts(): Record<Verdict, number> {
  return { error: 0, stuck: 0, 'objective-failed': 0, completed: 0, 'ran-clean': 0 };
}

/**
 * A SweepReport with the shape a real sweep produces — two failing runs, three
 * findings across two kinds, one skipped detector — so the formatters can be
 * tested without a browser anywhere in sight.
 */
export function cannedReport(overrides: Partial<SweepReport> = {}): SweepReport {
  const findings: Finding[] = [
    {
      kind: 'unhandled-error',
      severity: 'blocker',
      summary: 'TypeError: player.update is not a function',
      detail: 'thrown from game.js:117 on the first frame after the level loads',
      at: { frame: 12 },
      shot: 'sweeps/0002/shots/mash-3-final.png',
    },
    {
      kind: 'no-progress',
      severity: 'issue',
      summary: 'the avatar never left its spawn cell',
      at: { frame: 240 },
    },
    { kind: 'black-screen', severity: 'note', summary: '31% of sampled frames were uniformly black' },
  ];
  const failures: SweepFailure[] = [
    {
      policy: 'mash',
      seed: 3,
      verdict: 'error',
      at: { frame: 12 },
      detail: 'TypeError: player.update is not a function',
      shot: 'sweeps/0002/shots/mash-3-final.png',
    },
    { policy: 'mash', seed: 5, verdict: 'stuck', at: { frame: 600 }, detail: 'no novelty for 180 steps' },
  ];
  const skipped: SkippedDetector[] = [
    { kind: 'sealed-region', reason: 'no nav grid: the probe cannot tell walkable from solid' },
  ];
  return {
    target: '/tmp/my game',
    policies: ['mash'],
    seeds: [1, 2, 3, 4, 5, 6],
    runs: 6,
    verdicts: { ...emptyVerdicts(), 'ran-clean': 4, error: 1, stuck: 1 },
    findings,
    skipped,
    failures,
    framesSimulated: 2412,
    wallMs: 18_430,
    evidenceDir: '/tmp/my game/.hearth/evidence/sweeps/0002',
    ...overrides,
  };
}

export interface CapturedIo extends CliIo {
  lines: string[];
  errLines: string[];
  text(): string;
}

export function captureIo(): CapturedIo {
  const lines: string[] = [];
  const errLines: string[] = [];
  return {
    lines,
    errLines,
    out: (line) => lines.push(line),
    err: (line) => errLines.push(line),
    text: () => lines.join('\n'),
  };
}
