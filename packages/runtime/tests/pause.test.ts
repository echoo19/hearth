/**
 * Pause integration: what SceneRuntime.step() freezes while `paused` and what
 * it deliberately keeps running.
 *
 * Frozen: physics, contacts, animators, particles, game time (`elapsed`), and
 * onUpdate/timers/tweens for scripts that did not opt in.
 * Still live: the frame counter, onUpdate/timers/tweens for
 * `Script.runWhilePaused` entities, camera effects already in flight, text
 * bindings (see gameState.test.ts), and `sendPointer` → onUiEvent.
 */
import { describe, expect, it } from 'vitest';
import { GameSession, SceneRuntime } from '@hearth/runtime';
import type { ProjectStore } from '@hearth/core';
import { ent, makeStore } from './helpers.js';

/** Writes its own frame count into Text.content — observable without any test-only API. */
const COUNTER_JS = `export default {
  onUpdate(ctx) {
    ctx.vars.n = (ctx.vars.n || 0) + 1;
    ctx.getComponent('Text').content = String(ctx.vars.n);
  },
};`;

const contentOf = (rt: SceneRuntime, name: string) => rt.find(name)!.components.Text!.content;

/** Gameplay + pause-menu pair, both counting their own onUpdate calls. */
async function makeCounterRuntime(): Promise<SceneRuntime> {
  const { store } = await makeStore({
    entities: [
      ent('Gameplay', {
        Transform: {},
        Text: { content: 'x' },
        Script: { scriptPath: 'scripts/counter.js', runWhilePaused: false },
      }),
      ent('PauseMenu', {
        Transform: {},
        Text: { content: 'x' },
        Script: { scriptPath: 'scripts/counter.js', runWhilePaused: true },
      }),
    ],
    scripts: { 'counter.js': COUNTER_JS },
  });
  return SceneRuntime.create(store, 'Test');
}

describe('paused: time and frames', () => {
  it('advances frame but freezes elapsed, and resumes elapsed on unpause', async () => {
    const rt = await makeCounterRuntime();
    rt.run(6);
    const elapsedBefore = rt.elapsed;
    expect(elapsedBefore).toBeCloseTo(6 / 60, 10);
    expect(rt.frame).toBe(6);

    rt.paused = true;
    rt.run(30);
    // wait{frames} accounting and the sweep frame budget are measured in
    // frames, so the counter must keep moving; game time must not.
    expect(rt.frame).toBe(36);
    expect(rt.elapsed).toBe(elapsedBefore);

    rt.paused = false;
    rt.run(6);
    expect(rt.frame).toBe(42);
    expect(rt.elapsed).toBeCloseTo(12 / 60, 10);
  });
});

describe('paused: physics', () => {
  it('freezes integration and resumes exactly where it stopped', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Mover', {
          Transform: { position: { x: 0, y: 0 } },
          PhysicsBody: { bodyType: 'kinematic', velocity: { x: 60, y: 0 } },
        }),
      ],
    });
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(6);
    const frozen = rt.find('Mover')!.transform.position.x;
    expect(frozen).toBeGreaterThan(0);

    rt.paused = true;
    rt.run(60);
    expect(rt.find('Mover')!.transform.position.x).toBe(frozen);

    rt.paused = false;
    rt.run(6);
    // Six more integrated frames: the same displacement as the first six.
    expect(rt.find('Mover')!.transform.position.x).toBeCloseTo(frozen * 2, 6);
  });

  it('freezes gravity too, so a faller does not accumulate velocity', async () => {
    const { store } = await makeStore({
      entities: [ent('Faller', { Transform: {}, PhysicsBody: { bodyType: 'dynamic' } })],
    });
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(6);
    const vy = rt.find('Faller')!.components.PhysicsBody!.velocity.y;
    expect(vy).toBeGreaterThan(0);
    rt.paused = true;
    rt.run(60);
    expect(rt.find('Faller')!.components.PhysicsBody!.velocity.y).toBe(vy);
  });

  it('clears no contacts while paused: the previous frame’s contacts are simply kept', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Mover', {
          Transform: { position: { x: 0, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic', gravityScale: 0, velocity: { x: 0, y: 0 } },
        }),
        ent('Zone', {
          Transform: { position: { x: 0, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 32, isTrigger: true },
        }),
      ],
    });
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(1);
    expect(rt.find('Mover')!.collisions.length).toBe(1);
    rt.paused = true;
    // stepPhysics is skipped entirely, so entity.collisions is neither
    // recomputed nor cleared — scripts reading ctx.collisions while paused see
    // the last simulated frame. Documented here so a future "clear on pause"
    // change is a deliberate decision, not an accident.
    rt.find('Mover')!.transform.position.x = 5000;
    rt.run(5);
    expect(rt.find('Mover')!.collisions.length).toBe(1);
  });
});

