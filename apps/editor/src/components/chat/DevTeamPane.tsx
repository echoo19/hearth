import React, { useEffect, useState } from 'react';
import {
  devTeamActivity,
  devTeamLeadActivity,
  devTeamPhaseLabel,
  devTeamStage,
  devTeamTaskLabel,
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
 * time, and while it does there are engineers on screen reporting what they are
 * doing, so the pane is not silent and the person is not stranded.
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
 * A member of the team exists while it is on the job.
 *
 * `done` is absent on purpose: a finished engineer has nothing left to manage,
 * and leaving it on the board is what turned a sixteen-task run into a wall of
 * cards where thirteen of them said "QUEUED" and none of them were anybody.
 * `pending` is absent for the same reason from the other end — nobody has been
 * summoned for it yet. Both still appear in the plan, which is where a task
 * that is not a person belongs.
 *
 * `error` and `interrupted` stay. They are the ones that stopped without
 * finishing, which is exactly what a person managing the run has to see.
 */
const LIVE_STATUS = new Set<DevTeamTaskRecord['status']>(['running', 'waiting', 'error', 'interrupted']);

/** The lead's own entry id. Not a task id, and task ids cannot collide with it
 *  because the schema requires them to start with an alphanumeric. */
const LEAD_ID = '\u0000lead';

/** The one panel below the board, whichever member is being read. */
const PANEL_ID = 'devteam-log';

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
 * The three controls that govern a run, wherever it is being run from.
 *
 * Stop is offered for the whole life of a run, not just the phases that can be
 * paused. It used to be derived from those, which left an interview with no
 * control at all — and an interview is exactly where a lead turn can hang with
 * the pane saying "Working" and climbing. The runtime already accepts stop from
 * every phase and only ignores it when there is nothing running.
 */
function RunControls({ phase }: { phase: DevTeamSnapshot['phase'] }) {
  const pause = useApp((s) => s.pauseDevTeam);
  const resume = useApp((s) => s.resumeDevTeam);
  const stop = useApp((s) => s.stopDevTeam);
  const canPause = ['planning', 'building', 'reviewing', 'wrapping'].includes(phase);
  const canResume = phase === 'paused' || phase === 'interrupted';
  const canStop = phase !== 'idle' && phase !== 'done';
  if (!canPause && !canResume && !canStop) return null;

  return (
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
  );
}

/**
 * What a run looks like while it is still just a conversation.
 *
 * The interview and the specification are a chat and nothing more: one person
 * and one agent working out what to make. Everything the console needs to add
 * to that is a single line saying the lead is on it and offering the way out —
 * so that is all this is. A four-step progress rail over a two-message
 * conversation was describing a pipeline to someone who was still typing the
 * first sentence of it.
 */
function RunStrip({ phase, elapsed }: { phase: DevTeamSnapshot['phase']; elapsed: number | null }) {
  const counter = elapsed === null ? null : formatElapsed(elapsed);
  const parked = phase === 'paused' || phase === 'interrupted';

  return (
    <div className="devteam-strip">
      <span className="devteam-strip-state" data-parked={parked || undefined}>
        <span className="devteam-strip-pulse" aria-hidden="true" />
        <span role="status" aria-label="Dev team phase">{devTeamPhaseLabel(phase)}</span>
      </span>
      {counter && (
        <span className="devteam-strip-clock" aria-hidden="true">{counter}</span>
      )}
      <RunControls phase={phase} />
    </div>
  );
}

/**
 * The way out of a step that is not going to finish on its own.
 *
 * This exists because of a run that sat in `planning` for over an hour with a
 * complete, schema-valid plan.json already on disk. The pane said "The lead is
 * writing the plan", which was not true, and offered Stop, which would have
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
  // The phase labels are nouns — "Review", "Planning", "Wrapping up" — so the
  // sentence has to take one as a noun. Lowercasing one into a gerund slot
  // produced "The lead has been review for 17m 56s", which shipped.
  const step = devTeamPhaseLabel(phase);

  return (
    <section className="devteam-stall" role="status">
      <p className="devteam-stall-lead">
        <Icon name="warning" size={13} />
        The lead has not finished {step} after {formatElapsed(elapsed) ?? 'a long time'}.
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

/**
 * The lead, at the top of its own team.
 *
 * It is not one card among the others and must not look like one: it is the
 * agent you actually talk to, the one that hires and fires the rest, and the
 * only one still here from the interview. Pressing it puts the ordinary
 * conversation back in the panel below, which is what "click into the main
 * agent and chat with it" means.
 *
 * Its foot carries the two facts that belong to the run as a whole rather than
 * to any one member — how much of the plan is finished, and the controls that
 * govern it. Those sit outside the button, because a button inside a button is
 * not a thing a browser will render.
 */
function LeadPanel({
  phase,
  activity,
  tail,
  elapsed,
  asks,
  finished,
  total,
  selected,
  onSelect,
}: {
  phase: DevTeamSnapshot['phase'];
  activity: string;
  tail: string;
  elapsed: number | null;
  asks: number;
  finished: number;
  total: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const counter = elapsed === null ? null : formatElapsed(elapsed);
  const waiting = asks > 0 ? `, ${asks} waiting ${asks === 1 ? 'question' : 'questions'}` : '';
  const percent = total === 0 ? 0 : Math.round((finished / total) * 100);

  return (
    <section
      className="devteam-lead"
      data-phase={phase}
      data-selected={selected || undefined}
      // The lead is mid-turn, as opposed to watching a build that other people
      // are doing. Only then does its mark have anything to be lively about.
      data-live={elapsed !== null || undefined}
    >
      <button
        type="button"
        className="devteam-lead-main"
        aria-expanded={selected}
        aria-controls={PANEL_ID}
        aria-label={`Lead lane, Plan and review, ${activity}${tail ? `, ${tail}` : ''}${waiting}`}
        onClick={onSelect}
      >
        <span className="devteam-lead-mark" aria-hidden="true">
          <Icon name="review" size={16} />
        </span>
        <span className="devteam-lead-who">
          <strong>Lead</strong>
          <span>Plans the work, briefs the team, reviews what comes back</span>
        </span>
        <span className="devteam-lead-state">
          <span className="devteam-lane-activity">{activity}</span>
          {counter && <span className="devteam-lead-clock" aria-hidden="true">{counter}</span>}
        </span>
        {asks > 0 && (
          <span
            className="devteam-ask-badge"
            aria-label={`${asks} waiting ${asks === 1 ? 'question' : 'questions'}`}
          >
            {asks}
          </span>
        )}
      </button>
      <div className="devteam-lead-foot">
        {total > 0 && (
          <div className="devteam-progress">
            <span
              className="devteam-progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={finished}
              aria-label="Tasks finished"
            >
              <span className="devteam-progress-fill" style={{ width: `${percent}%` }} />
            </span>
            <span className="devteam-progress-text">
              {finished} of {total} {total === 1 ? 'task' : 'tasks'} finished
            </span>
          </div>
        )}
        <RunControls phase={phase} />
      </div>
    </section>
  );
}

/**
 * One engineer, as a card.
 *
 * They are headless: nothing they do is visible anywhere else in the app, and a
 * person managing them needs to see who is on the job, how each one is doing,
 * and then the actual log of one of them. The card carries every fact worth
 * scanning: who, what they are for, the state as a tracked-caps word, coloured,
 * the last thing observed, and whether they are waiting on an answer.
 */
function TeamCard({
  name,
  focus,
  status,
  activity,
  tail,
  asks,
  startedAt,
  selected,
  onSelect,
}: {
  name: string;
  focus?: string;
  status: DevTeamTaskRecord['status'];
  activity: string;
  tail: string;
  asks: number;
  startedAt?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  // How long this one has been at it. Every orchestration board worth using
  // carries a per-worker clock, and without one a card that is thinking and a
  // card that has wedged look exactly alike.
  const since = startedAt === undefined ? undefined : Date.parse(startedAt);
  const elapsed = useElapsed(Number.isNaN(since) ? undefined : since, status === 'running');
  const counter = status === 'running' && elapsed !== null ? formatElapsed(elapsed) : null;
  const waiting = asks > 0 ? `, ${asks} waiting ${asks === 1 ? 'question' : 'questions'}` : '';
  return (
    <button
      type="button"
      className="devteam-card"
      data-status={status}
      aria-expanded={selected}
      aria-controls={PANEL_ID}
      aria-label={`${name} lane${focus ? `, ${focus}` : ''}, ${activity}${tail ? `, ${tail}` : ''}${waiting}`}
      onClick={onSelect}
    >
      <span className="devteam-card-head">
        {/* One mark carries two facts: the shape says engineer and the tint says
            running, waiting or stopped, so a row of them can be scanned without
            reading a word. */}
        <span className="devteam-lane-mark" aria-hidden="true">
          <Icon name="bot" size={13} />
        </span>
        <span className="devteam-card-who">
          <strong>{name}</strong>
          {focus && <span>{focus}</span>}
        </span>
        {asks > 0 && (
          <span
            className="devteam-ask-badge"
            aria-label={`${asks} waiting ${asks === 1 ? 'question' : 'questions'}`}
          >
            {asks}
          </span>
        )}
      </span>
      <span className="devteam-card-foot">
        <span className="devteam-lane-activity">{activity}</span>
        {counter && <span className="devteam-lane-clock" aria-hidden="true">{counter}</span>}
      </span>
      {tail && <span className="devteam-lane-tail">{tail}</span>}
    </button>
  );
}

/**
 * The log of the one member currently being looked at.
 *
 * It sits under the board rather than inside a card, so choosing a different
 * member does not move the board under the pointer, and so a long transcript
 * cannot push the rest of the team off the screen above it. It is never empty:
 * something is always selected, and by default that is the lead, whose log is
 * the ordinary conversation.
 */
function MemberLog({
  name,
  subtitle,
  children,
}: {
  name: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="devteam-log" id={PANEL_ID} aria-label={`${name} log`}>
      <header className="devteam-log-head">
        <h3>{name}</h3>
        <span className="devteam-log-sub">{subtitle}</span>
      </header>
      <div className="devteam-log-body">{children}</div>
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

function Milestones({ state }: { state: Pick<DevTeamSnapshot, 'plan' | 'tasks' | 'currentMilestone'> }) {
  if (!state.plan) return null;
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
                <li key={task.id} data-status={status}>
                  {/* A settled task says so with a glyph, which reads at a
                      glance down a list; one still to come keeps the neutral
                      dot, because "nothing has happened yet" is exactly what a
                      dot means and an icon would overstate it. */}
                  <span className="devteam-task-mark" aria-hidden="true">
                    {TASK_GLYPH[status] ? <Icon name={TASK_GLYPH[status]} size={10} /> : null}
                  </span>
                  {/* What the task actually asks for. It lived only in a
                      native title= on this row, so it was hover-only, absent
                      on touch and unreachable from the keyboard, and it is the
                      only place the plan says what a one-line title means. */}
                  <span className="devteam-task-title">
                    {task.title}
                    {task.detail && <span className="devteam-task-detail">{task.detail}</span>}
                  </span>
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

/**
 * The board's own state, in a line.
 *
 * "3 on the job, 0 working" was what a run with three failed engineers said,
 * which is both true and useless: on the job is not a state anybody is in, and
 * a count of zero is not a fact worth printing. What a person wants from this
 * line is which of the three things is happening and to how many.
 */
function crewRollCall(crew: readonly { status: DevTeamTaskRecord['status'] }[]): string {
  const count = (status: DevTeamTaskRecord['status']) =>
    crew.filter((member) => member.status === status).length;
  const stopped = count('error') + count('interrupted');
  const parts = [
    count('running') > 0 ? `${count('running')} working` : null,
    count('waiting') > 0 ? `${count('waiting')} waiting on you` : null,
    stopped > 0 ? `${stopped} stopped` : null,
  ].filter((part): part is string => part !== null);
  return parts.join(' · ');
}

/**
 * Why nobody is on the board.
 *
 * An empty roster means four quite different things and a person cannot tell
 * them apart from the emptiness itself. The clock on the planning case is what
 * separates a lead that is thinking from one that has stopped, and it is the
 * fact the stall notice then acts on.
 */
function TeamEmpty({ state }: { state: DevTeamSnapshot }) {
  const parked = state.phase === 'paused' || state.phase === 'interrupted';
  const text = !state.plan
    ? 'The lead is writing the plan. The team appears here as it is brought on.'
    : parked
      ? 'The run is parked. Nobody is working until it is picked back up.'
      : state.phase === 'reviewing'
        ? 'Everyone has handed their work back. The lead is reviewing it.'
        : 'Nobody is on the job right now. Engineers appear here as the lead brings them on.';

  return (
    <p className="devteam-board-note">
      <span className="devteam-board-note-flame" aria-hidden="true">
        <Icon name={state.plan ? 'team' : 'fire'} size={13} />
      </span>
      {text}
    </p>
  );
}

/**
 * The screen a run turns into once its specification is approved.
 *
 * The lead is at the top and stays there; the engineers it has summoned sit
 * under it and leave when they are finished; whichever one is selected has its
 * log below. That shape is the whole point: the team is a thing the lead
 * assembles and dissolves as the build goes, and a board that kept every task
 * on it forever could not show that.
 */
function TeamStage({ state, elapsed }: { state: DevTeamSnapshot; elapsed: number | null }) {
  const messages = useApp((s) => s.messages);
  const lanes = useApp((s) => s.devTeamLanes);
  const approve = useApp((s) => s.approveEngineer);
  const answer = useApp((s) => s.answerEngineerInput);

  const roles = new Map(state.plan?.roles.map((role) => [role.id, role]));
  const tasks = new Map(state.plan?.milestones.flatMap((milestone) => milestone.tasks).map((task) => [task.id, task]));

  const leadAsks = pendingLaneAsk(messages);
  const leadActivity = devTeamLeadActivity(messages, state.phase);
  const leadObserved = laneTail(messages);

  const crew = state.tasks.filter((record) => LIVE_STATUS.has(record.status)).map((record) => {
    const task = tasks.get(record.taskId);
    const role = task ? roles.get(task.roleId) : undefined;
    const own = lanes[record.engineerId] ?? [];
    const asks = pendingLaneAsk(own);
    const activity = devTeamActivity(own, record.status);
    // A member with no prose to report falls back to its own status, which is
    // the word the state column is already showing: "WORKING  Working". Two
    // places saying one thing reads as two facts and is worth less than one.
    const observed = laneTail(own, record);
    return {
      // An engineer id only exists once the task is dispatched, and two of them
      // can share an empty one. The task id is unique by schema and stable for
      // the life of the run.
      id: record.taskId,
      name: task?.title ?? role?.name ?? 'Engineer',
      focus: role?.name ?? role?.focus,
      status: record.status,
      messages: own,
      engineerId: record.engineerId,
      startedAt: record.startedAt,
      activity,
      asks,
      tail: observed === activity ? '' : observed,
    };
  });

  const blocked = crew.find((member) => member.asks.count > 0);
  const blockedId = blocked?.id ?? null;
  const [picked, setPicked] = useState<string>(LEAD_ID);

  // An engineer that cannot proceed without an answer is the whole board's
  // business, so it shows itself. It does not PIN itself: someone who wants to
  // read a different log while one is waiting can still click away, and when
  // this one is settled the next blocked member takes its place.
  useEffect(() => {
    if (blockedId) setPicked(blockedId);
  }, [blockedId]);

  // Review is the lead's own turn, and its transcript is the thing worth
  // reading while it runs.
  useEffect(() => {
    if (state.phase === 'reviewing') setPicked(LEAD_ID);
  }, [state.phase]);

  // The selected engineer can finish and leave the board mid-read. Falling back
  // here rather than in an effect means there is never a frame with nothing
  // selected and no log at all.
  const selected = crew.find((member) => member.id === picked) ?? null;
  const finished = state.tasks.filter((task) => task.status === 'done').length;
  const roll = crewRollCall(crew);

  return (
    <div className="devteam-board">
      <LeadPanel
        phase={state.phase}
        activity={leadActivity}
        tail={leadObserved}
        elapsed={elapsed}
        asks={leadAsks.count}
        finished={finished}
        total={state.tasks.length}
        selected={selected === null}
        onSelect={() => setPicked(LEAD_ID)}
      />

      {/* Indented under the lead and joined to it by a guide line, because that
          is the actual relationship: these exist because the lead summoned
          them, and they leave when it is done with them. Two sibling sections
          of equal weight said the opposite. */}
      <div className="devteam-crew">
        <h2 className="devteam-section">
          <Icon name="team" size={11} />
          Team
          {roll && <span className="devteam-section-count">{roll}</span>}
        </h2>
        {crew.length > 0 ? (
          <div className="devteam-lanes" aria-label="Team activity">
            {crew.map((member) => (
              <TeamCard
                key={member.id}
                name={member.name}
                focus={member.focus}
                status={member.status}
                activity={member.activity}
                tail={member.tail}
                asks={member.asks.count}
                startedAt={member.startedAt}
                selected={member.id === picked}
                onSelect={() => setPicked(member.id)}
              />
            ))}
          </div>
        ) : (
          <TeamEmpty state={state} />
        )}
      </div>

      {state.plan && (
        <details className="devteam-plan-fold">
          <summary>
            <Icon name="checkpoint" size={11} />
            Plan
            <span>{state.tasks.length} {state.tasks.length === 1 ? 'task' : 'tasks'}</span>
          </summary>
          <Milestones state={state} />
        </details>
      )}

      {selected ? (
        <MemberLog name={selected.name} subtitle={selected.focus ?? 'Engineer'}>
          {selected.messages.length > 0 ? (
            <MessageTurns
              messages={selected.messages}
              className="devteam-lane-turns"
              controls={selected.engineerId ? {
                // Only one ask on the whole board may own Enter and Escape, and
                // it is the one being looked at: a shortcut that answers a
                // question offscreen is worse than no shortcut.
                activeApprovalId: selected.id === blockedId && selected.asks.active?.kind === 'approval'
                  ? selected.asks.active.id
                  : null,
                activeInputId: selected.id === blockedId && selected.asks.active?.kind === 'input'
                  ? selected.asks.active.id
                  : null,
                onApproval: (approvalId, decision, choiceId) =>
                  approve(selected.engineerId, approvalId, decision, choiceId),
                onInput: (inputId, action, answers) =>
                  answer(selected.engineerId, inputId, action, answers),
              } : undefined}
            />
          ) : (
            <p className="devteam-lane-empty">
              Nothing has been reported yet. This one is headless, so whatever it does shows up here.
            </p>
          )}
        </MemberLog>
      ) : (
        <MemberLog name="Lead" subtitle="Your conversation with the lead">
          <MessageList />
        </MemberLog>
      )}
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
        {/* The team has dissolved by the time this is read, so what is left to
            show is the plan with its outcomes on it, not a board of nobody. */}
        <Milestones state={state} />
      </div>
    </details>
  );
}

function composerCopy(state: DevTeamSnapshot | null): { label: string; placeholder: string } {
  if (!state) return { label: 'Message the lead', placeholder: 'Describe what you want to make' };
  if (state.phase === 'spec-review') return { label: 'Message the lead', placeholder: 'Describe a revision…' };
  if (devTeamStage(state) === 'team') return { label: 'Tell the team', placeholder: 'Tell the team…' };
  return { label: 'Message the lead', placeholder: 'Message the lead…' };
}

export function DevTeamPane() {
  const state = useApp((s) => s.devTeam);
  const permissionMode = useApp((s) => s.permissionMode);
  const elapsed = usePhaseElapsed(state);
  const stalled = elapsed !== null && elapsed >= STALL_AFTER_MS;
  const copy = composerCopy(state);
  const stage = devTeamStage(state);
  const phase = state?.phase ?? 'idle';
  const done = phase === 'done';
  const approvedSpec = state !== null && state.spec !== null && state.approvals.some(
    (approval) => approval.specVersion === state.specVersion,
  );

  return (
    // One column, and one only. A run is a conversation that grows a team in
    // the middle of it and loses the team again at the end, so the pane has two
    // shapes rather than one shape with a permanent chrome column beside it.
    // The four-step rail that used to sit there was describing a pipeline over
    // the top of whichever step you were actually in.
    <div className="devteam-pane" data-stage={stage}>
      <div className="devteam-main">
        {stage === 'conversation' && phase !== 'idle' && phase !== 'done' && (
          <RunStrip phase={phase} elapsed={elapsed} />
        )}
        {stalled && state && <StallNotice elapsed={elapsed!} phase={state.phase} />}
        {state && state.steering.length > 0 && (
          <p className="devteam-steering-note" role="status">
            {state.steering.length === 1
              ? 'One note is queued for the lead. It is folded in at the next review.'
              : `${state.steering.length} notes are queued for the lead. They are folded in at the next review.`}
          </p>
        )}
        {permissionMode === 'ask' && stage === 'team' && (
          <p className="devteam-ask-warning" role="status">
            Ask mode pauses engineers for each command and file change. Automatic mode is smoother for team runs.
          </p>
        )}
        {state && state.history.length > 0 && (
          <div className="devteam-history" aria-label="Completed dev team runs">
            {state.history.map((run) => <RunRecord key={run.runId} state={run} historical />)}
          </div>
        )}
        {state && approvedSpec && stage === 'team' && (
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
        {stage === 'team' ? (
          <TeamStage state={state!} elapsed={elapsed} />
        ) : (
          <div className="devteam-flow">
            <MessageList />
            {phase === 'spec-review' && <SpecReview state={state!} />}
            {done && <RunRecord state={state!} />}
          </div>
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
