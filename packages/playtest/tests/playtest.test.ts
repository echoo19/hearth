/**
 * End-to-end playtest execution against projects built in memory with
 * createProject + HearthSession commands.
 */
import { describe, it, expect } from 'vitest';
import {
  MemoryFileSystem,
  ProjectStore,
  SceneSchema,
  createProject,
  HearthSession,
} from '@hearth/core';
import { createRng } from '@hearth/runtime';
import { runPlaytest, runSceneSmoke, createRuntimeHooks } from '@hearth/playtest';

const MOVE_SCRIPT = `
export default {
  onUpdate(ctx) {
    const body = ctx.getComponent('PhysicsBody');
    if (ctx.input.isDown('right')) body.velocity.x = 100;
    else if (ctx.input.isDown('left')) body.velocity.x = -100;
    else body.velocity.x = 0;
  },
};
`;

const AXIS_MOVE_SCRIPT = `
export default {
  onUpdate(ctx, dt) {
    ctx.transform.position.x += ctx.input.axis('moveX') * 100 * dt;
  },
};
`;

/** Starter project (Main scene: Camera, Ground, Player) plus a movement script. */
async function makeProject(): Promise<{ store: ProjectStore; session: HearthSession }> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Playtest Game' });
  const session = HearthSession.fromStore(store, { runtime: createRuntimeHooks() });
  const created = await session.execute<{ path: string }>('createScript', {
    name: 'player move',
    source: MOVE_SCRIPT,
    language: 'js',
  });
  expect(created.success).toBe(true);
  const attached = await session.execute('attachScript', {
    scene: 'Main',
    entity: 'Player',
    script: created.data!.path,
  });
  expect(attached.success).toBe(true);
  return { store, session };
}

/** Starter project (Main scene: Camera, Ground, Player) plus an axis-driven movement script. */
async function makeAxisProject(): Promise<{ store: ProjectStore; session: HearthSession }> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Axis Playtest Game' });
  const session = HearthSession.fromStore(store, { runtime: createRuntimeHooks() });
  const created = await session.execute<{ path: string }>('createScript', {
    name: 'axis move',
    source: AXIS_MOVE_SCRIPT,
    language: 'js',
  });
  expect(created.success).toBe(true);
  const attached = await session.execute('attachScript', {
    scene: 'Main',
    entity: 'Player',
    script: created.data!.path,
  });
  expect(attached.success).toBe(true);
  return { store, session };
}

