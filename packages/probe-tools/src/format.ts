/**
 * Turning a SweepReport into the two things an agent actually consumes: a JSON
 * payload for the envelope, and a handful of terminal lines.
 *
 * Three rules, all of them load-bearing:
 *
 * 1. **Never `[N items]`.** A folded report is already small — probe-core caps
 *    findings at 8 (3 per kind) and failures at 5 — so every one of them is
 *    rendered in full. Collapsing them into a count is exactly the token
 *    "saving" that forces a second tool call to learn anything.
 * 2. **Every failure carries its repro.** The bot's rng is seeded, so one
 *    (policy, seed) pair is a re-runnable experiment. The repro string is
 *    computed once, put in the JSON *and* printed, so an agent never has to
 *    reassemble it from parts.
 * 3. **Depth lives in report.json.** The lines say where it is; they don't
 *    inline evidence blobs, coverage keys, or per-run detail.
 *
 * Everything here is pure: same report in, same strings out. No clock, no fs,
 * no browser — which is what makes it unit-testable against a canned report.
 */
import path from 'node:path';
import {
  MAX_FAILURES,
  MAX_FINDINGS,
  type Finding,
  type SkippedDetector,
  type SweepFailure,
  type SweepReport,
  type Verdict,
} from '@hearth/probe-core';
import { targetArgs, shellQuote } from './target.js';

/** Display order: worst verdict first, matching the contract's precedence. */
export const VERDICT_ORDER: readonly Verdict[] = [
  'error',
  'stuck',
  'objective-failed',
  'completed',
  'ran-clean',
];

/** Verdicts that mean a run went wrong (the sweep's exit-code signal). */
const FAILING: ReadonlySet<Verdict> = new Set<Verdict>(['error', 'stuck', 'objective-failed']);

/** Longest `detail` rendered inline before it is elided (report.json has it all). */
const MAX_DETAIL_CHARS = 180;

export interface FailureView extends SweepFailure {
  /** A complete, copy-pasteable command that re-runs exactly this one episode. */
  repro: string;
}

/** The `data` payload of a `sweep` or `report` envelope. */
export interface SweepView {
  target: string;
  /** Zero-padded sweep sequence id, e.g. "0003". */
  sweepId: string;
  policies: string[];
  seeds: number[];
  runs: number;
  verdicts: Record<Verdict, number>;
  /** Runs whose verdict was error/stuck/objective-failed. */
  failingRuns: number;
  /** Blocker-severity findings. A detector can flag one without failing a run. */
  blockers: number;
  /**
   * True when no run failed AND nothing was flagged as a blocker. The single
   * boolean an agent branches on, and what the CLI's exit code follows — a
   * blocker finding on otherwise "clean" runs still means do not ship.
   */
  passed: boolean;
  findings: Finding[];
  skipped: SkippedDetector[];
  failures: FailureView[];
  framesSimulated: number;
  wallMs: number;
  evidenceDir: string;
  reportPath: string;
  /** True when the fold caps may have hidden more of that list. */
  findingsAtCap: boolean;
  failuresAtCap: boolean;
}

/**
 * The command that re-runs one episode. `--seeds 1 --seed-start <seed>` rather
 * than a `--seed` flag so the repro is the same grammar as the sweep that
 * produced it — one dial, narrowed, not a different mode.
 */
export function reproCommand(target: string, policy: string, seed: number): string {
  return `hearth-probe sweep ${targetArgs(target)} --policies ${shellQuote(policy)} --seeds 1 --seed-start ${seed}`;
}

/** Sweep sequence id from an evidence dir (".../sweeps/0003" → "0003"). */
export function sweepIdFromDir(evidenceDir: string): string {
  return path.basename(evidenceDir);
}

export function countFailing(verdicts: Record<Verdict, number>): number {
  let n = 0;
  for (const verdict of VERDICT_ORDER) if (FAILING.has(verdict)) n += verdicts[verdict] ?? 0;
  return n;
}

/** The JSON payload for a report — everything an agent needs without a second read. */
export function sweepView(report: SweepReport): SweepView {
  const failingRuns = countFailing(report.verdicts);
  const blockers = report.findings.filter((f) => f.severity === 'blocker').length;
  return {
    target: report.target,
    sweepId: sweepIdFromDir(report.evidenceDir),
    policies: report.policies,
    seeds: report.seeds,
    runs: report.runs,
    verdicts: report.verdicts,
    failingRuns,
    blockers,
    passed: failingRuns === 0 && blockers === 0,
    findings: report.findings,
    skipped: report.skipped,
    failures: report.failures.map((failure) => ({
      ...failure,
      repro: reproCommand(report.target, failure.policy, failure.seed),
    })),
    framesSimulated: report.framesSimulated,
    wallMs: report.wallMs,
    evidenceDir: report.evidenceDir,
    reportPath: path.join(report.evidenceDir, 'report.json'),
    findingsAtCap: report.findings.length >= MAX_FINDINGS,
    failuresAtCap: report.failures.length >= MAX_FAILURES,
  };
}

