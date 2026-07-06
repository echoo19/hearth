/**
 * Deterministic camera effects: CameraEffectsState in isolation, its wiring
 * into SceneRuntime's fixed-step loop + ctx.camera, and GameSession's
 * fade-carries-shake-doesn't behavior across a scene switch.
 */
import { describe, it, expect } from 'vitest';
import type { ProjectStore } from '@hearth/core';
import {
  CameraEffectsState,
  GameSession,
  SceneRuntime,
  type CameraEffectRecord,
} from '@hearth/runtime';
import { makeStore, ent } from './helpers.js';

const noop = () => {
  throw new Error('unexpected onError');
};

describe('CameraEffectsState (standalone)', () => {
  it('shake is seeded and deterministic: same seed, identical offset per frame across 30 steps', () => {
    const a = new CameraEffectsState({ seed: 42 });
    const b = new CameraEffectsState({ seed: 42 });
    a.shake(10, 5); // long enough to still be running after 30 steps @ dt=1/60
    b.shake(10, 5);
    for (let i = 0; i < 30; i++) {
      a.step(1 / 60, i, noop);
      b.step(1 / 60, i, noop);
      expect(a.offset).toEqual(b.offset);
    }
    expect(a.activeCount).toBe(1);
  });

  it('different seeds diverge', () => {
    const a = new CameraEffectsState({ seed: 1 });
    const b = new CameraEffectsState({ seed: 2 });
    a.shake(10, 5);
    b.shake(10, 5);
    a.step(1 / 60, 0, noop);
    b.step(1 / 60, 0, noop);
    expect(a.offset).not.toEqual(b.offset);
  });

  it('flash completes and activeCount drops', () => {
    const state = new CameraEffectsState({ seed: 0 });
    state.flash('#ffffff', 0.1);
    expect(state.activeCount).toBe(1);
    // Partway through: still active.
    for (let i = 0; i < 3; i++) state.step(1 / 60, i, noop);
    expect(state.activeCount).toBe(1);
    expect(state.overlay.alpha).toBeGreaterThan(0);
    // Comfortably past the 0.1s duration (with margin for float rounding).
    for (let i = 3; i < 10; i++) state.step(1 / 60, i, noop);
    expect(state.activeCount).toBe(0);
    expect(state.overlay.alpha).toBe(0);
  });

  it('fade holds the target after completion and fires onComplete exactly once', () => {
    let completions = 0;
    const state = new CameraEffectsState({ seed: 0 });
    state.fade(0.8, 0.2, { color: '#000000', onComplete: () => completions++ });
    // 0.2s at dt=1/10 → exactly 2 steps to reach t=1.
    state.step(0.1, 0, noop);
    expect(state.overlay.alpha).toBeCloseTo(0.4, 5); // 0 + (0.8-0) * easeInOut(0.5) = 0.8 * 0.5
    state.step(0.1, 1, noop);
    expect(state.overlay.alpha).toBeCloseTo(0.8, 10);
    expect(completions).toBe(1);
    // Holds for further steps; onComplete never fires again.
    for (let i = 2; i < 10; i++) state.step(0.1, i, noop);
    expect(state.overlay.alpha).toBeCloseTo(0.8, 10);
    expect(completions).toBe(1);
    expect(state.overlay.color).toBe('#000000');
  });

  it('zoomPunch returns to exactly 1', () => {
    const state = new CameraEffectsState({ seed: 0 });
    state.zoomPunch(1.5, 0.1);
    expect(state.zoomMul).toBe(1); // no step yet
    state.step(0.05, 0, noop);
    expect(state.zoomMul).toBeGreaterThan(1);
    state.step(0.05, 1, noop);
    expect(state.zoomMul).toBe(1);
    state.step(0.05, 2, noop);
    expect(state.zoomMul).toBe(1);
  });

  it('records are emitted with the frame passed to the step that flushes them', () => {
    const records: CameraEffectRecord[] = [];
    const state = new CameraEffectsState({ seed: 0, onRecord: (r) => records.push(r) });
    state.shake(5, 1);
    state.flash('#ff0000', 1);
    state.step(1 / 60, 7, noop);
    expect(records).toEqual([
      { effect: 'shake', frame: 7, params: { intensity: 5, seconds: 1, seed: expect.any(Number) } },
      { effect: 'flash', frame: 7, params: { color: '#ff0000', seconds: 1 } },
    ]);
    state.fade(1, 1);
    state.step(1 / 60, 8, noop);
    expect(records[2]).toEqual({ effect: 'fade', frame: 8, params: { alpha: 1, seconds: 1 } });
  });

  it('starts with an initialOverlay and carries it as the persistent fade level', () => {
    const state = new CameraEffectsState({ seed: 0, initialOverlay: { color: '#112233', alpha: 0.4 } });
    expect(state.overlay).toEqual({ color: '#112233', alpha: 0.4 });
    expect(state.activeCount).toBe(0);
    state.step(1 / 60, 0, noop);
    expect(state.overlay).toEqual({ color: '#112233', alpha: 0.4 }); // holds, no fade in flight
  });
});

