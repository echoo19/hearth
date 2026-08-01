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
  readDevTeamSpec,
  readDevTeamState,
  readEngineerRecords,
  resetDevTeamHandshakes,
  writeDevTeamState,
  type DevTeamPhase,
  type DevTeamPlan,
  type DevTeamCompletedRun,
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
  /** Identifies the replaceable lead driver that receives the next prompt. */
  leadBindingId?: () => string | null;
  createDriver: (request: DevTeamEngineerRequest) => Promise<ChatDriver>;
  sendLead: (text: string, agent: AgentTurnOptions | null) => void | Promise<void>;
  appendLeadRecord: (record: ChatRecord) => Promise<void>;
  appendEngineerRecord: (engineerId: string, record: ChatRecord) => Promise<void>;
  /** Optional owner seam for atomic state persistence and publication. */
  persistState?: (state: DevTeamState) => Promise<void>;
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

interface ActiveEngineer {
  driver: ChatDriver;
  task: DevTeamTask;
  currentProse: string;
  finalProse: string;
  files: Set<string>;
  approvals: Set<string>;
  inputs: Set<string>;
  withdrawals: Promise<void> | null;
  consuming: Promise<void> | null;
}

type LeadTurn = 'interview' | 'revision' | 'planning' | 'review' | 'wrap';

interface LeadOperation {
  epoch: number;
  turn: LeadTurn;
  stale: boolean;
  accepted: boolean;
  currentProse: string;
  finalProse: string;
  bindingId?: string | null;
  steeringCount: number;
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

const DEV_TEAM_STOPPED = 'Dev team run stopped.';

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
    history: [],
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

function engineerIdentity(chatId: string, taskId: string): string {
  return `devteam-${createHash('sha256').update(`${chatId}\0${taskId}`).digest('hex')}`;
}

function terminal(status: DevTeamTaskRecord['status']): boolean {
  return status === 'done' || status === 'error' || status === 'interrupted';
}

function completedRun(state: DevTeamState, completedAt: string): DevTeamCompletedRun {
  const { version, runId, plan, tasks, currentMilestone, spec, specVersion, summary, wrap } = state;
  return structuredClone({
    version,
    runId,
    plan,
    tasks,
    currentMilestone,
    spec,
    specVersion,
    summary,
    wrap,
    completedAt,
  });
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
  private disposing: Promise<void> | null = null;
  private leadGeneration = 0;
  private pendingLead: LeadOperation | null = null;
  private processingLead: LeadOperation | null = null;
  private leadQueue: LeadOperation[] = [];
  private active = new Map<string, ActiveEngineer>();
  private engineerClosures = new Set<Promise<void>>();
  private engineerConsumers = new Set<Promise<void>>();
  private trackedEngineerDrivers = new WeakSet<ChatDriver>();
  private dispatches = new Map<string, symbol>();
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
    const operation = this.beginLead('interview');
    const approvalHistory = this.state.approvals;
    const history = this.state.phase === 'done' && this.state.runId
      ? [...this.state.history, completedRun(this.state, this.now())]
      : this.state.history;
    const specVersion = this.state.specVersion;
    await resetDevTeamHandshakes(this.options.root, this.options.chatId);
    if (!this.operationCurrent(operation)) return;
    this.state = {
      ...initialState(),
      runId: this.id(),
      phase: 'interviewing',
      agent: this.options.agent ?? null,
      approvals: approvalHistory,
      history,
      specVersion,
    };
    await this.persist();
    await this.sendLead(buildInterviewPrompt(this.options.chatId, initialRequest), operation);
  }

