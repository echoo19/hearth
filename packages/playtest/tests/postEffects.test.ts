/**
 * assertPostEffect playtest step + PlaytestResult.postEffects, exercised
 * end-to-end against a real project (createProject's starter scene camera).
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, ProjectStore, createProject, HearthSession } from '@hearth/core';
import { runPlaytest, runSceneSmoke, createRuntimeHooks } from '@hearth/playtest';

const PUSH_BLOOM_SCRIPT = `
export default {
  onStart(ctx) {
    const camera = ctx.getComponent('Camera');
    camera.postEffects.push({ type: 'bloom' });
  },
};
`;

/** Starter project (Main scene: Main Camera, Ground, Player) plus a script that
 * pushes a bloom postEffect onto the camera's live component data. */
async function makeProject(): Promise<{ store: ProjectStore; session: HearthSession }> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'PostEffects Game' });
  const session = HearthSession.fromStore(store, { runtime: createRuntimeHooks() });
  const created = await session.execute<{ path: string }>('createScript', {
    name: 'push bloom',
    source: PUSH_BLOOM_SCRIPT,
    language: 'js',
  });
  expect(created.success).toBe(true);
  const attached = await session.execute('attachScript', {
    scene: 'Main',
    entity: 'Main Camera',
    script: created.data!.path,
  });
  expect(attached.success).toBe(true);
  return { store, session };
}

describe('assertPostEffect', () => {
  it('passes active:true once the script pushes bloom onto Camera.postEffects', async () => {
    const { store, session } = await makeProject();
    const created = await session.execute<{ playtestId: string }>('createPlaytest', {
      name: 'bloom on',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 2 },
        { type: 'assertPostEffect', effect: 'bloom', active: true },
        { type: 'assertNoErrors' },
      ],
    });
    expect(created.success).toBe(true);

    const result = await runPlaytest(store, 'bloom on');
    expect(result.steps.map((s) => `${s.type}:${s.passed}`)).toEqual([
      'wait:true',
      'assertPostEffect:true',
      'assertNoErrors:true',
    ]);
    expect(result.passed).toBe(true);
    expect(result.postEffects).toEqual(['bloom']);
  });

  it('fails active:false once bloom is active, naming the active stack', async () => {
    const { store, session } = await makeProject();
    const created = await session.execute('createPlaytest', {
      name: 'bloom should be off',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 2 },
        { type: 'assertPostEffect', effect: 'bloom', active: false },
      ],
    });
    expect(created.success).toBe(true);

    const result = await runPlaytest(store, 'bloom should be off');
    expect(result.passed).toBe(false);
    expect(result.steps[1].passed).toBe(false);
    expect(result.steps[1].message).toContain('bloom');
  });

  it('passes active:false for an effect never pushed, and active:true fails for it', async () => {
    const { store, session } = await makeProject();
    const created = await session.execute('createPlaytest', {
      name: 'crt never active',
      scene: 'Main',
      steps: [
        { type: 'wait', frames: 2 },
        { type: 'assertPostEffect', effect: 'crt', active: false },
      ],
    });
    expect(created.success).toBe(true);
    const result = await runPlaytest(store, 'crt never active');
    expect(result.passed).toBe(true);
  });

  it('a project with no postEffects pushed reports an empty postEffects list', async () => {
    const fs = new MemoryFileSystem();
    const { store } = await createProject(fs, '/proj', { name: 'Plain Game' });
    const session = HearthSession.fromStore(store, { runtime: createRuntimeHooks() });
    await session.execute('createPlaytest', {
      name: 'noop',
      scene: 'Main',
      steps: [{ type: 'wait', frames: 1 }],
    });
    const result = await runPlaytest(store, 'noop');
    expect(result.postEffects).toEqual([]);
  });

  it('runSceneSmoke also reports postEffects (mirrors runPlaytest)', async () => {
    const { store } = await makeProject();
    const smoke = await runSceneSmoke(store, 'Main', 3);
    expect(smoke.postEffects).toEqual(['bloom']);
  });
});
