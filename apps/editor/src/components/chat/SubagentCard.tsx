/**
 * A delegated agent, working inside this turn.
 *
 * A subagent is a genuine second actor, but it is still the agent's legwork
 * rather than the agent's answer, so it reads as one row in the same folded
 * machinery family as a command or a file report — not as an outlined card
 * standing beside the prose.
 *
 * The collapsed row carries the three things a reader scanning back needs:
 * what it was, how it ended, and what it reported, the last of those clipped
 * to the line. Everything it wrote is behind the chevron, in place, because a
 * panel or a dialog for something read at a glance is a heavier promise than
 * the content makes good on, and because opening in place is what every other
 * fold in this transcript does.
 */
import React, { useState } from 'react';
import type { ChatSubagentPart } from '../../types';
import { FlameMark, Icon } from '../ui';

/**
 * The one line a running subagent shows: the last thing it actually said.
 * Streaming chunks arrive mid-line, so a trailing partial line is the newest
 * thing there is and is what gets shown.
 */
export function subagentTail(text: string): string | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line !== '') return line;
  }
  return null;
}

export function SubagentCard({ part }: { part: ChatSubagentPart }) {
  const [open, setOpen] = useState(false);
  const running = part.state === 'running';
  // Once it has finished, its conclusion replaces the running commentary —
  // the tail of a transcript is not a summary, and pretending otherwise would
  // leave whatever it happened to say last standing as the result.
  const line = running ? subagentTail(part.text) : (part.summary ?? subagentTail(part.text));
  const rows = part.text.split('\n').filter((row) => row.trim() !== '');

  return (
    <div className={`subagent-card state-${part.state}`} data-open={open}>
      <button type="button" className="subagent-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="subagent-chevron" aria-hidden="true">
          <Icon name="chevron" size={9} />
        </span>
        <span className="subagent-dot" aria-hidden="true" />
        <span className="subagent-title">{part.title}</span>
        {part.role && <span className="subagent-role">{part.role}</span>}
        {/* The outcome, on the row. A helper that reported nothing at all still
            has to say how it ended, or a collapsed row would read as a helper
            that never came back. One that is still going says so with the same
            mark the turn's own working line uses: one "still going" idiom in
            the app, whoever is doing the going.

            Once the block is open the same sentence is below it in full, so
            the slot empties rather than printing it twice — kept in the row so
            the title and the role hold their places through the toggle. */}
        <span className="subagent-outcome">
          {open && line ? null : (line ??
            (running ? (
              <span className="subagent-working">
                <FlameMark />
                <span className="working-label">Working</span>
              </span>
            ) : (
              subagentOutcome(part.state)
            )))}
        </span>
      </button>
      {open && (
        <>
          {/* Clipped on the row, whole once opened. */}
          {line && <p className="subagent-line">{line}</p>}
          <div className="subagent-detail">
            {rows.length === 0 ? (
              <p className="subagent-row subagent-empty">Nothing reported yet.</p>
            ) : (
              rows.map((row, index) => (
                <p key={index} className="subagent-row">
                  {row}
                </p>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * How a helper ended, for a collapsed row that has nothing else to show.
 *
 * `stopped` is named rather than left to the default. A turn can end with a
 * helper still open (the turn failed, the user interrupted, the driver died),
 * and those rows are settled to `stopped` rather than left claiming to run.
 * Falling through to "Done" would take the one case where nothing knows what
 * happened and report it as success, which is the worst reading available.
 */
export function subagentOutcome(state: ChatSubagentPart['state']): string {
  switch (state) {
    case 'running':
      return 'Working';
    case 'error':
      return 'Failed';
    case 'stopped':
      return 'Stopped';
    default:
      return 'Done';
  }
}
