import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession, StateMachineDataSchema } from '@hearth/core';

async function makeSession(granted?: any) {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return {
    fs,
    session: HearthSession.fromStore(store, granted ? { granted } : {}),
    store,
  };
}

/** Create two sprite assets + an animation asset ("Walk"), returning its asset id. */
async function makeAnimation(session: HearthSession, name = 'Walk'): Promise<string> {
  const s1 = await session.execute<any>('createSpriteAsset', { name: `${name}_f1` });
  const s2 = await session.execute<any>('createSpriteAsset', { name: `${name}_f2` });
  expect(s1.success).toBe(true);
  expect(s2.success).toBe(true);
  const anim = await session.execute<any>('createAnimationAsset', {
    name,
    frames: [s1.data.asset.id, s2.data.asset.id],
  });
  expect(anim.success).toBe(true);
  return anim.data.asset.id as string;
}

/** A minimal valid state machine doc referencing the given animation asset id for every state. */
function makeDoc(animId: string) {
  return {
    params: { moving: { type: 'bool' as const, default: false } },
    states: [
      { name: 'idle', animation: animId, speed: 1 },
      { name: 'walk', animation: animId, speed: 1 },
    ],
    initial: 'idle',
    transitions: [
      { from: 'idle', to: 'walk', conditions: [{ param: 'moving', op: 'eq' as const, value: true }] },
      { from: 'walk', to: 'idle', conditions: [{ param: 'moving', op: 'eq' as const, value: false }] },
    ],
  };
}

