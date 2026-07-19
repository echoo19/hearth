import { describe, expect, it } from 'vitest';
import {
  COMPONENT_SCHEMAS,
  COMPONENT_DOCS,
  createComponent,
  isComponentType,
} from '../src/schema/components.js';
import { validateProject } from '../src/validate.js';
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

describe('Wave A component schemas', () => {
  it('registers the four new component types with docs', () => {
    for (const type of ['Light2D', 'LineRenderer', 'ParticleEmitter', 'SpriteAnimator'] as const) {
      expect(isComponentType(type)).toBe(true);
      expect(COMPONENT_DOCS[type]).toBeTruthy();
    }
  });

  it('Light2D defaults', () => {
    expect(createComponent('Light2D')).toEqual({
      radius: 200, color: '#ffffff', intensity: 1, enabled: true,
    });
  });

  it('LineRenderer defaults', () => {
    expect(createComponent('LineRenderer')).toEqual({
      points: [], width: 2, color: '#ffffff', closed: false,
      opacity: 1, layer: 0, visible: true,
    });
  });

  it('ParticleEmitter defaults are deterministic-ready', () => {
    const e = createComponent('ParticleEmitter');
    expect(e).toEqual({
      emitting: true, rate: 10, burst: 0, lifetime: 1, speed: 100,
      spread: 30, direction: 0, gravity: { x: 0, y: 0 },
      startColor: '#ffffff', endColor: '#ffffff', startSize: 8, endSize: 0,
      maxParticles: 256, layer: 0, seed: 0,
    });
  });

  it('SpriteAnimator defaults', () => {
    expect(createComponent('SpriteAnimator')).toEqual({
      assetId: '', fps: 0, playing: true, loop: true,
    });
  });

  it('Camera gains ambientLight defaulting to 1 (fully lit)', () => {
    expect(createComponent('Camera').ambientLight).toBe(1);
  });

  it('clamps ambientLight and rejects bad colors', () => {
    expect(() => createComponent('Camera', { ambientLight: 2 })).toThrow();
    expect(() => createComponent('Light2D', { color: 'red' })).toThrow();
  });

  it('PhysicsBody defaults include mass/restitution/friction', () => {
    expect(createComponent('PhysicsBody')).toEqual({
      bodyType: 'dynamic',
      velocity: { x: 0, y: 0 },
      gravityScale: 1,
      drag: 0,
      mass: 1,
      restitution: 0,
      friction: 0,
    });
  });

  it('PhysicsBody mass must be positive', () => {
    expect(() => createComponent('PhysicsBody', { mass: 0 })).toThrow();
  });

  it('PhysicsBody restitution clamped to 0-1', () => {
    expect(() => createComponent('PhysicsBody', { restitution: 1.5 })).toThrow();
    expect(() => createComponent('PhysicsBody', { restitution: -0.1 })).toThrow();
  });

  it('PhysicsBody friction clamped to 0-1', () => {
    expect(() => createComponent('PhysicsBody', { friction: 1.5 })).toThrow();
    expect(() => createComponent('PhysicsBody', { friction: -0.1 })).toThrow();
  });

  it('Collider defaults include layer/collidesWith/oneWay', () => {
    expect(createComponent('Collider')).toMatchObject({
      layer: 'default',
      collidesWith: ['*'],
      oneWay: false,
    });
  });

  it('Collider layer must be non-empty string', () => {
    expect(() => createComponent('Collider', { layer: '' })).toThrow();
  });
});

