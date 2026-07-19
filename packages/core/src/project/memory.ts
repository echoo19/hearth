/**
 * Agent-managed durable memory: `.hearth/memory.md`. Where the digest holds
 * *state* the engine can derive (see `./digest.ts`), memory holds *intent* the
 * engine can't — decisions made, work still to do, and gotchas already hit — so
 * a new session picks up where the last left off instead of re-experimenting.
 *
 * The engine owns the shape (a fixed set of markdown sections) so `remember`
 * appends stay consistent and the file can't drift into something the agent has
 * to re-parse. It is authored intent, so unlike the digest it is committed, not
 * gitignored.
 */
import type { FsLike } from '../fs.js';
import { joinPath } from '../fs.js';
import { MEMORY_FILE } from '../schema/project.js';

/** The section a note is filed under. */
export type MemorySection = 'note' | 'decision' | 'todo' | 'gotcha';

/** Section key → the markdown `## ` heading it lives under. Order defines the file layout. */
const SECTION_HEADINGS: Record<MemorySection, string> = {
  note: 'Notes',
  decision: 'Decisions',
  todo: 'Todo',
  gotcha: 'Gotchas',
};

/** The empty file written on first use — headings in a stable order, ready to append into. */
export const MEMORY_TEMPLATE = [
  '# Project memory',
  '',
  '_Durable notes that survive across agent sessions — read this at the start of every session._',
  '_Append with `hearth remember "<note>" --section decision|todo|gotcha` (or the `remember` MCP tool)._',
  '',
  '## Decisions',
  '',
  '## Todo',
  '',
  '## Gotchas',
  '',
  '## Notes',
  '',
].join('\n');

function memoryPath(root: string): string {
  return joinPath(root, MEMORY_FILE);
}

/**
 * Append `note` as a bullet under its section, at the end of that section so the
 * order is chronological. Creates the file from `MEMORY_TEMPLATE` if missing,
 * and adds the section heading if a hand-edited file dropped it.
 */
export async function appendMemory(
  fs: FsLike,
  root: string,
  entry: { note: string; section?: MemorySection },
): Promise<void> {
  const section = entry.section ?? 'note';
  const heading = `## ${SECTION_HEADINGS[section]}`;
  const bullet = `- ${entry.note.trim()}`;

  const path = memoryPath(root);
  const existing = (await fs.exists(path)) ? await fs.readFile(path) : MEMORY_TEMPLATE;
  const lines = existing.split('\n');

  const headingIdx = lines.findIndex((l) => l.trim() === heading);
  if (headingIdx === -1) {
    // Section missing (hand-edited file) — append it at the end.
    const trimmed = existing.replace(/\n+$/, '');
    const next = `${trimmed}\n\n${heading}\n\n${bullet}\n`;
    await ensureDirAndWrite(fs, root, path, next);
    return;
  }

  // Find the end of this section: the next `## ` heading, or end of file.
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }
  // Insert after the last non-blank line of the section (keeps bullets grouped,
  // no accumulating blank lines).
  let insertAt = headingIdx + 1;
  for (let i = headingIdx + 1; i < end; i++) {
    if (lines[i].trim() !== '') insertAt = i + 1;
  }
  lines.splice(insertAt, 0, bullet);
  await ensureDirAndWrite(fs, root, path, lines.join('\n'));
}

/** Read the memory file, or the empty template if it doesn't exist yet. */
export async function readMemory(fs: FsLike, root: string): Promise<string> {
  const path = memoryPath(root);
  return (await fs.exists(path)) ? fs.readFile(path) : MEMORY_TEMPLATE;
}

async function ensureDirAndWrite(fs: FsLike, root: string, path: string, content: string): Promise<void> {
  await fs.mkdir(joinPath(root, '.hearth'));
  await fs.writeFile(path, content.endsWith('\n') ? content : content + '\n');
}
