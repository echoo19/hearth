import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore, validateProject, AUTOTILE_SHAPES } from '@hearth/core';
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
  'sky-courier',
  'drift-cellar',
  'ember-horde',
  'ember-arcade',
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
// driven flame — all scripted in Lua, all asserted headlessly. As of Task
// 12 it's also the blob47 autotile showcase: a "Cave Rocks" Tilemap whose
// 'R' char is bound to a generated blob47 sheet.
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

  it('Cave Rocks is a blob47 autotile Tilemap over a fully-covered generated sheet', async () => {
    const store = await loadStore('glow-caves');
    const scene = store.getScene('Cave')!;
    const rocks = scene.entities.find((e) => e.name === 'Cave Rocks')!;
    const tilemap = rocks.components.Tilemap!;
    const rule = tilemap.tileAssets.R;
    expect(rule).toEqual(expect.objectContaining({ template: 'blob47' }));
    expect(typeof rule).not.toBe('string');
    const sheetAssetId = (rule as { sheet: string }).sheet;
    const sheet = store.getAsset(sheetAssetId)!;
    expect(sheet.name).toBe('cave-rock-blob47');
    const frameNames = new Set(((sheet.metadata as any).frames as { name: string }[]).map((f) => f.name));
    // Every canonical blob47 shape has a frame — setTileAutotile would have
    // refused the rule otherwise (AUTOTILE_FRAME_MISSING).
    for (const shape of AUTOTILE_SHAPES) {
      expect(frameNames.has(`blob_${shape}`)).toBe(true);
    }
    expect(tilemap.grid.some((row) => row.includes('R'))).toBe(true);
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

// Sky Courier is the wave C showcase: every prior example's sprites are
// procedural SVGs, but this one's character sheet and music are real
// imported binary assets (a hand-drawn PNG spritesheet sliced with
// sliceSpritesheet/createAnimationFromSheet, and a synthesized WAV chiptune
// loop) plus a genuinely imported TTF font. All scripted in Lua, all
// asserted headlessly via probe-baked playtests.
describe('sky-courier v0.6 showcase (imported binary assets)', () => {
  it('is scripted entirely in Lua', async () => {
    const store = await loadStore('sky-courier');
    const scripts = await store.listScripts();
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.every((p) => p.endsWith('.lua'))).toBe(true);
  });

  it('has the expected cast', async () => {
    const store = await loadStore('sky-courier');
    const scene = store.getScene('Rooftops')!;
    const names = scene.entities.map((e) => e.name);
    expect(names).toContain('Courier');
    expect(names).toContain('Chute');
    expect(names).toContain('HUD');
    expect(names.filter((n) => n.startsWith('Parcel')).length).toBe(3);
    expect(store.playtests.size).toBe(4);
  });

  it('the character sheet is a real imported PNG, sliced into named frames', async () => {
    const store = await loadStore('sky-courier');
    const sheet = store.getAsset('courier-sheet')!;
    expect(sheet.metadata.width).toBe(96);
    expect(sheet.metadata.height).toBe(16);
    expect((sheet.metadata as any).frames.length).toBe(6);
    const walk = store.getAsset('courier-walk')!;
    expect(walk.type).toBe('animation');
  });

  it('the font asset is a real imported TTF, referenced by name from the HUD/Title text', async () => {
    const store = await loadStore('sky-courier');
    const font = store.getAsset('press-start-2p')!;
    expect(font.type).toBe('font');
    const scene = store.getScene('Rooftops')!;
    const hud = scene.entities.find((e) => e.name === 'HUD')!;
    const title = scene.entities.find((e) => e.name === 'Title')!;
    expect(hud.components.Text!.fontFamily).toBe('press-start-2p');
    expect(title.components.Text!.fontFamily).toBe('press-start-2p');
  });

  it('the music track autoplays exactly once on the shared music channel', async () => {
    const store = await loadStore('sky-courier');
    const result = await runPlaytest(store, 'boot');
    expect(result.passed).toBe(true);
    const music = store.getAsset('rooftop-loop')!;
    // The `music: true` filter itself is asserted inside the "boot"
    // playtest's own assertAudioCount step; this just confirms the same
    // asset id shows up in the recorded playback (AudioEventEntry has no
    // `music` field to re-check from the test side).
    expect(result.audioEvents.some((e) => e.assetId === music.id && e.action === 'play')).toBe(true);
  });

  it('the courier walks right and switches to the walk animation clip', async () => {
    const store = await loadStore('sky-courier');
    const result = await runPlaytest(store, 'movement');
    expect(result.passed).toBe(true);
  });

  it('idle/walk is driven by an AnimationStateMachine, not a hand-toggled SpriteAnimator', async () => {
    const store = await loadStore('sky-courier');
    const scene = store.getScene('Rooftops')!;
    const courier = scene.entities.find((e) => e.name === 'Courier')!;
    expect(courier.components.AnimationStateMachine).toBeDefined();
    expect(courier.components.SpriteAnimator).toBeUndefined();

    const runtime = await SceneRuntime.create(store, store.project.initialScene);
    runtime.run(1); // the state machine initializes its first state on the first tick
    expect(runtime.getStateMachineState('Courier')).toBe('idle');
    runtime.input.setActionDown('right');
    runtime.run(15); // matches the movement playtest's MOVE_FRAMES
    expect(runtime.getStateMachineState('Courier')).toBe('walk');
    runtime.input.setActionUp('right');
    runtime.run(30); // long enough for the "moving" bool to flip back to idle
    expect(runtime.getStateMachineState('Courier')).toBe('idle');
    expect(runtime.errors).toEqual([]);
  });

  it('walking the courier onto Parcel 1 emits the parcel event', async () => {
    const store = await loadStore('sky-courier');
    const result = await runPlaytest(store, 'pickup');
    expect(result.passed).toBe(true);
    expect(result.eventCounts.parcel).toBeGreaterThanOrEqual(1);
  });

  it('the HUD text updates when a parcel is collected (ctx.events + onEvent)', async () => {
    const store = await loadStore('sky-courier');
    const runtime = await SceneRuntime.create(store, store.project.initialScene);
    runtime.input.setActionDown('right');
    runtime.run(45); // matches the pickup playtest's walk-right frame count
    runtime.input.setActionUp('right');
    expect(runtime.errors).toEqual([]);
    const hud = runtime.getEntities().find((e) => e.name === 'HUD')!;
    expect(hud.components.Text!.content).toBe('Parcels: 1/3');
  });

  it('the smoke playtest passes with no script errors', async () => {
    const store = await loadStore('sky-courier');
    const result = await runPlaytest(store, 'smoke');
    expect(result.passed).toBe(true);
  });
});

// Drift Cellar is the wave D showcase: analog virtual axes (ctx.input.axis
// with gamepad stick + keyboard fallback), gamepadButtons action bindings,
// camera effects (shake/flash/fade/zoomPunch), the widget set (UILayout/
// UISlider/UIToggle + focusable UIElements), and ctx.ui focus navigation —
// all scripted in Lua, all asserted headlessly via probe-baked playtests.
describe('drift-cellar v0.7 showcase (axes + gamepad + widgets + camera effects)', () => {
  it('is scripted entirely in Lua', async () => {
    const store = await loadStore('drift-cellar');
    const scripts = await store.listScripts();
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.every((p) => p.endsWith('.lua'))).toBe(true);
  });

  it('has the expected cast and playtests', async () => {
    const store = await loadStore('drift-cellar');
    const scene = store.getScene('Cellar')!;
    const names = scene.entities.map((e) => e.name);
    expect(names).toContain('Player');
    expect(names).toContain('Pause Menu');
    expect(names).toContain('Resume');
    expect(names).toContain('Music Volume');
    expect(names).toContain('Screen Shake');
    expect(names).toContain('Gems HUD');
    expect(names.filter((n) => n.startsWith('Gem ')).length).toBe(3);
    expect(store.getScene('Vault')).toBeDefined();
    expect(store.playtests.size).toBe(7);
  });

  it('declares virtual axes and gamepad button bindings in inputMappings', async () => {
    const store = await loadStore('drift-cellar');
    const mappings = store.project.inputMappings;
    expect(mappings.axes.moveX.gamepadAxis).toBe(0);
    expect(mappings.axes.moveX.negativeCodes).toContain('KeyA');
    expect(mappings.axes.moveX.positiveCodes).toContain('KeyD');
    expect(mappings.axes.moveY.gamepadAxis).toBe(1);
    expect(mappings.actions.dash).toEqual(['Space']);
    expect(mappings.gamepadButtons.dash).toEqual(['a']);
    expect(mappings.gamepadButtons.pause).toEqual(['start']);
  });

  it('builds the pause menu from the widget set, every control focusable', async () => {
    const store = await loadStore('drift-cellar');
    const scene = store.getScene('Cellar')!;
    const byName = (n: string) => scene.entities.find((e) => e.name === n)!;
    const menu = byName('Pause Menu');
    expect(menu.components.UILayout!.direction).toBe('vertical');
    const slider = byName('Music Volume');
    expect(slider.components.UISlider!.step).toBeCloseTo(0.1);
    expect(slider.components.UIElement!.focusable).toBe(true);
    const toggle = byName('Screen Shake');
    expect(toggle.components.UIToggle!.value).toBe(true);
    expect(toggle.components.UIElement!.focusable).toBe(true);
    expect(byName('Resume').components.UIElement!.focusable).toBe(true);
    // Menu children stack under the UILayout container.
    expect(byName('Resume').parentId).toBe(menu.id);
    expect(slider.parentId).toBe(menu.id);
    expect(toggle.parentId).toBe(menu.id);
  });

  it('drifts deterministically on setAxis input (drift-movement playtest)', async () => {
    const store = await loadStore('drift-cellar');
    const result = await runPlaytest(store, 'drift-movement');
    expect(result.passed).toBe(true);
  });

  it('dashing records a zoomPunch camera effect', async () => {
    const store = await loadStore('drift-cellar');
    const result = await runPlaytest(store, 'dash-zoom-punch');
    expect(result.passed).toBe(true);
    expect(result.cameraEffects.some((r) => r.effect === 'zoomPunch')).toBe(true);
  });

  it('slamming a wall records shake and flash', async () => {
    const store = await loadStore('drift-cellar');
    const result = await runPlaytest(store, 'wall-bump-shake');
    expect(result.passed).toBe(true);
    expect(result.cameraEffects.some((r) => r.effect === 'shake')).toBe(true);
    expect(result.cameraEffects.some((r) => r.effect === 'flash')).toBe(true);
  });

  it('opening the menu focuses Resume and dragging the slider changes its value', async () => {
    const store = await loadStore('drift-cellar');
    const result = await runPlaytest(store, 'pause-menu-slider');
    expect(result.passed).toBe(true);
  });

  it('the slider drives the real music channel (setMusicVolume via onAudio)', async () => {
    const store = await loadStore('drift-cellar');
    const scene = store.getScene('Cellar')!;
    let musicVolumeEvents = 0;
    const runtime = await SceneRuntime.create(store, scene.id, {
      onAudio: (e) => {
        if (e.action === 'music-volume') musicVolumeEvents++;
      },
    });
    // Open the menu, then nudge the focused-slider path: focus it and adjust.
    runtime.input.setActionDown('pause');
    runtime.run(2);
    runtime.input.setActionUp('pause');
    runtime.focusUi('Music Volume');
    runtime.adjustUiFocus(-1);
    runtime.run(1);
    expect(runtime.errors).toEqual([]);
    expect(musicVolumeEvents).toBeGreaterThanOrEqual(1);
    const slider = runtime.getEntities().find((e) => e.name === 'Music Volume')!;
    expect(slider.components.UISlider!.value).toBeCloseTo(0.7);
  });

  it('keyboard/gamepad focus navigation flips the shake toggle and gates the shake', async () => {
    const store = await loadStore('drift-cellar');
    const result = await runPlaytest(store, 'menu-focus-nav');
    expect(result.passed).toBe(true);
    expect(result.logs.some((l) => l.message.includes('screen shake: off'))).toBe(true);
    // The gated wall slam still flashed but never shook.
    expect(result.cameraEffects.some((r) => r.effect === 'flash')).toBe(true);
    expect(result.cameraEffects.some((r) => r.effect === 'shake')).toBe(false);
  });

  it('collecting all gems fades out, switches to the Vault, and fades back in', async () => {
    const store = await loadStore('drift-cellar');
    const result = await runPlaytest(store, 'gem-run-to-vault');
    expect(result.passed).toBe(true);
    const vault = store.getScene('Vault')!;
    expect(result.finalScene).toBe(vault.id);
    expect(result.sceneEvents.length).toBe(1);
    expect(result.sceneEvents[0].to).toBe(vault.id);
    expect(result.cameraEffects.filter((r) => r.effect === 'fade').length).toBeGreaterThanOrEqual(2);
    expect(result.eventCounts.gem).toBe(3);
  });

  it('produces identical camera-effect and event records on a second run (deterministic)', async () => {
    const store = await loadStore('drift-cellar');
    const first = await runPlaytest(store, 'gem-run-to-vault');
    const second = await runPlaytest(store, 'gem-run-to-vault');
    expect(first.passed).toBe(true);
    expect(second.cameraEffects).toEqual(first.cameraEffects);
    expect(second.eventCounts).toEqual(first.eventCounts);
  });

  it('the smoke playtest passes with music autoplaying once', async () => {
    const store = await loadStore('drift-cellar');
    const result = await runPlaytest(store, 'smoke');
    expect(result.passed).toBe(true);
  });
});

