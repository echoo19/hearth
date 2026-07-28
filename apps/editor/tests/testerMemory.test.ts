/**
 * The tester's memory on disk.
 *
 * Two rules here are the product rather than the plumbing. Sessions are
 * append-only, because a tester that could revise what it used to think could
 * never be caught contradicting itself and being caught is the point. And one
 * unreadable note must not take the history down with it: a person can hand-edit
 * this folder, so a broken file is a thing that happens.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMemory, writeMemory, listSessions, nextSessionId, writeNote } from '../server/tester/memory';

let root: string;
beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tester-')); });
afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

const note = (session: number) => ({
  session, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:05:00.000Z',
  onTheChange: { seen: 'the jump is higher', verdict: 'better' as const, why: 'I cleared the gap' },
  regression: 'nothing', observations: [{ frame: 3, text: 'fell in the pit' }],
  openQuestions: ['what is the red thing'], steps: 40, stopped: 'done' as const,
});

describe('tester memory', () => {
  it('reads an empty string for a project that has never been tested', async () => {
    expect(await readMemory(root)).toBe('');
  });

  it('numbers the first session 1 and counts up', async () => {
    expect(await nextSessionId(root)).toBe(1);
    await writeNote(root, note(1));
    expect(await nextSessionId(root)).toBe(2);
  });

  it('round-trips memory as text a person could hand-edit', async () => {
    await writeMemory(root, '# What I know\n\nSpace jumps.\n');
    expect(await readMemory(root)).toBe('# What I know\n\nSpace jumps.\n');
  });

  it('lists sessions oldest first so the history reads as a history', async () => {
    await writeNote(root, note(2));
    await writeNote(root, note(1));
    expect((await listSessions(root)).map((n) => n.session)).toEqual([1, 2]);
  });

  it('refuses to overwrite a session that already exists', async () => {
    // The verdict history is the product. A tester that could revise what it
    // used to think could never be caught contradicting itself.
    await writeNote(root, note(1));
    await expect(writeNote(root, note(1))).rejects.toThrow(/already/i);
  });

  it('skips an unreadable note rather than failing the whole history', async () => {
    await writeNote(root, note(1));
    await fsp.mkdir(path.join(root, '.hearth', 'tester', 'sessions', '0002'), { recursive: true });
    await fsp.writeFile(path.join(root, '.hearth', 'tester', 'sessions', '0002', 'note.json'), '{ broken');
    expect((await listSessions(root)).map((n) => n.session)).toEqual([1]);
  });
});
