/**
 * The agent thinking out loud.
 *
 * Folded by default and set in the faintest ink the app has, because reasoning
 * is not the answer — it is the working-out. A reader who wants it knows to
 * look; a reader who doesn't should be able to scan straight past it.
 */
import React, { useState } from 'react';
import type { ChatReasoningPart } from '../../types';
import { Icon } from '../ui';

export function ReasoningRow({ part }: { part: ChatReasoningPart }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="reasoning-row" data-open={open}>
      <button type="button" className="reasoning-line" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="reasoning-chevron" aria-hidden="true">
          <Icon name="chevron" size={9} />
        </span>
        Thinking
      </button>
      {open && <p className="reasoning-body">{part.text}</p>}
    </div>
  );
}