  async handleUserMessage(text: string): Promise<boolean> {
    await this.load();
    const message = text.trim();
    if (!message) return false;
    if (this.state.phase === 'done' && this.state.error?.startsWith(DEV_TEAM_STOPPED)) return false;
    if (this.state.phase === 'idle' || this.state.phase === 'done') {
      await this.start(message);
      return true;
    }
    if (this.state.phase === 'spec-review') {
      const operation = this.beginLead('revision');
      this.state.phase = 'drafting-spec';
      await this.persist();
      await this.sendLeadWithSteering(
        (steering) => buildRevisionPrompt(this.options.chatId, message, steering),
        operation,
      );
      return true;
    }
    if (this.state.phase === 'interviewing') {
      this.acceptLead(this.beginLead('interview'));
      return false;
    }
    if (
      this.state.phase === 'drafting-spec' ||
      this.state.phase === 'planning' ||
      this.state.phase === 'building' ||
      this.state.phase === 'reviewing' ||
      this.state.phase === 'wrapping' ||
      this.state.phase === 'paused'
    ) {
      this.state.steering.push({ ts: this.now(), text: message });
      await this.persist();
      return true;
    }
    if (this.state.phase === 'interrupted') {
      this.state.steering.push({ ts: this.now(), text: message });
      await this.persist();
      return true;
    }
    return false;
  }

  async handleLeadEvent(rawEvent: ChatEvent, bindingId?: string): Promise<void> {
    await this.load();
    const event = normalizeChatEvent(rawEvent);
    const operation = this.leadQueue[0];
    if (!operation) return;
    if (
      (operation.bindingId !== undefined || bindingId !== undefined) &&
      operation.bindingId !== bindingId
    ) return;
    if (event.type === 'message-delta') {
      if (!operation.stale) operation.currentProse += event.text;
      return;
    }
    if (event.type === 'message-end') {
      if (!operation.stale && operation.currentProse.trim()) {
        operation.finalProse = operation.currentProse.trim();
      }
      operation.currentProse = '';
      return;
    }
    if (event.type === 'error') {
      this.leadQueue.shift();
      if (operation.stale) return;
      this.processingLead = operation;
      try {
        await this.interruptState(event.message);
      } finally {
        if (this.processingLead === operation) this.processingLead = null;
      }
      return;
    }
    if (event.type !== 'turn-complete') return;

    this.leadQueue.shift();
    if (operation.stale) return;
    const turn = operation.turn;
    const paused = this.state.phase === 'paused';
    const phase = paused ? this.state.resumePhase : this.state.phase;
    if (phase === null || !this.leadTurnMatchesPhase(turn, phase)) return;
    this.processingLead = operation;
    await this.acknowledgeSteering(operation);
    const finalProse = operation.currentProse.trim() || operation.finalProse;
    operation.currentProse = '';
    operation.finalProse = '';
    try {
      if (
        (turn === 'interview' && (phase === 'interviewing' || phase === 'drafting-spec')) ||
        (turn === 'revision' && (phase === 'drafting-spec' || phase === 'spec-review'))
      ) {
        const spec = await readDevTeamSpec(this.options.root, this.options.chatId);
        if (!this.leadCompletionCurrent(operation, paused, phase)) return;
        if (spec !== null) {
          if (paused) this.state.resumePhase = 'spec-review';
          else this.state.phase = 'spec-review';
          this.state.spec = spec;
          this.state.error = null;
          await this.persist();
        }
        return;
      }
      if (turn === 'planning' && phase === 'planning') {
        await this.finishPlanning(paused, operation, phase);
        return;
      }
      if (turn === 'review' && phase === 'reviewing') {
        if (!(await this.applyReviewPlan(paused, operation, phase))) return;
        if (!this.leadCompletionCurrent(operation, paused, phase)) return;
        this.state.summary = finalProse || null;
        if (this.state.plan && this.state.currentMilestone + 1 < this.state.plan.milestones.length) {
          this.state.currentMilestone += 1;
          if (paused) this.state.resumePhase = 'building';
          else this.state.phase = 'building';
          await this.persist();
          if (!paused && this.leadCompletionCurrent(operation, false, 'building')) await this.schedule();
        } else if (this.state.plan) {
          if (paused) {
            this.state.resumePhase = 'wrapping';
            await this.persist();
          } else {
            const next = this.beginLead('wrap');
            this.state.phase = 'wrapping';
            await this.persist();
            await this.sendLeadWithSteering((steering) => buildWrapPrompt(this.state.plan!, steering), next);
          }
        }
        return;
      }
      if (turn === 'wrap' && phase === 'wrapping') {
        this.state.wrap = finalProse || null;
        if (this.state.steering.length > 0 && this.state.plan) {
          const next = this.beginLead('wrap');
          await this.persist();
          await this.sendLeadWithSteering(
            (steering) => buildWrapPrompt(this.state.plan!, steering),
            next,
          );
          return;
        }
        this.state.phase = 'done';
        this.state.resumePhase = null;
        await this.persist();
      }
    } finally {
      if (this.processingLead === operation) this.processingLead = null;
    }
  }

