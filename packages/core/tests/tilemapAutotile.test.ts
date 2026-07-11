import { describe, it, expect } from 'vitest';
import {
  MemoryFileSystem,
  createProject,
  HearthSession,
  TilemapSchema,
  AUTOTILE_SHAPES,
  extractJournalDetail,
} from '@hearth/core';

async function makeSession(granted: any = ['safe-edit', 'asset-edit']) {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Test Game' });
  return { fs, session: HearthSession.fromStore(store, { granted }), store };
}

async function addTilemap(session: HearthSession) {
  return session.execute<any>('addComponent', {
    scene: 'Main',
    entity: 'Player',
    type: 'Tilemap',
    properties: { grid: ['....', '.GG.', '....'], tileAssets: { G: 'ast_ground' } },
  });
}

function tilemapOf(store: any) {
  return store.getScene('Main')!.entities.find((e: any) => e.name === 'Player')!.components.Tilemap;
}

/** Register a spritesheet asset with the given named frames straight into the store. */
function addSheet(store: any, id: string, name: string, frameNames: string[]) {
  store.assets.assets.push({
    id,
    name,
    type: 'sprite',
    path: `assets/sprites/${name}.png`,
    metadata: {
      frames: frameNames.map((frameName, i) => ({
        name: frameName,
        x: i,
        y: 0,
        width: 16,
        height: 16,
      })),
    },
  });
}

/** A sheet carrying the full blob47 template frame set (blob_<shape> for every shape). */
function addBlob47Sheet(store: any, id = 'ast_sheet', name = 'GroundSheet') {
  addSheet(store, id, name, AUTOTILE_SHAPES.map((s) => `blob_${s}`));
}

