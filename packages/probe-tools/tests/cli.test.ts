/**
 * The CLI, driven the way a caller drives it — through the real commander
 * program — but in-process, so the assertions can see the envelope rather than
 * a subprocess's stdout.
 *
 * Everything that needs no browser runs always. The one end-to-end sweep of a
 * real game is gated on Chromium being launchable, copying the guard pattern
 * from packages/adapter-web/tests/support.ts.
 */
import { describe, it, expect } from 'vitest';
import { shellQuote } from '../src/target.js';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canLaunchChromium } from '@hearth/adapter-web';
import { buildProgram }  from '../src/cli.js';
import { reportCommand, shimCommand, sweepCommand, SHIM_FILENAME, SHIM_SNIPPET } from '../src/actions.js';
import { findLatestSweep, listSweepIds } from '../src/store.js';
import type { Envelope } from '../src/envelope.js';
import type { SweepView } from '../src/format.js';
import { RUNNER_DIR, cannedReport, captureIo } from './support.js';

const hasChromium = await canLaunchChromium();

/** Run the real program and hand back what it printed plus the exit code it chose. */
async function runCli(argv: string[]): Promise<{ lines: string[]; text: string; code: number }> {
  const io = captureIo();
  let code = -1;
  const program = buildProgram(io, (c) => {
    code = c;
  });
  await program.parseAsync(argv, { from: 'user' });
  return { lines: io.lines, text: io.text(), code };
}

function parseJsonOutput<T>(text: string): Envelope<T> {
  return JSON.parse(text) as Envelope<T>;
}

async function tempDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'hearth-probe-tools-'));
}

/** Drop a finished sweep into `<root>/.hearth/evidence` without running one. */
async function seedEvidence(root: string, sweepId: string, overrides = {}): Promise<string> {
  const dir = path.join(root, '.hearth/evidence/sweeps', sweepId);
  await mkdir(dir, { recursive: true });
  const report = cannedReport({ evidenceDir: dir, target: root, ...overrides });
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  return dir;
}

