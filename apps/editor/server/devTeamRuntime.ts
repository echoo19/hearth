import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  normalizeChatEvent,
  type AgentToolAccess,
  type AgentTurnOptions,
  type ApprovalDecision,
  type ChatDriver,
  type ChatEvent,
  type InputResponse,
} from './chat.js';
import type { PermissionMode } from './permissionMode.js';
import type { ChatRecord } from './chatStore.js';
import {
  approveDevTeamSpec,
  devTeamPlanSchema,
  readDevTeamPlan,
  readDevTeamSpec,
  readDevTeamState,
  readEngineerRecords,
  writeDevTeamState,
  type DevTeamPhase,
  type DevTeamPlan,
  type DevTeamSnapshot,
  type DevTeamState,
  type DevTeamTaskRecord,
} from './devTeamStore.js';

export const DEFAULT_DEV_TEAM_CONCURRENCY = 2;
export const MAX_DEV_TEAM_CONCURRENCY = 4;
export const MAX_DEV_TEAM_PLAN_RETRIES = 3;

type DevTeamRole = DevTeamPlan['roles'][number];
type DevTeamTask = DevTeamPlan['milestones'][number]['tasks'][number];

export interface DevTeamEngineerRequest {
  engineerId: string;
  sessionId: string;
  task: DevTeamTask;
  role: DevTeamRole;
  agent: AgentTurnOptions | null;
  permissionMode: PermissionMode;
  tools: AgentToolAccess | null;
  resumeContinuationId?: string;
  onContinuationId: (id: string) => void;
}

export interface DevTeamRuntimeOptions {
  root: string;
  chatId: string;
  maxConcurrency?: number;
  agent?: AgentTurnOptions | null;
  permissionMode: PermissionMode;
  tools?: AgentToolAccess | null;
  createDriver: (request: DevTeamEngineerRequest) => Promise<ChatDriver>;
  sendLead: (text: string, agent: AgentTurnOptions | null) => void | Promise<void>;
  appendLeadRecord: (record: ChatRecord) => Promise<void>;
  appendEngineerRecord: (engineerId: string, record: ChatRecord) => Promise<void>;
  emitSnapshot: (snapshot: DevTeamSnapshot) => void;
  emitEngineerEvent: (engineerId: string, event: ChatEvent) => void;
  now?: () => string;
  id?: () => string;
}

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

export function buildRevisionPrompt(chatId: string, revision: string): string {
  return [
    `Revise and rewrite ${runPath(chatId, 'spec.md')} to incorporate the person's feedback below.`,
    'Preserve decisions that were not changed, keep the specification project-appropriate and genre-neutral, then end the turn.',
    '',
    'Revision request:',
    revision,
  ].join('\n');
}

export function buildPlanPrompt(chatId: string, spec: string): string {
  return [
    'Create the smallest capable team and an executable milestone plan for the approved specification below.',
    'Invent roles for this project; do not use a fixed organization chart. Keep tasks focused, dependencies explicit, scopes safe relative path prefixes, and effort low, medium, or high only when useful.',
    `Write only schema version 1 plan JSON to ${runPath(chatId, 'plan.json')}, then end the turn. The runtime validates the file; prose is not the handshake.`,
    '',
    'Approved specification:',
    spec,
  ].join('\n');
}

