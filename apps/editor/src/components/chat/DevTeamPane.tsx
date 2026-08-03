import React, { useEffect, useState } from 'react';
import {
  DEV_TEAM_STEPS,
  devTeamActivity,
  devTeamLeadActivity,
  devTeamPhaseLabel,
  devTeamStage,
  devTeamStepStates,
  devTeamTaskLabel,
  pendingLaneAsk,
  teamNames,
} from '../../chat/devteam';
import { useApp } from '../../store';
import type { ChatMessage, DevTeamCompletedRun, DevTeamSnapshot, DevTeamTaskRecord } from '../../types';
import { formatElapsed } from '../../chat/duration';
import { FlameMark, Icon, Modal } from '../ui';
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
 * An agent is on the board once it exists, and stays there afterwards.
 *
 * `pending` is the one status that never appears. A task nobody has been
 * summoned for is not an agent yet, and treating it as one is what turned a
 * sixteen-task run into a wall of cards where thirteen said "QUEUED" and none
 * of them were anybody. Those live in the plan, which is where a task that is
 * not a person belongs.
 *
 * Everything else stays, finished included: the board's job is to say how each
 * agent is doing, and "done" is one of the answers.
 */
const BOARD_STATUS = new Set<DevTeamTaskRecord['status']>([
  'running', 'waiting', 'error', 'interrupted', 'done',
]);

/** The lead's own entry id. Not a task id, and task ids cannot collide with it
 *  because the schema requires them to start with an alphanumeric. */
const LEAD_ID = '\u0000lead';

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
        <FlameMark state={parked ? 'ember' : 'burn'} size={11} />
        <span role="status" aria-label="Dev team phase">{devTeamPhaseLabel(phase)}</span>
      </span>
      {counter && (
        <span className="devteam-strip-clock" aria-hidden="true">{counter}</span>
      )}
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


/**
 * One member of the team, as a square card.
 *
 * The lead gets the same card as everyone else, centred above them. It used to
 * be a wide elevated banner with the run's controls in its foot, which made it
 * a different KIND of thing from the people under it. It is not. It is the
 * agent at the top of the tree and the one you talk to, and position says that
 * on its own.
 *
 * Square because a board of them is scanned rather than read: a fixed shape
 * means the eye learns one layout once and then only reads what changed. Every
 * line clips. The card used to carry the last line its engineer said, in mono,
 * and that line escaped the card and ran clear across the board. A summary is
 * not a transcript, and the transcript is one press away.
 */
function AgentCard({
  name,
  role,
  assignment,
  status,
  activity,
  asks,
  startedAt,
  onOpen,
}: {
  name: string;
  role: string;
  /** What this one is on: its task, or the lead's standing job. */
  assignment: string;
  status: DevTeamTaskRecord['status'] | 'lead';
  activity: string;
  asks: number;
  startedAt?: string;
  onOpen: () => void;
}) {
  // How long this one has been at it. Every orchestration board worth using
  // carries a per-worker clock; without one, a card that is thinking and a card
  // that has wedged look exactly alike.
  const since = startedAt === undefined ? undefined : Date.parse(startedAt);
  const elapsed = useElapsed(Number.isNaN(since) ? undefined : since, status === 'running');
  const counter = status === 'running' && elapsed !== null ? formatElapsed(elapsed) : null;
  const waiting = asks > 0 ? `${asks} waiting ${asks === 1 ? 'question' : 'questions'}` : '';
  // The lead carries no role: "Lead" is the role, and "Lead / Tech lead" said
  // one thing twice in the two places on the card that are meant to say two.
  const label = [name, role, assignment, activity, waiting].filter(Boolean).join(', ');

  return (
    <button
      type="button"
      className="devteam-card"
      data-status={status}
      aria-label={label}
      onClick={onOpen}
    >
      <span className="devteam-card-mark" aria-hidden="true">
        {status === 'running'
          // Burning while it works, banked while it is blocked: an engineer
          // sitting on an unanswered question is not producing anything, and
          // the card should not look like it is.
          ? <FlameMark state={asks > 0 ? 'smoulder' : 'burn'} size={14} />
          : <Icon name={status === 'lead' ? 'review' : 'bot'} size={14} />}
      </span>
      <span className="devteam-card-name">{name}</span>
      {role && <span className="devteam-card-role">{role}</span>}
      <span className="devteam-card-task">{assignment}</span>
      <span className="devteam-card-state">
        <span className="devteam-card-status">{activity}</span>
        {counter && <span className="devteam-card-clock">{counter}</span>}
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
  );
}

