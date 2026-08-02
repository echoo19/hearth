import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AgentTurnOptions } from './chat.js';
import { parseTranscript, safeChatId, type ChatRecord } from './chatStore.js';
import { formatPlanIssues } from './devTeamPrompts.js';

export const DEVTEAM_DIR = path.join('.hearth', 'devteam');
export const DEVTEAM_STATE_UNREADABLE = 'Dev team state is unreadable.';
/** Why an approval was refused. Both are read by the caller, so they are shared. */
export const DEVTEAM_SPEC_MISSING = 'The specification is missing.';
export const DEVTEAM_SPEC_NOT_AWAITING = 'The specification is no longer waiting for approval.';

/** Remove one explicitly deleted conversation's artifacts without exposing a path builder. */
export async function deleteDevTeamArtifacts(root: string, chatId: string): Promise<boolean> {
  const id = safeChatId(chatId);
  if (!id) return false;
  await fsp.rm(path.join(root, DEVTEAM_DIR, id), { recursive: true, force: true });
  return true;
}

export type DevTeamPhase =
  | 'idle'
  | 'interviewing'
  | 'drafting-spec'
  | 'spec-review'
  | 'planning'
  | 'building'
  | 'reviewing'
  | 'wrapping'
  | 'done'
  | 'paused'
  | 'interrupted';

export interface DevTeamPlan {
  version: 1;
  roles: { id: string; name: string; focus: string }[];
  milestones: {
    id: string;
    title: string;
    goal: string;
    tasks: {
      id: string;
      title: string;
      roleId: string;
      detail: string;
      dependsOn?: string[];
      scope?: string[];
      effort?: 'low' | 'medium' | 'high';
    }[];
  }[];
}

export type DevTeamTaskStatus = 'pending' | 'running' | 'waiting' | 'done' | 'error' | 'interrupted';

export interface DevTeamTaskRecord {
  taskId: string;
  engineerId: string;
  status: DevTeamTaskStatus;
  startedAt?: string;
  endedAt?: string;
  summary?: string;
  continuationId?: string;
  files?: string[];
}

export interface DevTeamApprovalRecord {
  specVersion: number;
  approvedAt: string;
}

export interface DevTeamSteeringRecord {
  ts: string;
  text: string;
}

export interface DevTeamCompletedRun {
  version: 1;
  runId: string;
  plan: DevTeamPlan | null;
  tasks: DevTeamTaskRecord[];
  currentMilestone: number;
  spec: string | null;
  specVersion: number;
  summary: string | null;
  wrap: string | null;
  completedAt: string;
}

export interface DevTeamSnapshot {
  version: 1;
  runId: string;
  phase: DevTeamPhase;
  /** Notes typed during an active phase, still waiting to reach the lead. The
   *  pane cannot tell someone their note was received without this. */
  steering: DevTeamSteeringRecord[];
  plan: DevTeamPlan | null;
  tasks: DevTeamTaskRecord[];
  approvals: DevTeamApprovalRecord[];
  history: DevTeamCompletedRun[];
  currentMilestone: number;
  spec: string | null;
  specVersion: number;
  summary: string | null;
  wrap: string | null;
  error: string | null;
  /**
   * When the run entered the phase it is in, as epoch milliseconds.
   *
   * The pane could say WHAT was happening and never how long it had been
   * happening, and those are not the same fact. A run whose lead turn hangs
   * looks exactly like one that is thinking: the board reads "The lead is
   * preparing the plan" at minute one and at hour two, with nothing to press.
   * Null for a run persisted before this existed, and for `idle`.
   */
  phaseSince: number | null;
}

export interface DevTeamState extends DevTeamSnapshot {
  resumePhase: DevTeamPhase | null;
  planDigest: string | null;
  retryCount: number;
  /** Milestone id -> how many times its plan has been repaired after a failed
   *  task, so one bad task cannot loop the run forever. */
  milestoneRepairs: Record<string, number>;
  agent: AgentTurnOptions | null;
  /** Set only on a read sentinel. Never valid persisted state. */
  unreadable?: true;
}

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const textSchema = z.string().trim().min(1).max(16_384);
const scopeSchema = z.string().refine(
  (value) =>
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !value.includes('\\') &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value !== '.' &&
    !value.startsWith('../') &&
    !/^[A-Za-z]:/.test(value),
  'Scope paths must be safe normalized relative paths.',
);

