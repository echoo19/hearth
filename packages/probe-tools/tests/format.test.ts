/**
 * The pure half of the package: envelopes, target resolution, repro strings and
 * the folded human report. No browser, no filesystem, no clock — every case
 * runs against the canned SweepReport in support.ts.
 */
import { describe, it, expect } from 'vitest';
import { MAX_FAILURES, MAX_FINDINGS } from '@hearth/probe-core';
import {
  ERROR_CODES,
  classifyError,
  fail,
  failFrom,
  ok,
  stringifyEnvelope,
  type Envelope,
} from '../src/envelope.js';
import {
  formatSeeds,
  renderFailure,
  renderFinding,
  renderSweepHuman,
  reproCommand,
  sweepIdFromDir,
  sweepView,
  verdictLine,
} from '../src/format.js';
import { resolveTarget, shellQuote, targetArgs } from '../src/target.js';
import { pngSize } from '../src/png.js';
import { emit } from '../src/cli.js';
import { cannedReport, captureIo, emptyVerdicts } from './support.js';

describe('the envelope', () => {
  it('has the same five keys whether it succeeded or failed', () => {
    const keys = (e: Envelope<unknown>) => Object.keys(e).sort();
    expect(keys(ok('sweep', { a: 1 }))).toEqual(['command', 'data', 'errors', 'success', 'warnings']);
    expect(keys(fail('sweep', ERROR_CODES.INVALID_INPUT, 'nope'))).toEqual([
      'command',
      'data',
      'errors',
      'success',
      'warnings',
    ]);
  });

  it('nulls data and carries a coded error on failure', () => {
    const envelope = fail('report', ERROR_CODES.NO_EVIDENCE, 'nothing swept yet');
    expect(envelope).toEqual({
      success: false,
      command: 'report',
      data: null,
      errors: [{ code: 'NO_EVIDENCE', message: 'nothing swept yet' }],
      warnings: [],
    });
  });

  it('recognizes a missing browser, because that failure has an obvious fix', () => {
    const err = new Error(
      'The Hearth web probe needs Chrome or Chromium installed (or CHROMIUM_PATH set). ' +
        'Install Google Chrome, or: npx playwright install chromium',
    );
    expect(classifyError(err)).toBe(ERROR_CODES.CHROMIUM_MISSING);
    expect(failFrom('sweep', err).errors[0]!.code).toBe('CHROMIUM_MISSING');
  });

  it('classifies a probe-core argument error as bad input, not a probe failure', () => {
    expect(classifyError(new Error('runSweep: no policies given'))).toBe(ERROR_CODES.INVALID_INPUT);
    expect(classifyError(new Error('the page fell over'))).toBe(ERROR_CODES.PROBE_FAILED);
  });

  it('stringifies to parseable JSON in both modes', () => {
    const envelope = ok('sweep', { runs: 6 });
    expect(JSON.parse(stringifyEnvelope(envelope))).toEqual(envelope);
    expect(JSON.parse(stringifyEnvelope(envelope, true))).toEqual(envelope);
    expect(stringifyEnvelope(envelope, true)).toContain('\n');
  });
});

describe('resolving what to probe', () => {
  it('serves a directory and writes evidence into it by default', () => {
    const target = resolveTarget({ dir: 'game', cwd: '/work' });
    expect(target).toEqual({ label: '/work/game', open: { dir: '/work/game' }, root: '/work/game', isUrl: false });
  });

  it('lets --out move the evidence root without moving the target', () => {
    const target = resolveTarget({ dir: 'game', out: 'evidence', cwd: '/work' });
    expect(target.label).toBe('/work/game');
    expect(target.root).toBe('/work/evidence');
  });

  it('takes a url verbatim and falls back to cwd for evidence', () => {
    const target = resolveTarget({ url: 'http://localhost:5173/', cwd: '/work' });
    expect(target).toEqual({
      label: 'http://localhost:5173/',
      open: { url: 'http://localhost:5173/' },
      root: '/work',
      isUrl: true,
    });
  });

  it('prefers the url when both are given, mirroring openWebGame', () => {
    expect(resolveTarget({ dir: 'game', url: 'http://x/', cwd: '/work' }).isUrl).toBe(true);
  });
});

