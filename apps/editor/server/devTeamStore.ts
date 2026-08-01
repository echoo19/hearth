import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AgentTurnOptions } from './chat.js';
import { parseTranscript, safeChatId, type ChatRecord } from './chatStore.js';

export const DEVTEAM_DIR = path.join('.hearth', 'devteam');
export const DEVTEAM_STATE_UNREADABLE = 'Dev team state is unreadable.';

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

export interface DevTeamSnapshot {
  runId: string;
  phase: DevTeamPhase;
  plan: DevTeamPlan | null;
  tasks: DevTeamTaskRecord[];
  approvals: DevTeamApprovalRecord[];
  currentMilestone: number;
  spec: string | null;
  specVersion: number;
  summary: string | null;
  wrap: string | null;
  error: string | null;
}

export interface DevTeamState extends DevTeamSnapshot {
  resumePhase: DevTeamPhase | null;
  planDigest: string | null;
  steering: DevTeamSteeringRecord[];
  retryCount: number;
  agent: AgentTurnOptions | null;
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

const stateSchema: z.ZodType<DevTeamState> = z.object({
  runId: z.string(),
  phase: phaseSchema,
  resumePhase: phaseSchema.nullable(),
  planDigest: z.string().nullable(),
  plan: devTeamPlanSchema.nullable(),
  tasks: z.array(
    z.object({
      taskId: z.string(),
      engineerId: z.string(),
      status: z.enum(['pending', 'running', 'waiting', 'done', 'error', 'interrupted']),
      startedAt: z.string().optional(),
      endedAt: z.string().optional(),
      summary: z.string().optional(),
      continuationId: z.string().optional(),
      files: z.array(z.string()).optional(),
    }),
  ),
  approvals: z.array(z.object({ specVersion: z.number().int().positive(), approvedAt: z.string() })),
  steering: z.array(z.object({ ts: z.string(), text: z.string() })),
  currentMilestone: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  agent: z
    .object({
      provider: z.enum(['anthropic', 'openai']).optional(),
      model: z.string().nullable().optional(),
      effort: z.string().nullable().optional(),
    })
    .nullable(),
  spec: z.string().nullable(),
  specVersion: z.number().int().nonnegative(),
  summary: z.string().nullable(),
  wrap: z.string().nullable(),
  error: z.string().nullable(),
});

function emptyState(over: Partial<DevTeamState> = {}): DevTeamState {
  return {
    runId: '',
    phase: 'idle',
    resumePhase: null,
    planDigest: null,
    plan: null,
    tasks: [],
    approvals: [],
    steering: [],
    currentMilestone: 0,
    retryCount: 0,
    agent: null,
    spec: null,
    specVersion: 0,
    summary: null,
    wrap: null,
    error: null,
    ...over,
  };
}

export function devTeamRunDir(root: string, chatId: string): string {
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
    await fsp.writeFile(temp, text, 'utf8');
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
    return parsed.success ? parsed.data : emptyState({ phase: 'interrupted', error: DEVTEAM_STATE_UNREADABLE });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? emptyState()
      : emptyState({ phase: 'interrupted', error: DEVTEAM_STATE_UNREADABLE });
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
  const parsed = stateSchema.parse(state);
  return serialize(root, id, () =>
    writeAtomic(path.join(devTeamRunDir(root, id), 'state.json'), `${JSON.stringify(parsed, null, 2)}\n`),
  );
}

export async function readDevTeamPlan(root: string, chatId: string): Promise<DevTeamPlan | null> {
  const id = safeChatId(chatId);
  if (!id) return null;
  try {
    const parsed = devTeamPlanSchema.safeParse(JSON.parse(await fsp.readFile(path.join(devTeamRunDir(root, id), 'plan.json'), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function readDevTeamSpec(root: string, chatId: string): Promise<string | null> {
  const id = safeChatId(chatId);
  if (!id) return null;
  try {
    return await fsp.readFile(path.join(devTeamRunDir(root, id), 'spec.md'), 'utf8');
  } catch {
    return null;
  }
}

export function approveDevTeamSpec(root: string, chatId: string): Promise<DevTeamState> {
  const id = safeChatId(chatId);
  if (!id) return Promise.reject(new Error('Chat id must be a safe id.'));
  return serialize(root, id, async () => {
    const spec = await readDevTeamSpec(root, id);
    const current = await readStateFile(root, id);
    if (spec === null || current.error !== null) return current;
    const specVersion = current.specVersion + 1;
    const approvedAt = new Date().toISOString();
    await writeAtomic(path.join(devTeamRunDir(root, id), `spec.v${specVersion}.md`), spec);
    const next: DevTeamState = {
      ...current,
      spec,
      specVersion,
      approvals: [...current.approvals, { specVersion, approvedAt }],
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
