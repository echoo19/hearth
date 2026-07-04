/**
 * SpriteRenderer.frame: sheet-frame refs threaded through stepAnimator and
 * the runtime's stepAnimators, end to end.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession } from '@hearth/core';
import { SceneRuntime } from '@hearth/runtime';
import { stepAnimator, createAnimatorState } from '../src/animator.js';

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

describe('stepAnimator: sheet-ref vs plain-ref frames (pure)', () => {
  it('splits a sheet ref into {assetId, frame} and advances through frame names', () => {
    const state = createAnimatorState('ast_walk');
    const component = { assetId: 'ast_walk', fps: 0, playing: true, loop: true };
    const asset = { frames: ['ast_a#walk_0', 'ast_a#walk_1'], frameDuration: 0.1, loop: true };

    expect(stepAnimator(state, component, asset, 0)).toEqual({ assetId: 'ast_a', frame: 'walk_0' });
    expect(stepAnimator(state, component, asset, 0.1)).toEqual({ assetId: 'ast_a', frame: 'walk_1' });
  });

  it('returns frame: null for a plain (non-sheet) sprite-asset-id entry', () => {
    const state = createAnimatorState('ast_plain');
    const component = { assetId: 'ast_plain', fps: 0, playing: true, loop: true };
    const asset = { frames: ['ast_b'], frameDuration: 0.1, loop: true };

    expect(stepAnimator(state, component, asset, 0)).toEqual({ assetId: 'ast_b', frame: null });
  });
});

describe('runtime: SpriteRenderer.frame cycling through a sliced sheet', () => {
  async function makeAnimatedSheetProject() {
    const fs = new MemoryFileSystem();
    const { store } = await createProject(fs, '/proj', { name: 'Test' });
    const session = HearthSession.fromStore(store);

    const sheetPng = makePngBytes(130, 64);
    await fs.writeFile('/tmp/hero.png', sheetPng);
    const sheetImport = await session.execute('importAsset', {
      sourcePath: '/tmp/hero.png',
      name: 'Hero',
      type: 'sprite',
    });
    const sheetId = sheetImport.data!.asset.id;
    await session.execute('sliceSpritesheet', { asset: sheetId, frameWidth: 32, frameHeight: 32 });

    const walkResult = await session.execute('createAnimationFromSheet', {
      name: 'HeroWalk',
      sheet: sheetId,
      frames: ['hero_0', 'hero_1', 'hero_2'],
      frameDuration: 0.1,
    });
    const walkAnimId = walkResult.data!.asset.id;

    const plainPng = makePngBytes(32, 32);
    await fs.writeFile('/tmp/plain.png', plainPng);
    const plainImport = await session.execute('importAsset', {
      sourcePath: '/tmp/plain.png',
      name: 'PlainSprite',
      type: 'sprite',
    });
    const plainSpriteId = plainImport.data!.asset.id;
    const idleResult = await session.execute('createAnimationAsset', {
      name: 'Idle',
      frames: [plainSpriteId],
      frameDuration: 0.1,
    });
    const idleAnimId = idleResult.data!.asset.id;

    await session.execute('createEntity', {
      scene: 'Main',
      name: 'Animator',
      components: {
        SpriteRenderer: { assetId: sheetId, frame: 'hero_0' },
        SpriteAnimator: { assetId: walkAnimId },
        Script: { scriptPath: 'scripts/switch.js' },
      },
    });
    await fs.writeFile(
      '/proj/scripts/switch.js',
      `export default {
        onUpdate(ctx) {
          if (ctx.time.frame === 30) ctx.animate('${idleAnimId}');
        },
      };`,
    );

    return { store, sheetId, plainSpriteId };
  }

  function spriteRenderer(rt: SceneRuntime) {
    return rt.find('Animator')!.components.SpriteRenderer!;
  }

  it('advances SpriteRenderer.frame through sheet frame names each fixed step', async () => {
    const { store, sheetId } = await makeAnimatedSheetProject();
    const rt = await SceneRuntime.create(store, 'Main');

    expect(spriteRenderer(rt).assetId).toBe(sheetId);
    expect(spriteRenderer(rt).frame).toBe('hero_0');

    rt.run(6); // 0.1s -> next frame
    expect(spriteRenderer(rt).assetId).toBe(sheetId);
    expect(spriteRenderer(rt).frame).toBe('hero_1');

    rt.run(6);
    expect(spriteRenderer(rt).frame).toBe('hero_2');

    rt.run(6); // loop wraps
    expect(spriteRenderer(rt).frame).toBe('hero_0');
  });

  it('switching to a plain (non-sheet) animation resets SpriteRenderer.frame to null', async () => {
    const { store, plainSpriteId } = await makeAnimatedSheetProject();
    const rt = await SceneRuntime.create(store, 'Main');

    rt.run(31); // steps 0..30; step 30's onUpdate triggers ctx.animate('Idle') and is reflected the same step
    expect(spriteRenderer(rt).assetId).toBe(plainSpriteId);
    expect(spriteRenderer(rt).frame).toBeNull();
  });
});