/**
 * The glyph a settled task wears in the plan. Only the outcomes worth spotting
 * while scanning are here; `pending` and `running` are deliberately absent and
 * fall back to the neutral dot the mark draws itself.
 */
const TASK_GLYPH: Partial<Record<DevTeamTaskRecord['status'], string>> = {
  done: 'check',
  error: 'hazard',
  interrupted: 'stop',
  waiting: 'warning',
};

function Milestones({ state }: { state: Pick<DevTeamSnapshot, 'plan' | 'tasks' | 'currentMilestone'> }) {
  if (!state.plan) {
    return <p className="devteam-lane-empty">The lead has not written the plan yet.</p>;
  }
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
 * The run's own column, down the right-hand side.
 *
 * Four numbered steps, the two documents the run is built on, and the controls
 * that govern it. All of it is ABOUT the run rather than part of it, so it is
 * out of the reading column entirely: the board is what you look at, this is
 * what you reach for.
 *
 * A finished step trades its number for a tick and the one being worked trades
 * it for a spinner. A step still to come keeps its number, because the number
 * is the thing that says how much is left.
 */
function RunRail({
  state,
  finished,
  onPlan,
  onSpec,
}: {
  state: DevTeamSnapshot;
  finished: number;
  onPlan: () => void;
  onSpec: () => void;
}) {
  const steps = devTeamStepStates(state);

  return (
    <aside className="devteam-rail" aria-label="Run status">
      <ol className="devteam-steps" aria-label="Dev team progress">
        {DEV_TEAM_STEPS.map((step, index) => (
          <li
            key={step}
            data-state={steps[index]}
            aria-current={steps[index] === 'active' ? 'step' : undefined}
          >
            <span className="devteam-step-mark" aria-hidden="true">
              {steps[index] === 'done' && <Icon name="check" size={11} />}
              {steps[index] === 'active' && <FlameMark size={11} />}
              {steps[index] === 'waiting' && index + 1}
            </span>
            <span className="devteam-step-name">{step}</span>
          </li>
        ))}
      </ol>

      <div className="devteam-rail-docs">
        <Button size="sm" variant="quiet" icon="checkpoint" onClick={onPlan}>
          Plan
        </Button>
        <Button size="sm" variant="quiet" icon="script" onClick={onSpec} disabled={state.spec === null}>
          Specification
        </Button>
        {state.tasks.length > 0 && (
          <p className="devteam-rail-count">
            {finished} of {state.tasks.length} finished
          </p>
        )}
      </div>
    </aside>
  );
}

/**
 * Why nobody is on the board. An empty roster means four quite different things
 * and a person cannot tell them apart from the emptiness itself.
 */
function TeamEmpty({ state }: { state: DevTeamSnapshot }) {
  const parked = state.phase === 'paused' || state.phase === 'interrupted';
  const text = !state.plan
    ? 'The lead is writing the plan. The team appears here as it is brought on.'
    : parked
      ? 'The run is parked. Nobody is working until it is picked back up.'
      : state.phase === 'reviewing'
        ? 'Everyone has handed their work back. The lead is reviewing it.'
        : 'Nobody has been brought on yet. Engineers appear here as the lead summons them.';

  return <p className="devteam-board-note">{text}</p>;
}

interface Member {
  id: string;
  isLead: boolean;
  name: string;
  role: string;
  assignment: string;
  status: DevTeamTaskRecord['status'] | 'lead';
  activity: string;
  messages: readonly ChatMessage[];
  engineerId?: string;
  startedAt?: string;
  asks: ReturnType<typeof pendingLaneAsk>;
}

/**
 * One agent, opened.
 *
 * The whole board gives way to it rather than a log appearing underneath it,
 * because this is the point of the screen: a dev team run is an agent using
 * subagents, so going into the lead has to put you in the ordinary
 * conversation, with the ordinary composer under it and every ordinary control
 * in it working. A panel below a board is a preview of a conversation. This is
 * the conversation.
 */
function MemberView({
  member,
  keyboardActive,
  running,
  leadTurn,
  onBack,
}: {
  member: Member;
  keyboardActive: boolean;
  /** The team is still working, so anything typed is steering rather than a
   *  turn of its own, and a file cannot be handed to the lead mid-run. */
  running: boolean;
  /** The lead itself is mid-turn, so the box it carries offers Stop. */
  leadTurn: boolean;
  onBack: () => void;
}) {
  const approve = useApp((s) => s.approveEngineer);
  const answer = useApp((s) => s.answerEngineerInput);
  const stopRun = useApp((s) => s.stopDevTeam);
  const engineerId = member.engineerId;

  return (
    <section className="devteam-view" aria-label={`${member.name} log`}>
      <header className="devteam-view-head">
        {/* The app has one back affordance and it reads the same wherever it
            appears (.screen-back, screen.css). This is a way out of a member
            and into the board, which is the same kind of move. */}
        <button type="button" className="screen-back" aria-label="Back to the team" onClick={onBack}>
          <Icon name="chevron" size={13} />
          <span>Team</span>
        </button>
        <span className="devteam-view-who">
          <strong>{member.name}</strong>
          {member.role && <span>{member.role}</span>}
        </span>
        <span className="devteam-view-state" data-status={member.status}>{member.activity}</span>
      </header>
      <div className="devteam-view-body">
        {member.isLead ? (
          <MessageList />
        ) : (
          <div className="devteam-lane-scroll">
            {member.messages.length > 0 ? (
              <MessageTurns
                messages={member.messages}
                className="devteam-lane-turns"
                controls={engineerId ? {
                  activeApprovalId: keyboardActive && member.asks.active?.kind === 'approval'
                    ? member.asks.active.id
                    : null,
                  activeInputId: keyboardActive && member.asks.active?.kind === 'input'
                    ? member.asks.active.id
                    : null,
                  onApproval: (approvalId, decision, choiceId) =>
                    approve(engineerId, approvalId, decision, choiceId),
                  onInput: (inputId, action, answers) =>
                    answer(engineerId, inputId, action, answers),
                } : undefined}
              />
            ) : (
              <p className="devteam-lane-empty">
                Nothing has been reported yet. This one is headless, so whatever it does shows up here.
              </p>
            )}
          </div>
        )}
      </div>
      {/* Opening the lead IS the ordinary conversation, so it has the ordinary
          composer under it. The board does not: it is a status board, and
          nothing on it is a thing you talk to. Neither does an engineer, which
          is headless and read-only apart from the asks in its own log. */}
      {member.isLead && (
        <Composer
          label="Message the lead"
          placeholder="Message the lead…"
          attachmentDisabledReason={running ? 'Steering is text-only while the team is running.' : undefined}
          running={leadTurn}
          onStop={stopRun}
        />
      )}
    </section>
  );
}

/**
 * The board's own state, in a line.
 *
 * "3 on the job, 0 working" was what a run with three failed engineers said,
 * which is both true and useless: on the job is not a state anybody is in, and
 * a count of zero is not a fact worth printing.
 */
function crewRollCall(crew: readonly Member[]): string {
  // Blocked is counted off the pending ask rather than off the task status: a
  // task whose engineer is sitting on an unanswered approval is still `running`
  // as far as the runtime is concerned, and counting it as working is how a
  // board tells you everything is fine while nothing is moving.
  const blocked = crew.filter((member) => member.asks.count > 0 || member.status === 'waiting');
  const stopped = crew.filter((member) => member.status === 'error' || member.status === 'interrupted');
  const working = crew.filter((member) => member.status === 'running' && member.asks.count === 0);
  const done = crew.filter((member) => member.status === 'done');
  return [
    working.length > 0 ? `${working.length} working` : null,
    blocked.length > 0 ? `${blocked.length} needs you` : null,
    stopped.length > 0 ? `${stopped.length} stopped` : null,
    done.length > 0 ? `${done.length} done` : null,
  ].filter((part): part is string => part !== null).join(' · ');
}

/**
 * The screen a run turns into once its specification is approved.
 *
 * The lead centred at the top, the engineers it has summoned in a grid under
 * it, and the run's own column down the right. Opening anybody replaces the
 * board with them, and there is one way back.
 */
function TeamStage({ state, elapsed }: { state: DevTeamSnapshot; elapsed: number | null }) {
  const messages = useApp((s) => s.messages);
  const lanes = useApp((s) => s.devTeamLanes);
  const [opened, setOpened] = useState<string | null>(null);
  const [showing, setShowing] = useState<'plan' | 'spec' | null>(null);

  const roles = new Map(state.plan?.roles.map((role) => [role.id, role]));
  const tasks = new Map(state.plan?.milestones.flatMap((milestone) => milestone.tasks).map((task) => [task.id, task]));
  // Named over every task in the run rather than only the ones on the board, so
  // a name never moves to somebody else as people come and go.
  const names = teamNames(state.tasks.map((record) => record.taskId));

  const lead: Member = {
    id: LEAD_ID,
    isLead: true,
    name: 'Lead',
    role: '',
    assignment: 'Plans the work and reviews it',
    status: 'lead',
    activity: devTeamLeadActivity(messages, state.phase),
    messages,
    asks: pendingLaneAsk(messages),
  };

  const crew: Member[] = state.tasks
    .filter((record) => BOARD_STATUS.has(record.status))
    .map((record) => {
      const task = tasks.get(record.taskId);
      const role = task ? roles.get(task.roleId) : undefined;
      const own = lanes[record.engineerId] ?? [];
      return {
        // An engineer id only exists once the task is dispatched, and two of
        // them can share an empty one. The task id is unique by schema and
        // stable for the life of the run.
        id: record.taskId,
        isLead: false,
        name: names.get(record.taskId) ?? 'Engineer',
        role: role?.name ?? 'Engineer',
        assignment: task?.title ?? 'Unassigned',
        status: record.status,
        activity: devTeamActivity(own, record.status),
        messages: own,
        engineerId: record.engineerId,
        startedAt: record.startedAt,
        asks: pendingLaneAsk(own),
      };
    });

  const blockedId = crew.find((member) => member.asks.count > 0)?.id ?? null;
  const members = [lead, ...crew];
  // Whoever is open can finish and leave the board mid-read; falling back here
  // rather than in an effect means there is never a frame showing nobody.
  const open = members.find((member) => member.id === opened) ?? null;
  const finished = state.tasks.filter((task) => task.status === 'done').length;
  const roll = crewRollCall(crew);
  const closeDoc = (doc: 'plan' | 'spec') => () =>
    setShowing((current) => (current === doc ? null : current));

  return (
    <div className="devteam-team">
      <div className="devteam-stage" data-view={open ? 'member' : 'board'}>
        {open ? (
          <MemberView
            member={open}
            running={state.phase !== 'paused' && state.phase !== 'interrupted'}
            leadTurn={LEAD_TURN_PHASES.has(state.phase)}
            // Only one ask in the whole run may own Enter and Escape, and it is
            // the one being looked at: a shortcut that answers a question
            // offscreen is worse than no shortcut.
            keyboardActive={open.id === blockedId}
            onBack={() => setOpened(null)}
          />
        ) : (
          <div className="devteam-board">
            {elapsed !== null && elapsed >= STALL_AFTER_MS && (
              <StallNotice elapsed={elapsed} phase={state.phase} />
            )}
            {state.error && <p className="devteam-error" role="alert">{state.error}</p>}
            <div className="devteam-lead-slot">
              <AgentCard
                name={lead.name}
                role={lead.role}
                assignment={lead.assignment}
                status="lead"
                activity={lead.activity}
                asks={lead.asks.count}
                onOpen={() => setOpened(LEAD_ID)}
              />
            </div>
            <div className="devteam-crew">
              <h2 className="devteam-section">
                <Icon name="team" size={11} />
                Team
                {roll && <span className="devteam-section-count">{roll}</span>}
              </h2>
              {crew.length > 0 ? (
                <div className="devteam-lanes" aria-label="Team activity">
                  {crew.map((member) => (
                    <AgentCard
                      key={member.id}
                      name={member.name}
                      role={member.role}
                      assignment={member.assignment}
                      status={member.status}
                      activity={member.activity}
                      asks={member.asks.count}
                      startedAt={member.startedAt}
                      onOpen={() => setOpened(member.id)}
                    />
                  ))}
                </div>
              ) : (
                <TeamEmpty state={state} />
              )}
            </div>
          </div>
        )}
      </div>

      <RunRail
        state={state}
        finished={finished}
        onPlan={() => setShowing('plan')}
        onSpec={() => setShowing('spec')}
      />

      {/* Each dialog only clears the state it owns. Both are mounted at once, so
          opening the second closes the first, whose own close handler would
          otherwise fire second and clear the choice that had just been made:
          pressing Specification while Plan was open opened nothing at all. */}
      <Modal open={showing === 'plan'} title="Plan" className="is-wide" onClose={closeDoc('plan')}>
        <div className="devteam-doc">
          <Milestones state={state} />
        </div>
      </Modal>
      <Modal
        open={showing === 'spec'}
        title={`Specification v${state.specVersion}`}
        className="is-wide"
        onClose={closeDoc('spec')}
      >
        <div className="devteam-doc">
          <Markdown text={state.spec ?? 'There is no specification yet.'} live={false} />
        </div>
      </Modal>
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
  return { label: 'Message the lead', placeholder: 'Message the lead…' };
}

export function DevTeamPane() {
  const state = useApp((s) => s.devTeam);
  const stopRun = useApp((s) => s.stopDevTeam);
  const elapsed = usePhaseElapsed(state);
  const stalled = elapsed !== null && elapsed >= STALL_AFTER_MS;
  const copy = composerCopy(state);
  const stage = devTeamStage(state);
  const phase = state?.phase ?? 'idle';
  const done = phase === 'done';

  return (
    // One column, and one only. A run is a conversation that grows a team in
    // the middle of it and loses the team again at the end, so the pane has two
    // shapes rather than one shape with a permanent chrome column beside it.
    // The four-step rail that used to sit there was describing a pipeline over
    // the top of whichever step you were actually in.
    <div className="devteam-pane" data-stage={stage}>
      {stage === 'team' ? (
        <TeamStage state={state!} elapsed={elapsed} />
      ) : (
      <div className="devteam-main">
        {phase !== 'idle' && phase !== 'done' && <RunStrip phase={phase} elapsed={elapsed} />}
        {stalled && state && <StallNotice elapsed={elapsed!} phase={state.phase} />}
        {state && state.history.length > 0 && (
          <div className="devteam-history" aria-label="Completed dev team runs">
            {state.history.map((run) => <RunRecord key={run.runId} state={run} historical />)}
          </div>
        )}
        {state?.error && <p className="devteam-error" role="alert">{state.error}</p>}
        <div className="devteam-flow">
          <MessageList />
          {phase === 'spec-review' && <SpecReview state={state!} />}
          {done && <RunRecord state={state!} />}
        </div>
      </div>
      )}
      {/* The board and an engineer's log have no composer: neither is a thing
          you talk to. The lead's own view brings one with it. */}
      {/* Stop lives here and nowhere else. The strip over the conversation used
          to carry its own pair of buttons, which put the run's one destructive
          control somewhere different from the Stop every other conversation in
          the app has, and left the box below it showing Send while a turn ran.
          The run's Stop is the RUN's, not the turn's: it parks the run, keeps
          the plan and the transcripts, and withdraws whatever the engineers
          were waiting on. */}
      {stage === 'conversation' && (
        <Composer
          label={copy.label}
          placeholder={copy.placeholder}
          attachmentDisabledReason={done ? undefined : 'Steering is text-only while the team is running.'}
          running={LEAD_TURN_PHASES.has(phase)}
          onStop={stopRun}
        />
      )}
    </div>
  );
}
