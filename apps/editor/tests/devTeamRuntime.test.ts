import { promises as fsp, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventQueue, type AgentTurnOptions, type ChatDriver, type ChatEvent, type InputResponse } from '../server/chat';
import type { ChatRecord } from '../server/chatStore';
import {
  DevTeamRuntime,
  buildEngineerPrompt,
  buildInterviewPrompt,
  buildPlanPrompt,
  engineerIdentity,
  type DevTeamEngineerRequest,
} from '../server/devTeamRuntime';
import {
  readDevTeamState,
  writeDevTeamState,
  type DevTeamPlan,
  type DevTeamSnapshot,
} from '../server/devTeamStore';

class ScriptedDriver implements ChatDriver {
  readonly kind = 'stub' as const;
  readonly queue = new EventQueue<ChatEvent>();
  readonly sent: { text: string; agent?: AgentTurnOptions }[] = [];
  readonly approvals: { id: string; decision: 'allow' | 'deny'; choiceId?: string }[] = [];
  readonly inputs: { id: string; response: InputResponse }[] = [];
  starts: { sessionId: string; root: string }[] = [];
  iterations = 0;
  interrupts = 0;
  stops = 0;
  failStart = false;
  failSend = false;
  holdClose = false;
  closedBeforeStartNever = false;
  private stopped = false;
  private started = false;
  private readonly actualClosed: Promise<void>;
  private resolveClosed!: () => void;

  constructor() {
    this.actualClosed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  get closed(): Promise<void> {
    return this.closedBeforeStartNever && !this.started ? new Promise<void>(() => undefined) : this.actualClosed;
  }

  get events(): AsyncIterable<ChatEvent> {
    const queue = this.queue;
    return {
      [Symbol.asyncIterator]: () => {
        this.iterations += 1;
        return queue[Symbol.asyncIterator]();
      },
    };
  }

  async start(sessionId: string, root: string): Promise<void> {
    this.starts.push({ sessionId, root });
    if (this.failStart) throw new Error('start failed');
    this.started = true;
  }

  send(text: string, agent?: AgentTurnOptions): void {
    if (this.failSend) throw new Error('send failed');
    this.sent.push({ text, agent });
  }

  approve(id: string, decision: 'allow' | 'deny', choiceId?: string): void {
    this.approvals.push({ id, decision, choiceId });
  }

  answerInput(id: string, response: InputResponse): void {
    this.inputs.push({ id, response });
  }

  interrupt(): void {
    this.interrupts += 1;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stops += 1;
    this.queue.close();
    if (!this.holdClose) this.resolveClosed();
  }

  releaseClose(): void {
    this.resolveClosed();
  }
}

const role = { id: 'builder', name: 'Systems builder', focus: 'Make the requested experience coherent' };

function plan(tasks: DevTeamPlan['milestones'][number]['tasks'], more: DevTeamPlan['milestones'] = []): DevTeamPlan {
  return {
    version: 1,
    roles: [role],
    milestones: [{ id: 'm1', title: 'Foundation', goal: 'Complete the first outcome', tasks }, ...more],
  };
}

let root: string;
let leadPrompts: string[];
let leadRecords: unknown[];
let snapshots: DevTeamSnapshot[];
let engineerEvents: { engineerId: string; event: ChatEvent }[];
let engineerRecords: { engineerId: string; record: unknown }[];
let drivers: ScriptedDriver[];
let requests: DevTeamEngineerRequest[];
let beforeCreate: ((request: DevTeamEngineerRequest) => Promise<void>) | null;
let driverFailureStage: 'start' | 'append' | 'send' | null;
let beforeEngineerAppend: ((record: ChatRecord) => Promise<void>) | null;
let failLeadSend: boolean;
let failLeadAppend: boolean;
let failAgentAppend: boolean;
let persistentlyFailAgentAppend: boolean;
let closedBeforeStartNever: boolean;
let idCounter: number;
const chatId = 'team-chat';
const runDir = (): string => path.join(root, '.hearth', 'devteam', chatId);

function runtime(maxConcurrency = 2): DevTeamRuntime {
  return new DevTeamRuntime({
    root,
    chatId,
    maxConcurrency,
    agent: { provider: 'openai', model: 'chosen-model', effort: 'max' },
    permissionMode: 'ask',
    tools: { shimDir: '/tools', probeCli: true },
    createDriver: async (request) => {
      requests.push(request);
      await beforeCreate?.(request);
      const driver = new ScriptedDriver();
      driver.closedBeforeStartNever = closedBeforeStartNever;
      driver.failStart = driverFailureStage === 'start';
      driver.failSend = driverFailureStage === 'send';
      drivers.push(driver);
      return driver;
    },
    sendLead: async (text) => {
      if (failLeadSend) throw new Error('lead send failed');
      leadPrompts.push(text);
    },
    appendLeadRecord: async (record) => {
      if (failLeadAppend) throw new Error('lead append failed');
      leadRecords.push(record);
    },
    appendEngineerRecord: async (engineerId, record) => {
      await beforeEngineerAppend?.(record);
      if (driverFailureStage === 'append' && record.role === 'user') throw new Error('append failed');
      if (persistentlyFailAgentAppend && record.role === 'agent') throw new Error('persistent agent transcript failure');
      if (failAgentAppend && record.role === 'agent') {
        failAgentAppend = false;
        throw new Error('agent transcript failed');
      }
      engineerRecords.push({ engineerId, record });
    },
    emitSnapshot: (snapshot) => {
      const persisted = JSON.parse(readFileSync(path.join(runDir(), 'state.json'), 'utf8')) as DevTeamSnapshot;
      expect(persisted).toMatchObject(snapshot);
      snapshots.push(snapshot);
    },
    emitEngineerEvent: (engineerId, event) => {
      engineerEvents.push({ engineerId, event });
    },
    now: () => `2026-07-31T00:00:${String(idCounter).padStart(2, '0')}.000Z`,
    id: () => `id-${++idCounter}`,
  });
}

async function putSpec(text = '# Approved spec\n\nBuild exactly what was requested.\n'): Promise<void> {
  await fsp.mkdir(runDir(), { recursive: true });
  await fsp.writeFile(path.join(runDir(), 'spec.md'), text);
}

async function putPlan(value: unknown): Promise<void> {
  await fsp.mkdir(runDir(), { recursive: true });
  await fsp.writeFile(path.join(runDir(), 'plan.json'), JSON.stringify(value));
}

function blockNextFileRead(fileName: string): { reached: Promise<void>; release: () => void } {
  const readFile = fsp.readFile.bind(fsp) as (...args: unknown[]) => Promise<unknown>;
  let release!: () => void;
  let markReached!: () => void;
  let blocked = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  vi.spyOn(fsp, 'readFile').mockImplementation((async (file: unknown, ...args: unknown[]) => {
    if (!blocked && path.basename(String(file)) === fileName) {
      blocked = true;
      markReached();
      await gate;
    }
    return readFile(file, ...args);
  }) as typeof fsp.readFile);
  return { reached, release };
}

function blockNextRename(): { reached: Promise<void>; release: () => void } {
  const rename = fsp.rename.bind(fsp);
  let release!: () => void;
  let markReached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  vi.spyOn(fsp, 'rename').mockImplementationOnce(async (from, to) => {
    markReached();
    await gate;
    await rename(from, to);
  });
  return { reached, release };
}

/**
 * Polling budget for the whole file.
 *
 * These runs are driven by real promise chains and real fs writes, so every
 * assertion about a phase is a poll. Vitest's 1s default is comfortable on an
 * idle machine and not on one running the whole monorepo suite beside it, and a
 * test that only passes when nothing else is happening is a test that will fail
 * on CI for no reason. Budget generously: a passing poll returns immediately,
 * so this costs nothing when things work.
 */
const WAIT_FOR = { timeout: 15_000, interval: 10 } as const;

/**
 * Wait for the lead to have been SENT the milestone review, not merely for the
 * phase to say so.
 *
 * The run persists and publishes `reviewing` before `sendLead` is accepted, so
 * a test that waits on the phase alone can read the PREVIOUS turn's prompt or
 * settle a turn the lead has not been given yet. That is the same race the
 * socket tests already guard against, and it is what made these tests fail
 * under load and nowhere else.
 */
async function waitForReview(run: DevTeamRuntime): Promise<void> {
  await vi.waitFor(() => {
    expect(run.snapshot().phase).toBe('reviewing');
    expect(leadPrompts.at(-1)).toContain('Review milestone');
  }, WAIT_FOR);
}

async function settleLead(run: DevTeamRuntime, text = 'Lead response'): Promise<void> {
  await run.handleLeadEvent({ type: 'message-delta', text });
  await run.handleLeadEvent({ type: 'turn-complete' });
}

async function reachPlanning(run: DevTeamRuntime): Promise<void> {
  await run.start('Create an experience from this brief.');
  await putSpec();
  await settleLead(run, 'I drafted the spec.');
  expect(run.snapshot().phase).toBe('spec-review');
  await run.approveSpec();
  expect(run.snapshot().phase).toBe('planning');
}

async function reachBuilding(run: DevTeamRuntime, value: DevTeamPlan): Promise<void> {
  await reachPlanning(run);
  await putPlan(value);
  await settleLead(run, 'The plan is ready.');
  await vi.waitFor(() => expect(run.snapshot().phase).toBe('building'), WAIT_FOR);
}

async function complete(driver: ScriptedDriver, text = 'Task handoff.'): Promise<void> {
  driver.queue.push({ type: 'message-delta', text });
  driver.queue.push({ type: 'turn-complete' });
  await vi.waitFor(() => expect(driver.sent).toHaveLength(1), WAIT_FOR);
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-runtime-'));
  leadPrompts = [];
  leadRecords = [];
  snapshots = [];
  engineerEvents = [];
  engineerRecords = [];
  drivers = [];
  requests = [];
  beforeCreate = null;
  driverFailureStage = null;
  beforeEngineerAppend = null;
  failLeadSend = false;
  failLeadAppend = false;
  failAgentAppend = false;
    persistentlyFailAgentAppend = false;
    closedBeforeStartNever = false;
  idCounter = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(root, { recursive: true, force: true });
});