describe('createStateMachineAsset', () => {
  it('writes a schema-valid payload file and registers a stateMachine asset', async () => {
    const { session, store, fs } = await makeSession();
    const animId = await makeAnimation(session);

    const result = await session.execute<any>('createStateMachineAsset', {
      name: 'Enemy AI',
      data: makeDoc(animId),
    });
    expect(result.success).toBe(true);
    expect(result.data.path).toBe('assets/statemachines/enemy_ai.asm.json');
    expect(typeof result.data.assetId).toBe('string');

    const asset = store.getAsset(result.data.assetId)!;
    expect(asset.type).toBe('stateMachine');
    expect(asset.name).toBe('Enemy AI');
    expect(asset.path).toBe('assets/statemachines/enemy_ai.asm.json');

    const raw = JSON.parse(await fs.readFile(`/proj/${asset.path}`));
    const parsed = StateMachineDataSchema.parse(raw);
    expect(parsed.initial).toBe('idle');
    expect(parsed.states).toHaveLength(2);
  });

  it('enforces unique asset names (duplicate name -> CONFLICT)', async () => {
    const { session } = await makeSession();
    const animId = await makeAnimation(session);
    const first = await session.execute<any>('createStateMachineAsset', { name: 'AI', data: makeDoc(animId) });
    expect(first.success).toBe(true);
    const second = await session.execute<any>('createStateMachineAsset', { name: 'AI', data: makeDoc(animId) });
    expect(second.success).toBe(false);
    expect(second.errors[0].code).toBe('CONFLICT');
  });

  it('rejects a state referencing an unknown animation asset (ASM_ANIMATION_NOT_FOUND)', async () => {
    const { session } = await makeSession();
    const result = await session.execute<any>('createStateMachineAsset', {
      name: 'AI',
      data: makeDoc('ast_doesnotexist'),
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('ASM_ANIMATION_NOT_FOUND');
  });

  it('rejects a state referencing a non-animation asset (ASM_ANIMATION_NOT_FOUND)', async () => {
    const { session } = await makeSession();
    const sprite = await session.execute<any>('createSpriteAsset', { name: 'NotAnAnim' });
    expect(sprite.success).toBe(true);
    const result = await session.execute<any>('createStateMachineAsset', {
      name: 'AI',
      data: makeDoc(sprite.data.asset.id),
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('ASM_ANIMATION_NOT_FOUND');
  });

  it('rejects a structurally invalid doc with INVALID_PARAMS (schema superRefine runs at param-parse time)', async () => {
    const { session } = await makeSession();
    const animId = await makeAnimation(session);
    const doc = makeDoc(animId);
    doc.initial = 'nonexistent';
    const result = await session.execute<any>('createStateMachineAsset', { name: 'AI', data: doc });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_PARAMS');
  });

  it('requires permission asset-edit', async () => {
    const { session } = await makeSession(['read-only']);
    const result = await session.execute<any>('createStateMachineAsset', {
      name: 'AI',
      data: makeDoc('ast_whatever'),
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('PERMISSION_DENIED');
  });

  it('records a {name} journal detail', async () => {
    const { session, fs } = await makeSession();
    const animId = await makeAnimation(session);
    await session.execute<any>('createStateMachineAsset', { name: 'Enemy AI', data: makeDoc(animId) });
    const lines = (await fs.readFile('/proj/.hearth/log/commands.jsonl')).trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.command).toBe('createStateMachineAsset');
    expect(entry.detail).toEqual({ name: 'Enemy AI' });
  });
});

describe('updateStateMachineAsset', () => {
  it('replaces the payload document in place (same asset id/path)', async () => {
    const { session, store, fs } = await makeSession();
    const animId = await makeAnimation(session);
    const created = await session.execute<any>('createStateMachineAsset', { name: 'AI', data: makeDoc(animId) });
    const assetId = created.data.assetId as string;
    const path = created.data.path as string;

    const newDoc = makeDoc(animId);
    newDoc.states.push({ name: 'attack', animation: animId, speed: 2 });
    newDoc.transitions.push({
      from: 'walk',
      to: 'attack',
      conditions: [{ param: 'moving', op: 'eq', value: true }],
    });

    const update = await session.execute<any>('updateStateMachineAsset', { assetId, data: newDoc });
    expect(update.success).toBe(true);
    expect(update.data).toEqual({ assetId });

    // same asset id/path, index entry unchanged
    expect(store.getAsset(assetId)!.path).toBe(path);

    const raw = JSON.parse(await fs.readFile(`/proj/${path}`));
    const parsed = StateMachineDataSchema.parse(raw);
    expect(parsed.states.map((s) => s.name)).toEqual(['idle', 'walk', 'attack']);
  });

  it('unknown assetId -> NOT_FOUND', async () => {
    const { session } = await makeSession();
    const animId = await makeAnimation(session);
    const result = await session.execute<any>('updateStateMachineAsset', {
      assetId: 'ast_doesnotexist',
      data: makeDoc(animId),
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('NOT_FOUND');
  });

  it('unknown animation id in the new doc -> ASM_ANIMATION_NOT_FOUND', async () => {
    const { session } = await makeSession();
    const animId = await makeAnimation(session);
    const created = await session.execute<any>('createStateMachineAsset', { name: 'AI', data: makeDoc(animId) });
    const result = await session.execute<any>('updateStateMachineAsset', {
      assetId: created.data.assetId,
      data: makeDoc('ast_doesnotexist'),
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('ASM_ANIMATION_NOT_FOUND');
  });

  it('undo restores the prior document (payload bytes on disk)', async () => {
    const { session, fs } = await makeSession();
    const animId = await makeAnimation(session);
    const created = await session.execute<any>('createStateMachineAsset', { name: 'AI', data: makeDoc(animId) });
    const path = created.data.path as string;
    const originalBytes = await fs.readFile(`/proj/${path}`);

    const newDoc = makeDoc(animId);
    newDoc.states.push({ name: 'attack', animation: animId, speed: 2 });
    newDoc.transitions.push({ from: 'idle', to: 'attack', exitTime: 0.5, conditions: [] });
    const update = await session.execute<any>('updateStateMachineAsset', {
      assetId: created.data.assetId,
      data: newDoc,
    });
    expect(update.success).toBe(true);
    expect(await fs.readFile(`/proj/${path}`)).not.toBe(originalBytes);

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(true);
    expect(undo.data.undone).toBe('updateStateMachineAsset');
    expect(await fs.readFile(`/proj/${path}`)).toBe(originalBytes);
  });

  it('records an {assetId} journal detail', async () => {
    const { session, fs } = await makeSession();
    const animId = await makeAnimation(session);
    const created = await session.execute<any>('createStateMachineAsset', { name: 'AI', data: makeDoc(animId) });
    await session.execute<any>('updateStateMachineAsset', { assetId: created.data.assetId, data: makeDoc(animId) });
    const lines = (await fs.readFile('/proj/.hearth/log/commands.jsonl')).trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.command).toBe('updateStateMachineAsset');
    expect(entry.detail).toEqual({ assetId: created.data.assetId });
  });

  it('requires permission asset-edit', async () => {
    const { session } = await makeSession(['read-only']);
    const result = await session.execute<any>('updateStateMachineAsset', {
      assetId: 'ast_whatever',
      data: makeDoc('ast_whatever'),
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('PERMISSION_DENIED');
  });
});

describe('inspectAssets — state machine payload', () => {
  it('attaches the parsed state machine document under `stateMachine`', async () => {
    const { session } = await makeSession();
    const animId = await makeAnimation(session);
    const created = await session.execute<any>('createStateMachineAsset', { name: 'AI', data: makeDoc(animId) });

    const inspected = await session.execute<any>('inspectAssets', { type: 'stateMachine' });
    expect(inspected.success).toBe(true);
    const entry = inspected.data.assets.find((a: any) => a.id === created.data.assetId);
    expect(entry).toBeDefined();
    expect(entry.stateMachine.initial).toBe('idle');
    expect(entry.stateMachine.states.map((s: any) => s.name)).toEqual(['idle', 'walk']);
  });
});
