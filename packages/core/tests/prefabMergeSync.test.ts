/**
 * Prefab merge sync, project-wide auto-sync, override revert, and
 * structural detach. These exercise the merge semantics (id reuse, fresh ids
 * for new locals, deletion of removed locals, override re-application, stale
 * override dropping) plus the command-level auto-sync / revert / detach.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession } from '@hearth/core';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return { fs, session: HearthSession.fromStore(store), store };
}

/**
 * Build a PlayerPrefab (Player + a Hat child) in the initial scene, then place
 * one LIVE instance (populated ids) in a fresh Level2 scene. Returns handles.
 */
async function makeLiveInstance() {
  const ctx = await makeSession();
  const { session, store } = ctx;
  const sourceSceneId = store.project.initialScene!;
  const player = store.getScene(sourceSceneId)!.entities.find((e) => e.name === 'Player')!;
  const hat = await session.execute<any>('createEntity', { scene: sourceSceneId, name: 'Hat', parent: player.id });
  expect(hat.success).toBe(true);

  const created = await session.execute<any>('createPrefab', {
    scene: sourceSceneId,
    entity: player.id,
    name: 'PlayerPrefab',
  });
  expect(created.success).toBe(true);
  const asset = created.data.asset as { id: string; name: string; path: string };

  const level = await session.execute<any>('createScene', { name: 'Level2' });
  const sceneId = level.data.sceneId as string;
  const inst = await session.execute<any>('instantiatePrefab', { prefab: asset.id, scene: sceneId });
  expect(inst.success).toBe(true);
  const rootId = inst.data.entity.id as string;
  const childId = store.getScene(sceneId)!.entities.find((e) => e.parentId === rootId)!.id;

  const marker = () => store.getScene(sceneId)!.entities.find((e) => e.id === rootId)!.prefab!;
  const readPayload = async () => JSON.parse(await ctx.fs.readFile(`/proj/${asset.path}`));
  const writePayload = async (data: unknown) =>
    ctx.fs.writeFile(`/proj/${asset.path}`, JSON.stringify(data));

  return { ...ctx, asset, sourceSceneId, sourceRootId: player.id, sceneId, rootId, childId, marker, readPayload, writePayload };
}

/**
 * A live PlayerPrefab instance whose root has TWO direct children (Hat, Boots),
 * placed in a fresh Level2 scene. Used for reparent-detach policy tests that
 * need a within-subtree reparent target.
 */
async function makeMultiChildInstance() {
  const ctx = await makeSession();
  const { session, store } = ctx;
  const src = store.project.initialScene!;
  const player = store.getScene(src)!.entities.find((e) => e.name === 'Player')!;
  await session.execute<any>('createEntity', { scene: src, name: 'Hat', parent: player.id });
  await session.execute<any>('createEntity', { scene: src, name: 'Boots', parent: player.id });
  const created = await session.execute<any>('createPrefab', { scene: src, entity: player.id, name: 'PlayerPrefab' });
  const asset = created.data.asset as { id: string; path: string };
  const sceneId = (await session.execute<any>('createScene', { name: 'Level2' })).data.sceneId as string;
  const inst = await session.execute<any>('instantiatePrefab', { prefab: asset.id, scene: sceneId });
  const rootId = inst.data.entity.id as string;
  const scene = () => store.getScene(sceneId)!;
  const marker = () => scene().entities.find((e) => e.id === rootId)!.prefab;
  const childByName = (name: string) => scene().entities.find((e) => e.name === name && e.parentId === rootId)!;
  return { ...ctx, asset, sceneId, rootId, scene, marker, childByName };
}

