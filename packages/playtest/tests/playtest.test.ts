/**
 * End-to-end playtest execution against projects built in memory with
 * createProject + HearthSession commands.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, createProject, HearthSession, type ProjectStore } from '@hearth/core';
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

/** Starter project (Main scene: Camera, Ground, Player) plus a movement script. */
async function makeProject(): Promise<{ store: ProjectStore; session: HearthSession }> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Playtest Game' });
  const session = HearthSession.fromStore(store, { runtime: createRuntimeHooks() });
  const created = await session.execute<{ path: string }>('createScript', {
    name: 'player move',
    source: MOVE_SCRIPT,
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
      ],
    });
    const result = await runPlaytest(store, 'capped');
    expect(result.framesRun).toBe(50);
    expect(result.steps[0].message).toMatch(/maxFrames cap/);
    expect(result.steps[1].message).toMatch(/0\/100 frames/);
    expect(result.steps[2].passed).toBe(true);
    expect(result.steps[2].message).toMatch(/evaluated at maxFrames cap/);
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

describe('createRuntimeHooks', () => {
  it('wires both hooks', () => {
    const hooks = createRuntimeHooks();
    expect(typeof hooks.runPlaytest).toBe('function');
    expect(typeof hooks.runSceneSmoke).toBe('function');
  });
});
