/**
 * SpriteAnimator playback: frame stepping via SceneRuntime's fixed-step
 * loop, and ctx.animate from scripts.
 */
import { describe, it, expect } from 'vitest';
import { SceneRuntime, type RuntimeOptions } from '@hearth/runtime';
import { makeStore, ent } from './helpers.js';

const WALK = { frames: ['ast_wf0', 'ast_wf1', 'ast_wf2'], frameDuration: 0.1, loop: true };
const JUMP = { frames: ['ast_jf0', 'ast_jf1'], frameDuration: 0.2, loop: true };

/** One entity named 'Animator' playing WALK by default, plus overrides. */
async function makeRuntimeWithAnimator(
  animatorOverrides: Record<string, unknown> = {},
  runtimeOptions: RuntimeOptions = {},
): Promise<SceneRuntime> {
  const { store, fs } = await makeStore({
    entities: [
      ent('Animator', {
        Transform: {},
        SpriteRenderer: { assetId: 'ast_wf0' },
        SpriteAnimator: { assetId: 'ast_walk', ...animatorOverrides },
      }),
    ],
    assets: [
      { id: 'ast_walk', name: 'walk', type: 'animation', path: 'assets/animations/walk.anim.json' },
      { id: 'ast_jump', name: 'jump', type: 'animation', path: 'assets/animations/jump.anim.json' },
    ],
  });
  await fs.writeFile('/proj/assets/animations/walk.anim.json', JSON.stringify(WALK));
  await fs.writeFile('/proj/assets/animations/jump.anim.json', JSON.stringify(JUMP));
  return SceneRuntime.create(store, 'Test', runtimeOptions);
}

function spriteAssetId(rt: SceneRuntime): unknown {
  return rt.find('Animator')!.components.SpriteRenderer!.assetId;
}

function spriteFrame(rt: SceneRuntime): unknown {
  return rt.find('Animator')!.components.SpriteRenderer!.frame;
}

