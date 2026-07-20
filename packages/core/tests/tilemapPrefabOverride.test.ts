/**
 * Tilemap mutation commands must record a
 * prefab override when they mutate a live-linked instance member, so painting
 * / autotiling a tilemap inside an instance is NOT silently clobbered by the
 * next updatePrefab/sync.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession, AUTOTILE_SHAPES } from '@hearth/core';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return { fs, session: HearthSession.fromStore(store, { granted: ['safe-edit', 'asset-edit'] }), store };
}

/** Register a spritesheet asset with the full blob47 template frame set. */
function addBlob47Sheet(store: any, id = 'ast_sheet', name = 'GroundSheet') {
  store.assets.assets.push({
    id,
    name,
    type: 'sprite',
    path: `assets/sprites/${name}.png`,
    metadata: {
      frames: AUTOTILE_SHAPES.map((s: string, i: number) => ({
        name: `blob_${s}`,
        x: i,
        y: 0,
        width: 16,
        height: 16,
      })),
    },
  });
}

/**
 * Build a PlayerPrefab whose root carries a Tilemap (empty 3x4 grid), then
 * place TWO live instances (A and B) in a fresh Level2 scene. `updatePrefab`
 * is later driven from B so the auto-sync must preserve A's overrides.
 */
async function makeTwoTilemapInstances() {
  const ctx = await makeSession();
  const { session, store } = ctx;
  const src = store.project.initialScene!;
  const player = store.getScene(src)!.entities.find((e) => e.name === 'Player')!;

  const added = await session.execute<any>('addComponent', {
    scene: src,
    entity: player.id,
    type: 'Tilemap',
    properties: { grid: ['....', '....', '....'], tileAssets: { G: 'ast_ground' } },
  });
  expect(added.success).toBe(true);

  const created = await session.execute<any>('createPrefab', { scene: src, entity: player.id, name: 'PlayerPrefab' });
  expect(created.success).toBe(true);
  const asset = created.data.asset as { id: string; name: string; path: string };

  const sceneId = (await session.execute<any>('createScene', { name: 'Level2' })).data.sceneId as string;
  const instA = await session.execute<any>('instantiatePrefab', { prefab: asset.id, scene: sceneId });
  const instB = await session.execute<any>('instantiatePrefab', { prefab: asset.id, scene: sceneId });
  expect(instA.success && instB.success).toBe(true);
  const rootA = instA.data.entity.id as string;
  const rootB = instB.data.entity.id as string;

  const tilemapOf = (id: string) => store.getScene(sceneId)!.entities.find((e) => e.id === id)!.components.Tilemap!;
  const markerOf = (id: string) => store.getScene(sceneId)!.entities.find((e) => e.id === id)!.prefab!;

  return { ...ctx, asset, sceneId, rootA, rootB, tilemapOf, markerOf };
}

describe('I-2 — tilemap paint on a live instance survives prefab sync', () => {
  it('records a grid override that is preserved by updatePrefab and revertible', async () => {
    const { session, asset, sceneId, rootA, rootB, tilemapOf, markerOf } = await makeTwoTilemapInstances();

    // Paint a cell on instance A's tilemap.
    const paint = await session.execute<any>('paintTiles', {
      scene: sceneId,
      entity: rootA,
      cells: [{ x: 0, y: 0, char: 'G' }],
    });
    expect(paint.success).toBe(true);
    const painted = tilemapOf(rootA).grid;
    expect(painted[0]).toBe('G...');

    // The paint must have recorded an implicit override on A's root marker.
    const gridOverride = markerOf(rootA).overrides!.find((o) => o.component === 'Tilemap' && o.path === 'grid');
    expect(gridOverride).toBeTruthy();

    // Drive updatePrefab from the OTHER instance (B, whose tilemap is still empty).
    const upd = await session.execute<any>('updatePrefab', { prefab: asset.id, scene: sceneId, entity: rootB });
    expect(upd.success).toBe(true);

    // A's painted grid must SURVIVE the sync (not silently reverted to empty).
    expect(tilemapOf(rootA).grid).toEqual(painted);
    // B (no override) is rebuilt from the payload (empty top row).
    expect(tilemapOf(rootB).grid[0]).toBe('....');

    // revertPrefabOverride restores the prefab's grid on A.
    const rev = await session.execute<any>('revertPrefabOverride', {
      scene: sceneId,
      entity: rootA,
      component: 'Tilemap',
      path: 'grid',
    });
    expect(rev.success).toBe(true);
    expect(tilemapOf(rootA).grid[0]).toBe('....');
  });
});

describe('I-2 — setTileAutotile on a live instance survives prefab sync', () => {
  it('records a tileAssets override that is preserved by updatePrefab and revertible', async () => {
    const { store, session, asset, sceneId, rootA, rootB, tilemapOf, markerOf } = await makeTwoTilemapInstances();
    addBlob47Sheet(store);

    const bind = await session.execute<any>('setTileAutotile', {
      scene: sceneId,
      entity: rootA,
      char: 'G',
      sheet: 'ast_sheet',
    });
    expect(bind.success).toBe(true);
    const ruleAfter = tilemapOf(rootA).tileAssets.G;
    expect(typeof ruleAfter).toBe('object'); // an autotile rule, not a plain id

    const taOverride = markerOf(rootA).overrides!.find((o) => o.component === 'Tilemap' && o.path === 'tileAssets');
    expect(taOverride).toBeTruthy();

    const upd = await session.execute<any>('updatePrefab', { prefab: asset.id, scene: sceneId, entity: rootB });
    expect(upd.success).toBe(true);

    // A keeps the autotile rule; B reverts to the plain-id payload.
    expect(tilemapOf(rootA).tileAssets.G).toEqual(ruleAfter);
    expect(tilemapOf(rootB).tileAssets.G).toBe('ast_ground');

    const rev = await session.execute<any>('revertPrefabOverride', {
      scene: sceneId,
      entity: rootA,
      component: 'Tilemap',
      path: 'tileAssets',
    });
    expect(rev.success).toBe(true);
    expect(tilemapOf(rootA).tileAssets.G).toBe('ast_ground');
  });
});
