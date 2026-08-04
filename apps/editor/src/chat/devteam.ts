import type { ChatMessage, ChatPart, DevTeamPhase, DevTeamSnapshot, DevTeamTaskRecord } from '../types';

const PHASE_LABEL: Record<DevTeamPhase, string> = {
  idle: 'Ready',
  interviewing: 'Interview',
  'drafting-spec': 'Drafting spec',
  'spec-review': 'Spec review',
  planning: 'Planning',
  building: 'Build',
  reviewing: 'Review',
  wrapping: 'Wrapping up',
  done: 'Done',
  paused: 'Paused',
  interrupted: 'Interrupted',
};

export function devTeamPhaseLabel(phase: DevTeamPhase): string {
  return PHASE_LABEL[phase];
}

/**
 * How a task is doing, in as few words as it takes.
 *
 * These are read as chips: tracked caps on a card, and sixteen rows deep in
 * the plan. "Stopped with an error" set that way ran 150px across a 316px card
 * and printed itself down the whole plan, which is a sentence doing a label's
 * job. Every comparable board — a CI run, a deploy, an issue tracker — says
 * this in one or two words, and the card's red ring already carries the alarm.
 */
export function devTeamTaskLabel(status: DevTeamTaskRecord['status']): string {
  switch (status) {
    case 'running': return 'Working';
    case 'waiting': return 'Needs you';
    case 'done': return 'Finished';
    case 'error': return 'Failed';
    case 'interrupted': return 'Interrupted';
    default: return 'Queued';
  }
}

function lastPart(messages: readonly ChatMessage[]): ChatPart | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const parts = messages[messageIndex].parts;
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return undefined;
}

export function devTeamActivity(
  messages: readonly ChatMessage[],
  taskStatus: DevTeamTaskRecord['status'] = 'running',
): string {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind === 'approval' && part.decision === null) return 'Needs you';
      if (part.kind === 'input' && part.resolution === null) return 'Needs you';
    }
  }
  const part = lastPart(messages);
  if (taskStatus !== 'running') return devTeamTaskLabel(taskStatus);
  if (part?.kind === 'reasoning') return 'Thinking';
  if (part?.kind === 'file-change') return 'Editing files';
  if (part?.kind === 'command' && part.state === 'running') return 'Running a command';
  return 'Working';
}

/**
 * Which flame an agent wears, from what it is doing.
 *
 * Burning means producing; banked means the fuel is there and nothing is
 * coming off it. Thinking and blocked are both the second kind, and the board
 * said so in words while the mark beside them burned — a card reading THINKING
 * under a licking flame is the picture disagreeing with the caption.
 *
 * Keyed on the activity word rather than on the task status because the status
 * cannot tell these apart: an engineer mid-thought and an engineer sitting on
 * an unanswered question are both `running` to the runtime.
 */
export function devTeamFlame(activity: string): 'burn' | 'smoulder' {
  return activity === 'Thinking' || activity === 'Needs you' ? 'smoulder' : 'burn';
}

/**
 * The lead's own lane. It has no task record, so its state has to come from the
 * run's phase — "Available" would be a lie while a milestone is being built,
 * because the lead is watching it.
 *
 * The phase is named rather than flattened to one word. "Supervising" for every
 * phase of a team run meant the panel said the same thing for three hours while
 * the lead planned, watched, reviewed and wrote up, which is four different
 * jobs and the only place any of them was legible.
 *
 * An unanswered question outranks all of it, exactly as it does for an
 * engineer. The phase does not change while the lead sits on one, so a run
 * stalled on an approval nobody had seen read "Planning" for as long as it was
 * left there — the one card on the board that was waiting on the person looking
 * at it was the one card claiming to be busy.
 */
export function devTeamLeadActivity(
  messages: readonly ChatMessage[],
  phase?: DevTeamPhase,
): string {
  if (pendingLaneAsk(messages).count > 0) return 'Needs you';
  if (messages.some((message) => message.streaming)) return 'Working';
  switch (phase) {
    case 'planning': return 'Planning';
    case 'building': return 'Supervising';
    case 'reviewing': return 'Reviewing';
    case 'wrapping': return 'Wrapping up';
    case 'paused': return 'Paused';
    case 'interrupted': return 'Stopped';
    default: return 'Available';
  }
}

export function pendingLaneAsk(messages: readonly ChatMessage[]): {
  active: { kind: 'approval' | 'input'; id: string } | null;
  count: number;
} {
  let active: { kind: 'approval' | 'input'; id: string } | null = null;
  let count = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind === 'approval' && part.decision === null) {
        active ??= { kind: 'approval', id: part.id };
        count += 1;
      }
      if (part.kind === 'input' && part.resolution === null) {
        active ??= { kind: 'input', id: part.id };
        count += 1;
      }
    }
  }
  return { active, count };
}

export function devTeamSidebarAnnotation(snapshot: DevTeamSnapshot | null): string | null {
  if (!snapshot) return null;
  const working = snapshot.tasks.filter((task) => task.status === 'running').length;
  if (snapshot.phase === 'building') return `building · ${working} working`;
  if (snapshot.phase === 'reviewing') return 'reviewing milestone';
  if (snapshot.phase === 'paused') return 'paused';
  if (snapshot.phase === 'interrupted') return 'interrupted';
  return null;
}

export function isTeamBoardPhase(phase: DevTeamPhase): boolean {
  return ['planning', 'building', 'reviewing', 'wrapping', 'paused', 'interrupted'].includes(phase);
}

