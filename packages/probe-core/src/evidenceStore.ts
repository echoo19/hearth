/**
 * The evidence store on a real filesystem.
 *
 * Everything the app, the CLI, or an external agent shows about a game comes
 * from files under `<root>/.hearth/evidence`, laid out exactly as evidence.ts
 * documents. Sweep ids are zero-padded sequence numbers, not timestamps, so a
 * path stays stable, sorts correctly, and can be pasted into a conversation.
 *
 * The journal is append-only and single-writer: appends are serialized through
 * one promise chain so two concurrent finishes cannot interleave a line, and
 * `seq` is recovered by counting existing lines the first time it is needed
 * (a fresh process picks up where the last one left off).
 */
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EVIDENCE_DIR, type EvidenceEvent, type EvidenceStore } from './evidence.js';
import type { RunResult, SweepReport } from './contract.js';

/** Omit that distributes over a union instead of collapsing it to its common keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A journal event as callers build it — one full variant minus the fields the
 * store stamps. `Omit<EvidenceEvent, 'seq' | 'ts'>` in the committed interface
 * collapses the union to its common keys, which is too loose to catch a typo in
 * a payload; this keeps the per-variant shape while still satisfying it.
 */
export type EvidenceEventInput = DistributiveOmit<EvidenceEvent, 'seq' | 'ts'>;

/** Append a fully-typed event to any EvidenceStore. */
export function appendEvidence(store: EvidenceStore, event: EvidenceEventInput): Promise<void> {
  return store.append(event);
}

export class NodeEvidenceStore implements EvidenceStore {
  /** Absolute path of `<root>/.hearth/evidence`. */
  readonly dir: string;
  private readonly journalPath: string;
  private seq: number | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly root: string) {
    this.dir = path.join(root, EVIDENCE_DIR);
    this.journalPath = path.join(this.dir, 'journal.jsonl');
  }

  /** Absolute path of a sweep's directory. */
  sweepDir(sweepId: string): string {
    return path.join(this.dir, 'sweeps', sweepId);
  }

  async beginSweep(
    _target: string,
    _policies: string[],
    _seeds: number[],
  ): Promise<{ sweepId: string; dir: string }> {
    const sweeps = path.join(this.dir, 'sweeps');
    await mkdir(sweeps, { recursive: true });
    let max = 0;
    for (const name of await readdir(sweeps)) {
      if (/^\d{4}$/.test(name)) max = Math.max(max, Number(name));
    }
    const sweepId = String(max + 1).padStart(4, '0');
    const dir = this.sweepDir(sweepId);
    await mkdir(path.join(dir, 'runs'), { recursive: true });
    await mkdir(path.join(dir, 'shots'), { recursive: true });
    return { sweepId, dir };
  }

  async writeRun(sweepId: string, run: RunResult): Promise<void> {
    const file = path.join(this.sweepDir(sweepId), 'runs', `${safe(run.policy)}-${run.seed}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  }

  async writeShot(sweepId: string, name: string, png: Uint8Array): Promise<string> {
    const file = safe(name.endsWith('.png') ? name : `${name}.png`);
    const abs = path.join(this.sweepDir(sweepId), 'shots', file);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, png);
    // Findings reference shots relative to the evidence dir (see contract.ts).
    return `sweeps/${sweepId}/shots/${file}`;
  }

  async finishSweep(sweepId: string, report: SweepReport): Promise<string> {
    const file = path.join(this.sweepDir(sweepId), 'report.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return file;
  }

  async append(event: Omit<EvidenceEvent, 'seq' | 'ts'>): Promise<void> {
    const write = this.tail.then(async () => {
      await mkdir(this.dir, { recursive: true });
      if (this.seq === null) this.seq = await this.countLines();
      const full = { ...event, seq: ++this.seq, ts: new Date().toISOString() } as EvidenceEvent;
      await appendFile(this.journalPath, `${JSON.stringify(full)}\n`, 'utf8');
    });
    // Keep the chain alive even when one append fails, but still surface the error.
    this.tail = write.catch(() => undefined);
    return write;
  }

  /** Read the journal back, newest last. Convenience for the UI and tests. */
  async readJournal(): Promise<EvidenceEvent[]> {
    let text: string;
    try {
      text = await readFile(this.journalPath, 'utf8');
    } catch {
      return [];
    }
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as EvidenceEvent);
  }

  private async countLines(): Promise<number> {
    return (await this.readJournal()).length;
  }
}

/** Keep generated names inside the sweep directory. */
function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-');
}
