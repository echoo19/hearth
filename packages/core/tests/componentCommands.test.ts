import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession } from '@hearth/core';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  const session = HearthSession.fromStore(store, {});
  return { fs, session, store };
}

async function makeEntity(session: HearthSession, scene = 'Main') {
  const created = await session.execute<any>('createEntity', { scene, name: 'Coin' });
  expect(created.success).toBe(true);
  return created.data.entityId as string;
}

describe('setComponentProperty — strict path validation', () => {
  it('RED: a typo\'d path used to silently "succeed" by writing to a throwaway key; now it is rejected', async () => {
    const { session, store } = await makeSession();
    const entityId = await makeEntity(session);

    const result = await session.execute<any>('setComponentProperty', {
      scene: 'Main',
      entity: entityId,
      property: 'Transform.postiion.x',
      value: 100,
    });

    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_INPUT');
    expect(result.errors[0].message).toContain('postiion');
    expect(result.errors[0].message).toContain('position'); // did-you-mean suggestion

    // And critically: nothing was written under a throwaway "postiion" key.
    const entity = store.getScene('Main')!.entities.find((e) => e.id === entityId)!;
    expect((entity.components.Transform as any).postiion).toBeUndefined();
    expect(entity.components.Transform!.position).toEqual({ x: 0, y: 0 });
  });

  it('accepts a valid nested path', async () => {
    const { session, store } = await makeSession();
    const entityId = await makeEntity(session);

    const result = await session.execute<any>('setComponentProperty', {
      scene: 'Main',
      entity: entityId,
      property: 'Transform.position.x',
      value: 250,
    });

    expect(result.success).toBe(true);
    const entity = store.getScene('Main')!.entities.find((e) => e.id === entityId)!;
    expect(entity.components.Transform!.position.x).toBe(250);
  });

  it('rejects an unknown leaf field with no suggestion when nothing is close', async () => {
    const { session } = await makeSession();
    const entityId = await makeEntity(session);

    const result = await session.execute<any>('setComponentProperty', {
      scene: 'Main',
      entity: entityId,
      property: 'Transform.zzzzzzzzzz',
      value: 1,
    });

    expect(result.success).toBe(false);
    expect(result.errors[0].message).not.toContain('Did you mean');
  });

  it('allows setting a whole nested object wholesale', async () => {
    const { session, store } = await makeSession();
    const entityId = await makeEntity(session);

    const result = await session.execute<any>('setComponentProperty', {
      scene: 'Main',
      entity: entityId,
      property: 'Transform.position',
      value: { x: 9, y: 9 },
    });

    expect(result.success).toBe(true);
    const entity = store.getScene('Main')!.entities.find((e) => e.id === entityId)!;
    expect(entity.components.Transform!.position).toEqual({ x: 9, y: 9 });
  });
});
