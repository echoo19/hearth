import React, { useEffect, useRef, useState } from 'react';
import {
  devTeamActivity,
  devTeamLeadActivity,
  devTeamPhaseLabel,
  devTeamTaskLabel,
  isTeamBoardPhase,
  pendingLaneAsk,
} from '../../chat/devteam';
import { useApp } from '../../store';
import type { ChatMessage, DevTeamCompletedRun, DevTeamSnapshot, DevTeamTaskRecord } from '../../types';
import { Button } from '../ui/Button';
import { Composer } from './Composer';
import { Markdown } from './Markdown';
import { MessageList, MessageTurns } from './MessageList';

const STEPS = ['Interview', 'Spec', 'Build', 'Done'] as const;

function stepIndex(phase: DevTeamSnapshot['phase']): number {
  if (phase === 'idle' || phase === 'interviewing' || phase === 'drafting-spec') return 0;
  if (phase === 'spec-review') return 1;
  if (phase === 'done') return 3;
  return 2;
}

function PhaseHeader({ state }: { state: DevTeamSnapshot | null }) {
  const pause = useApp((s) => s.pauseDevTeam);
  const resume = useApp((s) => s.resumeDevTeam);
  const stop = useApp((s) => s.stopDevTeam);
  const phase = state?.phase ?? 'idle';
  const active = stepIndex(phase);
  const canPause = ['planning', 'building', 'reviewing', 'wrapping'].includes(phase);
  const canResume = phase === 'paused' || phase === 'interrupted';
  const canStop = canPause || canResume;

  return (
    <header className="devteam-phase">
      <ol className="devteam-steps" aria-label="Dev team progress">
        {STEPS.map((step, index) => (
          <li
            key={step}
            data-state={index < active ? 'done' : index === active ? 'current' : 'upcoming'}
            aria-current={index === active ? 'step' : undefined}
          >
            <span className="devteam-step-mark" aria-hidden="true" />
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <span className="devteam-phase-name" role="status" aria-label="Dev team phase">
        {devTeamPhaseLabel(phase)}
      </span>
      <div className="devteam-controls">
        {canPause && <Button size="sm" variant="ghost" aria-label="Pause dev team" onClick={pause}>Pause</Button>}
        {canResume && <Button size="sm" variant="primary" aria-label="Resume dev team" onClick={resume}>Resume</Button>}
        {canStop && <Button size="sm" variant="ghost" aria-label="Stop dev team" onClick={stop}>Stop</Button>}
      </div>
    </header>
  );
}

function SpecReview({ state }: { state: DevTeamSnapshot }) {
  const approve = useApp((s) => s.approveDevTeamSpec);
  return (
    <section className="devteam-spec" role="region" aria-label="Specification">
      <div className="devteam-spec-head">
        <span>Specification</span>
        <span>v{state.specVersion}</span>
      </div>
      <div className="devteam-spec-body">
        <Markdown text={state.spec ?? 'The specification is not available yet.'} live={false} />
      </div>
      <div className="devteam-spec-actions">
        <Button variant="primary" onClick={approve}>Approve &amp; build</Button>
        <span>Or describe a revision below.</span>
      </div>
    </section>
  );
}

function laneTail(messages: readonly ChatMessage[], record?: DevTeamTaskRecord): string {
  if (record?.summary) return record.summary;
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    // A steering note the person typed is not the lane's own activity.
    if (message.role !== 'agent') continue;
    const parts = message.parts;
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (part.kind === 'text' && part.text.trim()) {
        const lines = part.text.trim().split('\n');
        return lines[lines.length - 1];
      }
      if (part.kind === 'file-change') return `Changed ${part.files.length} ${part.files.length === 1 ? 'file' : 'files'}`;
    }
  }
  // The lead has no task record, so there is no status to fall back to.
  return record ? devTeamTaskLabel(record.status) : '';
}

function Lane({
  name,
  focus,
  messages,
  record,
  engineerId,
  phase,
  initiallyOpen = false,
  keyboardActive = false,
}: {
  name: string;
  focus?: string;
  messages: readonly ChatMessage[];
  record?: DevTeamTaskRecord;
  engineerId?: string;
  /** Lead lane only: what the phase says the lead is doing between turns. */
  phase?: DevTeamSnapshot['phase'];
  initiallyOpen?: boolean;
  /** Only one ask across the whole board may own Enter/Escape and focus. */
  keyboardActive?: boolean;
}) {
  const approve = useApp((s) => s.approveEngineer);
  const answer = useApp((s) => s.answerEngineerInput);
  const asks = pendingLaneAsk(messages);
  // A lane that cannot proceed without an answer is the whole board's business,
  // so it opens itself and stays open until the ask is settled.
  const blocked = asks.count > 0;
  const [open, setOpen] = useState(initiallyOpen || blocked);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const activity = engineerId
    ? devTeamActivity(messages, record?.status)
    : devTeamLeadActivity(messages, phase);
  const tail = laneTail(messages, record);
  const waiting = asks.count > 0
    ? `, ${asks.count} waiting ${asks.count === 1 ? 'question' : 'questions'}`
    : '';
  const id = `devteam-lane-${record?.taskId ?? engineerId ?? 'lead'}`;

  useEffect(() => {
    if (blocked) setOpen(true);
  }, [blocked]);

  useEffect(() => {
    setOpen(initiallyOpen || blockedRef.current);
  }, [initiallyOpen]);

  return (
    <section className="devteam-lane" data-status={record?.status ?? 'lead'}>
      <button
        type="button"
        className="devteam-lane-head"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`${name} lane${focus ? `, ${focus}` : ''}, ${activity}${tail ? `, ${tail}` : ''}${waiting}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="devteam-lane-dot" aria-hidden="true" />
        <span className="devteam-lane-who">
          <strong>{name}</strong>
          {focus && <span>{focus}</span>}
        </span>
        <span className="devteam-lane-activity">{activity}</span>
        <span className="devteam-lane-tail">{tail}</span>
        {asks.count > 0 && <span className="devteam-ask-badge" aria-label={`${asks.count} waiting ${asks.count === 1 ? 'question' : 'questions'}`}>{asks.count}</span>}
        <span className="devteam-lane-chevron" aria-hidden="true">›</span>
      </button>
      {open && (
        <div className="devteam-lane-body" id={id}>
          {messages.length > 0 ? (
            <MessageTurns
              messages={messages}
              className="devteam-lane-turns"
              controls={engineerId ? {
                activeApprovalId: keyboardActive && asks.active?.kind === 'approval' ? asks.active.id : null,
                activeInputId: keyboardActive && asks.active?.kind === 'input' ? asks.active.id : null,
                onApproval: (approvalId, decision, choiceId) => approve(engineerId, approvalId, decision, choiceId),
                onInput: (inputId, action, answers) => answer(engineerId, inputId, action, answers),
              } : undefined}
            />
          ) : <p className="devteam-lane-empty">No activity reported yet.</p>}
        </div>
      )}
    </section>
  );
}

function Milestones({ state }: { state: Pick<DevTeamSnapshot, 'plan' | 'tasks' | 'currentMilestone'> }) {
  if (!state.plan) return <p className="devteam-board-note">The lead is preparing the plan.</p>;
  const records = new Map(state.tasks.map((task) => [task.taskId, task]));
  return (
    <nav className="devteam-milestones" aria-label="Build milestones">
      {state.plan.milestones.map((milestone, milestoneIndex) => (
        <section key={milestone.id} className="devteam-milestone" aria-current={milestoneIndex === state.currentMilestone ? 'step' : undefined}>
          <h3>{milestone.title}</h3>
          {milestone.goal && <p className="devteam-milestone-goal">{milestone.goal}</p>}
          <ul>
            {milestone.tasks.map((task) => {
              const status = records.get(task.id)?.status ?? 'pending';
              return (
                <li key={task.id} data-status={status} title={task.detail}>
                  <span className="devteam-task-mark" aria-hidden="true" />
                  <span>{task.title}</span>
                  <span>{devTeamTaskLabel(status)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}

function TeamBoard({ state }: { state: DevTeamSnapshot }) {
  const messages = useApp((s) => s.messages);
  const lanes = useApp((s) => s.devTeamLanes);
  const roles = new Map(state.plan?.roles.map((role) => [role.id, role]));
  const tasks = new Map(state.plan?.milestones.flatMap((milestone) => milestone.tasks).map((task) => [task.id, task]));
  const activeAskEngineerId = state.tasks.find((record) =>
    pendingLaneAsk(lanes[record.engineerId] ?? []).count > 0,
  )?.engineerId;

  return (
    <div className="devteam-board">
      <Milestones state={state} />
      <div className="devteam-lanes" aria-label="Team activity">
        <Lane
          name="Lead"
          focus="Plan and review"
          messages={messages}
          phase={state.phase}
          initiallyOpen={state.phase === 'reviewing' || state.phase === 'wrapping'}
        />
        {state.tasks.map((record) => {
          const task = tasks.get(record.taskId);
          const role = task ? roles.get(task.roleId) : undefined;
          return (
            <Lane
              // Two pending tasks share an empty engineer id, and an engineer id
              // only exists once the task is dispatched. The task id is unique
              // by schema and stable for the life of the run.
              key={record.taskId}
              name={task?.title ?? role?.name ?? 'Engineer'}
              focus={role?.name ?? role?.focus}
              messages={lanes[record.engineerId] ?? []}
              record={record}
              engineerId={record.engineerId}
              keyboardActive={record.engineerId === activeAskEngineerId}
            />
          );
        })}
      </div>
    </div>
  );
}

type RunRecordProps =
  | { state: DevTeamCompletedRun; historical: true }
  | { state: DevTeamSnapshot; historical?: false };

function RunRecord(props: RunRecordProps) {
  const { state } = props;
  const finished = state.tasks.filter((task) => task.status === 'done').length;
  return (
    // The run that just finished leads with the lead's handoff; a run from
    // earlier in the conversation stays folded away.
    <details className="devteam-run-record" open={!props.historical}>
      <summary>
        <span className="devteam-run-chevron" aria-hidden="true">›</span>
        <span>Run complete</span>
        <span>{finished} of {state.tasks.length} tasks finished</span>
      </summary>
      <div className="devteam-run-body">
        {state.wrap && <Markdown text={state.wrap} live={false} />}
        {!state.wrap && state.summary && <Markdown text={state.summary} live={false} />}
        {props.historical ? <Milestones state={state} /> : <TeamBoard state={props.state} />}
      </div>
    </details>
  );
}

function composerCopy(state: DevTeamSnapshot | null): { label: string; placeholder: string } {
  if (!state) return { label: 'Message the lead', placeholder: 'Describe what you want to make' };
  if (state.phase === 'spec-review') return { label: 'Message the lead', placeholder: 'Describe a revision…' };
  if (isTeamBoardPhase(state.phase)) return { label: 'Tell the team', placeholder: 'Tell the team…' };
  return { label: 'Message the lead', placeholder: 'Message the lead…' };
}

export function DevTeamPane() {
  const state = useApp((s) => s.devTeam);
  const permissionMode = useApp((s) => s.permissionMode);
  const copy = composerCopy(state);
  // A board needs something to draw. `planning` earns one because it says the
  // plan is being written; a run parked before a plan exists does not, and used
  // to render an empty grid over the conversation that explains it — which is
  // exactly what a person reopening an interrupted interview needs to read.
  const board = state ? isTeamBoardPhase(state.phase) && (state.plan !== null || state.phase === 'planning') : false;
  const done = state?.phase === 'done';
  const approvedSpec = state !== null && state.spec !== null && state.approvals.some(
    (approval) => approval.specVersion === state.specVersion,
  );

  return (
    <div className="devteam-pane">
      <PhaseHeader state={state} />
      <div className="devteam-scroll">
        {state && state.steering.length > 0 && (
          <p className="devteam-steering-note" role="status">
            {state.steering.length === 1
              ? 'One note is queued for the lead. It is folded in at the next review.'
              : `${state.steering.length} notes are queued for the lead. They are folded in at the next review.`}
          </p>
        )}
        {permissionMode === 'ask' && board && (
          <p className="devteam-ask-warning" role="status">
            Ask mode pauses engineers for each command and file change. Automatic mode is smoother for team runs.
          </p>
        )}
        {state && state.history.length > 0 && (
          <div className="devteam-history" aria-label="Completed dev team runs">
            {state.history.map((run) => <RunRecord key={run.runId} state={run} historical />)}
          </div>
        )}
        {state && approvedSpec && board && (
          <details className="devteam-spec-record">
            <summary>Approved specification v{state.specVersion}</summary>
            <div className="devteam-spec-record-body">
              <Markdown text={state.spec ?? ''} live={false} />
            </div>
          </details>
        )}
        {state?.error && <p className="devteam-error" role="alert">{state.error}</p>}
        {state?.phase === 'spec-review' ? (
          <div className="devteam-flow">
            <MessageList />
            <SpecReview state={state} />
          </div>
        ) : board ? (
          <TeamBoard state={state!} />
        ) : done ? (
          <div className="devteam-flow">
            <MessageList />
            <RunRecord state={state!} />
          </div>
        ) : (
          <MessageList />
        )}
      </div>
      <Composer
        label={copy.label}
        placeholder={copy.placeholder}
        attachmentDisabledReason={done ? undefined : 'Steering is text-only while the team is running.'}
      />
    </div>
  );
}
