/**
 * Cross-session regressions for whole-model restore (applySnapshot, shared by
 * undo/redo and revertProject): undoing a create must not just update the
 * in-memory model, it must remove the file(s) that command wrote — otherwise
 * a fresh session loading the same project on disk resurrects the "undone"
 * playtest/scene (ProjectStore.load slurps every *.playtest.json it finds,
 * and ties scenes to whatever hearth.json references — but orphaned files
 * left behind by a sloppy restore can still shadow a later same-name create).
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession } from '@hearth/core';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return { fs, session: HearthSession.fromStore(store), store };
}

describe('undo of createPlaytest removes the on-disk playtest file, cross-session', () => {
  it('does not resurrect the playtest in a fresh session after undo', async () => {
    const { fs, session } = await makeSession();

    const created = await session.execute<any>('createPlaytest', {
      name: 'Smoke Test',
      scene: 'Main',
    });
    expect(created.success).toBe(true);

    const playtestPath = '/proj/playtests/smoke_test.playtest.json';
    expect(await fs.exists(playtestPath)).toBe(true);

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(true);

    // In-memory: gone from the same session's store.
    expect(session.store.getPlaytest('Smoke Test')).toBeUndefined();

    // The load-bearing assertion: the file itself must be gone too, or a
    // brand-new session loading the same project resurrects it.
    expect(await fs.exists(playtestPath)).toBe(false);

    // Cross-session: a fresh ProjectStore.load over the same fs must not
    // see the "undone" playtest.
    const fresh = await HearthSession.open(fs, '/proj');
    expect(fresh.store.getPlaytest('Smoke Test')).toBeUndefined();
    expect([...fresh.store.playtests.values()]).toEqual([]);
  });

  it('redo restores the playtest file so a fresh session sees it again', async () => {
    const { fs, session } = await makeSession();
    await session.execute('createPlaytest', { name: 'Smoke Test', scene: 'Main' });
    await session.execute('undo');
    const redo = await session.execute<any>('redo');
    expect(redo.success).toBe(true);

    const playtestPath = '/proj/playtests/smoke_test.playtest.json';
    expect(await fs.exists(playtestPath)).toBe(true);

    const fresh = await HearthSession.open(fs, '/proj');
    expect(fresh.store.getPlaytest('Smoke Test')).toBeTruthy();
  });

  it('revertProject also removes the stale playtest file', async () => {
    const { fs, session } = await makeSession();
    await session.execute('snapshotProject');
    await session.execute('createPlaytest', { name: 'Smoke Test', scene: 'Main' });

    const playtestPath = '/proj/playtests/smoke_test.playtest.json';
    expect(await fs.exists(playtestPath)).toBe(true);

    const revert = await session.execute<any>('revertProject', { confirm: true });
    expect(revert.success).toBe(true);
    expect(await fs.exists(playtestPath)).toBe(false);

    const fresh = await HearthSession.open(fs, '/proj');
    expect(fresh.store.getPlaytest('Smoke Test')).toBeUndefined();
  });
});

describe('undo of createScene removes the orphan scene file, cross-session', () => {
  it('the orphan scene file is gone from disk, not just the in-memory model', async () => {
    const { fs, session } = await makeSession();

    const created = await session.execute<any>('createScene', { name: 'Level 1' });
    expect(created.success).toBe(true);
    const scenePath = '/proj/scenes/level_1.scene.json';
    expect(await fs.exists(scenePath)).toBe(true);

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(true);
    expect(await fs.exists(scenePath)).toBe(false);

    // Cross-session: a fresh load must not see it either (ProjectStore.load
    // only loads scenes hearth.json references, but the file itself must
    // not linger to shadow a later same-name create).
    const fresh = await HearthSession.open(fs, '/proj');
    expect(fresh.store.getScene('Level 1')).toBeUndefined();

    // Recreating "Level 1" must not collide with the (now-removed) orphan.
    const recreated = await fresh.execute<any>('createScene', { name: 'Level 1', withCamera: false });
    expect(recreated.success).toBe(true);
    expect(fresh.store.getScene('Level 1')!.entities).toEqual([]);
  });
});
