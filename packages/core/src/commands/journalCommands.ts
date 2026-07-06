import { z } from 'zod';
import { defineCommand } from './types.js';
import { JournalStore } from '../project/journal.js';

export const listJournal = defineCommand({
  name: 'listJournal',
  description:
    'List recorded command journal entries (see .hearth/log/commands.jsonl), oldest first. Unlike listHistory, this includes read-only and failed commands and is never rewound by undo/redo.',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({
    since: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(500).default(50),
  }),
  async run(ctx, params) {
    const journal = new JournalStore(ctx.fs, ctx.store.root);
    const [entries, lastSeq] = await Promise.all([
      journal.read({ since: params.since, limit: params.limit }),
      journal.lastSeq(),
    ]);
    return { entries, lastSeq };
  },
});