describe('paused: onUpdate and runWhilePaused', () => {
  it('runs onUpdate only for runWhilePaused entities, then resumes both', async () => {
    const rt = await makeCounterRuntime();
    rt.run(3);
    expect(contentOf(rt, 'Gameplay')).toBe('3');
    expect(contentOf(rt, 'PauseMenu')).toBe('3');

    rt.paused = true;
    rt.run(5);
    expect(contentOf(rt, 'Gameplay')).toBe('3'); // frozen
    expect(contentOf(rt, 'PauseMenu')).toBe('8'); // still ticking

    rt.paused = false;
    rt.run(2);
    expect(contentOf(rt, 'Gameplay')).toBe('5');
    expect(contentOf(rt, 'PauseMenu')).toBe('10');
  });

  it('drives the same split from Lua through ctx.state (dot syntax)', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Player', {
          Transform: {},
          Script: { scriptPath: 'scripts/play.lua', runWhilePaused: false },
        }),
        ent('Hud', {
          Transform: {},
          Script: { scriptPath: 'scripts/hud.lua', runWhilePaused: true },
        }),
      ],
      scripts: {
        'play.lua': ['return {', '  onUpdate = function(ctx)', "    ctx.state.add('playTicks', 1)", '  end,', '}'].join('\n'),
        'hud.lua': ['return {', '  onUpdate = function(ctx)', "    ctx.state.add('hudTicks', 1)", '  end,', '}'].join('\n'),
      },
      gameState: {
        playTicks: { type: 'number', initial: 0 },
        hudTicks: { type: 'number', initial: 0 },
      },
    });
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(4);
    expect(rt.gameState.get('playTicks')).toBe(4);
    expect(rt.gameState.get('hudTicks')).toBe(4);

    rt.paused = true;
    rt.run(10);
    expect(rt.gameState.get('playTicks')).toBe(4);
    expect(rt.gameState.get('hudTicks')).toBe(14);
    expect(rt.errors).toEqual([]);
  });

  it('still runs onStart while paused, for opted-out scripts too', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Late', {
          Transform: {},
          Text: { content: 'x' },
          Script: { scriptPath: 'scripts/late.js', runWhilePaused: false },
        }),
      ],
      scripts: {
        'late.js': `export default {
          onStart(ctx) { ctx.getComponent('Text').content = 'started'; },
          onUpdate(ctx) { ctx.getComponent('Text').content = 'updated'; },
        };`,
      },
    });
    const rt = await SceneRuntime.create(store, 'Test');
    rt.paused = true;
    rt.run(5);
    // Phase 1 (onStart) sits outside the pause guard on purpose: entities must
    // initialize even in a scene that opens paused. onUpdate still does not run.
    expect(contentOf(rt, 'Late')).toBe('started');
  });

  it('exposes ctx.game.pause/resume/isPaused to a runWhilePaused script', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Menu', {
          Transform: {},
          Script: { scriptPath: 'scripts/menu.js', runWhilePaused: true },
        }),
      ],
      scripts: {
        'menu.js': `export default {
          onUpdate(ctx) {
            if (ctx.time.frame === 2) ctx.game.pause();
            if (ctx.time.frame === 5) ctx.game.resume();
            ctx.log(ctx.time.frame + ':' + ctx.game.isPaused());
          },
        };`,
      },
    });
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(7);
    expect(rt.logs.map((l) => l.message)).toEqual([
      '0:false',
      '1:false',
      '2:true',
      '3:true',
      '4:true',
      '5:false',
      '6:false',
    ]);
    expect(rt.paused).toBe(false);
  });
});

