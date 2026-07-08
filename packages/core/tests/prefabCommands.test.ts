import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession, PrefabDataSchema } from '@hearth/core';

async function makeSession(granted?: any) {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return {
    fs,
    session: HearthSession.fromStore(store, granted ? { granted } : {}),
    store,
  };
}

/** Add a "Hat" child entity under `player` so the source subtree has 2 entities. */
async function addChild(session: HearthSession, sceneId: string, parentId: string) {
  const created = await session.execute<any>('createEntity', { scene: sceneId, name: 'Hat', parent: parentId });
  expect(created.success).toBe(true);
  return created.data.entityId as string;
}

describe('createPrefab', () => {
  it('writes a schema-valid, root-first prefab payload file and registers a prefab asset', async () => {
    const { session, store, fs } = await makeSession();
    const sceneId = store.project.initialScene!;
    const player = store.getScene(sceneId)!.entities.find((e) => e.name === 'Player')!;
    await addChild(session, sceneId, player.id);

    const result = await session.execute<any>('createPrefab', {
      scene: sceneId,
      entity: player.id,
      name: 'PlayerPrefab',
    });
    expect(result.success).toBe(true);
    expect(result.data.entityCount).toBe(2);

    const asset = result.data.asset;
    expect(asset.type).toBe('prefab');
    expect(asset.name).toBe('PlayerPrefab');
    expect(asset.path).toBe('assets/prefabs/playerprefab.prefab.json');
    expect(asset.metadata.entityCount).toBe(2);

    // asset registered in the store's in-memory index too
    expect(store.getAsset('PlayerPrefab')).toBeDefined();

    const raw = JSON.parse(await fs.readFile(`/proj/${asset.path}`));
    const parsed = PrefabDataSchema.parse(raw); // schema-parses cleanly
    expect(parsed.name).toBe('PlayerPrefab');
    expect(parsed.entities.map((e) => e.id)).toEqual(['pfe_1', 'pfe_2']); // root-first local ids
    expect(parsed.entities[0].parentId).toBeNull();
    expect(parsed.entities[1].parentId).toBe('pfe_1');

    // source root gains a prefab marker pointing at the new asset
    const updatedPlayer = store.getScene(sceneId)!.entities.find((e) => e.id === player.id)!;
    expect(updatedPlayer.prefab).toEqual({ asset: asset.id });
  });

  it('enforces unique asset names (duplicate name -> CONFLICT)', async () => {
    const { session, store } = await makeSession();
    const sceneId = store.project.initialScene!;
    const player = store.getScene(sceneId)!.entities.find((e) => e.name === 'Player')!;

    const first = await session.execute<any>('createPrefab', { scene: sceneId, entity: player.id, name: 'Dup' });
    expect(first.success).toBe(true);

    const ground = store.getScene(sceneId)!.entities.find((e) => e.name === 'Ground')!;
    const dup = await session.execute<any>('createPrefab', { scene: sceneId, entity: ground.id, name: 'Dup' });
    expect(dup.success).toBe(false);
    expect(dup.errors[0].code).toBe('CONFLICT');
  });

  it('errors NOT_FOUND for an unknown root entity', async () => {
    const { session, store } = await makeSession();
    const sceneId = store.project.initialScene!;
    const result = await session.execute<any>('createPrefab', {
      scene: sceneId,
      entity: 'ent_doesnotexist',
      name: 'X',
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('NOT_FOUND');
  });

  it('errors NOT_FOUND for an unknown scene', async () => {
    const { session } = await makeSession();
    const result = await session.execute<any>('createPrefab', {
      scene: 'scn_doesnotexist',
      entity: 'ent_doesnotexist',
      name: 'X',
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('NOT_FOUND');
  });
});

describe('instantiatePrefab', () => {
  async function makePrefabAsset() {
    const ctx = await makeSession();
    const { session, store } = ctx;
    const sourceSceneId = store.project.initialScene!;
    const player = store.getScene(sourceSceneId)!.entities.find((e) => e.name === 'Player')!;
    await addChild(session, sourceSceneId, player.id);
    const created = await session.execute<any>('createPrefab', {
      scene: sourceSceneId,
      entity: player.id,
      name: 'PlayerPrefab',
    });
    expect(created.success).toBe(true);
    return { ...ctx, asset: created.data.asset as { id: string; name: string; path: string }, sourceSceneId };
  }

  it('instantiates a full subtree into a different scene with fresh ids, a marker, and position/name overrides', async () => {
    const { session, store, asset, sourceSceneId } = await makePrefabAsset();

    const otherScene = await session.execute<any>('createScene', { name: 'Level2' });
    expect(otherScene.success).toBe(true);
    const otherSceneId = otherScene.data.sceneId as string;

    const result = await session.execute<any>('instantiatePrefab', {
      prefab: asset.name,
      scene: otherSceneId,
      position: { x: 111, y: 222 },
      name: 'Player Clone',
    });
    expect(result.success).toBe(true);
    expect(result.data.entityCount).toBe(2);

    const rootEntity = result.data.entity;
    expect(rootEntity.name).toBe('Player Clone');
    expect(rootEntity.parentId).toBeNull();
    expect(rootEntity.components.Transform.position).toEqual({ x: 111, y: 222 });
    expect(rootEntity.prefab).toEqual({ asset: asset.id });

    const scene = store.getScene(otherSceneId)!;
    expect(scene.entities).toHaveLength(3); // default Main Camera + the 2 instantiated entities
    const instantiated = scene.entities.filter((e) => e.id === rootEntity.id || e.parentId === rootEntity.id);
    expect(instantiated).toHaveLength(2);

    // fresh ids, distinct from the source scene's original entities
    const sourceIds = new Set(store.getScene(sourceSceneId)!.entities.map((e) => e.id));
    for (const e of instantiated) {
      expect(sourceIds.has(e.id)).toBe(false);
    }
  });

  it('errors NOT_FOUND for an unknown prefab asset', async () => {
    const { session, store } = await makeSession();
    const sceneId = store.project.initialScene!;
    const result = await session.execute<any>('instantiatePrefab', {
      prefab: 'ast_doesnotexist',
      scene: sceneId,
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('NOT_FOUND');
  });

  it('errors PREFAB_DATA_INVALID when the payload on disk is corrupt', async () => {
    const { session, fs, asset, sourceSceneId } = await makePrefabAsset();
    await fs.writeFile(`/proj/${asset.path}`, 'not json {{{');

    const result = await session.execute<any>('instantiatePrefab', {
      prefab: asset.id,
      scene: sourceSceneId,
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('PREFAB_DATA_INVALID');
  });

  it('errors PREFAB_DATA_INVALID when the payload on disk fails schema/local-id validation', async () => {
    const { session, fs, asset, sourceSceneId } = await makePrefabAsset();
    await fs.writeFile(
      `/proj/${asset.path}`,
      JSON.stringify({ name: 'Broken', entities: [{ id: 'pfe_1', name: 'Root', parentId: 'pfe_99', enabled: true, tags: [], components: {} }] }),
    );

    const result = await session.execute<any>('instantiatePrefab', {
      prefab: asset.id,
      scene: sourceSceneId,
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('PREFAB_DATA_INVALID');
  });
});

describe('updatePrefab', () => {
  async function makePrefabAsset() {
    const ctx = await makeSession();
    const { session, store } = ctx;
    const sourceSceneId = store.project.initialScene!;
    const player = store.getScene(sourceSceneId)!.entities.find((e) => e.name === 'Player')!;
    await addChild(session, sourceSceneId, player.id);
    const created = await session.execute<any>('createPrefab', {
      scene: sourceSceneId,
      entity: player.id,
      name: 'PlayerPrefab',
    });
    expect(created.success).toBe(true);
    return {
      ...ctx,
      asset: created.data.asset as { id: string; name: string; path: string },
      sourceSceneId,
      rootId: player.id,
    };
  }

  it('rewrites the payload from a modified instance subtree (read back, new component values)', async () => {
    const { session, store, fs, asset, sourceSceneId, rootId } = await makePrefabAsset();

    const setColor = await session.execute<any>('setComponentProperty', {
      scene: sourceSceneId,
      entity: rootId,
      property: 'SpriteRenderer.color',
      value: '#123456',
    });
    expect(setColor.success).toBe(true);

    // add a second child so the payload's entity count changes too
    await addChild(session, sourceSceneId, rootId);

    const result = await session.execute<any>('updatePrefab', {
      prefab: asset.id,
      scene: sourceSceneId,
      entity: rootId,
    });
    expect(result.success).toBe(true);
    expect(result.data.asset.id).toBe(asset.id);
    expect(result.data.entityCount).toBe(3);
    expect(store.getAsset(asset.id)!.metadata.entityCount).toBe(3);

    const raw = JSON.parse(await fs.readFile(`/proj/${asset.path}`));
    const parsed = PrefabDataSchema.parse(raw);
    expect(parsed.entities).toHaveLength(3);
    expect(parsed.entities[0].components.SpriteRenderer.color).toBe('#123456');
  });

  it('errors PREFAB_NOT_INSTANCE when the entity has no prefab marker', async () => {
    const { session, store, asset, sourceSceneId } = await makePrefabAsset();
    const ground = store.getScene(sourceSceneId)!.entities.find((e) => e.name === 'Ground')!;

    const result = await session.execute<any>('updatePrefab', {
      prefab: asset.id,
      scene: sourceSceneId,
      entity: ground.id,
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('PREFAB_NOT_INSTANCE');
  });

  it('errors PREFAB_NOT_INSTANCE for a mismatched prefab (instance of a different asset)', async () => {
    const { session, store, asset, sourceSceneId, rootId } = await makePrefabAsset();
    const ground = store.getScene(sourceSceneId)!.entities.find((e) => e.name === 'Ground')!;
    const otherPrefab = await session.execute<any>('createPrefab', {
      scene: sourceSceneId,
      entity: ground.id,
      name: 'GroundPrefab',
    });
    expect(otherPrefab.success).toBe(true);

    // rootId is an instance of `asset` (PlayerPrefab), not `otherPrefab` (GroundPrefab)
    const result = await session.execute<any>('updatePrefab', {
      prefab: otherPrefab.data.asset.id,
      scene: sourceSceneId,
      entity: rootId,
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('PREFAB_NOT_INSTANCE');
  });

  it('errors NOT_FOUND for an unknown prefab asset', async () => {
    const { session, sourceSceneId, rootId } = await makePrefabAsset();
    const result = await session.execute<any>('updatePrefab', {
      prefab: 'ast_doesnotexist',
      scene: sourceSceneId,
      entity: rootId,
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('NOT_FOUND');
  });
});

describe('syncPrefabInstances', () => {
  async function makeScenario() {
    const ctx = await makeSession();
    const { session, store } = ctx;
    const sceneAId = store.project.initialScene!;
    const player = store.getScene(sceneAId)!.entities.find((e) => e.name === 'Player')!;
    await addChild(session, sceneAId, player.id);
    const created = await session.execute<any>('createPrefab', {
      scene: sceneAId,
      entity: player.id,
      name: 'PlayerPrefab',
    });
    expect(created.success).toBe(true);
    const asset = created.data.asset as { id: string; name: string; path: string };

    // place a second instance in scene A
    const place2 = await session.execute<any>('instantiatePrefab', {
      prefab: asset.id,
      scene: sceneAId,
      position: { x: 10, y: 20 },
      name: 'Player Two',
    });
    expect(place2.success).toBe(true);
    const secondRootId = place2.data.entity.id as string;

    // and one instance in scene B
    const sceneB = await session.execute<any>('createScene', { name: 'Level2' });
    expect(sceneB.success).toBe(true);
    const sceneBId = sceneB.data.sceneId as string;
    const place3 = await session.execute<any>('instantiatePrefab', {
      prefab: asset.id,
      scene: sceneBId,
      name: 'Player Three',
    });
    expect(place3.success).toBe(true);
    const thirdRootId = place3.data.entity.id as string;

    return { ...ctx, asset, sceneAId, sceneBId, firstRootId: player.id, secondRootId, thirdRootId };
  }

  it('rebuilds children from the payload while preserving per-instance root name/position/enabled and ids, across scenes', async () => {
    const { session, store, asset, sceneAId, sceneBId, firstRootId, secondRootId, thirdRootId } =
      await makeScenario();

    // mutate the shared payload: add a second child + change SpriteRenderer color on the root
    await session.execute<any>('setComponentProperty', {
      scene: sceneAId,
      entity: firstRootId,
      property: 'SpriteRenderer.color',
      value: '#abcdef',
    });
    await addChild(session, sceneAId, firstRootId);
    const update = await session.execute<any>('updatePrefab', {
      prefab: asset.id,
      scene: sceneAId,
      entity: firstRootId,
    });
    expect(update.success).toBe(true);
    expect(update.data.entityCount).toBe(3);

    // disable instance 2, rename it, move it — sync must preserve these
    await session.execute<any>('setEntityEnabled', { scene: sceneAId, entity: secondRootId, enabled: false });
    await session.execute<any>('renameEntity', { scene: sceneAId, entity: secondRootId, newName: 'Renamed Two' });
    await session.execute<any>('moveEntity', { scene: sceneAId, entity: secondRootId, position: { x: 77, y: 88 } });

    const sync = await session.execute<any>('syncPrefabInstances', { prefab: asset.id });
    expect(sync.success).toBe(true);
    expect(sync.data.total).toBe(3);
    expect(sync.data.scenes).toEqual(
      expect.arrayContaining([
        { scene: sceneAId, instances: 2 },
        { scene: sceneBId, instances: 1 },
      ]),
    );

    const sceneA = store.getScene(sceneAId)!;

    const rebuiltFirstRoot = sceneA.entities.find((e) => e.id === firstRootId)!;
    expect(rebuiltFirstRoot.prefab).toEqual({ asset: asset.id });
    expect(rebuiltFirstRoot.components.SpriteRenderer.color).toBe('#abcdef');
    const firstRootChildren = sceneA.entities.filter((e) => e.parentId === firstRootId);
    expect(firstRootChildren).toHaveLength(2);

    const rebuiltSecondRoot = sceneA.entities.find((e) => e.id === secondRootId)!;
    expect(rebuiltSecondRoot.enabled).toBe(false);
    expect(rebuiltSecondRoot.name).toBe('Renamed Two');
    expect(rebuiltSecondRoot.components.Transform.position).toEqual({ x: 77, y: 88 });
    expect(rebuiltSecondRoot.prefab).toEqual({ asset: asset.id });
    // the second instance's root picked up the updated payload color via sync
    expect(rebuiltSecondRoot.components.SpriteRenderer?.color).toBe('#abcdef');
    // second instance's children also rebuilt from the (now 3-entity) payload
    const secondRootChildren = sceneA.entities.filter((e) => e.parentId === secondRootId);
    expect(secondRootChildren).toHaveLength(2);

    const sceneB = store.getScene(sceneBId)!;
    const rebuiltThirdRoot = sceneB.entities.find((e) => e.id === thirdRootId)!;
    expect(rebuiltThirdRoot.name).toBe('Player Three');
    expect(rebuiltThirdRoot.prefab).toEqual({ asset: asset.id });
    expect(sceneB.entities.filter((e) => e.parentId === thirdRootId)).toHaveLength(2);
  });

  it('limits sync scope with the scene param', async () => {
    const { session, asset, sceneAId, sceneBId } = await makeScenario();

    const sync = await session.execute<any>('syncPrefabInstances', { prefab: asset.id, scene: sceneAId });
    expect(sync.success).toBe(true);
    expect(sync.data.scenes).toEqual([{ scene: sceneAId, instances: 2 }]);
    expect(sync.data.total).toBe(2);
    // sceneB untouched: no entry for it
    expect(sync.data.scenes.find((s: any) => s.scene === sceneBId)).toBeUndefined();
  });

  it('omits scenes with no instances from the returned scenes array', async () => {
    const { session, store, asset, sceneAId, sceneBId } = await makeScenario();

    // create a third scene with no instances of the prefab
    const emptyScene = await session.execute<any>('createScene', { name: 'Empty' });
    expect(emptyScene.success).toBe(true);
    const emptySceneId = emptyScene.data.sceneId as string;

    const sync = await session.execute<any>('syncPrefabInstances', { prefab: asset.id });
    expect(sync.success).toBe(true);
    expect(sync.data.total).toBe(3); // 2 in sceneA + 1 in sceneB
    // emptyScene has no instances, so it should be omitted from the scenes array
    expect(sync.data.scenes.find((s: any) => s.scene === emptySceneId)).toBeUndefined();
    expect(sync.data.scenes).toEqual(
      expect.arrayContaining([
        { scene: sceneAId, instances: 2 },
        { scene: sceneBId, instances: 1 },
      ]),
    );
  });

  it('keeps the instance root at its original array index in the scene', async () => {
    const { session, store, asset, sceneAId, secondRootId } = await makeScenario();
    const sceneA = store.getScene(sceneAId)!;
    const indexBefore = sceneA.entities.findIndex((e) => e.id === secondRootId);
    expect(indexBefore).toBeGreaterThanOrEqual(0);

    const sync = await session.execute<any>('syncPrefabInstances', { prefab: asset.id, scene: sceneAId });
    expect(sync.success).toBe(true);

    const indexAfter = store.getScene(sceneAId)!.entities.findIndex((e) => e.id === secondRootId);
    expect(indexAfter).toBe(indexBefore);
  });

  it('undo restores the pre-sync scenes exactly', async () => {
    const { session, store, asset } = await makeScenario();
    const beforeSnapshot = await store.toSnapshot();

    const sync = await session.execute<any>('syncPrefabInstances', { prefab: asset.id });
    expect(sync.success).toBe(true);
    expect(await store.toSnapshot()).not.toEqual(beforeSnapshot);

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(true);
    expect(undo.data.undone).toBe('syncPrefabInstances');
    expect(await store.toSnapshot()).toEqual(beforeSnapshot);
  });

  it('errors NOT_FOUND for an unknown prefab asset', async () => {
    const { session } = await makeSession();
    const result = await session.execute<any>('syncPrefabInstances', { prefab: 'ast_doesnotexist' });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('NOT_FOUND');
  });
});

describe('removeAsset prefab warning', () => {
  it('warns (but does not block) when removing a prefab with live instances', async () => {
    const { session, store } = await makeSession();
    const sceneId = store.project.initialScene!;
    const player = store.getScene(sceneId)!.entities.find((e) => e.name === 'Player')!;

    const created = await session.execute<any>('createPrefab', { scene: sceneId, entity: player.id, name: 'PlayerPrefab' });
    expect(created.success).toBe(true);
    const asset = created.data.asset as { id: string };

    // createPrefab itself marks the source root as a live instance.
    const rm = await session.execute<any>('removeAsset', { asset: asset.id });
    expect(rm.success).toBe(true);
    expect(rm.data.warning).toBeTruthy();
    expect(rm.data.warning).toContain(player.name);

    // asset is actually gone
    expect(store.getAsset(asset.id)).toBeUndefined();
  });

  it('does not warn when the prefab has no live instances', async () => {
    const { session, store } = await makeSession();
    const sceneId = store.project.initialScene!;
    const player = store.getScene(sceneId)!.entities.find((e) => e.name === 'Player')!;

    const created = await session.execute<any>('createPrefab', { scene: sceneId, entity: player.id, name: 'PlayerPrefab' });
    expect(created.success).toBe(true);
    const asset = created.data.asset as { id: string };

    // remove the only marked instance so no live instances remain
    const del = await session.execute<any>('deleteEntity', { scene: sceneId, entity: player.id });
    expect(del.success).toBe(true);

    const rm = await session.execute<any>('removeAsset', { asset: asset.id });
    expect(rm.success).toBe(true);
    expect(rm.data.warning).toBeUndefined();
  });

  it('does not warn when removing a non-prefab asset', async () => {
    const { session, store } = await makeSession();
    const sprite = await session.execute<any>('createSpriteAsset', { name: 'Plain', shape: 'circle', color: 'red' });
    expect(sprite.success).toBe(true);

    const rm = await session.execute<any>('removeAsset', { asset: sprite.data.asset.id });
    expect(rm.success).toBe(true);
    expect(rm.data.warning).toBeUndefined();
  });
});

describe('createPrefab + instantiatePrefab undo/redo', () => {
  it('undo/redo across create + instantiate restores the project exactly', async () => {
    const { session, store } = await makeSession();
    const sceneId = store.project.initialScene!;
    const player = store.getScene(sceneId)!.entities.find((e) => e.name === 'Player')!;

    const create = await session.execute<any>('createPrefab', { scene: sceneId, entity: player.id, name: 'PlayerPrefab' });
    expect(create.success).toBe(true);
    const afterCreateSnapshot = await store.toSnapshot();

    const instantiate = await session.execute<any>('instantiatePrefab', {
      prefab: 'PlayerPrefab',
      scene: sceneId,
      position: { x: 5, y: 5 },
    });
    expect(instantiate.success).toBe(true);
    const afterInstantiateSnapshot = await store.toSnapshot();

    const undoInstantiate = await session.execute<any>('undo');
    expect(undoInstantiate.success).toBe(true);
    expect(undoInstantiate.data.undone).toBe('instantiatePrefab');
    expect(await store.toSnapshot()).toEqual(afterCreateSnapshot);

    const undoCreate = await session.execute<any>('undo');
    expect(undoCreate.success).toBe(true);
    expect(undoCreate.data.undone).toBe('createPrefab');
    expect(store.getAsset('PlayerPrefab')).toBeUndefined();
    expect(store.getScene(sceneId)!.entities.find((e) => e.id === player.id)!.prefab).toBeUndefined();

    const redoCreate = await session.execute<any>('redo');
    expect(redoCreate.success).toBe(true);
    expect(await store.toSnapshot()).toEqual(afterCreateSnapshot);

    const redoInstantiate = await session.execute<any>('redo');
    expect(redoInstantiate.success).toBe(true);
    expect(await store.toSnapshot()).toEqual(afterInstantiateSnapshot);
  });
});
