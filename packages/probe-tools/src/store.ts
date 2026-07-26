/**
 * Reading the evidence store back without a browser.
 *
 * `hearth-probe report` and `probe_report` answer "what did the last sweep
 * say?" from files alone, which is the whole point of the store being a
 * neutral bus: the app, the CLI and an MCP client all read the same bytes,
 * and re-reading costs nothing. Sweep ids are zero-padded sequence numbers,
 * so "latest" is a numeric max over directory names, not an mtime race.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { EVIDENCE_DIR, type SweepReport } from '@hearth/probe-core';

export interface StoredSweep {
  sweepId: string;
  dir: string;
  reportPath: string;
  report: SweepReport;
}

/** Absolute path of `<root>/.hearth/evidence`. */
export function evidenceDirFor(root: string): string {
  return path.join(root, EVIDENCE_DIR);
}

/** Every sweep id that has a directory under `<root>`, oldest first. */
export async function listSweepIds(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(path.join(evidenceDirFor(root), 'sweeps'));
  } catch {
    return [];
  }
  return names.filter((name) => /^\d{4}$/.test(name)).sort();
}

/** Read one sweep's report.json, or null when it has none (an interrupted sweep). */
export async function readSweep(root: string, sweepId: string): Promise<StoredSweep | null> {
  const dir = path.join(evidenceDirFor(root), 'sweeps', sweepId);
  const reportPath = path.join(dir, 'report.json');
  let text: string;
  try {
    text = await readFile(reportPath, 'utf8');
  } catch {
    return null;
  }
  try {
    return { sweepId, dir, reportPath, report: JSON.parse(text) as SweepReport };
  } catch (err) {
    throw new Error(`evidence at ${reportPath} is not valid JSON: ${(err as Error).message}`);
  }
}

/**
 * The newest *finished* sweep under `root`. A sweep that was interrupted
 * before `finishSweep` has a directory but no report; skipping backwards past
 * it is more useful than reporting nothing at all.
 */
export async function findLatestSweep(root: string): Promise<StoredSweep | null> {
  const ids = await listSweepIds(root);
  for (let i = ids.length - 1; i >= 0; i--) {
    const sweep = await readSweep(root, ids[i]!);
    if (sweep) return sweep;
  }
  return null;
}
