/**
 * A tampered/corrupted history snapshot (valid JSON, invalid shape — e.g. a
 * garbled asset entry) must fail undo/redo cleanly instead of getting applied
 * and bricking the project: every later command (including redo) reads the
 * project back through the same schemas and would otherwise throw forever.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession } from '@hearth/core';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return { fs, session: HearthSession.fromStore(store), store };
}

async function importPng(session: HearthSession, fs: MemoryFileSystem, name: string, sourcePath = '/tmp/sprite.png') {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
  await fs.writeFile(sourcePath, pngBytes);
  const result = await session.execute<any>('importAsset', { sourcePath, name, type: 'sprite' });
  expect(result.success).toBe(true);
  return result.data.asset as { id: string; path: string };
}

describe('a corrupted history snapshot fails undo/redo cleanly', () => {
  it('undo returns HISTORY_CORRUPT, leaves assets.json untouched, and the project keeps working', async () => {
    const { session, fs } = await makeSession();

    // A valid asset first, so the *next* mutation's "before" snapshot
    // carries a real asset entry we can tamper with.
    await importPng(session, fs, 'Coin');
    const createEntity = await session.execute<any>('createEntity', { scene: 'Main', name: 'Enemy' });
    expect(createEntity.success).toBe(true);

    const listBefore = await session.execute<any>('listHistory');
    const seq = listBefore.data.entries[listBefore.data.entries.length - 1].seq;
    const statePath = `/proj/.hearth/history/state-${seq}.json`;

    const raw = JSON.parse(await fs.readFile(statePath));
    // AssetSchema requires `type` to be one of ASSET_TYPES — corrupt it.
    raw.assets.assets[0].type = 'not-a-real-asset-type';
    await fs.writeFile(statePath, JSON.stringify(raw));

    const assetsJsonBefore = await fs.readFile('/proj/assets.json');

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(false);
    expect(undo.errors[0].code).toBe('HISTORY_CORRUPT');

    // Store untouched: assets.json on disk is exactly what it was before
    // the failed undo attempt.
    expect(await fs.readFile('/proj/assets.json')).toBe(assetsJsonBefore);

    // Cursor unmoved, no redo file written for this entry.
    const listAfter = await session.execute<any>('listHistory');
    expect(listAfter.data.cursor).toBe(listBefore.data.cursor);
    expect(listAfter.data.entries[listAfter.data.entries.length - 1].undone).toBe(false);
    expect(await fs.exists(`/proj/.hearth/history/redo-${seq}.json`)).toBe(false);

    // A subsequent command still works — the corrupt entry didn't brick
    // the project.
    const again = await session.execute<any>('createEntity', { scene: 'Main', name: 'Ally' });
    expect(again.success).toBe(true);

    // Undoing the (uncorrupted) later entry still works fine.
    const undoAgain = await session.execute<any>('undo');
    expect(undoAgain.success).toBe(true);
    expect(undoAgain.data.undone).toBe('createEntity');
  });

  it('a traversal-crafted asset id fails validation before it ever reaches trash reconciliation', async () => {
    // AssetSchema.id and isSafeTrashAssetId use the identical regex, so any
    // id that would be "unsafe" for trash purposes is also schema-invalid —
    // upfront validation now rejects it as HISTORY_CORRUPT, before
    // applySnapshot's reconcileAssetFiles ever sees it (see
    // history-assets.test.ts for the residual unsafe-*path* case, which the
    // schema doesn't constrain).
    const { session, fs } = await makeSession();
    await session.execute('createEntity', { scene: 'Main', name: 'Enemy' });

    const statePath = '/proj/.hearth/history/state-1.json';
    const snapshot = JSON.parse(await fs.readFile(statePath));
    snapshot.assets.assets.push({
      id: '../../../etc',
      name: 'evil',
      type: 'other',
      path: '../outside.bin',
      metadata: {},
    });
    await fs.writeFile(statePath, JSON.stringify(snapshot));

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(false);
    expect(undo.errors[0].code).toBe('HISTORY_CORRUPT');
    expect(await fs.exists('/outside.bin')).toBe(false);
    expect(await fs.exists('/etc')).toBe(false);
  });
});
