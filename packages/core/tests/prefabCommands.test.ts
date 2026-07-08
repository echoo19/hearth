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
