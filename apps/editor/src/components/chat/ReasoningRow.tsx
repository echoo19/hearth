/**
 * The agent thinking out loud.
 *
 * Folded by default and set in the faintest ink the app has, because reasoning
 * is not the answer — it is the working-out. A reader who wants it knows to
 * look; a reader who doesn't should be able to scan straight past it.
 *
 * The line says how long the thinking took once it is over. On a long turn
 * that number is the most useful thing on screen: it is the difference between
 * a model that spent forty seconds on a hard question and one that is hung.
 */
import React, { useState } from 'react';
import type { ChatReasoningPart } from '../../types';
import { formatDuration, formatElapsed } from '../../chat/duration';
// The flame and the label share the working line's classes on purpose — one
// "still going" idiom in the app. Styles live in styles/app/chat.css.
import { FlameMark, Icon } from '../ui';
import { useSmoothStream } from './useSmoothStream';

/**
 * What the fold is called. Pure, because this is the whole rule: present tense
 * while the tokens are still arriving, past tense with the span once they have
 * stopped, and no span at all for a replayed transcript that never had one.
 */
export function reasoningLabel(part: Pick<ChatReasoningPart, 'durationMs'>, live: boolean): string {
  if (live) return 'Thinking';
  const spent = formatDuration(part.durationMs);
  return spent === null ? 'Thought' : `Thought for ${spent}`;
}

export function ReasoningRow({ part, live = false }: { part: ChatReasoningPart; live?: boolean }) {
  const [open, setOpen] = useState(false);
  // While the thinking is live this row IS the turn's working line — it takes
  // the pulse, and MessageList suppresses the one it would otherwise draw
  // underneath. Two lines both saying "Thinking" is the app stuttering.
  // The live counter is the working line's, not the finished-span one: a thought
  // still being had is being WATCHED, so it waits a few seconds before saying
  // anything and then counts whole seconds like the flame beside it.
  const spent = live ? formatElapsed(part.durationMs ?? 0) : null;
  // Paced like the prose it is written beside; a thought arrives in the same
  // lumps and is read the same way.
  const body = useSmoothStream(part.text, live && open);

  return (
    <div className="reasoning-row" data-open={open} data-live={live || undefined}>
      <button type="button" className="reasoning-line" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="reasoning-chevron" aria-hidden="true">
          <Icon name="chevron" size={9} />
        </span>
        {/* Smouldering rather than burning: this row is the turn's working
            line while the thinking is live, and nothing is coming out of it
            yet. Same mark, banked. */}
        {live && <FlameMark state="smoulder" />}
        <span className="working-label">{reasoningLabel(part, live)}</span>
        {/* Counted from the deltas themselves, so it grows with the thought
            rather than needing a clock of its own. */}
        {spent && <span className="working-elapsed">{spent}</span>}
      </button>
      {open && <p className="reasoning-body">{body}</p>}
    </div>
  );
}
