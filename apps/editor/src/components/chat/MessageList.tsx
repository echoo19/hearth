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
import type { ChatMessage, ChatPart } from '../../types';
import { Button } from '../ui/Button';
import { ApprovalPrompt } from './ApprovalPrompt';
import { CommandRow } from './CommandRow';
import { FileChangeCard } from './FileChangeCard';
import { ReasoningRow } from './ReasoningRow';
import { SubagentCard } from './SubagentCard';
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
 * With nothing configured there are exactly three ways forward and all three
 * are offered as real controls: sign in to one built-in agent, give the other
 * a key, or bring your own CLI agent (one click away, in this same column).
 * None of them is the fallback.
 */
function ChatEmptyState({ hasAgent }: { hasAgent: boolean }) {
  const setConversationMode = useApp((s) => s.setConversationMode);
  const startOpenAiLogin = useApp((s) => s.startOpenAiLogin);
  return (
    <div className="chat-empty">
      <p className="chat-empty-lead">What are we making?</p>
      <p className="chat-empty-hint">
        {hasAgent
          ? 'Describe the game. It gets built in this folder, and shows up in the pane beside you.'
          : 'No agent is connected yet. Sign in with ChatGPT, add an Anthropic key, or run your own CLI agent in the terminal.'}
      </p>
      {hasAgent ? (
        <ul className="chat-empty-examples">
          <li>a top-down space shooter with asteroids</li>
          <li>a one-screen platformer, three levels</li>
          <li>snake, but the walls wrap</li>
        </ul>
      ) : (
        // Three ways forward, and none of them is the consolation prize: the
        // two built-in agents are one click each, and the terminal is the
        // third first-class answer rather than what's left over.
        <div className="chat-empty-actions">
          <Button onClick={() => setConversationMode('terminal')}>Switch to Terminal</Button>
          <Button variant="ghost" onClick={() => void startOpenAiLogin()}>
            Sign in with ChatGPT
          </Button>
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

/**
 * One part of a turn. Everything the transcript can show is dispatched here
 * and nowhere else, so the vocabulary is readable in one place.
 *
 * Prose is the only thing with no container at all — the reader should read
 * the agent the way they read a page. Commands and reasoning are lines; only
 * a file change, a delegated agent, and an ask earn a box.
 */
function Part({ part }: { part: ChatPart }) {
  switch (part.kind) {
    case 'text':
      return <p className="msg-text">{part.text}</p>;
    case 'reasoning':
      return <ReasoningRow part={part} />;
    case 'command':
      return <CommandRow part={part} />;
    case 'file-change':
      return <FileChangeCard part={part} />;
    case 'subagent':
      return <SubagentCard part={part} />;
    case 'approval':
      return <ApprovalPrompt part={part} />;
    default:
      return <ToolChip part={part} />;
  }
}

/**
 * A stable key for a part. Text and reasoning coalesce in place and have no
 * id of their own, so position is their identity; everything else keeps the
 * id the driver gave it, which survives the parts around it changing.
 */
function partKey(part: ChatPart, index: number): string {
  return part.kind === 'text' || part.kind === 'reasoning' ? `p${index}` : part.id;
}

function Turn({ message }: { message: ChatMessage }) {
  const showWorking = message.streaming && message.parts.length === 0;
  return (
    <article className={`msg msg-${message.role}`}>
      {message.parts.map((part, index) => (
        <Part key={partKey(part, index)} part={part} />
      ))}
      {showWorking && (
        <p className="msg-working">
          <span className="working-bar" aria-hidden="true" />
          Working
        </p>
      )}
    </article>
  );
}

/**
 * A cheap "has the last turn got taller?" number, for the follow-the-tail
 * effect below. Only the part currently growing can change the height between
 * two renders, so measuring the tail is enough — and it matters that this is
 * cheap: a command streaming a build log re-renders per chunk, and serializing
 * the whole turn each time would cost more with every chunk it captured.
 */
export function turnGrowth(message: ChatMessage | undefined): number {
  const tail = message?.parts[message.parts.length - 1];
  if (!message || !tail) return 0;
  switch (tail.kind) {
    case 'text':
    case 'reasoning':
      return message.parts.length + tail.text.length;
    case 'command':
      return message.parts.length + tail.output.length;
    case 'subagent':
      return message.parts.length + tail.text.length;
    default:
      return message.parts.length;
  }
}

export function MessageList() {
  const messages = useApp((s) => s.messages);
  // "Something can answer": a bound driver that isn't the stub, a provider the
  // server says is active, or — before either has been read — a stored key.
  const hasAgent = useApp(
    (s) =>
      s.chatDriver === 'agent-sdk' ||
      s.chatDriver === 'codex' ||
      s.providers?.active != null ||
      s.settings?.hasKey === true,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  // Follow the tail unless the reader has scrolled up to reread something —
  // the standard chat idiom. Appending grows scrollHeight without firing a
  // scroll event, so the intent is retained across new content.
  const lastId = messages.length > 0 ? messages[messages.length - 1].id : '';
  const lastLength = turnGrowth(messages[messages.length - 1]);

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