describe('runPlaytest', () => {
  it('runs a press-based movement playtest end-to-end', async () => {
    const { store, session } = await makeProject();
    const created = await session.execute<{ playtestId: string }>('createPlaytest', {
      name: 'move right',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 30 }, // let the player settle on the ground
        { type: 'press', action: 'right', frames: 60 },
        { type: 'assertProperty', entity: 'Player', property: 'Transform.position.x', greaterThan: 450 },
        { type: 'assertProperty', entity: 'Player', property: 'PhysicsBody.bodyType', equals: 'dynamic' },
        { type: 'assertPositionNear', entity: 'Player', x: 500, y: 494, tolerance: 10 },
        { type: 'assertEntityExists', entity: 'Player', exists: true },
        { type: 'assertNoErrors' },
      ],
    });
    expect(created.success).toBe(true);

    const result = await runPlaytest(store, 'move right');
    expect(result.steps.map((s) => `${s.type}:${s.passed}`)).toEqual([
      'wait:true',
      'press:true',
      'assertProperty:true',
      'assertProperty:true',
      'assertPositionNear:true',
      'assertEntityExists:true',
      'assertNoErrors:true',
    ]);
    expect(result.passed).toBe(true);
    expect(result.playtestId).toBe(created.data!.playtestId);
    expect(result.framesRun).toBe(90);
    expect(result.errors).toEqual([]);
  });

  it('is runnable through the core runPlaytest command via runtime hooks', async () => {
    const { session } = await makeProject();
    await session.execute('createPlaytest', {
      name: 'smoke steps',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 10 },
        { type: 'assertEntityExists', entity: 'Player' },
        { type: 'assertNoErrors' },
      ],
    });
    const result = await session.execute<{ passed: boolean; framesRun: number }>('runPlaytest', {
      playtest: 'smoke steps',
    });
    expect(result.success).toBe(true);
    expect(result.data!.passed).toBe(true);
    expect(result.data!.framesRun).toBe(10);
  });

  it('continues past failed assertions and collects every step result', async () => {
    const { store, session } = await makeProject();
    await session.execute('createPlaytest', {
      name: 'mixed',
      scene: 'Main',
      steps: [
        { type: 'assertProperty', entity: 'Player', property: 'Transform.position.x', greaterThan: 10000 },
        { type: 'assertEntityExists', entity: 'NoSuchEntity', exists: true },
        { type: 'assertEntityExists', entity: 'Player', exists: true },
      ],
    });
    const result = await runPlaytest(store, 'mixed');
    expect(result.passed).toBe(false);
    expect(result.steps.length).toBe(3);
    expect(result.steps[0].passed).toBe(false);
    expect(result.steps[0].message).toMatch(/expected > 10000/);
    expect(result.steps[1].passed).toBe(false);
    expect(result.steps[2].passed).toBe(true);
  });

  it('enforces maxFrames as a hard cap and notes capped asserts', async () => {
    const { store, session } = await makeProject();
    await session.execute('createPlaytest', {
      name: 'capped',
      scene: 'Main',
      maxFrames: 50,
      steps: [
        { type: 'wait', frames: 500 },
        { type: 'press', action: 'right', frames: 100 },
        { type: 'assertEntityExists', entity: 'Player', exists: true },
        { type: 'assertEventCount', event: 'nonexistent', max: 0 },
      ],
    });
    const result = await runPlaytest(store, 'capped');
    expect(result.framesRun).toBe(50);
    expect(result.steps[0].message).toMatch(/maxFrames cap/);
    expect(result.steps[1].message).toMatch(/0\/100 frames/);
    expect(result.steps[2].passed).toBe(true);
    expect(result.steps[2].message).toMatch(/evaluated at maxFrames cap/);
    // assertEventCount must carry the same capNote as every other assert step.
    expect(result.steps[3].passed).toBe(true);
    expect(result.steps[3].message).toMatch(/evaluated at maxFrames cap/);
    expect(result.passed).toBe(true);
  });

  it('reports a missing playtest as a failing pseudo-step', async () => {
    const { store } = await makeProject();
    const result = await runPlaytest(store, 'does-not-exist');
    expect(result.passed).toBe(false);
    expect(result.steps).toEqual([
      { index: 0, type: 'load', passed: false, message: 'Playtest not found: does-not-exist' },
    ]);
    expect(result.framesRun).toBe(0);
  });
});

describe('runPlaytest setAxis', () => {
  it('drives ctx.input.axis via a setAxis playtest step', async () => {
    const { store, session } = await makeAxisProject();
    const created = await session.execute<{ playtestId: string }>('createPlaytest', {
      name: 'axis move right',
      scene: 'Main',
      steps: [
        { type: 'setAxis', axis: 'moveX', value: 1, frames: 30 },
        { type: 'assertProperty', entity: 'Player', property: 'Transform.position.x', greaterThan: 400 },
        { type: 'assertNoErrors' },
      ],
    });
    expect(created.success).toBe(true);

    const result = await runPlaytest(store, 'axis move right');
    expect(result.steps.map((s) => `${s.type}:${s.passed}`)).toEqual([
      'setAxis:true',
      'assertProperty:true',
      'assertNoErrors:true',
    ]);
    expect(result.passed).toBe(true);
    expect(result.framesRun).toBe(30);
  });

  it('drives negative axis values, and the override stays sticky across frames', async () => {
    const { store, session } = await makeAxisProject();
    await session.execute('createPlaytest', {
      name: 'axis move left',
      scene: 'Main',
      steps: [
        { type: 'setAxis', axis: 'moveX', value: -1, frames: 30 },
        { type: 'assertProperty', entity: 'Player', property: 'Transform.position.x', lessThan: 400 },
        { type: 'wait', frames: 30 }, // override must still hold with no further setAxis step
        { type: 'assertProperty', entity: 'Player', property: 'Transform.position.x', lessThan: 350 },
      ],
    });
    const result = await runPlaytest(store, 'axis move left');
    expect(result.passed).toBe(true);
  });

  it('defaults frames to 1 when omitted', async () => {
    const { store, session } = await makeAxisProject();
    await session.execute('createPlaytest', {
      name: 'axis one frame',
      scene: 'Main',
      steps: [{ type: 'setAxis', axis: 'moveX', value: 1 }],
    });
    const result = await runPlaytest(store, 'axis one frame');
    expect(result.framesRun).toBe(1);
    expect(result.passed).toBe(true);
  });
});

