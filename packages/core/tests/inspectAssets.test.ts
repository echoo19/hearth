import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession } from '@hearth/core';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return { fs, session: HearthSession.fromStore(store, {}), store };
}

describe('inspectAssets prefab summary', () => {
  it('extends prefab entries with entityCount and rootComponents', async () => {
    const { session, store } = await makeSession();
    const sceneId = store.project.initialScene!;
    const player = store.getScene(sceneId)!.entities.find((e) => e.name === 'Player')!;

    const created = await session.execute<any>('createPrefab', { scene: sceneId, entity: player.id, name: 'PlayerPrefab' });
    expect(created.success).toBe(true);
    const assetId = created.data.asset.id as string;

    const result = await session.execute<any>('inspectAssets', { type: 'prefab' });
    expect(result.success).toBe(true);
    const entry = result.data.assets.find((a: any) => a.id === assetId);
    expect(entry).toBeTruthy();
    expect(entry.prefab).toEqual({
      entityCount: 1,
      rootComponents: expect.arrayContaining(Object.keys(player.components)),
    });
    expect(entry.prefab.rootComponents).toHaveLength(Object.keys(player.components).length);
  });

  it('does not attach a prefab summary to non-prefab assets', async () => {
    const { session } = await makeSession();
    const sprite = await session.execute<any>('createSpriteAsset', { name: 'Plain', shape: 'circle', color: 'red' });
    expect(sprite.success).toBe(true);

    const result = await session.execute<any>('inspectAssets', {});
    const entry = result.data.assets.find((a: any) => a.id === sprite.data.asset.id);
    expect(entry.prefab).toBeUndefined();
  });

  it('omits the prefab summary (rather than crashing) when the payload on disk is corrupt', async () => {
    const { session, store, fs } = await makeSession();
    const sceneId = store.project.initialScene!;
    const player = store.getScene(sceneId)!.entities.find((e) => e.name === 'Player')!;
    const created = await session.execute<any>('createPrefab', { scene: sceneId, entity: player.id, name: 'PlayerPrefab' });
    const asset = created.data.asset as { id: string; path: string };

    await fs.writeFile(`/proj/${asset.path}`, 'not json {{{');

    const result = await session.execute<any>('inspectAssets', { type: 'prefab' });
    expect(result.success).toBe(true);
    const entry = result.data.assets.find((a: any) => a.id === asset.id);
    expect(entry).toBeTruthy();
    expect(entry.prefab).toBeUndefined();
  });
});
