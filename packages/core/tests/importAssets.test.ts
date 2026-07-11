/**
 * importAssets: bulk import of multiple external files in one atomic
 * command — one journal entry, one undo/redo step, per-file skip reporting,
 * and collision-safe auto-naming. See task-10-brief.md.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession } from '@hearth/core';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return { fs, session: HearthSession.fromStore(store), store };
}

describe('importAssets (bulk)', () => {
  let fs: MemoryFileSystem;
  let session: HearthSession;

  beforeEach(async () => {
    ({ fs, session } = await makeSession());
  });

  it('imports multiple files, registers all, and produces exactly one journal entry', async () => {
    await fs.writeFile('/tmp/coin.png', PNG_BYTES);
    await fs.writeFile('/tmp/jump.wav', PNG_BYTES);

    const result = await session.execute<any>('importAssets', {
      sourcePaths: ['/tmp/coin.png', '/tmp/jump.wav'],
    });
    expect(result.success).toBe(true);
    expect(result.data.imported).toHaveLength(2);
    expect(result.data.skipped).toHaveLength(0);

    const coin = result.data.imported.find((i: any) => i.path === '/tmp/coin.png');
    const jump = result.data.imported.find((i: any) => i.path === '/tmp/jump.wav');
    expect(coin).toMatchObject({ name: 'coin', type: 'sprite' });
    expect(jump).toMatchObject({ name: 'jump', type: 'audio' });
    expect(typeof coin.assetId).toBe('string');
    expect(typeof jump.assetId).toBe('string');

    expect(await fs.exists('/proj/assets/sprites/coin.png')).toBe(true);
    expect(await fs.exists('/proj/assets/audio/jump.wav')).toBe(true);

    const journal = await session.execute<any>('listJournal');
    expect(journal.data.entries).toHaveLength(1);
    expect(journal.data.entries[0].command).toBe('importAssets');
    expect(journal.data.entries[0].detail).toEqual({ count: 2, types: ['sprite', 'audio'] });

    const history = await session.execute<any>('listHistory');
    expect(history.data.entries).toHaveLength(1);
    expect(history.data.entries[0].command).toBe('importAssets');
  });

  it('undo removes all imported files and index entries in one step; redo restores them', async () => {
    await fs.writeFile('/tmp/coin.png', PNG_BYTES);
    await fs.writeFile('/tmp/jump.wav', PNG_BYTES);

    const result = await session.execute<any>('importAssets', {
      sourcePaths: ['/tmp/coin.png', '/tmp/jump.wav'],
    });
    expect(result.success).toBe(true);

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(true);
    expect(await fs.exists('/proj/assets/sprites/coin.png')).toBe(false);
    expect(await fs.exists('/proj/assets/audio/jump.wav')).toBe(false);
    const inspectAfterUndo = await session.execute<any>('inspectAssets');
    expect(inspectAfterUndo.data.assets).toHaveLength(0);

    const redo = await session.execute<any>('redo');
    expect(redo.success).toBe(true);
    expect(await fs.exists('/proj/assets/sprites/coin.png')).toBe(true);
    expect(await fs.exists('/proj/assets/audio/jump.wav')).toBe(true);
    const inspectAfterRedo = await session.execute<any>('inspectAssets');
    expect(inspectAfterRedo.data.assets).toHaveLength(2);
  });

  it('skips a missing source file with a NOT_FOUND-style code, importing the rest', async () => {
    await fs.writeFile('/tmp/coin.png', PNG_BYTES);

    const result = await session.execute<any>('importAssets', {
      sourcePaths: ['/tmp/coin.png', '/tmp/does-not-exist.png'],
    });
    expect(result.success).toBe(true);
    expect(result.data.imported).toHaveLength(1);
    expect(result.data.skipped).toHaveLength(1);
    expect(result.data.skipped[0]).toMatchObject({ path: '/tmp/does-not-exist.png' });
    expect(typeof result.data.skipped[0].code).toBe('string');
    expect(result.data.skipped[0].code.length).toBeGreaterThan(0);
    expect(typeof result.data.skipped[0].message).toBe('string');
  });

  it('skips a file with an unknown extension when no type override is given', async () => {
    await fs.writeFile('/tmp/coin.png', PNG_BYTES);
    await fs.writeFile('/tmp/notes.xyz', PNG_BYTES);

    const result = await session.execute<any>('importAssets', {
      sourcePaths: ['/tmp/coin.png', '/tmp/notes.xyz'],
    });
    expect(result.success).toBe(true);
    expect(result.data.imported).toHaveLength(1);
    expect(result.data.skipped).toHaveLength(1);
    expect(result.data.skipped[0].path).toBe('/tmp/notes.xyz');
    expect(result.data.skipped[0].code).toBe('UNKNOWN_TYPE');
  });

  it('a type override applies to every file, including ones with otherwise-unknown extensions', async () => {
    await fs.writeFile('/tmp/coin.png', PNG_BYTES);
    await fs.writeFile('/tmp/notes.xyz', PNG_BYTES);

    const result = await session.execute<any>('importAssets', {
      sourcePaths: ['/tmp/coin.png', '/tmp/notes.xyz'],
      type: 'other',
    });
    expect(result.success).toBe(true);
    expect(result.data.imported).toHaveLength(2);
    expect(result.data.skipped).toHaveLength(0);
    expect(result.data.imported.every((i: any) => i.type === 'other')).toBe(true);
  });

  it('auto-suffixes colliding names (-2, -3...) and reports the final names in the result', async () => {
    await fs.writeFile('/tmp/a/coin.png', PNG_BYTES);
    await fs.writeFile('/tmp/b/coin.png', PNG_BYTES);
    await fs.writeFile('/tmp/c/coin.png', PNG_BYTES);

    const result = await session.execute<any>('importAssets', {
      sourcePaths: ['/tmp/a/coin.png', '/tmp/b/coin.png', '/tmp/c/coin.png'],
    });
    expect(result.success).toBe(true);
    expect(result.data.imported).toHaveLength(3);
    const names = result.data.imported.map((i: any) => i.name).sort();
    expect(names).toEqual(['coin', 'coin-2', 'coin-3']);

    // Every imported file lands at a distinct, existing path.
    for (const item of result.data.imported) {
      const asset = await session.execute<any>('inspectAssets');
      const found = asset.data.assets.find((a: any) => a.id === item.assetId);
      expect(found).toBeDefined();
      expect(await fs.exists(`/proj/${found.path}`)).toBe(true);
    }
  });

  it('auto-suffixes against a pre-existing asset name from an earlier import', async () => {
    await fs.writeFile('/tmp/coin.png', PNG_BYTES);
    const first = await session.execute<any>('importAsset', { sourcePath: '/tmp/coin.png', type: 'sprite' });
    expect(first.success).toBe(true);

    await fs.writeFile('/tmp/other/coin.png', PNG_BYTES);
    const result = await session.execute<any>('importAssets', {
      sourcePaths: ['/tmp/other/coin.png'],
    });
    expect(result.success).toBe(true);
    expect(result.data.imported[0].name).toBe('coin-2');
  });

  it('validates every path up front: a batch with a bad path in the middle still imports the good ones around it', async () => {
    await fs.writeFile('/tmp/a.png', PNG_BYTES);
    await fs.writeFile('/tmp/c.png', PNG_BYTES);

    const result = await session.execute<any>('importAssets', {
      sourcePaths: ['/tmp/a.png', '/tmp/missing.png', '/tmp/c.png'],
    });
    expect(result.success).toBe(true);
    expect(result.data.imported.map((i: any) => i.path).sort()).toEqual(['/tmp/a.png', '/tmp/c.png']);
    expect(result.data.skipped).toHaveLength(1);
    expect(result.data.skipped[0].path).toBe('/tmp/missing.png');
  });

  it('rejects an empty sourcePaths array', async () => {
    const result = await session.execute<any>('importAssets', { sourcePaths: [] });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_PARAMS');
  });

  it('requires the asset-edit permission', async () => {
    const restricted = HearthSession.fromStore(session.store, { granted: ['read-only'] });
    await fs.writeFile('/tmp/coin.png', PNG_BYTES);
    const result = await restricted.execute<any>('importAssets', { sourcePaths: ['/tmp/coin.png'] });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('PERMISSION_DENIED');
  });

  it('a directory passed as a sourcePath is skipped, not copied', async () => {
    await fs.mkdir('/tmp/somedir');
    await fs.writeFile('/tmp/ok.png', PNG_BYTES);

    const result = await session.execute<any>('importAssets', {
      sourcePaths: ['/tmp/somedir', '/tmp/ok.png'],
    });
    expect(result.success).toBe(true);
    expect(result.data.imported).toHaveLength(1);
    expect(result.data.skipped).toHaveLength(1);
    expect(result.data.skipped[0].path).toBe('/tmp/somedir');
  });
});