describe('runSceneSmoke', () => {
  it('passes a healthy scene and reports entity count', async () => {
    const { store } = await makeProject();
    const result = await runSceneSmoke(store, 'Main', 60);
    expect(result.passed).toBe(true);
    expect(result.sceneName).toBe('Main');
    expect(result.framesRun).toBe(60);
    expect(result.entityCount).toBe(3); // Camera, Ground, Player
    expect(result.errors).toEqual([]);
  });

  it('fails and reports errors for a broken script', async () => {
    const { store, session } = await makeProject();
    const broken = await session.execute<{ path: string }>('createScript', {
      name: 'broken',
      source: 'export default { onStart() { throw new Error("boom"); } };',
      language: 'js',
    });
    await session.execute('attachScript', {
      scene: 'Main',
      entity: 'Ground',
      script: broken.data!.path,
    });
    const result = await runSceneSmoke(store, 'Main', 30);
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatchObject({
      message: 'boom',
      entity: 'Ground',
      script: 'scripts/broken.js',
      phase: 'onStart',
    });
    expect(result.framesRun).toBe(30);
  });

  it('fails cleanly for an unknown scene', async () => {
    const { store } = await makeProject();
    const result = await runSceneSmoke(store, 'Nowhere', 10);
    expect(result.passed).toBe(false);
    expect(result.errors[0].message).toMatch(/Scene not found/);
    expect(result.framesRun).toBe(0);
  });
});

describe('audio events pass-through', () => {
  it('surfaces runtime audioEvents on smoke and playtest results', async () => {
    const { store, session } = await makeProject();
    store.assets.assets.push({
      id: 'ast_coin',
      name: 'coin',
      type: 'audio',
      path: 'assets/coin.wav',
      metadata: {},
    });
    const created = await session.execute<{ path: string }>('createScript', {
      name: 'chime',
      source: `export default { onStart(ctx) { ctx.audio.play('coin'); } };`,
      language: 'js',
    });
    await session.execute('attachScript', {
      scene: 'Main',
      entity: 'Ground',
      script: created.data!.path,
    });

    const smoke = await runSceneSmoke(store, 'Main', 10);
    expect(smoke.passed).toBe(true);
    expect(smoke.audioEvents).toEqual([{ frame: 0, assetId: 'ast_coin', action: 'play' }]);

    await session.execute('createPlaytest', {
      name: 'audio check',
      scene: 'Main',
      steps: [{ type: 'wait', frames: 5 }, { type: 'assertNoErrors' }],
    });
    const result = await runPlaytest(store, 'audio check');
    expect(result.passed).toBe(true);
    expect(result.audioEvents).toEqual([{ frame: 0, assetId: 'ast_coin', action: 'play' }]);
  });
});

// ---------------------------------------------------------------------------
// assertAudioCount playtest assertion
// ---------------------------------------------------------------------------