describe('paused: timers and tweens', () => {
  const TIMER_JS = `export default {
    onStart(ctx) { ctx.timers.after(0.5, () => ctx.log(ctx.entity.name + ':fired')); },
  };`;

  async function makeTimerRuntime(): Promise<SceneRuntime> {
    const { store } = await makeStore({
      entities: [
        ent('Gameplay', { Transform: {}, Script: { scriptPath: 'scripts/timer.js' } }),
        ent('PauseMenu', {
          Transform: {},
          Script: { scriptPath: 'scripts/timer.js', runWhilePaused: true },
        }),
      ],
      scripts: { 'timer.js': TIMER_JS },
    });
    return SceneRuntime.create(store, 'Test');
  }

  const remaining = (rt: SceneRuntime, name: string) =>
    rt.getSchedulerSnapshot(rt.find(name)!.id)!.timers[0]?.remaining;

  it('freezes an opted-out timer and keeps a runWhilePaused one counting down', async () => {
    const rt = await makeTimerRuntime();
    rt.paused = true;
    rt.run(1); // onStart schedules both timers even while paused
    const frozenAt = remaining(rt, 'Gameplay');
    expect(frozenAt).toBeCloseTo(0.5, 10);

    rt.run(45); // 0.75s of frames: enough for both, if both were ticking
    expect(remaining(rt, 'Gameplay')).toBe(frozenAt);
    expect(rt.logs.map((l) => l.message)).toEqual(['PauseMenu:fired']);
  });

  it('an opted-out timer fires once unpaused, having lost no time', async () => {
    const rt = await makeTimerRuntime();
    rt.run(1);
    rt.paused = true;
    rt.run(120);
    expect(rt.logs.map((l) => l.message)).toEqual(['PauseMenu:fired']);
    rt.paused = false;
    // Gameplay's scheduler has ticked once so far (frame 0, before the pause).
    rt.run(28); // 29 ticks ≈ 0.483s: still short of the 0.5s timer
    expect(rt.logs.map((l) => l.message)).toEqual(['PauseMenu:fired']);
    rt.run(2); // 31 ticks ≈ 0.517s: past 0.5s, so it fires now and only now
    expect(rt.logs.map((l) => l.message)).toEqual(['PauseMenu:fired', 'Gameplay:fired']);
  });

  it('freezes an opted-out tween and keeps a runWhilePaused one animating', async () => {
    const TWEEN_JS = `export default {
      onStart(ctx) { ctx.tweens.to('Transform.position.x', 120, 1); },
    };`;
    const { store } = await makeStore({
      entities: [
        ent('Gameplay', {
          Transform: { position: { x: 0, y: 0 } },
          Script: { scriptPath: 'scripts/tween.js' },
        }),
        ent('PauseMenu', {
          Transform: { position: { x: 0, y: 0 } },
          Script: { scriptPath: 'scripts/tween.js', runWhilePaused: true },
        }),
      ],
      scripts: { 'tween.js': TWEEN_JS },
    });
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(6);
    const partway = rt.find('Gameplay')!.transform.position.x;
    expect(partway).toBeGreaterThan(0);
    expect(rt.find('PauseMenu')!.transform.position.x).toBeCloseTo(partway, 10);

    rt.paused = true;
    rt.run(30);
    expect(rt.find('Gameplay')!.transform.position.x).toBe(partway);
    expect(rt.find('PauseMenu')!.transform.position.x).toBeGreaterThan(partway);
    // Tween elapsed is the underlying evidence, not just the written value.
    const snap = (name: string) =>
      rt.getSchedulerSnapshot(rt.find(name)!.id)!.tweens[0]?.elapsed ?? 1;
    expect(snap('Gameplay')).toBeCloseTo(6 / 60, 10);
    expect(snap('PauseMenu')).toBeGreaterThan(6 / 60);
  });
});

describe('paused: particles and animators', () => {
  it('does not advance particle emitters', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Emitter', {
          Transform: {},
          ParticleEmitter: { seed: 3, rate: 60, burst: 0, lifetime: 10, emitting: true },
        }),
      ],
    });
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(5);
    const frozen = rt.getParticleCount('Emitter');
    expect(frozen).toBeGreaterThan(0);
    const ages = rt.getParticles('Emitter').map((p) => p.age);

    rt.paused = true;
    rt.run(60);
    expect(rt.getParticleCount('Emitter')).toBe(frozen);
    expect(rt.getParticles('Emitter').map((p) => p.age)).toEqual(ages);

    rt.paused = false;
    rt.run(5);
    expect(rt.getParticleCount('Emitter')).toBeGreaterThan(frozen);
  });

  it('does not advance SpriteAnimator playback', async () => {
    const { store, fs } = await makeStore({
      entities: [
        ent('Animator', {
          Transform: {},
          SpriteRenderer: { assetId: 'ast_wf0' },
          SpriteAnimator: { assetId: 'ast_walk' },
        }),
      ],
      assets: [
        { id: 'ast_walk', name: 'walk', type: 'animation', path: 'assets/animations/walk.anim.json' },
      ],
    });
    await fs.writeFile(
      '/proj/assets/animations/walk.anim.json',
      JSON.stringify({ frames: ['ast_wf0', 'ast_wf1', 'ast_wf2'], frameDuration: 0.1, loop: true }),
    );
    const rt = await SceneRuntime.create(store, 'Test');
    const sprite = () => rt.find('Animator')!.components.SpriteRenderer!.assetId;
    rt.run(6); // 0.1s: one frame in
    expect(sprite()).toBe('ast_wf1');

    rt.paused = true;
    rt.run(60); // a full second: would loop twice if the animator were live
    expect(sprite()).toBe('ast_wf1');

    rt.paused = false;
    rt.run(6);
    expect(sprite()).toBe('ast_wf2');
  });
});