// Ember Horde is the Wave E spatial-hash horde-scale showcase, and (as of
// Task 12) the Wave I prefab-spawn showcase: a Director waves-spawns
// kinematic enemies at runtime via ctx.scene.spawnPrefab("Enemy", ...),
// capped at 300 concurrent, each caching the Player EntityHandle once
// instead of re-searching the scene every frame (see generate.mjs's
// file-header comment on generateEmberHorde for the full O(n^2)-avoidance
// rationale, and its prefab-spawning paragraph for why there is no
// hand-mirrored enemy component tree anymore).
describe('ember-horde v0.7 showcase (Wave E spatial-hash horde scale)', () => {
  it('is scripted entirely in Lua', async () => {
    const store = await loadStore('ember-horde');
    const scripts = await store.listScripts();
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.every((p) => p.endsWith('.lua'))).toBe(true);
  });

  it('has the expected cast and playtests', async () => {
    const store = await loadStore('ember-horde');
    const scene = store.getScene('Arena')!;
    const names = scene.entities.map((e) => e.name);
    expect(names).toContain('Player');
    expect(names).toContain('Director');
    expect(names).toContain('Enemy');
    expect(names).toContain('Elite Enemy');
    expect(names).toContain('Timer HUD');
    expect(names).toContain('HP HUD');
    expect(names).toContain('Horde HUD');
    expect(names).toContain('Resume');
    expect(names).toContain('Screen Shake');
    const enemy = scene.entities.find((e) => e.name === 'Enemy')!;
    expect(enemy.enabled).toBe(true);
    expect(enemy.tags).toContain('enemy');
    expect(store.playtests.size).toBe(6);
  });

  it('spawns enemies from a real prefab, with a tinted/scaled Elite Enemy instance staying live-linked', async () => {
    const store = await loadStore('ember-horde');
    const scene = store.getScene('Arena')!;
    const enemy = scene.entities.find((e) => e.name === 'Enemy')!;
    const elite = scene.entities.find((e) => e.name === 'Elite Enemy')!;

    // "Enemy" is the prefab's source root; both entities link to the same
    // prefab asset, which owns exactly one enemy.
    expect(enemy.prefab).toBeDefined();
    expect(elite.prefab).toBeDefined();
    expect(elite.prefab!.asset).toBe(enemy.prefab!.asset);
    const prefabAsset = store.getAsset(enemy.prefab!.asset)!;
    expect(prefabAsset.type).toBe('prefab');
    expect(prefabAsset.path).toBe('assets/prefabs/enemy.prefab.json');

    // Elite Enemy overrides SpriteRenderer.color/width/height on top of the
    // shared prefab (a visibly distinct "tinted elite" per-field override,
    // not a detached copy) — every other field (Collider, PhysicsBody,
    // Script) still comes straight from the prefab.
    expect(elite.components.SpriteRenderer!.color).not.toBe(enemy.components.SpriteRenderer!.color);
    expect(elite.components.SpriteRenderer!.width).toBeGreaterThan(enemy.components.SpriteRenderer!.width);
    expect(elite.components.Collider).toEqual(enemy.components.Collider);
    expect(elite.components.Script).toEqual(enemy.components.Script);

    const overriddenPaths = elite.prefab!.overrides.map((o) => o.path).sort();
    expect(overriddenPaths).toEqual(['color', 'height', 'width']);

    // The director spawns copies of this same prefab at runtime — confirm
    // the spawned enemies actually run enemy-chase.lua (not an inline
    // hand-mirrored def) by checking a freshly-spawned one carries it.
    const runtime = await SceneRuntime.create(store, scene.id);
    runtime.run(25); // past the first wave (WAVE_INTERVAL=20)
    const spawned = runtime.getEntities().find((e) => e.name === 'Enemy' && e.id !== enemy.id)!;
    expect(spawned).toBeDefined();
    expect(spawned.components.Script!.scriptPath).toBe('scripts/enemy-chase.lua');
    expect(runtime.errors).toEqual([]);
  });

  it('declares virtual axes and gamepad button bindings in inputMappings', async () => {
    const store = await loadStore('ember-horde');
    const mappings = store.project.inputMappings;
    expect(mappings.axes.moveX.gamepadAxis).toBe(0);
    expect(mappings.axes.moveX.negativeCodes).toContain('KeyA');
    expect(mappings.axes.moveY.gamepadAxis).toBe(1);
    expect(mappings.actions.pause).toEqual(['Escape']);
    expect(mappings.gamepadButtons.pause).toEqual(['start']);
  });

  it('builds the pause menu from the widget set, every control focusable', async () => {
    const store = await loadStore('ember-horde');
    const scene = store.getScene('Arena')!;
    const byName = (n: string) => scene.entities.find((e) => e.name === n)!;
    const menu = byName('Pause Menu');
    expect(menu.components.UILayout!.direction).toBe('vertical');
    const toggle = byName('Screen Shake');
    expect(toggle.components.UIToggle!.value).toBe(true);
    expect(toggle.components.UIElement!.focusable).toBe(true);
    expect(toggle.parentId).toBe(menu.id);
    expect(byName('Resume').components.UIElement!.focusable).toBe(true);
    expect(byName('Resume').parentId).toBe(menu.id);
  });

  it('moves deterministically on setAxis input (player-moves-on-axes playtest)', async () => {
    const store = await loadStore('ember-horde');
    const result = await runPlaytest(store, 'player-moves-on-axes');
    expect(result.passed).toBe(true);
  });

  // Genuinely heavy: 650 fixed frames with 300 kinematic enemies all chasing
  // the player. Fast locally (arm64) but well over vitest's 30s default on the
  // slower shared CI runners, so it gets the same 120s budget the other
  // at-scale determinism tests use (goldenDeterminism colliders-1500,
  // broadphase). This is a performance headroom bump, not a correctness change
  // — the enemy-spawned count is monotonic integer logic (enemies never die
  // here), identical on every platform.
  // 300s: the v0.10.0 release run proved 120s is not enough headroom on a
  // slow windows-latest runner (timed out while every other platform passed).
  // Same platform-honesty rationale as the v0.8.0 bump (c79bf86).
  it('the horde actually reaches 300 concurrent enemies (sustained-horde-scale playtest)', { timeout: 300_000 }, async () => {
    const store = await loadStore('ember-horde');
    const result = await runPlaytest(store, 'sustained-horde-scale');
    expect(result.passed).toBe(true);
    expect(result.eventCounts['enemy-spawned']).toBe(300);
  });

  it('director cap logic prevents unlimited spawning', async () => {
    const store = await loadStore('ember-horde');
    const scene = store.getScene('Arena')!;
    const runtime = await SceneRuntime.create(store, scene.id);

    // Verify the director cap logic: spawning works and respects the 300 cap.
    // WAVE_SIZE=10, WAVE_INTERVAL=20 → ~100 enemies at frame 200, ~150 at frame 300.
    // We verify the logic at smaller scale: count climbs but never exceeds 300.
    runtime.run(200);
    let count = runtime.getEntities().filter((e) => e.tags.includes('enemy')).length;
    expect(count).toBeGreaterThan(80);
    expect(count).toBeLessThanOrEqual(300);

    runtime.run(150);
    const prevCount = count;
    count = runtime.getEntities().filter((e) => e.tags.includes('enemy')).length;
    expect(count).toBeGreaterThan(prevCount); // still climbing
    expect(count).toBeLessThanOrEqual(300); // never exceeds cap

    expect(runtime.errors).toEqual([]);
  });

  it('an enemy reaching the player hurts and shakes the camera (enemy-contact-hurts-and-shakes playtest)', async () => {
    const store = await loadStore('ember-horde');
    const result = await runPlaytest(store, 'enemy-contact-hurts-and-shakes');
    expect(result.passed).toBe(true);
    expect(result.eventCounts['player-hit']).toBeGreaterThanOrEqual(1);
    expect(result.cameraEffects.some((r) => r.effect === 'shake')).toBe(true);
  });

  it('turning off the Screen Shake toggle gates the shake but not the hit (shake-toggle-gates-shake playtest)', async () => {
    const store = await loadStore('ember-horde');
    const result = await runPlaytest(store, 'shake-toggle-gates-shake');
    expect(result.passed).toBe(true);
    expect(result.eventCounts['player-hit']).toBeGreaterThanOrEqual(1);
    expect(result.cameraEffects.some((r) => r.effect === 'shake')).toBe(false);
  });

  it('keyboard/gamepad focus navigation moves between Resume and Screen Shake (pause-menu-focus-nav playtest)', async () => {
    const store = await loadStore('ember-horde');
    const result = await runPlaytest(store, 'pause-menu-focus-nav');
    expect(result.passed).toBe(true);
  });

  it('the smoke playtest passes with no script errors', async () => {
    const store = await loadStore('ember-horde');
    const result = await runPlaytest(store, 'smoke');
    expect(result.passed).toBe(true);
  });
});

