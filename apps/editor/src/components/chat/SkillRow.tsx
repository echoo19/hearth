/**
 * A skill the agent reached for, inline in the conversation.
 *
 * The app asks people to install skills, curate them and switch them on, and
 * until this row existed the payoff was invisible: a skill arrived as a tool
 * call named `Skill` and rendered as an unremarkable chip beside `Read` and
 * `Bash`. So it gets its own line and says which one ran.
 *
 * It is still machinery, which means it is still quiet. Same block, same fill,
 * same chevron column and same left edge as a command or a file report: the
 * only thing that marks it out is the sparkle the rail already uses for Skills
 * and the sentence, which is enough to catch while scanning and not enough to
 * pull the eye off what the agent actually said.
 *
 * What is behind the fold is what it was asked to do: the arguments for an
 * Agent SDK call, the shell command for a codex one. A skill invoked bare has
 * nothing to disclose and does not pretend to, exactly as a detail-less tool
 * chip does.
 */
import React, { useState } from 'react';
import type { ChatSkillPart } from '../../types';
import { Icon } from '../ui';

export function SkillRow({ part }: { part: ChatSkillPart }) {
  const [open, setOpen] = useState(false);
  const detail = part.detail;

  return (
    <div className={`skill-use state-${part.state}`} data-open={open}>
      <button
        type="button"
        className="skill-use-line"
        aria-expanded={detail ? open : undefined}
        onClick={() => detail && setOpen((v) => !v)}
      >
        {/* Drawn only when there is something behind it, but the column is
            always there, so a bare skill still lines its mark up with every
            other row in the turn. */}
        <span className="skill-use-chevron" aria-hidden="true">
          {detail ? <Icon name="chevron" size={9} /> : null}
        </span>
        <span className="skill-use-mark" aria-hidden="true">
          <Icon name="sparkle" size={9} />
        </span>
        <span className="skill-use-verb">Used</span>
        <span className="skill-use-name">{part.name}</span>
        <span className="skill-use-tag">skill</span>
        {/* A skill that failed to load did not run, and the row must not go on
            claiming it did. */}
        {part.state === 'error' && <span className="skill-use-note">failed</span>}
      </button>
      {open && detail && (
        <div className="skill-use-body">
          <span className="tool-body-name">Asked for</span>
          <span className="tool-body-detail">{detail}</span>
        </div>
      )}
    </div>
  );
}