describe('paused: camera effects', () => {
  it('keeps a fade already in flight progressing to completion', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Fader', { Transform: {}, Script: { scriptPath: 'scripts/fade.js' } }),
      ],
      scripts: {
        'fade.js': `export default {
          onStart(ctx) { ctx.camera.fade(1, 1, { onComplete: () => ctx.log('faded') }); },
        };`,
      },
    });
    const rt = await SceneRuntime.create(store, 'Test');
    // Pause before the very first step: onStart still runs, so the fade starts
    // in flight and must finish even though the game is frozen. A transition
    // that stalled here would leave the screen half-black forever.
    rt.paused = true;
    rt.run(1);
    expect(rt.cameraEffects.persistentOverlay.alpha).toBeGreaterThan(0);

    rt.run(29);
    const halfway = rt.cameraEffects.persistentOverlay.alpha;
    expect(halfway).toBeGreaterThan(0.3);
    expect(halfway).toBeLessThan(1);

    rt.run(31); // past the 1s duration
    expect(rt.cameraEffects.persistentOverlay.alpha).toBe(1);
    expect(rt.cameraEffects.activeCount).toBe(0);
    expect(rt.logs.map((l) => l.message)).toEqual(['faded']);
    expect(rt.paused).toBe(true);
  });
});

describe('paused: UI', () => {
  it('sendPointer still dispatches onUiEvent while paused', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Resume', {
          Transform: {},
          UIElement: { interactive: true, anchor: 'top-left', offset: { x: 100, y: 100 } },
          SpriteRenderer: { width: 50, height: 50 },
          Script: { scriptPath: 'scripts/btn.js', runWhilePaused: true },
        }),
      ],
      scripts: {
        'btn.js': `export default {
          onUiEvent(ctx, event) { ctx.log(event.type); },
        };`,
      },
    });
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(1);
    rt.paused = true;
    rt.sendPointer(100, 100, 'down');
    rt.sendPointer(100, 100, 'up');
    expect(rt.logs.map((l) => l.message)).toEqual(['enter', 'press', 'release', 'click']);
    expect(rt.errors).toEqual([]);
  });

  it('dispatches onUiEvent even to a script that did not opt into runWhilePaused', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Resume', {
          Transform: {},
          UIElement: { interactive: true, anchor: 'top-left', offset: { x: 100, y: 100 } },
          SpriteRenderer: { width: 50, height: 50 },
          Script: { scriptPath: 'scripts/btn.js', runWhilePaused: false },
        }),
      ],
      scripts: {
        'btn.js': `export default { onUiEvent(ctx, event) { ctx.log(event.type); } };`,
      },
    });
    const rt = await SceneRuntime.create(store, 'Test');
    rt.run(1);
    rt.paused = true;
    rt.sendPointer(100, 100, 'down');
    rt.sendPointer(100, 100, 'up');
    // sendPointer runs outside step(), so runWhilePaused gates onUpdate only.
    expect(rt.logs.map((l) => l.message)).toEqual(['enter', 'press', 'release', 'click']);
  });
});

/** Menu scene (scn_test) that loads 'Level' on frame 2 while paused, plus a Level scene. */
async function makePauseSwitchStore(): Promise<ProjectStore> {
  const { store } = await makeStore({
    entities: [
      ent('Menu', {
        Transform: {},
        Script: { scriptPath: 'scripts/menu.js', runWhilePaused: true },
      }),
    ],
    scripts: {
      'menu.js': `export default {
        onUpdate(ctx) { if (ctx.time.frame === 2) ctx.scenes.load('Level'); },
      };`,
      'hero.js': `export default {
        onStart(ctx) { ctx.getComponent('Text').content = 'hero-started'; },
        onUpdate(ctx) { ctx.getComponent('Text').content = 'hero-updated'; },
      };`,
    },
    extraScenes: [
      {
        id: 'scn_level',
        name: 'Level',
        entities: [
          ent('Hero', {
            Transform: {},
            Text: { content: 'x' },
            Script: { scriptPath: 'scripts/hero.js' },
          }),
        ],
      },
    ],
  });
  return store;
}

