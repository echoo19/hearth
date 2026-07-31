/**
 * The line that says the agent is still going.
 *
 * It lives in the transcript, at the foot of the turn being written, because
 * that is where the reader's eye already is — the old arrangement put a static
 * "Working — press Stop to interrupt." down in the composer, which is a caption
 * on the wrong thing: it explained a button instead of showing a state.
 *
 * What it says is derived from what the turn is actually doing, so a long
 * silence while a build runs reads as "Running" rather than as a generic
 * spinner. Past a few seconds it starts counting, which is the difference
 * between a slow turn and a stuck one.
 */
import React, { useEffect, useState } from 'react';
import type { ChatMessage } from '../../types';
import { formatElapsed } from '../../chat/duration';
import { Icon } from '../ui';

/**
 * What the turn is busy with, in one word.
 *
 * The rule is narrow on purpose: a label is given only for something that is
 * still HAPPENING at the tail of the turn — a command mid-run, a delegated
 * agent mid-run, a question nobody has answered. Everything else is "Working".
 *
 * A richer vocabulary was tried and thrown away. Labelling prose as "Writing"
 * looked better in isolation and read as a flicker in practice, because a real
 * turn alternates between prose and tool calls every couple of seconds: the
 * line said Writing, Working, Writing, Working while nothing meaningful
 * changed. A word that changes when nothing changed is worse than no word.
 *
 * Pure — this is the whole vocabulary.
 */
export function workingLabel(message: Pick<ChatMessage, 'parts'>): string {
  const tail = message.parts[message.parts.length - 1];
  if (!tail) return 'Working';
  switch (tail.kind) {
    case 'reasoning':
      return 'Thinking';
    case 'command':
      return tail.state === 'running' ? 'Running' : 'Working';
    case 'subagent':
      return tail.state === 'running' ? 'Delegating' : 'Working';
    // An ask is on screen and nothing moves until it is answered. Saying
    // "Working" over a question the agent is blocked on would be a lie.
    case 'approval':
      return tail.decision === null ? 'Waiting for you' : 'Working';
    case 'input':
      return tail.resolution === null ? 'Waiting for you' : 'Working';
    default:
      return 'Working';
  }
}

/**
 * Milliseconds since `startedAt`, re-read once a second. Returns null when the
 * turn never recorded a start (a replay), so the caller shows no counter at
 * all rather than a stopwatch pinned at zero.
 */
export function useElapsed(startedAt: number | undefined, active: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined || !active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt, active]);
  if (startedAt === undefined) return null;
  return Math.max(0, now - startedAt);
}

export function WorkingRow({ message }: { message: ChatMessage }) {
  const elapsed = useElapsed(message.startedAt, message.streaming);
  const counter = elapsed === null ? null : formatElapsed(elapsed);

  return (
    // Polite, and only the label is announced: a counter re-read by a screen
    // reader every second is not information, it is interruption.
    <p className="msg-working" aria-live="polite">
      {/* The app's own flame, not the generic dot the other live rows use. This
          is the one place a turn is being written right now, and a hearth with
          something burning in it is a truer picture of that than a blinking
          light. The wrapper exists so the flicker has something to pivot on:
          the transform origin has to sit at the flame's base, and the Icon
          renders a bare svg with no class of its own. See chat.css. */}
      <span className="working-flame" aria-hidden="true">
        <Icon name="fire" />
      </span>
      <span className="working-label">{workingLabel(message)}</span>
      {counter && (
        <span className="working-elapsed" aria-hidden="true">
          {counter}
        </span>
      )}
    </p>
  );
}
