import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession } from '@hearth/core';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return { fs, session: HearthSession.fromStore(store, {}), store };
}

/**
 * Build a prefab from Player (with a Hat child) and instantiate it into a
 * fresh scene. Returns the instance root id, the child id, and helpers.
 * Player has Transform + SpriteRenderer; the Hat child has only Transform.
 */
async function makeInstance() {
  const ctx = await makeSession();
  const { session, store } = ctx;
  const sourceSceneId = store.project.initialScene!;
  const player = store.getScene(sourceSceneId)!.entities.find((e) => e.name === 'Player')!;
  const hat = await session.execute<any>('createEntity', {
    scene: sourceSceneId,
    name: 'Hat',
    parent: player.id,
  });
  expect(hat.success).toBe(true);

  const created = await session.execute<any>('createPrefab', {
    scene: sourceSceneId,
    entity: player.id,
    name: 'PlayerPrefab',
  });
  expect(created.success).toBe(true);
  const asset = created.data.asset as { id: string; name: string };

  const level = await session.execute<any>('createScene', { name: 'Level2' });
  expect(level.success).toBe(true);
  const sceneId = level.data.sceneId as string;

  const inst = await session.execute<any>('instantiatePrefab', { prefab: asset.id, scene: sceneId });
  expect(inst.success).toBe(true);
  const rootId = inst.data.entity.id as string;

  const scene = store.getScene(sceneId)!;
  const childId = scene.entities.find((e) => e.parentId === rootId)!.id;

  const rootMarker = () => store.getScene(sceneId)!.entities.find((e) => e.id === rootId)!.prefab!;

  return { ...ctx, asset, sceneId, rootId, childId, rootMarker };
}

describe('instantiatePrefab writes ids', () => {
  it('records a complete local-id -> scene-id map on the root marker', async () => {
    const { store, sceneId, rootId, childId, rootMarker } = await makeInstance();
    const marker = rootMarker();
    expect(marker.asset).toBeTruthy();
    expect(marker.overrides).toEqual([]);
    // pfe_1 -> root, pfe_2 -> child (BFS order from serialize)
    expect(marker.ids.pfe_1).toBe(rootId);
    expect(marker.ids.pfe_2).toBe(childId);
    // every mapped id is a live entity in the scene
    const live = new Set(store.getScene(sceneId)!.entities.map((e) => e.id));
    for (const id of Object.values(marker.ids)) expect(live.has(id as string)).toBe(true);
  });
});

describe('override recording — setComponentProperty', () => {
  it('records an override for a write to an instance child', async () => {
    const { session, sceneId, childId, rootMarker } = await makeInstance();
    const r = await session.execute<any>('setComponentProperty', {
      scene: sceneId,
      entity: childId,
      property: 'Transform.position.x',
      value: 77,
    });
    expect(r.success).toBe(true);
    expect(rootMarker().overrides).toEqual([
      { entity: childId, component: 'Transform', path: 'position.x', value: 77 },
    ]);
  });

  it('records a root component override (root non-position edits count)', async () => {
    const { session, sceneId, rootId, rootMarker } = await makeInstance();
    const r = await session.execute<any>('setComponentProperty', {
      scene: sceneId,
      entity: rootId,
      property: 'SpriteRenderer.color',
      value: '#abcdef',
    });
    expect(r.success).toBe(true);
    expect(rootMarker().overrides).toEqual([
      { entity: rootId, component: 'SpriteRenderer', path: 'color', value: '#abcdef' },
    ]);
  });

  it('never records a write to the ROOT Transform.position', async () => {
    const { session, sceneId, rootId, rootMarker } = await makeInstance();
    const r = await session.execute<any>('setComponentProperty', {
      scene: sceneId,
      entity: rootId,
      property: 'Transform.position.x',
      value: 999,
    });
    expect(r.success).toBe(true);
    expect(rootMarker().overrides).toEqual([]);
  });

  it('replaces (does not append) on a repeat write to the same path', async () => {
    const { session, sceneId, childId, rootMarker } = await makeInstance();
    await session.execute<any>('setComponentProperty', {
      scene: sceneId,
      entity: childId,
      property: 'Transform.position.x',
      value: 1,
    });
    await session.execute<any>('setComponentProperty', {
      scene: sceneId,
      entity: childId,
      property: 'Transform.position.x',
      value: 2,
    });
    expect(rootMarker().overrides).toEqual([
      { entity: childId, component: 'Transform', path: 'position.x', value: 2 },
    ]);
  });

  it('records nothing for edits to a non-instance entity', async () => {
    const { session, store } = await makeInstance();
    const mainSceneId = store.project.initialScene!;
    const ground = store.getScene(mainSceneId)!.entities.find((e) => e.name === 'Ground')!;
    const r = await session.execute<any>('setComponentProperty', {
      scene: mainSceneId,
      entity: ground.id,
      property: 'Transform.position.x',
      value: 5,
    });
    expect(r.success).toBe(true);
    // Ground is not part of any instance -> no marker anywhere gained an override
    for (const scene of store.scenes.values()) {
      for (const e of scene.entities) {
        expect(e.prefab?.overrides ?? []).toEqual([]);
      }
    }
  });
});

