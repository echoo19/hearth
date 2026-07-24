/**
 * Unresponsive-input detection — hold each declared control from the opening
 * state and see whether anything observable changes beyond what a no-input
 * control run already produces. An input with no effect over the window is
 * flagged; a crashing one is a blocker.
 */
import { describe, it, expect } from 'vitest';
import {
  MemoryFileSystem,
  ProjectStore,
  SceneSchema,
  createProject,
} from '@hearth/core';
import { probeResponsiveness } from '@hearth/playtest';

/** Reads 'jump' (fires an event) but does nothing for the declared 'dash'; 'boom' throws. */
const RESPONDER = `export default {
  onUpdate(ctx) {
    if (ctx.input.isDown('jump')) ctx.events.emit('jumped');
    if (ctx.input.isDown('boom')) { const x = null; x.y = 1; }
    // 'dash' is declared but nothing here reads or responds to it.
  },
};`;

async function makeInputGame(): Promise<ProjectStore> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/g', { name: 'Input Game', starterScene: false });
  store.project.inputMappings = {
    actions: { jump: ['Space'], dash: ['ShiftLeft'], boom: ['KeyB'] },
    axes: {},
  } as typeof store.project.inputMappings;
  store.project.scenes.push({ id: 'scn_test', name: 'Test', path: 'scenes/test.scene.json' });
  store.project.initialScene = 'scn_test';
  store.scenes.set(
    'scn_test',
    SceneSchema.parse({
      formatVersion: 1,
      id: 'scn_test',
      name: 'Test',
      entities: [
        {
          id: 'ent_hero',
          name: 'Hero',
          parentId: null,
          enabled: true,
          tags: [],
          components: { Transform: { position: { x: 0, y: 0 } }, Script: { scriptPath: 'scripts/hero.js' } },
        },
      ],
    }),
  );
  await fs.writeFile('/g/scripts/hero.js', RESPONDER);
  await store.save();
  return ProjectStore.load(fs, '/g');
}

/** Avatar drifts +1px/frame on its own; 'boost' adds movement, 'noop' does nothing. */
const DRIFTER = `export default {
  onUpdate(ctx) {
    ctx.transform.position.x += 1;
    if (ctx.input.isDown('boost')) ctx.transform.position.x += 6;
    if (ctx.input.isDown('noop')) { const z = 1; void z; }
  },
};`;

async function makeDriftGame(): Promise<ProjectStore> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/g', { name: 'Drift Game', starterScene: false });
  store.project.inputMappings = {
    actions: { boost: ['Space'], noop: ['KeyN'] },
    axes: {},
  } as typeof store.project.inputMappings;
  store.project.scenes.push({ id: 'scn_test', name: 'Test', path: 'scenes/test.scene.json' });
  store.project.initialScene = 'scn_test';
  store.scenes.set(
    'scn_test',
    SceneSchema.parse({
      formatVersion: 1,
      id: 'scn_test',
      name: 'Test',
      entities: [
        {
          id: 'ent_hero',
          name: 'Hero',
          parentId: null,
          enabled: true,
          tags: [],
          components: { Transform: { position: { x: 0, y: 0 } }, Script: { scriptPath: 'scripts/hero.js' } },
        },
      ],
    }),
  );
  await fs.writeFile('/g/scripts/hero.js', DRIFTER);
  await store.save();
  return ProjectStore.load(fs, '/g');
}

describe('probeResponsiveness', () => {
  it('flags a declared input that produces no observable change', async () => {
    const store = await makeInputGame();
    const findings = await probeResponsiveness(store, 'Test', {});
    const dash = findings.find((f) => f.kind === 'unresponsive-input' && f.summary.includes('dash'));
    expect(dash).toBeDefined();
  });

  it('does not flag an input that produces an observable effect', async () => {
    const store = await makeInputGame();
    const findings = await probeResponsiveness(store, 'Test', {});
    expect(findings.some((f) => f.kind === 'unresponsive-input' && f.summary.includes('jump'))).toBe(false);
  });

  it('reports an input that crashes the game as a blocker', async () => {
    const store = await makeInputGame();
    const findings = await probeResponsiveness(store, 'Test', {});
    const boom = findings.find((f) => f.kind === 'crash-on-input');
    expect(boom).toBeDefined();
    expect(boom!.severity).toBe('blocker');
  });

  it('does not flag a movement input just because the avatar also drifts on its own', async () => {
    // The avatar drifts +1px/frame regardless (like gravity). "boost" adds extra
    // movement; "noop" is read but does nothing. Only "noop" is unresponsive —
    // boost's displacement genuinely differs from the no-input control.
    const store = await makeDriftGame();
    const findings = await probeResponsiveness(store, 'Test', {});
    expect(findings.some((f) => f.kind === 'unresponsive-input' && f.summary.includes('boost'))).toBe(false);
    expect(findings.some((f) => f.kind === 'unresponsive-input' && f.summary.includes('noop'))).toBe(true);
  });
});