/**
 * Which of the two shapes the pane takes.
 *
 * A dev team run is a conversation that grows a team in the middle of it and
 * loses it again at the end, and those are genuinely different screens rather
 * than one screen with a switch on it:
 *
 * - `conversation` — the interview and the specification, which are one person
 *   and one agent working something out, and the closing report, by which time
 *   the team has dissolved and the lead is the only one left to talk to.
 * - `team` — everything between the approval and the report, when there is a
 *   lead with engineers under it and the run is a thing being managed.
 *
 * `wrapping` is a team phase. It was a conversation one, on the reasoning that
 * the engineers had finished and the lead was writing the handoff, so the
 * transcript should be on screen — but that put the run's last visible act,
 * the build finishing, on the one screen with no steps on it. The board is
 * where the work is reported, so the work finishing is reported there: every
 * engineer settles to Finished and the rail moves off Build and onto Done.
 * The report is what ends it, and the report is a conversation.
 *
 * A parked run goes wherever it was parked. Without a plan there was never a
 * team, and showing an empty board over the interview that explains why is
 * exactly the wrong way round.
 */
export function devTeamStage(
  state: Pick<DevTeamSnapshot, 'phase' | 'plan'> | null,
): 'conversation' | 'team' {
  if (!state) return 'conversation';
  switch (state.phase) {
    case 'planning':
    case 'building':
    case 'reviewing':
    case 'wrapping':
      return 'team';
    case 'paused':
    case 'interrupted':
      return state.plan ? 'team' : 'conversation';
    default:
      return 'conversation';
  }
}

/**
 * The names the team is drawn from.
 *
 * A headless engineer with no name is a task with a robot beside it, and a
 * board of those reads as a queue rather than as people doing work. Short,
 * one word, and drawn from a wide enough spread that a run of six does not
 * look like a set. They are labels for the person managing the run, not
 * claims about who anybody is: the ROLE is the real fact on the card, and it
 * comes from the plan.
 */
const TEAM_NAMES = [
  'Ada', 'Arlo', 'Bex', 'Bo', 'Cass', 'Cyra', 'Dara', 'Dov',
  'Eli', 'Esme', 'Faye', 'Fen', 'Gia', 'Gus', 'Hana', 'Hollis',
  'Ines', 'Ivo', 'Jae', 'June', 'Kai', 'Kit', 'Lark', 'Lena',
  'Marek', 'Mira', 'Nils', 'Noor', 'Odile', 'Oren', 'Petra', 'Pia',
  'Quinn', 'Rai', 'Rune', 'Sable', 'Suri', 'Thea', 'Tova', 'Uma',
  'Vero', 'Vidar', 'Wren', 'Wynn', 'Yuki', 'Zara', 'Zoe', 'Xan',
] as const;

/** FNV-1a, so a task id lands on the same name on every machine and in every
 *  session. Nothing here may depend on render order or on the clock. */
function hashId(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * One name per task, stable for the life of the run and unique within it.
 *
 * Keyed on the task id rather than the engineer id: an engineer id only exists
 * once the task is dispatched, and two tasks waiting to start share an empty
 * one, so naming by engineer would rename people as the build went on.
 *
 * Assignment walks the tasks in plan order and probes forward from the hashed
 * slot, so it is a pure function of the task ids and nothing else.
 */
export function teamNames(taskIds: readonly string[]): Map<string, string> {
  const taken = new Set<number>();
  const names = new Map<string, string>();
  for (const taskId of taskIds) {
    let slot = hashId(taskId) % TEAM_NAMES.length;
    for (let probe = 0; probe < TEAM_NAMES.length && taken.has(slot); probe += 1) {
      slot = (slot + 1) % TEAM_NAMES.length;
    }
    taken.add(slot);
    names.set(taskId, TEAM_NAMES[slot]);
  }
  return names;
}

/**
 * Which of the run's four steps is where, for the rail.
 *
 * `active` is the one being worked and wears a spinner; `waiting` is still to
 * come and wears its number. A parked run has no active step: nothing is
 * turning, so nothing should look like it is.
 */
export const DEV_TEAM_STEPS = ['Interview', 'Specification', 'Build', 'Done'] as const;

export function devTeamStepStates(
  state: Pick<DevTeamSnapshot, 'phase' | 'spec' | 'approvals' | 'specVersion'> | null,
): ('done' | 'active' | 'waiting')[] {
  const phase = state?.phase ?? 'idle';
  const parked = phase === 'paused' || phase === 'interrupted';
  // Where the run got to. `paused` and `interrupted` do not say, so the
  // handshakes do: no spec means the interview never finished, and a spec
  // nobody has approved means it was still waiting on that.
  let reached: number;
  if (phase === 'idle' || phase === 'interviewing' || phase === 'drafting-spec') reached = 0;
  else if (phase === 'spec-review') reached = 1;
  // Wrapping up is not part of the build. The engineers have all finished and
  // the lead is writing the report, so the rail says the build is done and the
  // last step is the one running: the rail sitting on Build while every card on
  // the board said Finished was the run's own progress bar disagreeing with it.
  else if (phase === 'wrapping' || phase === 'done') reached = 3;
  else if (parked && !state?.spec) reached = 0;
  else if (parked && !state?.approvals.some((a) => a.specVersion === state.specVersion)) reached = 1;
  else reached = 2;

  return DEV_TEAM_STEPS.map((_, index) => {
    if (index < reached) return 'done';
    if (index > reached) return 'waiting';
    if (phase === 'done') return 'done';
    return parked ? 'waiting' : 'active';
  });
}
