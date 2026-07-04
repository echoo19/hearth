import { describe, it, expect, beforeEach } from 'vitest';
import {
  MemoryFileSystem,
  createProject,
  HearthSession,
  readJson,
} from '@hearth/core';
import { validateProject } from '../src/validate.js';

describe('createAnimationFromSheet', () => {
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
    return new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff, // width
      (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff, // height
      0x08, 0x02, 0x00, 0x00, 0x00, // color type, compression, filter
      0x12, 0x34, 0x56, 0x78, // CRC
    ]);
  }

  async function makeSlicedSheet(name = 'Hero') {
    const pngBytes = makePngBytes(130, 64);
    await fs.writeFile('/tmp/sprite.png', pngBytes);

    const importResult = await session.execute('importAsset', {
      sourcePath: '/tmp/sprite.png',
      name,
      type: 'sprite',
    });
    const assetId = importResult.data!.asset.id;

    await session.execute('sliceSpritesheet', {
      asset: assetId,
      frameWidth: 32,
      frameHeight: 32,
    });

    return assetId;
  }

  it('creates an animation from named frames, writing <sheetId>#<frameName> refs', async () => {
    const sheetId = await makeSlicedSheet('Hero');

    const result = await session.execute('createAnimationFromSheet', {
      name: 'HeroWalk',
      sheet: 'Hero', // referenced by name, not id
      frames: ['hero_0', 'hero_1', 'hero_2'],
    });

    expect(result.success).toBe(true);
    const data = result.data!;
    expect(data.asset.name).toBe('HeroWalk');
    expect(data.frames).toEqual([
      `${sheetId}#hero_0`,
      `${sheetId}#hero_1`,
      `${sheetId}#hero_2`,
    ]);

    // Read back the .anim.json from disk
    const asset = session.store.getAsset(data.asset.id)!;
    const written: any = await readJson(fs, `/proj/${asset.path}`);
    expect(written.frames).toEqual([
      `${sheetId}#hero_0`,
      `${sheetId}#hero_1`,
      `${sheetId}#hero_2`,
    ]);
    expect(written.frameDuration).toBe(0.15);
    expect(written.loop).toBe(true);
  });

  it('carries frameCount, frameDuration, loop, and sheet in asset metadata', async () => {
    const sheetId = await makeSlicedSheet('Hero');

    const result = await session.execute('createAnimationFromSheet', {
      name: 'HeroWalk',
      sheet: sheetId,
      frames: ['hero_0', 'hero_1'],
      frameDuration: 0.2,
      loop: false,
    });

    expect(result.success).toBe(true);
    const asset = session.store.getAsset(result.data!.asset.id)!;
    expect(asset.metadata.frameCount).toBe(2);
    expect(asset.metadata.frameDuration).toBe(0.2);
    expect(asset.metadata.loop).toBe(false);
    expect(asset.metadata.sheet).toBe(sheetId);
  });

  it('errors: missing frame names -> INVALID_INPUT listing them', async () => {
    await makeSlicedSheet('Hero');

    const result = await session.execute('createAnimationFromSheet', {
      name: 'HeroWalk',
      sheet: 'Hero',
      frames: ['hero_0', 'nope_1', 'nope_2'],
    });

    expect(result.success).toBe(false);
    expect(result.errors[0]?.code).toBe('INVALID_INPUT');
    expect(result.errors[0]?.message).toContain('nope_1');
    expect(result.errors[0]?.message).toContain('nope_2');
  });

  it('errors: unsliced sheet -> INVALID_INPUT', async () => {
    const pngBytes = makePngBytes(130, 64);
    await fs.writeFile('/tmp/sprite2.png', pngBytes);
    const importResult = await session.execute('importAsset', {
      sourcePath: '/tmp/sprite2.png',
      name: 'Unsliced',
      type: 'sprite',
    });
    const assetId = importResult.data!.asset.id;

    const result = await session.execute('createAnimationFromSheet', {
      name: 'HeroWalk',
      sheet: assetId,
      frames: ['unsliced_0'],
    });

    expect(result.success).toBe(false);
    expect(result.errors[0]?.code).toBe('INVALID_INPUT');
  });

  it('errors: unknown sheet -> NOT_FOUND', async () => {
    const result = await session.execute('createAnimationFromSheet', {
      name: 'HeroWalk',
      sheet: 'ast_nonexistent',
      frames: ['hero_0'],
    });

    expect(result.success).toBe(false);
    expect(result.errors[0]?.code).toBe('NOT_FOUND');
  });

  describe('ANIMATION_FRAME_NOT_FOUND validation', () => {
    it('warns when an animation frame ref does not resolve', async () => {
      const sheetId = await makeSlicedSheet('Hero');
      await session.execute('createAnimationFromSheet', {
        name: 'HeroWalk',
        sheet: sheetId,
        frames: ['hero_0', 'hero_1'],
      });

      // Corrupt the written .anim.json with a bad frame ref.
      const asset = session.store.assets.assets.find((a) => a.name === 'HeroWalk')!;
      const absPath = `/proj/${asset.path}`;
      const data: any = await readJson(fs, absPath);
      data.frames.push(`${sheetId}#does_not_exist`);
      await fs.writeFile(absPath, JSON.stringify(data, null, 2) + '\n');

      const validation = await validateProject(session.store);
      const warning = validation.warnings.find((w) => w.code === 'ANIMATION_FRAME_NOT_FOUND');
      expect(warning).toBeTruthy();
      expect(warning?.message).toContain('does_not_exist');
      expect(warning?.asset).toBe(asset.id);
    });

    it('warns when the sheet asset itself is missing', async () => {
      const sheetId = await makeSlicedSheet('Hero');
      await session.execute('createAnimationFromSheet', {
        name: 'HeroWalk',
        sheet: sheetId,
        frames: ['hero_0'],
      });

      const asset = session.store.assets.assets.find((a) => a.name === 'HeroWalk')!;
      const absPath = `/proj/${asset.path}`;
      const data: any = await readJson(fs, absPath);
      data.frames = ['ast_totally_bogus#hero_0'];
      await fs.writeFile(absPath, JSON.stringify(data, null, 2) + '\n');

      const validation = await validateProject(session.store);
      const warning = validation.warnings.find((w) => w.code === 'ANIMATION_FRAME_NOT_FOUND');
      expect(warning).toBeTruthy();
      expect(warning?.asset).toBe(asset.id);
    });

    it('does not warn when all frame refs resolve', async () => {
      const sheetId = await makeSlicedSheet('Hero');
      await session.execute('createAnimationFromSheet', {
        name: 'HeroWalk',
        sheet: sheetId,
        frames: ['hero_0', 'hero_1', 'hero_2'],
      });

      const validation = await validateProject(session.store);
      const warning = validation.warnings.find((w) => w.code === 'ANIMATION_FRAME_NOT_FOUND');
      expect(warning).toBeUndefined();
    });

    it('does not warn on legacy plain (non-#) frame refs', async () => {
      // createAnimationAsset writes plain sprite-asset-id refs, no '#'.
      const pngBytes = makePngBytes(32, 32);
      await fs.writeFile('/tmp/frame.png', pngBytes);
      const frameImport = await session.execute('importAsset', {
        sourcePath: '/tmp/frame.png',
        name: 'FrameSprite',
        type: 'sprite',
      });
      const frameAssetId = frameImport.data!.asset.id;

      await session.execute('createAnimationAsset', {
        name: 'PlainAnim',
        frames: [frameAssetId],
      });

      const validation = await validateProject(session.store);
      const warning = validation.warnings.find((w) => w.code === 'ANIMATION_FRAME_NOT_FOUND');
      expect(warning).toBeUndefined();
    });
  });
});
