/**
 * Tests for the journal file watcher: fs.watch on .hearth/log/ plus a poll
 * fallback, debounced, delivering only newly appended entries (no
 * duplicates, no missed writes between watcher start and the first read).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JournalStore, type JournalEntry } from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import { startJournalWatcher } from '../server/journalWatcher';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const disposers: (() => void)[] = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()!();
});

describe('startJournalWatcher', () => {
  it('delivers appended entries in batches, without duplicates', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-journal-watch-'));
    const fs = new NodeFileSystem();
    const writer = new JournalStore(fs, root);

    const batches: JournalEntry[][] = [];
    const dispose = startJournalWatcher(root, fs, (entries) => batches.push(entries));
    disposers.push(dispose);

    // Give the watcher a moment to install and read its starting seq.
    await wait(50);

    // Two rapid appends should coalesce into a single delivered batch
    // (debounced), not two separate callbacks.
    await writer.append({ ts: new Date().toISOString(), source: 'cli', command: 'createScene', summary: 'A', ok: true });
    await writer.append({ ts: new Date().toISOString(), source: 'cli', command: 'createScene', summary: 'B', ok: true });

    await wait(400);

    const delivered = batches.flat();
    expect(delivered.map((e) => e.summary)).toEqual(['A', 'B']);
    expect(batches.length).toBeGreaterThanOrEqual(1);
    // No duplicates: every seq appears exactly once across all batches.
    const seqs = delivered.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);

    // A further append after the first batch is delivered as new, not
    // re-delivering the earlier entries.
    await writer.append({ ts: new Date().toISOString(), source: 'editor', command: 'createEntity', summary: 'C', ok: true });
    await wait(400);

    const delivered2 = batches.flat();
    expect(delivered2.map((e) => e.summary)).toEqual(['A', 'B', 'C']);

    dispose();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('does not miss an entry written immediately after the watcher starts', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-journal-watch-'));
    const fs = new NodeFileSystem();
    const writer = new JournalStore(fs, root);

    const batches: JournalEntry[][] = [];
    const dispose = startJournalWatcher(root, fs, (entries) => batches.push(entries));
    disposers.push(dispose);

    // No delay here on purpose: append as soon as possible after starting
    // the watcher, to exercise the startup race the watcher must close.
    await writer.append({ ts: new Date().toISOString(), source: 'cli', command: 'createScene', summary: 'fast', ok: true });

    await wait(500);

    const delivered = batches.flat();
    expect(delivered.some((e) => e.summary === 'fast')).toBe(true);

    dispose();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('stops delivering after dispose', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-journal-watch-'));
    const fs = new NodeFileSystem();
    const writer = new JournalStore(fs, root);

    const batches: JournalEntry[][] = [];
    const dispose = startJournalWatcher(root, fs, (entries) => batches.push(entries));
    await wait(50);

    await writer.append({ ts: new Date().toISOString(), source: 'cli', command: 'createScene', summary: 'before', ok: true });
    await wait(400);
    expect(batches.flat().map((e) => e.summary)).toEqual(['before']);

    dispose();

    await writer.append({ ts: new Date().toISOString(), source: 'cli', command: 'createScene', summary: 'after', ok: true });
    await wait(400);
    expect(batches.flat().map((e) => e.summary)).toEqual(['before']);

    await fsp.rm(root, { recursive: true, force: true });
  });
});
