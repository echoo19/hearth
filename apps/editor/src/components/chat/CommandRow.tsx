/**
 * A shell command the agent ran, inline in the conversation.
 *
 * One quiet line: what ran, whether it worked, how long it took. A turn that
 * runs nine commands should read as nine lines — the output is behind a click
 * because it is evidence, not prose, and most of the time nobody needs it.
 *
 * A failed command still doesn't shout: it keeps the same line, in the same
 * place, with its exit code stated on it. That is enough to be found while
 * scanning, and the reader decides whether to open it.
 */
import React, { useState } from 'react';
import type { ChatCommandPart } from '../../types';
import { formatDuration } from '../../chat/duration';
import { Icon } from '../ui';

/**
 * How the run ended, for the collapsed line. A non-zero exit is the single
 * most useful thing to state without opening anything; a failure with no code
 * to report still has to say that it failed.
 */
export function commandStatusNote(part: Pick<ChatCommandPart, 'state' | 'exitCode'>): string | null {
  // A command whose turn ended before it reported back. No exit code exists,
  // because nothing ever collected one, so the row says what is actually known
  // rather than borrowing the vocabulary of success or of failure.
  if (part.state === 'stopped') return 'did not finish';
  if (part.state !== 'error') return null;
  return part.exitCode === undefined ? 'failed' : `exit ${part.exitCode}`;
}

export function CommandRow({ part }: { part: ChatCommandPart }) {
  const [open, setOpen] = useState(false);
  const duration = formatDuration(part.durationMs);
  const note = commandStatusNote(part);
  const output = part.output.trim();

  return (
    <div className={`cmd-row state-${part.state}`} data-open={open}>
      <button type="button" className="cmd-line" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="cmd-chevron" aria-hidden="true">
          <Icon name="chevron" size={9} />
        </span>
        <span className="cmd-verb">Ran</span>
        <span className="cmd-text">{part.title}</span>
        {note && <span className="cmd-note">{note}</span>}
        {duration && <span className="cmd-time">{duration}</span>}
      </button>
      {open && (
        // Always openable, even before anything has been captured: a control
        // that switches from inert to live mid-stream is harder to trust than
        // one that admits there is nothing to show yet.
        <div className="cmd-body">
          {output === '' ? (
            <p className="cmd-empty">{part.state === 'running' ? 'No output yet.' : 'No output.'}</p>
          ) : (
            <pre className="cmd-output">{part.output}</pre>
          )}
          {part.detail && <p className="cmd-summary">{part.detail}</p>}
          {part.exitCode !== undefined && <p className="cmd-exit">Exit code {part.exitCode}</p>}
        </div>
      )}
    </div>
  );
}
