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

/**
 * I-1 (waveG final review): `validateComponentPath` accepts a segment if it's
 * valid on ANY member of a discriminated union, because the schema-only path
 * walker can't know which member is actually stored at a given array index.
 * That's necessary for the walker to work at all — but it means a field from
 * the WRONG variant (e.g. a crt-only field on a stored bloom element) passes
 * path validation, then Zod's safeParse silently strips it when resolving the
 * real discriminant, and the command still reports success + changed. These
 * tests pin the reviewer's live repro and its fix: a data-aware post-check
 * that reads the written path back out of the parsed result.
 */
describe('setComponentProperty / setProperties — cross-branch union write (I-1)', () => {
  async function makeCameraWithBloom(session: HearthSession) {
    const created = await session.execute<any>('createEntity', {
      scene: 'Main',
      name: 'Main Camera',
      components: {
        Camera: { postEffects: [{ type: 'bloom', strength: 1, threshold: 0.5 }] },
      },
    });
    expect(created.success).toBe(true);
    return created.data.entityId as string;
  }

  it('rejects a crt-only field written onto a stored bloom element instead of silently dropping it', async () => {
    const { session, store } = await makeSession();
    const entityId = await makeCameraWithBloom(session);

    const result = await session.execute<any>('setComponentProperty', {
      scene: 'Main',
      entity: entityId,
      property: 'Camera.postEffects.0.scanlineIntensity',
      value: 0.9,
    });

    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_INPUT');
    expect(result.errors[0].message).toContain('scanlineIntensity');
    expect(result.errors[0].message).toContain('bloom');
    expect(result.errors[0].message).toContain('postEffects.0');
    expect(result.errors[0].message).toContain('strength');
    expect(result.errors[0].message).toContain('threshold');

    // Critically: the bloom element must be untouched — no false-success, no history entry.
    const entity = store.getScene('Main')!.entities.find((e) => e.id === entityId)!;
    expect(entity.components.Camera!.postEffects[0]).toEqual({
      type: 'bloom',
      strength: 1,
      threshold: 0.5,
    });
  });

  it('same cross-branch rejection through setProperties (batch path)', async () => {
    const { session, store } = await makeSession();
    const entityId = await makeCameraWithBloom(session);

    const result = await session.execute<any>('setProperties', {
      scene: 'Main',
      entity: entityId,
      properties: { 'Camera.postEffects.0.scanlineIntensity': 0.9 },
    });

    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_INPUT');
    expect(result.errors[0].message).toContain('scanlineIntensity');
    expect(result.errors[0].message).toContain('bloom');

    const entity = store.getScene('Main')!.entities.find((e) => e.id === entityId)!;
    expect(entity.components.Camera!.postEffects[0]).toEqual({
      type: 'bloom',
      strength: 1,
      threshold: 0.5,
    });
  });

  it('a field on the CORRECT branch still works (not over-corrected)', async () => {
    const { session, store } = await makeSession();
    const entityId = await makeCameraWithBloom(session);

    const result = await session.execute<any>('setComponentProperty', {
      scene: 'Main',
      entity: entityId,
      property: 'Camera.postEffects.0.strength',
      value: 2,
    });

    expect(result.success).toBe(true);
    const entity = store.getScene('Main')!.entities.find((e) => e.id === entityId)!;
    expect(entity.components.Camera!.postEffects[0]).toEqual({
      type: 'bloom',
      strength: 2,
      threshold: 0.5,
    });
  });

  it('a name in NO branch is still rejected by the ordinary did-you-mean path (unaffected by this fix)', async () => {
    const { session } = await makeSession();
    const entityId = await makeCameraWithBloom(session);

    const result = await session.execute<any>('setComponentProperty', {
      scene: 'Main',
      entity: entityId,
      property: 'Camera.postEffects.0.zzzzzzzzzz',
      value: 1,
    });

    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_INPUT');
  });

  it('whole-array wholesale write of postEffects still works (editor UI path)', async () => {
    const { session, store } = await makeSession();
    const entityId = await makeCameraWithBloom(session);

    const result = await session.execute<any>('setComponentProperty', {
      scene: 'Main',
      entity: entityId,
      property: 'Camera.postEffects',
      value: [{ type: 'crt' }],
    });

    expect(result.success).toBe(true);
    const entity = store.getScene('Main')!.entities.find((e) => e.id === entityId)!;
    expect(entity.components.Camera!.postEffects[0]).toEqual({
      type: 'crt',
      curvature: 0.15,
      scanlineIntensity: 0.25,
      noise: 0,
    });
  });

  it('setProperties with a mix of a valid Camera field and a cross-branch field rejects the whole batch (all-or-nothing)', async () => {
    const { session, store } = await makeSession();
    const entityId = await makeCameraWithBloom(session);

    const result = await session.execute<any>('setProperties', {
      scene: 'Main',
      entity: entityId,
      properties: {
        'Camera.zoom': 2,
        'Camera.postEffects.0.scanlineIntensity': 0.9,
      },
    });

    expect(result.success).toBe(false);
    const entity = store.getScene('Main')!.entities.find((e) => e.id === entityId)!;
    expect(entity.components.Camera!.zoom).toBe(1);
    expect(entity.components.Camera!.postEffects[0]).toEqual({
      type: 'bloom',
      strength: 1,
      threshold: 0.5,
    });
  });

  it('record keys (Script.params.*) still resolve and are unaffected by the resolves-check', async () => {
    const { session, store } = await makeSession();
    const created = await session.execute<any>('createEntity', {
      scene: 'Main',
      name: 'Scripted',
      components: { Script: { scriptPath: 'scripts/x.js' } },
    });
    const entityId = created.data.entityId as string;

    const result = await session.execute<any>('setComponentProperty', {
      scene: 'Main',
      entity: entityId,
      property: 'Script.params.speed',
      value: 42,
    });

    expect(result.success).toBe(true);
    const entity = store.getScene('Main')!.entities.find((e) => e.id === entityId)!;
    expect((entity.components.Script as any).params.speed).toBe(42);
  });
});