describe('SpriteAnimator stepping', () => {
  it('advances SpriteRenderer.assetId through frames on the fixed timestep', async () => {
    const rt = await makeRuntimeWithAnimator();
    expect(spriteAssetId(rt)).toBe('ast_wf0');
    rt.run(6); // 0.1s
    expect(spriteAssetId(rt)).toBe('ast_wf1');
    rt.run(6);
    expect(spriteAssetId(rt)).toBe('ast_wf2');
    rt.run(6); // loop wraps
    expect(spriteAssetId(rt)).toBe('ast_wf0');
  });

  it('plain (non-sheet) frame entries always write SpriteRenderer.frame = null', async () => {
    const rt = await makeRuntimeWithAnimator();
    expect(spriteFrame(rt)).toBeNull();
    rt.run(6);
    expect(spriteFrame(rt)).toBeNull();
  });

  it('fps override replaces the asset frameDuration', async () => {
    // fps 20 -> 0.05s/frame, i.e. every 3 fixed steps at 60fps, regardless
    // of WALK's own frameDuration (0.1).
    const rt = await makeRuntimeWithAnimator({ fps: 20 });
    rt.run(3);
    expect(spriteAssetId(rt)).toBe('ast_wf1');
    rt.run(3);
    expect(spriteAssetId(rt)).toBe('ast_wf2');
    rt.run(3);
    expect(spriteAssetId(rt)).toBe('ast_wf0'); // loop wraps
  });

  it('non-loop clamps on the last frame and sets playing=false', async () => {
    const rt = await makeRuntimeWithAnimator({ loop: false });
    rt.run(6);
    expect(spriteAssetId(rt)).toBe('ast_wf1');
    rt.run(6);
    expect(spriteAssetId(rt)).toBe('ast_wf2');
    const animator = rt.find('Animator')!.components.SpriteAnimator!;
    expect(animator.playing).toBe(true);
    rt.run(6); // would wrap if looping; instead clamps and stops
    expect(spriteAssetId(rt)).toBe('ast_wf2');
    expect(animator.playing).toBe(false);
    rt.run(12); // stopped: no further change
    expect(spriteAssetId(rt)).toBe('ast_wf2');
  });

  it('playing=false holds the current frame', async () => {
    const rt = await makeRuntimeWithAnimator({ playing: false });
    rt.run(12);
    expect(spriteAssetId(rt)).toBe('ast_wf0');
  });

  it('missing SpriteRenderer is skipped silently', async () => {
    const { store, fs } = await makeStore({
      entities: [ent('NoRenderer', { Transform: {}, SpriteAnimator: { assetId: 'ast_walk' } })],
      assets: [{ id: 'ast_walk', name: 'walk', type: 'animation', path: 'assets/animations/walk.anim.json' }],
    });
    await fs.writeFile('/proj/assets/animations/walk.anim.json', JSON.stringify(WALK));
    const logs: string[] = [];
    const runtime = await SceneRuntime.create(store, 'Test', { onLog: (e) => logs.push(e.message) });
    expect(() => runtime.run(3)).not.toThrow();
    expect(runtime.errors).toEqual([]);
  });

  it('unknown/empty assetId is skipped silently (no SpriteRenderer write)', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Blank', {
          Transform: {},
          SpriteRenderer: { assetId: 'ast_placeholder' },
          SpriteAnimator: {},
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(3);
    expect(runtime.find('Blank')!.components.SpriteRenderer!.assetId).toBe('ast_placeholder');
    expect(runtime.errors).toEqual([]);
  });

  it('disabling and re-enabling freezes progress instead of resetting it', async () => {
    const rt = await makeRuntimeWithAnimator();
    rt.run(3); // 0.05s into frame 0 (halfway to the 0.1 threshold)
    expect(spriteAssetId(rt)).toBe('ast_wf0');
    const entity = rt.find('Animator')!;
    entity.enabled = false;
    rt.run(6); // frozen while disabled
    expect(spriteAssetId(rt)).toBe('ast_wf0');
    entity.enabled = true;
    rt.run(3); // resumes; total playing time is 0.05 + 0.05 = 0.1s
    expect(spriteAssetId(rt)).toBe('ast_wf1');
  });
});

