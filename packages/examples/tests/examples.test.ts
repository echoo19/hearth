import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore, validateProject } from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import { SceneRuntime } from '@hearth/runtime';
import { runPlaytest } from '@hearth/playtest';

const examplesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = ['mini-platformer', 'top-down-room', 'visual-novel', 'ember-trail'];

function loadStore(name: string) {
  return ProjectStore.load(new NodeFileSystem(), path.join(examplesDir, name));
}

describe('example projects', () => {
  for (const name of EXAMPLES) {
    it(`${name} loads and validates with zero errors`, async () => {
      const store = await loadStore(name);
      expect(store.project.initialScene).toBeTruthy();
      expect(store.scenes.size).toBeGreaterThan(0);
      const report = await validateProject(store);
      expect(report.errors).toEqual([]);
    });
  }

  it('mini-platformer has the expected cast', async () => {
    const store = await loadStore('mini-platformer');
    const scene = store.getScene('Level 1')!;
    const names = scene.entities.map((e) => e.name);
    expect(names).toContain('Player');
    expect(names).toContain('Enemy');
    expect(names).toContain('Score');
    expect(names).toContain('Spikes');
    expect(names).toContain('Restart');
    expect(names).toContain('Ambience');
    expect(names.filter((n) => n.startsWith('Coin')).length).toBe(3);
    expect(store.playtests.size).toBe(5);
  });
});

// The playtest JSON schema has no audio assertion step and no pointer step,
// so audio and UI-click behavior are asserted here instead: runPlaytest
// returns the run's audioEvents, and SceneRuntime.sendPointer drives the
// interactive UIElement directly.
describe('mini-platformer v0.2 showcase (audio + UI)', () => {
  it('ambience autoplays: the smoke playtest records an audio event', async () => {
    const store = await loadStore('mini-platformer');
    const result = await runPlaytest(store, 'smoke');
    expect(result.passed).toBe(true);
    const ambience = store.getAsset('ambience')!;
    expect(
      result.audioEvents.some((e) => e.assetId === ambience.id && e.action === 'play'),
    ).toBe(true);
  });

  it('jumping plays the jump sound', async () => {
    const store = await loadStore('mini-platformer');
    const result = await runPlaytest(store, 'jump-works');
    expect(result.passed).toBe(true);
    const jump = store.getAsset('jump-sound')!;
    expect(result.audioEvents.some((e) => e.assetId === jump.id && e.action === 'play')).toBe(
      true,
    );
  });

  it('the polygon spike respawns the player and plays the hit sound', async () => {
    const store = await loadStore('mini-platformer');
    const result = await runPlaytest(store, 'spikes-respawn-player');
    expect(result.passed).toBe(true);
    const hit = store.getAsset('hit-sound')!;
    expect(result.audioEvents.some((e) => e.assetId === hit.id && e.action === 'play')).toBe(
      true,
    );
  });

  it('clicking the Restart button resets the score and plays the click sound', async () => {
    const store = await loadStore('mini-platformer');
    const runtime = await SceneRuntime.create(store, store.project.initialScene);
    runtime.run(60); // land; ambience autoplay fires

    const score = runtime.getEntities().find((e) => e.name === 'Score')!;
    score.components.Text!.content = 'Score: 3';

    // Restart is anchored top-right with offset (-80, 32) → screen (720, 32)
    // in the 800×600 buildSettings space.
    runtime.sendPointer(720, 32, 'down');
    runtime.sendPointer(720, 32, 'up');

    expect(score.components.Text!.content).toBe('Score: 0');
    const click = store.getAsset('click-sound')!;
    expect(
      runtime.audioEvents.some((e) => e.assetId === click.id && e.action === 'play'),
    ).toBe(true);
    expect(runtime.errors).toEqual([]);
  });
});

// Ember Trail is the all-Lua showcase: every script runs through the wasmoon
// Lua engine, the menu is a user-built start screen (interactive UIElement +
// ctx.scenes.load), and the level exercises ctx.timers, seeded ctx.random,
// ctx.camera.follow, and ctx.save/ctx.load — headlessly, end to end.
describe('ember-trail v0.3 showcase (Lua + scenes + stdlib)', () => {
  it('is scripted entirely in Lua', async () => {
    const store = await loadStore('ember-trail');
    const scripts = await store.listScripts();
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.every((p) => p.endsWith('.lua'))).toBe(true);
  });

  it('clicking Start switches to the Level scene (Lua onUiEvent + ctx.scenes.load)', async () => {
    const store = await loadStore('ember-trail');
    const result = await runPlaytest(store, 'menu-start');
    expect(result.passed).toBe(true);
    const level = store.getScene('Level')!;
    expect(result.finalScene).toBe(level.id);
    expect(result.sceneEvents.length).toBe(1);
    expect(result.sceneEvents[0].to).toBe(level.id);
    const start = store.getAsset('start-sound')!;
    expect(result.audioEvents.some((e) => e.assetId === start.id && e.action === 'play')).toBe(
      true,
    );
  });

  it('the level runs: timers spawn embers, the camera follows the player', async () => {
    const store = await loadStore('ember-trail');
    const result = await runPlaytest(store, 'level-runs');
    expect(result.passed).toBe(true);
    expect(result.logs.some((l) => l.message.includes('spawned Ember 1'))).toBe(true);
  });

  it('same seed, same run: two level-runs executions produce identical logs', async () => {
    const store = await loadStore('ember-trail');
    const first = await runPlaytest(store, 'level-runs');
    const second = await runPlaytest(store, 'level-runs');
    expect(first.passed).toBe(true);
    // Spawn positions come from seeded ctx.random and are logged with full
    // float precision — byte-identical logs prove the deterministic stream.
    expect(second.logs.map((l) => [l.frame, l.message])).toEqual(
      first.logs.map((l) => [l.frame, l.message]),
    );
  });

  it('the run clock ends back at the menu with the best score saved', async () => {
    const store = await loadStore('ember-trail');
    const result = await runPlaytest(store, 'run-ends-back-at-menu');
    expect(result.passed).toBe(true);
    const menu = store.getScene('Menu')!;
    expect(result.finalScene).toBe(menu.id);
  });
});