describe('ember-arcade v0.10 showcase (Wave G post-effects system)', () => {
  it('is scripted entirely in Lua', async () => {
    const store = await loadStore('ember-arcade');
    const scripts = await store.listScripts();
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.every((p) => p.endsWith('.lua'))).toBe(true);
  });

  it('has the expected cast and playtests', async () => {
    const store = await loadStore('ember-arcade');
    const scene = store.getScene('Arcade')!;
    const names = scene.entities.map((e) => e.name);
    expect(names).toContain('Player');
    expect(names).toContain('Target 1');
    expect(names).toContain('Target 2');
    expect(names).toContain('Target 3');
    expect(names).toContain('Director');
    expect(names).toContain('Score HUD');
    expect(names).toContain('CRT Toggle');
    expect(store.playtests.size).toBe(3);
  });

  it('the Main Camera starts with crt, vignette, and bloom stacked', async () => {
    const store = await loadStore('ember-arcade');
    const scene = store.getScene('Arcade')!;
    const camera = scene.entities.find((e) => e.name === 'Main Camera')!;
    const types = camera.components.Camera!.postEffects.map((e) => e.type);
    expect(types).toEqual(['crt', 'vignette', 'bloom']);
  });

  it('every target is authored with a no-op SpriteEffects component and a trigger collider', async () => {
    const store = await loadStore('ember-arcade');
    const scene = store.getScene('Arcade')!;
    for (const name of ['Target 1', 'Target 2', 'Target 3']) {
      const target = scene.entities.find((e) => e.name === name)!;
      expect(target.components.SpriteEffects!.dissolveAmount).toBe(0);
      expect(target.components.SpriteEffects!.flashStrength).toBe(0);
      expect(target.components.Collider!.isTrigger).toBe(true);
    }
  });

  it('the CRT toggle flips Camera.postEffects (crt-toggle-drives-post-effects playtest)', async () => {
    const store = await loadStore('ember-arcade');
    const result = await runPlaytest(store, 'crt-toggle-drives-post-effects');
    expect(result.passed).toBe(true);
    expect(result.postEffects).toEqual(['vignette', 'bloom']);
  });

  it('touching a target flashes then dissolves it out (target-hit-flash-and-dissolve playtest)', async () => {
    const store = await loadStore('ember-arcade');
    const result = await runPlaytest(store, 'target-hit-flash-and-dissolve');
    expect(result.passed).toBe(true);
    expect(result.eventCounts['target-hit']).toBe(1);
  });

  it('the smoke playtest passes with the full post-effects stack active and no script errors', async () => {
    const store = await loadStore('ember-arcade');
    const result = await runPlaytest(store, 'smoke');
    expect(result.passed).toBe(true);
    expect(result.postEffects).toEqual(['crt', 'vignette', 'bloom']);
  });
});
