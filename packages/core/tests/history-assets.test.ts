import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession } from '@hearth/core';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return {
    fs,
    session: HearthSession.fromStore(store),
    store,
  };
}

async function importPng(session: HearthSession, fs: MemoryFileSystem, name: string, sourcePath = '/tmp/sprite.png') {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
  await fs.writeFile(sourcePath, pngBytes);
  const result = await session.execute<any>('importAsset', {
    sourcePath,
    name,
    type: 'sprite',
  });
  expect(result.success).toBe(true);
  return result.data.asset as { id: string; path: string };
}

describe('binary asset trash', () => {
  it('deleteAsset (removeAsset deleteFile=true) moves the file to trash, not oblivion', async () => {
    const { session, fs } = await makeSession();
    const asset = await importPng(session, fs, 'Coin');
    const absPath = `/proj/${asset.path}`;
    expect(await fs.exists(absPath)).toBe(true);

    const rm = await session.execute<any>('removeAsset', { asset: asset.id, deleteFile: true });
    expect(rm.success).toBe(true);

    expect(await fs.exists(absPath)).toBe(false);
    const trashPath = `/proj/.hearth/trash/${asset.id}/sprite.png`;
    expect(await fs.exists(trashPath)).toBe(true);
  });

  it('undo of deleteAsset restores the binary at its original path', async () => {
    const { session, fs, store } = await makeSession();
    const asset = await importPng(session, fs, 'Coin');
    const absPath = `/proj/${asset.path}`;

    await session.execute('removeAsset', { asset: asset.id, deleteFile: true });
    expect(await fs.exists(absPath)).toBe(false);

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(true);

    expect(await fs.exists(absPath)).toBe(true);
    expect(store.getAsset(asset.id)).toBeTruthy();
    expect(await fs.exists(`/proj/.hearth/trash/${asset.id}`)).toBe(false);
  });

  it('redo of deleteAsset trashes it again', async () => {
    const { session, fs, store } = await makeSession();
    const asset = await importPng(session, fs, 'Coin');
    const absPath = `/proj/${asset.path}`;

    await session.execute('removeAsset', { asset: asset.id, deleteFile: true });
    await session.execute('undo');
    expect(await fs.exists(absPath)).toBe(true);

    const redo = await session.execute<any>('redo');
    expect(redo.success).toBe(true);

    expect(await fs.exists(absPath)).toBe(false);
    expect(store.getAsset(asset.id)).toBeFalsy();
    expect(await fs.exists(`/proj/.hearth/trash/${asset.id}/sprite.png`)).toBe(true);
  });

  it('undo of an import removes the file but stashes it; redo restores it', async () => {
    const { session, fs, store } = await makeSession();
    const asset = await importPng(session, fs, 'Coin');
    const absPath = `/proj/${asset.path}`;

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(true);
    expect(await fs.exists(absPath)).toBe(false);
    expect(store.getAsset(asset.id)).toBeFalsy();
    expect(await fs.exists(`/proj/.hearth/trash/${asset.id}/sprite.png`)).toBe(true);

    const redo = await session.execute<any>('redo');
    expect(redo.success).toBe(true);
    expect(await fs.exists(absPath)).toBe(true);
    expect(store.getAsset(asset.id)).toBeTruthy();
    expect(await fs.readFileBinary(absPath)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]));
  });

  it('trash is pruned once every history entry referencing it falls off the 25-entry bound', async () => {
    const { session, fs } = await makeSession();
    const asset = await importPng(session, fs, 'Coin');
    await session.execute('removeAsset', { asset: asset.id, deleteFile: true });

    expect(await fs.exists(`/proj/.hearth/trash/${asset.id}`)).toBe(true);

    // Push 25 more history entries so the import (seq 1) and remove (seq 2)
    // entries both fall off the 25-entry bound.
    for (let i = 0; i < 25; i++) {
      const result = await session.execute('createEntity', { scene: 'Main', name: `Entity${i}` });
      expect(result.success).toBe(true);
    }

    const list = await session.execute<any>('listHistory');
    expect(list.data.entries.length).toBe(25);
    expect(list.data.entries.some((e: any) => e.command === 'importAsset')).toBe(false);
    expect(list.data.entries.some((e: any) => e.command === 'removeAsset')).toBe(false);

    expect(await fs.exists(`/proj/.hearth/trash/${asset.id}`)).toBe(false);
  });

  it('redo of an unregister (deleteFile=false) trashes the file; undo restores it (pinned behavior)', async () => {
    // removeAsset({deleteFile:false}) never touches the file, but the
    // reconciliation pass in applySnapshot is a pure index diff: redoing the
    // unregister makes the asset "disappear" from the target snapshot, so the
    // still-present file is moved to trash to keep disk consistent with the
    // index. Accepted as documented behavior — round-trip-safe by design.
    const { session, fs, store } = await makeSession();
    const asset = await importPng(session, fs, 'Coin');
    const absPath = `/proj/${asset.path}`;

    const rm = await session.execute<any>('removeAsset', { asset: asset.id, deleteFile: false });
    expect(rm.success).toBe(true);
    expect(await fs.exists(absPath)).toBe(true); // deleteFile:false leaves the file alone

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(true);
    expect(store.getAsset(asset.id)).toBeTruthy();
    expect(await fs.exists(absPath)).toBe(true); // file was already in place; no move

    const redo = await session.execute<any>('redo');
    expect(redo.success).toBe(true);
    expect(store.getAsset(asset.id)).toBeFalsy();
    // The reconciliation trashed the file even though the forward command didn't.
    expect(await fs.exists(absPath)).toBe(false);
    expect(await fs.exists(`/proj/.hearth/trash/${asset.id}/sprite.png`)).toBe(true);

    const undo2 = await session.execute<any>('undo');
    expect(undo2.success).toBe(true);
    expect(await fs.exists(absPath)).toBe(true); // round-trip-safe: file comes back
    expect(store.getAsset(asset.id)).toBeTruthy();
  });

  it('a corrupted snapshot with an unsafe asset path cannot read or write outside the trash', async () => {
    const { session, fs } = await makeSession();
    await session.execute('createEntity', { scene: 'Main', name: 'Enemy' });

    // Hand-corrupt the recorded before-snapshot: a schema-valid asset id
    // (a traversal-crafted id would fail AssetIndexSchema validation
    // upfront and be rejected as HISTORY_CORRUPT before reaching this
    // reconciliation code — see history-corrupt.test.ts) paired with a path
    // that points outside the project root, which the schema doesn't
    // constrain.
    const statePath = '/proj/.hearth/history/state-1.json';
    const snapshot = JSON.parse(await fs.readFile(statePath));
    snapshot.assets.assets.push({
      id: 'ast_evil0traversal',
      name: 'evil',
      type: 'other',
      path: '../outside.bin',
      metadata: {},
    });
    await fs.writeFile(statePath, JSON.stringify(snapshot));

    // Undo restores that snapshot; the malicious asset "reappears".
    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(true);
    expect(undo.warnings.some((w: any) => w.code === 'ASSET_TRASH_UNSAFE')).toBe(true);
    // Nothing was written outside the project root.
    expect(await fs.exists('/outside.bin')).toBe(false);
    expect(await fs.exists('/etc')).toBe(false);

    // Now the malicious entry is in the live index; redoing makes it
    // "disappear", which without a guard would move a file from outside the
    // project into a traversal-crafted trash path. Plant a sentinel there.
    await fs.writeFile('/outside.bin', 'sentinel');
    const redo = await session.execute<any>('redo');
    expect(redo.success).toBe(true);
    expect(redo.warnings.some((w: any) => w.code === 'ASSET_TRASH_UNSAFE')).toBe(true);
    // The outside file was neither moved nor deleted.
    expect(await fs.readFile('/outside.bin')).toBe('sentinel');
    expect(await fs.exists('/etc')).toBe(false);
  });

  it('does not prune trash for an asset still present in the live project', async () => {
    const { session, fs, store } = await makeSession();
    const kept = await importPng(session, fs, 'Kept', '/tmp/kept.png');
    const trashed = await importPng(session, fs, 'Trashed', '/tmp/trashed.png');
    await session.execute('removeAsset', { asset: trashed.id, deleteFile: true });

    for (let i = 0; i < 25; i++) {
      await session.execute('createEntity', { scene: 'Main', name: `Entity${i}` });
    }

    // The kept asset is still live; its file must be untouched (never trashed).
    expect(store.getAsset(kept.id)).toBeTruthy();
    expect(await fs.exists(`/proj/${kept.path}`)).toBe(true);
    expect(await fs.exists(`/proj/.hearth/trash/${trashed.id}`)).toBe(false);
  });
});
