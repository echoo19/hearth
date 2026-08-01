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

export function devTeamTaskLabel(status: DevTeamTaskRecord['status']): string {
  switch (status) {
    case 'running': return 'Working';
    case 'waiting': return 'Waiting for you';
    case 'done': return 'Finished';
    case 'error': return 'Stopped with an error';
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
      if (part.kind === 'approval' && part.decision === null) return 'Waiting for you';
      if (part.kind === 'input' && part.resolution === null) return 'Waiting for you';
    }
  }
  const part = lastPart(messages);
  if (taskStatus !== 'running') return devTeamTaskLabel(taskStatus);
  if (part?.kind === 'reasoning') return 'Thinking';
  if (part?.kind === 'file-change') return 'Editing files';
  if (part?.kind === 'command' && part.state === 'running') return 'Running a command';
  return 'Working';
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
