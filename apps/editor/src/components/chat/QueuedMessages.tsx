/**
 * Messages typed while the agent was still answering.
 *
 * They sit at the foot of the transcript, in the place and shape they will
 * occupy once they are actually sent, so waiting looks like waiting rather
 * than like nothing happened. Quieter than a real turn — outlined instead of
 * filled — because these have not been said yet, and each one can be taken
 * back for as long as that stays true.
 *
 * The alternative, which is what the app did before, is to disable the box
 * while a turn runs. That loses the thought entirely, and the moment someone
 * thinks of the correction is precisely the moment they can see the answer
 * going wrong.
 */
import React from 'react';
import { useApp } from '../../store';
import { IconButton } from '../ui/Button';

export function QueuedMessages() {
  const queued = useApp((s) => s.queued);
  const unqueueChat = useApp((s) => s.unqueueChat);
  if (queued.length === 0) return null;

  return (
    <div className="queued" aria-label="Waiting to send">
      {queued.map((message) => (
        <div key={message.id} className="queued-row">
          <span className="queued-text">
            {message.text !== ''
              ? message.text
              : message.attachments.map((file) => file.name).join(', ')}
          </span>
          {message.attachments.length > 0 && message.text !== '' && (
            <span className="queued-count">
              {message.attachments.length === 1 ? '1 file' : `${message.attachments.length} files`}
            </span>
          )}
          <IconButton
            icon="cross"
            label="Don't send this"
            iconSize={11}
            className="queued-remove"
            onClick={() => unqueueChat(message.id)}
          />
        </div>
      ))}
    </div>
  );
}
