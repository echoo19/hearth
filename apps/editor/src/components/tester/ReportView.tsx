/**
 * One session, read in full.
 *
 * The history answers the question a person arrives with: did my last change
 * help. This is for the next question, which is what actually happened, and it
 * is longer because the answer is.
 *
 * The rules it has to hold to are not styling. A claim about somewhere the game
 * put the tester says so on the claim, not in a note underneath, and the
 * sentence about what that does to a finding sits above the list rather than
 * below it, where it would arrive after the reader had already believed
 * something. Both come from `report.ts`, which is where they are tested.
 */
import React, { useEffect, useRef } from 'react';
import {
  anythingPlaced,
  endingSentence,
  placementSentence,
  regressionSentence,
  verdictSentence,
  REACHABILITY_CAVEAT,
} from '../../../server/tester/report';
import { observationReach, type TesterNote } from '../../../server/tester/types';
import { Modal } from '../ui';
import { PlanOfAction } from './PlanOfAction';

export function ReportView({
  note,
  open,
  onClose,
  returnFocusTo,
}: {
  note: TesterNote;
  open: boolean;
  onClose: () => void;
  /** Where focus goes when this closes. The control that opened it. */
  returnFocusTo?: React.RefObject<HTMLElement | null>;
}) {
  const wasOpen = useRef(false);
  useEffect(() => {
    // A dialog returns focus on its own in a browser. Doing it here as well
    // covers the close paths that are not the dialog's (a button in the body,
    // the session being swapped out from under it).
    if (wasOpen.current && !open) returnFocusTo?.current?.focus();
    wasOpen.current = open;
  }, [open, returnFocusTo]);

  const observations = note.observations ?? [];
  const questions = note.openQuestions ?? [];
  const regression = regressionSentence(note.regression);
  const placement = placementSentence(note);

  return (
    <Modal open={open} title={`Session ${note.session}`} className="is-wide report-modal" onClose={onClose}>
      {/* A tab stop, because this element is the scroller and a scroller nobody
          can focus cannot be scrolled from a keyboard. Both of the real
          sessions in a new project have no plan of action, which leaves the
          close button as the only focusable thing in the dialog, and it sits
          outside this box: PageDown did nothing and scrollTop stayed at 0 for
          the entire report. `role` and the label are what stop a bare tab stop
          arriving as an unnamed group in a screen reader. */}
      <div className="report" tabIndex={0} role="region" aria-label={`Session ${note.session} report`}>
        <p className="report-ending">{endingSentence(note)}</p>

        <section className="report-part">
          <h3 className="report-part-title">On your last change</h3>
          <p className="report-line">{verdictSentence(note)}</p>
        </section>

        <section className="report-part">
          <h3 className="report-part-title">Anything worse</h3>
          <p className={`report-line${regression.answered ? '' : ' is-unanswered'}`}>{regression.text}</p>
        </section>

        {/* Absent only for a session played before a game could name anywhere.
            A game that names nothing still gets its sentence, because a
            capability nobody mentions looks like one the report forgot. */}
        {placement !== null && (
          <section className="report-part">
            <h3 className="report-part-title">Where it played</h3>
            <p className="report-line">{placement}</p>
          </section>
        )}

        <section className="report-part">
          <h3 className="report-part-title">What it saw</h3>
          {observations.length === 0 ? (
            <p className="report-line">It did not write down anything it saw this session.</p>
          ) : (
            <>
              {/* Above the list, in full-strength ink. A reader who meets this
                  after the claims has already believed them. */}
              {anythingPlaced(note) && <p className="report-caveat">{REACHABILITY_CAVEAT}</p>}
              <ul className="tester-saw">
                {observations.map((observation) => (
                  <li key={`${observation.frame}-${observation.text}`} className="tester-saw-row">
                    <span className="tester-saw-frame">
                      Picture {observation.frame}
                      {observationReach(observation) === 'placed' && (
                        <span className="tester-saw-placed">placed here</span>
                      )}
                    </span>
                    <span>{observation.text}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="report-part">
          <h3 className="report-part-title">Still could not work out</h3>
          {questions.length === 0 ? (
            <p className="report-line">Nothing it wanted to raise.</p>
          ) : (
            <ul className="tester-saw">
              {questions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          )}
        </section>

        {/* Last, because it is what the reader does about everything above it.
            Putting a decision before its evidence is asking for a guess. */}
        <PlanOfAction note={note} onStarted={onClose} />
      </div>
    </Modal>
  );
}
