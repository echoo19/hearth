/**
 * L-011: renameEntity had no uniqueness guard, so renaming one entity to
 * another's name produced two identically-named rows — ambiguous for any
 * name-based command reference. Rename now auto-suffixes to stay addressable,
 * the same invariant the create/instantiate paths already hold.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession } from '@hearth/core';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return { fs, session: HearthSession.fromStore(store, {}), store };
}

describe('renameEntity uniqueness (L-011)', () => {
  it('auto-suffixes a rename that would collide with another entity', async () => {
    const { session } = await makeSession();
    await session.execute('createScene', { name: 'Main' });
    const a = await session.execute<any>('createEntity', { scene: 'Main', name: 'Hint' });
    await session.execute('createEntity', { scene: 'Main', name: 'Player' });
    const r = await session.execute<any>('renameEntity', {
      scene: 'Main',
      entity: a.data.entityId,
      newName: 'Player',
    });
    expect(r.success).toBe(true);
    expect(r.data.name).toBe('Player 2');
  });

  it("renaming to the entity's own current name is unchanged", async () => {
    const { session } = await makeSession();
    await session.execute('createScene', { name: 'Main' });
    const a = await session.execute<any>('createEntity', { scene: 'Main', name: 'Coin' });
    const r = await session.execute<any>('renameEntity', {
      scene: 'Main',
      entity: a.data.entityId,
      newName: 'Coin',
    });
    expect(r.success).toBe(true);
    expect(r.data.name).toBe('Coin');
  });

  it('renaming to a free name keeps it as-is', async () => {
    const { session } = await makeSession();
    await session.execute('createScene', { name: 'Main' });
    const a = await session.execute<any>('createEntity', { scene: 'Main', name: 'Coin' });
    const r = await session.execute<any>('renameEntity', {
      scene: 'Main',
      entity: a.data.entityId,
      newName: 'Gem',
    });
    expect(r.success).toBe(true);
    expect(r.data.name).toBe('Gem');
  });
});