describe('repro strings', () => {
  it('re-runs exactly one seeded episode', () => {
    expect(reproCommand('/work/game', 'mash', 3)).toBe(
      'hearth-probe sweep /work/game --policies mash --seeds 1 --seed-start 3',
    );
  });

  it('passes a url through --url instead of positionally', () => {
    expect(reproCommand('http://localhost:5173/', 'wander', 11)).toBe(
      'hearth-probe sweep --url http://localhost:5173/ --policies wander --seeds 1 --seed-start 11',
    );
  });

  it('quotes a path with a space so the copy-paste survives a shell', () => {
    expect(reproCommand('/tmp/my game', 'mash', 1)).toContain("sweep '/tmp/my game' --policies mash");
  });

  it('escapes an embedded quote with the POSIX idiom rather than breaking out of it', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(targetArgs('/plain/path')).toBe('/plain/path');
    expect(targetArgs('http://localhost:5173/?variant=healthy')).toBe(
      "--url 'http://localhost:5173/?variant=healthy'",
    );
  });
});

describe('the sweep view', () => {
  const view = sweepView(cannedReport());

  it('derives the sweep id from the evidence directory', () => {
    expect(view.sweepId).toBe('0002');
    expect(sweepIdFromDir('/a/b/sweeps/0017')).toBe('0017');
  });

  it('counts failing runs and answers "did it pass" in one boolean', () => {
    expect(view.failingRuns).toBe(2);
    expect(view.blockers).toBe(1);
    expect(view.passed).toBe(false);
    const clean = sweepView(
      cannedReport({ verdicts: { ...emptyVerdicts(), 'ran-clean': 6 }, failures: [], findings: [] }),
    );
    expect(clean.failingRuns).toBe(0);
    expect(clean.blockers).toBe(0);
    expect(clean.passed).toBe(true);
  });

  it('does not pass a sweep whose runs all "ran clean" but which flagged a blocker', () => {
    const blocked = sweepView(
      cannedReport({
        verdicts: { ...emptyVerdicts(), 'ran-clean': 6 },
        failures: [],
        findings: [{ kind: 'black-screen', severity: 'blocker', summary: 'the game renders nothing' }],
      }),
    );
    expect(blocked.failingRuns).toBe(0);
    expect(blocked.blockers).toBe(1);
    expect(blocked.passed).toBe(false);
  });

  it('attaches a repro to every failure', () => {
    expect(view.failures.map((f) => f.repro)).toEqual([
      "hearth-probe sweep '/tmp/my game' --policies mash --seeds 1 --seed-start 3",
      "hearth-probe sweep '/tmp/my game' --policies mash --seeds 1 --seed-start 5",
    ]);
    // The rest of the failure survives untouched alongside it.
    expect(view.failures[0]!.shot).toBe('sweeps/0002/shots/mash-3-final.png');
  });

  it('points at report.json for the depth it does not inline', () => {
    expect(view.reportPath).toBe('/tmp/my game/.hearth/evidence/sweeps/0002/report.json');
  });

  it('flags when the folded lists are sitting on probe-core’s caps', () => {
    expect(view.findingsAtCap).toBe(false);
    expect(view.failuresAtCap).toBe(false);
    const full = sweepView(
      cannedReport({
        findings: Array.from({ length: MAX_FINDINGS }, (_, i) => ({
          kind: `k${i}`,
          severity: 'issue' as const,
          summary: `s${i}`,
        })),
        failures: Array.from({ length: MAX_FAILURES }, (_, i) => ({
          policy: 'mash',
          seed: i,
          verdict: 'stuck' as const,
          detail: 'd',
        })),
      }),
    );
    expect(full.findingsAtCap).toBe(true);
    expect(full.failuresAtCap).toBe(true);
  });
});

