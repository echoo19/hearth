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

/**
 * The lead is asked for a file the runtime validates with a strict schema, so
 * the schema has to be in the prompt. This block is the prose form of
 * `devTeamPlanSchema` in devTeamStore.ts; when that schema changes, change this
 * with it. devTeamPlan.test.ts checks the id pattern quoted here against the
 * schema itself so the two cannot drift silently.
 */
const PLAN_SHAPE = [
  'The file must be exactly this shape. Unknown keys are rejected.',
  '{',
  '  "version": 1,',
  '  "roles": [{ "id": "...", "name": "...", "focus": "..." }],',
  '  "milestones": [{',
  '    "id": "...", "title": "...", "goal": "...",',
  '    "tasks": [{',
  '      "id": "...", "title": "...", "roleId": "...", "detail": "...",',
  '      "dependsOn": ["taskId"], "scope": ["src/path"], "effort": "low|medium|high"',
  '    }]',
  '  }]',
  '}',
  'dependsOn, scope and effort are optional; every other key is required.',
  'Ids match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/. Role ids are unique among roles, milestone ids among milestones, and task ids across the whole plan.',
  'Every roleId names a role in roles. Every text field is non-empty and at most 16384 characters.',
  'At least 1 and at most 6 roles, at least 1 and at most 100 milestones, at least 1 and at most 100 tasks per milestone.',
  'A dependency must name an earlier or same-milestone task, never a later one, and never itself.',
  'Scopes are normalized relative paths with no leading slash, no backslash and no "..".',
].join('\n');

export function buildInterviewPrompt(chatId: string, request: string): string {
  return [
    'You are the lead for a small development team. Work in a provider-neutral, project-appropriate way.',
    'Before asking anything, look at the project folder to see what already exists; do not propose rebuilding what is there.',
    'Briefly interview the person only where the request leaves a material decision open. Adapt to the detail already provided; a complete brief may need no questions.',
    'Use a structured question tool when useful, while keeping prose questions valid. Do not assume a genre, dimension, engine, role, or input method.',
    'The specification is read and approved by a person, then handed to a planner. Write it as: what this is in one paragraph, the core loop or primary flow, the things a person can do, what "finished" means for this run, and anything deliberately out of scope. Keep it to what this run will actually build.',
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
    'Each task is executed by a separate agent with no memory of the others and no view of their conversations. Everything a task needs must be in its own title and detail, or in the handoff of a task it declares in dependsOn.',
    'Declare scope on every task you can. Tasks with overlapping scopes never run at the same time, and a task with no scope runs alone — omitting scope serializes the whole run.',
    '',
    PLAN_SHAPE,
    '',
    `Write only that JSON to ${runPath(chatId, 'plan.json')}, then end the turn. The runtime validates the file; prose is not the handshake.`,
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
  // Scope is a rule the engineer has to follow, not a note about how the
  // scheduler picked this turn. The old wording described the scheduler, which
  // told the engineer nothing it could act on.
  const scope = input.task.scope?.length
    ? `Files you may create or change: ${input.task.scope.join(', ')}. Do not write outside them.`
    : 'No files were reserved for this task. Change as little as possible and prefer creating new files over editing shared ones.';
  const dependencies = input.dependencies.length
    ? input.dependencies
        .map((record) => `- ${record.taskId}: ${record.summary ?? 'completed without a prose handoff'}${record.files?.length ? `; files: ${record.files.join(', ')}` : ''}`)
        .join('\n')
    : '- None.';
  return [
    `You are the ${input.role.name}. Your focus: ${input.role.focus}`,
    'Complete exactly one assigned task in the current project. Work with what is present, decide reasonable implementation details yourself, and do not ask the lead to choose routine details.',
    'The other tasks in this plan belong to other agents. Build only what this task asks for; the specification is here as context, not as your assignment.',
    '',
    'Approved specification:',
    input.spec,
    '',
    `Task: ${input.task.title}`,
    input.task.detail,
    scope,
    '',
    'Dependency handoffs:',
    dependencies,
    '',
    'Current project context:',
    input.context || 'No earlier task handoffs yet.',
    '',
    'Before finishing, check your own work: run whatever the project already uses (a build, a test command, a script in package.json), or if there is nothing to run, open what you produced and read it back. Then write a short factual handoff: what you changed, what you actually ran and what it said, and any known gap. Do not claim results you did not observe.',
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
  const failed = records.filter((record) => taskIds.has(record.taskId) && record.status === 'error').map((record) => record.taskId);
  return [
    `Review milestone ${milestoneIndex + 1}: ${milestone?.title ?? 'Milestone'}.`,
    `Its goal: ${milestone?.goal ?? 'The plan did not state a goal for this milestone.'}`,
    'Assess only the observed handoffs and repository state. Run checks if needed. You may amend future milestones by rewriting the existing plan.json, but do not rewrite completed or running work. End with a concise factual review.',
    failed.length
      ? `These tasks failed: ${failed.join(', ')}. You may add remediation tasks to this milestone by rewriting plan.json, and the milestone will run again once. Say what is still broken; do not describe a failed task as finished.`
      : 'If a task in this milestone had failed, you could add remediation tasks to it by rewriting plan.json. None failed, so amend later milestones only.',
    '',
    'Task outcomes:',
    handoffs || '- No task outcome was observed.',
    ...(steering ? ['', 'Steering from the person:', steering] : []),
  ].join('\n');
}

export function buildWrapPrompt(
  plan: DevTeamPlan,
  steering = '',
  tasks: readonly DevTeamTaskRecord[] = [],
): string {
  const outcomes = tasks.length
    ? tasks
        .map(
          (record) =>
            `- ${record.taskId} [${record.status}]: ${record.summary ?? 'no completed prose observed'}${record.files?.length ? `; observed files: ${record.files.join(', ')}` : ''}`,
        )
        .join('\n')
    : '- No task outcome was recorded.';
  return [
    'Write the closing handoff for this run using only the work and checks actually observed.',
    'Summarize what was built, how to use or experience it, and known gaps. Keep it appropriate to this project and do not invent verification results.',
    `The plan contained ${plan.milestones.length} milestone${plan.milestones.length === 1 ? '' : 's'}.`,
    '',
    'Task outcomes:',
    outcomes,
    '',
    'Report failed or interrupted tasks honestly; do not describe them as finished.',
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