describe('assertAudioCount', () => {
  /**
   * Project with SFX and music assets.
   * Script plays coin (sfx) twice and music once on start.
   */
  async function makeAudioProject(): Promise<{ store: ProjectStore; session: HearthSession }> {
    const { store, session } = await makeProject();
    store.assets.assets.push(
      {
        id: 'ast_coin',
        name: 'coin',
        type: 'audio',
        path: 'assets/coin.wav',
        metadata: {},
      },
      {
        id: 'ast_bgm',
        name: 'bgm',
        type: 'audio',
        path: 'assets/bgm.wav',
        metadata: {},
      },
    );
    const created = await session.execute<{ path: string }>('createScript', {
      name: 'audio sfx',
      source: `export default {
  onStart(ctx) {
    ctx.audio.play('coin');
    ctx.audio.play('coin');
    ctx.audio.playMusic('bgm');
  }
};`,
      language: 'js',
    });
    await session.execute('attachScript', {
      scene: 'Main',
      entity: 'Ground',
      script: created.data!.path,
    });
    return { store, session };
  }

  it('counts audio events filtered by action and music flag', async () => {
    const { store, session } = await makeAudioProject();
    await session.execute('createPlaytest', {
      name: 'audio assertions',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 5 },
        { type: 'assertAudioCount', music: true, action: 'play', equals: 1 },
        { type: 'assertAudioCount', action: 'play', equals: 3 },
        { type: 'assertAudioCount', music: false, action: 'play', equals: 2 },
      ],
    });
    const result = await runPlaytest(store, 'audio assertions');
    expect(result.passed).toBe(true);
    expect(result.steps[1].passed).toBe(true);
    expect(result.steps[2].passed).toBe(true);
    expect(result.steps[3].passed).toBe(true);
  });

  it('counts audio events filtered by asset name', async () => {
    const { store, session } = await makeAudioProject();
    await session.execute('createPlaytest', {
      name: 'audio by asset',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 5 },
        { type: 'assertAudioCount', asset: 'coin', equals: 2 },
        { type: 'assertAudioCount', asset: 'bgm', equals: 1 },
        { type: 'assertAudioCount', asset: 'bgm', min: 1 },
      ],
    });
    const result = await runPlaytest(store, 'audio by asset');
    expect(result.passed).toBe(true);
    expect(result.steps[1].passed).toBe(true);
    expect(result.steps[2].passed).toBe(true);
    expect(result.steps[3].passed).toBe(true);
  });

  it('fails when asset is not found', async () => {
    const { store, session } = await makeAudioProject();
    await session.execute('createPlaytest', {
      name: 'unknown asset',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 5 },
        { type: 'assertAudioCount', asset: 'nope', min: 1 },
      ],
    });
    const result = await runPlaytest(store, 'unknown asset');
    expect(result.passed).toBe(false);
    expect(result.steps[1].passed).toBe(false);
    expect(result.steps[1].message).toContain('assertAudioCount: asset not found: nope');
  });

  it('fails when bounds are not met', async () => {
    const { store, session } = await makeAudioProject();
    await session.execute('createPlaytest', {
      name: 'wrong bounds',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 5 },
        { type: 'assertAudioCount', action: 'stop', equals: 5 },
      ],
    });
    const result = await runPlaytest(store, 'wrong bounds');
    expect(result.passed).toBe(false);
    expect(result.steps[1].passed).toBe(false);
    expect(result.steps[1].message).toContain('action "stop" count 0');
    expect(result.steps[1].message).toContain('expected exactly 5');
  });
});

// ---------------------------------------------------------------------------
// assertCameraEffect playtest assertion
// ---------------------------------------------------------------------------