describe('merge sync — id reuse & new-local fresh ids', () => {
  it('reuses existing scene ids for kept locals and repopulates the ids map', async () => {
    const { session, store, asset, sceneId, rootId, childId, marker, readPayload, writePayload } =
      await makeLiveInstance();

    // change the root color in the payload; entities unchanged
    const payload = await readPayload();
    payload.entities[0].components.SpriteRenderer.color = '#ff0000';
    await writePayload(payload);

    const sync = await session.execute<any>('syncPrefabInstances', { prefab: asset.id });
    expect(sync.success).toBe(true);

    // root id preserved, child id REUSED (not regenerated)
    const scene = store.getScene(sceneId)!;
    expect(scene.entities.some((e) => e.id === rootId)).toBe(true);
    expect(scene.entities.some((e) => e.id === childId)).toBe(true);
    // ids map repopulated & complete
    expect(marker().ids.pfe_1).toBe(rootId);
    expect(marker().ids.pfe_2).toBe(childId);
    // root color pulled from payload
    expect(scene.entities.find((e) => e.id === rootId)!.components.SpriteRenderer.color).toBe('#ff0000');
  });

  it('gives fresh ids to newly-added prefab locals and records them in ids', async () => {
    const { session, store, asset, sceneId, rootId, childId, marker, readPayload, writePayload } =
      await makeLiveInstance();

    // add a new local pfe_3 (a second child under the root) to the payload
    const payload = await readPayload();
    payload.entities.push({
      id: 'pfe_3',
      name: 'Boots',
      parentId: 'pfe_1',
      enabled: true,
      tags: [],
      components: { Transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } } },
    });
    await writePayload(payload);

    const sync = await session.execute<any>('syncPrefabInstances', { prefab: asset.id });
    expect(sync.success).toBe(true);

    const scene = store.getScene(sceneId)!;
    const boots = scene.entities.find((e) => e.name === 'Boots' && e.parentId === rootId)!;
    expect(boots).toBeDefined();
    // fresh id, distinct from existing ones, recorded in the ids map
    expect(boots.id).not.toBe(childId);
    expect(marker().ids.pfe_3).toBe(boots.id);
    expect(marker().ids.pfe_1).toBe(rootId);
    expect(marker().ids.pfe_2).toBe(childId);
  });

  it('deletes entities for locals removed from the prefab and drops them from ids', async () => {
    const { session, store, asset, sceneId, childId, marker, readPayload, writePayload } =
      await makeLiveInstance();

    // remove pfe_2 (the Hat child) from the payload
    const payload = await readPayload();
    payload.entities = payload.entities.filter((e: any) => e.id !== 'pfe_2');
    await writePayload(payload);

    const sync = await session.execute<any>('syncPrefabInstances', { prefab: asset.id });
    expect(sync.success).toBe(true);

    const scene = store.getScene(sceneId)!;
    expect(scene.entities.some((e) => e.id === childId)).toBe(false);
    expect(marker().ids.pfe_2).toBeUndefined();
  });

  it('preserves per-instance root name/position/enabled across a merge', async () => {
    const { session, store, asset, sceneId, rootId, readPayload, writePayload } = await makeLiveInstance();

    await session.execute<any>('renameEntity', { scene: sceneId, entity: rootId, newName: 'Hero' });
    await session.execute<any>('setEntityEnabled', { scene: sceneId, entity: rootId, enabled: false });
    await session.execute<any>('moveEntity', { scene: sceneId, entity: rootId, position: { x: 42, y: 99 } });

    const payload = await readPayload();
    payload.entities[0].components.SpriteRenderer.color = '#00ff00';
    await writePayload(payload);

    const sync = await session.execute<any>('syncPrefabInstances', { prefab: asset.id });
    expect(sync.success).toBe(true);

    const root = store.getScene(sceneId)!.entities.find((e) => e.id === rootId)!;
    expect(root.name).toBe('Hero');
    expect(root.enabled).toBe(false);
    expect(root.components.Transform.position).toEqual({ x: 42, y: 99 });
    expect(root.components.SpriteRenderer.color).toBe('#00ff00'); // non-position root field still synced
  });
});