describe('Wave A validation rules', () => {
  it('LineRenderer with <2 points warns', async () => {
    const { session, store } = await makeSession();
    await session.execute('createEntity', {
      scene: 'Main',
      name: 'Lonely Line',
      components: { LineRenderer: { points: [] } },
    });

    const validation = await validateProject(store);
    expect(validation.warnings.some((w) => w.code === 'LINERENDERER_TOO_FEW_POINTS')).toBe(true);
  });

  it('ParticleEmitter with rate=0 && burst=0 (burst-only mode) does NOT warn', async () => {
    // rate=0 is a legitimate, common juice pattern: the emitter is fired at
    // runtime via ctx.particles.burst. Flagging it produced 38 noise warnings
    // in a real project and taught agents to ignore validate.
    const { session, store } = await makeSession();
    await session.execute('createEntity', {
      scene: 'Main',
      name: 'Burst Emitter',
      components: { ParticleEmitter: { rate: 0, burst: 0 } },
    });

    const validation = await validateProject(store);
    expect(validation.warnings.some((w) => w.code === 'PARTICLE_EMITTER_EMITS_NOTHING')).toBe(false);
  });

  it('ParticleEmitter that can never emit (maxParticles<=0) warns', async () => {
    const { session, store } = await makeSession();
    await session.execute('createEntity', {
      scene: 'Main',
      name: 'Inert Emitter',
      components: { ParticleEmitter: { rate: 10 } },
    });
    // maxParticles is schema-constrained positive; force the genuinely-inert
    // state directly on the model to simulate a hand-edited/corrupt project.
    const scene = store.getScene('Main')!;
    const ent = scene.entities.find((e) => e.name === 'Inert Emitter')!;
    (ent.components.ParticleEmitter as any).maxParticles = 0;

    const validation = await validateProject(store);
    expect(validation.warnings.some((w) => w.code === 'PARTICLE_EMITTER_EMITS_NOTHING')).toBe(true);
  });

  it('SpriteAnimator without SpriteRenderer sibling warns', async () => {
    const { session, store } = await makeSession();
    await session.execute('createEntity', {
      scene: 'Main',
      name: 'No Renderer',
      components: { SpriteAnimator: { assetId: '' } },
    });

    const validation = await validateProject(store);
    expect(validation.warnings.some((w) => w.code === 'SPRITE_ANIMATOR_MISSING_RENDERER')).toBe(true);
  });

  it('SpriteAnimator with missing animation asset errors', async () => {
    const { session, store } = await makeSession();
    await session.execute('createEntity', {
      scene: 'Main',
      name: 'Bad Animation',
      components: {
        SpriteRenderer: { shape: 'rectangle' },
        SpriteAnimator: { assetId: 'anim_missing' },
      },
    });

    const validation = await validateProject(store);
    expect(validation.errors.some((e) => e.code === 'MISSING_ANIMATION_ASSET')).toBe(true);
  });

  it('SpriteAnimator with wrong asset type errors', async () => {
    const { session, store } = await makeSession();
    // Create a sprite asset (not animation type)
    await session.execute('createSpriteAsset', {
      name: 'Wrong Type Asset',
    });
    const wrongTypeAssetId = store.assets.assets[0]?.id;

    await session.execute('createEntity', {
      scene: 'Main',
      name: 'Wrong Asset Type',
      components: {
        SpriteRenderer: { shape: 'rectangle' },
        SpriteAnimator: { assetId: wrongTypeAssetId! },
      },
    });

    const validation = await validateProject(store);
    expect(validation.errors.some((e) => e.code === 'INVALID_ANIMATION_ASSET_TYPE')).toBe(true);
  });

  it('Collider with collidesWith: [] warns', async () => {
    const { session, store } = await makeSession();
    await session.execute('createEntity', {
      scene: 'Main',
      name: 'No Collisions',
      components: { Collider: { collidesWith: [] } },
    });

    const validation = await validateProject(store);
    expect(validation.warnings.some((w) => w.code === 'COLLIDER_COLLIDES_WITH_NOTHING')).toBe(true);
  });

  it('Collider with unknown collidesWith layer warns', async () => {
    const { session, store } = await makeSession();
    await session.execute('createEntity', {
      scene: 'Main',
      name: 'Unknown Layer',
      components: { Collider: { collidesWith: ['ghosts'] } },
    });

    const validation = await validateProject(store);
    const warning = validation.warnings.find((w) => w.code === 'COLLIDES_WITH_UNKNOWN_LAYER');
    expect(warning).toBeTruthy();
    expect(warning?.message).toContain('ghosts');
  });

  it('Collider with collidesWith: ["*"] never warns', async () => {
    const { session, store } = await makeSession();
    await session.execute('createEntity', {
      scene: 'Main',
      name: 'Default Collider',
      components: { Collider: { collidesWith: ['*'] } },
    });

    const validation = await validateProject(store);
    expect(validation.warnings.some((w) => w.code === 'COLLIDES_WITH_UNKNOWN_LAYER')).toBe(false);
  });

  it('Collider layer interaction is consistent across scenes', async () => {
    const { session, store } = await makeSession();
    // Create entity in Main scene with layer 'player'
    await session.execute('createEntity', {
      scene: 'Main',
      name: 'Player',
      components: { Collider: { layer: 'player' } },
    });
    // Create a second scene
    await session.execute('createScene', { name: 'Level2' });
    // Create entity in Level2 scene that references 'player' layer
    await session.execute('createEntity', {
      scene: 'Level2',
      name: 'Enemy',
      components: { Collider: { collidesWith: ['player'] } },
    });

    const validation = await validateProject(store);
    expect(validation.warnings.some((w) => w.code === 'COLLIDES_WITH_UNKNOWN_LAYER')).toBe(false);
  });
});

