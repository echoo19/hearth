/**
 * Folding many runs into one small report.
 *
 * A sweep produces dozens of runs and hundreds of observations; an agent reads
 * the summary, so the summary has to stay small without lying. Ported from
 * @hearth/playtest's sweep.ts: dedupe findings by kind+summary, sort by
 * severity, cap the total (8) and the per-kind share (3) so one loud detector
 * cannot crowd out a quiet blocker, and surface at most 5 failures worst-first.
 *
 * All pure — same inputs, same report, no clock and no rng.
 */
import type {
  Finding,
  ObjectiveOutcome,
  RunResult,
  Severity,
  SkippedDetector,
  SweepFailure,
  Verdict,
} from './contract.js';

/** Order findings for display: blocker → issue → note, stable within a tier. */
const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, issue: 1, note: 2 };
/** Cap on findings surfaced in the summary (full detail lands in the run files). */
export const MAX_FINDINGS = 8;
/** Per-kind cap so one noisy detector can't crowd out the rest. */
export const MAX_PER_KIND = 3;
/** Hard cap on failures surfaced in the summary. */
export const MAX_FAILURES = 5;

/** Verdicts that count as a failure, most severe first. */
const FAILURE_RANK: Partial<Record<Verdict, number>> = {
  error: 0,
  stuck: 1,
  'objective-failed': 2,
};

/** Every verdict key present (zeros included) so the report shape is stable. */
export function emptyVerdictTally(): Record<Verdict, number> {
  return { error: 0, stuck: 0, 'objective-failed': 0, completed: 0, 'ran-clean': 0 };
}

export function tallyVerdicts(runs: readonly RunResult[]): Record<Verdict, number> {
  const tally = emptyVerdictTally();
  for (const run of runs) tally[run.verdict]++;
  return tally;
}

/** Dedupe (by kind+summary), sort by severity, and cap — keeping the report token-frugal. */
export function foldFindings(all: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const perKind = new Map<string, number>();
  const deduped: Finding[] = [];
  for (const f of all) {
    const key = `${f.kind} ${f.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }
  deduped.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3));
  const out: Finding[] = [];
  for (const f of deduped) {
    const n = perKind.get(f.kind) ?? 0;
    if (n >= MAX_PER_KIND) continue;
    perKind.set(f.kind, n + 1);
    out.push(f);
    if (out.length >= MAX_FINDINGS) break;
  }
  return out;
}

/** Union of skipped detectors across runs, deduped by kind, first reason wins. */
export function foldSkipped(all: readonly SkippedDetector[]): SkippedDetector[] {
  const byKind = new Map<string, SkippedDetector>();
  for (const s of all) if (!byKind.has(s.kind)) byKind.set(s.kind, s);
  return [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

/** Verdict precedence: error > stuck > objective-failed > completed > ran-clean. */
export function decideVerdict(input: {
  hasError: boolean;
  stuck: boolean;
  objectives: readonly Pick<ObjectiveOutcome, 'achieved' | 'failed'>[];
}): Verdict {
  if (input.hasError) return 'error';
  if (input.stuck) return 'stuck';
  if (input.objectives.length > 0) {
    return input.objectives.every((o) => o.achieved && !o.failed) ? 'completed' : 'objective-failed';
  }
  return 'ran-clean';
}

/** The most severe failing runs (cap 5), worst-first, ties broken deterministically. */
export function collectFailures(runs: readonly RunResult[], stuckAfter: number): SweepFailure[] {
  const failing = runs.filter((r) => r.verdict in FAILURE_RANK);
  failing.sort((a, b) => {
    const sa = FAILURE_RANK[a.verdict] ?? 9;
    const sb = FAILURE_RANK[b.verdict] ?? 9;
    if (sa !== sb) return sa - sb;
    if (a.seed !== b.seed) return a.seed - b.seed;
    return a.policy.localeCompare(b.policy);
  });
  return failing.slice(0, MAX_FAILURES).map((r) => {
    const shot = r.shots.length > 0 ? r.shots[r.shots.length - 1] : undefined;
    return {
      policy: r.policy,
      seed: r.seed,
      verdict: r.verdict,
      ...(failureInstant(r) ? { at: failureInstant(r) } : {}),
      detail: failureDetail(r, stuckAfter),
      ...(shot ? { shot } : {}),
    };
  });
}

function failureInstant(r: RunResult) {
  if (r.verdict === 'error' && r.firstError) return r.firstError.at;
  return { frame: r.frames };
}

function failureDetail(r: RunResult, stuckAfter: number): string {
  if (r.verdict === 'error') return r.firstError?.message ?? 'unhandled error';
  if (r.verdict === 'stuck') return `no novelty for ${stuckAfter} steps`;
  const unmet = r.objectives.filter((o) => o.failed || !o.achieved).length;
  return unmet > 0 ? `${unmet} objective(s) unmet` : 'objectives unmet at cap';
}
