/**
 * The conversation itself.
 *
 * A user turn is a quiet raised block; an agent turn is plain text on the
 * column, no container — the reader should be able to read the agent the way
 * they read a page, not pick it out of a card. Tool activity lands inline
 * between paragraphs, exactly where it happened.
 */
import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { useApp } from '../../store';
import type { ChatMessage } from '../../types';
import { Button } from '../ui/Button';
import { ToolChip } from './ToolChip';

/**
 * Whether a scroll container is parked at (or within `slack` px of) its
 * bottom. Pure so the follow threshold is testable without a layout; jsdom
 * reports zeroes, which must read as "at the bottom".
 */
export function isNearBottom(
  metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
  slack = 48,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < slack;
}

/**
 * Nothing has been said yet. The one place in the app with a little warmth —
 * it is the first thing a new user reads, and "type what you want" is the
 * entire onboarding.
 *
 * With no key configured there are exactly two ways forward and both are
 * offered as real controls: bring your own CLI agent (one click away, in this
 * same column), or give the built-in one a key. Neither is the fallback.
 */
function ChatEmptyState({ hasAgent }: { hasAgent: boolean }) {
  const setConversationMode = useApp((s) => s.setConversationMode);
  return (
    <div className="chat-empty">
      <p className="chat-empty-lead">What are we making?</p>
      <p className="chat-empty-hint">
        {hasAgent
          ? 'Describe the game. It gets built in this folder, and shows up in the pane beside you.'
          : 'No agent is connected yet. Run your own CLI agent in the terminal, or add a key so the built-in one can answer.'}
      </p>
      {hasAgent ? (
        <ul className="chat-empty-examples">
          <li>a top-down space shooter with asteroids</li>
          <li>a one-screen platformer, three levels</li>
          <li>snake, but the walls wrap</li>
        </ul>
      ) : (
        <div className="chat-empty-actions">
          <Button onClick={() => setConversationMode('terminal')}>Switch to Terminal</Button>
          <Button
            variant="ghost"
            onClick={() => window.dispatchEvent(new CustomEvent('hearth:open-settings'))}
          >
            Add a key in Settings
          </Button>
        </div>
      )}
    </div>
  );
}

function Turn({ message }: { message: ChatMessage }) {
  const showWorking = message.streaming && message.parts.length === 0;
  return (
    <article className={`msg msg-${message.role}`}>
      {message.parts.map((part, index) =>
        part.kind === 'text' ? (
          <p key={index} className="msg-text">
            {part.text}
          </p>
        ) : (
          <ToolChip key={part.id} part={part} />
        ),
      )}
      {showWorking && (
        <p className="msg-working">
          <span className="working-bar" aria-hidden="true" />
          Working
        </p>
      )}
    </article>
  );
}

export function MessageList() {
  const messages = useApp((s) => s.messages);
  const hasAgent = useApp((s) => s.chatDriver === 'agent-sdk' || s.settings?.hasKey === true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  // Follow the tail unless the reader has scrolled up to reread something —
  // the standard chat idiom. Appending grows scrollHeight without firing a
  // scroll event, so the intent is retained across new content.
  const lastId = messages.length > 0 ? messages[messages.length - 1].id : '';
  const lastLength = messages.length > 0 ? JSON.stringify(messages[messages.length - 1].parts).length : 0;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [lastId, lastLength]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      followRef.current = isNearBottom(el);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="chat-scroll" ref={scrollRef}>
      {messages.length === 0 ? (
        <ChatEmptyState hasAgent={hasAgent} />
      ) : (
        <div className="chat-turns">
          {messages.map((message) => (
            <Turn key={message.id} message={message} />
          ))}
        </div>
      )}
    </div>
  );
}
