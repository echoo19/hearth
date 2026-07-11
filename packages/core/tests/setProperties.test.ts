import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession } from '@hearth/core';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  const session = HearthSession.fromStore(store, {});
  return { fs, session, store };
}

async function makeEntity(session: HearthSession, scene = 'Main') {
  const created = await session.execute<any>('createEntity', {
    scene,
    name: 'Coin',
    components: { Transform: {}, SpriteRenderer: {} },
  });
  expect(created.success).toBe(true);
  return created.data.entityId as string;
}

describe('setProperties (batch)', () => {
  it('applies multiple properties across components in one call', async () => {
    const { session, store } = await makeSession();
    const entityId = await makeEntity(session);

    const result = await session.execute<any>('setProperties', {
      scene: 'Main',
      entity: entityId,
      properties: {
        'Transform.position.x': 100,
        'Transform.position.y': 50,
        'SpriteRenderer.width': 64,
        'SpriteRenderer.height': 48,
      },
    });

    expect(result.success).toBe(true);
    expect(result.data.entityId).toBe(entityId);
    expect(result.data.components.Transform.position).toEqual({ x: 100, y: 50 });
    expect(result.data.components.SpriteRenderer.width).toBe(64);
    expect(result.data.components.SpriteRenderer.height).toBe(48);

    const entity = store.getScene('Main')!.entities.find((e) => e.id === entityId)!;
    expect(entity.components.Transform!.position).toEqual({ x: 100, y: 50 });
    expect(entity.components.SpriteRenderer!.width).toBe(64);
    expect(entity.components.SpriteRenderer!.height).toBe(48);
  });

  it('is all-or-nothing: one bad key rejects the whole batch, writing nothing', async () => {
    const { session, store } = await makeSession();
    const entityId = await makeEntity(session);

    const before = structuredClone(store.getScene('Main')!.entities.find((e) => e.id === entityId)!.components);

    const result = await session.execute<any>('setProperties', {
      scene: 'Main',
      entity: entityId,
      properties: {
        'Transform.position.x': 100,
        'Transform.postiion.y': 50, // typo
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors[0].message).toContain('position');

    const after = store.getScene('Main')!.entities.find((e) => e.id === entityId)!.components;
    expect(after).toEqual(before);
  });

  it('is all-or-nothing when a resulting value fails schema re-validation', async () => {
    const { session, store } = await makeSession();
    const entityId = await makeEntity(session);
    const before = structuredClone(store.getScene('Main')!.entities.find((e) => e.id === entityId)!.components);

    const result = await session.execute<any>('setProperties', {
      scene: 'Main',
      entity: entityId,
      properties: {
        'Transform.position.x': 100,
        'SpriteRenderer.width': -5, // width must be positive
      },
    });

    expect(result.success).toBe(false);
    const after = store.getScene('Main')!.entities.find((e) => e.id === entityId)!.components;
    expect(after).toEqual(before);
  });

  it('rejects a missing component with NOT_FOUND, writing nothing', async () => {
    const { session, store } = await makeSession();
    const entityId = await makeEntity(session); // no Collider on this entity

    const result = await session.execute<any>('setProperties', {
      scene: 'Main',
      entity: entityId,
      properties: {
        'Transform.position.x': 100,
        'Collider.width': 10,
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('NOT_FOUND');
    const entity = store.getScene('Main')!.entities.find((e) => e.id === entityId)!;
    expect(entity.components.Transform!.position.x).not.toBe(100);
  });

  it('rejects an empty properties object', async () => {
    const { session } = await makeSession();
    const entityId = await makeEntity(session);

    const result = await session.execute<any>('setProperties', {
      scene: 'Main',
      entity: entityId,
      properties: {},
    });

    expect(result.success).toBe(false);
  });

  it('conflict rule: keys are applied in Object.entries order onto the same clone, later wins on identical paths', async () => {
    const { session, store } = await makeSession();
    const entityId = await makeEntity(session);

    // "Transform.position" sets the whole object first; "Transform.position.x"
    // then overwrites just x on top of it — object key order preserves insertion order.
    const result = await session.execute<any>('setProperties', {
      scene: 'Main',
      entity: entityId,
      properties: {
        'Transform.position': { x: 5, y: 5 },
        'Transform.position.x': 999,
      },
    });

    expect(result.success).toBe(true);
    expect(result.data.components.Transform.position).toEqual({ x: 999, y: 5 });

    const entity = store.getScene('Main')!.entities.find((e) => e.id === entityId)!;
    expect(entity.components.Transform!.position).toEqual({ x: 999, y: 5 });
  });

  it('one setProperties call touching two components is undone by a single undo', async () => {
    const { session, store } = await makeSession();
    const entityId = await makeEntity(session);

    const result = await session.execute<any>('setProperties', {
      scene: 'Main',
      entity: entityId,
      properties: {
        'Transform.position.x': 111,
        'SpriteRenderer.width': 77,
      },
    });
    expect(result.success).toBe(true);

    // makeEntity's createEntity is its own history entry; setProperties adds exactly one more on top.
    const history = await session.execute<any>('listHistory');
    expect(history.data.entries.length).toBe(2);
    expect(history.data.entries[1].command).toBe('setProperties');

    // One undo must revert the whole batch (both components), not just one property.
    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(true);
    expect(undo.data.undone).toBe('setProperties');

    const entity = store.getScene('Main')!.entities.find((e) => e.id === entityId)!;
    expect(entity.components.Transform!.position.x).not.toBe(111);
    expect(entity.components.SpriteRenderer!.width).not.toBe(77);

    // The entity itself (created by the earlier, separate command) must still exist —
    // this single undo only reverted the setProperties batch.
    expect(store.getScene('Main')!.entities.some((e) => e.id === entityId)).toBe(true);
  });
});
