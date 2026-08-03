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
 * The lead's own lane. It has no task record, so its state has to come from the
 * run's phase — "Available" would be a lie while a milestone is being built,
 * because the lead is watching it.
 *
 * The phase is named rather than flattened to one word. "Supervising" for every
 * phase of a team run meant the panel said the same thing for three hours while
 * the lead planned, watched, reviewed and wrote up, which is four different
 * jobs and the only place any of them was legible.
 */
export function devTeamLeadActivity(
  messages: readonly ChatMessage[],
  phase?: DevTeamPhase,
): string {
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
 * `wrapping` is a conversation phase, not a team one: the engineers have all
 * finished and the lead is writing the handoff into the transcript, so the
 * transcript is what should be on screen.
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
      return 'team';
    case 'paused':
    case 'interrupted':
      return state.plan ? 'team' : 'conversation';
    default:
      return 'conversation';
  }
}
