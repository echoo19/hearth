/**
 * Where a project's probe evidence lives on disk.
 *
 * `.hearth/evidence/` is written by whoever played the game: `hearth-probe`
 * from the agent's shell, via probe-core's `NodeEvidenceStore`. The app only
 * ever points at it now, so what is left here is the layout both sides agree
 * on. The static mount serves the folder (projectServer.ts) and the usage
 * read-out counts the sweeps under it (usage.ts).
 *
 * This used to also tail the journal and push new lines at the evidence rail.
 * The rail is gone and playtesting runs out of process, so there is nothing
 * left to follow: a folder full of evidence is read by whoever opens the
 * files, not streamed at a surface waiting for it.
 */
import path from 'node:path';

/** Relative location of the evidence directory and journal within a project. */
export const EVIDENCE_DIR = path.join('.hearth', 'evidence');
export const EVIDENCE_JOURNAL = path.join(EVIDENCE_DIR, 'journal.jsonl');
