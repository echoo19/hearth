import { z } from 'zod';
import { defineCommand } from './types.js';
import { appendMemory, readMemory } from '../project/memory.js';

/**
 * Record a durable note into `.hearth/memory.md`. Not a project mutation
 * (mutates:false): memory is agent intent, not scene data, so it must stay out
 * of the undo history and the structural diff. It writes the memory file
 * directly. Requires `safe-edit` — the same grant a default agent session
 * carries — so a locked-down read-only inspection session can't write notes.
 */
export const rememberNote = defineCommand({
  name: 'rememberNote',
  description:
    'Record a durable note in project memory (.hearth/memory.md) that survives across sessions: a decision, a todo, or a ' +
    'gotcha already hit. Read it back at the start of a session with recallNotes so you never re-derive intent or repeat a ' +
    'failed approach.',
  permission: 'safe-edit',
  mutates: false,
  paramsSchema: z.object({
    note: z.string().min(1),
    section: z.enum(['note', 'decision', 'todo', 'gotcha']).default('note'),
  }),
  async run(ctx, params) {
    await appendMemory(ctx.fs, ctx.store.root, { note: params.note, section: params.section });
    return { section: params.section, note: params.note };
  },
});

/** Read all durable memory back. Read-only; returns the raw markdown for the agent to read. */
export const recallNotes = defineCommand({
  name: 'recallNotes',
  description:
    'Read the project memory (.hearth/memory.md) — the durable decisions, todos, and gotchas recorded across sessions. ' +
    'Do this at the start of a session before re-inspecting or re-deciding.',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({}),
  async run(ctx) {
    const memory = await readMemory(ctx.fs, ctx.store.root);
    return { memory };
  },
});