describe('hearth-probe, without a browser', () => {
  it('rejects an unknown policy by name and lists the real ones', async () => {
    const { code, text } = await runCli(['sweep', '--policies', 'chaos', '--json']);
    const envelope = parseJsonOutput(text);
    expect(code).toBe(1);
    expect(envelope.success).toBe(false);
    expect(envelope.errors[0]!.code).toBe('INVALID_INPUT');
    expect(envelope.errors[0]!.message).toContain('unknown policy: chaos');
    expect(envelope.errors[0]!.message).toContain('mash');
  });

  it('rejects a non-integer --seeds before launching anything', async () => {
    const { text } = await runCli(['sweep', '--seeds', 'lots', '--json']);
    expect(parseJsonOutput(text).errors[0]!.message).toContain('--seeds must be an integer >= 1');
  });

  it('reports a missing directory as bad input, not a probe failure', async () => {
    const { text } = await runCli(['sweep', '/definitely/not/here', '--json']);
    const envelope = parseJsonOutput(text);
    expect(envelope.errors[0]!.code).toBe('INVALID_INPUT');
    expect(envelope.errors[0]!.message).toContain('no such directory');
  });

  it('says what to do when nothing has been swept yet', async () => {
    const root = await tempDir();
    try {
      const { code, text } = await runCli(['report', root, '--json']);
      const envelope = parseJsonOutput(text);
      expect(code).toBe(1);
      expect(envelope.errors[0]!.code).toBe('NO_EVIDENCE');
      expect(envelope.errors[0]!.message).toContain('hearth-probe sweep');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads the latest sweep back from disk, repro strings and all', async () => {
    const root = await tempDir();
    try {
      await seedEvidence(root, '0001');
      const dir = await seedEvidence(root, '0002');
      expect(await listSweepIds(root)).toEqual(['0001', '0002']);

      const { code, text } = await runCli(['report', root, '--json']);
      const envelope = parseJsonOutput<SweepView>(text);
      expect(envelope.success).toBe(true);
      // Exit 1: the command worked, the game did not.
      expect(code).toBe(1);
      expect(envelope.data!.sweepId).toBe('0002');
      expect(envelope.data!.evidenceDir).toBe(dir);
      expect(envelope.data!.passed).toBe(false);
      expect(envelope.data!.failures[0]!.repro).toBe(
        `hearth-probe sweep ${shellQuote(root)} --policies mash --seeds 1 --seed-start 3`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips backwards past a sweep that never finished', async () => {
    const root = await tempDir();
    try {
      await seedEvidence(root, '0001');
      await mkdir(path.join(root, '.hearth/evidence/sweeps/0002'), { recursive: true });
      const latest = await findLatestSweep(root);
      expect(latest?.sweepId).toBe('0001');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renders the report for a human with every finding and every repro', async () => {
    const root = await tempDir();
    try {
      await seedEvidence(root, '0001');
      const { text } = await runCli(['report', root]);
      expect(text).toContain('6 runs: error 1, stuck 1, ran-clean 4 — 2 failing');
      expect(text).toContain('[blocker] unhandled-error');
      expect(text).toContain('[note] black-screen');
      expect(text).toContain('repro: hearth-probe sweep');
      expect(text).not.toMatch(/\[\d+ items\]/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('installs the reference shim and prints the two-line snippet', async () => {
    const root = await tempDir();
    try {
      const { code, text } = await runCli(['shim', root]);
      expect(code).toBe(0);
      expect(text).toContain('<script src="probe-shim.js"></script>');
      expect(text).toContain('<script src="game.js"></script>');
      const copied = await readFile(path.join(root, SHIM_FILENAME), 'utf8');
      expect(copied).toContain('__hearthProbe');
      expect(SHIM_SNIPPET.split('\n')).toHaveLength(2);

      // A second install replaces it and says so, rather than failing.
      const again = await shimCommand({ dir: root });
      expect(again.success).toBe(true);
      expect(again.data!.overwrote).toBe(true);
      expect(again.warnings[0]!.code).toBe('SHIM_OVERWRITTEN');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('sweeping a real game end to end', () => {
  it.skipIf(!hasChromium)(
    'plays the healthy runner fixture, writes evidence, and reports it clean',
    async () => {
      const out = await tempDir();
      try {
        const envelope = await sweepCommand({
          dir: RUNNER_DIR,
          out,
          policies: ['idle'],
          seeds: 1,
          seedStart: 1,
          maxSteps: 40,
          // 16ms sampling (one frame at 60fps) instead of the adapter's 100ms
          // default: the input-probe prelude alone is ~600 steps, and this
          // test is about the wiring, not about giving the game time.
          stepMs: 16,
        });
        expect(envelope.errors).toEqual([]);
        expect(envelope.success).toBe(true);
        const view = envelope.data!;

        // The envelope says what happened...
        expect(envelope.command).toBe('sweep');
        expect(view.target).toBe(RUNNER_DIR);
        expect(view.sweepId).toBe('0001');
        expect(view.runs).toBe(1);
        expect(view.seeds).toEqual([1]);
        expect(Object.values(view.verdicts).reduce((a, b) => a + b, 0)).toBe(1);
        expect(view.framesSimulated).toBeGreaterThan(0);
        // ...and the shim fixture means the deep senses were available, so
        // nothing was skipped for want of entities.
        expect(view.skipped.map((s) => s.kind)).not.toContain('avatar-resolution');

        // ...and the evidence store says the same thing, on disk.
        const stored = await findLatestSweep(out);
        expect(stored).not.toBeNull();
        expect(stored!.sweepId).toBe('0001');
        expect(stored!.report.runs).toBe(1);
        expect(view.evidenceDir).toBe(stored!.dir);
        expect(view.reportPath).toBe(stored!.reportPath);

        const journal = await readFile(path.join(out, '.hearth/evidence/journal.jsonl'), 'utf8');
        const kinds = journal
          .trim()
          .split('\n')
          .map((line) => (JSON.parse(line) as { kind: string }).kind);
        expect(kinds).toContain('sweep-started');
        expect(kinds).toContain('run-finished');
        expect(kinds).toContain('sweep-finished');

        // And `report` reads it back without touching a browser.
        const reread = await reportCommand({ dir: out });
        expect(reread.success).toBe(true);
        expect(reread.data!.sweepId).toBe('0001');
        expect(reread.data!.verdicts).toEqual(view.verdicts);
      } finally {
        await rm(out, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