describe('merge sync — overrides', () => {
  it('re-applies a recorded child override on top of the rebuilt subtree', async () => {
    const { session, store, asset, sceneId, childId, marker, readPayload, writePayload } =
      await makeLiveInstance();

    // record an override on the child
    await session.execute<any>('setComponentProperty', {
      scene: sceneId,
      entity: childId,
      property: 'Transform.position.x',
      value: 123,
    });
    expect(marker().overrides).toHaveLength(1);

    // change the payload root color and sync
    const payload = await readPayload();
    payload.entities[0].components.SpriteRenderer.color = '#abcdef';
    await writePayload(payload);
    const sync = await session.execute<any>('syncPrefabInstances', { prefab: asset.id });
    expect(sync.success).toBe(true);

    // override survives: child still x=123, and the record is preserved
    const child = store.getScene(sceneId)!.entities.find((e) => e.id === childId)!;
    expect(child.components.Transform.position.x).toBe(123);
    expect(marker().overrides).toEqual([
      { entity: childId, component: 'Transform', path: 'position.x', value: 123 },
    ]);
    expect(sync.data.overridesPreserved).toBe(1);
    expect(sync.data.overridesDropped).toBe(0);
  });

  it('drops a stale override (component gone from prefab) with a PREFAB_OVERRIDE_STALE warning', async () => {
    const { session, store, asset, sceneId, childId, marker, readPayload, writePayload } =
      await makeLiveInstance();

    // override the child's SpriteRenderer... but the Hat child has only Transform.
    // Instead override the ROOT's SpriteRenderer, then delete SpriteRenderer from
    // the root in the payload so the override becomes stale.
    const rootId = marker().ids.pfe_1;
    await session.execute<any>('setComponentProperty', {
      scene: sceneId,
      entity: rootId,
      property: 'SpriteRenderer.color',
      value: '# deadbe'.replace(' ', ''),
    });
    expect(marker().overrides).toHaveLength(1);

    const payload = await readPayload();
    delete payload.entities[0].components.SpriteRenderer;
    await writePayload(payload);

    const sync = await session.execute<any>('syncPrefabInstances', { prefab: asset.id });
    expect(sync.success).toBe(true);
    expect(sync.data.overridesDropped).toBe(1);
    expect(marker().overrides).toHaveLength(0);
    expect(sync.warnings.some((w: any) => w.code === 'PREFAB_OVERRIDE_STALE')).toBe(true);
    void childId;
  });

  it('drops an override whose value would make the merged component schema-invalid, keeping the prefab value', async () => {
    const { session, store, asset, sceneId, rootId, marker, readPayload, writePayload } =
      await makeLiveInstance();

    // The prefab holds a valid hex string for the root color.
    const payload = await readPayload();
    payload.entities[0].components.SpriteRenderer.color = '#00ff00';
    await writePayload(payload);

    // Inject an override that puts a NUMBER where the schema wants a string
    // (as if the prefab field type flipped number -> string under a live
    // numeric override). Re-applying it must fail the schema re-parse.
    const mk = marker();
    mk.overrides = mk.overrides ?? [];
    mk.overrides.push({ entity: rootId, component: 'SpriteRenderer', path: 'color', value: 123 });

    const sync = await session.execute<any>('syncPrefabInstances', { prefab: asset.id, scene: sceneId });
    expect(sync.success).toBe(true);
    expect(sync.data.overridesDropped).toBe(1);
    expect(sync.warnings.some((w: any) => w.code === 'PREFAB_OVERRIDE_STALE')).toBe(true);

    // Component kept the prefab value and is still schema-valid.
    const root = store.getScene(sceneId)!.entities.find((e) => e.id === rootId)!;
    expect(root.components.SpriteRenderer.color).toBe('#00ff00');
    expect(marker().overrides).toHaveLength(0);
  });
});