describe('GameSession pause', () => {
  it('setPaused survives a scene switch: the new runtime comes up paused', async () => {
    const store = await makePauseSwitchStore();
    const session = await GameSession.create(store);
    session.setPaused(true);
    expect(session.runtime.paused).toBe(true);

    for (let i = 0; i < 6; i++) await session.stepAsync();

    expect(session.currentSceneId).toBe('scn_level');
    expect(session.isPaused()).toBe(true);
    // Pause is a session concern re-applied to the fresh runtime; without that
    // re-application the new scene would start simulating behind a pause menu.
    expect(session.runtime.paused).toBe(true);
    // The new scene's gameplay script started but never updated.
    expect(session.runtime.find('Hero')!.components.Text!.content).toBe('hero-started');
    expect(session.errors).toEqual([]);
    session.destroy();
  });

  it('setPaused(false) after the switch resumes the new scene', async () => {
    const store = await makePauseSwitchStore();
    const session = await GameSession.create(store);
    session.setPaused(true);
    for (let i = 0; i < 6; i++) await session.stepAsync();
    session.setPaused(false);
    await session.stepAsync();
    expect(session.runtime.find('Hero')!.components.Text!.content).toBe('hero-updated');
    session.destroy();
  });

  /**
   * KNOWN PRODUCT DEFECT (packages/runtime/src/runtime.ts:2359 ctx.game.pause,
   * vs packages/runtime/src/session.ts:154 GameSession.setPaused).
   *
   * ctx.game.pause() writes SceneRuntime.paused directly and never tells the
   * owning GameSession, so GameSession._paused stays false. On the next scene
   * switch startScene() re-applies that stale false
   * (packages/runtime/src/session.ts:326 `this._runtime.paused = this._paused`)
   * and the pause is silently lost — the new scene comes up running while the
   * pause menu still thinks the game is frozen. GameSession.isPaused() also
   * disagrees with ctx.game.isPaused() for the whole time in between.
   *
   * A pause menu is exactly the thing that pauses from script and then loads a
   * scene ("Restart Level"), so this is on the main path. Left failing
   * deliberately rather than fixed here — this file only writes tests.
   */
  it('a script-side ctx.game.pause() is visible to the session and survives a switch', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Menu', {
          Transform: {},
          Script: { scriptPath: 'scripts/menu.js', runWhilePaused: true },
        }),
      ],
      scripts: {
        'menu.js': `export default {
          onUpdate(ctx) {
            if (ctx.time.frame === 1) ctx.game.pause();
            if (ctx.time.frame === 2) ctx.scenes.load('Level');
          },
        };`,
        'hero.js': `export default {
          onStart(ctx) { ctx.getComponent('Text').content = 'hero-started'; },
          onUpdate(ctx) { ctx.getComponent('Text').content = 'hero-updated'; },
        };`,
      },
      extraScenes: [
        {
          id: 'scn_level',
          name: 'Level',
          entities: [
            ent('Hero', {
              Transform: {},
              Text: { content: 'x' },
              Script: { scriptPath: 'scripts/hero.js' },
            }),
          ],
        },
      ],
    });
    const session = await GameSession.create(store);
    await session.stepAsync(); // frame 0
    await session.stepAsync(); // frame 1: ctx.game.pause()
    // Collected into one object so the failure diff shows the whole defect at
    // once rather than stopping at the first divergence.
    const observed: Record<string, unknown> = {
      runtimePausedOnPause: session.runtime.paused,
      sessionIsPausedOnPause: session.isPaused(),
    };

    for (let i = 0; i < 4; i++) await session.stepAsync();
    observed.scene = session.currentSceneId;
    observed.runtimePausedAfterSwitch = session.runtime.paused;
    observed.heroText = session.runtime.find('Hero')!.components.Text!.content;

    expect(observed).toEqual({
      runtimePausedOnPause: true,
      sessionIsPausedOnPause: true,
      scene: 'scn_level',
      runtimePausedAfterSwitch: true,
      heroText: 'hero-started',
    });
    session.destroy();
  });
});
