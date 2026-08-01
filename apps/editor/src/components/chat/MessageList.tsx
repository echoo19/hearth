/**
 * The conversation itself.
 *
 * A user turn is a quiet raised block; an agent turn is plain text on the
 * column, no container — the reader should be able to read the agent the way
 * they read a page, not pick it out of a card. Tool activity lands inline
 * between paragraphs, exactly where it happened.
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useApp } from '../../store';
import type { ApprovalDecision, ChatMessage, ChatPart, InputAction, InputAnswer } from '../../types';
import { greetingFor } from '../home/Home';
import { Button } from '../ui/Button';
import { ApprovalPrompt } from './ApprovalPrompt';
import { InputPrompt } from './InputPrompt';
import { SentAttachments } from './AttachmentTray';
import { ImageCard, NoticeRow, PlanCard } from './PlanCard';
import { CommandRow } from './CommandRow';
import { FileChangeCard } from './FileChangeCard';
import { Markdown } from './Markdown';
import { ReasoningRow } from './ReasoningRow';
import { SkillRow } from './SkillRow';
import { SubagentCard } from './SubagentCard';
import { ToolChip } from './ToolChip';
import { groupTranscriptParts, runIsLive, ToolRunGroup } from './ToolRun';
import { WorkingRow } from './WorkingRow';
import { QueuedMessages } from './QueuedMessages';
import { useCopy } from '../../useCopy';
import { Icon } from '../ui';
import { Tooltip } from '../ui/Tooltip';

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
 * The greeting an empty chat opens with — the same rotating line Home uses,
 * one size down. Two different greetings for the same moment would read as
 * two different apps, so this borrows rather than repeats.
 */
function chatEmptyGreeting(): string {
  return greetingFor(new Date().getHours(), Math.floor(Date.now() / 86_400_000));
}

/**
 * Whether anything can answer, and crucially whether we know yet.
 *
 * The third state is the whole point. `openWorkspace` and `closeWorkspace`
 * reset `settings`, `providers` and `chatDriver` to null, so for the first
 * moment of every new chat all three signals read false while the socket binds
 * and the settings call is still in flight. Treating that window as "nothing
 * connected" told people with a perfectly good setup that they had no agent,
 * seemingly at random, and the message went away on its own a moment later.
 *
 * So absence of evidence is reported as `unknown` and says nothing at all. A
 * driver that bound as the stub IS an answer: the server looked and found
 * nothing to talk to.
 */
export type AgentReadiness = 'unknown' | 'connected' | 'missing';

export function agentReadiness(state: {
  chatDriver: string | null;
  providers: { active?: unknown } | null;
  settings: { hasKey?: boolean } | null;
}): AgentReadiness {
  if (state.chatDriver === 'agent-sdk' || state.chatDriver === 'codex') return 'connected';
  if (state.providers?.active != null || state.settings?.hasKey === true) return 'connected';
  // Only the bound driver can prove absence. Settings returning "no key" does
  // not mean nothing can answer: the socket may still be about to bind a CLI
  // agent that needs no key at all. Waiting for the driver is the difference
  // between reporting a fact and guessing during a race.
  return state.chatDriver === null ? 'unknown' : 'missing';
}

/**
 * Nothing has been said yet. The one place in the app with a little warmth —
 * it is the first thing a new user reads, and "type what you want" is the
 * entire onboarding.
 *
 * With nothing configured there are exactly three ways forward and all three
 * are offered as real controls: sign in to one built-in agent, give the other
 * a key, or run your own CLI agent in the terminal in this same column. None
 * of them is the fallback. The third is a shell, not a registered backend: the
 * CLI answers in the terminal, it does not drive this transcript, so tool rows
 * and approvals are its own rather than Hearth's.
 */
