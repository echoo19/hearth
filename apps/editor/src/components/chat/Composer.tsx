/**
 * The one input the app really has.
 *
 * A single card: what you type on top, everything that qualifies it along the
 * bottom — the + menu on the left, who answers and the send button on the
 * right. The same card appears on Home (where sending creates the folder) and
 * docked under the transcript (where sending continues the conversation);
 * mounting it twice with a different submit is cheaper, and reads better, than
 * two boxes that drift apart.
 *
 * Enter sends and Shift+Enter breaks the line, which is what every other chat
 * app in the world does. ⌘↵ keeps working for the people who learned it here.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApp } from '../../store';
import { Tooltip } from '../ui/Tooltip';
import { Icon } from '../ui';
import { MenuButton } from '../ui/Menu';
import { ModelSelector } from './ModelSelector';

/** Ceiling for the autosizing textarea, in px — past this it scrolls. */
export const COMPOSER_MAX_PX = 200;

/** Where the composer is mounted, which is the only thing that differs. */
export type ComposerVariant = 'chat' | 'home';

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

/**
 * What a keypress in the textarea means. `null` is "not ours" — let the
 * browser do whatever it was going to do, including finishing an IME
 * composition, where an Enter that submits eats the candidate the user was
 * choosing.
 */
export function composerKeyAction(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}): 'send' | 'newline' | null {
  if (event.key !== 'Enter') return null;
  if (event.isComposing) return null;
  if (event.metaKey || event.ctrlKey) return 'send';
  if (event.shiftKey || event.altKey) return 'newline';
  return 'send';
}

/**
 * The send glyph: an arrow going up, the way the message goes. Local to the
 * composer rather than in the shared 12px icon set — this is one 14px mark on
 * one button, and the set is a vocabulary for toolbars.
 */
function ArrowUp() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 11.5V3M3.2 6.8L7 3l3.8 3.8" />
    </svg>
  );
}

const PLACEHOLDER: Record<ComposerVariant, string> = {
  chat: 'Describe the game you want',
  home: 'What are we making?',
};

export function Composer({ variant = 'chat' }: { variant?: ComposerVariant } = {}) {
  const sendChat = useApp((s) => s.sendChat);
  // Stop interrupts the TURN and keeps the conversation's agent alive, so the
  // next message continues with everything it already knows — pressing Stop
  // must not cost the user the session they were in the middle of.
  const interruptChat = useApp((s) => s.interruptChat);
  const chatBusy = useApp((s) => s.chatBusy);
  const connected = useApp((s) => s.wsStatus === 'connected');
  const consumePendingPrompt = useApp((s) => s.consumePendingPrompt);
  const [text, setText] = useState('');
  // Home's submit is a round trip (create the folder, open it, then send), and
  // it must not be startable twice from one impatient double-press.
  const [starting, setStarting] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const isHome = variant === 'home';

  // A prompt handed over by another surface lands here, focused and ready to
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

  // Home talks to the workspace endpoint over HTTP, not the chat socket, so a
  // disconnected socket is not a reason to stop someone starting a project.
  const busy = isHome ? starting : chatBusy;
  const blocked = isHome ? null : composerBlockReason({ connected, busy: chatBusy, empty: text.trim() === '' });
  const canSend = (isHome || connected) && !busy && text.trim() !== '';

  function send(): void {
    if (!canSend) return;
    const value = text;
    if (!isHome) {
      setText('');
      sendChat(value);
      return;
    }
    setStarting(true);
    // The prompt stays in the box until it is known to have gone somewhere: if
    // creating the folder fails, losing what was typed is the worst outcome.
    void Promise.resolve(useApp.getState().startFromHome(value)).finally(() => setStarting(false));
  }

  return (
    <div className={`composer composer-${variant}`}>
      <div className="composer-card">
        <textarea
          ref={ref}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={PLACEHOLDER[variant]}
          aria-label="Message the agent"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            const action = composerKeyAction({
              key: e.key,
              metaKey: e.metaKey,
              ctrlKey: e.ctrlKey,
              shiftKey: e.shiftKey,
              altKey: e.altKey,
              isComposing: e.nativeEvent.isComposing,
            });
            if (action === 'send') {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-row">
          <MenuButton
            label="Add context"
            align="left"
            triggerClassName="composer-plus"
            popoverClassName="composer-menu"
            trigger={<Icon name="plus" />}
            items={[
              {
                label: 'Open folder…',
                icon: 'folder',
                // The sidebar owns the native picker; this is the one surface
                // that needs it without owning it.
                onSelect: () => window.dispatchEvent(new CustomEvent('hearth:open-folder')),
              },
              {
                label: 'Settings…',
                icon: 'gear',
                onSelect: () => window.dispatchEvent(new CustomEvent('hearth:open-settings')),
              },
            ]}
          />
          {/* A quiet status line, not a control: shown only when there is
              actually something in the way. */}
          {blocked ? <span className="composer-note">{blocked}</span> : <span className="composer-row-gap" />}
          <ModelSelector />
          {busy && !isHome ? (
            <Tooltip content="Stop">
              <button type="button" className="composer-send is-stop" aria-label="Stop" onClick={interruptChat}>
                <Icon name="stop" size={9} />
              </button>
            </Tooltip>
          ) : (
            <Tooltip content="Send" shortcut="↵">
              <button type="button" className="composer-send" aria-label="Send" disabled={!canSend} onClick={send}>
                <ArrowUp />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}
