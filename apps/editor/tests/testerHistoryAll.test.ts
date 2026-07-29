/**
 * Every recent playtest across every game.
 *
 * A playtest belongs to a game; the history of playtests belongs to the person.
 * So this route takes no `project` and reads the server's own recents list, the
 * way skills and usage do. That is also what makes it safe without an
 * `isOpenRoot` gate: the caller supplies no path at all, so there is nothing
 * here to point somewhere it should not go. This file pins that, and pins the
 * two ways a global read like this goes wrong: one deleted game taking the
 * whole screen down, and a capped list that looks complete.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProjectServerContext,
  MAX_HISTORY_RUNS,
  type ProjectServerContext,
} from '../server/projectServer';

let tmp: string;
let ctx: ProjectServerContext;
let recentsFile: string;

/** A project folder with `sessions` playtests already in it. */
async function makeProject(name: string, sessions: { session: number; finishedAt: string }[]): Promise<string> {
  const root = path.join(tmp, name);
  const dir = path.join(root, '.hearth', 'tester', 'sessions');
  await fsp.mkdir(dir, { recursive: true });
  for (const { session, finishedAt } of sessions) {
    const sessionDir = path.join(dir, String(session).padStart(4, '0'));
    await fsp.mkdir(sessionDir, { recursive: true });
    await fsp.writeFile(
      path.join(sessionDir, 'note.json'),
      JSON.stringify({
        session,
        startedAt: '2026-07-27T10:00:00.000Z',
        finishedAt,
        onTheChange: { seen: 'you changed the jump', verdict: 'better', why: 'it reads that way' },
        regression: 'nothing',
        observations: [],
        openQuestions: [],
        steps: 4,
        stopped: 'done',
      }),
    );
  }
  return root;
}

/** Put projects on the recents list, newest first, without opening them. */
async function remember(...roots: string[]): Promise<void> {
  await fsp.writeFile(
    recentsFile,
    JSON.stringify(roots.map((root) => ({ path: root, name: path.basename(root) }))),
  );
}

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-history-'));
  recentsFile = path.join(tmp, 'recent.json');
  ctx = createProjectServerContext({ recentsFile, repoRoot: tmp });
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('the global playtest history', () => {
  it('spans every game, newest first, each run saying which game it is', async () => {
    const lighthouse = await makeProject('lighthouse', [
      { session: 1, finishedAt: '2026-07-28T02:00:00.000Z' },
      { session: 2, finishedAt: '2026-07-28T06:00:00.000Z' },
    ]);
    const harbour = await makeProject('harbour', [{ session: 1, finishedAt: '2026-07-28T04:00:00.000Z' }]);
    await remember(lighthouse, harbour);

    const result = await ctx.testerHistoryAll();

    expect(result.status).toBe(200);
    const runs = (result.body as { runs: { note: { session: number }; project: { name: string } }[] }).runs;
    expect(runs.map((run) => `${run.project.name}/${run.note.session}`)).toEqual([
      'lighthouse/2',
      'harbour/1',
      'lighthouse/1',
    ]);
  });

  it('needs nothing open, which is the whole point of a global screen', async () => {
    const lighthouse = await makeProject('lighthouse', [{ session: 1, finishedAt: '2026-07-28T02:00:00.000Z' }]);
    await remember(lighthouse);
    // No `openWorkspace`. Reaching yesterday's run must not require first
    // guessing which project it came from and opening that project.
    const result = await ctx.testerHistoryAll();
    expect((result.body as { runs: unknown[] }).runs).toHaveLength(1);
  });

  it('skips a game whose folder has gone rather than failing the whole read', async () => {
    const lighthouse = await makeProject('lighthouse', [{ session: 1, finishedAt: '2026-07-28T02:00:00.000Z' }]);
    await remember(lighthouse, path.join(tmp, 'deleted-last-week'));

    const result = await ctx.testerHistoryAll();

    expect(result.status).toBe(200);
    expect((result.body as { runs: unknown[] }).runs).toHaveLength(1);
  });

  it('answers with nothing at all when nothing has ever played', async () => {
    const empty = path.join(tmp, 'brand-new');
    await fsp.mkdir(empty, { recursive: true });
    await remember(empty);

    const result = await ctx.testerHistoryAll();

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, runs: [], dropped: 0 });
  });

  it('says how many it left out, so a capped list cannot read as a complete one', async () => {
    const many = Array.from({ length: MAX_HISTORY_RUNS + 5 }, (_unused, index) => ({
      session: index + 1,
      finishedAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
    }));
    const busy = await makeProject('busy', many);
    await remember(busy);

    const result = await ctx.testerHistoryAll();
    const body = result.body as { runs: unknown[]; dropped: number };

    expect(body.runs).toHaveLength(MAX_HISTORY_RUNS);
    expect(body.dropped).toBe(5);
  });
});