  /** Retires work owned by a replaced lead driver without accepting its tail. */
  handleLeadBindingClosed(bindingId: string): Promise<void> {
    const operations = [this.pendingLead, this.processingLead, ...this.leadQueue];
    let interrupted = false;
    for (const operation of new Set(operations)) {
      if (operation?.bindingId !== bindingId) continue;
      this.removeLead(operation);
      const phase = this.state.phase === 'paused' ? this.state.resumePhase : this.state.phase;
      // An interview follow-up immediately establishes a replacement
      // operation on the new binding. File-handshake turns have no such user
      // turn, so freezing them is the only honest alternative to stalling.
      if (phase && phase !== 'interviewing' && phase !== 'spec-review') {
        this.state.phase = 'interrupted';
        this.state.resumePhase = phase;
        this.state.error = 'The lead agent changed while a dev team handshake was running. Resume to continue.';
        interrupted = true;
      }
    }
    return interrupted ? this.persist() : Promise.resolve();
  }

  /** Refreshes the provider-neutral run binding without replacing durable state. */
  async updateBinding(options: {
    agent: AgentTurnOptions | null;
    permissionMode: PermissionMode;
    tools: AgentToolAccess | null;
  }): Promise<void> {
    await this.load();
    this.options.agent = options.agent;
    this.options.permissionMode = options.permissionMode;
    this.options.tools = options.tools;
    if (JSON.stringify(this.state.agent) === JSON.stringify(options.agent)) return;
    this.state.agent = options.agent ? structuredClone(options.agent) : null;
    const revision = structuredClone(this.state);
    if (this.options.persistState) await this.options.persistState(revision);
    else await writeDevTeamState(this.options.root, this.options.chatId, revision);
  }

