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
  parsePlanJson,
  quarantineDevTeamState,
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

// The prompts live in devTeamPrompts.ts. They are re-exported here because the
// runtime is where callers and tests have always found them, and because what
// the team is told is part of this module's public surface even when the words
// are edited somewhere else.
export {
  buildInterviewPrompt,
  buildRevisionPrompt,
  buildInterviewResumePrompt,
  buildPlanPrompt,
  buildPlanRepairPrompt,
  buildEngineerPrompt,
  buildReviewPrompt,
  buildWrapPrompt,
  formatPlanIssues,
  type EngineerPromptInput,
} from './devTeamPrompts.js';

import {
  buildEngineerPrompt,
  buildInterviewPrompt,
  buildInterviewResumePrompt,
  buildPlanPrompt,
  buildPlanRepairPrompt,
  buildReviewPrompt,
  buildRevisionPrompt,
  buildWrapPrompt,
} from './devTeamPrompts.js';
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

// Phases with driver work of our own in flight, which is what makes them worth
// interrupting on reopen and worth pausing. Interviewing and spec review are
// deliberately absent: both are ordinary back-and-forth with the person, they
// survive a restart untouched, and rewriting them as interrupted only forced a
// Resume click before someone could answer the question they were just asked.
const ACTIVE_PHASES = new Set<DevTeamPhase>([
  // `interviewing` belongs here and `spec-review` does not, and the difference
  // is whether anything is RUNNING. An interview has a lead turn in flight —
  // that is what buildInterviewResumePrompt exists to restart. A spec review is
  // a person reading a document; marking it interrupted on reopen threw away
  // the one screen they needed, the spec and its Approve button, to recover
  // from an interruption that never happened.
  'interviewing',
  'drafting-spec',
  'planning',
  'building',
  'reviewing',
  'wrapping',
]);

const DEV_TEAM_STOPPED = 'Dev team run stopped.';
/**
 * Said when a turn was given up on rather than ended. Names what happened and
 * what to do next, because this is the message a person reads at the moment
 * they have been staring at a board that was not moving.
 */
const DEV_TEAM_STALLED =
  'The lead stopped responding, so the run was parked with nothing left running. Resume to run that step again.';

