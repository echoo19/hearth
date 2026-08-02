import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  approveDevTeamSpec,
  appendEngineerRecord,
  deleteDevTeamArtifacts,
  parsePlanJson,
  quarantineDevTeamState,
  readDevTeamPlan,
  readDevTeamSpec,
  readDevTeamState,
  readEngineerRecords,
  writeDevTeamState,
  type DevTeamPlan,
  type DevTeamState,
} from '../server/devTeamStore';
import * as devTeamStore from '../server/devTeamStore';

let root: string;
const chatId = 'chat-1';
const runDir = (): string => path.join(root, '.hearth', 'devteam', chatId);
const stateFile = (): string => path.join(runDir(), 'state.json');

const validPlan: DevTeamPlan = {
  version: 1,
  roles: [{ id: 'builder', name: 'Builder', focus: 'Make the interaction work' }],
  milestones: [
    {
      id: 'playable',
      title: 'Playable',
      goal: 'Ship a playable loop',
      tasks: [{ id: 'loop', title: 'Build loop', roleId: 'builder', detail: 'Build it.', scope: ['src'] }],
    },
  ],
};

function state(over: Partial<DevTeamState> = {}): DevTeamState {
  return {
    version: 1,
    runId: 'run-1',
    phase: 'planning',
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
    ...over,
  };
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-devteam-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(root, { recursive: true, force: true });
});