/** "12 runs: ran-clean 10, stuck 2" — zero-count verdicts are noise, so they're dropped. */
export function verdictLine(view: Pick<SweepView, 'runs' | 'verdicts' | 'failingRuns'>): string {
  const parts = VERDICT_ORDER.filter((v) => (view.verdicts[v] ?? 0) > 0).map(
    (v) => `${v} ${view.verdicts[v]}`,
  );
  const tally = parts.length > 0 ? parts.join(', ') : 'no runs';
  const suffix = view.failingRuns > 0 ? ` — ${view.failingRuns} failing` : ' — all clean';
  return `${view.runs} runs: ${tally}${suffix}`;
}

function elide(text: string, max = MAX_DETAIL_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function instant(at: { frame: number; ms?: number } | undefined): string {
  if (!at) return '';
  return ` at frame ${at.frame}`;
}

/** One finding, fully rendered — severity, summary, where, detail, shot. */
export function renderFinding(finding: Finding, indent = '    '): string[] {
  const lines = [`${indent}- [${finding.severity}] ${finding.kind}: ${elide(finding.summary)}`];
  const where = [
    finding.at ? `frame ${finding.at.frame}` : '',
    finding.shot ? `shot ${finding.shot}` : '',
  ].filter(Boolean);
  if (finding.detail) lines.push(`${indent}    ${elide(finding.detail)}`);
  if (where.length > 0) lines.push(`${indent}    ${where.join(' · ')}`);
  return lines;
}

/** One failure, fully rendered — with the repro on its own line, ready to copy. */
export function renderFailure(failure: FailureView, indent = '    '): string[] {
  return [
    `${indent}- ${failure.policy}/${failure.seed} ${failure.verdict}${instant(failure.at)} — ${elide(failure.detail)}`,
    `${indent}    repro: ${failure.repro}`,
  ];
}

/**
 * The human `sweep`/`report` output. Reads top-down: what happened, what is
 * wrong, how to reproduce it, what was NOT checked, where the full story is.
 */
export function renderSweepHuman(view: SweepView): string[] {
  const lines: string[] = [];
  lines.push(`${view.passed ? '✓' : '✗'} sweep ${view.sweepId} — ${view.target}`);
  lines.push(`  ${verdictLine(view)}`);
  lines.push(`  policies: ${view.policies.join(', ') || 'none ran'} · seeds: ${formatSeeds(view.seeds)}`);

  if (view.findings.length === 0) {
    lines.push('  findings: none');
  } else {
    lines.push(`  findings (${view.findings.length}${view.findingsAtCap ? ', at cap' : ''}):`);
    for (const finding of view.findings) lines.push(...renderFinding(finding));
  }

  if (view.failures.length > 0) {
    lines.push(`  failures (${view.failures.length}${view.failuresAtCap ? ', at cap' : ''}):`);
    for (const failure of view.failures) lines.push(...renderFailure(failure));
  }

  // Never silently omitted: "no findings" must never be mistaken for
  // "everything was checked" (contract.ts's rule, surfaced at the edge).
  if (view.skipped.length > 0) {
    lines.push(`  not checked (${view.skipped.length}):`);
    for (const skip of view.skipped) lines.push(`    - ${skip.kind}: ${elide(skip.reason, 120)}`);
  }

  lines.push(`  evidence: ${view.evidenceDir}`);
  lines.push(`  full detail: ${view.reportPath}`);
  if (view.findingsAtCap || view.failuresAtCap) {
    lines.push('  (lists are folded to their caps — report.json and runs/*.json have the rest)');
  }
  return lines;
}

/** "1-6" for a contiguous run, else a plain list. */
export function formatSeeds(seeds: readonly number[]): string {
  if (seeds.length === 0) return 'none';
  if (seeds.length === 1) return String(seeds[0]);
  const contiguous = seeds.every((s, i) => i === 0 || s === seeds[i - 1]! + 1);
  return contiguous ? `${seeds[0]}-${seeds[seeds.length - 1]}` : seeds.join(',');
}