describe('TilemapSchema tileAssets union', () => {
  it('accepts the string arm unchanged (back-compat)', () => {
    const parsed = TilemapSchema.safeParse({ tileAssets: { G: 'ast_ground', W: 'ast_water' } });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.tileAssets).toEqual({ G: 'ast_ground', W: 'ast_water' });
  });

  it('round-trips the object (autotile rule) arm', () => {
    const rule = { sheet: 'ast_sheet', template: 'blob47', mapping: { '0': 'lonely', '255': 'center' } };
    const parsed = TilemapSchema.safeParse({ tileAssets: { G: rule } });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.tileAssets.G).toEqual(rule);
  });

  it('allows string and rule arms to coexist across chars', () => {
    const parsed = TilemapSchema.safeParse({
      tileAssets: { G: 'ast_ground', W: { sheet: 'ast_sheet', template: 'blob47' } },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown template value', () => {
    const parsed = TilemapSchema.safeParse({
      tileAssets: { G: { sheet: 'ast_sheet', template: 'wang' } },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a stray key on the rule arm (.strict)', () => {
    const parsed = TilemapSchema.safeParse({
      tileAssets: { G: { sheet: 'ast_sheet', template: 'blob47', bogus: 1 } },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('setTileAutotile', () => {
  it('binds a char to a blob47 rule when the sheet has all template frames', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session);
    addBlob47Sheet(store);

    const result = await session.execute<any>('setTileAutotile', {
      scene: 'Main',
      entity: 'Player',
      char: 'W',
      sheet: 'GroundSheet',
    });

    expect(result.success).toBe(true);
    expect(tilemapOf(store).tileAssets.W).toEqual({ sheet: 'ast_sheet', template: 'blob47' });
  });

  it('stores the resolved sheet id even when referenced by name', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session);
    addBlob47Sheet(store, 'ast_grnd', 'Ground');
    const result = await session.execute<any>('setTileAutotile', {
      scene: 'Main',
      entity: 'Player',
      char: 'W',
      sheet: 'Ground',
    });
    expect(result.success).toBe(true);
    expect(tilemapOf(store).tileAssets.W.sheet).toBe('ast_grnd');
  });

  it('accepts a partial mapping override whose frames exist on the sheet', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session);
    // Full template set PLUS a custom frame name used by the override.
    addSheet(store, 'ast_sheet', 'GroundSheet', [
      ...AUTOTILE_SHAPES.map((s) => `blob_${s}`),
      'special_center',
    ]);
    const result = await session.execute<any>('setTileAutotile', {
      scene: 'Main',
      entity: 'Player',
      char: 'W',
      sheet: 'GroundSheet',
      mapping: { '255': 'special_center' },
    });
    expect(result.success).toBe(true);
    expect(tilemapOf(store).tileAssets.W.mapping).toEqual({ '255': 'special_center' });
  });

  it('clears an existing rule and removes the tileAssets entry', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session);
    addBlob47Sheet(store);
    await session.execute('setTileAutotile', { scene: 'Main', entity: 'Player', char: 'W', sheet: 'GroundSheet' });
    expect(tilemapOf(store).tileAssets.W).toBeTruthy();

    const cleared = await session.execute<any>('setTileAutotile', {
      scene: 'Main',
      entity: 'Player',
      char: 'W',
      clear: true,
    });
    expect(cleared.success).toBe(true);
    expect('W' in tilemapOf(store).tileAssets).toBe(false);
  });

  it('fails to clear a char that has no tileAssets entry', async () => {
    const { session } = await makeSession();
    await addTilemap(session);
    const result = await session.execute<any>('setTileAutotile', {
      scene: 'Main',
      entity: 'Player',
      char: 'Z',
      clear: true,
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('NOT_FOUND');
  });

  it('rejects a reserved empty char', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session);
    addBlob47Sheet(store);
    const result = await session.execute<any>('setTileAutotile', {
      scene: 'Main',
      entity: 'Player',
      char: '.',
      sheet: 'GroundSheet',
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_TILE_CHAR');
  });

  it('fails with AUTOTILE_SHEET_NOT_FOUND when the sheet asset does not exist', async () => {
    const { session } = await makeSession();
    await addTilemap(session);
    const result = await session.execute<any>('setTileAutotile', {
      scene: 'Main',
      entity: 'Player',
      char: 'W',
      sheet: 'Nope',
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('AUTOTILE_SHEET_NOT_FOUND');
  });

  it('fails with AUTOTILE_SHEET_NOT_FOUND when the asset has no sliced frames', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session);
    addSheet(store, 'ast_bare', 'Bare', []); // no frames
    const result = await session.execute<any>('setTileAutotile', {
      scene: 'Main',
      entity: 'Player',
      char: 'W',
      sheet: 'Bare',
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('AUTOTILE_SHEET_NOT_FOUND');
  });

  it('fails with AUTOTILE_FRAME_MISSING when template frames are absent', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session);
    // A sheet with SOME frames but not the full blob47 template set.
    addSheet(store, 'ast_partial', 'Partial', ['blob_0', 'blob_255']);
    const result = await session.execute<any>('setTileAutotile', {
      scene: 'Main',
      entity: 'Player',
      char: 'W',
      sheet: 'Partial',
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('AUTOTILE_FRAME_MISSING');
  });

  it('fails with AUTOTILE_FRAME_MISSING when a mapping override frame is absent', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session);
    addBlob47Sheet(store); // has all template frames, but not "ghost"
    const result = await session.execute<any>('setTileAutotile', {
      scene: 'Main',
      entity: 'Player',
      char: 'W',
      sheet: 'GroundSheet',
      mapping: { '255': 'ghost' },
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('AUTOTILE_FRAME_MISSING');
  });

  it('rejects a mapping key that is not a real blob47 shape key', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session);
    addBlob47Sheet(store);
    const result = await session.execute<any>('setTileAutotile', {
      scene: 'Main',
      entity: 'Player',
      char: 'W',
      sheet: 'GroundSheet',
      mapping: { '2': 'blob_2' }, // 2 (lone NE) is not canonical -> not a shape key
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_INPUT');
  });

  it('records exactly one undo entry and undoes back to the prior tileAssets', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session);
    addBlob47Sheet(store);
    const before = JSON.parse(JSON.stringify(tilemapOf(store).tileAssets));

    await session.execute('setTileAutotile', { scene: 'Main', entity: 'Player', char: 'W', sheet: 'GroundSheet' });
    expect(tilemapOf(store).tileAssets).not.toEqual(before);

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(true);
    expect(undo.data.undone).toBe('setTileAutotile');
    expect(tilemapOf(store).tileAssets).toEqual(before);
  });

  it('journals only the target (scene, entity, char)', () => {
    const detail = extractJournalDetail(
      'setTileAutotile',
      { entityId: 'ent_1', char: 'W', rule: { sheet: 'ast_sheet', template: 'blob47' } },
      { scene: 'Main', entity: 'Player', char: 'W', sheet: 'GroundSheet' },
    );
    expect(detail).toEqual({ scene: 'Main', entity: 'Player', char: 'W' });
  });
});

describe('setComponentProperty rejects the autotile object arm', () => {
  it('refuses a rule written to tileAssets.<char> and points at setTileAutotile', async () => {
    const { session } = await makeSession();
    await addTilemap(session);
    const result = await session.execute<any>('setComponentProperty', {
      scene: 'Main',
      entity: 'Player',
      property: 'Tilemap.tileAssets.W',
      value: { sheet: 'ast_sheet', template: 'blob47' },
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_INPUT');
    expect(result.errors[0].message).toContain('setTileAutotile');
  });

  it('refuses a rule written via a wholesale tileAssets object', async () => {
    const { session } = await makeSession();
    await addTilemap(session);
    const result = await session.execute<any>('setComponentProperty', {
      scene: 'Main',
      entity: 'Player',
      property: 'Tilemap.tileAssets',
      value: { G: 'ast_ground', W: { sheet: 'ast_sheet', template: 'blob47' } },
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_INPUT');
    expect(result.errors[0].message).toContain('setTileAutotile');
  });

  it('still allows a plain string tile id through setComponentProperty', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session);
    const result = await session.execute<any>('setComponentProperty', {
      scene: 'Main',
      entity: 'Player',
      property: 'Tilemap.tileAssets.W',
      value: 'ast_water',
    });
    expect(result.success).toBe(true);
    expect(tilemapOf(store).tileAssets.W).toBe('ast_water');
  });

  it('setProperties also refuses a rule written to tileAssets', async () => {
    const { session } = await makeSession();
    await addTilemap(session);
    const result = await session.execute<any>('setProperties', {
      scene: 'Main',
      entity: 'Player',
      properties: { 'Tilemap.tileAssets.W': { sheet: 'ast_sheet', template: 'blob47' } },
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_INPUT');
    expect(result.errors[0].message).toContain('setTileAutotile');
  });
});
