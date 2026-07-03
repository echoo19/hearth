import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession } from '@hearth/core';

async function sessionWithPolygon(points: { x: number; y: number }[]) {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Poly Game' });
  const session = HearthSession.fromStore(store);
  const created = await session.execute<any>('createEntity', { scene: 'Main', name: 'Shape' });
  expect(created.success).toBe(true);
  const added = await session.execute('addComponent', {
    scene: 'Main',
    entity: 'Shape',
    type: 'Collider',
    properties: { shape: 'polygon', points },
  });
  expect(added.success).toBe(true);
  return session;
}

async function polygonErrors(points: { x: number; y: number }[]) {
  const session = await sessionWithPolygon(points);
  const result = await session.execute<any>('validateProject');
  expect(result.success).toBe(true);
  return result.data.errors as { code: string; message: string }[];
}

describe('polygon collider validation', () => {
  it('accepts a convex polygon (CCW winding)', async () => {
    const errors = await polygonErrors([
      { x: 0, y: -16 },
      { x: 16, y: 16 },
      { x: -16, y: 16 },
    ]);
    expect(errors).toEqual([]);
  });

  it('accepts the opposite (CW) winding too', async () => {
    const errors = await polygonErrors([
      { x: -16, y: 16 },
      { x: 16, y: 16 },
      { x: 0, y: -16 },
    ]);
    expect(errors).toEqual([]);
  });

  it('errors on fewer than 3 points', async () => {
    const errors = await polygonErrors([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    expect(errors.some((e) => e.code === 'POLYGON_TOO_FEW_POINTS')).toBe(true);
  });

  it('errors on duplicate consecutive points', async () => {
    const errors = await polygonErrors([
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 0 },
      { x: 0, y: 40 },
    ]);
    expect(errors.some((e) => e.code === 'POLYGON_DUPLICATE_POINT')).toBe(true);
  });

  it('errors on a closing duplicate (last point repeats the first)', async () => {
    const errors = await polygonErrors([
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 0, y: 40 },
      { x: 0, y: 0 },
    ]);
    expect(errors.some((e) => e.code === 'POLYGON_DUPLICATE_POINT')).toBe(true);
  });

  it('errors on a non-convex polygon and tells the agent to split it', async () => {
    const errors = await polygonErrors([
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 40 },
      { x: 20, y: 10 }, // dents inward
    ]);
    const err = errors.find((e) => e.code === 'POLYGON_NOT_CONVEX');
    expect(err).toBeDefined();
    expect(err!.message).toContain('split concave shapes into multiple entities');
  });

  it('does not apply polygon checks to box/circle colliders', async () => {
    const fs = new MemoryFileSystem();
    const { store } = await createProject(fs, '/proj', { name: 'Box Game' });
    const session = HearthSession.fromStore(store);
    await session.execute('createEntity', { scene: 'Main', name: 'Box' });
    await session.execute('addComponent', {
      scene: 'Main',
      entity: 'Box',
      type: 'Collider',
      properties: { shape: 'box', points: [] }, // empty points is fine for a box
    });
    const result = await session.execute<any>('validateProject');
    expect(result.data.errors).toEqual([]);
  });
});
