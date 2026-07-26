/**
 * The one input the app really has.
 *
 * Grows with what's typed (up to a ceiling, then scrolls), sends on ⌘↵, and
 * when it can't send it says why rather than going quietly grey.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApp } from '../../store';
import { IconButton } from '../ui/Button';

/** Ceiling for the autosizing textarea, in px — past this it scrolls. */
export const COMPOSER_MAX_PX = 200;

/**
 * Why the composer can't send right now, or null when it can. Pure, so the
 * disabled contract is unit-testable without a DOM: the composer must never
 * be disabled without a visible reason.
 */
export function composerBlockReason(opts: {
  connected: boolean;
  busy: boolean;
  empty: boolean;
}): string | null {
  if (!opts.connected) return 'Reconnecting…';
  if (opts.busy) return 'Working — press Stop to interrupt.';
  if (opts.empty) return null;
  return null;
}

/** True when ⌘↵ / Ctrl+↵ was pressed (the send chord). */
export function isSendChord(event: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey);
}

export function Composer() {
  const sendChat = useApp((s) => s.sendChat);
  const cancelChat = useApp((s) => s.cancelChat);
  const busy = useApp((s) => s.chatBusy);
  const connected = useApp((s) => s.wsStatus === 'connected');
  const consumePendingPrompt = useApp((s) => s.consumePendingPrompt);
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  // A prompt handed over by the launcher lands here, focused and ready to
  // edit — never sent behind the user's back.
  useEffect(() => {
    const pending = consumePendingPrompt();
    if (pending) setText(pending);
    ref.current?.focus();
  }, [consumePendingPrompt]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measure from scratch, then adopt the content height up to the ceiling.
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_PX)}px`;
  }, [text]);

  const blocked = composerBlockReason({ connected, busy, empty: text.trim() === '' });
  const canSend = connected && !busy && text.trim() !== '';

  function send(): void {
    if (!canSend) return;
    sendChat(text);
    setText('');
  }

  return (
    <div className="composer">
      <div className="composer-field">
        <textarea
          ref={ref}
          className="composer-input"
          rows={1}
          value={text}
          placeholder="Describe the game you want"
          aria-label="Message the agent"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (isSendChord(e)) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-actions">
          <span className="composer-note">{blocked ?? '⌘↵ to send'}</span>
          {busy ? (
            <IconButton icon="stop" label="Stop" className="composer-send is-stop" onClick={cancelChat} />
          ) : (
            <IconButton
              icon="chevron"
              label="Send"
              shortcut="⌘↵"
              className="composer-send"
              disabled={!canSend}
              onClick={send}
            />
          )}
        </div>
      </div>
    </div>
  );
}