describe('dev team lead state machine', () => {
  it('clears stale handshake files before a new run can observe them', async () => {
    await putSpec('# Stale spec\n');
    await putPlan(plan([{ id: 'stale', title: 'Stale', roleId: role.id, detail: 'Stale work' }]));
    const run = runtime();

    await run.start('A fresh request.');

    await expect(fsp.readFile(path.join(runDir(), 'spec.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.readFile(path.join(runDir(), 'plan.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await settleLead(run, 'No fresh spec was written.');
    expect(run.snapshot()).toMatchObject({ phase: 'interviewing', spec: null });
  });

  it('interviews to spec review and sends revisions through the lead handshake', async () => {
    const run = runtime();
    await run.start('A complete brief with no genre assumptions.');

    expect(run.snapshot()).toMatchObject({ phase: 'interviewing', runId: 'id-1' });
    expect(leadPrompts[0]).toBe(buildInterviewPrompt(chatId, 'A complete brief with no genre assumptions.'));
    expect(leadPrompts[0]).toContain('spec.md');
    expect(leadRecords).toEqual([
      { role: 'user', ts: '2026-07-31T00:00:01.000Z', text: leadPrompts[0], orchestration: true },
    ]);

    await putSpec('# First version\n');
    await settleLead(run);
    expect(run.snapshot()).toMatchObject({ phase: 'spec-review', spec: '# First version\n' });

    await run.handleUserMessage('Make the outcome calmer.');
    expect(leadPrompts.at(-1)).toContain('Make the outcome calmer.');
    expect(leadPrompts.at(-1)).toContain('rewrite');
    await putSpec('# Calmer version\n');
    await settleLead(run);
    expect(run.snapshot()).toMatchObject({ phase: 'spec-review', spec: '# Calmer version\n' });
  });

  it('approves a versioned spec and retries invalid plans three times before interruption', async () => {
    const run = runtime();
    await reachPlanning(run);

    expect(run.snapshot()).toMatchObject({ specVersion: 1, approvals: [{ specVersion: 1 }] });
    expect(await fsp.readFile(path.join(runDir(), 'spec.v1.md'), 'utf8')).toContain('Approved spec');
    expect(leadPrompts.at(-1)).toBe(buildPlanPrompt(chatId, '# Approved spec\n\nBuild exactly what was requested.\n'));

    await putPlan({ version: 1, roles: [], milestones: [] });
    await settleLead(run);
    expect(run.snapshot()).toMatchObject({ phase: 'planning' });
    expect(await readDevTeamState(root, chatId)).toMatchObject({ retryCount: 1 });
    expect(leadPrompts.at(-1)).toMatch(/invalid/i);
    await settleLead(run);
    expect(run.snapshot()).toMatchObject({ phase: 'planning' });
    expect(await readDevTeamState(root, chatId)).toMatchObject({ retryCount: 2 });
    await settleLead(run);
    expect(run.snapshot()).toMatchObject({ phase: 'interrupted', error: expect.stringMatching(/plan/i) });
    expect(await readDevTeamState(root, chatId)).toMatchObject({ retryCount: 3 });
    const promptCount = leadPrompts.length;
    await run.resume();
    expect(run.snapshot()).toMatchObject({ phase: 'planning', error: expect.stringMatching(/plan/i) });
    expect(leadPrompts).toHaveLength(promptCount + 1);
    expect(leadPrompts.at(-1)).toMatch(/invalid/i);
  });

  it('queues planning direction into repair exactly once after its tracked completion', async () => {
    const run = runtime();
    await reachPlanning(run);
    expect(await run.handleUserMessage('Keep the repair within the existing scope.')).toBe(true);
    await putPlan({ version: 1, roles: [], milestones: [] });

    await settleLead(run);
    expect(leadPrompts.at(-1)).toContain('Keep the repair within the existing scope.');
    expect((await readDevTeamState(root, chatId)).steering).toHaveLength(1);

    await settleLead(run);
    expect(leadPrompts.at(-1)).not.toContain('Keep the repair within the existing scope.');
    expect((await readDevTeamState(root, chatId)).steering).toEqual([]);
  });

  it('resumes a paused accepted lead turn without duplicating it or losing later steering', async () => {
    const run = runtime();
    await reachPlanning(run);
    const promptCount = leadPrompts.length;
    await run.pause();
    expect(await run.handleUserMessage('Carry this into milestone review.')).toBe(true);

    await run.resume();
    expect(run.snapshot().phase).toBe('planning');
    expect(leadPrompts).toHaveLength(promptCount);

    await putPlan(plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    await settleLead(run, 'Original planning turn complete.');
    await vi.waitFor(() => expect(run.snapshot().phase).toBe('building'), WAIT_FOR);
    expect((await readDevTeamState(root, chatId)).steering).toHaveLength(1);

    await complete(drivers[0], 'A done.');
    await waitForReview(run);
    expect(leadPrompts.at(-1)).toContain('Carry this into milestone review.');
    await settleLead(run, 'Review complete.');
    expect((await readDevTeamState(root, chatId)).steering).toEqual([]);
  });

  it('correlates interview follow-ups and prevents approval while a revision is running', async () => {
    const run = runtime();
    await run.start('An incomplete brief.');
    await settleLead(run, 'Which direction should this take?');
    expect(run.snapshot().phase).toBe('interviewing');

    expect(await run.handleUserMessage('Use the quieter direction.')).toBe(false);
    await putSpec('# First spec\n');
    await settleLead(run, 'Spec ready.');
    expect(run.snapshot().phase).toBe('spec-review');

    await run.handleUserMessage('Make the result clearer.');
    expect(run.snapshot().phase).toBe('drafting-spec');
    expect(await run.handleUserMessage('Also keep the language concise.')).toBe(true);
    await run.approveSpec();
    expect(run.snapshot().specVersion).toBe(0);
    await putSpec('# Revised clear spec\n');
    await settleLead(run, 'Revision ready.');
    await run.approveSpec();
    expect(run.snapshot()).toMatchObject({ phase: 'planning', spec: '# Revised clear spec\n', specVersion: 1 });
    expect(leadPrompts.at(-1)).toContain('Also keep the language concise.');
  });

  it.each(['append', 'send'] as const)('makes a failed lead %s recoverable through Resume', async (stage) => {
    const run = runtime();
    failLeadAppend = stage === 'append';
    failLeadSend = stage === 'send';

    await expect(run.start('A brief.')).rejects.toThrow(`lead ${stage} failed`);
    expect(run.snapshot()).toMatchObject({ phase: 'interrupted', error: expect.stringMatching(/lead/i) });
    expect(await readDevTeamState(root, chatId)).toMatchObject({ resumePhase: 'interviewing' });

    failLeadAppend = false;
    failLeadSend = false;
    await run.resume();
    expect(run.snapshot().phase).toBe('interviewing');
    expect(leadPrompts.at(-1)).toMatch(/continue.*interview/i);
  });

  it('does not let a stopped interview completion overwrite the terminal run after spec read', async () => {
    const run = runtime();
    await run.start('A brief.');
    await putSpec('# Spec\n');
    const blocked = blockNextFileRead('spec.md');

    const completion = settleLead(run, 'Spec ready.');
    await blocked.reached;
    await run.stop();
    blocked.release();
    await completion;

    expect(run.snapshot()).toMatchObject({ phase: 'interrupted', spec: null, error: expect.stringMatching(/stopped/i) });
    expect(await readDevTeamState(root, chatId)).toMatchObject({
      phase: 'interrupted',
      resumePhase: 'interviewing',
    });
  });

  it('does not dispatch a stopped planning completion after plan read', async () => {
    const run = runtime();
    await reachPlanning(run);
    await putPlan(plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    const blocked = blockNextFileRead('plan.json');

    const completion = settleLead(run, 'Plan ready.');
    await blocked.reached;
    await run.stop();
    blocked.release();
    await completion;

    expect(run.snapshot().phase).toBe('interrupted');
    expect(drivers).toEqual([]);
  });

  it('does not wrap a stopped review completion after amended-plan read', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    await complete(drivers[0], 'A done.');
    await waitForReview(run);
    const blocked = blockNextFileRead('plan.json');

    const completion = settleLead(run, 'Review ready.');
    await blocked.reached;
    await run.stop();
    blocked.release();
    await completion;

    expect(run.snapshot().phase).toBe('interrupted');
    expect(leadPrompts.at(-1)).toMatch(/Review milestone/);
  });

  it('does not let approval overwrite Stop after the spec-version store await', async () => {
    const run = runtime();
    await run.start('A brief.');
    await putSpec('# Spec\n');
    await settleLead(run, 'Spec ready.');
    const promptCount = leadPrompts.length;
    const blocked = blockNextFileRead('spec.md');

    const approving = run.approveSpec();
    await blocked.reached;
    const stopping = run.stop();
    blocked.release();
    await Promise.all([approving, stopping]);

    expect(run.snapshot().phase).toBe('interrupted');
    expect(leadPrompts).toHaveLength(promptCount);
  });

  it('does not let approval overwrite a concurrent revision after its store await', async () => {
    const run = runtime();
    await run.start('A brief.');
    await putSpec('# Old spec\n');
    await settleLead(run, 'Spec ready.');
    const promptCount = leadPrompts.length;
    const blocked = blockNextFileRead('spec.md');

    const approving = run.approveSpec();
    await blocked.reached;
    const revising = run.handleUserMessage('Revise it first.');
    blocked.release();
    await Promise.all([approving, revising]);

    expect(run.snapshot().phase).toBe('drafting-spec');
    expect(run.snapshot().specVersion).toBe(0);
    expect(leadPrompts).toHaveLength(promptCount + 1);
    expect(leadPrompts.at(-1)).toContain('Revise it first.');
  });

  it('does not send a resumed lead turn after Stop invalidates its pending state write', async () => {
    const first = runtime();
    await reachPlanning(first);
    const reopened = runtime();
    await reopened.start();
    expect(reopened.snapshot().phase).toBe('interrupted');
    const promptCount = leadPrompts.length;
    const blocked = blockNextRename();

    const resuming = reopened.resume();
    await blocked.reached;
    const stopping = reopened.stop();
    blocked.release();
    await Promise.all([resuming, stopping]);

    expect(reopened.snapshot().phase).toBe('interrupted');
    expect(leadPrompts).toHaveLength(promptCount);
  });

  it('parks a stopped run as interrupted so Resume re-enters the phase it left', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));

    await run.stop();
    expect(run.snapshot()).toMatchObject({
      phase: 'interrupted',
      error: expect.stringMatching(/stopped/i),
      tasks: [{ status: 'interrupted' }],
    });
    expect(await readDevTeamState(root, chatId)).toMatchObject({ resumePhase: 'building' });

    // A note typed after Stop still belongs to the run, not to ordinary chat.
    expect(await run.handleUserMessage('Keep the calmer direction.')).toBe(true);
    expect((await readDevTeamState(root, chatId)).steering).toEqual([
      { ts: expect.any(String), text: 'Keep the calmer direction.' },
    ]);

    await run.resume();
    await vi.waitFor(() => expect(drivers).toHaveLength(2), WAIT_FOR);
    expect(run.snapshot()).toMatchObject({ phase: 'building', tasks: [{ status: 'running' }] });
  });

  it('leaves a hydrated spec review alone because it has no driver work of its own', async () => {
    await putSpec('# Awaiting approval\n');
    await writeDevTeamState(root, chatId, {
      ...(await readDevTeamState(root, chatId)),
      runId: 'earlier-run',
      phase: 'spec-review',
      spec: '# Awaiting approval\n',
    });

    const run = runtime();
    await run.start();

    expect(run.snapshot()).toMatchObject({ phase: 'spec-review', error: null });
    expect(await readDevTeamState(root, chatId)).toMatchObject({ phase: 'spec-review', resumePhase: null });
    await run.approveSpec();
    expect(run.snapshot().phase).toBe('planning');
  });

  it('runs plan, build, review, and wrap turns through done', async () => {
    const run = runtime();
    await reachBuilding(
      run,
      plan([{ id: 'task-a', title: 'Create foundation', roleId: role.id, detail: 'Implement the foundation.' }]),
    );

    expect(drivers).toHaveLength(1);
    await complete(drivers[0], 'Foundation implemented.');
    await waitForReview(run);
    expect(leadPrompts.at(-1)).toContain('Review milestone 1: Foundation.');
    expect(leadPrompts.at(-1)).toContain('Foundation implemented.');

    await settleLead(run, 'Milestone reviewed.');
    expect(run.snapshot().phase).toBe('wrapping');
    expect(leadPrompts.at(-1)).toContain('closing handoff');
    await settleLead(run, 'Built the requested experience. Known gap: none observed.');
    expect(run.snapshot()).toMatchObject({
      phase: 'done',
      summary: 'Milestone reviewed.',
      wrap: 'Built the requested experience. Known gap: none observed.',
    });

    const completedRunId = run.snapshot().runId;
    await run.handleUserMessage('Add a second chapter.');
    expect(run.snapshot()).toMatchObject({
      phase: 'interviewing',
      history: [expect.objectContaining({
        runId: completedRunId,
        wrap: 'Built the requested experience. Known gap: none observed.',
        completedAt: expect.any(String),
      })],
    });
    expect(run.snapshot().runId).not.toBe(completedRunId);

    const reopened = runtime();
    await reopened.start();
    expect(reopened.snapshot().history).toEqual(run.snapshot().history);
  });
});

describe('engineer scheduling', () => {
  it('honors dependencies, current milestone, and the concurrency cap', async () => {
    const run = runtime();
    await reachBuilding(
      run,
      plan(
        [
          { id: 'a', title: 'A', roleId: role.id, detail: 'A', scope: ['src/a'] },
          { id: 'b', title: 'B', roleId: role.id, detail: 'B', dependsOn: ['a'], scope: ['src/b'] },
          { id: 'c', title: 'C', roleId: role.id, detail: 'C', scope: ['src/c'] },
          { id: 'd', title: 'D', roleId: role.id, detail: 'D', scope: ['src/d'] },
        ],
        [{
          id: 'm2',
          title: 'Second',
          goal: 'Later only',
          tasks: [{ id: 'later', title: 'Later', roleId: role.id, detail: 'Later', scope: ['src/later'] }],
        }],
      ),
    );

    expect(requests.map((request) => request.task.id)).toEqual(['a', 'c']);
    expect(drivers.every((driver) => driver.iterations === 1)).toBe(true);
    await complete(drivers[0], 'A done.');
    await vi.waitFor(() => expect(requests.map((request) => request.task.id)).toEqual(['a', 'c', 'b']), WAIT_FOR);
    await complete(drivers[1], 'C done.');
    await vi.waitFor(() => expect(requests.map((request) => request.task.id)).toEqual(['a', 'c', 'b', 'd']), WAIT_FOR);
    await complete(drivers[2], 'B done.');
    await complete(drivers[3], 'D done.');
    await waitForReview(run);
    expect(requests.some((request) => request.task.id === 'later')).toBe(false);

    await settleLead(run, 'First milestone accepted.');
    await vi.waitFor(() => expect(requests.at(-1)?.task.id).toBe('later'), WAIT_FOR);
    expect(run.snapshot().currentMilestone).toBe(1);
  });

  it('clamps requested concurrency to four', async () => {
    const run = runtime(99);
    await reachBuilding(
      run,
      plan(
        ['a', 'b', 'c', 'd', 'e'].map((id) => ({
          id,
          title: id.toUpperCase(),
          roleId: role.id,
          detail: id,
          scope: [`src/${id}`],
        })),
      ),
    );

    expect(requests.map((request) => request.task.id)).toEqual(['a', 'b', 'c', 'd']);
    await run.dispose();
  });

  it('derives a bounded safe engineer identity from maximum-length task ids', async () => {
    const taskId = `t${'x'.repeat(127)}`;
    const run = runtime();

    await reachBuilding(run, plan([{ id: taskId, title: 'Long id', roleId: role.id, detail: 'Long id task' }]));

    const { engineerId, sessionId } = requests[0];
    expect(engineerId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    expect(engineerId.length).toBeLessThanOrEqual(128);
    expect(sessionId).toBe(engineerId);
    expect(run.snapshot().tasks[0].engineerId).toBe(engineerId);
  });

  it('gives every task record its engineer id at plan time and scopes it to the run', async () => {
    const run = runtime();
    const shape = (): DevTeamPlan =>
      plan([
        { id: 'a', title: 'A', roleId: role.id, detail: 'A', scope: ['src/a'] },
        { id: 'b', title: 'B', roleId: role.id, detail: 'B', dependsOn: ['a'], scope: ['src/b'] },
      ]);
    await reachBuilding(run, shape());

    // The lane key must be stable from 'pending' onward, not only once a task
    // is dispatched.
    const [first, pending] = run.snapshot().tasks;
    expect(pending).toMatchObject({ taskId: 'b', status: 'pending' });
    expect(pending.engineerId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    expect(pending.engineerId).not.toBe(first.engineerId);
    expect(requests[0].engineerId).toBe(first.engineerId);

    await complete(drivers[0], 'A done.');
    await vi.waitFor(() => expect(drivers).toHaveLength(2), WAIT_FOR);
    await complete(drivers[1], 'B done.');
    await waitForReview(run);
    await settleLead(run, 'Reviewed.');
    await settleLead(run, 'Wrapped.');
    expect(run.snapshot().phase).toBe('done');

    await reachBuilding(run, shape());
    expect(run.snapshot().tasks[0].engineerId).not.toBe(first.engineerId);
    expect(engineerIdentity(chatId, 'run-one', 'a')).not.toBe(engineerIdentity(chatId, 'run-two', 'a'));
  });

  it('uses path segments for scope overlap and makes an absent scope exclusive', async () => {
    const run = runtime(4);
    await reachBuilding(
      run,
      plan([
        { id: 'a', title: 'A', roleId: role.id, detail: 'A', scope: ['src/a'] },
        { id: 'ab', title: 'AB', roleId: role.id, detail: 'AB', scope: ['src/ab'] },
        { id: 'child', title: 'Child', roleId: role.id, detail: 'Child', scope: ['src/a/child'] },
        { id: 'exclusive', title: 'Exclusive', roleId: role.id, detail: 'Exclusive' },
      ]),
    );

    expect(requests.map((request) => request.task.id)).toEqual(['a', 'ab']);
    await complete(drivers[1], 'AB done.');
    expect(requests.map((request) => request.task.id)).toEqual(['a', 'ab']);
    await complete(drivers[0], 'A done.');
    await vi.waitFor(() => expect(requests.at(-1)?.task.id).toBe('child'), WAIT_FOR);
    await complete(drivers[2], 'Child done.');
    await vi.waitFor(() => expect(requests.at(-1)?.task.id).toBe('exclusive'), WAIT_FOR);
  });

  it('maps effort without changing the selected provider or model and builds a complete neutral prompt', async () => {
    const run = runtime();
    const task = {
      id: 'focused',
      title: 'Focused task',
      roleId: role.id,
      detail: 'Work only on this outcome.',
      effort: 'low' as const,
      scope: ['src/focused'],
    };
    await reachBuilding(run, plan([task]));

    expect(drivers[0].sent[0].agent).toEqual({ provider: 'openai', model: 'chosen-model', effort: 'low' });
    expect(drivers[0].sent[0].text).toBe(buildEngineerPrompt({
      spec: '# Approved spec\n\nBuild exactly what was requested.\n',
      role,
      task,
      dependencies: [],
      context: '',
    }));
    expect(drivers[0].sent[0].text).toMatch(/decide/i);
    expect(drivers[0].sent[0].text).toMatch(/handoff/i);
  });
});

describe('engineer durability and controls', () => {
  it('captures only observed file changes and the final completed prose', async () => {
    const run = runtime();
    await reachBuilding(
      run,
      plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A', scope: ['src'] }]),
    );
    const driver = drivers[0];
    driver.queue.push({ type: 'message-delta', text: 'Earlier prose.' });
    driver.queue.push({ type: 'message-end' });
    driver.queue.push({
      type: 'file-change',
      files: [
        { path: 'src/a.ts', kind: 'edit' },
        { path: 'src/a.ts', kind: 'edit' },
        { path: 'src/b.ts', kind: 'create' },
      ],
    });
    driver.queue.push({ type: 'message-delta', text: 'Final handoff.' });
    driver.queue.push({ type: 'turn-complete' });

    await vi.waitFor(() => expect(run.snapshot().tasks[0]?.status).toBe('done'), WAIT_FOR);
    expect(run.snapshot().tasks[0]).toMatchObject({ summary: 'Final handoff.', files: ['src/a.ts', 'src/b.ts'] });
    expect(engineerRecords[0]).toMatchObject({
      engineerId: run.snapshot().tasks[0].engineerId,
      record: { role: 'user', text: expect.stringContaining('short factual handoff') },
    });
    expect(engineerRecords.at(-1)).toMatchObject({ record: { role: 'agent', event: { type: 'turn-complete' } } });
    expect(engineerEvents.every((item) => item.engineerId === run.snapshot().tasks[0].engineerId)).toBe(true);
  });

  it('attributes engineer approvals and inputs and routes answers to that driver', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    const engineerId = run.snapshot().tasks[0].engineerId;
    drivers[0].queue.push({
      type: 'approval-request',
      approvalId: 'approval-1',
      kind: 'command',
      title: 'Run command',
      detail: 'Do the thing',
    });
    drivers[0].queue.push({
      type: 'input-request',
      inputId: 'input-1',
      questions: [{ id: 'answer', label: 'Answer', type: 'text' }],
    });
    await vi.waitFor(() => expect(engineerEvents).toHaveLength(2), WAIT_FOR);
    expect(engineerEvents.map((item) => item.engineerId)).toEqual([engineerId, engineerId]);

    expect(run.routeEngineerApproval(engineerId, 'approval-1', 'allow', 'once')).toBe(true);
    expect(run.routeEngineerInput(engineerId, 'input-1', { action: 'submit', answers: { answer: 'yes' } })).toBe(true);
    expect(drivers[0].approvals).toEqual([{ id: 'approval-1', decision: 'allow', choiceId: 'once' }]);
    expect(drivers[0].inputs).toEqual([
      { id: 'input-1', response: { action: 'submit', answers: { answer: 'yes' } } },
    ]);
    expect(run.routeEngineerApproval('another', 'approval-1', 'deny')).toBe(false);
  });

  it('holds a task at waiting for exactly as long as an ask is outstanding', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    const engineerId = run.snapshot().tasks[0].engineerId;
    expect(run.snapshot().tasks[0].status).toBe('running');

    drivers[0].queue.push({
      type: 'approval-request',
      approvalId: 'ask-1',
      kind: 'command',
      title: 'Run',
      detail: 'Run',
    });
    await vi.waitFor(() => expect(run.snapshot().tasks[0].status).toBe('waiting'), WAIT_FOR);
    expect(await readDevTeamState(root, chatId)).toMatchObject({ tasks: [{ status: 'waiting' }] });

    drivers[0].queue.push({
      type: 'input-request',
      inputId: 'ask-2',
      questions: [{ id: 'x', label: 'X', type: 'text' }],
    });
    drivers[0].queue.push({ type: 'approval-resolved', approvalId: 'ask-1', decision: 'allow' });
    await vi.waitFor(() => expect(engineerEvents).toHaveLength(3), WAIT_FOR);
    // One answered ask does not unblock a lane that is still holding another.
    expect(run.snapshot().tasks[0].status).toBe('waiting');

    drivers[0].queue.push({ type: 'input-resolved', inputId: 'ask-2', action: 'submit' });
    await vi.waitFor(() => expect(run.snapshot().tasks[0].status).toBe('running'), WAIT_FOR);
    expect(run.snapshot().tasks[0].engineerId).toBe(engineerId);

    await complete(drivers[0], 'A done.');
    await vi.waitFor(() => expect(run.snapshot().tasks[0].status).toBe('done'), WAIT_FOR);
  });

  it('records an engineer error and still settles the milestone into review', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    drivers[0].queue.push({ type: 'error', message: 'provider failed' });
    await waitForReview(run);
    expect(run.snapshot().tasks[0]).toMatchObject({ status: 'error', summary: 'provider failed' });
  });

  it('settles a reverse-ordered chain whose root dependency errors', async () => {
    const run = runtime();
    await reachBuilding(
      run,
      plan([
        { id: 'c', title: 'C', roleId: role.id, detail: 'C', dependsOn: ['b'] },
        { id: 'b', title: 'B', roleId: role.id, detail: 'B', dependsOn: ['a'] },
        { id: 'a', title: 'A', roleId: role.id, detail: 'A' },
      ]),
    );
    expect(requests.map((request) => request.task.id)).toEqual(['a']);

    drivers[0].queue.push({ type: 'error', message: 'root failed' });
    await waitForReview(run);
    expect(run.snapshot().tasks.map((task) => [task.taskId, task.status])).toEqual([
      ['c', 'error'],
      ['b', 'error'],
      ['a', 'error'],
    ]);
  });

  it('pauses without dispatching after running turns finish, then resumes pending work', async () => {
    const run = runtime(1);
    await reachBuilding(
      run,
      plan([
        { id: 'a', title: 'A', roleId: role.id, detail: 'A', scope: ['a'] },
        { id: 'b', title: 'B', roleId: role.id, detail: 'B', scope: ['b'] },
      ]),
    );
    await run.pause();
    expect(run.snapshot()).toMatchObject({ phase: 'paused' });
    expect(await readDevTeamState(root, chatId)).toMatchObject({ resumePhase: 'building' });
    await complete(drivers[0], 'A done.');
    await vi.waitFor(() => expect(run.snapshot().tasks[0]?.status).toBe('done'), WAIT_FOR);
    expect(drivers).toHaveLength(1);

    await run.resume();
    await vi.waitFor(() => expect(drivers).toHaveLength(2), WAIT_FOR);
    expect(run.snapshot().phase).toBe('building');
  });

  it('stop ends the run and withdraws active engineer asks', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    const engineerId = run.snapshot().tasks[0].engineerId;
    drivers[0].queue.push({
      type: 'approval-request',
      approvalId: 'approval-1',
      kind: 'command',
      title: 'Run',
      detail: 'Run',
    });
    drivers[0].queue.push({
      type: 'input-request',
      inputId: 'input-1',
      questions: [{ id: 'x', label: 'X', type: 'text' }],
    });
    await vi.waitFor(() => expect(engineerEvents).toHaveLength(2), WAIT_FOR);

    await run.stop();
    expect(drivers[0].interrupts).toBe(1);
    expect(run.snapshot()).toMatchObject({ phase: 'interrupted', error: expect.stringMatching(/stopped/i) });
    expect(await readDevTeamState(root, chatId)).toMatchObject({
      phase: 'interrupted',
      resumePhase: 'building',
    });
    expect(run.snapshot().tasks[0].status).toBe('interrupted');
    expect(engineerEvents.slice(-2)).toEqual([
      { engineerId, event: { type: 'approval-resolved', approvalId: 'approval-1', decision: 'withdrawn' } },
      { engineerId, event: { type: 'input-resolved', inputId: 'input-1', action: 'withdrawn' } },
    ]);
  });

  it('still ends and interrupts the run when ask withdrawal writes keep failing', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    const engineerId = run.snapshot().tasks[0].engineerId;
    drivers[0].queue.push({
      type: 'approval-request',
      approvalId: 'unpersisted-approval',
      kind: 'command',
      title: 'Run',
      detail: 'Run',
    });
    drivers[0].queue.push({
      type: 'input-request',
      inputId: 'unpersisted-input',
      questions: [{ id: 'x', label: 'X', type: 'text' }],
    });
    await vi.waitFor(() => expect(engineerEvents).toHaveLength(2), WAIT_FOR);
    persistentlyFailAgentAppend = true;

    await expect(run.stop()).resolves.toBeUndefined();

    expect(drivers[0].interrupts).toBe(1);
    expect(drivers[0].stops).toBe(1);
    expect(run.snapshot()).toMatchObject({
      phase: 'interrupted',
      error: expect.stringMatching(/withdraw.*persist|persist.*withdraw/i),
      tasks: [{ status: 'interrupted' }],
    });
    expect(engineerEvents.slice(-2)).toEqual([
      { engineerId, event: { type: 'approval-resolved', approvalId: 'unpersisted-approval', decision: 'withdrawn' } },
      { engineerId, event: { type: 'input-resolved', inputId: 'unpersisted-input', action: 'withdrawn' } },
    ]);
  });

  it('stop cancels an engineer whose driver is still being created', async () => {
    const run = runtime();
    await reachPlanning(run);
    await putPlan(plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    let release!: () => void;
    let creationReached!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      creationReached = resolve;
    });
    beforeCreate = async () => {
      creationReached();
      await blocked;
    };

    const planning = settleLead(run, 'Plan ready.');
    await reached;
    await run.stop();
    release();
    await planning;

    expect(run.snapshot().tasks[0].status).toBe('interrupted');
    expect(drivers[0].sent).toEqual([]);
    expect(drivers[0].stops).toBe(1);
  });

  it('dispose waits for an engineer that is still being created', async () => {
    const run = runtime();
    await reachPlanning(run);
    await putPlan(plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    let release!: () => void;
    let creationReached!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { creationReached = resolve; });
    beforeCreate = async () => {
      creationReached();
      await blocked;
    };
    closedBeforeStartNever = true;

    const planning = settleLead(run, 'Plan ready.');
    await reached;
    let disposed = false;
    const disposing = run.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    release();
    await Promise.all([planning, disposing]);

    expect(drivers[0].sent).toEqual([]);
    expect(drivers[0].stops).toBe(1);
  });

  it('dispose waits for a completed engineer provider to close', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    drivers[0].holdClose = true;
    await complete(drivers[0], 'Done.');
    await waitForReview(run);

    let disposed = false;
    const disposing = run.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    drivers[0].releaseClose();
    await disposing;
  });

  it('does not restart a stale engineer after Stop races its prompt append', async () => {
    const run = runtime();
    await reachPlanning(run);
    await putPlan(plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    let release!: () => void;
    let appendReached!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      appendReached = resolve;
    });
    beforeEngineerAppend = async (record) => {
      if (record.role !== 'user') return;
      appendReached();
      await blocked;
    };

    const planning = settleLead(run, 'Plan ready.');
    await reached;
    await run.stop();
    beforeEngineerAppend = null;
    const resuming = run.resume();
    release();
    await Promise.all([planning, resuming]);

    expect(drivers[0].sent).toEqual([]);
    expect(drivers[0].stops).toBe(1);
    // Resume starts a fresh engineer rather than handing work to the retired one.
    await vi.waitFor(() => expect(drivers).toHaveLength(2), WAIT_FOR);
    expect(run.snapshot()).toMatchObject({ phase: 'building', tasks: [{ status: 'running' }] });
  });

  it.each(['start', 'append', 'send'] as const)('stops a created driver when engineer %s fails', async (stage) => {
    const run = runtime();
    await reachPlanning(run);
    driverFailureStage = stage;
    await putPlan(plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));

    await settleLead(run, 'Plan ready.');

    expect(run.snapshot().tasks[0]).toMatchObject({ status: 'error', summary: `${stage} failed` });
    expect(drivers[0].stops).toBe(1);
    expect(drivers[0].iterations).toBe(stage === 'send' ? 1 : 0);
  });

  it('settles dependents and advances after engineer startup failure', async () => {
    const run = runtime();
    await reachPlanning(run);
    driverFailureStage = 'start';
    await putPlan(
      plan([
        { id: 'dependent', title: 'Dependent', roleId: role.id, detail: 'Dependent', dependsOn: ['root'] },
        { id: 'root', title: 'Root', roleId: role.id, detail: 'Root' },
      ]),
    );

    await settleLead(run, 'Plan ready.');
    expect(run.snapshot().phase).toBe('reviewing');
    expect(run.snapshot().tasks.map((task) => [task.taskId, task.status])).toEqual([
      ['dependent', 'error'],
      ['root', 'error'],
    ]);
  });

  it('does not let an in-flight terminal event overwrite Stop', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    let release!: () => void;
    let appendReached!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      appendReached = resolve;
    });
    beforeEngineerAppend = async (record) => {
      if (record.role !== 'agent' || record.event.type !== 'turn-complete') return;
      appendReached();
      await blocked;
    };

    drivers[0].queue.push({ type: 'turn-complete' });
    await reached;
    await run.stop();
    release();
    await vi.waitFor(() => expect(engineerRecords.at(-1)).toMatchObject({ record: { role: 'agent' } }), WAIT_FOR);
    expect(run.snapshot().tasks[0].status).toBe('interrupted');
  });

  it('stops and settles an engineer when its event transcript write fails', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    const engineerId = run.snapshot().tasks[0].engineerId;
    drivers[0].queue.push({
      type: 'approval-request',
      approvalId: 'approval-before-failure',
      kind: 'command',
      title: 'Run',
      detail: 'Run',
    });
    drivers[0].queue.push({
      type: 'input-request',
      inputId: 'input-before-failure',
      questions: [{ id: 'x', label: 'X', type: 'text' }],
    });
    await vi.waitFor(() => expect(engineerEvents).toHaveLength(2), WAIT_FOR);
    failAgentAppend = true;

    drivers[0].queue.push({ type: 'message-delta', text: 'Unpersisted.' });

    await vi.waitFor(() => expect(run.snapshot().tasks[0].status).toBe('error'), WAIT_FOR);
    expect(run.snapshot().tasks[0].summary).toContain('agent transcript failed');
    expect(drivers[0].stops).toBe(1);
    expect(run.snapshot().phase).toBe('reviewing');
    expect(engineerRecords.slice(-2)).toEqual([
      {
        engineerId,
        record: {
          role: 'agent',
          ts: expect.any(String),
          event: { type: 'approval-resolved', approvalId: 'approval-before-failure', decision: 'withdrawn' },
        },
      },
      {
        engineerId,
        record: {
          role: 'agent',
          ts: expect.any(String),
          event: { type: 'input-resolved', inputId: 'input-before-failure', action: 'withdrawn' },
        },
      },
    ]);
  });

  it('persists withdrawn asks before settling a bare engineer stream end', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    const engineerId = run.snapshot().tasks[0].engineerId;
    drivers[0].queue.push({
      type: 'approval-request',
      approvalId: 'approval-at-end',
      kind: 'command',
      title: 'Run',
      detail: 'Run',
    });
    drivers[0].queue.push({
      type: 'input-request',
      inputId: 'input-at-end',
      questions: [{ id: 'x', label: 'X', type: 'text' }],
    });
    await vi.waitFor(() => expect(engineerEvents).toHaveLength(2), WAIT_FOR);

    drivers[0].queue.close();

    await vi.waitFor(() => expect(run.snapshot().tasks[0].status).toBe('error'), WAIT_FOR);
    expect(engineerRecords.slice(-2)).toEqual([
      {
        engineerId,
        record: {
          role: 'agent',
          ts: expect.any(String),
          event: { type: 'approval-resolved', approvalId: 'approval-at-end', decision: 'withdrawn' },
        },
      },
      {
        engineerId,
        record: {
          role: 'agent',
          ts: expect.any(String),
          event: { type: 'input-resolved', inputId: 'input-at-end', action: 'withdrawn' },
        },
      },
    ]);
  });

  it('settles a bare stream end when ask withdrawal writes keep failing', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    const engineerId = run.snapshot().tasks[0].engineerId;
    drivers[0].queue.push({
      type: 'approval-request',
      approvalId: 'unpersisted-at-end',
      kind: 'command',
      title: 'Run',
      detail: 'Run',
    });
    await vi.waitFor(() => expect(engineerEvents).toHaveLength(1), WAIT_FOR);
    persistentlyFailAgentAppend = true;

    drivers[0].queue.close();

    await waitForReview(run);
    expect(run.snapshot()).toMatchObject({
      phase: 'reviewing',
      error: expect.stringMatching(/withdraw.*persist|persist.*withdraw/i),
      tasks: [{ status: 'error', summary: expect.stringMatching(/withdraw.*persist|persist.*withdraw/i) }],
    });
    expect(drivers[0].stops).toBe(1);
    expect(engineerEvents.at(-1)).toEqual({
      engineerId,
      event: { type: 'approval-resolved', approvalId: 'unpersisted-at-end', decision: 'withdrawn' },
    });
  });
});