function initialState(): DevTeamState {
  return {
    version: 1,
    runId: '',
    phase: 'idle',
    phaseSince: null,
    milestoneRepairs: {},
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

/**
 * The engineer id is also the session id and the transcript file name, so two
 * runs of the same chat that happen to reuse a task id would otherwise append
 * to one another's history and resume a stranger's continuation. The run id is
 * in the hash for exactly that reason.
 */
export function engineerIdentity(chatId: string, runId: string, taskId: string): string {
  return `devteam-${createHash('sha256').update(`${chatId}\0${runId}\0${taskId}`).digest('hex')}`;
}

function terminal(status: DevTeamTaskRecord['status']): boolean {
  return status === 'done' || status === 'error' || status === 'interrupted';
}

/** A task blocked on an approval still owns a live turn, so it is swept, held
 *  and interrupted everywhere a running one is. */
function inFlight(status: DevTeamTaskRecord['status']): boolean {
  return status === 'running' || status === 'waiting';
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
  /** The phase as of the last persist, so `phaseSince` moves only on a change. */
  private persistedPhase: DevTeamPhase | null = null;
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
        const priorDigest = this.state.planDigest;
        if (!(await this.applyReviewPlan(paused, operation, phase))) return;
        if (!this.leadCompletionCurrent(operation, paused, phase)) return;
        this.state.summary = finalProse || null;
        if (await this.repairMilestone(paused, priorDigest)) return;
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
            await this.sendLeadWithSteering(
              (steering) => buildWrapPrompt(this.state.plan!, steering, this.state.tasks),
              next,
            );
          }
        }
        return;
      }
      if (turn === 'wrap' && phase === 'wrapping') {
        // Its siblings re-check ownership after their own await; this branch had
        // none of its own and inherited the persist inside acknowledgeSteering,
        // so a Stop landing in that window used to be overwritten by a closing
        // handoff for a run that was no longer happening.
        if (!this.leadCompletionCurrent(operation, paused, phase)) return;
        this.state.wrap = finalProse || null;
        if (this.state.steering.length > 0 && this.state.plan) {
          const next = this.beginLead('wrap');
          await this.persist();
          await this.sendLeadWithSteering(
            (steering) => buildWrapPrompt(this.state.plan!, steering, this.state.tasks),
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
        // A plan may already be sitting on disk, complete and valid, from a
        // turn that wrote it and then hung without ever handing it back. Take
        // it rather than paying for the same plan twice and getting a
        // different one. Safe because resetDevTeamHandshakes deletes plan.json
        // whenever a run starts over, so a file here belongs to this run, and
        // because `needsRepair` above already claims the case where the plan
        // on disk is the one we know to be broken.
        //
        // Not when something is queued for the lead. Planning is also
        // interrupted by a REBIND — the person changed the agent mid-turn and
        // said something while doing it — and taking the old plan there would
        // hold their note back until the next review when they have just this
        // second typed it. Someone who has spoken gets a turn that hears them.
        const existing = this.state.steering.length > 0
          ? { plan: null, error: null }
          : await this.readPlanResult();
        if (existing.plan && this.operationCurrent(operation!)) {
          this.removeLead(operation!);
          this.adoptPlan(existing.plan);
          this.state.phase = 'building';
          await this.persist();
          await this.schedule();
          return;
        }
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
      await this.sendLeadWithSteering(
        (steering) => buildWrapPrompt(this.state.plan!, steering, this.state.tasks),
        operation!,
      );
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
    // Seeded from what was read, so the first persist after a load only stamps
    // a new phaseSince if the phase actually moved. Without this, merely
    // opening a conversation would reset how long its phase had been running.
    this.persistedPhase = this.state.phase;
    if (this.state.unreadable) {
      // The file did not parse, so nothing here can be trusted or written over
      // it. Move it aside rather than delete it: it may still be the only
      // record of a run, and leaving it in place made every later write throw
      // and the conversation unusable for good.
      await quarantineDevTeamState(this.options.root, this.options.chatId);
      this.state = await readDevTeamState(this.options.root, this.options.chatId);
      this.loaded = true;
      return;
    }
    if (ACTIVE_PHASES.has(this.state.phase)) {
      const prior = this.state.phase;
      this.state.phase = 'interrupted';
      this.state.resumePhase = prior;
      this.state.error = 'The dev team run was interrupted and needs to be resumed.';
      for (const record of this.state.tasks) {
        if (inFlight(record.status)) {
          record.status = 'interrupted';
          record.endedAt = this.now();
        }
      }
      await this.persist();
    } else if (this.state.phase === 'paused') {
      let changed = false;
      for (const record of this.state.tasks) {
        if (!inFlight(record.status)) continue;
        record.status = 'interrupted';
        record.endedAt = this.now();
        changed = true;
      }
      if (changed) await this.persist();
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    // Stamped here rather than at each of the two dozen sites that assign a
    // phase, because missing one of those sites produces a clock that is wrong
    // rather than a clock that is absent, and a wrong elapsed time is worse
    // than none: it is the pane claiming to know something it does not.
    if (this.state.phase !== this.persistedPhase) {
      this.persistedPhase = this.state.phase;
      // Through the injected clock rather than Date.now(), so a test that
      // controls time controls this too.
      this.state.phaseSince = this.state.phase === 'idle' ? null : Date.parse(this.now());
    }
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
      steering,
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
      phaseSince,
    } = state;
    return structuredClone({
      version,
      runId,
      phase,
      steering,
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
      phaseSince,
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
      // Through parsePlanJson, so a repair turn is told WHICH field is wrong.
      // Joining bare issue messages produced "Required Required Unrecognized
      // key(s)", which names nothing and spends one of three repair attempts.
      return parsePlanJson(await fsp.readFile(file, 'utf8'));
    } catch (error) {
      return { plan: null, error: (error as Error).message };
    }
  }

  /**
   * Take a validated plan as the run's plan and lay out a record per task.
   *
   * Shared by the normal end of a planning turn and by `recover`, which is the
   * point: recovery must produce exactly the state a completed turn would have,
   * or it is a second way of being half-planned rather than a way out of one.
   */
  private adoptPlan(plan: DevTeamPlan): void {
    this.state.plan = plan;
    this.state.planDigest = digest(plan);
    // The id is derived, not allocated, so it can be settled now rather than at
    // dispatch. A record that carries it from 'pending' onward gives the board
    // a stable lane key instead of every unstarted task sharing the empty one.
    this.state.tasks = plan.milestones.flatMap((milestone) =>
      milestone.tasks.map((task) => ({
        taskId: task.id,
        engineerId: engineerIdentity(this.options.chatId, this.state.runId, task.id),
        status: 'pending' as const,
      })),
    );
    this.state.currentMilestone = 0;
    this.state.retryCount = 0;
    this.state.error = null;
  }

  /**
   * Pick the run up from what the team actually produced, when the turn that
   * was supposed to hand it over never finished.
   *
   * A lead turn can end without ending: the agent writes its artifact and the
   * process then sits there, alive and silent. Nothing in the runtime notices,
   * because a hung turn and a slow turn are the same thing from outside. The
   * run stayed in `planning` with `plan: null` and `error: null` while a
   * complete, schema-valid plan.json sat on disk, and the only control offered
   * was Stop, which throws that plan away.
   *
   * So: read the artifact, and if it is good, go on as though the turn had
   * ended properly. If it is not, park the run where Resume can re-run the
   * phase. Either way the person gets somewhere, which is the whole point;
   * "never show a dead end with nothing to press" is the rule this broke.
   */
  async recover(): Promise<void> {
    await this.load();
    if (!ACTIVE_PHASES.has(this.state.phase)) return;

    if (this.state.phase === 'planning') {
      this.invalidateLead();
      const result = await this.readPlanResult();
      if (result.plan) {
        this.adoptPlan(result.plan);
        this.state.phase = 'building';
        this.state.resumePhase = null;
        await this.persist();
        await this.schedule();
        return;
      }
      // A plan that is present but wrong is worth saying out loud: it is the
      // difference between "the lead never answered" and "the lead answered
      // badly", and only the second is worth a repair turn on Resume.
      if (result.error) this.state.retryCount = Math.max(this.state.retryCount, 1);
      await this.stopActive(
        result.error
          ? `The lead stopped responding and the plan it left is not valid: ${result.error}`
          : DEV_TEAM_STALLED,
      );
      return;
    }

    await this.stopActive(DEV_TEAM_STALLED);
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
    this.adoptPlan(result.plan);
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
    const locked = old.milestones.slice(0, this.state.currentMilestone + 1)
      .map((milestone, index) => this.withRepairTasks(milestone, index, candidate));
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
      milestone.tasks.map(
        (task) =>
          existing.get(task.id) ?? {
            taskId: task.id,
            engineerId: engineerIdentity(this.options.chatId, this.state.runId, task.id),
            status: 'pending' as const,
          },
      ),
    );
    for (const record of this.state.tasks) {
      if (!wanted.has(record.taskId) && (record.status === 'done' || inFlight(record.status))) records.push(record);
    }
    this.state.plan = validated.data;
    this.state.planDigest = digest(candidate);
    this.state.tasks = records;
    this.state.retryCount = 0;
    this.state.error = null;
    return true;
  }

  /**
   * Milestones up to and including the one under review are locked, because a
   * review must not be able to rewrite work that already ran. The one exception
   * is the repair round we asked for: there the lead may APPEND remediation
   * tasks to the milestone it just reviewed. Existing tasks keep their identity
   * and their records either way — only ids the plan has never seen are taken.
   */
  private withRepairTasks(
    milestone: DevTeamPlan['milestones'][number],
    index: number,
    candidate: DevTeamPlan,
  ): DevTeamPlan['milestones'][number] {
    if (index !== this.state.currentMilestone) return milestone;
    if ((this.state.milestoneRepairs[milestone.id] ?? 0) !== 1) return milestone;
    const amended = candidate.milestones.find((item) => item.id === milestone.id);
    if (!amended) return milestone;
    const known = new Set(milestone.tasks.map((task) => task.id));
    const added = amended.tasks.filter((task) => !known.has(task.id));
    return added.length ? { ...milestone, tasks: [...milestone.tasks, ...added] } : milestone;
  }

  /**
   * A milestone whose tasks failed used to be reviewed and then marched past,
   * so a broken foundation was built on for the rest of the run and the wrap
   * called it finished. The lead gets exactly one chance per milestone to add
   * repair work; if it declines, or the repair round also fails, the failure is
   * carried in `error` so the wrap has to account for it.
   *
   * Returns true when it has taken over the turn.
   */
  private async repairMilestone(paused: boolean, priorDigest: string | null): Promise<boolean> {
    const milestone = this.state.plan?.milestones[this.state.currentMilestone];
    if (!milestone) return false;
    const failed = milestone.tasks
      .map((task) => this.taskRecord(task.id))
      .filter((record): record is DevTeamTaskRecord => record?.status === 'error')
      .map((record) => record.taskId);
    if (failed.length === 0) return false;
    const named = `Some tasks in this milestone failed: ${failed.join(', ')}.`;
    const attempts = this.state.milestoneRepairs[milestone.id] ?? 0;

    if (attempts === 0) {
      this.state.milestoneRepairs[milestone.id] = 1;
      this.state.error = `${named} The lead was asked to add repair work.`;
      if (paused) {
        // Resume re-enters 'reviewing' and sends the review turn itself.
        this.state.resumePhase = 'reviewing';
        await this.persist();
        return true;
      }
      const next = this.beginLead('review');
      this.state.phase = 'reviewing';
      await this.persist();
      await this.sendLeadWithSteering(
        (steering) => buildReviewPrompt(this.state.plan!, this.state.currentMilestone, this.state.tasks, steering),
        next,
      );
      return true;
    }

    if (attempts > 1) {
      this.state.error = named;
      return false;
    }
    this.state.milestoneRepairs[milestone.id] = 2;
    const repaired =
      this.state.planDigest !== priorDigest &&
      milestone.tasks.some((task) => this.taskRecord(task.id)?.status === 'pending');
    if (!repaired) {
      this.state.error = named;
      return false;
    }
    this.state.error = null;
    if (paused) {
      this.state.resumePhase = 'building';
      await this.persist();
      return true;
    }
    this.state.phase = 'building';
    await this.persist();
    await this.schedule();
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
      await this.sendLeadWithSteering(
        (steering) => buildWrapPrompt(this.state.plan!, steering, this.state.tasks),
        operation,
      );
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
    // Plan time already assigned this; the fallback is only for a record
    // written by an older build, and it recomputes the same value.
    const engineerId = record.engineerId || engineerIdentity(this.options.chatId, this.state.runId, task.id);
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
    let started = false;
    try {
      driver = await this.options.createDriver(request);
      if (!this.dispatchOwned(task.id, token, record)) {
        driver.stop();
        return;
      }
      await driver.start(request.sessionId, this.options.root);
      started = true;
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
        if (driver && started) this.trackEngineerClosure(driver);
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
    return !this.disposed && phaseOwnsBuild && inFlight(record.status) && this.dispatches.get(taskId) === token;
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
        } else if (event.type === 'approval-request') {
          active.approvals.add(event.approvalId);
          await this.syncWaiting(active);
        } else if (event.type === 'approval-resolved') {
          active.approvals.delete(event.approvalId);
          await this.syncWaiting(active);
        } else if (event.type === 'input-request') {
          active.inputs.add(event.inputId);
          await this.syncWaiting(active);
        } else if (event.type === 'input-resolved') {
          active.inputs.delete(event.inputId);
          await this.syncWaiting(active);
        } else if (event.type === 'error') active.finalProse = event.message;
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

  /**
   * A lane blocked on an approval looked identical to one that was working, so
   * a run could sit still for an hour with the board reporting progress. The
   * record says 'waiting' for exactly as long as an ask is outstanding.
   */
  private async syncWaiting(active: ActiveEngineer): Promise<void> {
    const record = this.taskRecord(active.task.id);
    if (!record) return;
    const blocked = active.approvals.size > 0 || active.inputs.size > 0;
    if (blocked && record.status === 'running') record.status = 'waiting';
    else if (!blocked && record.status === 'waiting') record.status = 'running';
    else return;
    await this.persist();
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
    // Stopping something already parked keeps the phase it was parked at,
    // otherwise a second Stop would set 'paused' or 'interrupted' as the thing
    // to resume into and Resume would have nowhere to go.
    const resumePhase = phase === 'paused' || phase === 'interrupted' ? this.state.resumePhase : phase;
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
      if (!inFlight(record.status)) continue;
      record.status = 'interrupted';
      record.endedAt = this.now();
    }
    // Stop used to end the run outright, which threw away a plan, a spec and
    // every engineer transcript because someone wanted the machines to stop
    // for a minute. It parks the run instead: whatever phase it was in is the
    // phase Resume returns to.
    this.state.phase = 'interrupted';
    this.state.resumePhase = resumePhase;
    this.state.error = [error, ...withdrawalErrors].filter(Boolean).join(' ') || null;
    await this.persist();
  }
}