describe('ctx.animate', () => {
  it('switches mid-run and resets to frame 0 the same frame', async () => {
    const { store, fs } = await makeStore({
      entities: [
        ent('Animator', {
          Transform: {},
          SpriteRenderer: { assetId: 'ast_wf0' },
          SpriteAnimator: { assetId: 'ast_walk' },
          Script: { scriptPath: 'scripts/switch.js' },
        }),
      ],
      assets: [
        { id: 'ast_walk', name: 'walk', type: 'animation', path: 'assets/animations/walk.anim.json' },
        { id: 'ast_jump', name: 'jump', type: 'animation', path: 'assets/animations/jump.anim.json' },
      ],
      scripts: {
        'switch.js': `export default {
          onUpdate(ctx) {
            if (ctx.time.frame === 3) ctx.animate('ast_jump');
          },
        };`,
      },
    });
    await fs.writeFile('/proj/assets/animations/walk.anim.json', JSON.stringify(WALK));
    await fs.writeFile('/proj/assets/animations/jump.anim.json', JSON.stringify(JUMP));
    const runtime = await SceneRuntime.create(store, 'Test');

    runtime.run(4); // steps 0..3; step 3's onUpdate triggers the switch
    expect(spriteAssetId(runtime)).toBe('ast_jf0');
    expect(runtime.find('Animator')!.components.SpriteAnimator!.assetId).toBe('ast_jump');

    runtime.run(12); // 0.2s more -> jump's frameDuration threshold
    expect(spriteAssetId(runtime)).toBe('ast_jf1');
  });

  it('re-triggering a finished non-loop clip replays it from frame 0', async () => {
    const { store, fs } = await makeStore({
      entities: [
        ent('Animator', {
          Transform: {},
          SpriteRenderer: { assetId: 'ast_wf0' },
          SpriteAnimator: { assetId: 'ast_walk', loop: false },
          Script: { scriptPath: 'scripts/replay.js' },
        }),
      ],
      assets: [
        { id: 'ast_walk', name: 'walk', type: 'animation', path: 'assets/animations/walk.anim.json' },
      ],
      scripts: {
        'replay.js': `export default {
          onUpdate(ctx) {
            if (ctx.time.frame === 30) ctx.animate('ast_walk');
          },
        };`,
      },
    });
    await fs.writeFile('/proj/assets/animations/walk.anim.json', JSON.stringify(WALK));
    const runtime = await SceneRuntime.create(store, 'Test');

    runtime.run(20); // 3 frames x 6 steps = 18 steps to finish; clip clamped by now
    const animator = runtime.find('Animator')!.components.SpriteAnimator!;
    expect(spriteAssetId(runtime)).toBe('ast_wf2');
    expect(animator.playing).toBe(false);

    runtime.run(10); // steps 20..29
    runtime.step(); // frame 30: ctx.animate same assetId -> restart at frame 0
    expect(spriteAssetId(runtime)).toBe('ast_wf0');
    expect(animator.playing).toBe(true);
    runtime.run(6); // advances again from the top
    expect(spriteAssetId(runtime)).toBe('ast_wf1');
  });

  it('re-triggering mid-loop restarts the clip at frame 0', async () => {
    const { store, fs } = await makeStore({
      entities: [
        ent('Animator', {
          Transform: {},
          SpriteRenderer: { assetId: 'ast_wf0' },
          SpriteAnimator: { assetId: 'ast_walk' },
          Script: { scriptPath: 'scripts/restart.js' },
        }),
      ],
      assets: [
        { id: 'ast_walk', name: 'walk', type: 'animation', path: 'assets/animations/walk.anim.json' },
      ],
      scripts: {
        'restart.js': `export default {
          onUpdate(ctx) {
            if (ctx.time.frame === 9) ctx.animate('ast_walk');
          },
        };`,
      },
    });
    await fs.writeFile('/proj/assets/animations/walk.anim.json', JSON.stringify(WALK));
    const runtime = await SceneRuntime.create(store, 'Test');

    runtime.run(9); // mid-loop: 9 steps in, showing frame 1 (advanced at step 6)
    expect(spriteAssetId(runtime)).toBe('ast_wf1');
    runtime.step(); // frame 9: ctx.animate same assetId -> back to frame 0
    expect(spriteAssetId(runtime)).toBe('ast_wf0');
    runtime.run(6); // a full frameDuration from the restart, not the old elapsed
    expect(spriteAssetId(runtime)).toBe('ast_wf1');
  });

  it('warns and no-ops when the entity has no SpriteAnimator', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Plain', { Transform: {}, Script: { scriptPath: 'scripts/animate.js' } }),
      ],
      scripts: {
        'animate.js': `export default {
          onStart(ctx) { ctx.animate('ast_walk'); },
        };`,
      },
    });
    const logs: string[] = [];
    const runtime = await SceneRuntime.create(store, 'Test', { onLog: (e) => logs.push(e.message) });
    runtime.run(1);
    expect(logs.some((m) => m.includes('ctx.animate') && m.includes('no SpriteAnimator'))).toBe(true);
  });

  it('warns and no-ops when the asset is unknown', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Animator', {
          Transform: {},
          SpriteRenderer: { assetId: 'ast_wf0' },
          SpriteAnimator: { assetId: '' },
          Script: { scriptPath: 'scripts/animate.js' },
        }),
      ],
      scripts: {
        'animate.js': `export default {
          onStart(ctx) { ctx.animate('nonexistent'); },
        };`,
      },
    });
    const logs: string[] = [];
    const runtime = await SceneRuntime.create(store, 'Test', { onLog: (e) => logs.push(e.message) });
    runtime.run(1);
    expect(logs.some((m) => m.includes('ctx.animate') && m.includes('unknown animation asset'))).toBe(true);
    expect(runtime.find('Animator')!.components.SpriteAnimator!.assetId).toBe('');
  });
});