describe('restart, steering, and plan rewrites', () => {
  it('rehydrates an ownerless active run as interrupted and requires resume', async () => {
    const first = runtime();
    await reachBuilding(first, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A', scope: ['src'] }]));
    const before = first.snapshot().tasks[0];
    drivers = [];
    requests = [];

    const reopened = runtime();
    await reopened.start();
    expect(reopened.snapshot()).toMatchObject({ phase: 'interrupted' });
    expect(await readDevTeamState(root, chatId)).toMatchObject({ resumePhase: 'building' });
    expect(reopened.snapshot().tasks[0]).toMatchObject({ ...before, status: 'interrupted' });
    expect(drivers).toHaveLength(0);

    await reopened.resume();
    await vi.waitFor(() => expect(drivers).toHaveLength(1), WAIT_FOR);
    expect(requests[0].resumeContinuationId).toBe(before.continuationId);
    expect(reopened.snapshot().phase).toBe('building');
  });

  it('rehydrates a paused run with orphaned work still paused and redispatches it on resume', async () => {
    const first = runtime();
    await reachBuilding(first, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    await first.pause();
    drivers = [];
    requests = [];

    const reopened = runtime();
    await reopened.start();
    expect(reopened.snapshot()).toMatchObject({ phase: 'paused', tasks: [{ taskId: 'a', status: 'interrupted' }] });
    expect(await readDevTeamState(root, chatId)).toMatchObject({ phase: 'paused', resumePhase: 'building' });

    await reopened.resume();
    await vi.waitFor(() => expect(requests.map((request) => request.task.id)).toEqual(['a']), WAIT_FOR);
    expect(reopened.snapshot()).toMatchObject({ phase: 'building', tasks: [{ taskId: 'a', status: 'running' }] });
  });

  it('starts over from an unreadable state file instead of refusing every later write', async () => {
    const first = runtime();
    await first.start('A brief.');
    const file = path.join(root, '.hearth', 'devteam', chatId, 'state.json');
    await fsp.writeFile(file, '{ this is not json');

    const reopened = runtime();
    await reopened.start();

    // The corrupt file is kept beside the run rather than deleted, and the
    // conversation can be used again — it used to throw on every persist.
    expect(await fsp.readFile(`${file}.corrupt`, 'utf8')).toBe('{ this is not json');
    expect(reopened.snapshot().phase).toBe('idle');
    expect(await reopened.handleUserMessage('Start again.')).toBe(true);
    expect((await readDevTeamState(root, chatId)).phase).toBe('interviewing');
  });

  it('marks a reopened interview interrupted, because its lead turn was in flight', async () => {
    const first = runtime();
    await first.start('An unfinished brief.');

    const reopened = runtime();
    await reopened.start();

    // The opposite of the spec review below: a turn WAS running, and only the
    // lead can pick it up again, so Resume is the honest offer.
    expect(reopened.snapshot()).toMatchObject({ phase: 'interrupted' });
    // resumePhase is state, not snapshot — the pane never needs it, Resume does.
    expect(await readDevTeamState(root, chatId)).toMatchObject({ resumePhase: 'interviewing' });
  });

  it('folds paused revision and planning completions without losing files or duplicating lead turns', async () => {
    const interview = runtime();
    await interview.start('A complete brief.');
    await putSpec('# First spec\n');
    await settleLead(interview, 'Spec written.');
    expect(interview.snapshot().phase).toBe('spec-review');

    await interview.handleUserMessage('Make the outcome calmer.');
    expect(interview.snapshot().phase).toBe('drafting-spec');
    await interview.pause();
    await putSpec('# Paused spec\n');
    await settleLead(interview, 'Revision written.');
    expect(interview.snapshot()).toMatchObject({ phase: 'paused', spec: '# Paused spec\n' });
    expect(await readDevTeamState(root, chatId)).toMatchObject({ resumePhase: 'spec-review' });
    await interview.resume();
    expect(interview.snapshot().phase).toBe('spec-review');

    await interview.approveSpec();
    await putPlan(plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    const promptCount = leadPrompts.length;
    await interview.pause();
    await settleLead(interview, 'Plan written.');
    expect(interview.snapshot()).toMatchObject({ phase: 'paused', tasks: [{ taskId: 'a', status: 'pending' }] });
    expect(await readDevTeamState(root, chatId)).toMatchObject({ resumePhase: 'building' });
    expect(leadPrompts).toHaveLength(promptCount);

    await interview.resume();
    await vi.waitFor(() => expect(drivers).toHaveLength(1), WAIT_FOR);
    expect(interview.snapshot().phase).toBe('building');
    expect(leadPrompts).toHaveLength(promptCount);
  });

  it('folds paused review and wrap completions exactly once', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    await complete(drivers[0], 'A done.');
    await waitForReview(run);
    const reviewPromptCount = leadPrompts.length;

    await run.pause();
    await settleLead(run, 'Review complete.');
    expect(run.snapshot()).toMatchObject({ phase: 'paused', summary: 'Review complete.' });
    expect(await readDevTeamState(root, chatId)).toMatchObject({ resumePhase: 'wrapping' });
    expect(leadPrompts).toHaveLength(reviewPromptCount);

    await run.resume();
    expect(run.snapshot().phase).toBe('wrapping');
    expect(leadPrompts).toHaveLength(reviewPromptCount + 1);
    await run.pause();
    await settleLead(run, 'Final wrap.');
    expect(run.snapshot()).toMatchObject({ phase: 'done', wrap: 'Final wrap.' });
    expect(leadPrompts).toHaveLength(reviewPromptCount + 1);
  });

  it('persists steering during build and folds it into the next lead turn', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    await run.handleUserMessage('Please emphasize clarity.');
    expect((await readDevTeamState(root, chatId)).steering).toEqual([
      { ts: expect.any(String), text: 'Please emphasize clarity.' },
    ]);

    await complete(drivers[0], 'A done.');
    await waitForReview(run);
    expect(leadPrompts.at(-1)).toContain('Please emphasize clarity.');
    expect((await readDevTeamState(root, chatId)).steering).toHaveLength(1);
    await settleLead(run, 'Review complete.');
    expect((await readDevTeamState(root, chatId)).steering).toEqual([]);
    expect(leadPrompts.at(-1)).not.toContain('Please emphasize clarity.');
  });

  it('runs a tracked follow-up wrap for direction received during wrapping', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    await complete(drivers[0], 'A done.');
    await waitForReview(run);
    await settleLead(run, 'Review complete.');
    expect(run.snapshot().phase).toBe('wrapping');
    const promptCount = leadPrompts.length;

    expect(await run.handleUserMessage('Mention the alternate launch path.')).toBe(true);
    await settleLead(run, 'First wrap.');
    expect(run.snapshot().phase).toBe('wrapping');
    expect(leadPrompts).toHaveLength(promptCount + 1);
    expect(leadPrompts.at(-1)).toContain('Mention the alternate launch path.');
    expect((await readDevTeamState(root, chatId)).steering).toHaveLength(1);

    await settleLead(run, 'Final wrap.');
    expect(run.snapshot()).toMatchObject({ phase: 'done', wrap: 'Final wrap.' });
    expect((await readDevTeamState(root, chatId)).steering).toEqual([]);
  });

  it('does not let a stopped wrap turn land after its steering acknowledgement', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    await complete(drivers[0], 'A done.');
    await waitForReview(run);
    await settleLead(run, 'Review complete.');
    expect(run.snapshot().phase).toBe('wrapping');
    expect(await run.handleUserMessage('Mention the alternate launch path.')).toBe(true);
    await settleLead(run, 'First wrap.');
    expect(run.snapshot()).toMatchObject({ phase: 'wrapping', wrap: 'First wrap.' });

    const blocked = blockNextRename();
    const completion = settleLead(run, 'Second wrap.');
    await blocked.reached;
    const stopping = run.stop();
    blocked.release();
    await Promise.all([completion, stopping]);

    expect(run.snapshot()).toMatchObject({ phase: 'interrupted', wrap: 'First wrap.' });
    expect(await readDevTeamState(root, chatId)).toMatchObject({
      phase: 'interrupted',
      resumePhase: 'wrapping',
      wrap: 'First wrap.',
    });
  });

  it('gives a milestone one repair round before carrying its failure into the wrap', async () => {
    const run = runtime();
    const failing = { id: 'a', title: 'A', roleId: role.id, detail: 'A' };
    await reachBuilding(run, plan([failing]));

    drivers[0].queue.push({ type: 'error', message: 'provider failed' });
    await waitForReview(run);

    await settleLead(run, 'The task failed.');
    expect(run.snapshot()).toMatchObject({ phase: 'reviewing', error: expect.stringContaining('failed: a') });
    expect(leadPrompts.at(-1)).toContain('Review milestone 1');
    expect(await readDevTeamState(root, chatId)).toMatchObject({ milestoneRepairs: { m1: 1 } });

    await putPlan(plan([failing, { id: 'a-repair', title: 'Repair A', roleId: role.id, detail: 'Redo the work' }]));
    await settleLead(run, 'I added a repair task.');
    await vi.waitFor(() => expect(requests.at(-1)?.task.id).toBe('a-repair'), WAIT_FOR);
    expect(run.snapshot()).toMatchObject({ phase: 'building', currentMilestone: 0, error: null });

    await complete(drivers[1], 'Repaired.');
    await waitForReview(run);
    await settleLead(run, 'Reviewed the repair.');

    // One repair round only: the second review advances instead of asking again,
    // and the failure is still named so the wrap cannot call it finished.
    expect(run.snapshot()).toMatchObject({ phase: 'wrapping', error: expect.stringContaining('failed: a') });
    expect(await readDevTeamState(root, chatId)).toMatchObject({ milestoneRepairs: { m1: 2 } });
    expect(drivers).toHaveLength(2);
  });

  it('keeps the current milestone locked when no repair was asked for', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'done', title: 'Done', roleId: role.id, detail: 'Do it' }]));
    await complete(drivers[0], 'Done.');
    await waitForReview(run);

    await putPlan(
      plan([
        { id: 'done', title: 'Done', roleId: role.id, detail: 'Do it' },
        { id: 'extra', title: 'Extra', roleId: role.id, detail: 'Not invited' },
      ]),
    );
    await settleLead(run, 'Reviewed.');

    expect(run.snapshot().tasks.map((task) => task.taskId)).toEqual(['done']);
    expect(run.snapshot().phase).toBe('wrapping');
  });

  it('keeps steering durable until the next lead prompt is appended and sent', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    await complete(drivers[0], 'A done.');
    await waitForReview(run);
    await run.handleUserMessage('Keep this instruction.');
    failLeadSend = true;

    await expect(settleLead(run, 'Review complete.')).rejects.toThrow('lead send failed');

    expect((await readDevTeamState(root, chatId)).steering).toEqual([
      { ts: expect.any(String), text: 'Keep this instruction.' },
    ]);
  });

  it('merges review amendments by milestone identity when current work is omitted and future work is reordered', async () => {
    const run = runtime();
    const second = {
      id: 'm2',
      title: 'Second',
      goal: 'Second outcome',
      tasks: [{ id: 'second', title: 'Second', roleId: role.id, detail: 'Second task' }],
    };
    const third = {
      id: 'm3',
      title: 'Third',
      goal: 'Third outcome',
      tasks: [{ id: 'third', title: 'Third', roleId: role.id, detail: 'Third task' }],
    };
    await reachBuilding(run, plan([{ id: 'first', title: 'First', roleId: role.id, detail: 'First task' }], [second, third]));
    await complete(drivers[0], 'First done.');
    await waitForReview(run);

    await putPlan({ version: 1, roles: [role], milestones: [third, second] });
    await settleLead(run, 'Future work reordered.');

    expect(run.snapshot().plan?.milestones.map((milestone) => milestone.id)).toEqual(['m1', 'm3', 'm2']);
    expect(run.snapshot().tasks.map((task) => task.taskId)).toEqual(['first', 'third', 'second']);
    await vi.waitFor(() => expect(requests.at(-1)?.task.id).toBe('third'), WAIT_FOR);
  });

  it('keeps completed records when a review rewrites future plan work', async () => {
    const run = runtime();
    const second = {
      id: 'm2',
      title: 'Second',
      goal: 'Second outcome',
      tasks: [{ id: 'future', title: 'Future', roleId: role.id, detail: 'Old future', scope: ['future'] }],
    };
    await reachBuilding(run, plan([{ id: 'done', title: 'Done', roleId: role.id, detail: 'Do it' }], [second]));
    await complete(drivers[0], 'Immutable handoff.');
    await waitForReview(run);
    const completed = { ...run.snapshot().tasks.find((task) => task.taskId === 'done') };

    await putPlan(
      plan(
        [{ id: 'replacement', title: 'Replacement', roleId: role.id, detail: 'Cannot replace history' }],
        [{
          ...second,
          tasks: [{ id: 'future-new', title: 'Future new', roleId: role.id, detail: 'New future', scope: ['future'] }],
        }],
      ),
    );
    await settleLead(run, 'Plan amended.');
    expect(run.snapshot().tasks.find((task) => task.taskId === 'done')).toEqual(completed);
    expect(run.snapshot().tasks.some((task) => task.taskId === 'replacement')).toBe(false);
    expect(run.snapshot().tasks.some((task) => task.taskId === 'future-new')).toBe(true);
  });

  it('retries malformed or invalid merged review plans without poisoning durable state', async () => {
    const run = runtime();
    const future = {
      id: 'm2',
      title: 'Second',
      goal: 'Second outcome',
      tasks: [{ id: 'future', title: 'Future', roleId: role.id, detail: 'Future' }],
    };
    await reachBuilding(run, plan([{ id: 'done', title: 'Done', roleId: role.id, detail: 'Done' }], [future]));
    await complete(drivers[0], 'Done.');
    await waitForReview(run);

    const otherRole = { id: 'other', name: 'Other', focus: 'Future only' };
    await putPlan({
      version: 1,
      roles: [otherRole],
      milestones: [
        {
          id: 'replacement',
          title: 'Replacement',
          goal: 'Replacement',
          tasks: [{ id: 'replacement', title: 'Replacement', roleId: otherRole.id, detail: 'Replacement' }],
        },
        {
          ...future,
          tasks: [{ id: 'future-other', title: 'Future', roleId: otherRole.id, detail: 'Future' }],
        },
      ],
    });
    await settleLead(run, 'Amended.');
    expect(run.snapshot()).toMatchObject({ phase: 'reviewing', error: expect.stringMatching(/amendment/i) });
    expect(await readDevTeamState(root, chatId)).toMatchObject({ retryCount: 1 });
    expect(run.snapshot().plan?.roles).toEqual([role]);
    expect(leadPrompts.at(-1)).toMatch(/invalid/i);

    await fsp.writeFile(path.join(runDir(), 'plan.json'), '{ broken');
    await settleLead(run, 'Corrected.');
    expect(run.snapshot()).toMatchObject({ phase: 'reviewing', error: expect.stringMatching(/amendment/i) });
    expect(await readDevTeamState(root, chatId)).toMatchObject({ retryCount: 2 });
    await settleLead(run, 'Corrected again.');
    expect(run.snapshot()).toMatchObject({ phase: 'interrupted', error: expect.stringMatching(/amendment/i) });
    const promptCount = leadPrompts.length;

    await run.resume();

    expect(run.snapshot()).toMatchObject({ phase: 'reviewing', error: expect.stringMatching(/amendment/i) });
    expect(leadPrompts).toHaveLength(promptCount + 1);
    expect(leadPrompts.at(-1)).toMatch(/invalid/i);
  });
});