function ChatEmptyState({ agent }: { agent: AgentReadiness }) {
  // Read the clock once per mount: a line that re-rolls under the reader is
  // the app fidgeting.
  const greeting = useMemo(chatEmptyGreeting, []);
  return (
    <div className="chat-empty">
      <p className="chat-empty-lead">{greeting}</p>
      {/* Only once we actually know. `unknown` is the first moment of a new
          chat, before the socket has said which driver bound and before the
          settings call has returned, and claiming "no agent" there was telling
          people their working setup was broken. */}
      {agent === 'missing' && (
        <>
          <p className="chat-empty-hint">No agent is connected yet.</p>
          {/* One way forward. Settings is where every route in (sign in, paste
              a key, point at a CLI) already lives, so offering three shortcuts
              here was three chances to pick the wrong one. */}
          <div className="chat-empty-actions">
            <Button onClick={() => window.dispatchEvent(new CustomEvent('hearth:open-settings'))}>
              Open Settings
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One part of a turn. Everything the transcript can show is dispatched here
 * and nowhere else, so the vocabulary is readable in one place.
 *
 * Prose is the only thing with no container at all — the reader should read
 * the agent the way they read a page. Commands, skills and reasoning are
 * lines; only a file change, a delegated agent, and an ask earn a box.
 *
 * The agent's prose is read as markdown, because that is what agents write and
 * the transcript was showing the brackets. Yours is not: you can see what you
 * typed, and quietly restyling it afterwards is the app editing your words.
 */
export interface ControlledTurnActions {
  activeApprovalId?: string | null;
  activeInputId?: string | null;
  onApproval?: (approvalId: string, decision: ApprovalDecision, choiceId?: string) => void;
  onInput?: (
    inputId: string,
    action: InputAction,
    answers?: Record<string, InputAnswer>,
  ) => boolean;
}

function Part({
  part,
  live,
  role,
  controls,
}: {
  part: ChatPart;
  live: boolean;
  role: ChatMessage['role'];
  controls?: ControlledTurnActions;
}) {
  switch (part.kind) {
    case 'text':
      return role === 'agent' ? (
        <Markdown text={part.text} live={live} />
      ) : (
        <p className="msg-text">{part.text}</p>
      );
    case 'reasoning':
      return <ReasoningRow part={part} live={live} />;
    case 'command':
      return <CommandRow part={part} />;
    case 'skill':
      return <SkillRow part={part} />;
    case 'file-change':
      return <FileChangeCard part={part} />;
    case 'subagent':
      return <SubagentCard part={part} />;
    case 'approval':
      return (
        <ApprovalPrompt
          part={part}
          active={controls ? controls.activeApprovalId === part.id : undefined}
          onRespond={controls?.onApproval}
        />
      );
    case 'input':
      return (
        <InputPrompt
          part={part}
          active={controls ? controls.activeInputId === part.id : undefined}
          onRespond={controls?.onInput}
        />
      );
    case 'plan':
      return <PlanCard part={part} />;
    case 'image':
      return <ImageCard part={part} />;
    case 'notice':
      return <NoticeRow part={part} />;
    default:
      return <ToolChip part={part} />;
  }
}

/**
 * What a turn says, as plain text.
 *
 * Prose and plans only. Copying a turn is for taking away what was written,
 * so a captured build log and a diff stay out of it: someone pasting an
 * answer into a note wants the answer, and the machinery is recoverable from
 * the transcript itself. Blank when a turn was pure tool work, which is what
 * hides the control.
 */
export function turnPlainText(message: ChatMessage): string {
  return message.parts
    .filter((part): part is Extract<ChatPart, { kind: 'text' | 'plan' }> => part.kind === 'text' || part.kind === 'plan')
    .map((part) => part.text.trim())
    .filter((text) => text !== '')
    .join('\n\n');
}

/**
 * The controls that belong to a finished turn.
 *
 * Held at zero opacity until the turn is hovered or something inside it takes
 * focus, so a long conversation is not a column of buttons. It stays in the
 * layout rather than appearing from nothing, because a row that pushes the
 * text as it arrives makes the whole transcript twitch under the pointer.
 *
 * Never shown on a streaming turn: copying half a sentence is not useful, and
 * a control that appears mid-answer invites pressing it too early.
 *
 * Agent turns only. Your own message is already a bordered block, and putting
 * a control inside it would grow the block on every turn to offer back the
 * text you just typed.
 */
function TurnActions({ message }: { message: ChatMessage }) {
  const { copied, copy } = useCopy();
  const text = turnPlainText(message);
  if (message.role !== 'agent' || message.streaming || text === '') return null;

  return (
    <div className="turn-actions">
      {/* Icon alone. The word "Copy" beside it doubled the control's width to
          repeat what the glyph already says, and the confirmation now lands as
          the tick rather than as text that reflows the row. */}
      <Tooltip content={copied ? 'Copied' : 'Copy'} side="top">
        <button
          type="button"
          className="turn-action"
          onClick={() => copy(text)}
          aria-label={copied ? 'Copied' : 'Copy message'}
        >
          <Icon name={copied ? 'check' : 'copy'} size={12} />
        </button>
      </Tooltip>
    </div>
  );
}

export function MessageTurn({ message, controls }: { message: ChatMessage; controls?: ControlledTurnActions }) {
  if (message.orchestration) {
    return (
      <details className="orchestration-record">
        <summary>Dev team instruction</summary>
        <div className="orchestration-body">
          {message.parts.map((part, index) =>
            part.kind === 'text' ? <p key={index}>{part.text}</p> : null,
          )}
        </div>
      </details>
    );
  }
  const last = message.parts.length - 1;
  // A live reasoning fold is already a working line — it says "Thinking",
  // carries the pulse and counts. Drawing another one under it would print the
  // same word twice.
  const thinking = message.streaming && message.parts[last]?.kind === 'reasoning';
  return (
    <article className={`msg msg-${message.role}`}>
      {/* Above the words, the way it was assembled: you attach the picture,
          then say what to do with it. */}
      {message.attachments ? <SentAttachments attachments={message.attachments} /> : null}
      {/* Folded first, drawn second. A run of consecutive commands is one item
          here, so a turn that shells out eight times is eight lines while it
          happens and one line afterwards. */}
      {groupTranscriptParts(message.parts).map((item) =>
        item.type === 'run' ? (
          <ToolRunGroup
            key={item.key}
            parts={item.parts}
            live={runIsLive(item.parts, message.streaming, item.startIndex + item.parts.length - 1 === last)}
          />
        ) : (
          // Only the trailing part of a streaming turn is still being written;
          // everything above it is finished, whatever the turn as a whole is
          // doing.
          <Part
            key={item.key}
            part={item.part}
            live={message.streaming && item.index === last}
            role={message.role}
            controls={controls}
          />
        ),
      )}
      {/* Shown for the whole turn, not just its empty opening: the reader
          should never have to look at the send button to find out whether
          anything is still happening. */}
      {message.streaming && !thinking && <WorkingRow message={message} />}
      <TurnActions message={message} />
    </article>
  );
}

export function MessageTurns({
  messages,
  controls,
  className,
}: {
  messages: readonly ChatMessage[];
  controls?: ControlledTurnActions;
  className?: string | null;
}) {
  const turns = messages.map((message) => (
    <MessageTurn key={message.id} message={message} controls={controls} />
  ));
  if (!className) return <>{turns}</>;
  return (
    <div className={className}>
      {turns}
    </div>
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
    // A plan is replaced in place, so its length is the only thing that says
    // it changed — without this the view stops following while a plan grows.
    case 'plan':
      return message.parts.length + tail.text.length;
    default:
      return message.parts.length;
  }
}

export function MessageList() {
  const messages = useApp((s) => s.messages);
  const agent = useApp(agentReadiness);
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
        <ChatEmptyState agent={agent} />
      ) : (
        <div className="chat-turns">
          <MessageTurns messages={messages} />
          {/* Below the running turn, where they will appear once sent. */}
          <QueuedMessages />
        </div>
      )}
    </div>
  );
}