describe('SpriteRenderer.frame FRAME_NOT_FOUND validation', () => {
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

  async function makeSlicedSheet(session: HearthSession, fs: MemoryFileSystem, name = 'Hero') {
    const pngBytes = makePngBytes(130, 64);
    await fs.writeFile(`/tmp/${name}.png`, pngBytes);
    const importResult = await session.execute('importAsset', {
      sourcePath: `/tmp/${name}.png`,
      name,
      type: 'sprite',
    });
    const assetId = importResult.data!.asset.id;
    await session.execute('sliceSpritesheet', { asset: assetId, frameWidth: 32, frameHeight: 32 });
    return assetId;
  }

  it('warns when the referenced frame name is not on the sheet', async () => {
    const { session, store, fs } = await makeSession();
    const sheetId = await makeSlicedSheet(session, fs, 'Hero');
    await session.execute('createEntity', {
      scene: 'Main',
      name: 'Sprite',
      components: { SpriteRenderer: { assetId: sheetId, frame: 'hero_999' } },
    });

    const validation = await validateProject(store);
    const warning = validation.warnings.find((w) => w.code === 'FRAME_NOT_FOUND');
    expect(warning).toBeTruthy();
    expect(warning?.message).toContain('hero_999');
  });

  it('warns when assetId references an unsliced sprite', async () => {
    const { session, store, fs } = await makeSession();
    const pngBytes = makePngBytes(64, 64);
    await fs.writeFile('/tmp/Unsliced.png', pngBytes);
    const importResult = await session.execute('importAsset', {
      sourcePath: '/tmp/Unsliced.png',
      name: 'Unsliced',
      type: 'sprite',
    });
    const assetId = importResult.data!.asset.id;
    await session.execute('createEntity', {
      scene: 'Main',
      name: 'Sprite',
      components: { SpriteRenderer: { assetId, frame: 'anything' } },
    });

    const validation = await validateProject(store);
    expect(validation.warnings.some((w) => w.code === 'FRAME_NOT_FOUND')).toBe(true);
  });

  it('warns when assetId is missing/unknown', async () => {
    const { session, store } = await makeSession();
    await session.execute('createEntity', {
      scene: 'Main',
      name: 'Sprite',
      components: { SpriteRenderer: { assetId: 'ast_does_not_exist', frame: 'anything' } },
    });

    const validation = await validateProject(store);
    expect(validation.warnings.some((w) => w.code === 'FRAME_NOT_FOUND')).toBe(true);
  });

  it('does not warn when frame is null', async () => {
    const { session, store, fs } = await makeSession();
    const sheetId = await makeSlicedSheet(session, fs, 'Hero');
    await session.execute('createEntity', {
      scene: 'Main',
      name: 'Sprite',
      components: { SpriteRenderer: { assetId: sheetId, frame: null } },
    });

    const validation = await validateProject(store);
    expect(validation.warnings.some((w) => w.code === 'FRAME_NOT_FOUND')).toBe(false);
  });

  it('does not warn when the frame exists on the sheet', async () => {
    const { session, store, fs } = await makeSession();
    const sheetId = await makeSlicedSheet(session, fs, 'Hero');
    await session.execute('createEntity', {
      scene: 'Main',
      name: 'Sprite',
      components: { SpriteRenderer: { assetId: sheetId, frame: 'hero_0' } },
    });

    const validation = await validateProject(store);
    expect(validation.warnings.some((w) => w.code === 'FRAME_NOT_FOUND')).toBe(false);
  });
});
