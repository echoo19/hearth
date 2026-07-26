/**
 * A delegated agent, working inside this turn.
 *
 * A subagent is a genuine second actor, not a tool call, so it gets a
 * container and a small indent — enough to say "this happened one level in",
 * never enough to become a card inside a card. Its own transcript stays
 * folded: what the reader needs is that it is running, and what it concluded.
 */
import React, { useState } from 'react';
import type { ChatSubagentPart } from '../../types';
import { Icon } from '../ui';

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
      </button>
      {line && <p className="subagent-line">{line}</p>}
      {running && !line && (
        <p className="subagent-line subagent-working">
          <span className="working-bar" aria-hidden="true" />
          Working
        </p>
      )}
      {open && (
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
      )}
    </div>
  );
}
