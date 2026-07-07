import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession } from '@hearth/core';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return { fs, session: HearthSession.fromStore(store), store };
}

describe('duplicateScene', () => {
  it('defaults withPlaytests to false and clones no playtests', async () => {
    const { session } = await makeSession();
    await session.execute('createPlaytest', { name: 'smoke', scene: 'Main', steps: [] });
    const dup = await session.execute<any>('duplicateScene', { scene: 'Main', newName: 'Main Copy' });
    expect(dup.success).toBe(true);
    expect(dup.data.playtestsCloned).toBe(0);
    const list = await session.execute<any>('listPlaytests');
    expect(list.data.playtests.length).toBe(1);
  });

  it('clones playtests targeting the source scene, remapping id-based entity/scene refs but not name-based ones', async () => {
    const { session, store } = await makeSession();
    const player = store.getScene('Main')!.entities.find((e) => e.name === 'Player')!;
    await session.execute('createPlaytest', {
      name: 'smoke',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 10 },
        { type: 'assertEntityExists', entity: player.id, exists: true },
        { type: 'assertEntityExists', entity: 'Player', exists: true }, // name ref: must stay untouched
        { type: 'assertScene', scene: 'Main' }, // name ref: must stay untouched (source scene has a new name)
      ],
    });
    const dup = await session.execute<any>('duplicateScene', {
      scene: 'Main',
      newName: 'Main Copy',
      withPlaytests: true,
    });
    expect(dup.success).toBe(true);
    expect(dup.data.playtestsCloned).toBe(1);

    const list = await session.execute<any>('listPlaytests');
    expect(list.data.playtests.length).toBe(2);
    const cloned = [...store.playtests.values()].find((p) => p.name === 'smoke (Main Copy)')!;
    expect(cloned).toBeDefined();
    expect(cloned.scene).toBe(dup.data.sceneId);

    const newPlayerId = store.getScene('Main Copy')!.entities.find((e) => e.name === 'Player')!.id;
    const idStep = cloned.steps.find((s: any) => s.type === 'assertEntityExists' && s.entity !== 'Player') as any;
    expect(idStep.entity).toBe(newPlayerId);
    expect(idStep.entity).not.toBe(player.id);

    const nameStep = cloned.steps.find((s: any) => s.type === 'assertEntityExists' && s.entity === 'Player') as any;
    expect(nameStep).toBeDefined(); // name ref untouched

    const sceneStep = cloned.steps.find((s: any) => s.type === 'assertScene') as any;
    // The original assertScene value was the name 'Main', not the source
    // scene's id, so it must be left untouched even though it "means" the
    // source scene semantically.
    expect(sceneStep.scene).toBe('Main');
  });

  it('remaps an id-based assertScene ref to the new scene id', async () => {
    const { session, store } = await makeSession();
    const sourceScene = store.getScene('Main')!;
    await session.execute('createPlaytest', {
      name: 'smoke',
      scene: 'Main',
      steps: [{ type: 'assertScene', scene: sourceScene.id }],
    });
    const dup = await session.execute<any>('duplicateScene', {
      scene: 'Main',
      newName: 'Main Copy',
      withPlaytests: true,
    });
    const cloned = [...store.playtests.values()].find((p) => p.name === 'smoke (Main Copy)')!;
    const sceneStep = cloned.steps.find((s: any) => s.type === 'assertScene') as any;
    expect(sceneStep.scene).toBe(dup.data.sceneId);
  });

  it('suffixes cloned playtest names on collision', async () => {
    const { session, store } = await makeSession();
    await session.execute('createPlaytest', { name: 'smoke', scene: 'Main', steps: [] });
    await session.execute('createPlaytest', { name: 'smoke (Main Copy)', scene: 'Main', steps: [] });
    const dup = await session.execute<any>('duplicateScene', {
      scene: 'Main',
      newName: 'Main Copy',
      withPlaytests: true,
    });
    expect(dup.success).toBe(true);
    // Two source playtests target Main: 'smoke' and 'smoke (Main Copy)'.
    // Both get cloned; 'smoke' collides with the pre-existing
    // 'smoke (Main Copy)' name and must be suffixed.
    expect(dup.data.playtestsCloned).toBe(2);
    const names = [...store.playtests.values()].map((p) => p.name).sort();
    expect(names).toContain('smoke (Main Copy) 2');
  });

  it('does not clone playtests targeting a different scene', async () => {
    const { session, store } = await makeSession();
    await session.execute('createScene', { name: 'Other', withCamera: false });
    await session.execute('createPlaytest', { name: 'other-smoke', scene: 'Other', steps: [] });
    const dup = await session.execute<any>('duplicateScene', {
      scene: 'Main',
      newName: 'Main Copy',
      withPlaytests: true,
    });
    expect(dup.data.playtestsCloned).toBe(0);
    expect(store.playtests.size).toBe(1);
  });
});

describe('renameScene collision guard', () => {
  it('rejects renaming to a name already used by a different scene', async () => {
    const { session } = await makeSession();
    await session.execute('createScene', { name: 'Level 2', withCamera: false });
    const result = await session.execute('renameScene', { scene: 'Level 2', newName: 'Main' });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('SCENE_NAME_TAKEN');
  });

  it('rejects case-insensitive collisions', async () => {
    const { session } = await makeSession();
    await session.execute('createScene', { name: 'Level 2', withCamera: false });
    const result = await session.execute('renameScene', { scene: 'Level 2', newName: 'main' });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('SCENE_NAME_TAKEN');
  });

  it('allows renaming a scene to its own name with only a case change', async () => {
    const { session, store } = await makeSession();
    const result = await session.execute<any>('renameScene', { scene: 'Main', newName: 'MAIN' });
    expect(result.success).toBe(true);
    expect(store.getScene('MAIN')?.name).toBe('MAIN');
  });
});
