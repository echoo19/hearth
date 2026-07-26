/**
 * The agent asking permission, inline and blocking.
 *
 * Rare, so it is allowed to interrupt: it takes a container, an entrance, and
 * the keyboard. Everything the decision rests on is on screen — the command or
 * the file, verbatim, in mono — because "Allow?" with the detail hidden is not
 * a question anyone can answer.
 *
 * Once answered it does not disappear. It settles into a one-line record, in
 * place: what an agent was allowed to do is part of what happened.
 */
import React, { useEffect, useRef } from 'react';
import { pendingApprovalId, useApp } from '../../store';
import type { ApprovalDecision, ChatApprovalPart } from '../../types';
import { Button } from '../ui/Button';

/** How an answered ask reads afterwards. Past tense — it is history now. */
export function approvalRecordVerb(decision: ApprovalDecision): string {
  return decision === 'allow' ? 'Allowed' : 'Denied';
}

export function ApprovalPrompt({ part }: { part: ChatApprovalPart }) {
  const approveChat = useApp((s) => s.approveChat);
  // Only the ask the transcript is actually waiting on owns the keyboard; a
  // second one that somehow stacked stays a click-only control until its turn.
  const active = useApp((s) => pendingApprovalId(s.messages) === part.id);
  const allowRef = useRef<HTMLButtonElement>(null);
  const decision = part.decision;
  const pending = decision === null;

  // A blocking ask that leaves focus in the composer is a blocking ask the
  // keyboard can't answer. Taking focus is the point.
  useEffect(() => {
    if (active && pending) allowRef.current?.focus();
  }, [active, pending]);

  useEffect(() => {
    if (!active || !pending) return;
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      // Never answer on someone's behalf while they are typing, and never from
      // under an open dialog — Escape belongs to whatever is on top.
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      if (target?.closest('dialog[open]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        approveChat(part.id, 'deny');
        return;
      }
      // A focused button already answers Enter by activating itself; handling
      // it here too would answer twice — and, on Deny, answer the wrong way.
      if (event.key === 'Enter' && tag !== 'BUTTON') {
        event.preventDefault();
        approveChat(part.id, 'allow');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, pending, approveChat, part.id]);

  if (decision !== null) {
    return (
      <p className="approval-record" data-decision={decision}>
        {approvalRecordVerb(decision)} <span className="mono">{part.title}</span>
      </p>
    );
  }

  return (
    <div className="approval" role="group" aria-live="polite" aria-label={`Permission needed: ${part.title}`}>
      <p className="approval-title">{part.title}</p>
      <pre className="approval-detail">{part.detail}</pre>
      <div className="approval-actions">
        {/* Full-height controls, not the compact variant: this is a decision
            the user is being stopped for, not a row of secondary chrome. */}
        <Button ref={allowRef} variant="primary" onClick={() => approveChat(part.id, 'allow')}>
          Allow
        </Button>
        <Button onClick={() => approveChat(part.id, 'deny')}>Deny</Button>
        {active && <span className="approval-hint">↵ allow · esc deny</span>}
      </div>
    </div>
  );
}
