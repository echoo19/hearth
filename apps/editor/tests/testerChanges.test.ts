/**
 * What the project recorded happening since the tester last played.
 *
 * The source is the journal and the chat records rather than a git diff, because
 * the tester's verdict is on the change you MEANT to make. A diff shows the
 * lines; the journal carries the intent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changesSince } from '../server/tester/changes';

let root: string;
beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'changes-')); });
afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

async function journal(lines: object[]): Promise<void> {
  const file = path.join(root, '.hearth', 'log', 'commands.jsonl');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n'));
}

describe('changesSince', () => {
  it('says so plainly when nothing has been recorded', async () => {
    expect(await changesSince(root, null)).toMatch(/nothing/i);
  });

  it('keeps only entries newer than the last session', async () => {
    await journal([
      { ts: '2026-01-01T00:00:00.000Z', summary: 'raised the jump' },
      { ts: '2026-01-03T00:00:00.000Z', summary: 'added a second pit' },
    ]);
    const text = await changesSince(root, '2026-01-02T00:00:00.000Z');
    expect(text).toContain('added a second pit');
    expect(text).not.toContain('raised the jump');
  });

  it('takes everything when the tester has never played', async () => {
    await journal([{ ts: '2026-01-01T00:00:00.000Z', summary: 'raised the jump' }]);
    expect(await changesSince(root, null)).toContain('raised the jump');
  });

  it('survives a missing journal', async () => {
    expect(await changesSince(root, null)).toMatch(/nothing/i);
  });

  it('reads what was asked for in chat, not only what the journal logged', async () => {
    // Most of what happens to a game in Hearth happens because someone asked
    // for it in words. A summary built only from journaled commands would miss
    // the half of the record that carries why.
    const file = path.join(root, '.hearth', 'chats', 'abc.jsonl');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(
      file,
      `${JSON.stringify({ role: 'user', ts: '2026-01-03T00:00:00.000Z', text: 'make the jump feel heavier' })}\n`,
    );
    expect(await changesSince(root, '2026-01-02T00:00:00.000Z')).toContain('make the jump feel heavier');
  });

  it('carries the fact that says what actually changed, not just the command name', async () => {
    // "setComponentProperty Level 1" names a command. The property it set is
    // the thing the tester is being asked to have an opinion about.
    await journal([
      {
        ts: '2026-01-03T00:00:00.000Z',
        summary: 'setComponentProperty Level 1',
        ok: true,
        detail: { entity: 'Player', property: 'CharacterController.jumpHeight' },
      },
    ]);
    expect(await changesSince(root, null)).toContain('CharacterController.jumpHeight');
  });

  it('says when a recorded command failed, so its effects are not looked for', async () => {
    await journal([{ ts: '2026-01-03T00:00:00.000Z', summary: 'setComponentProperty x', ok: false }]);
    expect(await changesSince(root, null)).toMatch(/failed/i);
  });

  it('skips lines that will not parse rather than giving up on the file', async () => {
    const file = path.join(root, '.hearth', 'log', 'commands.jsonl');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, `{ broken\n${JSON.stringify({ ts: '2026-01-03T00:00:00.000Z', summary: 'moved the pit' })}\n`);
    expect(await changesSince(root, null)).toContain('moved the pit');
  });
});
