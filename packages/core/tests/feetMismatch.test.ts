/**
 * SPRITE_COLLIDER_FEET_MISMATCH validation: the "floating player" disconnect.
 * Sprites are center-anchored and colliders are centered + offset, so when a
 * dynamic body's collider bottom edge differs from its sprite bottom edge,
 * physics rests the collider on the ground while the art visibly floats above
 * it (or sinks into it). Feet alignment is the near-universal intent in both
 * platformers and top-down games — a mismatch is almost always an authoring
 * mistake, so validate names it and gives the exact offset.y that fixes it.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession, type ProjectStore } from '@hearth/core';
import { validateProject } from '../src/validate.js';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  const session = HearthSession.fromStore(store, {});
  return { session, store };
}

async function addEntity(session: HearthSession, store: ProjectStore, components: Record<string, unknown>, name = 'Hero') {
  const res = await session.execute('createEntity', {
    scene: store.project.initialScene as string,
    name,
    components,
  });
  expect(res.success).toBe(true);
}

async function feetIssues(store: ProjectStore) {
  const report = await validateProject(store);
  return [...report.errors, ...report.warnings].filter((i) => i.code === 'SPRITE_COLLIDER_FEET_MISMATCH');
}

describe('SPRITE_COLLIDER_FEET_MISMATCH', () => {
  it('warns when a dynamic body\'s box collider bottom sits above the sprite bottom (art sinks into ground)', async () => {
    const { session, store } = await makeSession();
    await addEntity(session, store, {
      SpriteRenderer: { width: 32, height: 32 },
      Collider: { shape: 'box', width: 32, height: 24 }, // bottom 4px above sprite's
      PhysicsBody: { bodyType: 'dynamic' },
    });
    const issues = await feetIssues(store);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toMatch(/offset\.y/); // must hand the agent the fix
  });

  it('stays quiet when offset.y aligns the bottoms (the intended smaller-hitbox pattern)', async () => {
    const { session, store } = await makeSession();
    await addEntity(session, store, {
      SpriteRenderer: { width: 32, height: 32 },
      Collider: { shape: 'box', width: 24, height: 24, offset: { x: 0, y: 4 } }, // 16 == 12+4
      PhysicsBody: { bodyType: 'dynamic' },
    });
    expect((await feetIssues(store)).length).toBe(0);
  });

  it('checks circle colliders against radius + offset', async () => {
    const { session, store } = await makeSession();
    await addEntity(session, store, {
      SpriteRenderer: { width: 32, height: 32 },
      Collider: { shape: 'circle', radius: 12 }, // bottom at 12 vs sprite 16
      PhysicsBody: { bodyType: 'dynamic' },
    });
    expect((await feetIssues(store)).length).toBe(1);
    // Aligned: offset.y = 4 puts circle bottom at 16.
    await addEntity(
      session,
      store,
      {
        SpriteRenderer: { width: 32, height: 32 },
        Collider: { shape: 'circle', radius: 12, offset: { x: 0, y: 4 } },
        PhysicsBody: { bodyType: 'dynamic' },
      },
      'HeroAligned',
    );
    expect((await feetIssues(store)).length).toBe(1); // still just the first entity
  });

  it('tolerates a 1-2px deliberate settle (hides contact flicker) without warning', async () => {
    const { session, store } = await makeSession();
    await addEntity(session, store, {
      SpriteRenderer: { width: 32, height: 32 },
      Collider: { shape: 'box', width: 32, height: 28 }, // bottom 2px above sprite's — within tolerance
      PhysicsBody: { bodyType: 'dynamic' },
    });
    expect((await feetIssues(store)).length).toBe(0);
  });

  it('ignores static bodies, triggers, and entities without all three components', async () => {
    const { session, store } = await makeSession();
    // Static scenery: doesn't rest on anything.
    await addEntity(
      session,
      store,
      {
        SpriteRenderer: { width: 64, height: 16 },
        Collider: { shape: 'box', width: 64, height: 12 },
        PhysicsBody: { bodyType: 'static' },
      },
      'Ground',
    );
    // Trigger zone: no contact resolution at all.
    await addEntity(
      session,
      store,
      {
        SpriteRenderer: { width: 32, height: 32 },
        Collider: { shape: 'box', width: 32, height: 16, isTrigger: true },
        PhysicsBody: { bodyType: 'dynamic' },
      },
      'PickupZone',
    );
    // Collider-only (no sprite): nothing visual to misalign.
    await addEntity(
      session,
      store,
      { Collider: { shape: 'box', width: 32, height: 24 }, PhysicsBody: { bodyType: 'dynamic' } },
      'InvisibleBody',
    );
    expect((await feetIssues(store)).length).toBe(0);
  });
});
