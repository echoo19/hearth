/**
 * The evidence store: the neutral bus between whatever runs the probe (app
 * conversation, CLI, external agent) and whatever renders the results.
 * Everything the app's UI shows about a game is a file written here.
 *
 * Layout, relative to a project root:
 *   .hearth/evidence/
 *     journal.jsonl            — append-only EvidenceEvent stream (the UI feed)
 *     sweeps/<id>/report.json  — SweepReport
 *     sweeps/<id>/runs/<policy>-<seed>.json — RunResult
 *     sweeps/<id>/shots/*.png  — screenshots referenced by findings/runs
 *
 * Sweep ids are zero-padded sequence numbers ("0001"), not timestamps, so
 * paths are stable and sortable.
 */
import type { Finding, PolicyMode, RunResult, SweepReport, Verdict } from './contract.js';

export const EVIDENCE_DIR = '.hearth/evidence';
export const EVIDENCE_JOURNAL = `${EVIDENCE_DIR}/journal.jsonl`;

/** One line in journal.jsonl. The UI renders these newest-first. */
export type EvidenceEvent =
  | {
      kind: 'sweep-started';
      seq: number;
      ts: string;
      sweepId: string;
      target: string;
      policies: string[];
      seeds: number[];
    }
  | {
      kind: 'run-finished';
      seq: number;
      ts: string;
      sweepId: string;
      policy: string;
      seed: number;
      verdict: Verdict;
      frames: number;
      /** Absent means `full`. See PolicyMode: a degraded run says so as it lands. */
      mode?: PolicyMode;
    }
  | {
      kind: 'sweep-finished';
      seq: number;
      ts: string;
      sweepId: string;
      verdicts: Record<Verdict, number>;
      findings: Finding[];
      reportPath: string;
    }
  | {
      kind: 'shot';
      seq: number;
      ts: string;
      sweepId?: string;
      path: string;
      caption?: string;
    }
  | {
      kind: 'note';
      seq: number;
      ts: string;
      text: string;
      source: 'app' | 'cli' | 'mcp' | 'agent';
    };

export interface EvidenceStore {
  /** Allocate the next sweep directory and id. */
  beginSweep(target: string, policies: string[], seeds: number[]): Promise<{ sweepId: string; dir: string }>;
  writeRun(sweepId: string, run: RunResult): Promise<void>;
  writeShot(sweepId: string, name: string, png: Uint8Array): Promise<string>;
  finishSweep(sweepId: string, report: SweepReport): Promise<string>;
  append(event: Omit<EvidenceEvent, 'seq' | 'ts'>): Promise<void>;
}
