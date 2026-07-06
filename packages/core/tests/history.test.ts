import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession } from '@hearth/core';

async function makeSession(granted?: any) {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return {
    fs,
    session: HearthSession.fromStore(store, granted ? { granted } : {}),
    store,
  };
}

describe('undo/redo history', () => {
  it('undo reverts createEntity (in-memory model and the scene file on disk)', async () => {
    const { session, store, fs } = await makeSession();

    const create = await session.execute<any>('createEntity', { scene: 'Main', name: 'Enemy' });
    expect(create.success).toBe(true);
    expect(store.getScene('Main')!.entities.some((e) => e.name === 'Enemy')).toBe(true);

    const list = await session.execute<any>('listHistory');
    expect(list.data.entries.length).toBe(1);
    expect(list.data.entries[0].command).toBe('createEntity');
    expect(list.data.entries[0].summary).toContain('Enemy');

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(true);
    expect(undo.data.undone).toBe('createEntity');

    expect(store.getScene('Main')!.entities.some((e) => e.name === 'Enemy')).toBe(false);
    const raw = JSON.parse(await fs.readFile('/proj/scenes/main.scene.json'));
    expect(raw.entities.some((e: any) => e.name === 'Enemy')).toBe(false);
  });

  it('redo re-applies an undone mutation', async () => {
    const { session, store } = await makeSession();

    await session.execute('createEntity', { scene: 'Main', name: 'Enemy' });
    await session.execute('undo');
    expect(store.getScene('Main')!.entities.some((e) => e.name === 'Enemy')).toBe(false);

    const redo = await session.execute<any>('redo');
    expect(redo.success).toBe(true);
    expect(redo.data.redone).toBe('createEntity');
    expect(store.getScene('Main')!.entities.some((e) => e.name === 'Enemy')).toBe(true);
  });

  it('a new mutation after undo truncates the redo tail', async () => {
    const { session, store } = await makeSession();

    await session.execute('createEntity', { scene: 'Main', name: 'Enemy' });
    await session.execute('undo');
    await session.execute('createEntity', { scene: 'Main', name: 'Boss' });

    const redo = await session.execute('redo');
    expect(redo.success).toBe(false);
    expect(redo.errors[0].message).toContain('Nothing to redo');

    // The truncated ("Enemy") branch is gone; only "Boss" exists.
    expect(store.getScene('Main')!.entities.some((e) => e.name === 'Enemy')).toBe(false);
    expect(store.getScene('Main')!.entities.some((e) => e.name === 'Boss')).toBe(true);
  });

  it('undo/redo restore script files created by a mutating command', async () => {
    const { session, fs } = await makeSession();

    const created = await session.execute<any>('createScript', { name: 'Enemy AI' });
    expect(created.success).toBe(true);
    const path = `/proj/${created.data.path}`;
    expect(await fs.exists(path)).toBe(true);

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(true);
    expect(await fs.exists(path)).toBe(false);

    const redo = await session.execute<any>('redo');
    expect(redo.success).toBe(true);
    expect(await fs.exists(path)).toBe(true);
    expect(await fs.readFile(path)).toContain('onUpdate');
  });

  it('bounds history at 25 entries, pruning the oldest state files', async () => {
    const { session, fs } = await makeSession();

    for (let i = 0; i < 27; i++) {
      const result = await session.execute('createEntity', { scene: 'Main', name: `Entity${i}` });
      expect(result.success).toBe(true);
    }

    const list = await session.execute<any>('listHistory');
    expect(list.data.entries.length).toBe(25);
    expect(list.data.cursor).toBe(25);
    // Oldest two entries (seq 1 and 2) were pruned; their state files are gone.
    expect(await fs.exists('/proj/.hearth/history/state-1.json')).toBe(false);
    expect(await fs.exists('/proj/.hearth/history/state-2.json')).toBe(false);
    expect(await fs.exists('/proj/.hearth/history/state-3.json')).toBe(true);
  });

  it('does not record exempt commands (snapshotProject, undo itself)', async () => {
    const { session } = await makeSession();

    await session.execute('snapshotProject');
    const afterSnapshot = await session.execute<any>('listHistory');
    expect(afterSnapshot.data.entries.length).toBe(0);

    await session.execute('createEntity', { scene: 'Main', name: 'Enemy' });
    const afterCreate = await session.execute<any>('listHistory');
    expect(afterCreate.data.entries.length).toBe(1);

    // Calling undo must not itself become a new history entry.
    await session.execute('undo');
    const afterUndo = await session.execute<any>('listHistory');
    expect(afterUndo.data.entries.length).toBe(1);
  });

  it('listHistory marks undone entries after an undo', async () => {
    const { session } = await makeSession();

    await session.execute('createEntity', { scene: 'Main', name: 'Enemy' });
    await session.execute('undo');

    const list = await session.execute<any>('listHistory');
    expect(list.data.entries.length).toBe(1);
    expect(list.data.entries[0].undone).toBe(true);
    expect(list.data.cursor).toBe(0);
  });

  it('undo with empty history returns a friendly error result, not a throw', async () => {
    const { session } = await makeSession();
    const result = await session.execute('undo');
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toContain('Nothing to undo');
  });

  it('redo with nothing undone returns a friendly error result', async () => {
    const { session } = await makeSession();
    await session.execute('createEntity', { scene: 'Main', name: 'Enemy' });
    const result = await session.execute('redo');
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toContain('Nothing to redo');
  });
});
