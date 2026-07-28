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
  picturesFor,
  proposalsFrom,
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

  const plan = useMemo(() => proposalsFrom(note), [note]);
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
    const result = await approveProposals(note.session, picked);
    setStarting(false);
    if (result.ok) onStarted();
  }

  if (plan.length === 0) {
    return (
      <section className="report-part">
        <h3 className="report-part-title">Worth changing</h3>
        <p className="report-line">It found nothing here worth changing.</p>
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