const taskSchema = z
  .object({
    id: idSchema,
    title: textSchema,
    roleId: idSchema,
    detail: textSchema,
    dependsOn: z.array(idSchema).max(100).optional(),
    scope: z.array(scopeSchema).max(100).optional(),
    effort: z.enum(['low', 'medium', 'high']).optional(),
  })
  .strict();

export const devTeamPlanSchema: z.ZodType<DevTeamPlan> = z
  .object({
    version: z.literal(1),
    roles: z
      .array(z.object({ id: idSchema, name: textSchema, focus: textSchema }).strict())
      .min(1)
      .max(6),
    milestones: z
      .array(
        z
          .object({
            id: idSchema,
            title: textSchema,
            goal: textSchema,
            tasks: z.array(taskSchema).min(1).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const roles = new Set(plan.roles.map((role) => role.id));
    if (roles.size !== plan.roles.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Role ids must be unique.' });

    const milestoneIds = new Set(plan.milestones.map((milestone) => milestone.id));
    if (milestoneIds.size !== plan.milestones.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Milestone ids must be unique.' });
    }

    const tasks = plan.milestones.flatMap((milestone, milestoneIndex) =>
      milestone.tasks.map((task) => ({ task, milestoneIndex })),
    );
    const byId = new Map(tasks.map((entry) => [entry.task.id, entry]));
    if (byId.size !== tasks.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Task ids must be unique.' });

    for (const { task, milestoneIndex } of tasks) {
      if (!roles.has(task.roleId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Task ${task.id} names an unknown role.` });
      }
      for (const dependency of task.dependsOn ?? []) {
        const found = byId.get(dependency);
        if (!found) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Task ${task.id} has an unknown dependency.` });
        else if (dependency === task.id) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Task ${task.id} cannot depend on itself.` });
        } else if (found.milestoneIndex > milestoneIndex) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Task ${task.id} cannot depend on a later milestone.` });
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const cyclic = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      const task = byId.get(id)?.task;
      const found = (task?.dependsOn ?? []).some((dependency) => byId.has(dependency) && cyclic(dependency));
      visiting.delete(id);
      visited.add(id);
      return found;
    };
    if (tasks.some(({ task }) => cyclic(task.id))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Task dependencies must not contain a cycle.' });
    }
  });

const phaseSchema = z.enum([
  'idle',
  'interviewing',
  'drafting-spec',
  'spec-review',
  'planning',
  'building',
  'reviewing',
  'wrapping',
  'done',
  'paused',
  'interrupted',
]);

const taskRecordSchema = z
  .object({
    taskId: z.string(),
    engineerId: z.string(),
    status: z.enum(['pending', 'running', 'waiting', 'done', 'error', 'interrupted']),
    startedAt: z.string().optional(),
    endedAt: z.string().optional(),
    summary: z.string().optional(),
    continuationId: z.string().optional(),
    files: z.array(z.string()).optional(),
  })
  .strict();

const completedRunSchema: z.ZodType<DevTeamCompletedRun> = z
  .object({
    version: z.literal(1),
    runId: z.string(),
    plan: devTeamPlanSchema.nullable(),
    tasks: z.array(taskRecordSchema),
    currentMilestone: z.number().int().nonnegative(),
    spec: z.string().nullable(),
    specVersion: z.number().int().nonnegative(),
    summary: z.string().nullable(),
    wrap: z.string().nullable(),
    completedAt: z.string(),
  })
  .strict();

const stateSchema: z.ZodType<DevTeamState> = z.object({
  version: z.literal(1),
  runId: z.string(),
  phase: phaseSchema,
  resumePhase: phaseSchema.nullable(),
  planDigest: z.string().nullable(),
  plan: devTeamPlanSchema.nullable(),
  tasks: z.array(taskRecordSchema),
  approvals: z.array(z.object({ specVersion: z.number().int().positive(), approvedAt: z.string() }).strict()),
  history: z.array(completedRunSchema).default([]),
  steering: z.array(z.object({ ts: z.string(), text: z.string() }).strict()),
  currentMilestone: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  milestoneRepairs: z.record(z.string(), z.number().int().nonnegative()).default({}),
  agent: z
    .object({
      provider: z.enum(['anthropic', 'openai']).optional(),
      model: z.string().nullable().optional(),
      effort: z.string().nullable().optional(),
    })
    .strict()
    .nullable(),
  spec: z.string().nullable(),
  specVersion: z.number().int().nonnegative(),
  summary: z.string().nullable(),
  wrap: z.string().nullable(),
  error: z.string().nullable(),
  // Defaulted, not required: every run written before this field existed must
  // still load. A null reads as "not known", which the pane states as such
  // rather than inventing a start time.
  phaseSince: z.number().nullable().default(null),
}).strict();

function emptyState(over: Partial<DevTeamState> = {}): DevTeamState {
  return {
    version: 1,
    runId: '',
    phase: 'idle',
    resumePhase: null,
    planDigest: null,
    plan: null,
    tasks: [],
    approvals: [],
    history: [],
    steering: [],
    currentMilestone: 0,
    retryCount: 0,
    milestoneRepairs: {},
    agent: null,
    spec: null,
    specVersion: 0,
    summary: null,
    wrap: null,
    error: null,
    phaseSince: null,
    ...over,
  };
}

function devTeamRunDir(root: string, chatId: string): string {
  return path.join(root, DEVTEAM_DIR, chatId);
}

const tails = new Map<string, Promise<unknown>>();

function serialize<T>(root: string, chatId: string, task: () => Promise<T>): Promise<T> {
  const key = `${root}\0${chatId}`;
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    // The rename is only atomic with respect to the directory entry. Without
    // the fsync the bytes can still be in the page cache when the rename
    // lands, so a hard kill leaves state.json present and zero length — the
    // one shape that reads back as corrupt.
    const handle = await fsp.open(temp, 'w');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temp, file);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readStateFile(root: string, chatId: string): Promise<DevTeamState> {
  const file = path.join(devTeamRunDir(root, chatId), 'state.json');
  try {
    const parsed = stateSchema.safeParse(JSON.parse(await fsp.readFile(file, 'utf8')));
    return parsed.success
      ? parsed.data
      : emptyState({ phase: 'interrupted', error: DEVTEAM_STATE_UNREADABLE, unreadable: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? emptyState()
      : emptyState({ phase: 'interrupted', error: DEVTEAM_STATE_UNREADABLE, unreadable: true });
  }
}

export function readDevTeamState(root: string, chatId: string): Promise<DevTeamState> {
  const id = safeChatId(chatId);
  if (!id) return Promise.resolve(emptyState());
  return serialize(root, id, () => readStateFile(root, id));
}

export function writeDevTeamState(root: string, chatId: string, state: DevTeamState): Promise<void> {
  const id = safeChatId(chatId);
  if (!id) return Promise.reject(new Error('Chat id must be a safe id.'));
  // The flag says the FILE could not be read; it says nothing about the state
  // the app is holding. Refusing to write it made every later persist throw,
  // so one corrupt read killed the conversation with no way back from inside
  // the app. Strip it and write what we have. The damaged file itself is only
  // ever moved aside by quarantineDevTeamState, on an explicit call — no write
  // path overwrites a file that might still hold someone's run.
  const { unreadable: _unreadable, ...writable } = state;
  const parsed = stateSchema.parse(writable);
  return serialize(root, id, () =>
    writeAtomic(path.join(devTeamRunDir(root, id), 'state.json'), `${JSON.stringify(parsed, null, 2)}\n`),
  );
}

/**
 * Move an unreadable state file aside so the conversation can start over.
 *
 * It is renamed rather than deleted because a file that failed to parse may
 * still be the only record of a run someone cares about. Deliberately outside
 * the per-chat write lane: rename is atomic, so a state write landing either
 * side of this leaves one whole state.json either way, and taking the lane
 * would deadlock a caller that is already holding it.
 */
export async function quarantineDevTeamState(root: string, chatId: string): Promise<void> {
  const id = safeChatId(chatId);
  if (!id) return;
  const file = path.join(devTeamRunDir(root, id), 'state.json');
  await fsp.rename(file, `${file}.corrupt`).catch(() => undefined);
}

export function resetDevTeamHandshakes(root: string, chatId: string): Promise<void> {
  const id = safeChatId(chatId);
  if (!id) return Promise.reject(new Error('Chat id must be a safe id.'));
  return serialize(root, id, async () => {
    await Promise.all(
      ['spec.md', 'plan.json'].map((file) => fsp.rm(path.join(devTeamRunDir(root, id), file), { force: true })),
    );
  });
}

/**
 * Read a plan the lead wrote, and say what is wrong with it in words the lead
 * can act on. `readDevTeamPlan` only answers "is there a plan"; a repair turn
 * needs the failing field, which is what `error` carries here.
 */
export function parsePlanJson(text: string): { plan: DevTeamPlan | null; error: string | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { plan: null, error: `The file is not valid JSON: ${(error as Error).message}` };
  }
  const parsed = devTeamPlanSchema.safeParse(raw);
  if (parsed.success) return { plan: parsed.data, error: null };
  // Zod types a path segment as PropertyKey. A plan parsed out of JSON can
  // never carry a symbol key, and the formatter is honest about taking only
  // what it can print, so drop the case that cannot occur rather than cast.
  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.filter((segment): segment is string | number => typeof segment !== 'symbol'),
    message: issue.message,
  }));
  return { plan: null, error: formatPlanIssues(issues) };
}

export async function readDevTeamPlan(root: string, chatId: string): Promise<DevTeamPlan | null> {
  const id = safeChatId(chatId);
  if (!id) return null;
  try {
    return parsePlanJson(await fsp.readFile(path.join(devTeamRunDir(root, id), 'plan.json'), 'utf8')).plan;
  } catch {
    return null;
  }
}

export async function readDevTeamSpec(root: string, chatId: string): Promise<string | null> {
  const id = safeChatId(chatId);
  if (!id) return null;
  try {
    const text = await fsp.readFile(path.join(devTeamRunDir(root, id), 'spec.md'), 'utf8');
    // An empty file is the lead having created spec.md and written nothing.
    // Callers only test for null, so returning '' advanced a run to planning
    // on a specification that does not exist.
    return text.trim() === '' ? null : text;
  } catch {
    return null;
  }
}

/**
 * Approve the spec on disk, or say why it was not approved.
 *
 * A bail-out used to return `current` untouched, which still carries the spec
 * the caller was already showing and no error — indistinguishable from a real
 * approval. The caller then recorded an approval that never happened by
 * rewriting `approvals[approvals.length - 1]`, which on an empty array sets
 * property `-1` and JSON.stringify drops it silently: the run advanced to
 * planning with no approval and no version. So every bail-out now names its
 * reason in `error`, where the caller already looks. The returned state is an
 * answer to this call, not necessarily what is on disk: nothing is persisted
 * on a bail-out.
 */
export function approveDevTeamSpec(root: string, chatId: string): Promise<DevTeamState> {
  const id = safeChatId(chatId);
  if (!id) return Promise.reject(new Error('Chat id must be a safe id.'));
  return serialize(root, id, async () => {
    const current = await readStateFile(root, id);
    if (current.error !== null) return current;
    if (current.phase !== 'spec-review') return { ...current, error: DEVTEAM_SPEC_NOT_AWAITING };
    const spec = await readDevTeamSpec(root, id);
    if (spec === null) return { ...current, error: DEVTEAM_SPEC_MISSING };
    const specVersion = current.specVersion + 1;
    const approvedAt = new Date().toISOString();
    await writeAtomic(path.join(devTeamRunDir(root, id), `spec.v${specVersion}.md`), spec);
    const next: DevTeamState = {
      ...current,
      phase: 'planning',
      resumePhase: null,
      spec,
      specVersion,
      approvals: [...current.approvals, { specVersion, approvedAt }],
      retryCount: 0,
      error: null,
    };
    await writeAtomic(path.join(devTeamRunDir(root, id), 'state.json'), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function appendEngineerRecord(root: string, chatId: string, engineerId: string, record: ChatRecord): Promise<void> {
  const chat = safeChatId(chatId);
  const engineer = safeChatId(engineerId);
  if (!chat) return Promise.reject(new Error('Chat id must be a safe id.'));
  if (!engineer) return Promise.reject(new Error('Engineer id must be a safe id.'));
  return serialize(root, chat, async () => {
    const file = path.join(devTeamRunDir(root, chat), 'engineers', `${engineer}.jsonl`);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
  });
}

export function readEngineerRecords(root: string, chatId: string, engineerId: string): Promise<ChatRecord[]> {
  const chat = safeChatId(chatId);
  const engineer = safeChatId(engineerId);
  if (!chat || !engineer) return Promise.resolve([]);
  return serialize(root, chat, async () => {
    try {
      return parseTranscript(await fsp.readFile(path.join(devTeamRunDir(root, chat), 'engineers', `${engineer}.jsonl`), 'utf8'));
    } catch {
      return [];
    }
  });
}
