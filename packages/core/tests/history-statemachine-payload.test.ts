/**
 * Cross-session regressions for state machine PAYLOAD content in the
 * whole-model snapshot — the same class of bug `history-prefab-payload.test.ts`
 * pins for prefabs. The asset index alone (reconcileAssetFiles, via trash)
 * captures create/delete but NOT an in-place payload rewrite:
 * updateStateMachineAsset re-serializes over the same path/asset id, so
 * undo/revert/diff would be blind to it without a `stateMachines` snapshot
 * bucket mirroring the `prefabs` one.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession } from '@hearth/core';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return { fs, session: HearthSession.fromStore(store), store };
}

async function makeAnimation(session: HearthSession, name: string): Promise<string> {
  const s1 = await session.execute<any>('createSpriteAsset', { name: `${name}_f1` });
  const s2 = await session.execute<any>('createSpriteAsset', { name: `${name}_f2` });
  const anim = await session.execute<any>('createAnimationAsset', {
    name,
    frames: [s1.data.asset.id, s2.data.asset.id],
  });
  return anim.data.asset.id as string;
}

function makeDoc(animId: string, extraState = false) {
  const states = [
    { name: 'idle', animation: animId, speed: 1 },
    { name: 'walk', animation: animId, speed: 1 },
  ];
  if (extraState) states.push({ name: 'attack', animation: animId, speed: 2 });
  return {
    params: { moving: { type: 'bool' as const, default: false } },
    states,
    initial: 'idle',
    transitions: [
      { from: 'idle', to: 'walk', conditions: [{ param: 'moving', op: 'eq' as const, value: true }] },
      { from: 'walk', to: 'idle', conditions: [{ param: 'moving', op: 'eq' as const, value: false }] },
    ],
  };
}

async function makeAsset(session: HearthSession) {
  const animId = await makeAnimation(session, 'Walk');
  const created = await session.execute<any>('createStateMachineAsset', { name: 'AI', data: makeDoc(animId) });
  expect(created.success).toBe(true);
  return { animId, assetId: created.data.assetId as string, path: created.data.path as string };
}

describe('state machine payload survives undo/redo (snapshot content model)', () => {
  it('(a) update -> undo restores the payload bytes on disk', async () => {
    const { fs, session } = await makeSession();
    const { animId, assetId, path } = await makeAsset(session);
    const abs = `/proj/${path}`;
    const originalBytes = await fs.readFile(abs);
    expect(originalBytes).toContain('"idle"');
    expect(originalBytes).not.toContain('"attack"');

    const update = await session.execute<any>('updateStateMachineAsset', {
      assetId,
      data: makeDoc(animId, true),
    });
    expect(update.success).toBe(true);
    expect(await fs.readFile(abs)).toContain('"attack"');

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(true);
    expect(undo.data.undone).toBe('updateStateMachineAsset');

    // The load-bearing assertion: the payload file itself is back to the
    // original bytes, not just the in-memory asset index.
    expect(await fs.readFile(abs)).toBe(originalBytes);
  });

  it('(b) undo in a FRESH session (reopened from disk) also restores the payload', async () => {
    const { fs, session } = await makeSession();
    const { animId, assetId, path } = await makeAsset(session);
    const abs = `/proj/${path}`;
    const originalBytes = await fs.readFile(abs);

    await session.execute<any>('updateStateMachineAsset', { assetId, data: makeDoc(animId, true) });
    expect(await fs.readFile(abs)).toContain('"attack"');

    const fresh = await HearthSession.open(fs, '/proj');
    const undo = await fresh.execute<any>('undo');
    expect(undo.success).toBe(true);
    expect(undo.data.undone).toBe('updateStateMachineAsset');
    expect(await fs.readFile(abs)).toBe(originalBytes);
  });

  it('(c) snapshot -> update -> revert restores the payload', async () => {
    const { fs, session } = await makeSession();
    const { animId, assetId, path } = await makeAsset(session);
    const abs = `/proj/${path}`;
    const originalBytes = await fs.readFile(abs);

    const snap = await session.execute<any>('snapshotProject');
    expect(snap.success).toBe(true);

    await session.execute<any>('updateStateMachineAsset', { assetId, data: makeDoc(animId, true) });
    expect(await fs.readFile(abs)).toContain('"attack"');

    const revert = await session.execute<any>('revertProject', { confirm: true });
    expect(revert.success).toBe(true);
    expect(await fs.readFile(abs)).toBe(originalBytes);
  });

  it('(d) diff after an update reports the payload change even when the index entry is unchanged', async () => {
    const { session } = await makeSession();
    const { animId, assetId } = await makeAsset(session);

    const snap = await session.execute<any>('snapshotProject');
    expect(snap.success).toBe(true);

    // Content-only change: metadata.stateCount/transitionCount is identical
    // to a same-shape doc reordering (use same state/transition counts by
    // swapping which animation a state points to via a second animation).
    const animId2 = await makeAnimation(session, 'Run');
    const doc = makeDoc(animId);
    doc.states[1].animation = animId2;
    await session.execute<any>('updateStateMachineAsset', { assetId, data: doc });

    const diff = await session.execute<any>('diffProject');
    expect(diff.success).toBe(true);
    const changed = diff.data.assets.find((a: any) => a.id === assetId);
    expect(changed).toBeDefined();
    expect(changed.status).toBe('modified');
  });

  it('(e) a corrupt state machine payload section in a history snapshot fails undo cleanly (HISTORY_CORRUPT)', async () => {
    const { fs, session } = await makeSession();
    const { assetId, path } = await makeAsset(session);

    // A later mutation whose "before" snapshot carries the state machine payload.
    const sprite = await session.execute<any>('createSpriteAsset', { name: 'Extra' });
    expect(sprite.success).toBe(true);

    const list = await session.execute<any>('listHistory');
    const seq = list.data.entries[list.data.entries.length - 1].seq;
    const statePath = `/proj/.hearth/history/state-${seq}.json`;

    const raw = JSON.parse(await fs.readFile(statePath));
    expect(raw.stateMachines[path]).toBeTypeOf('string'); // captured as path -> content
    raw.stateMachines[path] = 'not valid state machine json {{{';
    await fs.writeFile(statePath, JSON.stringify(raw));

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(false);
    expect(undo.errors[0].code).toBe('HISTORY_CORRUPT');
  });

  it('tolerates a pre-v0.12 baseline without a stateMachines key: diff succeeds and revert fully applies', async () => {
    const { fs, session, store } = await makeSession();
    const { assetId, path } = await makeAsset(session);

    const snap = await session.execute<any>('snapshotProject');
    expect(snap.success).toBe(true);
    const baselinePath = '/proj/.hearth/baseline.json';
    const baseline = JSON.parse(await fs.readFile(baselinePath));
    expect(baseline.stateMachines).toBeDefined();
    delete baseline.stateMachines;
    await fs.writeFile(baselinePath, JSON.stringify(baseline));

    const removed = await session.execute<any>('removeAsset', { asset: assetId, deleteFile: true });
    expect(removed.success).toBe(true);

    const diff = await session.execute<any>('diffProject');
    expect(diff.success).toBe(true);
    expect(diff.data.hasChanges).toBe(true);

    const revert = await session.execute<any>('revertProject', { confirm: true });
    expect(revert.success).toBe(true);

    expect(store.getAsset(assetId)).toBeDefined();
    expect(await fs.exists(`/proj/${path}`)).toBe(true);
  });
});