describe('merge sync — legacy (empty-ids) instance', () => {
  it('full-rebuilds a legacy instance once and then links it (ids repopulated)', async () => {
    const { session, store } = await makeSession();
    const sceneId = store.project.initialScene!;
    const player = store.getScene(sceneId)!.entities.find((e) => e.name === 'Player')!;
    await session.execute<any>('createEntity', { scene: sceneId, name: 'Hat', parent: player.id });
    const created = await session.execute<any>('createPrefab', { scene: sceneId, entity: player.id, name: 'PlayerPrefab' });
    const asset = created.data.asset as { id: string };

    // source root is legacy-detached: empty ids
    const before = store.getScene(sceneId)!.entities.find((e) => e.id === player.id)!;
    expect(before.prefab!.ids).toEqual({});

    const sync = await session.execute<any>('syncPrefabInstances', { prefab: asset.id });
    expect(sync.success).toBe(true);

    const after = store.getScene(sceneId)!.entities.find((e) => e.id === player.id)!;
    expect(after.prefab!.asset).toBe(asset.id);
    // now linked: ids maps pfe_1 -> the (preserved) root id
    expect(after.prefab!.ids.pfe_1).toBe(player.id);
    expect(Object.keys(after.prefab!.ids).length).toBeGreaterThanOrEqual(2);
  });
});

describe('updatePrefab — project-wide auto-sync', () => {
  async function scenario() {
    const ctx = await makeSession();
    const { session, store } = ctx;
    const sceneAId = store.project.initialScene!;
    const player = store.getScene(sceneAId)!.entities.find((e) => e.name === 'Player')!;
    await session.execute<any>('createEntity', { scene: sceneAId, name: 'Hat', parent: player.id });
    const created = await session.execute<any>('createPrefab', { scene: sceneAId, entity: player.id, name: 'PlayerPrefab' });
    const asset = created.data.asset as { id: string; name: string; path: string };

    // one instance in scene A, one in scene B
    const p2 = await session.execute<any>('instantiatePrefab', { prefab: asset.id, scene: sceneAId, name: 'Two' });
    const bId = (await session.execute<any>('createScene', { name: 'Level2' })).data.sceneId as string;
    const p3 = await session.execute<any>('instantiatePrefab', { prefab: asset.id, scene: bId, name: 'Three' });

    return {
      ...ctx,
      asset,
      sceneAId,
      sceneBId: bId,
      sourceRootId: player.id,
      root2: p2.data.entity.id as string,
      root3: p3.data.entity.id as string,
    };
  }

  it('syncs every instance across all scenes in one command and reports counts', async () => {
    const { session, store, asset, sceneAId, sceneBId, sourceRootId, root2, root3 } = await scenario();

    // change the source instance color then bake+auto-sync
    await session.execute<any>('setComponentProperty', {
      scene: sceneAId,
      entity: sourceRootId,
      property: 'SpriteRenderer.color',
      value: '#ff8800',
    });
    const update = await session.execute<any>('updatePrefab', { prefab: asset.id, scene: sceneAId, entity: sourceRootId });
    expect(update.success).toBe(true);
    expect(update.data.instancesSynced).toBeGreaterThanOrEqual(3);
    expect(typeof update.data.overridesPreserved).toBe('number');
    expect(typeof update.data.overridesDropped).toBe('number');

    // all three instances picked up the new color
    for (const [sc, id] of [[sceneAId, sourceRootId], [sceneAId, root2], [sceneBId, root3]] as const) {
      const e = store.getScene(sc)!.entities.find((x) => x.id === id)!;
      expect(e.components.SpriteRenderer.color).toBe('#ff8800');
    }
  });

  it('is a single undo entry that restores every instance AND the prefab file', async () => {
    const { session, store, fs, asset, sceneAId, sourceRootId } = await scenario();
    const abs = `/proj/${asset.path}`;
    const beforeBytes = await fs.readFile(abs);
    const beforeSnapshot = await store.toSnapshot();

    await session.execute<any>('setComponentProperty', {
      scene: sceneAId,
      entity: sourceRootId,
      property: 'SpriteRenderer.color',
      value: '#010101',
    });
    const update = await session.execute<any>('updatePrefab', { prefab: asset.id, scene: sceneAId, entity: sourceRootId });
    expect(update.success).toBe(true);
    expect(await fs.readFile(abs)).not.toBe(beforeBytes);

    // undo the updatePrefab, then undo the color set — back to the start
    const u1 = await session.execute<any>('undo');
    expect(u1.success).toBe(true);
    expect(u1.data.undone).toBe('updatePrefab');
    // prefab payload file restored by the single updatePrefab undo
    expect(await fs.readFile(abs)).toBe(beforeBytes);

    const u2 = await session.execute<any>('undo');
    expect(u2.success).toBe(true);
    expect(await store.toSnapshot()).toEqual(beforeSnapshot);
  });
});

