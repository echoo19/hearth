/**
 * Playtests belong to the folder, not to the window that happened to be open
 * when they ran.
 *
 * The bug these pin: the evidence rail was filled only by the live socket, and
 * the watcher behind that socket replays the journal for whoever STARTS it.
 * A second window on the same folder, or a socket reconnecting while another
 * one still held the channel open, joined a watcher that had already delivered
 * its history and so showed "No playtests yet" for a folder full of them.
 *
 * The fix reads the journal on open, which means the same events now arrive
 * twice by design. Everything below is about that overlap being harmless: the
 * rail must not double a sweep, and the Playtest button's progress must not
 * count a sweep that finished before this window existed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeEvidence, unseenEvidence, applySweepProgress } from '../src/store';
import { readEvidenceHistory, EVIDENCE_JOURNAL } from '../server/evidenceWatcher';
import type { EvidenceEvent } from '../src/types';

function event(seq: number, kind: string, extra: Record<string, unknown> = {}): EvidenceEvent {
  return { seq, kind, ts: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`, ...extra } as EvidenceEvent;
}

describe('mergeEvidence', () => {
  it('keeps one copy of an event delivered twice', () => {
    const history = [event(1, 'sweep-started'), event(2, 'run-finished')];
    const replay = [event(1, 'sweep-started'), event(2, 'run-finished'), event(3, 'sweep-finished')];
    expect(mergeEvidence(history, replay).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('orders by seq, not by arrival', () => {
    // The socket can deliver a live event before the history request that was
    // already in flight comes back.
    const live = [event(9, 'run-finished')];
    const late = [event(4, 'sweep-started'), event(5, 'run-finished')];
    expect(mergeEvidence(live, late).map((e) => e.seq)).toEqual([4, 5, 9]);
  });

  it('lets a re-read event win over the one already held', () => {
    // The file is the record. A line the watcher delivered half-written and
    // the history read whole must end up as the whole one.
    const merged = mergeEvidence([event(1, 'note', { text: 'partial' })], [event(1, 'note', { text: 'whole' })]);
    expect(merged).toHaveLength(1);
    expect((merged[0] as { text: string }).text).toBe('whole');
  });

  it('holds the newest 400 and drops the older end', () => {
    const many = Array.from({ length: 500 }, (_, i) => event(i + 1, 'note'));
    const merged = mergeEvidence([], many);
    expect(merged).toHaveLength(400);
    expect(merged[0].seq).toBe(101);
    expect(merged[399].seq).toBe(500);
  });

  it('returns what it was given when nothing arrives', () => {
    const current = [event(1, 'note')];
    expect(mergeEvidence(current, [])).toBe(current);
  });
});

describe('unseenEvidence', () => {
  it('drops what is already held', () => {
    const held = [event(1, 'sweep-started'), event(2, 'run-finished')];
    const batch = [event(1, 'sweep-started'), event(2, 'run-finished'), event(3, 'run-finished')];
    expect(unseenEvidence(held, batch).map((e) => e.seq)).toEqual([3]);
  });

  it('passes everything through on an empty store', () => {
    const batch = [event(1, 'sweep-started')];
    expect(unseenEvidence([], batch)).toEqual(batch);
  });

  it('keeps a replayed sweep from running the progress counter', () => {
    // The whole point. History is read on open, then the socket replays the
    // same lines. Counting them again would walk the Playtest button through a
    // sweep that finished before this window opened.
    const history = [
      event(1, 'sweep-started', { policies: ['mash', 'seek'], seeds: [1, 2] }),
      event(2, 'run-finished'),
      event(3, 'run-finished'),
      event(4, 'sweep-finished'),
    ];
    const idle = { running: false, done: 0, total: null, error: null };
    const after = applySweepProgress(idle, unseenEvidence(history, history));
    expect(after).toEqual(idle);
  });

  it('still counts a run that arrives while the window watches', () => {
    const history = [event(1, 'sweep-started', { policies: ['mash'], seeds: [1, 2] })];
    const live = [event(1, 'sweep-started', { policies: ['mash'], seeds: [1, 2] }), event(2, 'run-finished')];
    const started = applySweepProgress({ running: false, done: 0, total: null, error: null }, history);
    const after = applySweepProgress(started, unseenEvidence(history, live));
    expect(after.done).toBe(1);
    expect(after.running).toBe(true);
  });
});

describe('readEvidenceHistory', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-evidence-'));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function writeJournal(lines: string[]): Promise<void> {
    const file = path.join(root, EVIDENCE_JOURNAL);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, lines.join('\n'), 'utf8');
  }

  it('reads a folder that has never been played as empty, not as an error', async () => {
    expect(await readEvidenceHistory(root, 100)).toEqual([]);
  });

  it('returns every event in the journal, oldest first', async () => {
    await writeJournal([
      JSON.stringify(event(2, 'run-finished')),
      JSON.stringify(event(1, 'sweep-started')),
      JSON.stringify(event(3, 'sweep-finished')),
    ]);
    expect((await readEvidenceHistory(root, 100)).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('skips a half-written trailing line rather than failing the whole read', async () => {
    // The probe appends while this reads; the next poll picks the line up whole.
    await writeJournal([JSON.stringify(event(1, 'sweep-started')), '{"seq":2,"kind":"run-fin']);
    expect((await readEvidenceHistory(root, 100)).map((e) => e.seq)).toEqual([1]);
  });

  it('hands back the newest events when the journal is longer than the cap', async () => {
    await writeJournal(Array.from({ length: 50 }, (_, i) => JSON.stringify(event(i + 1, 'note'))));
    const events = await readEvidenceHistory(root, 10);
    expect(events).toHaveLength(10);
    expect(events[0].seq).toBe(41);
    expect(events[9].seq).toBe(50);
  });
});
