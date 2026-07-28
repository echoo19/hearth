/**
 * Every time your tester has played, and what it thought each time.
 *
 * This is the feature, not any single session. One playthrough is a bug report;
 * a record of playthroughs is a second opinion with a memory, and the thing it
 * can say that nothing else can is "you have raised the jump three times now".
 *
 * The newest verdict leads because it is the answer to the question the person
 * came here with: did my last change help. Underneath it, in order, is every
 * verdict before it, unedited. Sessions are never rewritten, so a tester that
 * changes its mind can be caught doing it, and that is the point.
 *
 * The rules about what may be claimed live in testerRows.ts, which is pure. All
 * this file does is put them on screen.
 */
import React, { useEffect } from 'react';
import { useApp } from '../../store';
import { Button } from '../ui/Button';
import { ScreenHeader } from '../ui/ScreenHeader';
import { testerRows, TESTER_NEVER_PLAYED, type TesterRow } from './testerRows';

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

function Session({ row, lead }: { row: TesterRow; lead: boolean }) {
  return (
    <article className={`tester-session${lead ? ' is-lead' : ''}`}>
      <div className="tester-session-head">
        <h2 className={`tester-verdict tone-${row.tone}`}>{row.headline}</h2>
        <span className="tester-session-when">
          Session {row.session}, {playedWhen(row.finishedAt)}
        </span>
      </div>

      <p className="tester-said">
        <span className="tester-said-label">What it thought you changed</span>
        {row.seen}
      </p>
      <p className="tester-said">
        <span className="tester-said-label">Why it says that</span>
        {row.why}
      </p>

      {/* Always here, in every state. A regression line that only appeared when
          something was wrong would make its absence mean nothing at all. */}
      <p className={`tester-said${row.regressionAnswered ? '' : ' is-unanswered'}`}>
        <span className="tester-said-label">Anything worse</span>
        {row.regression}
      </p>

      {row.observations.length > 0 && (
        <div className="tester-said">
          <span className="tester-said-label">What it saw</span>
          <ul className="tester-saw">
            {row.observations.map((observation) => (
              <li key={`${observation.frame}-${observation.text}`} className="tester-saw-row">
                <span className="tester-saw-frame">Picture {observation.frame}</span>
                <span>{observation.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {row.openQuestions.length > 0 && (
        <div className="tester-said">
          <span className="tester-said-label">Still could not work out</span>
          <ul className="tester-saw">
            {row.openQuestions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="tester-session-foot">
        {row.ending}
        {/* The previous verdict, carried on the row rather than left for the
            reader to scroll for. A tester that quietly contradicts itself is
            the failure this whole surface is built to make visible. */}
        {row.previously && <span className="tester-previously">Last time: {row.previously}</span>}
        {row.reversal && <span className="tester-reversal">{row.reversal}</span>}
      </p>
    </article>
  );
}

export function TesterHistory() {
  const projectName = useApp((s) => s.projectName);
  const closeScreen = useApp((s) => s.closeScreen);
  const tester = useApp((s) => s.tester);
  const refreshTesterHistory = useApp((s) => s.refreshTesterHistory);
  const playTester = useApp((s) => s.playTester);
  const gamePresent = useApp((s) => s.game.present);

  useEffect(() => {
    void refreshTesterHistory();
  }, [refreshTesterHistory]);

  const rows = testerRows(tester.sessions);

  return (
    <div className="screen tester-history">
      <ScreenHeader
        back={{ label: projectName ?? 'Chats', onBack: closeScreen }}
        title="Tester"
        actions={
          <Button
            variant="primary"
            icon="play"
            onClick={() => void playTester()}
            disabled={!gamePresent || tester.running || tester.starting}
          >
            {tester.running ? 'Playing' : 'Play'}
          </Button>
        }
      />

      <div className="screen-body">
        <div className="tester-history-body">
          {rows.length === 0 ? (
            <div className="tester-history-empty">
              <p className="tester-empty-lead">{TESTER_NEVER_PLAYED}</p>
              <p className="tester-empty-hint">
                Ask it to play and it will tell you what it made of your game. From the second
                session on, it tells you whether what you changed since helped.
              </p>
            </div>
          ) : (
            <>
              {rows.map((row, index) => (
                <Session key={row.session} row={row} lead={index === 0} />
              ))}

              {/* Its own words about your game, and the one part of all this a
                  person is meant to edit. A memory you cannot correct is one
                  you stop listening to. */}
              {tester.memory.trim() !== '' && (
                <section className="tester-memory">
                  <h2 className="tester-memory-title">What it remembers about this game</h2>
                  <p className="tester-memory-note">
                    Its own notes, kept in your project folder. Open
                    <code className="tester-memory-path">.hearth/tester/memory.md</code>
                    and correct anything it has wrong.
                  </p>
                  <div className="tester-memory-body">{tester.memory.trim()}</div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
