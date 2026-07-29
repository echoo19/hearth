/**
 * The plan of action, and the moment work is handed to an agent.
 *
 * Everything above this in the report is the tester talking. This is the one
 * part where the person answers, so it is built as a decision rather than a
 * summary: nothing arrives ticked, the button will not fire until something
 * is, and the claim being ticked carries its own caveats on its own row. A
 * reader who has to scroll back up to find out how much a claim is worth is
 * being asked to decide on trust.
 *
 * The two kinds are kept apart because they are not the same claim. It watched
 * the crash; it did not watch the jump being unfair, and it cannot judge fun
 * at all. Dressing the weaker one up as the stronger is the failure this
 * surface exists to prevent, so the headings say which is which in words and
 * the ink does the same at a glance.
 *
 * A session with nothing worth changing renders as a sentence and offers no
 * button. That is a legitimate and frequently correct result, and a tester
 * whose plan is never empty will start inventing work.
 */
import React, { useMemo, useState } from 'react';
import {
  droppedSentence,
  picturesFor,
  planFrom,
  PLACED_CLAIM,
  PLAN_BUGS,
  PLAN_PREFERENCES,
  type Proposal,
} from '../../../server/tester/report';
import type { TesterNote } from '../../../server/tester/types';
import { useApp } from '../../store';
import { Button } from '../ui/Button';

function Row({
  proposal,
  ticked,
  onToggle,
}: {
  proposal: Proposal;
  ticked: boolean;
  onToggle: (id: string, ticked: boolean) => void;
}) {
  return (
    <li className="plan-row">
      <label className="plan-pick">
        <input
          type="checkbox"
          checked={ticked}
          onChange={(event) => onToggle(proposal.id, event.target.checked)}
        />
        <span className="plan-frames">{picturesFor(proposal.evidence)}</span>
        <span className="plan-claim">
          {proposal.text}
          {/* On the row, where the decision is being made. A caveat further up
              the page arrives after the reader has already believed this. */}
          {proposal.reached === 'placed' && <span className="plan-placed">{PLACED_CLAIM}</span>}
        </span>
      </label>
    </li>
  );
}

export function PlanOfAction({ note, onStarted }: { note: TesterNote; onStarted: () => void }) {
  const approveProposals = useApp((s) => s.approveProposals);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [starting, setStarting] = useState(false);
  // Shown here rather than only raised as a toast. The failure happens on this
  // surface, so this is where the person is looking when it happens, and a
  // toast host that is not mounted is a message nobody ever sees.
  const [failed, setFailed] = useState<string | null>(null);

  const { plan, dropped } = useMemo(() => planFrom(note), [note]);
  const drops = droppedSentence(dropped, plan.length === 0);
  const bugs = plan.filter((proposal) => proposal.kind === 'bug');
  const preferences = plan.filter((proposal) => proposal.kind !== 'bug');
  // Read off the plan rather than off the clicks, so what gets sent is in the
  // order it was read in and a tick undone leaves nothing behind.
  const picked = plan.filter((proposal) => ticked.has(proposal.id)).map((proposal) => proposal.id);

  function toggle(id: string, on: boolean): void {
    setTicked((was) => {
      const next = new Set(was);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function start(): Promise<void> {
    if (picked.length === 0 || starting) return;
    setStarting(true);
    setFailed(null);
    const result = await approveProposals(note.session, picked);
    setStarting(false);
    if (result.ok) onStarted();
    // The ticks are left exactly as they were, so trying again is one click
    // rather than reading the whole plan a second time.
    else setFailed(result.error ?? 'That could not be handed to an agent. Nothing was sent.');
  }

  if (plan.length === 0) {
    return (
      <section className="report-part">
        <h3 className="report-part-title">Worth changing</h3>
        {/* "It found nothing" is a statement about the game and it is only ever
            true when the tester proposed nothing. When it proposed something
            that did not survive the anchor rule, that is what is said instead:
            a parse miss reported as a clean bill of health is the one thing
            this surface must never do. */}
        <p className="report-line">{drops ?? 'It found nothing here worth changing.'}</p>
      </section>
    );
  }

  return (
    <section className="report-part plan">
      <h3 className="report-part-title">Worth changing</h3>
      <p className="report-line">
        Tick what you want done. Approving opens a new chat with those and the pictures behind them,
        and leaves the rest of this here.
      </p>

      {bugs.length > 0 && (
        <div className="plan-group">
          <h4 className="plan-group-title">{PLAN_BUGS}</h4>
          <ul className="plan-list">
            {bugs.map((proposal) => (
              <Row
                key={proposal.id}
                proposal={proposal}
                ticked={ticked.has(proposal.id)}
                onToggle={toggle}
              />
            ))}
          </ul>
        </div>
      )}

      {preferences.length > 0 && (
        <div className="plan-group is-softer">
          <h4 className="plan-group-title">{PLAN_PREFERENCES}</h4>
          <ul className="plan-list">
            {preferences.map((proposal) => (
              <Row
                key={proposal.id}
                proposal={proposal}
                ticked={ticked.has(proposal.id)}
                onToggle={toggle}
              />
            ))}
          </ul>
        </div>
      )}

      {/* Under the list rather than above it: what survived is the thing to
          read first, and what did not is the footnote that keeps the count
          honest. */}
      {drops && <p className="plan-dropped">{drops}</p>}

      {failed && (
        <p className="plan-error" role="alert">
          {failed}
        </p>
      )}

      <div className="plan-foot">
        {/* Says why the button is off, beside the button. A disabled control
            with no explanation is a dead end. */}
        <span className="plan-count">
          {picked.length === 0 ? 'Nothing ticked yet.' : `${picked.length} ticked.`}
        </span>
        <Button variant="primary" disabled={picked.length === 0 || starting} onClick={() => void start()}>
          {starting ? 'Starting' : 'Start work'}
        </Button>
      </div>
    </section>
  );
}
