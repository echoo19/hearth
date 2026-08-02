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
import { formatElapsed } from '../../chat/duration';
import { Icon } from '../ui';
import { Button } from '../ui/Button';
import { Composer } from './Composer';
import { Markdown } from './Markdown';
import { MessageList, MessageTurns } from './MessageList';
import { useElapsed } from './WorkingRow';

/**
 * The phases that are ONE lead turn, and so the ones where time passing with
 * nothing to show means the turn is not coming back.
 *
 * `building` is deliberately absent. It can legitimately run for a very long
 * time, and while it does there are engineer lanes on screen reporting what
 * they are doing, so the pane is not silent and the person is not stranded.
 */
const LEAD_TURN_PHASES = new Set<DevTeamSnapshot['phase']>([
  'interviewing',
  'drafting-spec',
  'planning',
  'reviewing',
  'wrapping',
]);

/**
 * How long a single lead turn may go without finishing before the pane offers
 * a way out of it.
 *
 * A clean planning turn measured about fifty seconds against a real provider.
 * Three minutes is comfortably longer than slow-but-working and far shorter
 * than the hour a hung turn will otherwise sit there for. It is a threshold for
 * OFFERING help, not for taking action: nothing is cancelled on its own.
 */
const STALL_AFTER_MS = 3 * 60 * 1000;

/**
 * The four handshakes a run passes through, in the order it passes them.
 *
 * "Specification" rather than "Spec" because the rail is a column with room
 * for the word, and the abbreviation only ever existed to fit a horizontal
 * strip that no longer exists.
 */
const STEPS = ['Interview', 'Specification', 'Build', 'Done'] as const;

/**
 * Which step is lit.
 *
 * `paused` and `interrupted` do not say where the run got to, and defaulting
 * them to Build told a run that hung during its INTERVIEW that it had reached
 * the build. What the snapshot does carry is how far the handshakes got: no
 * spec means the interview never finished, a spec with no plan means it was
 * waiting on the plan.
 */
function stepIndex(
  state: Pick<DevTeamSnapshot, 'phase' | 'spec' | 'plan' | 'approvals' | 'specVersion'> | null,
): number {
  const phase = state?.phase ?? 'idle';
  if (phase === 'idle' || phase === 'interviewing' || phase === 'drafting-spec') return 0;
  if (phase === 'spec-review') return 1;
  if (phase === 'done') return 3;
  if (phase === 'paused' || phase === 'interrupted') {
    if (!state?.spec) return 0;
    // Approval, not the plan, is what marks the end of the Specification step.
    // Keying on `plan` put a run that was interrupted while PLANNING back on
    // Specification, because planning is exactly the stretch where a spec is
    // approved and a plan does not exist yet. That is the longest a lead turn
    // ever runs, so it was also the state most likely to be looked at.
    if (!state.approvals.some((approval) => approval.specVersion === state.specVersion)) return 1;
  }
  return 2;
}

/**
 * The run's own column: how far it has got, what it is doing, and the two
 * controls that govern it.
 *
 * It was a horizontal strip above the board, and that strip was the reason the
 * board never read as a place where work is being managed. Four dotted words
 * in a row say "here is a progress bar"; a numbered column with the finished
 * steps ticked off says "here is a job, and here is where it is up to". The
 * horizontal version also had nowhere to put the phase name except beside the
 * steps, where it printed a fifth word in the same treatment as the four.
 *
 * The steps are numbered because a run has an ORDER that matters (you cannot
 * build before a spec is approved), and numbers state an order that four dots
 * only imply. A finished step trades its number for a tick, which is the one
 * moment the count stops being the useful fact about it.
 */
