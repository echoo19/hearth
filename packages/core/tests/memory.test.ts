/**
 * Agent-managed durable memory (`.hearth/memory.md`): decisions, todos, and
 * gotchas that survive across sessions so the agent doesn't re-derive intent or
 * repeat a failed approach. The engine owns the file format (a fixed set of
 * markdown sections) so appends stay consistent and the agent can't corrupt it.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem } from '../src/fs.js';
import { appendMemory, readMemory, MEMORY_TEMPLATE } from '../src/project/memory.js';
import { MEMORY_FILE } from '../src/schema/project.js';

const ROOT = '/proj';

describe('memory', () => {
  it('creates the file from the template on first append', async () => {
    const fs = new MemoryFileSystem();
    await appendMemory(fs, ROOT, { note: 'Chose Lua for all scripts', section: 'decision' });
    const md = await fs.readFile(`${ROOT}/${MEMORY_FILE}`);
    expect(md).toContain('# Project memory');
    expect(md).toContain('## Decisions');
    expect(md).toContain('Chose Lua for all scripts');
  });

  it('files a note under the requested section', async () => {
    const fs = new MemoryFileSystem();
    await appendMemory(fs, ROOT, { note: 'Coin flash reads as a bug at >0.2s', section: 'gotcha' });
    const md = await fs.readFile(`${ROOT}/${MEMORY_FILE}`);
    const gotchas = md.slice(md.indexOf('## Gotchas'));
    expect(gotchas).toContain('Coin flash reads as a bug at >0.2s');
  });

  it('appends within a section, preserving earlier notes (chronological)', async () => {
    const fs = new MemoryFileSystem();
    await appendMemory(fs, ROOT, { note: 'first', section: 'todo' });
    await appendMemory(fs, ROOT, { note: 'second', section: 'todo' });
    const md = await fs.readFile(`${ROOT}/${MEMORY_FILE}`);
    expect(md.indexOf('first')).toBeGreaterThan(-1);
    expect(md.indexOf('second')).toBeGreaterThan(md.indexOf('first'));
    // A note lands in its own section, not another.
    const todo = md.slice(md.indexOf('## Todo'), md.indexOf('## Gotchas'));
    expect(todo).toContain('first');
    expect(todo).toContain('second');
  });

  it('defaults to the Notes section', async () => {
    const fs = new MemoryFileSystem();
    await appendMemory(fs, ROOT, { note: 'general observation' });
    const md = await fs.readFile(`${ROOT}/${MEMORY_FILE}`);
    const notes = md.slice(md.indexOf('## Notes'));
    expect(notes).toContain('general observation');
  });

  it('readMemory returns the empty template when nothing has been written', async () => {
    const fs = new MemoryFileSystem();
    const md = await readMemory(fs, ROOT);
    expect(md).toContain('# Project memory');
    expect(md).toBe(MEMORY_TEMPLATE);
  });

  it('readMemory returns written content', async () => {
    const fs = new MemoryFileSystem();
    await appendMemory(fs, ROOT, { note: 'persisted', section: 'decision' });
    const md = await readMemory(fs, ROOT);
    expect(md).toContain('persisted');
  });
});
