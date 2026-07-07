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

/** Adds a Tilemap to Main/Player with a small 4-wide/3-tall grid and one tile asset key ("G"). */
async function addTilemap(session: HearthSession, gridOverride?: string[]) {
  return session.execute<any>('addComponent', {
    scene: 'Main',
    entity: 'Player',
    type: 'Tilemap',
    properties: {
      grid: gridOverride ?? ['....', '.GG.', '....'],
      tileAssets: { G: 'ast_ground' },
    },
  });
}

function tilemapOf(store: any) {
  return store.getScene('Main')!.entities.find((e: any) => e.name === 'Player')!.components.Tilemap;
}

describe('paintTiles', () => {
  it('paints a batch of cells in one command and returns the count', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session);

    const result = await session.execute<any>('paintTiles', {
      scene: 'Main',
      entity: 'Player',
      cells: [
        { x: 0, y: 0, char: 'G' },
        { x: 3, y: 2, char: 'G' },
        { x: 1, y: 1, char: '.' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.data.painted).toBe(3);
    expect(tilemapOf(store).grid).toEqual(['G...', '..G.', '...G']);
  });

  it('rebuilds row strings without mutating other cells on the same row', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session);
    await session.execute('paintTiles', { scene: 'Main', entity: 'Player', cells: [{ x: 2, y: 1, char: '.' }] });
    expect(tilemapOf(store).grid).toEqual(['....', '.G..', '....']);
  });

  it('assigns a brand new grid array reference (never mutates in place)', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session);
    const before = tilemapOf(store).grid;
    await session.execute('paintTiles', { scene: 'Main', entity: 'Player', cells: [{ x: 0, y: 0, char: 'G' }] });
    const after = tilemapOf(store).grid;
    expect(after).not.toBe(before);
  });

  it('fails with NO_TILEMAP when the entity has no Tilemap component', async () => {
    const { session } = await makeSession();
    const result = await session.execute('paintTiles', {
      scene: 'Main',
      entity: 'Player',
      cells: [{ x: 0, y: 0, char: 'G' }],
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('NO_TILEMAP');
  });

  it('rejects a char that is not "." / " " or a tileAssets key', async () => {
    const { session } = await makeSession();
    await addTilemap(session);
    const result = await session.execute('paintTiles', {
      scene: 'Main',
      entity: 'Player',
      cells: [{ x: 0, y: 0, char: 'Z' }],
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_TILE_CHAR');
  });

  it('rejects multi-character strings as INVALID_TILE_CHAR', async () => {
    const { session } = await makeSession();
    await addTilemap(session);
    const result = await session.execute('paintTiles', {
      scene: 'Main',
      entity: 'Player',
      cells: [{ x: 0, y: 0, char: 'GG' }],
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_TILE_CHAR');
  });

  it('accepts a literal space as a legal (empty) tile char', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session);
    const result = await session.execute('paintTiles', {
      scene: 'Main',
      entity: 'Player',
      cells: [{ x: 1, y: 1, char: ' ' }],
    });
    expect(result.success).toBe(true);
    expect(tilemapOf(store).grid[1]).toBe('. G.');
  });

  it('fails with TILE_OUT_OF_BOUNDS and suggests resizeTilemap', async () => {
    const { session } = await makeSession();
    await addTilemap(session);
    const result = await session.execute('paintTiles', {
      scene: 'Main',
      entity: 'Player',
      cells: [{ x: 99, y: 0, char: 'G' }],
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('TILE_OUT_OF_BOUNDS');
    expect(result.suggestions.some((s: string) => s.includes('resizeTilemap'))).toBe(true);
  });

  it('respects each row own length for non-square grids', async () => {
    const { session } = await makeSession();
    // Row 0 is 4 wide, row 1 is only 2 wide, row 2 is 5 wide.
    await addTilemap(session, ['....', 'GG', '.....']);

    const okShort = await session.execute('paintTiles', {
      scene: 'Main',
      entity: 'Player',
      cells: [{ x: 1, y: 1, char: '.' }],
    });
    expect(okShort.success).toBe(true);

    const outOnShortRow = await session.execute('paintTiles', {
      scene: 'Main',
      entity: 'Player',
      cells: [{ x: 3, y: 1, char: 'G' }],
    });
    expect(outOnShortRow.success).toBe(false);
    expect(outOnShortRow.errors[0].code).toBe('TILE_OUT_OF_BOUNDS');

    const okOnLongRow = await session.execute<any>('paintTiles', {
      scene: 'Main',
      entity: 'Player',
      cells: [{ x: 4, y: 2, char: 'G' }],
    });
    expect(okOnLongRow.success).toBe(true);
  });

  it('validates every cell before mutating anything (all-or-nothing)', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session);
    const before = tilemapOf(store).grid;
    const result = await session.execute('paintTiles', {
      scene: 'Main',
      entity: 'Player',
      cells: [
        { x: 0, y: 0, char: 'G' },
        { x: 999, y: 999, char: 'G' }, // out of bounds -> whole command fails
      ],
    });
    expect(result.success).toBe(false);
    expect(tilemapOf(store).grid).toEqual(before);
  });

  it('undoes a paint back to a byte-identical grid', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session);
    const before = [...tilemapOf(store).grid];

    await session.execute('paintTiles', {
      scene: 'Main',
      entity: 'Player',
      cells: [
        { x: 0, y: 0, char: 'G' },
        { x: 3, y: 2, char: 'G' },
      ],
    });
    expect(tilemapOf(store).grid).not.toEqual(before);

    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(true);
    expect(undo.data.undone).toBe('paintTiles');
    expect(tilemapOf(store).grid).toEqual(before);
  });

  it('records a batched multi-cell paint as exactly one history entry', async () => {
    const { session } = await makeSession();
    await addTilemap(session);
    await session.execute('paintTiles', {
      scene: 'Main',
      entity: 'Player',
      cells: [
        { x: 0, y: 0, char: 'G' },
        { x: 1, y: 0, char: 'G' },
        { x: 2, y: 0, char: 'G' },
      ],
    });
    // The addComponent from addTilemap() is entry 0 (oldest first); the
    // batched multi-cell paint is entry 1 — one entry, not three.
    const list = await session.execute<any>('listHistory');
    expect(list.data.entries.length).toBe(2);
    expect(list.data.entries[1].command).toBe('paintTiles');
  });
});

