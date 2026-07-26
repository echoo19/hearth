/**
 * Pure shaping for the evidence feed: raw `EvidenceEvent`s in, rows the rail
 * renders out. No DOM, no store — so the folding rules are unit-tested
 * directly (tests/timeline.test.ts).
 *
 * The journal is a flat event stream, but what a person wants to see is one
 * card per sweep: it started, N runs finished with these verdicts, here are
 * the shots. So events are folded onto their sweep, newest sweep first, with
 * loose notes and orphan shots kept as their own rows rather than dropped.
 */
import type { EvidenceEvent, Verdict } from '../../types';

/** Verdicts get one of three tones. Anything unrecognised reads as neutral. */
export type VerdictTone = 'ok' | 'warn' | 'err' | 'neutral';

export function verdictTone(verdict: Verdict): VerdictTone {
  switch (verdict) {
    case 'ran-clean':
      return 'ok';
    case 'stuck':
    case 'unresponsive':
    case 'no-progress':
      return 'warn';
    case 'error':
    case 'crash':
    case 'black-screen':
      return 'err';
    default:
      return 'neutral';
  }
}

/** Verdict ids are hyphenated; show them as words. */
export function verdictLabel(verdict: Verdict): string {
  return verdict.replace(/-/g, ' ');
}

export interface VerdictCount {
  verdict: Verdict;
  count: number;
  tone: VerdictTone;
}

export interface SweepRow {
  kind: 'sweep';
  id: string;
  sweepId: string;
  ts: string;
  /** What was played, when the journal says. */
  target?: string;
  /** Still running when the journal has no sweep-finished for it. */
  running: boolean;
  counts: VerdictCount[];
  runs: number;
  /** Evidence-relative screenshot paths belonging to this sweep. */
  shots: string[];
  findings: { kind?: string; detail?: string }[];
}

export interface NoteRow {
  kind: 'note';
  id: string;
  ts: string;
  text: string;
}

export type EvidenceRow = SweepRow | NoteRow;

function tally(counts: Record<string, number>): VerdictCount[] {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([verdict, count]) => ({ verdict, count, tone: verdictTone(verdict) }))
    .sort((a, b) => b.count - a.count || a.verdict.localeCompare(b.verdict));
}

/**
 * Fold the journal into rows, newest first. `sweep-finished` counts win over
 * accumulated `run-finished` ones (the report is authoritative); a sweep with
 * neither is still shown, so a sweep in progress appears immediately.
 */
export function foldEvidence(events: readonly EvidenceEvent[]): EvidenceRow[] {
  const sweeps = new Map<string, SweepRow>();
  const notes: NoteRow[] = [];
  const running = new Map<string, Record<string, number>>();
  const finished = new Set<string>();

  const sweepFor = (sweepId: string, ts: string): SweepRow => {
    const existing = sweeps.get(sweepId);
    if (existing) return existing;
    const row: SweepRow = {
      kind: 'sweep',
      id: `sweep:${sweepId}`,
      sweepId,
      ts,
      running: true,
      counts: [],
      runs: 0,
      shots: [],
      findings: [],
    };
    sweeps.set(sweepId, row);
    return row;
  };

  for (const event of events) {
    switch (event.kind) {
      case 'sweep-started': {
        const row = sweepFor(String(event.sweepId ?? ''), event.ts);
        row.ts = event.ts;
        row.target = event.target;
        break;
      }
      case 'run-finished': {
        const sweepId = String(event.sweepId ?? '');
        const row = sweepFor(sweepId, event.ts);
        row.runs += 1;
        row.ts = event.ts;
        const bucket = running.get(sweepId) ?? {};
        const verdict = String(event.verdict ?? 'unknown');
        bucket[verdict] = (bucket[verdict] ?? 0) + 1;
        running.set(sweepId, bucket);
        break;
      }
      case 'sweep-finished': {
        const sweepId = String(event.sweepId ?? '');
        const row = sweepFor(sweepId, event.ts);
        row.ts = event.ts;
        row.running = false;
        finished.add(sweepId);
        row.counts = tally(event.verdicts ?? {});
        row.runs = row.counts.reduce((sum, c) => sum + c.count, 0) || row.runs;
        row.findings = (event.findings ?? []).map((f) => ({ kind: f.kind, detail: f.detail }));
        break;
      }
      case 'shot': {
        const sweepId = event.sweepId ? String(event.sweepId) : null;
        const shotPath = typeof event.path === 'string' ? event.path : null;
        if (!shotPath) break;
        if (sweepId) sweepFor(sweepId, event.ts).shots.push(shotPath);
        else notes.push({ kind: 'note', id: `shot:${event.seq}`, ts: event.ts, text: event.caption ?? shotPath });
        break;
      }
      default:
        notes.push({
          kind: 'note',
          id: `note:${event.seq}`,
          ts: event.ts,
          text: typeof event.text === 'string' ? event.text : event.kind,
        });
        break;
    }
  }

  for (const [sweepId, bucket] of running) {
    if (finished.has(sweepId)) continue;
    const row = sweeps.get(sweepId);
    if (row) row.counts = tally(bucket);
  }

  const rows: EvidenceRow[] = [...sweeps.values(), ...notes];
  // Newest first; ties break on the synthetic id so ordering stays stable.
  rows.sort((a, b) => (a.ts === b.ts ? b.id.localeCompare(a.id) : b.ts.localeCompare(a.ts)));
  return rows;
}

/**
 * One-line summary for the rail's collapsed header: the newest sweep's
 * verdict mix, or a plain count when there is nothing to summarise.
 */
export function railSummary(rows: readonly EvidenceRow[]): string {
  const sweep = rows.find((row): row is SweepRow => row.kind === 'sweep');
  if (!sweep) return rows.length === 0 ? 'No playtests yet' : `${rows.length} entries`;
  if (sweep.running && sweep.counts.length === 0) return 'Playing…';
  if (sweep.counts.length === 0) return `${sweep.runs} runs`;
  return sweep.counts.map((c) => `${c.count} ${verdictLabel(c.verdict)}`).join(' · ');
}
