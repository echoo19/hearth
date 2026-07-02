/**
 * SceneRuntime core: instantiation, queries, camera, hierarchy, and the
 * InputState action mapping.
 */
import { describe, it, expect } from 'vitest';
import { InputState, SceneRuntime } from '@hearth/runtime';
import { makeStore, ent } from './helpers.js';

describe('scene instantiation', () => {
  it('deep-copies entities and never mutates the authored scene', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Player', {
          Transform: { position: { x: 10, y: 20 } },
          PhysicsBody: { bodyType: 'dynamic' },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(30); // falls under gravity
    const authored = store.getScene('Test')!.entities[0];
    expect(authored.components.Transform!.position).toEqual({ x: 10, y: 20 });
    expect(runtime.find('Player')!.transform.position.y).toBeGreaterThan(20);
  });

  it('skips entities with enabled=false and defaults a missing Transform', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Visible', {}),
        ent('Hidden', {}, { enabled: false }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    expect(runtime.getEntities().map((e) => e.name)).toEqual(['Visible']);
    expect(runtime.find('Hidden')).toBeUndefined();
    expect(runtime.find('Visible')!.transform.position).toEqual({ x: 0, y: 0 });
  });

  it('finds entities by id, name, and tag', async () => {
    const { store } = await makeStore({
      entities: [ent('Coin', {}, { id: 'ent_coin1', tags: ['loot', 'coin'] })],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    expect(runtime.find('ent_coin1')?.name).toBe('Coin');
    expect(runtime.find('Coin')?.id).toBe('ent_coin1');
    expect(runtime.findByTag('loot').length).toBe(1);
    expect(runtime.findByTag('nope')).toEqual([]);
  });

  it('throws for an unknown scene', async () => {
    const { store } = await makeStore({ entities: [] });
    await expect(SceneRuntime.create(store, 'Nope')).rejects.toThrow(/Scene not found/);
  });

  it('tracks frame, elapsed, and fixedDt from build settings', async () => {
    const { store } = await makeStore({ entities: [] });
    const runtime = await SceneRuntime.create(store, 'Test');
    expect(runtime.fixedDt).toBeCloseTo(1 / 60, 6);
    runtime.run(30);
    expect(runtime.frame).toBe(30);
    expect(runtime.elapsed).toBeCloseTo(0.5, 6);
  });
});

describe('hierarchy', () => {
  it('children inherit parent translation in world position', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Parent', { Transform: { position: { x: 100, y: 100 } } }, { id: 'ent_parent' }),
        ent('Child', { Transform: { position: { x: 10, y: 5 } } }, { parentId: 'ent_parent' }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    expect(runtime.getWorldPosition(runtime.find('Child')!)).toEqual({ x: 110, y: 105 });
  });
});

describe('camera', () => {
  it('exposes the main camera position, zoom, and background', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Cam', {
          Transform: { position: { x: 100, y: 50 } },
          Camera: { zoom: 2, isMain: true, backgroundColor: '#123456' },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    expect(runtime.camera).toEqual({
      position: { x: 100, y: 50 },
      zoom: 2,
      backgroundColor: '#123456',
    });
  });

  it('falls back to build settings when no camera entity exists', async () => {
    const { store } = await makeStore({ entities: [] });
    const runtime = await SceneRuntime.create(store, 'Test');
    expect(runtime.camera).toEqual({
      position: { x: 400, y: 300 },
      zoom: 1,
      backgroundColor: '#1a1a2e',
    });
  });
});

describe('InputState', () => {
  it('maps KeyboardEvent.code to actions', () => {
    const input = new InputState({ left: ['ArrowLeft', 'KeyA'], jump: ['Space'] });
    input.handleKeyDown('KeyA');
    expect(input.isDown('left')).toBe(true);
    expect(input.justPressed('left')).toBe(true);
    expect(input.isDown('jump')).toBe(false);
    expect(input.isMappedCode('Space')).toBe(true);
    expect(input.isMappedCode('KeyZ')).toBe(false);
  });

  it('clears justPressed on endFrame but keeps isDown', () => {
    const input = new InputState({ jump: ['Space'] });
    input.handleKeyDown('Space');
    input.endFrame();
    expect(input.isDown('jump')).toBe(true);
    expect(input.justPressed('jump')).toBe(false);
    // OS key repeat must not re-trigger justPressed.
    input.handleKeyDown('Space');
    expect(input.justPressed('jump')).toBe(false);
  });

  it('keeps an action down while any mapped key is held', () => {
    const input = new InputState({ left: ['ArrowLeft', 'KeyA'] });
    input.handleKeyDown('ArrowLeft');
    input.handleKeyDown('KeyA');
    input.handleKeyUp('ArrowLeft');
    expect(input.isDown('left')).toBe(true);
    input.handleKeyUp('KeyA');
    expect(input.isDown('left')).toBe(false);
  });

  it('supports programmatic action control', () => {
    const input = new InputState({ right: ['ArrowRight'] });
    input.setActionDown('right');
    expect(input.isDown('right')).toBe(true);
    expect(input.justPressed('right')).toBe(true);
    input.endFrame();
    input.setActionUp('right');
    expect(input.isDown('right')).toBe(false);
  });
});