describe('fillTilemapRect', () => {
  it('fills a rectangular region and returns the painted count', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session, ['....', '....', '....']);
    const result = await session.execute<any>('fillTilemapRect', {
      scene: 'Main',
      entity: 'Player',
      x: 1,
      y: 0,
      width: 2,
      height: 2,
      char: 'G',
    });
    expect(result.success).toBe(true);
    expect(result.data.painted).toBe(4);
    expect(tilemapOf(store).grid).toEqual(['.GG.', '.GG.', '....']);
  });

  it('fails with NO_TILEMAP without a Tilemap component', async () => {
    const { session } = await makeSession();
    const result = await session.execute('fillTilemapRect', {
      scene: 'Main',
      entity: 'Player',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      char: '.',
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('NO_TILEMAP');
  });

  it('rejects an invalid char', async () => {
    const { session } = await makeSession();
    await addTilemap(session);
    const result = await session.execute('fillTilemapRect', {
      scene: 'Main',
      entity: 'Player',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      char: 'Q',
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_TILE_CHAR');
  });

  it('fails with TILE_OUT_OF_BOUNDS and suggests resizeTilemap when the rect overruns the grid', async () => {
    const { session } = await makeSession();
    await addTilemap(session);
    const result = await session.execute('fillTilemapRect', {
      scene: 'Main',
      entity: 'Player',
      x: 2,
      y: 0,
      width: 10,
      height: 1,
      char: 'G',
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('TILE_OUT_OF_BOUNDS');
    expect(result.suggestions.some((s: string) => s.includes('resizeTilemap'))).toBe(true);
  });

  it('is a single history entry regardless of rect size', async () => {
    const { session } = await makeSession();
    await addTilemap(session, ['.........', '.........', '.........']);
    await session.execute('fillTilemapRect', {
      scene: 'Main',
      entity: 'Player',
      x: 0,
      y: 0,
      width: 9,
      height: 3,
      char: 'G',
    });
    const list = await session.execute<any>('listHistory');
    expect(list.data.entries.length).toBe(2);
    expect(list.data.entries[1].command).toBe('fillTilemapRect');
  });

  it('rejects width/height exceeding 1024 as invalid params', async () => {
    const { session } = await makeSession();
    await addTilemap(session);
    const tooBig = await session.execute('fillTilemapRect', {
      scene: 'Main',
      entity: 'Player',
      x: 0,
      y: 0,
      width: 2000,
      height: 1,
      char: '.',
    });
    expect(tooBig.success).toBe(false);
    expect(tooBig.errors[0].code).toBe('INVALID_PARAMS');
  });

  it('fast-fails with TILE_OUT_OF_BOUNDS when oversized rect exceeds grid bounds (1000x1000 on 4x4)', async () => {
    const { session } = await makeSession();
    await addTilemap(session);
    const result = await session.execute('fillTilemapRect', {
      scene: 'Main',
      entity: 'Player',
      x: 0,
      y: 0,
      width: 1000,
      height: 1000,
      char: 'G',
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('TILE_OUT_OF_BOUNDS');
    expect(result.suggestions.some((s: string) => s.includes('resizeTilemap'))).toBe(true);
  });
});

describe('resizeTilemap', () => {
  it('grows the grid, padding new cells and new rows with "."', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session, ['GG', 'GG']);
    const result = await session.execute<any>('resizeTilemap', {
      scene: 'Main',
      entity: 'Player',
      width: 4,
      height: 4,
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ width: 4, height: 4 });
    expect(tilemapOf(store).grid).toEqual(['GG..', 'GG..', '....', '....']);
  });

  it('shrinks the grid, cropping from the right and bottom', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session, ['GGGG', 'GGGG', 'GGGG', 'GGGG']);
    const result = await session.execute<any>('resizeTilemap', {
      scene: 'Main',
      entity: 'Player',
      width: 2,
      height: 2,
    });
    expect(result.success).toBe(true);
    expect(tilemapOf(store).grid).toEqual(['GG', 'GG']);
  });

  it('normalizes non-square input so every row is exactly width long', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session, ['....', 'GG', '......']);
    await session.execute('resizeTilemap', { scene: 'Main', entity: 'Player', width: 5, height: 3 });
    const grid = tilemapOf(store).grid;
    expect(grid).toHaveLength(3);
    for (const row of grid) expect(row).toHaveLength(5);
    expect(grid).toEqual(['....' + '.', 'GG' + '...', '.....']);
  });

  it('defaults anchor to top-left and accepts it explicitly', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session, ['GG', 'GG']);
    const result = await session.execute<any>('resizeTilemap', {
      scene: 'Main',
      entity: 'Player',
      width: 3,
      height: 2,
      anchor: 'top-left',
    });
    expect(result.success).toBe(true);
    expect(tilemapOf(store).grid).toEqual(['GG.', 'GG.']);
  });

  it('rejects width/height outside 1..1024 as invalid params', async () => {
    const { session } = await makeSession();
    await addTilemap(session);
    const tooSmall = await session.execute('resizeTilemap', { scene: 'Main', entity: 'Player', width: 0, height: 4 });
    expect(tooSmall.success).toBe(false);
    expect(tooSmall.errors[0].code).toBe('INVALID_PARAMS');

    const tooBig = await session.execute('resizeTilemap', { scene: 'Main', entity: 'Player', width: 4, height: 1025 });
    expect(tooBig.success).toBe(false);
    expect(tooBig.errors[0].code).toBe('INVALID_PARAMS');
  });

  it('fails with NO_TILEMAP without a Tilemap component', async () => {
    const { session } = await makeSession();
    const result = await session.execute('resizeTilemap', { scene: 'Main', entity: 'Player', width: 4, height: 4 });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('NO_TILEMAP');
  });

  it('undoes a resize back to the original grid', async () => {
    const { session, store } = await makeSession();
    await addTilemap(session, ['GG', 'GG']);
    const before = [...tilemapOf(store).grid];
    await session.execute('resizeTilemap', { scene: 'Main', entity: 'Player', width: 4, height: 4 });
    expect(tilemapOf(store).grid).not.toEqual(before);
    const undo = await session.execute<any>('undo');
    expect(undo.success).toBe(true);
    expect(tilemapOf(store).grid).toEqual(before);
  });
});