describe('override recording — setProperties', () => {
  it('records one override per written key', async () => {
    const { session, sceneId, childId, rootMarker } = await makeInstance();
    const r = await session.execute<any>('setProperties', {
      scene: sceneId,
      entity: childId,
      properties: { 'Transform.position.x': 10, 'Transform.position.y': 20 },
    });
    expect(r.success).toBe(true);
    expect(rootMarker().overrides).toEqual(
      expect.arrayContaining([
        { entity: childId, component: 'Transform', path: 'position.x', value: 10 },
        { entity: childId, component: 'Transform', path: 'position.y', value: 20 },
      ]),
    );
    expect(rootMarker().overrides).toHaveLength(2);
  });
});

describe('override recording — moveEntity', () => {
  it('records a Transform.position override for a NON-root member', async () => {
    const { session, sceneId, childId, rootMarker } = await makeInstance();
    const r = await session.execute<any>('moveEntity', {
      scene: sceneId,
      entity: childId,
      position: { x: 33, y: 44 },
    });
    expect(r.success).toBe(true);
    expect(rootMarker().overrides).toEqual([
      { entity: childId, component: 'Transform', path: 'position', value: { x: 33, y: 44 } },
    ]);
  });

  it('does NOT record when moving the instance ROOT', async () => {
    const { session, sceneId, rootId, rootMarker } = await makeInstance();
    const r = await session.execute<any>('moveEntity', {
      scene: sceneId,
      entity: rootId,
      position: { x: 5, y: 6 },
    });
    expect(r.success).toBe(true);
    expect(rootMarker().overrides).toEqual([]);
  });

  it('reparenting a non-root member out of the instance detaches it (never recorded as an override)', async () => {
    const { session, store, sceneId, rootId, childId } = await makeInstance();
    // Moving a member out is a membership-altering structural edit: the instance
    // is detached (marker removed), so nothing is recorded as an override.
    const r = await session.execute<any>('moveEntity', { scene: sceneId, entity: childId, parent: null });
    expect(r.success).toBe(true);
    expect(r.warnings.some((w: any) => w.code === 'PREFAB_INSTANCE_DETACHED')).toBe(true);
    expect(store.getScene(sceneId)!.entities.find((e) => e.id === rootId)!.prefab).toBeUndefined();
  });
});

describe('override recording — undo', () => {
  it('undo removes the override record together with the value change', async () => {
    const { session, store, sceneId, childId, rootMarker } = await makeInstance();
    const childPos = () =>
      store.getScene(sceneId)!.entities.find((e) => e.id === childId)!.components.Transform!.position.x;
    const posBefore = childPos();

    const r = await session.execute<any>('setComponentProperty', {
      scene: sceneId,
      entity: childId,
      property: 'Transform.position.x',
      value: 123,
    });
    expect(r.success).toBe(true);
    expect(childPos()).toBe(123);
    expect(rootMarker().overrides).toHaveLength(1);

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(true);
    // The value change and the override record are both undone in one step —
    // they were a single command mutation.
    expect(childPos()).toBe(posBefore);
    expect(rootMarker().overrides).toEqual([]);
  });
});

describe('inspectEntity prefab block', () => {
  it('reports asset/root/localId/overridden for an instance child', async () => {
    const { session, sceneId, rootId, childId } = await makeInstance();
    await session.execute<any>('setComponentProperty', {
      scene: sceneId,
      entity: childId,
      property: 'Transform.position.x',
      value: 8,
    });
    const r = await session.execute<any>('inspectEntity', { scene: sceneId, entity: childId });
    expect(r.success).toBe(true);
    expect(r.data.prefab.root).toBe(rootId);
    expect(r.data.prefab.localId).toBe('pfe_2');
    expect(r.data.prefab.asset).toBeTruthy();
    expect(r.data.prefab.overridden).toEqual([{ component: 'Transform', path: 'position.x' }]);
  });

  it('reports the root as an instance member (localId pfe_1) with its own overridden list', async () => {
    const { session, sceneId, rootId } = await makeInstance();
    await session.execute<any>('setComponentProperty', {
      scene: sceneId,
      entity: rootId,
      property: 'SpriteRenderer.color',
      value: '#010203',
    });
    const r = await session.execute<any>('inspectEntity', { scene: sceneId, entity: rootId });
    expect(r.success).toBe(true);
    expect(r.data.prefab.root).toBe(rootId);
    expect(r.data.prefab.localId).toBe('pfe_1');
    expect(r.data.prefab.overridden).toEqual([{ component: 'SpriteRenderer', path: 'color' }]);
  });

  it('has no prefab block for a non-instance entity', async () => {
    const { session, store } = await makeInstance();
    const mainSceneId = store.project.initialScene!;
    const ground = store.getScene(mainSceneId)!.entities.find((e) => e.name === 'Ground')!;
    const r = await session.execute<any>('inspectEntity', { scene: mainSceneId, entity: ground.id });
    expect(r.success).toBe(true);
    expect(r.data.prefab).toBeUndefined();
  });
});
