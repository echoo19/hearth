/**
 * The `rememberNote` / `recallNotes` commands: the agent-facing surface over
 * `.hearth/memory.md`. `remember` appends a durable note; `recall` reads them
 * all back. Memory is not project data, so these must not touch the undo history
 * or the structural diff.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession } from '../src/index.js';
import { MEMORY_FILE } from '../src/schema/project.js';

async function session(granted?: Parameters<typeof HearthSession.fromStore>[1] extends { granted?: infer G } ? G : never) {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test' });
  return { fs, store, session: HearthSession.fromStore(store, granted ? { granted } : {}) };
}

describe('rememberNote / recallNotes commands', () => {
  it('remembers a note and recalls it', async () => {
    const { session: s } = await session();
    const wrote = await s.execute('rememberNote', { note: 'Use Kenney tiles', section: 'decision' });
    expect(wrote.success).toBe(true);

    const recalled = await s.execute<{ memory: string }>('recallNotes', {});
    expect(recalled.success).toBe(true);
    expect(recalled.data!.memory).toContain('Use Kenney tiles');
    expect(recalled.data!.memory).toContain('## Decisions');
  });

  it('writes to the memory file, not the project model (no history entry)', async () => {
    const { fs, session: s } = await session();
    await s.execute('rememberNote', { note: 'no undo for me', section: 'todo' });
    // The note is in the memory file...
    expect(await fs.readFile(`/proj/${MEMORY_FILE}`)).toContain('no undo for me');
    // ...but recording it did not push an undo-history entry.
    const history = await s.execute<{ entries: unknown[] }>('listHistory', {});
    expect(history.data!.entries.length).toBe(0);
  });

  it('recall is available under a read-only grant', async () => {
    const { session: s } = await session(['read-only']);
    const recalled = await s.execute('recallNotes', {});
    expect(recalled.success).toBe(true);
  });

  it('remember requires an edit grant (blocked in a read-only-only session)', async () => {
    const { session: s } = await session(['read-only']);
    const res = await s.execute('rememberNote', { note: 'x', section: 'note' });
    expect(res.success).toBe(false);
    expect(res.errors[0].code).toBe('PERMISSION_DENIED');
  });
});
