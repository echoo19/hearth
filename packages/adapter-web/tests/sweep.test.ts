/**
 * End-to-end through @hearth/probe-core's sweep engine: does the real sweep
 * loop drive this adapter, and does it separate a healthy game from a
 * crashing one?
 *
 * `tests/discrimination.test.ts` covers the same fixtures through the raw
 * contract and does not depend on probe-core at all.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runSweep, NodeEvidenceStore } from '@hearth/probe-core';
import { canLaunchChromium } from '../src/index.js';
import { RUNNER_DIR, openFixture } from './support.js';

interface SweepReportLike {
  target: string;
  runs: number;
  verdicts: Record<string, number>;
  findings: Array<{ kind: string; severity: string; summary: string }>;
  skipped: Array<{ kind: string; reason: string }>;
  failures: Array<{ policy: string; verdict: string; detail: string }>;
  evidenceDir: string;
}

const hasChromium = await canLaunchChromium();
const canSweep = hasChromium;

describe('sweeping a web game through probe-core', () => {
  it.skipIf(!canSweep)(
    'runs a healthy game clean, and skips the detectors whose senses are missing',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'hearth-sweep-'));
      const { game, close } = await openFixture(RUNNER_DIR, { variant: 'healthy' });
      try {
        const report = await runSweep(game, {
          policies: ['idle', 'mash'],
          seeds: [1],
          evidence: new NodeEvidenceStore(root),
          target: 'runner:healthy',
          maxSteps: 60,
          stuckAfter: 40,
          screenshotEvery: 30,
          inputProbe: false,
        });

        expect(report.target).toBe('runner:healthy');
        expect(report.runs).toBe(2);
        expect(Object.values(report.verdicts).reduce((a, b) => a + b, 0)).toBe(2);
        expect(report.verdicts.error ?? 0).toBe(0);
        expect(report.findings.some((f) => f.severity === 'blocker')).toBe(false);

        // Capability honesty end to end: this game exposes no nav grid, so
        // nav-dependent detectors are reported as skipped, never as passed.
        expect(report.skipped.length).toBeGreaterThan(0);
        expect(report.skipped.some((s) => /nav/i.test(s.reason))).toBe(true);

        expect((await readdir(report.evidenceDir)).length).toBeGreaterThan(0);
      } finally {
        await close();
        await rm(root, { recursive: true, force: true });
      }
    },
    240000,
  );

  it.skipIf(!canSweep)(
    'catches the crashing variant: error verdicts, a blocker finding, a failure entry',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'hearth-sweep-'));
      const { game, close } = await openFixture(RUNNER_DIR, { variant: 'crash' });
      try {
        const report = await runSweep(game, {
          policies: ['mash'],
          seeds: [1, 2, 3],
          evidence: new NodeEvidenceStore(root),
          target: 'runner:crash',
          maxSteps: 150,
          stuckAfter: 120,
          screenshotEvery: 50,
        });

        expect(report.verdicts.error ?? 0).toBeGreaterThan(0);
        expect(report.findings.some((f) => f.severity === 'blocker')).toBe(true);
        expect(report.failures.length).toBeGreaterThan(0);
        expect(report.failures[0]!.detail).toMatch(/null|TypeError/i);
      } finally {
        await close();
        await rm(root, { recursive: true, force: true });
      }
    },
    300000,
  );
});