  async approveSpec(): Promise<void> {
    await this.load();
    if (this.state.phase !== 'spec-review') return;
    const operation = this.beginLead('planning');
    const approved = await approveDevTeamSpec(this.options.root, this.options.chatId);
    if (!this.operationCurrent(operation) || this.state.phase !== 'spec-review') return;
    if (approved.error || approved.spec === null) {
      this.removeLead(operation);
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
    await this.sendLeadWithSteering(
      (steering) => buildPlanPrompt(this.options.chatId, approved.spec!, steering),
      operation,
    );
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
    const retryError = this.state.error;
    const needsRepair =
      this.state.retryCount > 0 && retryError !== null && (phase === 'planning' || phase === 'reviewing');
    const retainedOperation = this.leadOperationForPhase(phase);
    const operation =
      retainedOperation
        ? null
        : phase === 'interviewing' || phase === 'drafting-spec'
        ? this.beginLead('interview')
        : phase === 'planning'
          ? this.beginLead('planning')
          : phase === 'reviewing'
            ? this.beginLead('review')
            : phase === 'wrapping'
              ? this.beginLead('wrap')
              : null;
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
    this.state.error = needsRepair ? retryError : null;
    await this.persist();
    if (retainedOperation) return;
    if (operation && !this.operationCurrent(operation)) return;
    if (phase === 'building') await this.schedule();
    else if (phase === 'interviewing' || phase === 'drafting-spec') {
      await this.sendLeadWithSteering(
        (steering) => buildInterviewResumePrompt(this.options.chatId, steering),
        operation!,
      );
    } else if (phase === 'planning' && this.state.spec) {
      if (needsRepair && this.state.error) {
        await this.sendLeadWithSteering(
          (steering) => buildPlanRepairPrompt(this.options.chatId, this.state.error!, steering),
          operation!,
        );
      } else {
        await this.sendLeadWithSteering(
          (steering) => buildPlanPrompt(this.options.chatId, this.state.spec!, steering),
          operation!,
        );
      }
    } else if (phase === 'reviewing' && this.state.plan) {
      if (needsRepair && this.state.error) {
        await this.sendLeadWithSteering(
          (steering) => buildPlanRepairPrompt(this.options.chatId, this.state.error!, steering),
          operation!,
        );
      } else await this.beginReview(operation!);
    } else if (phase === 'wrapping' && this.state.plan) {
      await this.sendLeadWithSteering((steering) => buildWrapPrompt(this.state.plan!, steering), operation!);
    }
  }

  async stop(): Promise<void> {
    await this.load();
    if (this.state.phase === 'idle' || this.state.phase === 'done') {
      this.invalidateLead();
      return;
    }
    await this.stopActive(DEV_TEAM_STOPPED);
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

  dispose(): Promise<void> {
    this.disposing ??= this.disposeOnce();
    return this.disposing;
  }

  private async disposeOnce(): Promise<void> {
    this.disposed = true;
    await this.load();
    if (ACTIVE_PHASES.has(this.state.phase) || this.state.phase === 'paused') {
      await this.stopActive('The dev team runtime closed before the run finished.');
    }
    await this.scheduling;
    await Promise.all([...this.engineerClosures, ...this.engineerConsumers]);
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
    } else if (this.state.phase === 'paused') {
      let changed = false;
      for (const record of this.state.tasks) {
        if (record.status !== 'running') continue;
        record.status = 'interrupted';
        record.endedAt = this.now();
        changed = true;
      }
      if (changed) await this.persist();
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const revision = structuredClone(this.state);
    if (this.options.persistState) await this.options.persistState(revision);
    else {
      await writeDevTeamState(this.options.root, this.options.chatId, revision);
      this.options.emitSnapshot(this.publicSnapshot(revision));
    }
  }

  private publicSnapshot(state: DevTeamState): DevTeamSnapshot {
    const {
      version,
      runId,
      phase,
      plan,
      tasks,
      approvals,
      history,
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
      history,
      currentMilestone,
      spec,
      specVersion,
      summary,
      wrap,
      error,
    });
  }

  private beginLead(turn: LeadTurn): LeadOperation {
    if (this.pendingLead) this.pendingLead.stale = true;
    const operation: LeadOperation = {
      epoch: ++this.leadGeneration,
      turn,
      stale: false,
      accepted: false,
      currentProse: '',
      finalProse: '',
      bindingId: this.options.leadBindingId?.(),
      steeringCount: 0,
    };
    this.pendingLead = operation;
    return operation;
  }

  private operationCurrent(operation: LeadOperation): boolean {
    return !operation.stale &&
      (this.pendingLead === operation || this.processingLead === operation || this.leadQueue.includes(operation));
  }

  private leadTurnMatchesPhase(turn: LeadTurn, phase: DevTeamPhase): boolean {
    return (turn === 'interview' && (phase === 'interviewing' || phase === 'drafting-spec')) ||
      (turn === 'revision' && (phase === 'drafting-spec' || phase === 'spec-review')) ||
      (turn === 'planning' && phase === 'planning') ||
      (turn === 'review' && phase === 'reviewing') ||
      (turn === 'wrap' && phase === 'wrapping');
  }

  private leadOperationForPhase(phase: DevTeamPhase): LeadOperation | null {
    return [this.pendingLead, this.processingLead, ...this.leadQueue]
      .find((operation) => operation !== null && !operation.stale && this.leadTurnMatchesPhase(operation.turn, phase)) ?? null;
  }

  private acceptLead(operation: LeadOperation): boolean {
    if (operation.stale || this.pendingLead !== operation) return false;
    operation.accepted = true;
    this.pendingLead = null;
    this.leadQueue.push(operation);
    return true;
  }

  private removeLead(operation: LeadOperation): void {
    operation.stale = true;
    if (this.pendingLead === operation) this.pendingLead = null;
    const index = this.leadQueue.indexOf(operation);
    if (index >= 0) this.leadQueue.splice(index, 1);
    if (this.processingLead === operation) this.processingLead = null;
  }

  private invalidateLead(): void {
    this.leadGeneration += 1;
    if (this.pendingLead) this.pendingLead.stale = true;
    this.pendingLead = null;
    if (this.processingLead) this.processingLead.stale = true;
    for (const operation of this.leadQueue) operation.stale = true;
  }

  private async sendLead(prompt: string, operation: LeadOperation): Promise<void> {
    if (!this.operationCurrent(operation) || this.pendingLead !== operation) return;
    try {
      await this.options.appendLeadRecord({
        role: 'user',
        ts: this.now(),
        text: prompt,
        orchestration: true,
      });
      if (!this.operationCurrent(operation) || !this.acceptLead(operation)) return;
      await this.options.sendLead(prompt, this.state.agent);
    } catch (error) {
      const owned = this.operationCurrent(operation);
      this.removeLead(operation);
      if (owned) {
        const phase = this.state.phase === 'paused' ? this.state.resumePhase : this.state.phase;
        await this.interruptState(`Lead turn failed: ${(error as Error).message}`, phase);
      }
      throw error;
    }
  }

  private leadCompletionCurrent(operation: LeadOperation, paused: boolean, phase: DevTeamPhase | null): boolean {
    if (!this.operationCurrent(operation) || this.processingLead !== operation || phase === null) return false;
    return paused
      ? this.state.phase === 'paused' && this.state.resumePhase === phase
      : this.state.phase === phase;
  }

  private async sendLeadWithSteering(
    build: (steering: string) => string,
    operation: LeadOperation,
  ): Promise<void> {
    const count = this.state.steering.length;
    const steering = this.state.steering.slice(0, count).map((record) => record.text).join('\n');
    operation.steeringCount = count;
    await this.sendLead(build(steering), operation);
  }

  private async acknowledgeSteering(operation: LeadOperation): Promise<void> {
    if (operation.steeringCount === 0) return;
    this.state.steering.splice(0, operation.steeringCount);
    operation.steeringCount = 0;
    await this.persist();
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

  private async finishPlanning(paused: boolean, operation: LeadOperation, phase: DevTeamPhase): Promise<void> {
    const result = await this.readPlanResult();
    if (!this.leadCompletionCurrent(operation, paused, phase)) return;
    if (!result.plan) {
      this.state.retryCount += 1;
      this.state.error = `Plan validation failed: ${result.error ?? 'unknown error'}`;
      if (this.state.retryCount >= MAX_DEV_TEAM_PLAN_RETRIES) {
        this.state.resumePhase = 'planning';
        this.state.phase = 'interrupted';
        await this.persist();
        return;
      }
      if (paused) {
        this.state.phase = 'paused';
        this.state.resumePhase = 'planning';
      }
      const next = paused ? null : this.beginLead('planning');
      await this.persist();
      if (next) {
        await this.sendLeadWithSteering(
          (steering) => buildPlanRepairPrompt(this.options.chatId, result.error ?? 'unknown error', steering),
          next,
        );
      }
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
    this.state.phase = paused ? 'paused' : 'building';
    this.state.resumePhase = paused ? 'building' : null;
    await this.persist();
    if (!paused && this.leadCompletionCurrent(operation, false, 'building')) await this.schedule();
  }

  private async applyReviewPlan(
    paused: boolean,
    operation: LeadOperation,
    phase: DevTeamPhase,
  ): Promise<boolean> {
    const result = await this.readPlanResult();
    if (!this.leadCompletionCurrent(operation, paused, phase)) return false;
    if (!result.plan) return this.rejectReviewPlan(result.error ?? 'unknown error', paused);
    const candidate = result.plan;
    if (!this.state.plan || digest(candidate) === this.state.planDigest) {
      this.state.retryCount = 0;
      this.state.error = null;
      return true;
    }
    const old = this.state.plan;
    const locked = old.milestones.slice(0, this.state.currentMilestone + 1);
    const lockedIds = new Set(locked.map((milestone) => milestone.id));
    const future = candidate.milestones.filter((milestone) => !lockedIds.has(milestone.id));
    const merged: DevTeamPlan = {
      ...candidate,
      milestones: [...locked, ...future],
    };
    const validated = devTeamPlanSchema.safeParse(merged);
    if (!validated.success) {
      return this.rejectReviewPlan(validated.error.issues.map((issue) => issue.message).join(' '), paused);
    }
    const existing = new Map(this.state.tasks.map((record) => [record.taskId, record]));
    const wanted = new Set(merged.milestones.flatMap((milestone) => milestone.tasks.map((task) => task.id)));
    const records = merged.milestones.flatMap((milestone) =>
      milestone.tasks.map((task) => existing.get(task.id) ?? { taskId: task.id, engineerId: '', status: 'pending' as const }),
    );
    for (const record of this.state.tasks) {
      if (!wanted.has(record.taskId) && (record.status === 'done' || record.status === 'running')) records.push(record);
    }
    this.state.plan = validated.data;
    this.state.planDigest = digest(candidate);
    this.state.tasks = records;
    this.state.retryCount = 0;
    this.state.error = null;
    return true;
  }

  private async rejectReviewPlan(error: string, paused: boolean): Promise<false> {
    this.state.retryCount += 1;
    this.state.error = `Plan amendment validation failed: ${error}`;
    if (this.state.retryCount >= MAX_DEV_TEAM_PLAN_RETRIES) {
      this.state.phase = 'interrupted';
      this.state.resumePhase = 'reviewing';
      await this.persist();
      return false;
    }
    if (paused) {
      this.state.phase = 'paused';
      this.state.resumePhase = 'reviewing';
    } else this.state.phase = 'reviewing';
    const next = paused ? null : this.beginLead('review');
    await this.persist();
    if (next) {
      await this.sendLeadWithSteering(
        (steering) => buildPlanRepairPrompt(this.options.chatId, this.state.error!, steering),
        next,
      );
    }
    return false;
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
      const operation = this.beginLead('wrap');
      this.state.phase = 'wrapping';
      await this.persist();
      await this.sendLeadWithSteering((steering) => buildWrapPrompt(this.state.plan!, steering), operation);
      return;
    }

    const records = new Map(this.state.tasks.map((record) => [record.taskId, record]));
    if (this.failBlockedTasks(milestone, records)) await this.persist();

    while (this.active.size < this.maxConcurrency && this.state.phase === 'building') {
      const ready = milestone.tasks.find((task) => this.ready(task, records) && this.scopeAvailable(task));
      if (!ready) break;
      await this.dispatch(ready, records.get(ready.id)!);
    }

    if (this.failBlockedTasks(milestone, records)) await this.persist();

    if (
      this.state.phase === 'building' &&
      milestone.tasks.every((task) => terminal(records.get(task.id)?.status ?? 'pending')) &&
      this.active.size === 0
    ) {
      await this.beginReview();
    }
  }

  private failBlockedTasks(
    milestone: DevTeamPlan['milestones'][number],
    records: Map<string, DevTeamTaskRecord>,
  ): boolean {
    let changed = false;
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
    return changed;
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
    const engineerId = record.engineerId || engineerIdentity(this.options.chatId, task.id);
    record.engineerId = engineerId;
    record.status = 'running';
    record.startedAt = this.now();
    delete record.endedAt;
    const token = Symbol(task.id);
    this.dispatches.set(task.id, token);
    await this.persist();
    if (!this.dispatchOwned(task.id, token, record)) return;

    let driver: ChatDriver | null = null;
    const request: DevTeamEngineerRequest = {
      engineerId,
      sessionId: engineerId,
      task,
      role,
      agent: this.state.agent,
      permissionMode: this.options.permissionMode,
      tools: this.options.tools ?? null,
      resumeContinuationId: record.continuationId,
      onContinuationId: (continuationId) => {
        if (this.dispatches.get(task.id) !== token && this.active.get(engineerId)?.driver !== driver) return;
        const current = this.taskRecord(task.id);
        if (!current || current.continuationId === continuationId) return;
        current.continuationId = continuationId;
        void this.persist();
      },
    };
    let active: ActiveEngineer | null = null;
    try {
      driver = await this.options.createDriver(request);
      if (!this.dispatchOwned(task.id, token, record)) {
        driver.stop();
        this.trackEngineerClosure(driver);
        return;
      }
      await driver.start(request.sessionId, this.options.root);
      this.trackEngineerClosure(driver);
      if (!this.dispatchOwned(task.id, token, record)) {
        driver.stop();
        return;
      }
      active = {
        driver,
        task,
        currentProse: '',
        finalProse: '',
        files: new Set(),
        approvals: new Set(),
        inputs: new Set(),
        withdrawals: null,
        consuming: null,
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
      if (!this.dispatchOwned(task.id, token, record) || this.active.get(engineerId) !== active) {
        if (this.active.get(engineerId) === active) this.active.delete(engineerId);
        driver.stop();
        return;
      }
      const consuming = this.consumeEngineer(engineerId, active).catch(() => undefined);
      active.consuming = consuming;
      this.engineerConsumers.add(consuming);
      void consuming.then(() => this.engineerConsumers.delete(consuming));
      const agent = this.state.agent ? { ...this.state.agent } : {};
      if (task.effort) agent.effort = task.effort;
      if (!this.dispatchOwned(task.id, token, record) || this.active.get(engineerId) !== active) {
        if (this.active.get(engineerId) === active) this.active.delete(engineerId);
        driver.stop();
        return;
      }
      driver.send(prompt, Object.keys(agent).length ? agent : undefined);
      if (this.dispatches.get(task.id) === token) this.dispatches.delete(task.id);
    } catch (error) {
      if (active && this.active.get(engineerId) === active) this.active.delete(engineerId);
      try {
        driver?.stop();
        if (driver) this.trackEngineerClosure(driver);
      } catch {
        // The original setup failure is the useful task error.
      }
      if (this.dispatches.get(task.id) !== token || record.status !== 'running') return;
      this.dispatches.delete(task.id);
      record.status = 'error';
      record.endedAt = this.now();
      record.summary = (error as Error).message;
      await this.persist();
    }
  }

  private dispatchOwned(taskId: string, token: symbol, record: DevTeamTaskRecord): boolean {
    const phaseOwnsBuild =
      this.state.phase === 'building' || (this.state.phase === 'paused' && this.state.resumePhase === 'building');
    return !this.disposed && phaseOwnsBuild && record.status === 'running' && this.dispatches.get(taskId) === token;
  }

  private trackEngineerClosure(driver: ChatDriver): void {
    if (this.trackedEngineerDrivers.has(driver)) return;
    this.trackedEngineerDrivers.add(driver);
    const closed = driver.closed ?? Promise.resolve();
    this.engineerClosures.add(closed);
    void closed.then(
      () => this.engineerClosures.delete(closed),
      () => this.engineerClosures.delete(closed),
    );
  }

  private async consumeEngineer(engineerId: string, active: ActiveEngineer): Promise<void> {
    try {
      for await (const rawEvent of active.driver.events) {
        if (this.active.get(engineerId) !== active) break;
        const event = normalizeChatEvent(rawEvent);
        await this.options.appendEngineerRecord(engineerId, { role: 'agent', ts: this.now(), event });
        if (this.active.get(engineerId) !== active) return;
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
        else if (event.type === 'error') active.finalProse = event.message;
        // Attribution must be routable before a watcher can answer the frame.
        this.options.emitEngineerEvent(engineerId, event);
        if (event.type === 'turn-complete') {
          await this.finishEngineer(engineerId, active, 'done');
          return;
        } else if (event.type === 'error') {
          await this.finishEngineer(engineerId, active, 'error');
          return;
        }
      }
      if (this.active.get(engineerId) === active) {
        active.finalProse = 'Engineer stream ended before completing.';
        await this.finishEngineer(engineerId, active, 'error');
      }
    } catch (error) {
      if (this.active.get(engineerId) !== active) return;
      active.finalProse = `Engineer transcript failed: ${(error as Error).message}`;
      await this.finishEngineer(engineerId, active, 'error');
    }
  }

  private async finishEngineer(
    engineerId: string,
    active: ActiveEngineer,
    status: 'done' | 'error',
  ): Promise<void> {
    if (this.active.get(engineerId) !== active) return;
    const record = this.taskRecord(active.task.id);
    if (!record) return;
    const withdrawalError = await this.withdrawEngineerAsksBestEffort(engineerId, active);
    if (this.active.get(engineerId) !== active) return;
    record.status = status;
    record.endedAt = this.now();
    const summary = active.currentProse.trim() || active.finalProse || (status === 'error' ? 'Engineer failed.' : '');
    record.summary = [summary, withdrawalError].filter(Boolean).join(' ') || undefined;
    record.files = [...active.files];
    if (withdrawalError) this.state.error = withdrawalError;
    this.active.delete(engineerId);
    active.driver.stop();
    await this.persist();
    await this.schedule();
  }

  private withdrawEngineerAsks(engineerId: string, active: ActiveEngineer): Promise<void> {
    if (active.withdrawals) return active.withdrawals;
    const withdrawing = this.persistEngineerWithdrawals(engineerId, active);
    active.withdrawals = withdrawing;
    return withdrawing.finally(() => {
      if (active.withdrawals === withdrawing) active.withdrawals = null;
    });
  }

  private async withdrawEngineerAsksBestEffort(
    engineerId: string,
    active: ActiveEngineer,
  ): Promise<string | null> {
    try {
      await this.withdrawEngineerAsks(engineerId, active);
      return null;
    } catch (error) {
      this.emitUnpersistedEngineerWithdrawals(engineerId, active);
      return `Engineer ${active.task.id} ask withdrawals could not be persisted: ${(error as Error).message}`;
    }
  }

  private emitUnpersistedEngineerWithdrawals(engineerId: string, active: ActiveEngineer): void {
    for (const approvalId of [...active.approvals]) {
      active.approvals.delete(approvalId);
      this.options.emitEngineerEvent(engineerId, {
        type: 'approval-resolved',
        approvalId,
        decision: 'withdrawn',
      });
    }
    for (const inputId of [...active.inputs]) {
      active.inputs.delete(inputId);
      this.options.emitEngineerEvent(engineerId, { type: 'input-resolved', inputId, action: 'withdrawn' });
    }
  }

  private async persistEngineerWithdrawals(engineerId: string, active: ActiveEngineer): Promise<void> {
    for (const approvalId of [...active.approvals]) {
      const event: ChatEvent = { type: 'approval-resolved', approvalId, decision: 'withdrawn' };
      await this.options.appendEngineerRecord(engineerId, { role: 'agent', ts: this.now(), event });
      active.approvals.delete(approvalId);
      this.options.emitEngineerEvent(engineerId, event);
    }
    for (const inputId of [...active.inputs]) {
      const event: ChatEvent = { type: 'input-resolved', inputId, action: 'withdrawn' };
      await this.options.appendEngineerRecord(engineerId, { role: 'agent', ts: this.now(), event });
      active.inputs.delete(inputId);
      this.options.emitEngineerEvent(engineerId, event);
    }
  }

  private async beginReview(operation = this.beginLead('review')): Promise<void> {
    if (!this.state.plan) return;
    this.state.phase = 'reviewing';
    await this.persist();
    await this.sendLeadWithSteering(
      (steering) => buildReviewPrompt(this.state.plan!, this.state.currentMilestone, this.state.tasks, steering),
      operation,
    );
  }

  private async interruptState(error: string, resumePhase?: DevTeamPhase | null): Promise<void> {
    this.invalidateLead();
    const phase = resumePhase ?? this.state.phase;
    this.state.resumePhase = phase === 'paused' ? this.state.resumePhase : phase;
    this.state.phase = 'interrupted';
    this.state.error = error;
    await this.persist();
  }

  private async stopActive(error: string | null): Promise<void> {
    this.invalidateLead();
    this.dispatches.clear();
    const phase = this.state.phase;
    const resumePhase = phase === 'paused' ? this.state.resumePhase : phase;
    const withdrawalErrors: string[] = [];
    for (const [engineerId, active] of [...this.active]) {
      const withdrawalError = await this.withdrawEngineerAsksBestEffort(engineerId, active);
      if (withdrawalError) withdrawalErrors.push(withdrawalError);
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
    const stopped = error === DEV_TEAM_STOPPED;
    this.state.phase = stopped ? 'done' : 'interrupted';
    this.state.resumePhase = stopped ? null : resumePhase;
    this.state.error = [error, ...withdrawalErrors].filter(Boolean).join(' ') || null;
    await this.persist();
  }
}