describe('assertCameraEffect', () => {
  /** Project whose Ground entity shakes the camera once on start. */
  async function makeShakeProject(): Promise<{ store: ProjectStore; session: HearthSession }> {
    const { store, session } = await makeProject();
    const created = await session.execute<{ path: string }>('createScript', {
      name: 'shake once',
      source: `export default { onStart(ctx) { ctx.camera.shake(4, 0.2); } };`,
      language: 'js',
    });
    await session.execute('attachScript', {
      scene: 'Main',
      entity: 'Ground',
      script: created.data!.path,
    });
    return { store, session };
  }

  it('passes min:1 and reports the accumulated shake record', async () => {
    const { store, session } = await makeShakeProject();
    await session.execute('createPlaytest', {
      name: 'shake min',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 5 },
        { type: 'assertCameraEffect', effect: 'shake', min: 1 },
      ],
    });
    const result = await runPlaytest(store, 'shake min');
    expect(result.passed).toBe(true);
    expect(result.steps[1].passed).toBe(true);
    expect(result.cameraEffects.length).toBe(1);
    expect(result.cameraEffects[0]).toMatchObject({ effect: 'shake', frame: 0 });
  });

  it('fails equals:5 with a clear message when only one shake fired', async () => {
    const { store, session } = await makeShakeProject();
    await session.execute('createPlaytest', {
      name: 'shake equals',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 5 },
        { type: 'assertCameraEffect', effect: 'shake', equals: 5 },
      ],
    });
    const result = await runPlaytest(store, 'shake equals');
    expect(result.passed).toBe(false);
    expect(result.steps[1].passed).toBe(false);
    expect(result.steps[1].message).toContain('shake');
    expect(result.steps[1].message).toContain('expected exactly 5');
  });

  it('rejects a step with none of equals/min/max', async () => {
    const { store, session } = await makeProject();
    const result = await session.execute('createPlaytest', {
      name: 'no bounds',
      scene: 'Main',
      steps: [{ type: 'assertCameraEffect', effect: 'shake' }],
    });
    expect(result.success).toBe(false);
  });

  it('leaves cameraOverlayAlpha at 1 after a fade to 1 completes', async () => {
    const { store, session } = await makeProject();
    const created = await session.execute<{ path: string }>('createScript', {
      name: 'fade out',
      source: `export default { onStart(ctx) { ctx.camera.fade(1, 0.1); } };`,
      language: 'js',
    });
    await session.execute('attachScript', {
      scene: 'Main',
      entity: 'Ground',
      script: created.data!.path,
    });
    await session.execute('createPlaytest', {
      name: 'fade to black',
      scene: 'Main',
      // fixedTimestep defaults to 60Hz, so 0.1s completes well within 30 frames.
      steps: [{ type: 'wait', frames: 30 }],
    });
    const result = await runPlaytest(store, 'fade to black');
    expect(result.passed).toBe(true);
    expect(result.cameraOverlayAlpha).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scene switching: click steps, assertScene, seeded runs
// ---------------------------------------------------------------------------

const START_BUTTON_SCRIPT = `export default {
  onUiEvent(ctx, event) { if (event.type === 'click') ctx.scenes.load('Level'); },
};`;

const HERO_RNG_SCRIPT = `export default {
  onStart(ctx) { ctx.log('rng:' + ctx.random.next()); },
};`;

/**
 * Two-scene project: a Menu scene with an interactive StartButton
 * (50×50 sprite anchored top-left at offset 100,100 → hit rect 75..125)
 * and a Level scene with a Hero that logs one seeded random draw.
 */
async function makeMenuGame(
  menuScript: string = START_BUTTON_SCRIPT,
): Promise<{ store: ProjectStore; session: HearthSession }> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/menu', { name: 'Menu Game', starterScene: false });
  store.project.scenes.push(
    { id: 'scn_menu', name: 'Menu', path: 'scenes/menu.scene.json' },
    { id: 'scn_level', name: 'Level', path: 'scenes/level.scene.json' },
  );
  store.project.initialScene = 'scn_menu';
  store.scenes.set(
    'scn_menu',
    SceneSchema.parse({
      formatVersion: 1,
      id: 'scn_menu',
      name: 'Menu',
      entities: [
        {
          id: 'ent_btn',
          name: 'StartButton',
          parentId: null,
          enabled: true,
          tags: [],
          components: {
            Transform: {},
            UIElement: { interactive: true, anchor: 'top-left', offset: { x: 100, y: 100 } },
            SpriteRenderer: { width: 50, height: 50 },
            Script: { scriptPath: 'scripts/menu.js' },
          },
        },
      ],
    }),
  );
  store.scenes.set(
    'scn_level',
    SceneSchema.parse({
      formatVersion: 1,
      id: 'scn_level',
      name: 'Level',
      entities: [
        {
          id: 'ent_hero',
          name: 'Hero',
          parentId: null,
          enabled: true,
          tags: [],
          components: { Transform: {}, Script: { scriptPath: 'scripts/hero.js' } },
        },
      ],
    }),
  );
  await fs.writeFile('/menu/scripts/menu.js', menuScript);
  await fs.writeFile('/menu/scripts/hero.js', HERO_RNG_SCRIPT);
  await store.save();
  const loaded = await ProjectStore.load(fs, '/menu');
  const session = HearthSession.fromStore(loaded, { runtime: createRuntimeHooks() });
  return { store: loaded, session };
}

describe('click and assertScene steps', () => {
  it('click drives a UIElement button that switches scenes; seed is plumbed', async () => {
    const { store, session } = await makeMenuGame();
    await session.execute('createPlaytest', {
      name: 'start game',
      scene: 'Menu',
      steps: [
        { type: 'click', x: 100, y: 100 },
        { type: 'assertScene', scene: 'Level' },
        { type: 'wait', frames: 5 },
        { type: 'assertNoErrors' },
      ],
    });
    store.getPlaytest('start game')!.seed = 5;

    const result = await runPlaytest(store, 'start game');
    expect(result.steps.map((s) => `${s.type}:${s.passed}`)).toEqual([
      'click:true',
      'assertScene:true',
      'wait:true',
      'assertNoErrors:true',
    ]);
    expect(result.passed).toBe(true);
    expect(result.framesRun).toBe(6);
    expect(result.finalScene).toBe('scn_level');
    expect(result.sceneEvents).toEqual([{ frame: 1, from: 'scn_menu', to: 'scn_level' }]);
    // Hero's ctx.random draws from the playtest's seeded stream.
    expect(result.logs.map((l) => l.message)).toContain('rng:' + createRng(5)());
  });

  it('a click that misses the button does not switch scenes', async () => {
    const { store, session } = await makeMenuGame();
    await session.execute('createPlaytest', {
      name: 'miss',
      scene: 'Menu',
      steps: [
        { type: 'click', x: 400, y: 400 },
        { type: 'assertScene', scene: 'Menu' },
        { type: 'assertScene', scene: 'Level' },
      ],
    });
    const result = await runPlaytest(store, 'miss');
    expect(result.steps.map((s) => `${s.type}:${s.passed}`)).toEqual([
      'click:true',
      'assertScene:true',
      'assertScene:false',
    ]);
    expect(result.passed).toBe(false);
    expect(result.steps[2].message).toMatch(/expected scene "Level".*current scene is "Menu"/);
    expect(result.finalScene).toBe('scn_menu');
    expect(result.sceneEvents).toEqual([]);
  });

  it('assertScene accepts scene ids as well as names', async () => {
    const { store, session } = await makeMenuGame();
    await session.execute('createPlaytest', {
      name: 'by id',
      scene: 'Menu',
      steps: [
        { type: 'wait', frames: 2 },
        { type: 'assertScene', scene: 'scn_menu' },
      ],
    });
    const result = await runPlaytest(store, 'by id');
    expect(result.passed).toBe(true);
  });
});

describe('runSceneSmoke across scene switches', () => {
  it('keeps running after ctx.scenes.load and reports the final scene', async () => {
    const { store } = await makeMenuGame(
      `export default { onStart(ctx) { ctx.scenes.load('Level'); } };`,
    );
    const result = await runSceneSmoke(store, 'Menu', 10);
    expect(result.passed).toBe(true);
    expect(result.framesRun).toBe(10);
    expect(result.finalScene).toBe('scn_level');
    expect(result.sceneEvents).toEqual([{ frame: 1, from: 'scn_menu', to: 'scn_level' }]);
    expect(result.entityCount).toBe(1); // Hero, in the Level scene
  });
});

describe('createRuntimeHooks', () => {
  it('wires both hooks', () => {
    const hooks = createRuntimeHooks();
    expect(typeof hooks.runPlaytest).toBe('function');
    expect(typeof hooks.runSceneSmoke).toBe('function');
  });
});
