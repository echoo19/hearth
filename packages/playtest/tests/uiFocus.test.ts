/**
 * Task 11 playtest steps: `drag` (pointer down/interpolated moves/up over
 * several frames, driving a UISlider) and `assertFocus` (matches
 * ctx.ui.focus's current target by name/id, or null for nothing focused).
 * Results also gain `focusedEntity`.
 */
import { describe, it, expect } from 'vitest';
import { MemoryFileSystem, ProjectStore, SceneSchema, createProject, HearthSession } from '@hearth/core';
import { runPlaytest, createRuntimeHooks } from '@hearth/playtest';

/** Single-scene project: a UISlider ('Vol') and two focusable UIElement buttons ('Resume', 'Quit'). */
async function makeMenuGame(startScript?: string): Promise<{ store: ProjectStore; session: HearthSession }> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Focus Game', starterScene: false });
  store.project.scenes.push({ id: 'scn_menu', name: 'Menu', path: 'scenes/menu.scene.json' });
  store.project.initialScene = 'scn_menu';
  const entities: Record<string, unknown>[] = [
    {
      id: 'ent_vol',
      name: 'Vol',
      parentId: null,
      enabled: true,
      tags: [],
      components: {
        Transform: {},
        // Center (200,100), width 160 => track spans x = 120..280 (matches uiWidgets.test.ts math).
        UIElement: { interactive: true, anchor: 'top-left', offset: { x: 200, y: 100 } },
        UISlider: { min: 0, max: 1, value: 0, step: 0, width: 160 },
      },
    },
    {
      id: 'ent_resume',
      name: 'Resume',
      parentId: null,
      enabled: true,
      tags: [],
      components: {
        Transform: {},
        UIElement: { interactive: true, focusable: true, anchor: 'top-left', offset: { x: 50, y: 50 } },
      },
    },
    {
      id: 'ent_quit',
      name: 'Quit',
      parentId: null,
      enabled: true,
      tags: [],
      components: {
        Transform: {},
        UIElement: { interactive: true, focusable: true, anchor: 'top-left', offset: { x: 50, y: 100 } },
      },
    },
  ];
  if (startScript) {
    (entities[1].components as Record<string, unknown>).Script = { scriptPath: 'scripts/menu.js' };
    await fs.writeFile('/proj/scripts/menu.js', startScript);
  }
  store.scenes.set(
    'scn_menu',
    SceneSchema.parse({ formatVersion: 1, id: 'scn_menu', name: 'Menu', entities }),
  );
  await store.save();
  const loaded = await ProjectStore.load(fs, '/proj');
  const session = HearthSession.fromStore(loaded, { runtime: createRuntimeHooks() });
  return { store: loaded, session };
}

describe('drag playtest step', () => {
  it('drags a slider from its left edge to its center, landing on ~0.5', async () => {
    const { store, session } = await makeMenuGame();
    await session.execute('createPlaytest', {
      name: 'drag slider',
      scene: 'Menu',
      steps: [
        { type: 'drag', from: { x: 120, y: 100 }, to: { x: 200, y: 100 } },
        { type: 'assertProperty', entity: 'Vol', property: 'UISlider.value', greaterThan: 0.45 },
        { type: 'assertProperty', entity: 'Vol', property: 'UISlider.value', lessThan: 0.55 },
        { type: 'assertNoErrors' },
      ],
    });
    const result = await runPlaytest(store, 'drag slider');
    expect(result.steps.map((s) => `${s.type}:${s.passed}`)).toEqual([
      'drag:true',
      'assertProperty:true',
      'assertProperty:true',
      'assertNoErrors:true',
    ]);
    expect(result.passed).toBe(true);
    // down + 5 default interpolated moves + up = 7 frames.
    expect(result.framesRun).toBe(7);
  });

  it('honors an explicit frames count', async () => {
    const { store, session } = await makeMenuGame();
    await session.execute('createPlaytest', {
      name: 'drag slider custom frames',
      scene: 'Menu',
      steps: [
        { type: 'drag', from: { x: 120, y: 100 }, to: { x: 280, y: 100 }, frames: 2 },
        { type: 'assertProperty', entity: 'Vol', property: 'UISlider.value', equals: 1 },
      ],
    });
    const result = await runPlaytest(store, 'drag slider custom frames');
    expect(result.passed).toBe(true);
    expect(result.framesRun).toBe(4); // down + 2 moves + up
  });
});

const FOCUS_RESUME_SCRIPT = `export default {
  onStart(ctx) { ctx.ui.focus('Resume'); },
};`;

describe('assertFocus playtest step', () => {
  it('passes null before any focus call, and the focused name after ctx.ui.focus', async () => {
    const { store, session } = await makeMenuGame();
    await session.execute('createPlaytest', {
      name: 'nothing focused',
      scene: 'Menu',
      steps: [{ type: 'assertFocus', entity: null }],
    });
    const result = await runPlaytest(store, 'nothing focused');
    expect(result.passed).toBe(true);
    expect(result.focusedEntity).toBeNull();
  });

  it('matches the entity name a script focused via ctx.ui.focus', async () => {
    const { store, session } = await makeMenuGame(FOCUS_RESUME_SCRIPT);
    await session.execute('createPlaytest', {
      name: 'resume focused',
      scene: 'Menu',
      steps: [
        { type: 'wait', frames: 1 },
        { type: 'assertFocus', entity: 'Resume' },
        { type: 'assertFocus', entity: 'Quit' },
      ],
    });
    const result = await runPlaytest(store, 'resume focused');
    expect(result.steps.map((s) => `${s.type}:${s.passed}`)).toEqual([
      'wait:true',
      'assertFocus:true',
      'assertFocus:false',
    ]);
    expect(result.passed).toBe(false);
    expect(result.focusedEntity).toBe('Resume');
  });
});