describe('revertPrefabOverride', () => {
  it('reverts a single field (component+path) back to the prefab value and drops the record', async () => {
    const { session, store, sceneId, childId, marker } = await makeLiveInstance();
    const before = store.getScene(sceneId)!.entities.find((e) => e.id === childId)!.components.Transform.position.x;

    await session.execute<any>('setComponentProperty', {
      scene: sceneId,
      entity: childId,
      property: 'Transform.position.x',
      value: 500,
    });
    expect(marker().overrides).toHaveLength(1);

    const revert = await session.execute<any>('revertPrefabOverride', {
      scene: sceneId,
      entity: childId,
      component: 'Transform',
      path: 'position.x',
    });
    expect(revert.success).toBe(true);
    const after = store.getScene(sceneId)!.entities.find((e) => e.id === childId)!.components.Transform.position.x;
    expect(after).toBe(before); // restored to prefab value
    expect(marker().overrides).toHaveLength(0);
  });

  it('reverts a whole component (no path) on an entity', async () => {
    const { session, sceneId, childId, marker } = await makeLiveInstance();
    await session.execute<any>('setProperties', {
      scene: sceneId,
      entity: childId,
      properties: { 'Transform.position.x': 1, 'Transform.position.y': 2 },
    });
    expect(marker().overrides).toHaveLength(2);

    const revert = await session.execute<any>('revertPrefabOverride', {
      scene: sceneId,
      entity: childId,
      component: 'Transform',
    });
    expect(revert.success).toBe(true);
    expect(marker().overrides).toHaveLength(0);
  });

  it('reverts ALL overrides on an entity when neither component nor path is given', async () => {
    const { session, sceneId, rootId, childId, marker } = await makeLiveInstance();
    await session.execute<any>('setComponentProperty', { scene: sceneId, entity: childId, property: 'Transform.position.x', value: 9 });
    await session.execute<any>('setComponentProperty', { scene: sceneId, entity: rootId, property: 'SpriteRenderer.color', value: '#111111' });
    expect(marker().overrides).toHaveLength(2);

    const revert = await session.execute<any>('revertPrefabOverride', { scene: sceneId, entity: childId });
    expect(revert.success).toBe(true);
    // only the child's override was removed; the root's remains
    expect(marker().overrides).toEqual([
      { entity: rootId, component: 'SpriteRenderer', path: 'color', value: '#111111' },
    ]);
  });

  it('is a no-op success when the target has no overrides', async () => {
    const { session, sceneId, childId, marker } = await makeLiveInstance();
    const revert = await session.execute<any>('revertPrefabOverride', { scene: sceneId, entity: childId });
    expect(revert.success).toBe(true);
    expect(marker().overrides).toHaveLength(0);
  });
});