describe('ctx.camera effects wired through SceneRuntime', () => {
  it('shake/flash/fade/zoomPunch delegate to runtime.cameraEffects', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Hero', {
          Transform: {},
          Script: { scriptPath: 'scripts/hero.js' },
        }),
      ],
      scripts: {
        'hero.js': `export default {
          onStart(ctx) {
            ctx.camera.shake(10, 1);
            ctx.camera.flash('#ffffff', 0.5);
            ctx.camera.fade(1, 0.5);
            ctx.camera.zoomPunch(1.5, 0.5);
          },
        };`,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.step();
    expect(runtime.cameraEffects.activeCount).toBe(4);
    expect(runtime.cameraEffects.zoomMul).toBeGreaterThan(1);
    expect(runtime.cameraEffects.overlay.alpha).toBeGreaterThan(0);
    expect(runtime.errors).toEqual([]);
  });
});

describe('GameSession: camera effects across a scene switch', () => {
  async function makeTwoSceneStore(): Promise<ProjectStore> {
    const { store } = await makeStore({
      entities: [
        ent('Menu', {
          Transform: {},
          Script: { scriptPath: 'scripts/menu.js' },
        }),
      ],
      scripts: {
        'menu.js': `export default {
          onStart(ctx) {
            ctx.camera.fade(0.6, 0.001, { color: '#000000' });
            ctx.camera.shake(20, 10);
          },
          onUpdate(ctx) { if (ctx.time.frame === 2) ctx.scenes.load('Level'); },
        };`,
        'hero.js': `export default { onStart(ctx) { ctx.log('hero-start'); } };`,
      },
      extraScenes: [
        {
          id: 'scn_level',
          name: 'Level',
          entities: [ent('Hero', { Transform: {}, Script: { scriptPath: 'scripts/hero.js' } })],
        },
      ],
    });
    return store;
  }

  it('carries the persistent fade level across the switch; mid-flight shake does not', async () => {
    const store = await makeTwoSceneStore();
    const session = await GameSession.create(store);
    for (let i = 0; i < 5; i++) await session.stepAsync();

    expect(session.currentSceneId).toBe('scn_level');
    // Fade (0.001s duration) completed well before the switch at frame ~3.
    expect(session.runtime.cameraEffects.overlay).toEqual({ color: '#000000', alpha: 0.6 });
    // Shake (10s duration) was still mid-flight — must not carry.
    expect(session.runtime.cameraEffects.offset).toEqual({ x: 0, y: 0 });
    expect(session.runtime.cameraEffects.activeCount).toBe(0);
    session.destroy();
  });

  it('accumulates cameraEffects records across scenes, exactly like audioEvents', async () => {
    const store = await makeTwoSceneStore();
    const session = await GameSession.create(store);
    for (let i = 0; i < 5; i++) await session.stepAsync();

    const kinds = session.cameraEffects.map((r) => r.effect);
    expect(kinds).toContain('fade');
    expect(kinds).toContain('shake');
    expect(session.cameraEffects.every((r) => typeof r.frame === 'number')).toBe(true);
    session.destroy();
  });
});
