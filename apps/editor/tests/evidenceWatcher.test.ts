/**
 * The evidence journal follower. The file is normally absent (a folder that
 * has never been playtested has no evidence), so "missing" must be the quiet
 * normal case, and appended lines must be delivered exactly once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EVIDENCE_JOURNAL, parseEvidenceLines, startEvidenceWatcher, type EvidenceEvent } from '../server/evidenceWatcher';

describe('parseEvidenceLines', () => {
  it('parses whole lines and skips blanks', () => {
    const text = '{"kind":"note","seq":1,"ts":"t1","text":"a"}\n\n{"kind":"note","seq":2,"ts":"t2"}\n';
    expect(parseEvidenceLines(text, 0).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('skips a half-written trailing line instead of throwing', () => {
    const text = '{"kind":"note","seq":1,"ts":"t1"}\n{"kind":"no';
    expect(parseEvidenceLines(text, 0)).toHaveLength(1);
  });

  it('skips lines missing the fields the feed is keyed on', () => {
    const text = '{"seq":1}\n{"kind":"note"}\n[1,2,3]\n"a string"\n';
    expect(parseEvidenceLines(text, 0)).toHaveLength(0);
  });

  it('returns only what is newer than the given seq, in order', () => {
    const text = [3, 1, 2].map((seq) => JSON.stringify({ kind: 'note', seq, ts: `t${seq}` })).join('\n');
    expect(parseEvidenceLines(text, 1).map((e) => e.seq)).toEqual([2, 3]);
  });

  it('supplies a timestamp when the writer omitted one', () => {
    const events = parseEvidenceLines('{"kind":"note","seq":1}', 0);
    expect(typeof events[0].ts).toBe('string');
    expect(events[0].ts.length).toBeGreaterThan(0);
  });
});

describe('startEvidenceWatcher', () => {
  let dir: string;
  let dispose: (() => void) | null = null;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-evidence-'));
  });

  afterEach(async () => {
    dispose?.();
    dispose = null;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('timed out waiting for evidence');
  }

  it('delivers nothing for a folder that has never been playtested', async () => {
    const batches: EvidenceEvent[][] = [];
    dispose = startEvidenceWatcher(dir, (events) => batches.push(events));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(batches).toHaveLength(0);
  });

  it('delivers appended events, each exactly once', async () => {
    const seen: EvidenceEvent[] = [];
    dispose = startEvidenceWatcher(dir, (events) => seen.push(...events));
    const journal = path.join(dir, EVIDENCE_JOURNAL);
    await fsp.mkdir(path.dirname(journal), { recursive: true });

    await fsp.appendFile(journal, JSON.stringify({ kind: 'sweep-started', seq: 1, ts: 't1', sweepId: '0001' }) + '\n');
    await waitFor(() => seen.length >= 1);

    await fsp.appendFile(journal, JSON.stringify({ kind: 'run-finished', seq: 2, ts: 't2', verdict: 'ran-clean' }) + '\n');
    await waitFor(() => seen.length >= 2);

    expect(seen.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('stops delivering after dispose', async () => {
    const seen: EvidenceEvent[] = [];
    const stop = startEvidenceWatcher(dir, (events) => seen.push(...events));
    stop();
    stop(); // idempotent
    const journal = path.join(dir, EVIDENCE_JOURNAL);
    await fsp.mkdir(path.dirname(journal), { recursive: true });
    await fsp.appendFile(journal, JSON.stringify({ kind: 'note', seq: 1, ts: 't1' }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen).toHaveLength(0);
  });
});