function RunRail({ state, elapsed }: { state: DevTeamSnapshot | null; elapsed: number | null }) {
  const pause = useApp((s) => s.pauseDevTeam);
  const resume = useApp((s) => s.resumeDevTeam);
  const stop = useApp((s) => s.stopDevTeam);
  const phase = state?.phase ?? 'idle';
  const active = stepIndex(state);
  const canPause = ['planning', 'building', 'reviewing', 'wrapping'].includes(phase);
  const canResume = phase === 'paused' || phase === 'interrupted';
  // Stop is offered for the whole life of a run, not just the phases that can
  // be paused. It used to be derived from those, which left an interview with
  // no control at all — and an interview is exactly where a lead turn can hang
  // with the board saying "Working" and climbing. A run you cannot stop is a
  // run that can strand. The runtime already accepts stop from every phase and
  // only ignores it when there is nothing running (see DevTeamRuntime.stop).
  const canStop = phase !== 'idle' && phase !== 'done';
  // Reviewing, wrapping, paused and interrupted all sit on the Build step, so
  // the phase name is the only thing that says which. When it merely repeats
  // the step it is attached to, it is printing the same word twice.
  const detail = devTeamPhaseLabel(phase) === STEPS[active] ? '' : devTeamPhaseLabel(phase);
  const counter = elapsed === null ? null : formatElapsed(elapsed);
  const finished = state?.tasks.filter((task) => task.status === 'done').length ?? 0;

  return (
    <aside className="devteam-rail" aria-label="Run status">
      <ol className="devteam-steps" aria-label="Dev team progress">
        {STEPS.map((step, index) => {
          const stepState = index < active ? 'done' : index === active ? 'current' : 'upcoming';
          return (
            <li key={step} data-state={stepState} aria-current={index === active ? 'step' : undefined}>
              <span className="devteam-step-mark" aria-hidden="true">
                {stepState === 'done' ? <Icon name="check" size={11} /> : index + 1}
              </span>
              <span className="devteam-step-body">
                <span className="devteam-step-name">{step}</span>
                {/* Only the step actually being worked carries a detail line,
                    so the column has exactly one place worth looking at. */}
                {stepState === 'current' && (detail || counter) && (
                  <span className="devteam-step-detail" role="status" aria-label="Dev team phase">
                    {detail}
                    {/* The counter is the fact the board was missing: it is what
                        tells a turn that is thinking apart from one that has
                        stopped. Not announced, because a screen reader reading a
                        stopwatch once a second is interruption, not
                        information. */}
                    {counter && (
                      <span className="devteam-step-clock" aria-hidden="true">
                        {detail ? ' · ' : ''}
                        {counter}
                      </span>
                    )}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {state && state.tasks.length > 0 && (
        <p className="devteam-rail-count">
          {finished} of {state.tasks.length} {state.tasks.length === 1 ? 'task' : 'tasks'} finished
        </p>
      )}
      {(canPause || canResume || canStop) && (
        <div className="devteam-controls">
          {canPause && (
            <Button size="sm" variant="quiet" icon="pause" aria-label="Pause dev team" onClick={pause}>
              Pause
            </Button>
          )}
          {canResume && (
            <Button size="sm" variant="primary" icon="play" aria-label="Resume dev team" onClick={resume}>
              Resume
            </Button>
          )}
          {canStop && (
            <Button size="sm" variant="danger" icon="stop" aria-label="Stop dev team" onClick={stop}>
              Stop
            </Button>
          )}
        </div>
      )}
    </aside>
  );
}

/**
 * How long the current phase has been running, ticking, or null when the run
 * is not in one or the state predates the field.
 */
function usePhaseElapsed(state: DevTeamSnapshot | null): number | null {
  const active = state !== null && LEAD_TURN_PHASES.has(state.phase);
  const elapsed = useElapsed(state?.phaseSince ?? undefined, active);
  // `useElapsed`'s active flag only decides whether the clock TICKS; it still
  // returns a duration for an inactive one. Returning that here would have
  // called a two hour build stalled and offered to recover a run whose
  // engineers were working the whole time.
  return active ? elapsed : null;
}

/**
 * The way out of a step that is not going to finish on its own.
 *
 * This exists because of a run that sat in `planning` for over an hour with a
 * complete, schema-valid plan.json already on disk. The pane said "The lead is
 * preparing the plan", which was not true, and offered Stop, which would have
 * thrown that plan away. The person had no way to tell a hung turn from a slow
 * one and nothing to press that would help.
 *
 * It says how long, states plainly that this is longer than it should be, and
 * offers the two real choices. It appears only after STALL_AFTER_MS, so a turn
 * that is merely taking its time is never nagged about.
 */
function StallNotice({ elapsed, phase }: { elapsed: number; phase: DevTeamSnapshot['phase'] }) {
  const recover = useApp((s) => s.recoverDevTeam);
  const stop = useApp((s) => s.stopDevTeam);
  const step = devTeamPhaseLabel(phase).toLowerCase();

  return (
    <section className="devteam-stall" role="status">
      <p className="devteam-stall-lead">
        <Icon name="warning" size={13} />
        The lead has been {step} for {formatElapsed(elapsed) ?? 'a while'} without finishing.
      </p>
      <p className="devteam-stall-body">
        A turn that runs this long has usually stopped responding rather than slowed down. Picking the run
        back up keeps whatever the team has already written to the project and carries on from it; if
        there is nothing usable yet, the run parks so you can run the step again.
      </p>
      <div className="devteam-stall-actions">
        <Button variant="primary" icon="restart" onClick={recover}>
          Pick the run back up
        </Button>
        <Button variant="danger" icon="stop" onClick={stop}>
          Stop the run
        </Button>
      </div>
    </section>
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
  // A lane with no prose to report falls back to its own status, which is the
  // word the activity column is already showing: "QUEUED   Queued". Two columns
  // saying one thing reads as two facts and is worth less than one.
  const observed = laneTail(messages, record);
  const tail = observed === activity ? '' : observed;
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
        {/* Who this lane is, as a glyph, tinted by how it is doing. One mark
            carries both facts: the shape says lead or engineer and the colour
            says running, waiting, finished or failed, so a column of lanes can
            be scanned without reading a word of it. It replaced a 7px dot that
            only ever carried the second half. */}
        <span className="devteam-lane-mark" aria-hidden="true">
          {/* Keyed off the task record, not the engineer id: a task that is
              planned but not yet dispatched has an empty engineer id and is
              still an engineer's lane. Only the lead has no record at all. */}
          <Icon name={record ? 'bot' : 'review'} size={13} />
        </span>
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

/**
 * The glyph a settled task wears in the plan. Only the outcomes that a person
 * would want to spot while scanning are here; `pending` and `running` are
 * deliberately absent, and fall back to the neutral dot the mark draws itself.
 */
const TASK_GLYPH: Partial<Record<DevTeamTaskRecord['status'], string>> = {
  done: 'check',
  error: 'hazard',
  interrupted: 'stop',
  waiting: 'warning',
};

/**
 * What the Plan region shows before there is a plan.
 *
 * It was one grey sentence at the top of an otherwise empty column, which told
 * you what was supposed to be happening and nothing about whether it still
 * was. The counter is the difference: a number that climbs says the run is
 * alive, and a number that has climbed too far is the thing the stall notice
 * then acts on.
 */
function PlanPending({ elapsed }: { elapsed: number | null }) {
  const counter = elapsed === null ? null : formatElapsed(elapsed);
  return (
    <p className="devteam-board-note">
      <span className="devteam-board-note-flame" aria-hidden="true">
        <Icon name="fire" size={13} />
      </span>
      The lead is writing the plan.
      {counter && (
        <span className="devteam-board-note-clock" aria-hidden="true">
          {counter}
        </span>
      )}
    </p>
  );
}

function Milestones({
  state,
  elapsed = null,
}: {
  state: Pick<DevTeamSnapshot, 'plan' | 'tasks' | 'currentMilestone'>;
  elapsed?: number | null;
}) {
  if (!state.plan) return <PlanPending elapsed={elapsed} />;
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
                  {/* A settled task says so with a glyph, which reads at a
                      glance down a list; one still to come keeps the neutral
                      dot, because "nothing has happened yet" is exactly what a
                      dot means and an icon would overstate it. */}
                  <span className="devteam-task-mark" aria-hidden="true">
                    {TASK_GLYPH[status] ? <Icon name={TASK_GLYPH[status]} size={10} /> : null}
                  </span>
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

function TeamBoard({ state, elapsed = null }: { state: DevTeamSnapshot; elapsed?: number | null }) {
  const messages = useApp((s) => s.messages);
  const lanes = useApp((s) => s.devTeamLanes);
  const roles = new Map(state.plan?.roles.map((role) => [role.id, role]));
  const tasks = new Map(state.plan?.milestones.flatMap((milestone) => milestone.tasks).map((task) => [task.id, task]));
  const activeAskEngineerId = state.tasks.find((record) =>
    pendingLaneAsk(lanes[record.engineerId] ?? []).count > 0,
  )?.engineerId;

  return (
    <div className="devteam-board">
      {/* Two named regions rather than two unlabelled lists. A console says
          what you are looking at before it shows it to you, and these two are
          genuinely different things: one is what was agreed, the other is what
          is happening. */}
      <h2 className="devteam-section">
        <Icon name="checkpoint" size={11} />
        Plan
      </h2>
      <Milestones state={state} elapsed={elapsed} />
      <h2 className="devteam-section">
        <Icon name="team" size={11} />
        Team
      </h2>
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
  const elapsed = usePhaseElapsed(state);
  const stalled = elapsed !== null && elapsed >= STALL_AFTER_MS;
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
      {/* Two columns, and only two. The run's state and its controls live in a
          fixed column on the left; everything the team produced lives in one
          scrolling column on the right, sharing a single left edge.

          The old shape was a full-width header strip over a two-column board
          whose LEFT column held the milestones. When there was no plan yet
          that column held one sentence, vertically centred against a lane list
          of one row, with the approved-specification fold floating above both
          on a third alignment — three things, three left edges, none of them
          agreeing, and a large empty area under all of it. Nothing was
          mis-positioned; there was just no column structure for anything to be
          positioned against. */}
      <div className="devteam-console">
        <RunRail state={state} elapsed={elapsed} />
        <div className="devteam-main">
        {stalled && state && <StallNotice elapsed={elapsed!} phase={state.phase} />}
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
            <summary>
              <Icon name="script" size={11} />
              Approved specification v{state.specVersion}
            </summary>
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
          <TeamBoard state={state!} elapsed={elapsed} />
        ) : done ? (
          <div className="devteam-flow">
            <MessageList />
            <RunRecord state={state!} />
          </div>
        ) : (
          <MessageList />
        )}
        </div>
      </div>
      <Composer
        label={copy.label}
        placeholder={copy.placeholder}
        attachmentDisabledReason={done ? undefined : 'Steering is text-only while the team is running.'}
      />
    </div>
  );
}