describe('structural detach', () => {
  it('detaches when a child entity is added inside an instance subtree', async () => {
    const { session, store, sceneId, rootId, marker } = await makeLiveInstance();
    expect(marker().ids.pfe_1).toBe(rootId);

    const add = await session.execute<any>('createEntity', { scene: sceneId, name: 'Extra', parent: rootId });
    expect(add.success).toBe(true);
    expect(add.warnings.some((w: any) => w.code === 'PREFAB_INSTANCE_DETACHED')).toBe(true);
    // marker removed
    expect(store.getScene(sceneId)!.entities.find((e) => e.id === rootId)!.prefab).toBeUndefined();
  });

  it('detaches when an entity inside the subtree is deleted', async () => {
    const { session, store, sceneId, rootId, childId } = await makeLiveInstance();
    const del = await session.execute<any>('deleteEntity', { scene: sceneId, entity: childId });
    expect(del.success).toBe(true);
    expect(del.warnings.some((w: any) => w.code === 'PREFAB_INSTANCE_DETACHED')).toBe(true);
    expect(store.getScene(sceneId)!.entities.find((e) => e.id === rootId)!.prefab).toBeUndefined();
  });

  it('detaches on a root component add/remove', async () => {
    const { session, store, sceneId, rootId } = await makeLiveInstance();
    const add = await session.execute<any>('addComponent', { scene: sceneId, entity: rootId, type: 'AudioSource' });
    expect(add.success).toBe(true);
    expect(add.warnings.some((w: any) => w.code === 'PREFAB_INSTANCE_DETACHED')).toBe(true);
    expect(store.getScene(sceneId)!.entities.find((e) => e.id === rootId)!.prefab).toBeUndefined();
  });

  it('records nothing after a detach (marker gone)', async () => {
    const { session, store, sceneId, rootId, childId } = await makeLiveInstance();
    await session.execute<any>('addComponent', { scene: sceneId, entity: rootId, type: 'AudioSource' });
    // now edit the child: no marker means no override recorded anywhere
    await session.execute<any>('setComponentProperty', { scene: sceneId, entity: childId, property: 'Transform.position.x', value: 77 });
    for (const e of store.getScene(sceneId)!.entities) {
      expect(e.prefab?.overrides ?? []).toEqual([]);
    }
  });
});

describe('duplicateEntity — prefab instances (Task 6 finding 1)', () => {
  it('detaches the instance when a non-root member is duplicated', async () => {
    const { session, store, sceneId, rootId, childId } = await makeLiveInstance();
    const dup = await session.execute<any>('duplicateEntity', { scene: sceneId, entity: childId });
    expect(dup.success).toBe(true);
    expect((dup.warnings ?? []).some((w: any) => w.code === 'PREFAB_INSTANCE_DETACHED')).toBe(true);
    expect(store.getScene(sceneId)!.entities.find((e) => e.id === rootId)!.prefab).toBeUndefined();
  });

  it('duplicating an instance root yields a second, independently syncable instance with remapped ids', async () => {
    const { session, store, asset, sceneId, rootId, marker, readPayload, writePayload } =
      await makeLiveInstance();
    const origIds = new Set(Object.values(marker().ids));

    const dup = await session.execute<any>('duplicateEntity', { scene: sceneId, entity: rootId });
    expect(dup.success).toBe(true);
    expect((dup.warnings ?? []).some((w: any) => w.code === 'PREFAB_INSTANCE_DETACHED')).toBe(false);

    const copyRootId = dup.data.entityId as string;
    const copyRoot = store.getScene(sceneId)!.entities.find((e) => e.id === copyRootId)!;

    // The copy is an independent instance: marker present, same asset, root pinned.
    expect(copyRoot.prefab).toBeDefined();
    expect(copyRoot.prefab!.asset).toBe(asset.id);
    expect(copyRoot.prefab!.ids.pfe_1).toBe(copyRootId);
    // Remapped: none of the copy's scene ids collide with the original's ids.
    for (const id of Object.values(copyRoot.prefab!.ids)) {
      expect(origIds.has(id as string)).toBe(false);
    }
    // Original instance stays linked and untouched.
    expect(marker().ids.pfe_1).toBe(rootId);

    // Both instances sync from the payload with no cross-instance id collision.
    const payload = await readPayload();
    payload.entities[0].components.SpriteRenderer.color = '#0abced';
    await writePayload(payload);
    const sync = await session.execute<any>('syncPrefabInstances', { prefab: asset.id, scene: sceneId });
    expect(sync.success).toBe(true);
    expect(sync.data.total).toBe(2);

    const after = store.getScene(sceneId)!;
    expect(after.entities.find((e) => e.id === rootId)!.components.SpriteRenderer.color).toBe('#0abced');
    expect(after.entities.find((e) => e.id === copyRootId)!.components.SpriteRenderer.color).toBe('#0abced');

    // Each instance kept its own distinct child.
    const origChildren = after.entities.filter((e) => e.parentId === rootId);
    const copyChildren = after.entities.filter((e) => e.parentId === copyRootId);
    expect(origChildren).toHaveLength(1);
    expect(copyChildren).toHaveLength(1);
    expect(origChildren[0].id).not.toBe(copyChildren[0].id);
  });

  it('duplicating a non-instance entity is unchanged (no marker, no detach)', async () => {
    const { session, store } = await makeSession();
    const sceneId = store.project.initialScene!;
    const ground = store.getScene(sceneId)!.entities.find((e) => e.name === 'Ground')!;
    const dup = await session.execute<any>('duplicateEntity', { scene: sceneId, entity: ground.id });
    expect(dup.success).toBe(true);
    expect((dup.warnings ?? []).some((w: any) => w.code === 'PREFAB_INSTANCE_DETACHED')).toBe(false);
    const copy = store.getScene(sceneId)!.entities.find((e) => e.id === dup.data.entityId)!;
    expect(copy.prefab).toBeUndefined();
    expect(dup.data.copiedCount).toBe(1);
  });
});