describe('the human report', () => {
  const view = sweepView(cannedReport());
  const lines = renderSweepHuman(view);
  const text = lines.join('\n');

  it('opens with a verdict tally that drops the zero buckets', () => {
    expect(verdictLine(view)).toBe('6 runs: error 1, stuck 1, ran-clean 4 — 2 failing');
    expect(text).toContain('6 runs: error 1, stuck 1, ran-clean 4 — 2 failing');
    expect(text).not.toContain('objective-failed 0');
  });

  it('says "all clean" when nothing failed', () => {
    const clean = sweepView(cannedReport({ verdicts: { ...emptyVerdicts(), 'ran-clean': 6 }, failures: [] }));
    expect(verdictLine(clean)).toBe('6 runs: ran-clean 6 — all clean');
  });

  it('renders every finding instead of collapsing them into a count', () => {
    expect(text).toContain('[blocker] unhandled-error: TypeError: player.update is not a function');
    expect(text).toContain('[issue] no-progress: the avatar never left its spawn cell');
    expect(text).toContain('[note] black-screen: 31% of sampled frames were uniformly black');
    expect(text).not.toMatch(/\[\d+ items\]/);
  });

  it('carries each finding’s frame and screenshot', () => {
    expect(renderFinding(view.findings[0]!).join('\n')).toContain(
      'frame 12 · shot sweeps/0002/shots/mash-3-final.png',
    );
  });

  it('prints each failure with its repro on its own line', () => {
    expect(text).toContain('- mash/3 error at frame 12 — TypeError: player.update is not a function');
    expect(text).toContain("repro: hearth-probe sweep '/tmp/my game' --policies mash --seeds 1 --seed-start 3");
    expect(renderFailure(view.failures[1]!)).toHaveLength(2);
  });

  it('names what was NOT checked, so "no findings" cannot be misread', () => {
    expect(text).toContain('not checked (1):');
    expect(text).toContain('sealed-region: no nav grid');
  });

  it('ends on the evidence directory and the report path', () => {
    expect(text).toContain('evidence: /tmp/my game/.hearth/evidence/sweeps/0002');
    expect(text).toContain('full detail: /tmp/my game/.hearth/evidence/sweeps/0002/report.json');
  });

  it('says "findings: none" rather than omitting the section', () => {
    const clean = renderSweepHuman(sweepView(cannedReport({ findings: [], failures: [] }))).join('\n');
    expect(clean).toContain('findings: none');
  });

  it('elides only long detail, and marks it', () => {
    const long = 'x'.repeat(400);
    const rendered = renderFinding({ kind: 'k', severity: 'issue', summary: 's', detail: long }).join('\n');
    expect(rendered).toContain('…');
    expect(rendered.length).toBeLessThan(260);
  });

  it('folds a contiguous seed range', () => {
    expect(formatSeeds([1, 2, 3, 4, 5, 6])).toBe('1-6');
    expect(formatSeeds([3])).toBe('3');
    expect(formatSeeds([1, 4, 9])).toBe('1,4,9');
    expect(formatSeeds([])).toBe('none');
  });
});

describe('emit', () => {
  it('prints the exact envelope under --json and nothing else', () => {
    const io = captureIo();
    const envelope = ok('sweep', sweepView(cannedReport()));
    emit(io, envelope, { json: true }, () => ['unused']);
    expect(JSON.parse(io.text())).toEqual(JSON.parse(JSON.stringify(envelope)));
  });

  it('prints human lines otherwise, warnings included', () => {
    const io = captureIo();
    emit(io, ok('sweep', sweepView(cannedReport()), [{ code: 'POLICIES_SKIPPED', message: 'wander did not run' }]), {}, renderSweepHuman);
    expect(io.text()).toContain('warning [POLICIES_SKIPPED]: wander did not run');
    expect(io.text()).toContain('✗ sweep 0002 — /tmp/my game');
  });

  it('exits 0 on success, 1 on error, and 1 on a sweep that ran fine but found failures', () => {
    const io = captureIo();
    expect(emit(io, ok('sweep', 1), { json: true }, () => [])).toBe(0);
    expect(emit(io, fail('sweep', ERROR_CODES.PROBE_FAILED, 'boom'), { json: true }, () => [])).toBe(1);
    expect(emit(io, ok('sweep', 1), { json: true }, () => [], true)).toBe(1);
  });

  it('renders a failure without --json as a coded error line', () => {
    const io = captureIo();
    emit(io, fail('report', ERROR_CODES.NO_EVIDENCE, 'run a sweep first'), {}, () => []);
    expect(io.text()).toBe('✗ report\n  error [NO_EVIDENCE]: run a sweep first');
  });
});

describe('pngSize', () => {
  it('reads IHDR without decoding the image', () => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12);
    new DataView(bytes.buffer).setUint32(16, 960);
    new DataView(bytes.buffer).setUint32(20, 540);
    expect(pngSize(bytes)).toEqual({ width: 960, height: 540 });
  });

  it('returns null for anything that is not a PNG', () => {
    expect(pngSize(new Uint8Array(4))).toBeNull();
    expect(pngSize(new Uint8Array(64))).toBeNull();
  });
});
