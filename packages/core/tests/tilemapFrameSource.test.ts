import { describe, expect, it } from 'vitest';
import {
  HearthSession,
  MemoryFileSystem,
  TileAssetSchema,
  createProject,
  isAutotileRule,
  isTileFrameSource,
} from '@hearth/core';

async function makeSession() {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Fixed Frame Test' });
  const session = HearthSession.fromStore(store, { granted: ['safe-edit'] });
  await session.execute('addComponent', {
    scene: 'Main',
    entity: 'Player',
    type: 'Tilemap',
    properties: { grid: ['G'], tileAssets: { G: 'ast_ground' } },
  });
  return { session, store };
}

describe('fixed Tilemap frame sources', () => {
  it('accepts a fixed sliced-sheet frame and identifies each object arm', () => {
    const source = { sheet: 'ast_sheet', frame: 'floor_7' };
    expect(TileAssetSchema.parse(source)).toEqual(source);
    expect(isTileFrameSource(source)).toBe(true);
    expect(isAutotileRule(source)).toBe(false);

    const rule = { sheet: 'ast_sheet', template: 'blob47' } as const;
    expect(isTileFrameSource(rule)).toBe(false);
    expect(isAutotileRule(rule)).toBe(true);
    expect(isTileFrameSource({ frame: 'floor_7' })).toBe(false);
    expect(isAutotileRule({ template: 'blob47' })).toBe(false);
  });

  it('allows fixed-frame structured property writes', async () => {
    const { session, store } = await makeSession();
    const source = { sheet: 'ast_sheet', frame: 'floor_7' };
    const result = await session.execute('setComponentProperty', {
      scene: 'Main',
      entity: 'Player',
      property: 'Tilemap.tileAssets.G',
      value: source,
    });
    expect(result.success).toBe(true);
    const tilemap = store.getScene('Main')!.entities.find((entity) => entity.name === 'Player')!.components.Tilemap!;
    expect(tilemap.tileAssets.G).toEqual(source);
  });

  it('allows fixed frames in a wholesale tileAssets write', async () => {
    const { session, store } = await makeSession();
    const source = { sheet: 'ast_sheet', frame: 'floor_7' };
    const result = await session.execute('setComponentProperty', {
      scene: 'Main',
      entity: 'Player',
      property: 'Tilemap.tileAssets',
      value: { G: source, W: 'ast_water' },
    });
    expect(result.success).toBe(true);
    const tilemap = store.getScene('Main')!.entities.find((entity) => entity.name === 'Player')!.components.Tilemap!;
    expect(tilemap.tileAssets).toEqual({ G: source, W: 'ast_water' });
  });

  it('still rejects unchecked autotile object writes', async () => {
    const { session } = await makeSession();
    const result = await session.execute('setComponentProperty', {
      scene: 'Main',
      entity: 'Player',
      property: 'Tilemap.tileAssets.G',
      value: { sheet: 'ast_sheet', template: 'blob47' },
    });
    expect(result.success).toBe(false);
    expect(result.errors[0]?.message).toContain('setTileAutotile');
  });
});