describe('moveEntity reparent — structural detach (Task 6 finding 2)', () => {
  it('detaches when a non-root member is moved out of the instance', async () => {
    const { session, sceneId, marker, childByName } = await makeMultiChildInstance();
    const hat = childByName('Hat');
    const r = await session.execute<any>('moveEntity', { scene: sceneId, entity: hat.id, parent: null });
    expect(r.success).toBe(true);
    expect(r.warnings.some((w: any) => w.code === 'PREFAB_INSTANCE_DETACHED')).toBe(true);
    expect(marker()).toBeUndefined();
  });

  it('detaches when a foreign entity is moved into the instance subtree', async () => {
    const { session, sceneId, rootId, marker } = await makeMultiChildInstance();
    const foreign = await session.execute<any>('createEntity', { scene: sceneId, name: 'Foreign' });
    const r = await session.execute<any>('moveEntity', {
      scene: sceneId,
      entity: foreign.data.entityId,
      parent: rootId,
    });
    expect(r.success).toBe(true);
    expect(r.warnings.some((w: any) => w.code === 'PREFAB_INSTANCE_DETACHED')).toBe(true);
    expect(marker()).toBeUndefined();
  });

  it('detaches when a member is reparented within the subtree', async () => {
    const { session, sceneId, marker, childByName } = await makeMultiChildInstance();
    const hat = childByName('Hat');
    const boots = childByName('Boots');
    const r = await session.execute<any>('moveEntity', { scene: sceneId, entity: boots.id, parent: hat.id });
    expect(r.success).toBe(true);
    expect(r.warnings.some((w: any) => w.code === 'PREFAB_INSTANCE_DETACHED')).toBe(true);
    expect(marker()).toBeUndefined();
  });

  it('does NOT detach an instance-root reparent under a new scene parent, and next sync still works', async () => {
    const { session, store, asset, sceneId, rootId, marker } = await makeMultiChildInstance();
    const holder = await session.execute<any>('createEntity', { scene: sceneId, name: 'Holder' });
    const r = await session.execute<any>('moveEntity', {
      scene: sceneId,
      entity: rootId,
      parent: holder.data.entityId,
    });
    expect(r.success).toBe(true);
    expect(r.warnings.some((w: any) => w.code === 'PREFAB_INSTANCE_DETACHED')).toBe(false);
    expect(marker()).toBeDefined();
    expect(store.getScene(sceneId)!.entities.find((e) => e.id === rootId)!.parentId).toBe(holder.data.entityId);

    const sync = await session.execute<any>('syncPrefabInstances', { prefab: asset.id, scene: sceneId });
    expect(sync.success).toBe(true);
    expect(marker()!.asset).toBe(asset.id);
  });
});
