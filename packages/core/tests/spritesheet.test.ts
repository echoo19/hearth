import { describe, it, expect, beforeEach } from 'vitest';
import {
  MemoryFileSystem,
  createProject,
  HearthSession,
  getSheetFrames,
  findSheetFrame,
} from '@hearth/core';

describe('spritesheet slicing', () => {
  let fs: MemoryFileSystem;
  let session: HearthSession;

  beforeEach(async () => {
    fs = new MemoryFileSystem();
    const { store } = await createProject(fs, '/proj', { name: 'Test' });
    session = HearthSession.fromStore(store, {
      granted: ['asset-edit'],
    });
  });

  function makePngBytes(width: number, height: number): Uint8Array {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff, // width
      (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff, // height
      0x08, 0x02, 0x00, 0x00, 0x00, // color type, compression, filter
      0x12, 0x34, 0x56, 0x78, // CRC
    ]);
    return pngBytes;
  }

  it('slices a 130×64 PNG with 32×32 frames: 4 cols, 2 rows, 8 frames, warning about leftover pixels', async () => {
    const pngBytes = makePngBytes(130, 64);
    await fs.writeFile('/tmp/sprite.png', pngBytes);

    const importResult = await session.execute('importAsset', {
      sourcePath: '/tmp/sprite.png',
      name: 'TestSpritesheet',
      type: 'sprite',
    });
    expect(importResult.success).toBe(true);
    const assetId = importResult.data!.asset.id;

    const sliceResult = await session.execute('sliceSpritesheet', {
      asset: assetId,
      frameWidth: 32,
      frameHeight: 32,
    });

    expect(sliceResult.success).toBe(true);
    const data = sliceResult.data!;
    expect(data.assetId).toBe(assetId);
    expect(data.frameCount).toBe(8);
    expect(data.columns).toBe(4);
    expect(data.rows).toBe(2);
    expect(data.frames).toHaveLength(8);
    expect(data.warning).toBeDefined();
    expect(data.warning).toMatch(/130x64/);
    expect(data.warning).toMatch(/2px unused on the right/);

    // Verify frames were written to asset metadata
    const asset = session.store.getAsset(assetId);
    expect(asset).toBeDefined();
    const frames = getSheetFrames(asset!);
    expect(frames).toHaveLength(8);
    expect(frames[0].name).toBe('testspritesheet_0');
    expect(frames[0].x).toBe(0);
    expect(frames[0].y).toBe(0);
    expect(frames[0].width).toBe(32);
    expect(frames[0].height).toBe(32);
  });

  it('computes frame positions row-major: frame 5 at {x: 32, y: 32}', async () => {
    const pngBytes = makePngBytes(130, 64);
    await fs.writeFile('/tmp/sprite.png', pngBytes);

    const importResult = await session.execute('importAsset', {
      sourcePath: '/tmp/sprite.png',
      name: 'TestSpritesheet',
      type: 'sprite',
    });
    const assetId = importResult.data!.asset.id;

    await session.execute('sliceSpritesheet', {
      asset: assetId,
      frameWidth: 32,
      frameHeight: 32,
    });

    const asset = session.store.getAsset(assetId);
    const frames = getSheetFrames(asset!);
    // Frame 5: row 1, col 1
    expect(frames[5].x).toBe(32);
    expect(frames[5].y).toBe(32);
    expect(frames[5].width).toBe(32);
    expect(frames[5].height).toBe(32);
  });

  it('applies margin and spacing: 69×35 sheet with 16×16 frames, margin 1, spacing 2: 3 cols, 1 row', async () => {
    const pngBytes = makePngBytes(69, 35);
    await fs.writeFile('/tmp/sprite.png', pngBytes);

    const importResult = await session.execute('importAsset', {
      sourcePath: '/tmp/sprite.png',
      name: 'MarginTest',
      type: 'sprite',
    });
    const assetId = importResult.data!.asset.id;

    const sliceResult = await session.execute('sliceSpritesheet', {
      asset: assetId,
      frameWidth: 16,
      frameHeight: 16,
      margin: 1,
      spacing: 2,
    });

    expect(sliceResult.success).toBe(true);
    const data = sliceResult.data!;
    expect(data.columns).toBe(3);
    expect(data.rows).toBe(1);
    expect(data.frameCount).toBe(3);

    const asset = session.store.getAsset(assetId);
    const frames = getSheetFrames(asset!);
    // Frame 1: row 0, col 1
    // x = margin + col*(frameWidth+spacing) = 1 + 1*(16+2) = 1 + 18 = 19
    // y = margin + row*(frameHeight+spacing) = 1 + 0*(16+2) = 1 + 0 = 1
    expect(frames[1].x).toBe(19);
    expect(frames[1].y).toBe(1);
  });

  it('applies margin and spacing on both axes: 69×53 sheet with 16×16 frames, margin 1, spacing 2: 3 cols, 2 rows', async () => {
    const pngBytes = makePngBytes(69, 53);
    await fs.writeFile('/tmp/sprite.png', pngBytes);

    const importResult = await session.execute('importAsset', {
      sourcePath: '/tmp/sprite.png',
      name: 'MarginBothAxes',
      type: 'sprite',
    });
    const assetId = importResult.data!.asset.id;

    const sliceResult = await session.execute('sliceSpritesheet', {
      asset: assetId,
      frameWidth: 16,
      frameHeight: 16,
      margin: 1,
      spacing: 2,
    });

    expect(sliceResult.success).toBe(true);
    const data = sliceResult.data!;
    expect(data.columns).toBe(3);
    expect(data.rows).toBe(2);
    expect(data.frameCount).toBe(6);

    const asset = session.store.getAsset(assetId);
    const frames = getSheetFrames(asset!);
    // Frame 4: row 1, col 1
    // x = margin + col*(frameWidth+spacing) = 1 + 1*(16+2) = 19
    // y = margin + row*(frameHeight+spacing) = 1 + 1*(16+2) = 19
    expect(frames[4].x).toBe(19);
    expect(frames[4].y).toBe(19);
  });

  it('uses asset name slug as default namePrefix', async () => {
    const pngBytes = makePngBytes(130, 64);
    await fs.writeFile('/tmp/sprite.png', pngBytes);

    const importResult = await session.execute('importAsset', {
      sourcePath: '/tmp/sprite.png',
      name: 'Cool Sprite!',
      type: 'sprite',
    });
    const assetId = importResult.data!.asset.id;

    await session.execute('sliceSpritesheet', {
      asset: assetId,
      frameWidth: 32,
      frameHeight: 32,
    });

    const asset = session.store.getAsset(assetId);
    const frames = getSheetFrames(asset!);
    expect(frames[0].name).toBe('cool_sprite_0');
    expect(frames[1].name).toBe('cool_sprite_1');
  });

  it('respects explicit namePrefix', async () => {
    const pngBytes = makePngBytes(130, 64);
    await fs.writeFile('/tmp/sprite.png', pngBytes);

    const importResult = await session.execute('importAsset', {
      sourcePath: '/tmp/sprite.png',
      name: 'TestSprite',
      type: 'sprite',
    });
    const assetId = importResult.data!.asset.id;

    await session.execute('sliceSpritesheet', {
      asset: assetId,
      frameWidth: 32,
      frameHeight: 32,
      namePrefix: 'custom',
    });

    const asset = session.store.getAsset(assetId);
    const frames = getSheetFrames(asset!);
    expect(frames[0].name).toBe('custom_0');
    expect(frames[7].name).toBe('custom_7');
  });

  it('re-slicing replaces old frames', async () => {
    const pngBytes = makePngBytes(130, 64);
    await fs.writeFile('/tmp/sprite.png', pngBytes);

    const importResult = await session.execute('importAsset', {
      sourcePath: '/tmp/sprite.png',
      name: 'ReSlice',
      type: 'sprite',
    });
    const assetId = importResult.data!.asset.id;

    // First slice: 32×32 frames
    await session.execute('sliceSpritesheet', {
      asset: assetId,
      frameWidth: 32,
      frameHeight: 32,
    });

    let asset = session.store.getAsset(assetId);
    let frames = getSheetFrames(asset!);
    expect(frames).toHaveLength(8);

    // Second slice: 64×64 frames
    await session.execute('sliceSpritesheet', {
      asset: assetId,
      frameWidth: 64,
      frameHeight: 64,
    });

    asset = session.store.getAsset(assetId);
    frames = getSheetFrames(asset!);
    // 130÷64 = 2 cols, 64÷64 = 1 row, so 2 frames
    expect(frames).toHaveLength(2);
    expect(frames[0].width).toBe(64);
    expect(frames[0].height).toBe(64);
  });

  it('stores grid metadata', async () => {
    const pngBytes = makePngBytes(130, 64);
    await fs.writeFile('/tmp/sprite.png', pngBytes);

    const importResult = await session.execute('importAsset', {
      sourcePath: '/tmp/sprite.png',
      name: 'GridTest',
      type: 'sprite',
    });
    const assetId = importResult.data!.asset.id;

    await session.execute('sliceSpritesheet', {
      asset: assetId,
      frameWidth: 32,
      frameHeight: 32,
      margin: 1,
      spacing: 2,
    });

    const asset = session.store.getAsset(assetId);
    expect(asset!.metadata.grid).toEqual({
      frameWidth: 32,
      frameHeight: 32,
      margin: 1,
      spacing: 2,
    });
  });

  it('errors: asset not found', async () => {
    const result = await session.execute('sliceSpritesheet', {
      asset: 'ast_nonexistent',
      frameWidth: 32,
      frameHeight: 32,
    });

    expect(result.success).toBe(false);
    expect(result.errors[0]?.code).toBe('NOT_FOUND');
  });

  it('errors: asset type is audio (not sprite/tile)', async () => {
    const wavBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // 'RIFF'
      0x24, 0x00, 0x00, 0x00, // size
      0x57, 0x41, 0x56, 0x45, // 'WAVE'
    ]);
    await fs.writeFile('/tmp/sound.wav', wavBytes);

    const importResult = await session.execute('importAsset', {
      sourcePath: '/tmp/sound.wav',
      name: 'TestSound',
      type: 'audio',
    });
    const assetId = importResult.data!.asset.id;

    const result = await session.execute('sliceSpritesheet', {
      asset: assetId,
      frameWidth: 32,
      frameHeight: 32,
    });

    expect(result.success).toBe(false);
    expect(result.errors[0]?.code).toBe('INVALID_INPUT');
  });

  it('errors: frame larger than image', async () => {
    const pngBytes = makePngBytes(64, 32);
    await fs.writeFile('/tmp/sprite.png', pngBytes);

    const importResult = await session.execute('importAsset', {
      sourcePath: '/tmp/sprite.png',
      name: 'SmallSprite',
      type: 'sprite',
    });
    const assetId = importResult.data!.asset.id;

    const result = await session.execute('sliceSpritesheet', {
      asset: assetId,
      frameWidth: 999,
      frameHeight: 32,
    });

    expect(result.success).toBe(false);
    expect(result.errors[0]?.code).toBe('INVALID_INPUT');
  });

  it('errors: dimensionless SVG', async () => {
    const svgText = '<svg><circle r="16"/></svg>';
    const svgBytes = new TextEncoder().encode(svgText);
    await fs.writeFile('/tmp/sprite.svg', svgBytes);

    const importResult = await session.execute('importAsset', {
      sourcePath: '/tmp/sprite.svg',
      name: 'DimensionlessSvg',
      type: 'sprite',
    });
    const assetId = importResult.data!.asset.id;

    const result = await session.execute('sliceSpritesheet', {
      asset: assetId,
      frameWidth: 32,
      frameHeight: 32,
    });

    expect(result.success).toBe(false);
    expect(result.errors[0]?.code).toBe('INVALID_INPUT');
  });

  describe('getSheetFrames', () => {
    it('returns [] for unsliced asset', async () => {
      const pngBytes = makePngBytes(130, 64);
      await fs.writeFile('/tmp/sprite.png', pngBytes);

      const importResult = await session.execute('importAsset', {
        sourcePath: '/tmp/sprite.png',
        name: 'UnslicedSprite',
        type: 'sprite',
      });
      const assetId = importResult.data!.asset.id;
      const asset = session.store.getAsset(assetId);

      const frames = getSheetFrames(asset!);
      expect(frames).toEqual([]);
    });

    it('returns [] for corrupt metadata.frames', async () => {
      const pngBytes = makePngBytes(130, 64);
      await fs.writeFile('/tmp/sprite.png', pngBytes);

      const importResult = await session.execute('importAsset', {
        sourcePath: '/tmp/sprite.png',
        name: 'CorruptSprite',
        type: 'sprite',
      });
      const assetId = importResult.data!.asset.id;
      const asset = session.store.getAsset(assetId);
      asset!.metadata.frames = 'nope';

      const frames = getSheetFrames(asset!);
      expect(frames).toEqual([]);
    });
  });

  describe('findSheetFrame', () => {
    it('finds frame by exact name', async () => {
      const pngBytes = makePngBytes(130, 64);
      await fs.writeFile('/tmp/sprite.png', pngBytes);

      const importResult = await session.execute('importAsset', {
        sourcePath: '/tmp/sprite.png',
        name: 'FindTest',
        type: 'sprite',
      });
      const assetId = importResult.data!.asset.id;

      await session.execute('sliceSpritesheet', {
        asset: assetId,
        frameWidth: 32,
        frameHeight: 32,
      });

      const asset = session.store.getAsset(assetId);
      const frame = findSheetFrame(asset!, 'findtest_3');
      expect(frame).toBeDefined();
      expect(frame!.name).toBe('findtest_3');
      expect(frame!.x).toBe(96); // col 3
      expect(frame!.y).toBe(0); // row 0
    });

    it('returns null when frame not found', async () => {
      const pngBytes = makePngBytes(130, 64);
      await fs.writeFile('/tmp/sprite.png', pngBytes);

      const importResult = await session.execute('importAsset', {
        sourcePath: '/tmp/sprite.png',
        name: 'NoFrame',
        type: 'sprite',
      });
      const assetId = importResult.data!.asset.id;

      await session.execute('sliceSpritesheet', {
        asset: assetId,
        frameWidth: 32,
        frameHeight: 32,
      });

      const asset = session.store.getAsset(assetId);
      const frame = findSheetFrame(asset!, 'noframe_999');
      expect(frame).toBeNull();
    });
  });
});
