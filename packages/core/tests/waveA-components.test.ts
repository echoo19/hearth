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

  it('ParticleEmitter with rate=0 && burst=0 warns', async () => {
    const { session, store } = await makeSession();
    await session.execute('createEntity', {
      scene: 'Main',
      name: 'Dead Emitter',
      components: { ParticleEmitter: { rate: 0, burst: 0 } },
    });

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
});
