import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore, validateProject } from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import { SceneRuntime } from '@hearth/runtime';
import { runPlaytest, runSceneSmoke } from '@hearth/playtest';

const examplesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = [
  'mini-platformer',
  'top-down-room',
  'visual-novel',
  'ember-trail',
  'glow-caves',
  'bounce-patrol',
];

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

// Glow Caves is the rendering-v2 showcase: a dark scene (Camera.ambientLight)
// lit by a player-following Light2D torch, LineRenderer cave-wall outlines,
// two ParticleEmitters (torch sparks + a drip trail), and a SpriteAnimator
// driven flame — all scripted in Lua, all asserted headlessly.
describe('glow-caves v0.3 showcase (rendering v2)', () => {
  it('is scripted entirely in Lua', async () => {
    const store = await loadStore('glow-caves');
    const scripts = await store.listScripts();
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.every((p) => p.endsWith('.lua'))).toBe(true);
  });

  it('the scene is dark, lit by a Light2D torch parented to the player', async () => {
    const store = await loadStore('glow-caves');
    const scene = store.getScene('Cave')!;
    const camera = scene.entities.find((e) => e.name === 'Main Camera')!;
    expect(camera.components.Camera!.ambientLight).toBeLessThan(0.5);

    const player = scene.entities.find((e) => e.name === 'Player')!;
    const torch = scene.entities.find((e) => e.name === 'Torch')!;
    expect(torch.parentId).toBe(player.id);
    expect(torch.components.Light2D).toBeDefined();
    expect(torch.components.Light2D!.enabled).toBe(true);
    expect(torch.components.SpriteAnimator).toBeDefined();
    expect(torch.components.ParticleEmitter).toBeDefined();
  });

  it('has cave-wall LineRenderer geometry', async () => {
    const store = await loadStore('glow-caves');
    const scene = store.getScene('Cave')!;
    const walls = scene.entities.filter((e) => e.components.LineRenderer);
    expect(walls.length).toBeGreaterThanOrEqual(2);
    for (const wall of walls) {
      expect(wall.components.LineRenderer!.points.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('the showcase playtest asserts deterministic particle counts and the animator frame', async () => {
    const store = await loadStore('glow-caves');
    const result = await runPlaytest(store, 'glow-caves-showcase');
    expect(result.passed).toBe(true);
    expect(result.particleCounts.Drip).toBeGreaterThan(0);
    expect(result.particleCounts.Torch).toBeGreaterThan(0);
  });

  it('produces the same particle counts and animator frame on a second run (deterministic)', async () => {
    const store = await loadStore('glow-caves');
    const first = await runPlaytest(store, 'glow-caves-showcase');
    const second = await runPlaytest(store, 'glow-caves-showcase');
    expect(first.passed).toBe(true);
    expect(second.particleCounts).toEqual(first.particleCounts);
  });

  it('the torch script dogfoods ctx.particles.burst/count (extra embers logged)', async () => {
    const store = await loadStore('glow-caves');
    const result = await runSceneSmoke(store, 'Cave', 130);
    expect(result.errors).toEqual([]);
    expect(result.logs.some((l) => l.message.includes('torch embers:'))).toBe(true);
  });
});

// Bounce Patrol is the wave B showcase: physics v2 (mass/restitution/
// friction, layered/one-way colliders), ctx.events + onEvent, and
// ctx.scene.findPath driving a kinematic patroller — all scripted in Lua,
// all asserted headlessly via probe-baked playtests.
describe('bounce-patrol v0.5 showcase (physics v2 + events + findPath)', () => {
  it('is scripted entirely in Lua', async () => {
    const store = await loadStore('bounce-patrol');
    const scripts = await store.listScripts();
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.every((p) => p.endsWith('.lua'))).toBe(true);
  });

  it('has the expected cast', async () => {
    const store = await loadStore('bounce-patrol');
    const scene = store.getScene('Arena')!;
    const names = scene.entities.map((e) => e.name);
    expect(names).toContain('Player');
    expect(names).toContain('Ball');
    expect(names).toContain('Ice Patch');
    expect(names).toContain('Grind Strip');
    expect(names).toContain('Ledge');
    expect(names).toContain('Patroller');
    expect(names).toContain('Score');
    expect(names.filter((n) => n.startsWith('Coin')).length).toBe(3);
    expect(store.playtests.size).toBe(5);
  });

  it('the arena Tilemap has an interior wall with a gap', async () => {
    const store = await loadStore('bounce-patrol');
    const scene = store.getScene('Arena')!;
    const arena = scene.entities.find((e) => e.name === 'Arena')!;
    const grid = arena.components.Tilemap!.grid;
    expect(grid.length).toBeGreaterThan(2);
    // The interior wall column is solid on some rows and open ('.') on
    // at least one row (the gap findPath routes the Patroller through).
    const col = 12;
    const chars = grid.slice(1, -1).map((row) => row[col]);
    expect(chars.some((c) => c !== '.')).toBe(true);
    expect(chars.some((c) => c === '.')).toBe(true);
  });

  it('physics v2 fields are set: Ball restitution, floor friction contrast, one-way Ledge, layered coins', async () => {
    const store = await loadStore('bounce-patrol');
    const scene = store.getScene('Arena')!;
    const byName = (n: string) => scene.entities.find((e) => e.name === n)!;
    expect(byName('Ball').components.PhysicsBody!.restitution).toBeCloseTo(0.85);
    expect(byName('Ice Patch').components.PhysicsBody!.friction).toBe(0);
    expect(byName('Grind Strip').components.PhysicsBody!.friction).toBe(1);
    expect(byName('Ledge').components.Collider!.oneWay).toBe(true);
    expect(byName('Player').components.Collider!.layer).toBe('player');
    for (let i = 1; i <= 3; i++) {
      const coin = byName(`Coin ${i}`);
      expect(coin.components.Collider!.layer).toBe('pickup');
      expect(coin.components.Collider!.collidesWith).toEqual(['player']);
    }
  });

  it('the Ball bounces deterministically off the arena floor', async () => {
    const store = await loadStore('bounce-patrol');
    const first = await runPlaytest(store, 'bounce-determinism');
    expect(first.passed).toBe(true);
    const second = await runPlaytest(store, 'bounce-determinism');
    expect(second.passed).toBe(true);
  });

  it('walking the player onto a coin emits the coin event', async () => {
    const store = await loadStore('bounce-patrol');
    const result = await runPlaytest(store, 'coin-collected');
    expect(result.passed).toBe(true);
    expect(result.eventCounts.coin).toBeGreaterThanOrEqual(1);
    expect(result.events.some((e) => e.name === 'coin')).toBe(true);
  });

  it('the ScoreUI text updates when a coin is collected (ctx.events + onEvent)', async () => {
    const store = await loadStore('bounce-patrol');
    const runtime = await SceneRuntime.create(store, store.project.initialScene);
    runtime.input.setActionDown('right');
    runtime.run(40); // matches the coin-collected playtest's walk-right frame count
    runtime.input.setActionUp('right');
    expect(runtime.errors).toEqual([]);
    const score = runtime.getEntities().find((e) => e.name === 'Score')!;
    expect(score.components.Text!.content).toBe('Score: 1');
  });

  it('the player passes through the one-way Ledge from below and ends up above it', async () => {
    const store = await loadStore('bounce-patrol');
    const result = await runPlaytest(store, 'one-way-ledge');
    expect(result.passed).toBe(true);
  });

  it('the Patroller finds a path around the interior wall and leaves its spawn', async () => {
    const store = await loadStore('bounce-patrol');
    const result = await runPlaytest(store, 'patroller-pathfinds');
    expect(result.passed).toBe(true);
  });

  it('the smoke playtest passes with no script errors', async () => {
    const store = await loadStore('bounce-patrol');
    const result = await runPlaytest(store, 'smoke');
    expect(result.passed).toBe(true);
  });
});