describe('dev team run state', () => {
  it('reads a missing state as idle', async () => {
    expect(await readDevTeamState(root, chatId)).toEqual(state({ runId: '', phase: 'idle' }));
  });

  it('loads pre-history state files with an empty durable run history', async () => {
    await fsp.mkdir(runDir(), { recursive: true });
    const { history: _history, ...legacy } = state();
    await fsp.writeFile(stateFile(), JSON.stringify(legacy));

    expect((await readDevTeamState(root, chatId)).history).toEqual([]);
  });

  it('returns a visible interrupted state for corruption without overwriting the file', async () => {
    await fsp.mkdir(runDir(), { recursive: true });
    await fsp.writeFile(stateFile(), '{ broken');
    const read = await readDevTeamState(root, chatId);
    expect(read.phase).toBe('interrupted');
    expect(read.error).toBe('Dev team state is unreadable.');
    expect(await fsp.readFile(stateFile(), 'utf8')).toBe('{ broken');
  });

  it('rejects future versions and unknown fields without rewriting their state', async () => {
    await fsp.mkdir(runDir(), { recursive: true });
    for (const future of [
      { ...state(), version: 2, futureRuntimeData: { doNotLose: true } },
      { ...state(), version: 1, futureRuntimeData: { doNotLose: true } },
    ]) {
      const raw = JSON.stringify(future);
      await fsp.writeFile(stateFile(), raw);
      expect(await readDevTeamState(root, chatId)).toMatchObject({
        phase: 'interrupted',
        error: 'Dev team state is unreadable.',
      });
      expect(await fsp.readFile(stateFile(), 'utf8')).toBe(raw);
    }
  });

  it('writes the state it is holding even after an unreadable read', async () => {
    await fsp.mkdir(runDir(), { recursive: true });
    await fsp.writeFile(stateFile(), '{ preserve this damage');
    const unreadable = await readDevTeamState(root, chatId);
    expect(unreadable.unreadable).toBe(true);

    await writeDevTeamState(root, chatId, { ...unreadable, retryCount: 1 });

    const written = JSON.parse(await fsp.readFile(stateFile(), 'utf8'));
    expect('unreadable' in written).toBe(false);
    expect(written).toMatchObject({ retryCount: 1, phase: 'interrupted' });
    expect(await readDevTeamState(root, chatId)).toMatchObject({ retryCount: 1 });
  });

  it('quarantines a corrupt file instead of leaving the conversation dead', async () => {
    await fsp.mkdir(runDir(), { recursive: true });
    await fsp.writeFile(stateFile(), '{ preserve this damage');

    await quarantineDevTeamState(root, chatId);

    expect(await fsp.readFile(`${stateFile()}.corrupt`, 'utf8')).toBe('{ preserve this damage');
    await expect(fsp.stat(stateFile())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readDevTeamState(root, chatId)).toEqual(state({ runId: '', phase: 'idle' }));
  });

  it('quarantines nothing for a missing file or an unsafe id', async () => {
    await expect(quarantineDevTeamState(root, chatId)).resolves.toBeUndefined();
    await expect(quarantineDevTeamState(root, '../outside')).resolves.toBeUndefined();
    await expect(fsp.stat(path.join(root, '.hearth', 'devteam'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('round-trips a whole state through the atomic write', async () => {
    const written = state({
      phase: 'building',
      plan: validPlan,
      tasks: [{ taskId: 'loop', engineerId: 'eng-1', status: 'running', startedAt: 't1' }],
      steering: [{ ts: 't2', text: 'Keep it small' }],
      spec: '# Spec',
      specVersion: 1,
      approvals: [{ specVersion: 1, approvedAt: 't0' }],
    });
    await writeDevTeamState(root, chatId, written);

    expect(await readDevTeamState(root, chatId)).toEqual(written);
    expect((await fsp.readdir(runDir())).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('defaults milestone repairs and round-trips the counts a repair writes', async () => {
    await fsp.mkdir(runDir(), { recursive: true });
    const { milestoneRepairs: _repairs, ...legacy } = state();
    await fsp.writeFile(stateFile(), JSON.stringify(legacy));
    expect((await readDevTeamState(root, chatId)).milestoneRepairs).toEqual({});

    await writeDevTeamState(root, chatId, state({ milestoneRepairs: { m1: 1 } }));
    expect((await readDevTeamState(root, chatId)).milestoneRepairs).toEqual({ m1: 1 });
  });

  it('serializes atomic state writes so concurrent callers leave one whole state', async () => {
    const building = state({ phase: 'building', retryCount: 1 });
    const reviewing = state({ phase: 'reviewing', retryCount: 2 });
    await Promise.all([writeDevTeamState(root, chatId, building), writeDevTeamState(root, chatId, reviewing)]);

    expect(JSON.parse(await fsp.readFile(stateFile(), 'utf8'))).toEqual(reviewing);
    expect((await fsp.readdir(runDir())).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('does not start or settle a second state write until the first rename completes', async () => {
    const initial = state({ phase: 'planning', retryCount: 0 });
    const first = state({ phase: 'building', retryCount: 1 });
    const second = state({ phase: 'reviewing', retryCount: 2 });
    await writeDevTeamState(root, chatId, initial);

    const realRename = fsp.rename.bind(fsp);
    const renameOrder: string[] = [];
    const completionOrder: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let firstRenameReached!: () => void;
    let secondRenameReached!: () => void;
    const firstReached = new Promise<void>((resolve) => {
      firstRenameReached = resolve;
    });
    const secondReached = new Promise<void>((resolve) => {
      secondRenameReached = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondReleased = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      const label = renameOrder.length === 0 ? 'first' : 'second';
      renameOrder.push(label);
      if (label === 'first') {
        firstRenameReached();
        await firstReleased;
      } else {
        secondRenameReached();
        await secondReleased;
      }
      await realRename(from, to);
    });

    const firstWriting = writeDevTeamState(root, chatId, first).then(() => {
      completionOrder.push('first');
    });
    await firstReached;
    const mkdir = vi.spyOn(fsp, 'mkdir').mockResolvedValue(undefined);
    const secondWriting = writeDevTeamState(root, chatId, second).then(() => {
      completionOrder.push('second');
    });

    try {
      expect(mkdir).not.toHaveBeenCalled();
      expect(renameOrder).toEqual(['first']);
      expect(completionOrder).toEqual([]);

      releaseFirst();
      await firstWriting;
      await secondReached;
      expect(renameOrder).toEqual(['first', 'second']);
      expect(completionOrder).toEqual(['first']);

      releaseSecond();
      await secondWriting;
      expect(completionOrder).toEqual(['first', 'second']);
      expect(JSON.parse(await fsp.readFile(stateFile(), 'utf8'))).toEqual(second);
    } finally {
      releaseFirst();
      releaseSecond();
      await Promise.allSettled([firstWriting, secondWriting]);
    }
  });

  it('keeps the old whole state visible until the atomic rename', async () => {
    const before = state({ phase: 'building', retryCount: 1 });
    const after = state({ phase: 'reviewing', retryCount: 2 });
    await writeDevTeamState(root, chatId, before);

    const realRename = fsp.rename.bind(fsp);
    let releaseRename!: () => void;
    let renameReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      renameReached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    vi.spyOn(fsp, 'rename').mockImplementationOnce(async (from, to) => {
      renameReached();
      await released;
      await realRename(from, to);
    });

    const writing = writeDevTeamState(root, chatId, after);
    await reached;
    expect(JSON.parse(await fsp.readFile(stateFile(), 'utf8'))).toEqual(before);
    releaseRename();
    await writing;
    expect(JSON.parse(await fsp.readFile(stateFile(), 'utf8'))).toEqual(after);
  });
});

describe('spec and plan files', () => {
  it('reads a valid plan and rejects an invalid one', async () => {
    await fsp.mkdir(runDir(), { recursive: true });
    await fsp.writeFile(path.join(runDir(), 'plan.json'), JSON.stringify(validPlan));
    expect(await readDevTeamPlan(root, chatId)).toEqual(validPlan);

    await fsp.writeFile(path.join(runDir(), 'plan.json'), JSON.stringify({ ...validPlan, version: 2 }));
    expect(await readDevTeamPlan(root, chatId)).toBeNull();
  });

  it('reads the current spec and snapshots each approved version', async () => {
    await writeDevTeamState(root, chatId, state({ phase: 'spec-review', spec: '# First spec' }));
    await fsp.writeFile(path.join(runDir(), 'spec.md'), '# First spec\n');
    const first = await approveDevTeamSpec(root, chatId);
    expect(first.specVersion).toBe(1);
    expect(first).toMatchObject({ phase: 'planning', retryCount: 0, error: null });
    expect(first.approvals).toEqual([{ specVersion: 1, approvedAt: expect.any(String) }]);
    expect(await readDevTeamSpec(root, chatId)).toBe('# First spec\n');
    expect(await fsp.readFile(path.join(runDir(), 'spec.v1.md'), 'utf8')).toBe('# First spec\n');

    await writeDevTeamState(root, chatId, { ...first, phase: 'spec-review' });
    await fsp.writeFile(path.join(runDir(), 'spec.md'), '# Revised spec\n');
    const second = await approveDevTeamSpec(root, chatId);
    expect(second.specVersion).toBe(2);
    expect(await fsp.readFile(path.join(runDir(), 'spec.v2.md'), 'utf8')).toBe('# Revised spec\n');

    const repeated = await approveDevTeamSpec(root, chatId);
    expect(repeated.specVersion).toBe(2);
    expect(repeated.approvals).toHaveLength(2);
  });

  it('recovers one approval version after a crash between artifact and state writes', async () => {
    await writeDevTeamState(root, chatId, state({ phase: 'spec-review' }));
    await fsp.writeFile(path.join(runDir(), 'spec.md'), '# Crash-safe spec\n');
    const rename = fsp.rename.bind(fsp);
    let failed = false;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (!failed && path.basename(String(to)) === 'state.json') {
        failed = true;
        throw new Error('simulated crash before approval state');
      }
      await rename(from, to);
    });

    await expect(approveDevTeamSpec(root, chatId)).rejects.toThrow('simulated crash');
    expect(await fsp.readFile(path.join(runDir(), 'spec.v1.md'), 'utf8')).toBe('# Crash-safe spec\n');
    vi.restoreAllMocks();

    const recovered = await approveDevTeamSpec(root, chatId);
    expect(recovered).toMatchObject({ phase: 'planning', specVersion: 1 });
    expect(recovered.approvals).toHaveLength(1);
  });

  it('returns null when plan or spec files are missing or unreadable', async () => {
    expect(await readDevTeamPlan(root, chatId)).toBeNull();
    expect(await readDevTeamSpec(root, chatId)).toBeNull();
    expect(await approveDevTeamSpec(root, chatId)).toEqual(
      state({ runId: '', phase: 'idle', error: 'The specification is no longer waiting for approval.' }),
    );
  });

  it('reads an empty specification as no specification', async () => {
    await fsp.mkdir(runDir(), { recursive: true });
    for (const empty of ['', '   ', '\n\n\t']) {
      await fsp.writeFile(path.join(runDir(), 'spec.md'), empty);
      expect(await readDevTeamSpec(root, chatId)).toBeNull();
    }
    await fsp.writeFile(path.join(runDir(), 'spec.md'), '  # Real spec  \n');
    expect(await readDevTeamSpec(root, chatId)).toBe('  # Real spec  \n');
  });

  it('records no approval when the specification is gone by the time it is approved', async () => {
    await writeDevTeamState(root, chatId, state({ phase: 'spec-review', spec: '# The spec they read' }));

    const refused = await approveDevTeamSpec(root, chatId);

    expect(refused.error).toBe('The specification is missing.');
    expect(refused.specVersion).toBe(0);
    expect(refused.approvals).toEqual([]);
    const onDisk = JSON.parse(await fsp.readFile(stateFile(), 'utf8'));
    expect(onDisk).toMatchObject({ phase: 'spec-review', specVersion: 0, approvals: [] });
  });

  it('refuses to approve over a state that is already carrying an error', async () => {
    await writeDevTeamState(root, chatId, state({ phase: 'spec-review', error: 'The lead agent stopped.' }));
    await fsp.writeFile(path.join(runDir(), 'spec.md'), '# Ignored spec\n');

    const refused = await approveDevTeamSpec(root, chatId);

    expect(refused.error).toBe('The lead agent stopped.');
    expect(refused.approvals).toEqual([]);
    expect(await fsp.readdir(runDir())).not.toContain('spec.v1.md');
  });
});

describe('plan parsing', () => {
  it('names the failing field so a repair turn has something to fix', () => {
    const { goal: _goal, ...milestone } = validPlan.milestones[0];
    const parsed = parsePlanJson(JSON.stringify({ ...validPlan, milestones: [milestone] }));

    expect(parsed.plan).toBeNull();
    expect(parsed.error).toContain('milestones.0.goal');
  });

  it('separates broken JSON from a plan that parsed but does not fit', () => {
    const broken = parsePlanJson('{ "version": 1,');
    expect(broken.plan).toBeNull();
    expect(broken.error).toMatch(/^The file is not valid JSON: /);

    expect(parsePlanJson(JSON.stringify(validPlan))).toEqual({ plan: validPlan, error: null });
  });
});

describe('engineer transcripts and path ids', () => {
  it('does not expose an unchecked run-directory path builder', () => {
    expect('devTeamRunDir' in devTeamStore).toBe(false);
  });

  it('round-trips an engineer transcript in order', async () => {
    await appendEngineerRecord(root, chatId, 'engineer-1', { role: 'user', ts: 't1', text: 'Build the loop' });
    await appendEngineerRecord(root, chatId, 'engineer-1', {
      role: 'agent',
      ts: 't2',
      event: { type: 'text-delta', text: 'Done.' },
    });
    expect(await readEngineerRecords(root, chatId, 'engineer-1')).toEqual([
      { role: 'user', ts: 't1', text: 'Build the loop' },
      { role: 'agent', ts: 't2', event: { type: 'text-delta', text: 'Done.' } },
    ]);
  });

  it('rejects unsafe chat and engineer ids instead of escaping the run directory', async () => {
    await expect(writeDevTeamState(root, '../outside', state())).rejects.toThrow('safe');
    await expect(appendEngineerRecord(root, chatId, '../outside', { role: 'user', ts: 't', text: 'x' })).rejects.toThrow(
      'safe',
    );
    expect(await readDevTeamState(root, '../outside')).toEqual(state({ runId: '', phase: 'idle' }));
    expect(await readEngineerRecords(root, chatId, '../outside')).toEqual([]);
  });

  it('deletes only the validated dev team run directory', async () => {
    const sibling = path.join(root, '.hearth', 'devteam', 'keep-me');
    await fsp.mkdir(runDir(), { recursive: true });
    await fsp.mkdir(sibling, { recursive: true });
    await fsp.writeFile(path.join(runDir(), 'state.json'), '{}');
    await fsp.writeFile(path.join(sibling, 'state.json'), '{}');

    expect(await deleteDevTeamArtifacts(root, chatId)).toBe(true);
    await expect(fsp.stat(runDir())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fsp.readFile(path.join(sibling, 'state.json'), 'utf8')).toBe('{}');
    expect(await deleteDevTeamArtifacts(root, '../keep-me')).toBe(false);
    expect(await fsp.readFile(path.join(sibling, 'state.json'), 'utf8')).toBe('{}');
  });
});
