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
  type DevTeamEngineerRequest,
} from '../server/devTeamRuntime';
import { readDevTeamState, type DevTeamPlan, type DevTeamSnapshot } from '../server/devTeamStore';

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
  private stopped = false;

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
      if (failAgentAppend && record.role === 'agent') throw new Error('agent transcript failed');
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
  await vi.waitFor(() => expect(run.snapshot().phase).toBe('building'));
}

async function complete(driver: ScriptedDriver, text = 'Task handoff.'): Promise<void> {
  driver.queue.push({ type: 'message-delta', text });
  driver.queue.push({ type: 'turn-complete' });
  await vi.waitFor(() => expect(driver.sent).toHaveLength(1));
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
  idCounter = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(root, { recursive: true, force: true });
});

describe('dev team lead state machine', () => {
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
    await vi.waitFor(() => expect(run.snapshot().phase).toBe('building'));
    expect((await readDevTeamState(root, chatId)).steering).toHaveLength(1);

    await complete(drivers[0], 'A done.');
    await vi.waitFor(() => expect(run.snapshot().phase).toBe('reviewing'));
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

  it('does not let a stopped interview completion overwrite interruption after spec read', async () => {
    const run = runtime();
    await run.start('A brief.');
    await putSpec('# Spec\n');
    const blocked = blockNextFileRead('spec.md');

    const completion = settleLead(run, 'Spec ready.');
    await blocked.reached;
    await run.stop();
    blocked.release();
    await completion;

    expect(run.snapshot().phase).toBe('interrupted');
    expect(await readDevTeamState(root, chatId)).toMatchObject({ resumePhase: 'interviewing' });
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
    await vi.waitFor(() => expect(run.snapshot().phase).toBe('reviewing'));
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
    await first.start('An unfinished brief.');
    const reopened = runtime();
    await reopened.start();
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

  it('does not let a delayed pre-Stop completion satisfy the resumed lead turn', async () => {
    const run = runtime();
    await run.start('An unfinished brief.');
    await run.stop();
    await run.resume();
    await putSpec('# Resumed spec\n');

    await settleLead(run, 'Delayed old completion.');
    expect(run.snapshot()).toMatchObject({ phase: 'interviewing', spec: null });

    await settleLead(run, 'Resumed completion.');
    expect(run.snapshot()).toMatchObject({ phase: 'spec-review', spec: '# Resumed spec\n' });
  });

  it('runs plan, build, review, and wrap turns through done', async () => {
    const run = runtime();
    await reachBuilding(
      run,
      plan([{ id: 'task-a', title: 'Create foundation', roleId: role.id, detail: 'Implement the foundation.' }]),
    );

    expect(drivers).toHaveLength(1);
    await complete(drivers[0], 'Foundation implemented.');
    await vi.waitFor(() => expect(run.snapshot().phase).toBe('reviewing'));
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
    await vi.waitFor(() => expect(requests.map((request) => request.task.id)).toEqual(['a', 'c', 'b']));
    await complete(drivers[1], 'C done.');
    await vi.waitFor(() => expect(requests.map((request) => request.task.id)).toEqual(['a', 'c', 'b', 'd']));
    await complete(drivers[2], 'B done.');
    await complete(drivers[3], 'D done.');
    await vi.waitFor(() => expect(run.snapshot().phase).toBe('reviewing'));
    expect(requests.some((request) => request.task.id === 'later')).toBe(false);

    await settleLead(run, 'First milestone accepted.');
    await vi.waitFor(() => expect(requests.at(-1)?.task.id).toBe('later'));
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
    await vi.waitFor(() => expect(requests.at(-1)?.task.id).toBe('child'));
    await complete(drivers[2], 'Child done.');
    await vi.waitFor(() => expect(requests.at(-1)?.task.id).toBe('exclusive'));
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

    await vi.waitFor(() => expect(run.snapshot().tasks[0]?.status).toBe('done'));
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
    await vi.waitFor(() => expect(engineerEvents).toHaveLength(2));
    expect(engineerEvents.map((item) => item.engineerId)).toEqual([engineerId, engineerId]);

    expect(run.routeEngineerApproval(engineerId, 'approval-1', 'allow', 'once')).toBe(true);
    expect(run.routeEngineerInput(engineerId, 'input-1', { action: 'submit', answers: { answer: 'yes' } })).toBe(true);
    expect(drivers[0].approvals).toEqual([{ id: 'approval-1', decision: 'allow', choiceId: 'once' }]);
    expect(drivers[0].inputs).toEqual([
      { id: 'input-1', response: { action: 'submit', answers: { answer: 'yes' } } },
    ]);
    expect(run.routeEngineerApproval('another', 'approval-1', 'deny')).toBe(false);
  });

  it('records an engineer error and still settles the milestone into review', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    drivers[0].queue.push({ type: 'error', message: 'provider failed' });
    await vi.waitFor(() => expect(run.snapshot().phase).toBe('reviewing'));
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
    await vi.waitFor(() => expect(run.snapshot().phase).toBe('reviewing'));
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
    await vi.waitFor(() => expect(run.snapshot().tasks[0]?.status).toBe('done'));
    expect(drivers).toHaveLength(1);

    await run.resume();
    await vi.waitFor(() => expect(drivers).toHaveLength(2));
    expect(run.snapshot().phase).toBe('building');
  });

  it('stop interrupts active engineers and withdraws their pending asks', async () => {
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
    await vi.waitFor(() => expect(engineerEvents).toHaveLength(2));

    await run.stop();
    expect(drivers[0].interrupts).toBe(1);
    expect(run.snapshot()).toMatchObject({ phase: 'interrupted' });
    expect(await readDevTeamState(root, chatId)).toMatchObject({ resumePhase: 'building' });
    expect(run.snapshot().tasks[0].status).toBe('interrupted');
    expect(engineerEvents.slice(-2)).toEqual([
      { engineerId, event: { type: 'approval-resolved', approvalId: 'approval-1', decision: 'withdrawn' } },
      { engineerId, event: { type: 'input-resolved', inputId: 'input-1', action: 'withdrawn' } },
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

  it('does not start a stale engineer after Stop and Resume race its prompt append', async () => {
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
    await vi.waitFor(() => expect(drivers).toHaveLength(2));

    expect(drivers[0].sent).toEqual([]);
    expect(drivers[0].stops).toBe(1);
    expect(drivers[1].sent).toHaveLength(1);
    expect(run.snapshot().tasks[0].status).toBe('running');
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
    await vi.waitFor(() => expect(engineerRecords.at(-1)).toMatchObject({ record: { role: 'agent' } }));
    expect(run.snapshot().tasks[0].status).toBe('interrupted');
  });

  it('stops and settles an engineer when its event transcript write fails', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    failAgentAppend = true;

    drivers[0].queue.push({ type: 'message-delta', text: 'Unpersisted.' });

    await vi.waitFor(() => expect(run.snapshot().tasks[0].status).toBe('error'));
    expect(run.snapshot().tasks[0].summary).toContain('agent transcript failed');
    expect(drivers[0].stops).toBe(1);
    expect(run.snapshot().phase).toBe('reviewing');
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
    await vi.waitFor(() => expect(drivers).toHaveLength(1));
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
    await vi.waitFor(() => expect(requests.map((request) => request.task.id)).toEqual(['a']));
    expect(reopened.snapshot()).toMatchObject({ phase: 'building', tasks: [{ taskId: 'a', status: 'running' }] });
  });

  it('actively resumes an interrupted interview after rehydration', async () => {
    const first = runtime();
    await first.start('An unfinished brief.');
    const promptCount = leadPrompts.length;

    const reopened = runtime();
    await reopened.start();
    expect(reopened.snapshot().phase).toBe('interrupted');
    await reopened.resume();
    expect(reopened.snapshot().phase).toBe('interviewing');
    expect(leadPrompts).toHaveLength(promptCount + 1);
    expect(leadPrompts.at(-1)).toMatch(/continue.*interview/i);
  });

  it('folds paused interview and planning completions without losing files or duplicating lead turns', async () => {
    const interview = runtime();
    await interview.start('A complete brief.');
    await interview.pause();
    await putSpec('# Paused spec\n');
    await settleLead(interview, 'Spec written.');
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
    await vi.waitFor(() => expect(drivers).toHaveLength(1));
    expect(interview.snapshot().phase).toBe('building');
    expect(leadPrompts).toHaveLength(promptCount);
  });

  it('folds paused review and wrap completions exactly once', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    await complete(drivers[0], 'A done.');
    await vi.waitFor(() => expect(run.snapshot().phase).toBe('reviewing'));
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
    await vi.waitFor(() => expect(run.snapshot().phase).toBe('reviewing'));
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
    await vi.waitFor(() => expect(run.snapshot().phase).toBe('reviewing'));
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

  it('keeps steering durable until the next lead prompt is appended and sent', async () => {
    const run = runtime();
    await reachBuilding(run, plan([{ id: 'a', title: 'A', roleId: role.id, detail: 'A' }]));
    await complete(drivers[0], 'A done.');
    await vi.waitFor(() => expect(run.snapshot().phase).toBe('reviewing'));
    await run.handleUserMessage('Keep this instruction.');
    failLeadSend = true;

    await expect(settleLead(run, 'Review complete.')).rejects.toThrow('lead send failed');

    expect((await readDevTeamState(root, chatId)).steering).toEqual([
      { ts: expect.any(String), text: 'Keep this instruction.' },
    ]);
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
    await vi.waitFor(() => expect(run.snapshot().phase).toBe('reviewing'));
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
    await vi.waitFor(() => expect(run.snapshot().phase).toBe('reviewing'));

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
