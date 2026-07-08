/**
 * Cross-session regressions for prefab PAYLOAD content in the whole-model
 * snapshot. The asset index alone (which reconcileAssetFiles handles via
 * trash) captures create/delete but NOT an in-place payload rewrite:
 * updatePrefab re-serializes over the same path/asset id, so undo/revert/diff
 * were all blind to it. The snapshot now carries prefab payloads the same way
 * it carries scripts (path -> content), so undo restores the bytes on disk,
 * diff surfaces the change, and validateSnapshot rejects a corrupt payload
 * section before it can brick a project.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession } from '@hearth/core';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return { fs, session: HearthSession.fromStore(store), store };
}

/** Player's default SpriteRenderer.color in the generated project. */
const ORIGINAL_COLOR = '#3498db';
const NEW_COLOR = '#ff0000';

/** create a PlayerPrefab from the default Player, returning its asset + ids. */
async function makePrefab(session: HearthSession, store: any) {
  const sceneId = store.project.initialScene as string;
  const player = store.getScene(sceneId)!.entities.find((e: any) => e.name === 'Player')!;
  const created = await session.execute<any>('createPrefab', {
    scene: sceneId,
    entity: player.id,
    name: 'PlayerPrefab',
  });
  expect(created.success).toBe(true);
  return { sceneId, rootId: player.id as string, asset: created.data.asset as { id: string; path: string } };
}

/** Change the root's color then bake it into the prefab payload. */
async function recolorAndUpdate(session: HearthSession, sceneId: string, rootId: string, assetId: string, color: string) {
  const set = await session.execute<any>('setComponentProperty', {
    scene: sceneId,
    entity: rootId,
    property: 'SpriteRenderer.color',
    value: color,
  });
  expect(set.success).toBe(true);
  const update = await session.execute<any>('updatePrefab', { prefab: assetId, scene: sceneId, entity: rootId });
  expect(update.success).toBe(true);
}

describe('prefab payload survives undo/redo (snapshot content model)', () => {
  it('(a) update -> undo restores the payload bytes on disk, and sync then stamps the ORIGINAL color', async () => {
    const { fs, session, store } = await makeSession();
    const { sceneId, rootId, asset } = await makePrefab(session, store);
    const abs = `/proj/${asset.path}`;

    const originalBytes = await fs.readFile(abs);
    expect(originalBytes).toContain(ORIGINAL_COLOR);

    await recolorAndUpdate(session, sceneId, rootId, asset.id, NEW_COLOR);
    expect(await fs.readFile(abs)).toContain(NEW_COLOR);

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(true);
    expect(undo.data.undone).toBe('updatePrefab');

    // The load-bearing assertion: the payload file itself is back to the
    // original bytes, not just the in-memory asset index.
    expect(await fs.readFile(abs)).toBe(originalBytes);

    // syncing from the restored payload stamps the ORIGINAL color on the
    // instance (proving the on-disk payload really was rolled back).
    const sync = await session.execute<any>('syncPrefabInstances', { prefab: asset.id });
    expect(sync.success).toBe(true);
    const root = store.getScene(sceneId)!.entities.find((e: any) => e.id === rootId)!;
    expect(root.components.SpriteRenderer.color).toBe(ORIGINAL_COLOR);
  });

  it('(b) undo in a FRESH session (reopened from disk) also restores the payload', async () => {
    const { fs, session, store } = await makeSession();
    const { sceneId, rootId, asset } = await makePrefab(session, store);
    const abs = `/proj/${asset.path}`;
    const originalBytes = await fs.readFile(abs);

    await recolorAndUpdate(session, sceneId, rootId, asset.id, NEW_COLOR);
    expect(await fs.readFile(abs)).toContain(NEW_COLOR);

    // Reopen the project from disk — a brand-new session, undo reads the
    // disk-backed history the first session wrote.
    const fresh = await HearthSession.open(fs, '/proj');
    const undo = await fresh.execute<any>('undo');
    expect(undo.success).toBe(true);
    expect(undo.data.undone).toBe('updatePrefab');
    expect(await fs.readFile(abs)).toBe(originalBytes);
  });

  it('(c) snapshot -> update -> revert restores the payload', async () => {
    const { fs, session, store } = await makeSession();
    const { sceneId, rootId, asset } = await makePrefab(session, store);
    const abs = `/proj/${asset.path}`;
    const originalBytes = await fs.readFile(abs);

    const snap = await session.execute<any>('snapshotProject');
    expect(snap.success).toBe(true);

    await recolorAndUpdate(session, sceneId, rootId, asset.id, NEW_COLOR);
    expect(await fs.readFile(abs)).toContain(NEW_COLOR);

    const revert = await session.execute<any>('revertProject', { confirm: true });
    expect(revert.success).toBe(true);
    expect(await fs.readFile(abs)).toBe(originalBytes);
  });

  it('(d) diff after an update reports the payload change even when entityCount is unchanged', async () => {
    const { session, store } = await makeSession();
    const { sceneId, rootId, asset } = await makePrefab(session, store);

    const snap = await session.execute<any>('snapshotProject');
    expect(snap.success).toBe(true);

    // Color-only change: the asset-index entry (metadata.entityCount) is
    // identical, so only the payload content differs.
    await recolorAndUpdate(session, sceneId, rootId, asset.id, NEW_COLOR);

    const diff = await session.execute<any>('diffProject');
    expect(diff.success).toBe(true);
    const changed = diff.data.assets.find((a: any) => a.id === asset.id);
    expect(changed).toBeDefined();
    expect(changed.status).toBe('modified');
  });

  it('(e) a corrupt prefab payload section in a history snapshot fails undo cleanly (HISTORY_CORRUPT)', async () => {
    const { fs, session, store } = await makeSession();
    const { sceneId, asset } = await makePrefab(session, store);

    // A later mutation whose "before" snapshot carries the prefab payload.
    const createEntity = await session.execute<any>('createEntity', { scene: sceneId, name: 'Extra' });
    expect(createEntity.success).toBe(true);

    const list = await session.execute<any>('listHistory');
    const seq = list.data.entries[list.data.entries.length - 1].seq;
    const statePath = `/proj/.hearth/history/state-${seq}.json`;

    const raw = JSON.parse(await fs.readFile(statePath));
    expect(raw.prefabs[asset.path]).toBeTypeOf('string'); // captured as path -> content
    raw.prefabs[asset.path] = 'not valid prefab json {{{';
    await fs.writeFile(statePath, JSON.stringify(raw));

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(false);
    expect(undo.errors[0].code).toBe('HISTORY_CORRUPT');
  });
});