export function buildPlanRepairPrompt(chatId: string, error: string): string {
  return [
    `The plan at ${runPath(chatId, 'plan.json')} is invalid: ${error}`,
    'Correct that same file as schema version 1 JSON. Keep roles project-specific, dependencies valid, and scopes safe relative path prefixes, then end the turn.',
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

interface ActiveEngineer {
  driver: ChatDriver;
  task: DevTeamTask;
  currentProse: string;
  finalProse: string;
  files: Set<string>;
  approvals: Set<string>;
  inputs: Set<string>;
}

const ACTIVE_PHASES = new Set<DevTeamPhase>([
  'interviewing',
  'drafting-spec',
  'spec-review',
  'planning',
  'building',
  'reviewing',
  'wrapping',
]);

function initialState(): DevTeamState {
  return {
    version: 1,
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
  };
}

function digest(plan: DevTeamPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

function terminal(status: DevTeamTaskRecord['status']): boolean {
  return status === 'done' || status === 'error' || status === 'interrupted';
}

function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

export class DevTeamRuntime {
  private readonly maxConcurrency: number;
  private readonly now: () => string;
  private readonly id: () => string;
  private state = initialState();
  private loaded = false;
  private loading: Promise<void> | null = null;
  private disposed = false;
  private leadCurrentProse = '';
  private leadFinalProse = '';
  private active = new Map<string, ActiveEngineer>();
  private scheduling: Promise<void> | null = null;
  private scheduleAgain = false;

  constructor(private readonly options: DevTeamRuntimeOptions) {
    const requestedConcurrency = Number.isFinite(options.maxConcurrency)
      ? Math.floor(options.maxConcurrency!)
      : DEFAULT_DEV_TEAM_CONCURRENCY;
    this.maxConcurrency = Math.max(
      1,
      Math.min(MAX_DEV_TEAM_CONCURRENCY, requestedConcurrency),
    );
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? randomUUID;
  }

  snapshot(): DevTeamSnapshot {
    return this.publicSnapshot(this.state);
  }

  engineerReplay(engineerId: string): Promise<ChatRecord[]> {
    return readEngineerRecords(this.options.root, this.options.chatId, engineerId);
  }

  async start(initialRequest?: string): Promise<void> {
    await this.load();
    if (initialRequest === undefined) return;
    if (this.state.phase !== 'idle' && this.state.phase !== 'done') return;
    const approvalHistory = this.state.approvals;
    const specVersion = this.state.specVersion;
    this.state = {
      ...initialState(),
      runId: this.id(),
      phase: 'interviewing',
      agent: this.options.agent ?? null,
      approvals: approvalHistory,
      specVersion,
    };
    await this.persist();
    await this.sendLead(buildInterviewPrompt(this.options.chatId, initialRequest));
  }

  async handleUserMessage(text: string): Promise<boolean> {
    await this.load();
    const message = text.trim();
    if (!message) return false;
    if (this.state.phase === 'idle' || this.state.phase === 'done') {
      await this.start(message);
      return true;
    }
    if (this.state.phase === 'spec-review') {
      await this.sendLead(buildRevisionPrompt(this.options.chatId, message));
      return true;
    }
    if (this.state.phase === 'building' || this.state.phase === 'paused' || this.state.phase === 'reviewing') {
      this.state.steering.push({ ts: this.now(), text: message });
      await this.persist();
      return true;
    }
    return false;
  }

  async handleLeadEvent(rawEvent: ChatEvent): Promise<void> {
    await this.load();
    const event = normalizeChatEvent(rawEvent);
    if (event.type === 'message-delta') {
      this.leadCurrentProse += event.text;
      return;
    }
    if (event.type === 'message-end') {
      if (this.leadCurrentProse.trim()) this.leadFinalProse = this.leadCurrentProse.trim();
      this.leadCurrentProse = '';
      return;
    }
    if (event.type === 'error') {
      await this.interruptState(event.message);
      return;
    }
    if (event.type !== 'turn-complete') return;

    const finalProse = this.leadCurrentProse.trim() || this.leadFinalProse;
    this.leadCurrentProse = '';
    this.leadFinalProse = '';
    if (this.state.phase === 'interviewing' || this.state.phase === 'drafting-spec' || this.state.phase === 'spec-review') {
      const spec = await readDevTeamSpec(this.options.root, this.options.chatId);
      if (spec !== null) {
        this.state.phase = 'spec-review';
        this.state.spec = spec;
        this.state.error = null;
        await this.persist();
      }
      return;
    }
    if (this.state.phase === 'planning') {
      await this.finishPlanning();
      return;
    }
    if (this.state.phase === 'reviewing') {
      this.state.summary = finalProse || null;
      await this.applyReviewPlan();
      if (this.state.plan && this.state.currentMilestone + 1 < this.state.plan.milestones.length) {
        this.state.currentMilestone += 1;
        this.state.phase = 'building';
        await this.persist();
        await this.schedule();
      } else if (this.state.plan) {
        this.state.phase = 'wrapping';
        const steering = this.takeSteering();
        await this.persist();
        await this.sendLead(buildWrapPrompt(this.state.plan, steering));
      }
      return;
    }
    if (this.state.phase === 'wrapping') {
      this.state.wrap = finalProse || null;
      this.state.phase = 'done';
      this.state.resumePhase = null;
      await this.persist();
    }
  }

  async approveSpec(): Promise<void> {
    await this.load();
    if (this.state.phase !== 'spec-review') return;
    const approved = await approveDevTeamSpec(this.options.root, this.options.chatId);
    if (approved.error || approved.spec === null) {
      this.state.error = approved.error ?? 'The specification is missing.';
      await this.persist();
      return;
    }
    const approvals = [...approved.approvals];
    approvals[approvals.length - 1] = { ...approvals[approvals.length - 1], approvedAt: this.now() };
    this.state = {
      ...approved,
      approvals,
      phase: 'planning',
      retryCount: 0,
      error: null,
      agent: this.state.agent,
    };
    await this.persist();
    await this.sendLead(buildPlanPrompt(this.options.chatId, approved.spec));
  }

  async pause(): Promise<void> {
    await this.load();
    if (!ACTIVE_PHASES.has(this.state.phase)) return;
    this.state.resumePhase = this.state.phase;
    this.state.phase = 'paused';
    await this.persist();
  }

  async resume(): Promise<void> {
    await this.load();
    if (this.state.phase !== 'paused' && this.state.phase !== 'interrupted') return;
    const phase = this.state.resumePhase ?? 'building';
    for (const record of this.state.tasks) {
      if (record.status === 'interrupted') {
        record.status = 'pending';
        delete record.startedAt;
        delete record.endedAt;
        delete record.summary;
        delete record.files;
      }
    }
    this.state.phase = phase;
    this.state.resumePhase = null;
    this.state.error = null;
    await this.persist();
    if (phase === 'building') await this.schedule();
    else if (phase === 'planning' && this.state.spec) await this.sendLead(buildPlanPrompt(this.options.chatId, this.state.spec));
    else if (phase === 'reviewing' && this.state.plan) await this.beginReview();
    else if (phase === 'wrapping' && this.state.plan) {
      const steering = this.takeSteering();
      await this.persist();
      await this.sendLead(buildWrapPrompt(this.state.plan, steering));
    }
  }

  async stop(): Promise<void> {
    await this.load();
    if (this.state.phase === 'idle' || this.state.phase === 'done' || this.state.phase === 'interrupted') return;
    await this.stopActive(null);
  }

  routeEngineerApproval(
    engineerId: string,
    approvalId: string,
    decision: ApprovalDecision,
    choiceId?: string,
  ): boolean {
    const active = this.active.get(engineerId);
    if (!active?.driver.approve || !active.approvals.has(approvalId)) return false;
    active.driver.approve(approvalId, decision, choiceId);
    return true;
  }

  routeEngineerInput(engineerId: string, inputId: string, response: InputResponse): boolean {
    const active = this.active.get(engineerId);
    if (!active?.driver.answerInput || !active.inputs.has(inputId)) return false;
    active.driver.answerInput(inputId, response);
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.load();
    if (ACTIVE_PHASES.has(this.state.phase) || this.state.phase === 'paused') {
      await this.stopActive('The dev team runtime closed before the run finished.');
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loading ??= this.hydrate();
    await this.loading;
  }

  private async hydrate(): Promise<void> {
    this.state = await readDevTeamState(this.options.root, this.options.chatId);
    if (this.state.unreadable) {
      this.loaded = true;
      return;
    }
    if (ACTIVE_PHASES.has(this.state.phase)) {
      const prior = this.state.phase;
      this.state.phase = 'interrupted';
      this.state.resumePhase = prior;
      this.state.error = 'The dev team run was interrupted and needs to be resumed.';
      for (const record of this.state.tasks) {
        if (record.status === 'running') {
          record.status = 'interrupted';
          record.endedAt = this.now();
        }
      }
      await this.persist();
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const revision = structuredClone(this.state);
    await writeDevTeamState(this.options.root, this.options.chatId, revision);
    this.options.emitSnapshot(this.publicSnapshot(revision));
  }

  private publicSnapshot(state: DevTeamState): DevTeamSnapshot {
    const {
      version,
      runId,
      phase,
      plan,
      tasks,
      approvals,
      currentMilestone,
      spec,
      specVersion,
      summary,
      wrap,
      error,
    } = state;
    return structuredClone({
      version,
      runId,
      phase,
      plan,
      tasks,
      approvals,
      currentMilestone,
      spec,
      specVersion,
      summary,
      wrap,
      error,
    });
  }

  private async sendLead(prompt: string): Promise<void> {
    await this.options.appendLeadRecord({
      role: 'user',
      ts: this.now(),
      text: prompt,
      orchestration: true,
    });
    await this.options.sendLead(prompt, this.state.agent);
  }

  private takeSteering(): string {
    const text = this.state.steering.map((record) => record.text).join('\n');
    this.state.steering = [];
    return text;
  }

  private async readPlanResult(): Promise<{ plan: DevTeamPlan | null; error: string | null }> {
    const file = path.join(this.options.root, '.hearth', 'devteam', this.options.chatId, 'plan.json');
    try {
      const parsed = devTeamPlanSchema.safeParse(JSON.parse(await fsp.readFile(file, 'utf8')));
      if (parsed.success) return { plan: parsed.data, error: null };
      return { plan: null, error: parsed.error.issues.map((issue) => issue.message).join(' ') };
    } catch (error) {
      return { plan: null, error: (error as Error).message };
    }
  }

  private async finishPlanning(): Promise<void> {
    const result = await this.readPlanResult();
    if (!result.plan) {
      this.state.retryCount += 1;
      this.state.error = `Plan validation failed: ${result.error ?? 'unknown error'}`;
      if (this.state.retryCount >= MAX_DEV_TEAM_PLAN_RETRIES) {
        this.state.resumePhase = 'planning';
        this.state.phase = 'interrupted';
        await this.persist();
        return;
      }
      await this.persist();
      await this.sendLead(buildPlanRepairPrompt(this.options.chatId, result.error ?? 'unknown error'));
      return;
    }
    this.state.plan = result.plan;
    this.state.planDigest = digest(result.plan);
    this.state.tasks = result.plan.milestones.flatMap((milestone) =>
      milestone.tasks.map((task) => ({ taskId: task.id, engineerId: '', status: 'pending' as const })),
    );
    this.state.currentMilestone = 0;
    this.state.retryCount = 0;
    this.state.error = null;
    this.state.phase = 'building';
    await this.persist();
    await this.schedule();
  }

  private async applyReviewPlan(): Promise<void> {
    const candidate = await readDevTeamPlan(this.options.root, this.options.chatId);
    if (!candidate || !this.state.plan || digest(candidate) === this.state.planDigest) return;
    const old = this.state.plan;
    const future = candidate.milestones.slice(this.state.currentMilestone + 1);
    const merged: DevTeamPlan = {
      ...candidate,
      milestones: [...old.milestones.slice(0, this.state.currentMilestone + 1), ...future],
    };
    const existing = new Map(this.state.tasks.map((record) => [record.taskId, record]));
    const wanted = new Set(merged.milestones.flatMap((milestone) => milestone.tasks.map((task) => task.id)));
    const records = merged.milestones.flatMap((milestone) =>
      milestone.tasks.map((task) => existing.get(task.id) ?? { taskId: task.id, engineerId: '', status: 'pending' as const }),
    );
    for (const record of this.state.tasks) {
      if (!wanted.has(record.taskId) && (record.status === 'done' || record.status === 'running')) records.push(record);
    }
    this.state.plan = merged;
    this.state.planDigest = digest(candidate);
    this.state.tasks = records;
  }

  private async schedule(): Promise<void> {
    if (this.scheduling) {
      this.scheduleAgain = true;
      await this.scheduling;
      return;
    }
    this.scheduling = this.runSchedule();
    try {
      await this.scheduling;
    } finally {
      this.scheduling = null;
      if (this.scheduleAgain) {
        this.scheduleAgain = false;
        await this.schedule();
      }
    }
  }

  private async runSchedule(): Promise<void> {
    if (this.state.phase !== 'building' || !this.state.plan || this.disposed) return;
    const milestone = this.state.plan.milestones[this.state.currentMilestone];
    if (!milestone) {
      this.state.phase = 'wrapping';
      const steering = this.takeSteering();
      await this.persist();
      await this.sendLead(buildWrapPrompt(this.state.plan, steering));
      return;
    }

    let changed = false;
    const records = new Map(this.state.tasks.map((record) => [record.taskId, record]));
    let propagated: boolean;
    do {
      propagated = false;
      for (const task of milestone.tasks) {
        const record = records.get(task.id);
        if (!record || record.status !== 'pending') continue;
        const dependencies = (task.dependsOn ?? []).map((id) => records.get(id)).filter(Boolean) as DevTeamTaskRecord[];
        if (dependencies.some((dependency) => dependency.status === 'error' || dependency.status === 'interrupted')) {
          record.status = 'error';
          record.summary = 'A dependency did not complete.';
          record.endedAt = this.now();
          changed = true;
          propagated = true;
        }
      }
    } while (propagated);
    if (changed) await this.persist();

    while (this.active.size < this.maxConcurrency && this.state.phase === 'building') {
      const ready = milestone.tasks.find((task) => this.ready(task, records) && this.scopeAvailable(task));
      if (!ready) break;
      await this.dispatch(ready, records.get(ready.id)!);
    }

    if (milestone.tasks.every((task) => terminal(records.get(task.id)?.status ?? 'pending')) && this.active.size === 0) {
      await this.beginReview();
    }
  }

  private ready(task: DevTeamTask, records: Map<string, DevTeamTaskRecord>): boolean {
    const record = records.get(task.id);
    return record?.status === 'pending' && (task.dependsOn ?? []).every((id) => records.get(id)?.status === 'done');
  }

  private scopeAvailable(task: DevTeamTask): boolean {
    const running = [...this.active.values()];
    if (running.length === 0) return true;
    if (!task.scope?.length) return false;
    return running.every((active) => active.task.scope?.length && !scopesOverlap(task.scope!, active.task.scope));
  }

  private taskRecord(taskId: string): DevTeamTaskRecord | undefined {
    return this.state.tasks.find((record) => record.taskId === taskId);
  }

  private async dispatch(task: DevTeamTask, record: DevTeamTaskRecord): Promise<void> {
    const role = this.state.plan!.roles.find((candidate) => candidate.id === task.roleId)!;
    const engineerId = record.engineerId || `devteam-${this.options.chatId}-${task.id}`;
    record.engineerId = engineerId;
    record.status = 'running';
    record.startedAt = this.now();
    delete record.endedAt;
    await this.persist();

    const request: DevTeamEngineerRequest = {
      engineerId,
      sessionId: `devteam-${this.options.chatId}-${task.id}`,
      task,
      role,
      agent: this.state.agent,
      permissionMode: this.options.permissionMode,
      tools: this.options.tools ?? null,
      resumeContinuationId: record.continuationId,
      onContinuationId: (continuationId) => {
        const current = this.taskRecord(task.id);
        if (!current || current.continuationId === continuationId) return;
        current.continuationId = continuationId;
        void this.persist();
      },
    };
    try {
      const driver = await this.options.createDriver(request);
      await driver.start(request.sessionId, this.options.root);
      if (record.status !== 'running' || this.disposed || this.state.phase === 'interrupted') {
        driver.stop();
        return;
      }
      const active: ActiveEngineer = {
        driver,
        task,
        currentProse: '',
        finalProse: '',
        files: new Set(),
        approvals: new Set(),
        inputs: new Set(),
      };
      this.active.set(engineerId, active);
      const dependencies = (task.dependsOn ?? [])
        .map((id) => this.taskRecord(id))
        .filter(Boolean) as DevTeamTaskRecord[];
      const context = this.state.tasks
        .filter((item) => item.status === 'done' && item.taskId !== task.id)
        .map((item) => `${item.taskId}: ${item.summary ?? 'completed'}${item.files?.length ? ` (${item.files.join(', ')})` : ''}`)
        .join('\n');
      const prompt = buildEngineerPrompt({ spec: this.state.spec ?? '', role, task, dependencies, context });
      await this.options.appendEngineerRecord(engineerId, { role: 'user', ts: this.now(), text: prompt, orchestration: true });
      void this.consumeEngineer(engineerId, active);
      const agent = this.state.agent ? { ...this.state.agent } : {};
      if (task.effort) agent.effort = task.effort;
      driver.send(prompt, Object.keys(agent).length ? agent : undefined);
    } catch (error) {
      if (record.status !== 'running') return;
      record.status = 'error';
      record.endedAt = this.now();
      record.summary = (error as Error).message;
      this.active.delete(engineerId);
      await this.persist();
    }
  }

  private async consumeEngineer(engineerId: string, active: ActiveEngineer): Promise<void> {
    for await (const rawEvent of active.driver.events) {
      if (this.active.get(engineerId) !== active) break;
      const event = normalizeChatEvent(rawEvent);
      await this.options.appendEngineerRecord(engineerId, { role: 'agent', ts: this.now(), event });
      this.options.emitEngineerEvent(engineerId, event);
      if (event.type === 'message-delta') active.currentProse += event.text;
      else if (event.type === 'message-end') {
        if (active.currentProse.trim()) active.finalProse = active.currentProse.trim();
        active.currentProse = '';
      } else if (event.type === 'file-change') {
        for (const file of event.files) active.files.add(file.path);
      } else if (event.type === 'approval-request') active.approvals.add(event.approvalId);
      else if (event.type === 'approval-resolved') active.approvals.delete(event.approvalId);
      else if (event.type === 'input-request') active.inputs.add(event.inputId);
      else if (event.type === 'input-resolved') active.inputs.delete(event.inputId);
      else if (event.type === 'turn-complete') {
        await this.finishEngineer(engineerId, active, 'done');
        return;
      } else if (event.type === 'error') {
        active.finalProse = event.message;
        await this.finishEngineer(engineerId, active, 'error');
        return;
      }
    }
    if (this.active.get(engineerId) === active) {
      active.finalProse = 'Engineer stream ended before completing.';
      await this.finishEngineer(engineerId, active, 'error');
    }
  }

  private async finishEngineer(
    engineerId: string,
    active: ActiveEngineer,
    status: 'done' | 'error',
  ): Promise<void> {
    const record = this.taskRecord(active.task.id);
    if (!record) return;
    record.status = status;
    record.endedAt = this.now();
    record.summary = active.currentProse.trim() || active.finalProse || (status === 'error' ? 'Engineer failed.' : undefined);
    record.files = [...active.files];
    this.active.delete(engineerId);
    active.driver.stop();
    await this.persist();
    await this.schedule();
  }

  private async beginReview(): Promise<void> {
    if (!this.state.plan) return;
    this.state.phase = 'reviewing';
    const steering = this.takeSteering();
    await this.persist();
    await this.sendLead(buildReviewPrompt(this.state.plan, this.state.currentMilestone, this.state.tasks, steering));
  }

  private async interruptState(error: string): Promise<void> {
    const phase = this.state.phase;
    this.state.resumePhase = phase === 'paused' ? this.state.resumePhase : phase;
    this.state.phase = 'interrupted';
    this.state.error = error;
    await this.persist();
  }

  private async stopActive(error: string | null): Promise<void> {
    const phase = this.state.phase;
    const resumePhase = phase === 'paused' ? this.state.resumePhase : phase;
    for (const [engineerId, active] of [...this.active]) {
      for (const approvalId of active.approvals) {
        const event: ChatEvent = { type: 'approval-resolved', approvalId, decision: 'withdrawn' };
        await this.options.appendEngineerRecord(engineerId, { role: 'agent', ts: this.now(), event });
        this.options.emitEngineerEvent(engineerId, event);
      }
      for (const inputId of active.inputs) {
        const event: ChatEvent = { type: 'input-resolved', inputId, action: 'withdrawn' };
        await this.options.appendEngineerRecord(engineerId, { role: 'agent', ts: this.now(), event });
        this.options.emitEngineerEvent(engineerId, event);
      }
      this.active.delete(engineerId);
      active.driver.interrupt?.();
      active.driver.stop();
      const record = this.taskRecord(active.task.id);
      if (record) {
        record.status = 'interrupted';
        record.endedAt = this.now();
      }
    }
    for (const record of this.state.tasks) {
      if (record.status !== 'running') continue;
      record.status = 'interrupted';
      record.endedAt = this.now();
    }
    this.state.phase = 'interrupted';
    this.state.resumePhase = resumePhase;
    this.state.error = error;
    await this.persist();
  }
}
