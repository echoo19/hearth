/**
 * The evidence store writes the only interface the rest of Hearth has to a
 * sweep, so the layout documented in evidence.ts is the contract under test:
 * stable zero-padded sweep ids, per-run files, shots addressed relative to the
 * evidence dir, and an append-only journal with monotonic sequence numbers.
 */
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendEvidence,
  emptyVerdictTally,
  encodePng,
  blankImage,
  EVIDENCE_DIR,
  NodeEvidenceStore,
  type RunResult,
  type SweepReport,
} from '@hearth/probe-core';

async function root(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'probe-evidence-'));
}

const RUN: RunResult = {
  policy: 'mash',
  seed: 3,
  verdict: 'stuck',
  frames: 420,
  wallMs: 12,
  findings: [],
  skipped: [],
  objectives: [],
  coverageKeys: ['c:1,1'],
  shots: [],
};

function report(over: Partial<SweepReport> = {}): SweepReport {
  return {
    target: 'fixture',
    policies: ['mash'],
    seeds: [3],
    runs: 1,
    verdicts: emptyVerdictTally(),
    findings: [],
    skipped: [],
    failures: [],
    framesSimulated: 420,
    wallMs: 12,
    evidenceDir: '',
    ...over,
  };
}

describe('NodeEvidenceStore', () => {
  it('lays out sweeps exactly where evidence.ts says', async () => {
    const dir = await root();
    const store = new NodeEvidenceStore(dir);
    const sweep = await store.beginSweep('fixture', ['mash'], [3]);
    expect(sweep.sweepId).toBe('0001');
    expect(sweep.dir).toBe(path.join(dir, EVIDENCE_DIR, 'sweeps', '0001'));

    await store.writeRun(sweep.sweepId, RUN);
    const shot = await store.writeShot(sweep.sweepId, 'mash-3-00030', encodePng(blankImage(4, 4, [1, 2, 3, 255])));
    const reportPath = await store.finishSweep(sweep.sweepId, report({ evidenceDir: sweep.dir }));

    expect(shot).toBe('sweeps/0001/shots/mash-3-00030.png');
    expect(reportPath).toBe(path.join(sweep.dir, 'report.json'));
    // Shot paths in findings are relative to the evidence dir, so this resolves.
    expect((await stat(path.join(dir, EVIDENCE_DIR, shot))).isFile()).toBe(true);
    expect(await readdir(path.join(sweep.dir, 'runs'))).toEqual(['mash-3.json']);
    expect(JSON.parse(await readFile(path.join(sweep.dir, 'runs', 'mash-3.json'), 'utf8'))).toEqual(RUN);
    expect(JSON.parse(await readFile(reportPath, 'utf8')).target).toBe('fixture');
  });

  it('allocates sequential, sortable sweep ids', async () => {
    const store = new NodeEvidenceStore(await root());
    expect((await store.beginSweep('a', [], [])).sweepId).toBe('0001');
    expect((await store.beginSweep('a', [], [])).sweepId).toBe('0002');
    expect((await store.beginSweep('a', [], [])).sweepId).toBe('0003');
  });

  it('picks up the sequence a previous process left behind', async () => {
    const dir = await root();
    await new NodeEvidenceStore(dir).beginSweep('a', [], []);
    const later = new NodeEvidenceStore(dir);
    expect((await later.beginSweep('a', [], [])).sweepId).toBe('0002');
  });

  it('journals events in order with monotonic seq and an ISO timestamp', async () => {
    const dir = await root();
    const store = new NodeEvidenceStore(dir);
    await appendEvidence(store, { kind: 'note', text: 'first', source: 'cli' });
    await appendEvidence(store, {
      kind: 'run-finished',
      sweepId: '0001',
      policy: 'mash',
      seed: 1,
      verdict: 'ran-clean',
      frames: 10,
    });
    const journal = await store.readJournal();
    expect(journal.map((e) => e.seq)).toEqual([1, 2]);
    expect(journal[0].kind).toBe('note');
    expect(Number.isNaN(Date.parse(journal[1].ts))).toBe(false);

    // A fresh store over the same root continues the sequence.
    const later = new NodeEvidenceStore(dir);
    await appendEvidence(later, { kind: 'note', text: 'third', source: 'app' });
    expect((await later.readJournal()).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('serializes concurrent appends into whole lines', async () => {
    const store = new NodeEvidenceStore(await root());
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        appendEvidence(store, { kind: 'note', text: `n${i}`, source: 'agent' }),
      ),
    );
    const journal = await store.readJournal();
    expect(journal).toHaveLength(20);
    expect(journal.map((e) => e.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });

  it('reads an empty journal as no events', async () => {
    expect(await new NodeEvidenceStore(await root()).readJournal()).toEqual([]);
  });

  it('keeps generated shot names inside the sweep directory', async () => {
    const dir = await root();
    const store = new NodeEvidenceStore(dir);
    const { sweepId } = await store.beginSweep('a', [], []);
    const shot = await store.writeShot(sweepId, '../../escape', encodePng(blankImage(2, 2, [0, 0, 0, 255])));
    expect(shot).toBe('sweeps/0001/shots/..-..-escape.png');
    expect(path.normalize(path.join(dir, EVIDENCE_DIR, shot)).startsWith(path.join(dir, EVIDENCE_DIR))).toBe(true);
  });
});
