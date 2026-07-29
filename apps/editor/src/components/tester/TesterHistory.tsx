/**
 * Every time your tester has played, across every game you have made.
 *
 * This is the feature, not any single session. One playthrough is a bug report;
 * a record of playthroughs is a second opinion with a memory, and the thing it
 * can say that nothing else can is "you have raised the jump three times now".
 *
 * The screen is GLOBAL, and that is the fix it exists to be. A playtest belongs
 * to a game, but the history of playtests belongs to you: it spans every game,
 * it outlives any one session, and this screen used to show only whichever
 * project happened to be open, silently, with a Play button aimed at a game it
 * never named. Reaching yesterday's run meant first guessing which project it
 * had come from, then opening that project, then coming back here. Now every
 * run is on one list wearing its game's mark, and Play says out loud which game
 * it will play.
 *
 * A row opens its own report, in place. It does NOT switch project to do it:
 * reading what your tester said is not a reason to tear down the game you have
 * running. That was the other half of the complaint — three screens deep to
 * read a report for a session you had just watched finish.
 *
 * The rules about what may be claimed live in testerRows.ts, which is pure. All
 * this file does is put them on screen.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../store';
import type { TesterRun } from '../../types';
import { ScreenHeader, screenBackLabel } from '../ui/ScreenHeader';
import { PlayButton } from './TesterStage';
import { ReportView } from './ReportView';
import { ProjectMark } from '../../projects/ProjectMark';
import { ProjectSelector } from '../../projects/ProjectSelector';
import { readableNote, testerRows, TESTER_NEVER_PLAYED_ANYWHERE, type TesterRow } from './testerRows';

/** When it played, in the terms a person thinks in rather than a timestamp. */
export function playedWhen(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'at some point';
  const minutes = Math.round((now - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/**
 * The runs, newest first, each paired with the row built from its own game's
 * history.
 *
 * The pairing is the whole reason this is a function and not a map inline.
 * `testerRows` reads a session against the one BEFORE it — "last time you were
 * told the opposite" — so the comparison has to happen within a single game.
 * Building rows from the mixed list would have session 4 of one game answering
 * session 9 of another, which is the exact kind of confident wrong sentence
 * this feature exists not to produce.
 *
 * Pure, so the grouping rule is checkable without a screen.
 */
export function runRows(runs: readonly TesterRun[]): { run: TesterRun; row: TesterRow }[] {
  const byProject = new Map<string, TesterRun[]>();
  for (const run of runs) {
    const list = byProject.get(run.project.path);
    if (list) list.push(run);
    else byProject.set(run.project.path, [run]);
  }
  // Paired by the RUN, not by its session number. Keying a map by project plus
  // session let two notes numbered 3 in one game overwrite each other: the last
  // one written won, so a session the tester called "worse" and one it called
  // "better" both rendered as whichever came last, under duplicate React keys.
  // That number comes off disk from a folder people are told they may edit, so
  // it is not an identity. A row's `source` is a position in the list this
  // function built, and two runs cannot share one.
  const rowFor = new Map<TesterRun, TesterRow>();
  for (const list of byProject.values()) {
    for (const row of testerRows(list.map((run) => run.note))) {
      const run = list[row.source];
      if (run) rowFor.set(run, row);
    }
  }
  return runs.flatMap((run) => {
    const row = rowFor.get(run);
    return row ? [{ run, row }] : [];
  });
}

/**
 * What this screen says when it has no sessions to show.
 *
 * "Your tester has not played anything yet" is a claim about EVERY game you
 * have, and this screen does not always look at every game: it stops at a
 * project cap, and a folder that has moved cannot be read. When any game went
 * unopened, the honest empty state is about the search rather than about the
 * tester, because "it has never played" is not something an incomplete look can
 * establish.
 */
export function historyEmptyLead(skippedProjects: number): string {
  if (skippedProjects < 1) return TESTER_NEVER_PLAYED_ANYWHERE;
  return skippedProjects === 1
    ? 'No sessions in the games this list could look in, and there was one more it could not open.'
    : `No sessions in the games this list could look in, and there were ${skippedProjects} more it could not open.`;
}

/**
 * What the screen owes the reader about games it never looked in, or null when
 * it looked in all of them.
 *
 * A different sentence from the one about dropped runs, because they are
 * different admissions. That one says "there is more of this game's history
 * than fits here"; this one says "there are games here I did not open at all".
 * A screen whose own first claim is "across every game you have made" cannot
 * leave the second unsaid.
 */
export function skippedProjectsLine(skippedProjects: number): string | null {
  if (skippedProjects < 1) return null;
  return skippedProjects === 1
    ? 'One more game was not looked in, so any session your tester played there is missing from this list.'
    : `${skippedProjects} more games were not looked in, so any session your tester played in them is missing from this list.`;
}

/**
 * One run. The verdict, the game, and when — and the whole row is the button
 * that opens the report, because "let me read that one" is the only thing
 * anyone comes to this list to do.
 */
function RunRow({ run, row }: { run: TesterRun; row: TesterRow }) {
  const [reading, setReading] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // The checked note, not the raw one. The report reads the note directly, so
  // handing it the unchecked version put the one throw this normalisation
  // exists to prevent back into the dialog.
  const note = useMemo(() => readableNote(run.note), [run.note]);

  return (
    <>
      <button ref={trigger} type="button" className="tester-run" onClick={() => setReading(true)}>
        <ProjectMark path={run.project.path} identity={run.project.identity} size={16} className="tester-run-mark" />
        <span className="tester-run-body">
          <span className={`tester-run-verdict tone-${row.tone}`}>{row.headline}</span>
          <span className="tester-run-meta">
            {run.project.name} · Session {row.session}, {playedWhen(row.finishedAt)}
          </span>
        </span>
        <span className="tester-run-open" aria-hidden="true">
          Report
        </span>
      </button>
      {/* Named, because this screen is the one place a report is read away
          from the game it belongs to: it lists every project's sessions, and a
          project may not even be open. Approving is about THIS row's game. */}
      <ReportView
        note={note}
        open={reading}
        onClose={() => setReading(false)}
        returnFocusTo={trigger}
        project={run.project.path}
      />
    </>
  );
}

export function TesterHistory() {
  const closeScreen = useApp((s) => s.closeScreen);
  const projectName = useApp((s) => s.projectName);
  const projectPath = useApp((s) => s.projectPath);
  const refreshTesterRuns = useApp((s) => s.refreshTesterRuns);
  const playTesterIn = useApp((s) => s.playTesterIn);
  const testerRuns = useApp((s) => s.testerRuns);
  const testerTarget = useApp((s) => s.testerTarget);
  const setTesterTarget = useApp((s) => s.setTesterTarget);
  const running = useApp((s) => s.tester.running);
  const starting = useApp((s) => s.tester.starting);

  useEffect(() => {
    void refreshTesterRuns();
  }, [refreshTesterRuns]);

  /**
   * What Play will play. Explicitly the most recently played game rather than
   * the open one: standing on a global screen is not standing in a project,
   * and inheriting whichever folder was last clicked is what made this screen
   * lie about its own aim.
   */
  const aim = testerTarget ?? testerRuns?.runs[0]?.project.path ?? null;
  // What that folder is called, from the history this screen already has. The
  // picker names the current project from a fetch of its own, which answers an
  // empty list when it fails and is capped besides, so it could say "Pick a
  // game" beside a Play button armed and aimed at a real project. The control
  // and the button must never disagree about whether anything is chosen.
  const aimName = testerRuns?.runs.find((run) => run.project.path === aim)?.project.name ?? null;
  const pairs = useMemo(() => runRows(testerRuns?.runs ?? []), [testerRuns]);
  const loaded = testerRuns !== null;
  // How many games this list never opened: past the project cap, or a folder
  // that has gone. The doc comment at the top of this file promises every game
  // you have made, and this is what lets the screen take that back.
  const skippedProjects = testerRuns?.skippedProjects ?? 0;
  const skipped = skippedProjectsLine(skippedProjects);

  return (
    <div className="screen tester-history">
      {/* `back` names the destination, not the gesture — the same rule Skills
          follows, from the same function. It said "Back", which is the one
          thing a way out of a place must never say. */}
      <ScreenHeader
        back={{ label: screenBackLabel(projectName, projectPath), onBack: closeScreen }}
        title="Tester"
        actions={
          <>
            {/* Both on the right, both about the same act: which game, then
                play it. The picker is the same control the composer uses to
                aim a message, because aiming a global act at a project is one
                idea in this app and should look like one. */}
            <ProjectSelector
              value={aim}
              onChange={setTesterTarget}
              allowNew={false}
              emptyLabel="Pick a game"
              valueLabel={aimName}
            />
            <PlayButton
              blocked={
                aim === null
                  ? 'Pick a game for it to play.'
                  : starting
                    ? 'It is waking up. Give it a moment.'
                    : running
                      ? 'It is playing right now.'
                      : null
              }
              label={running ? 'Playing' : 'Play'}
              hint="It opens that game and plays a session now."
              onPlay={() => aim !== null && void playTesterIn(aim)}
            />
          </>
        }
      />

      <div className="screen-body">
        <div className="tester-history-body">
          {pairs.length === 0 ? (
            <div className="tester-history-empty">
              {/* "Not read yet" is not "never played". A screen that says the
                  second while the first is true is a screen that has to take
                  it back a moment later. Neither is "no sessions in the games
                  I looked in" the same as "no sessions", which is why the lead
                  is decided by the same count the caveat below is. */}
              <p className="tester-empty-lead">
                {loaded ? historyEmptyLead(skippedProjects) : 'Looking for past sessions…'}
              </p>
              {loaded && (
                <p className="tester-empty-hint">
                  Pick a game and ask it to play. It will tell you what it made of the game, and from the
                  second session on, whether what you changed since helped.
                </p>
              )}
            </div>
          ) : (
            <>
              <ul className="tester-runs">
                {pairs.map(({ run, row }) => (
                  <li key={`${run.project.path}\u0000${row.source}`}>
                    <RunRow run={run} row={row} />
                  </li>
                ))}
              </ul>
              {/* Said out loud rather than silently truncated: a capped list
                  that looks complete is a list that lies about your history. */}
              {testerRuns !== null && testerRuns.dropped > 0 && (
                <p className="tester-runs-capped">
                  {testerRuns.dropped} older {testerRuns.dropped === 1 ? 'session is' : 'sessions are'} not shown here.
                  Every one of them is still in its own project folder, under{' '}
                  <code className="tester-memory-path">.hearth/tester/sessions</code>.
                </p>
              )}
            </>
          )}
          {/* Outside the branch above, so the same admission is made whether
              the list came back with sessions or with none. Two counts, two
              sentences: one is history that did not fit, the other is games
              nobody opened, and collapsing them would leave the reader unable
              to tell which. */}
          {loaded && skipped !== null && <p className="tester-runs-capped">{skipped}</p>}
        </div>
      </div>
    </div>
  );
}
