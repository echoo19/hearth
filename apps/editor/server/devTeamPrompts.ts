/**
 * Every prompt Hearth composes for a Dev Team run — the lead's interview,
 * revision, plan, repair, review and wrap turns, and each engineer's single
 * task turn.
 *
 * They live apart from devTeamRuntime.ts because what the team is TOLD and how
 * the team is RUN change for different reasons and at different times: the
 * runtime is a state machine with a test suite about transitions, and this file
 * is writing. Keeping them together made every wording change a diff against
 * the scheduler.
 *
 * Nothing here reads the filesystem or holds state. Every function takes what
 * it needs and returns a string, which is what makes the wording testable.
 */
import type { DevTeamPlan, DevTeamTaskRecord } from './devTeamStore.js';

type DevTeamRole = DevTeamPlan['roles'][number];
type DevTeamTask = DevTeamPlan['milestones'][number]['tasks'][number];

export interface EngineerPromptInput {
  spec: string;
  role: DevTeamRole;
  task: DevTeamTask;
  dependencies: DevTeamTaskRecord[];
  context: string;
}

function runPath(chatId: string, file: string): string {
  return `.hearth/devteam/${chatId}/${file}`;
}

export function buildInterviewPrompt(chatId: string, request: string): string {
  return [
    'You are the lead for a small development team. Work in a provider-neutral, project-appropriate way.',
    'Briefly interview the person only where the request leaves a material decision open. Adapt to the detail already provided; a complete brief may need no questions.',
    'Use a structured question tool when useful, while keeping prose questions valid. Do not assume a genre, dimension, engine, role, or input method.',
    `When the brief is ready, write the complete specification to ${runPath(chatId, 'spec.md')} and end the turn. Do not put the specification in a different file.`,
    '',
    'Initial request:',
    request,
  ].join('\n');
}

export function buildRevisionPrompt(chatId: string, revision: string, steering = ''): string {
  return [
    `Revise and rewrite ${runPath(chatId, 'spec.md')} to incorporate the person's feedback below.`,
    'Preserve decisions that were not changed, keep the specification project-appropriate and genre-neutral, then end the turn.',
    '',
    'Revision request:',
    revision,
    ...(steering ? ['', 'Earlier queued direction:', steering] : []),
  ].join('\n');
}

export function buildInterviewResumePrompt(chatId: string, steering = ''): string {
  return [
    'Continue the interrupted interview from the conversation context. Ask only for material decisions that are still missing.',
    `When the brief is ready, write the complete specification to ${runPath(chatId, 'spec.md')} and end the turn.`,
    'Remain project-appropriate and do not assume a genre, dimension, engine, role, or input method.',
    ...(steering ? ['', 'New direction from the person:', steering] : []),
  ].join('\n');
}

export function buildPlanPrompt(chatId: string, spec: string, steering = ''): string {
  return [
    'Create the smallest capable team and an executable milestone plan for the approved specification below.',
    'Invent roles for this project; do not use a fixed organization chart. Keep tasks focused, dependencies explicit, scopes safe relative path prefixes, and effort low, medium, or high only when useful.',
    `Write only schema version 1 plan JSON to ${runPath(chatId, 'plan.json')}, then end the turn. The runtime validates the file; prose is not the handshake.`,
    '',
    'Approved specification:',
    spec,
    ...(steering ? ['', 'New direction from the person:', steering] : []),
  ].join('\n');
}

export function buildPlanRepairPrompt(chatId: string, error: string, steering = ''): string {
  return [
    `The plan at ${runPath(chatId, 'plan.json')} is invalid: ${error}`,
    'Correct that same file as schema version 1 JSON. Keep roles project-specific, dependencies valid, and scopes safe relative path prefixes, then end the turn.',
    ...(steering ? ['', 'New direction from the person:', steering] : []),
  ].join('\n');
}

export function buildEngineerPrompt(input: EngineerPromptInput): string {
  const scope = input.task.scope?.length ? input.task.scope.join(', ') : 'No scope was declared; this turn runs exclusively.';
  const dependencies = input.dependencies.length
    ? input.dependencies
        .map((record) => `- ${record.taskId}: ${record.summary ?? 'completed without a prose handoff'}${record.files?.length ? `; files: ${record.files.join(', ')}` : ''}`)
        .join('\n')
    : '- None.';
  return [
    `You are the ${input.role.name}. Your focus: ${input.role.focus}`,
    'Complete exactly one assigned task in the current project. Work with what is present, decide reasonable implementation details yourself, and do not ask the lead to choose routine details.',
    '',
    'Approved specification:',
    input.spec,
    '',
    `Task: ${input.task.title}`,
    input.task.detail,
    `Scope: ${scope}`,
    '',
    'Dependency handoffs:',
    dependencies,
    '',
    'Current project context:',
    input.context || 'No earlier task handoffs yet.',
    '',
    'Finish with a short factual handoff summarizing what you changed, checks you actually ran, and any known gap. Do not claim results you did not observe.',
  ].join('\n');
}

export function buildReviewPrompt(
  plan: DevTeamPlan,
  milestoneIndex: number,
  records: DevTeamTaskRecord[],
  steering = '',
): string {
  const milestone = plan.milestones[milestoneIndex];
  const taskIds = new Set(milestone?.tasks.map((task) => task.id) ?? []);
  const handoffs = records
    .filter((record) => taskIds.has(record.taskId))
    .map(
      (record) =>
        `- ${record.taskId} [${record.status}]: ${record.summary ?? 'no completed prose observed'}${record.files?.length ? `; observed files: ${record.files.join(', ')}` : ''}`,
    )
    .join('\n');
  return [
    `Review milestone ${milestoneIndex + 1}: ${milestone?.title ?? 'Milestone'}.`,
    'Assess only the observed handoffs and repository state. Run checks if needed. You may amend future milestones by rewriting the existing plan.json, but do not rewrite completed or running work. End with a concise factual review.',
    '',
    'Task outcomes:',
    handoffs || '- No task outcome was observed.',
    ...(steering ? ['', 'Steering from the person:', steering] : []),
  ].join('\n');
}

export function buildWrapPrompt(plan: DevTeamPlan, steering = ''): string {
  return [
    'Write the closing handoff for this run using only the work and checks actually observed.',
    'Summarize what was built, how to use or experience it, and known gaps. Keep it appropriate to this project and do not invent verification results.',
    `The plan contained ${plan.milestones.length} milestone${plan.milestones.length === 1 ? '' : 's'}.`,
    ...(steering ? ['', 'Steering from the person:', steering] : []),
  ].join('\n');
}

/**
 * Zod's `issue.message` alone reads as "Required Required Unrecognized key(s)"
 * with nothing to act on. The path is the half that names the field, so the
 * lead can find it — this is what a plan-repair turn is given.
 */
export function formatPlanIssues(
  issues: readonly { path: (string | number)[]; message: string }[],
): string {
  return issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}
