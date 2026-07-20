#!/usr/bin/env node
/**
 * Regenerates the Hearth example projects using the core command system —
 * the same operations agents use. Run from repo root after building core:
 *
 *   npm run build -w @hearth/core && node packages/examples/generate.mjs
 *
 * The generated projects are committed to the repo so they work out of the
 * box; re-running this script recreates them from scratch. Ids are seeded
 * (see setIdRandomSource below), so regeneration is byte-identical run to
 * run — CI diffs packages/examples after regenerating to catch drift.
 */
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject, HearthSession, setIdRandomSource, createSeededRng, AUTOTILE_SHAPES } from '../core/dist/index.js';
import { NodeFileSystem } from '../core/dist/node/index.js';
import { GameSession, resolveUiPositions } from '../runtime/dist/index.js';
import { encodePng, renderChiptuneWav, makeBlob47CaveSheetRgba } from './pixelart.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fs = new NodeFileSystem();

// Seed id generation so regenerating this file produces byte-identical
// output every time (see packages/core/src/ids.ts). Generator/test-only —
// does not touch the runtime's seeded ctx.random stream.
setIdRandomSource(createSeededRng(1));

/** Execute a command and fail loudly if it doesn't succeed. */
async function run(session, name, params) {
  const result = await session.execute(name, params);
  if (!result.success) {
    throw new Error(`${name} failed: ${result.errors.map((e) => e.message).join('; ')}`);
  }
  return result.data;
}

async function freshProject(dirName, options) {
  const root = path.join(here, dirName);
  await rm(root, { recursive: true, force: true });
  const { store } = await createProject(fs, root, { ...options, starterScene: false });
  return HearthSession.fromStore(store, { granted: ['read-only', 'safe-edit', 'code-edit', 'asset-edit', 'build'] });
}

// ---------------------------------------------------------------------------
// Example 1: Mini Platformer
// ---------------------------------------------------------------------------
async function generatePlatformer() {
  const session = await freshProject('mini-platformer', {
    name: 'Mini Platformer',
    description: 'Jump between platforms, collect coins, avoid spikes and the patrolling enemy.',
  });

  const scene = (await run(session, 'createScene', { name: 'Level 1', withCamera: false })).sceneId;

  // --- assets ---
  const player = (await run(session, 'createSpriteAsset', {
    name: 'player', shape: 'character', color: '#3498db', width: 32, height: 48,
  })).asset;
  const enemy = (await run(session, 'createSpriteAsset', {
    name: 'enemy', shape: 'enemy', color: '#e74c3c', width: 36, height: 36,
  })).asset;
  const coin = (await run(session, 'createSpriteAsset', {
    name: 'coin', shape: 'coin', color: '#f1c40f', width: 22, height: 22,
  })).asset;
  const grass = (await run(session, 'createTileAsset', { name: 'grass', color: '#2ecc71', size: 32 })).asset;
  const stone = (await run(session, 'createTileAsset', { name: 'stone', color: '#95a5a6', size: 32 })).asset;

  // Procedural sound effects (deterministic WAVs; names must not collide
  // with sprite assets because ctx.audio.play resolves by id OR name).
  await run(session, 'createSound', { name: 'coin-sound', preset: 'coin' });
  await run(session, 'createSound', { name: 'jump-sound', preset: 'jump' });
  await run(session, 'createSound', { name: 'hit-sound', preset: 'hit' });
  await run(session, 'createSound', { name: 'click-sound', preset: 'blip' });
  const ambience = (await run(session, 'createSound', { name: 'ambience', preset: 'powerup', seed: 7 })).asset;

  // --- scripts ---
  await run(session, 'createScript', {
    name: 'player-controller',
    language: 'js',
    source: `/**
 * Platformer player: left/right movement, jump when grounded, respawn on fall.
 * params: speed (px/s), jumpSpeed (px/s)
 */
export default {
  onStart(ctx) {
    ctx.vars.spawnX = ctx.transform.position.x;
    ctx.vars.spawnY = ctx.transform.position.y;
  },

  onUpdate(ctx, dt) {
    const body = ctx.getComponent('PhysicsBody');
    const speed = ctx.params.speed ?? 220;
    let vx = 0;
    if (ctx.input.isDown('left')) vx -= speed;
    if (ctx.input.isDown('right')) vx += speed;
    body.velocity.x = vx;

    if (ctx.input.justPressed('jump') && ctx.isGrounded()) {
      body.velocity.y = -(ctx.params.jumpSpeed ?? 460);
      ctx.audio.play('jump-sound', { volume: 0.8 });
    }

    // Fell off the world: respawn at the starting point.
    if (ctx.transform.position.y > 900) {
      ctx.transform.position.x = ctx.vars.spawnX;
      ctx.transform.position.y = ctx.vars.spawnY;
      body.velocity.x = 0;
      body.velocity.y = 0;
      ctx.log('player respawned');
    }
  },
};
`,
  });

  await run(session, 'createScript', {
    name: 'coin-pickup',
    language: 'js',
    source: `/**
 * Coin: when the player touches it, bump the Score HUD text, play the
 * pickup sound, and disappear.
 */
export default {
  onCollision(ctx, other) {
    if (!other.tags.includes('player')) return;
    const score = ctx.scene.find('Score');
    if (score) {
      const text = score.getComponent('Text');
      const current = parseInt((text.content.match(/\\d+/) || ['0'])[0], 10);
      text.content = 'Score: ' + (current + 1);
    }
    ctx.audio.play('coin-sound');
    ctx.log('coin collected');
    ctx.destroySelf();
  },
};
`,
  });

  await run(session, 'createScript', {
    name: 'enemy-patrol',
    language: 'js',
    source: `/**
 * Enemy: patrols horizontally around its origin; touching it sends the
 * player back to spawn. params: range (px), speed (px/s)
 */
export default {
  onStart(ctx) {
    ctx.vars.dir = 1;
    ctx.vars.originX = ctx.transform.position.x;
  },

  onUpdate(ctx, dt) {
    const range = ctx.params.range ?? 120;
    const speed = ctx.params.speed ?? 70;
    ctx.transform.position.x += ctx.vars.dir * speed * dt;
    if (Math.abs(ctx.transform.position.x - ctx.vars.originX) > range) {
      ctx.vars.dir *= -1;
    }
  },

  onCollision(ctx, other) {
    if (!other.tags.includes('player')) return;
    other.transform.position.x = 120;
    other.transform.position.y = 380;
    ctx.audio.play('hit-sound');
    ctx.log('player hit by enemy');
  },
};
`,
  });

  await run(session, 'createScript', {
    name: 'spike-hazard',
    language: 'js',
    source: `/**
 * Spikes: touching them plays the hit sound and sends the player back to
 * the start. The collider is a convex polygon (a triangle).
 */
export default {
  onCollision(ctx, other) {
    if (!other.tags.includes('player')) return;
    other.transform.position.x = 120;
    other.transform.position.y = 380;
    const body = other.getComponent('PhysicsBody');
    body.velocity.x = 0;
    body.velocity.y = 0;
    ctx.audio.play('hit-sound');
    ctx.log('player hit spikes');
  },
};
`,
  });

  await run(session, 'createScript', {
    name: 'restart-button',
    language: 'js',
    source: `/**
 * Restart button (screen-space UI): clicking it resets the score and puts
 * the player back at the start. Requires UIElement.interactive = true.
 */
export default {
  onUiEvent(ctx, event) {
    if (event.type !== 'click') return;
    const player = ctx.scene.find('Player');
    if (player) {
      player.transform.position.x = 120;
      player.transform.position.y = 380;
      const body = player.getComponent('PhysicsBody');
      body.velocity.x = 0;
      body.velocity.y = 0;
    }
    const score = ctx.scene.find('Score');
    if (score) score.getComponent('Text').content = 'Score: 0';
    ctx.audio.play('click-sound');
    ctx.log('game restarted');
  },
};
`,
  });

  await run(session, 'createScript', {
    name: 'camera-follow',
    language: 'js',
    source: `/**
 * Camera: follow the player horizontally, clamped so the level start stays visible.
 */
export default {
  onUpdate(ctx) {
    const player = ctx.scene.find('Player');
    if (!player) return;
    ctx.transform.position.x = Math.max(400, player.transform.position.x);
  },
};
`,
  });

  // --- entities ---
  await run(session, 'createEntity', {
    scene, name: 'Main Camera', position: { x: 400, y: 300 },
    components: { Camera: { backgroundColor: '#16213e' } },
  });
  await run(session, 'attachScript', { scene, entity: 'Main Camera', script: 'scripts/camera-follow.js' });

  await run(session, 'createEntity', {
    scene, name: 'Ground', tags: ['ground'], position: { x: 0, y: 552 },
    components: {
      Tilemap: {
        tileSize: 32,
        tileAssets: { G: grass.id, S: stone.id },
        grid: ['GGGGGGGGGGGGGGGGGGGGGGGGG..GGGGGGGGGG', 'SSSSSSSSSSSSSSSSSSSSSSSSS..SSSSSSSSSS'],
        solid: true,
      },
    },
  });

  const platforms = [
    { name: 'Platform A', x: 320, y: 440, w: 128 },
    { name: 'Platform B', x: 520, y: 350, w: 96 },
    { name: 'Platform C', x: 720, y: 260, w: 96 },
  ];
  for (const p of platforms) {
    await run(session, 'createEntity', {
      scene, name: p.name, tags: ['ground'], position: { x: p.x, y: p.y },
      components: {
        SpriteRenderer: { shape: 'rectangle', color: '#8d6e63', width: p.w, height: 20 },
        Collider: { shape: 'box', width: p.w, height: 20 },
        PhysicsBody: { bodyType: 'static' },
      },
    });
  }

  await run(session, 'createEntity', {
    scene, name: 'Player', tags: ['player'], position: { x: 120, y: 380 },
    components: {
      SpriteRenderer: { assetId: player.id, width: 32, height: 48 },
      Collider: { shape: 'box', width: 28, height: 46 },
      PhysicsBody: { bodyType: 'dynamic' },
    },
  });
  await run(session, 'attachScript', {
    scene, entity: 'Player', script: 'scripts/player-controller.js',
    params: { speed: 220, jumpSpeed: 460 },
  });

  const coins = [
    { x: 320, y: 400 }, { x: 520, y: 310 }, { x: 720, y: 220 },
  ];
  for (let i = 0; i < coins.length; i++) {
    await run(session, 'createEntity', {
      scene, name: `Coin ${i + 1}`, tags: ['coin'], position: coins[i],
      components: {
        SpriteRenderer: { assetId: coin.id, width: 22, height: 22 },
        Collider: { shape: 'circle', radius: 12, isTrigger: true },
      },
    });
    await run(session, 'attachScript', { scene, entity: `Coin ${i + 1}`, script: 'scripts/coin-pickup.js' });
  }

  // A polygon collider used as level geometry: spikes on the ground between
  // the platforms. Triangle points are local space, convex, listed clockwise.
  await run(session, 'createEntity', {
    scene, name: 'Spikes', tags: ['hazard'], position: { x: 380, y: 536 },
    components: {
      SpriteRenderer: { shape: 'triangle', color: '#e67e22', width: 32, height: 32 },
      Collider: {
        shape: 'polygon',
        points: [{ x: 0, y: -16 }, { x: 16, y: 16 }, { x: -16, y: 16 }],
        isTrigger: true,
      },
    },
  });
  await run(session, 'attachScript', { scene, entity: 'Spikes', script: 'scripts/spike-hazard.js' });

  await run(session, 'createEntity', {
    scene, name: 'Enemy', tags: ['enemy'], position: { x: 560, y: 522 },
    components: {
      SpriteRenderer: { assetId: enemy.id, width: 36, height: 36 },
      Collider: { shape: 'box', width: 34, height: 34, isTrigger: true },
    },
  });
  await run(session, 'attachScript', {
    scene, entity: 'Enemy', script: 'scripts/enemy-patrol.js',
    params: { range: 120, speed: 70 },
  });

  // --- HUD (screen-space UI) + ambience ---
  // UIElement entities ignore camera position/zoom; anchor + offset place them.
  await run(session, 'createEntity', {
    scene, name: 'Score', tags: ['ui'],
    components: {
      UIElement: { anchor: 'top-left', offset: { x: 24, y: 28 } },
      Text: { content: 'Score: 0', fontSize: 20, color: '#ffffff' },
    },
  });
  await run(session, 'createEntity', {
    scene, name: 'Restart', tags: ['ui'],
    components: {
      UIElement: { anchor: 'top-right', offset: { x: -80, y: 32 }, interactive: true },
      SpriteRenderer: { shape: 'rectangle', color: '#34495e', width: 110, height: 34, layer: 20 },
      Text: { content: 'Restart', fontSize: 14, color: '#ecf0f1', align: 'center', layer: 21 },
    },
  });
  await run(session, 'attachScript', { scene, entity: 'Restart', script: 'scripts/restart-button.js' });
  await run(session, 'createEntity', {
    scene, name: 'Ambience', tags: ['audio'],
    components: {
      AudioSource: { assetId: ambience.id, autoplay: true, loop: true, volume: 0.25 },
    },
  });

  // --- playtests ---
  await run(session, 'createPlaytest', {
    name: 'player-lands-on-ground',
    scene,
    steps: [
      { type: 'wait', frames: 90 },
      { type: 'assertProperty', entity: 'Player', property: 'Transform.position.y', lessThan: 560 },
      { type: 'assertProperty', entity: 'Player', property: 'Transform.position.y', greaterThan: 450 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 300,
  });
  await run(session, 'createPlaytest', {
    name: 'player-moves-right',
    scene,
    steps: [
      { type: 'wait', frames: 60 },
      { type: 'press', action: 'right', frames: 45 },
      { type: 'assertProperty', entity: 'Player', property: 'Transform.position.x', greaterThan: 180 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 300,
  });
  // Walking right from spawn crosses the spikes at x=380; the spike script
  // must send the player back toward the start (without it, 100 frames of
  // running right would put the player past x=450). The hit sound this
  // triggers shows up in the run report's audioEvents (asserted in
  // packages/examples/tests, since playtest steps have no audio assertion).
  await run(session, 'createPlaytest', {
    name: 'spikes-respawn-player',
    scene,
    steps: [
      { type: 'press', action: 'right', frames: 100 },
      { type: 'assertProperty', entity: 'Player', property: 'Transform.position.x', lessThan: 300 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 300,
  });
  await run(session, 'createPlaytest', {
    name: 'jump-works',
    scene,
    steps: [
      { type: 'wait', frames: 60 },
      { type: 'press', action: 'jump', frames: 3 },
      { type: 'wait', frames: 5 },
      { type: 'assertProperty', entity: 'Player', property: 'PhysicsBody.velocity.y', lessThan: 0 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 300,
  });
  await run(session, 'createPlaytest', {
    name: 'smoke',
    scene,
    steps: [
      { type: 'wait', frames: 120 },
      { type: 'assertEntityExists', entity: 'Player', exists: true },
      { type: 'assertEntityExists', entity: 'Score', exists: true },
      { type: 'assertEntityExists', entity: 'Restart', exists: true },
      { type: 'assertEntityExists', entity: 'Spikes', exists: true },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 300,
  });

  const report = await run(session, 'validateProject', {});
  if (report.errors.length > 0) throw new Error('platformer validation failed: ' + JSON.stringify(report.errors));
  console.log('✓ mini-platformer generated');
}

// ---------------------------------------------------------------------------
// Example 2: Top-Down Room
// ---------------------------------------------------------------------------
async function generateTopDown() {
  const session = await freshProject('top-down-room', {
    name: 'Top-Down Room',
    description: 'Walk around a room, open the door, talk to the keeper.',
  });

  const scene = (await run(session, 'createScene', { name: 'Room', withCamera: false })).sceneId;

  const player = (await run(session, 'createSpriteAsset', {
    name: 'hero', shape: 'character', color: '#9b59b6', width: 30, height: 34,
  })).asset;
  const npc = (await run(session, 'createSpriteAsset', {
    name: 'keeper', shape: 'character', color: '#e67e22', width: 30, height: 34,
  })).asset;
  const wallTile = (await run(session, 'createTileAsset', { name: 'wall', color: '#34495e', size: 32 })).asset;
  const floorTile = (await run(session, 'createTileAsset', { name: 'floor', color: '#7f8c8d', size: 32 })).asset;

  await run(session, 'createScript', {
    name: 'top-down-move',
    language: 'js',
    source: `/**
 * Four-direction movement (no gravity). params: speed (px/s)
 */
export default {
  onUpdate(ctx) {
    const body = ctx.getComponent('PhysicsBody');
    const speed = ctx.params.speed ?? 180;
    let vx = 0;
    let vy = 0;
    if (ctx.input.isDown('left')) vx -= speed;
    if (ctx.input.isDown('right')) vx += speed;
    if (ctx.input.isDown('up')) vy -= speed;
    if (ctx.input.isDown('down')) vy += speed;
    body.velocity.x = vx;
    body.velocity.y = vy;
  },
};
`,
  });

  await run(session, 'createScript', {
    name: 'door-trigger',
    language: 'js',
    source: `/**
 * Door: opens (turns green, logs) the first time the player touches it.
 */
export default {
  onCollision(ctx, other) {
    if (!other.tags.includes('player') || ctx.vars.open) return;
    ctx.vars.open = true;
    const sprite = ctx.getComponent('SpriteRenderer');
    if (sprite) sprite.color = '#2ecc71';
    ctx.log('door opened');
  },
};
`,
  });

  await run(session, 'createScript', {
    name: 'npc-dialogue',
    language: 'js',
    source: `/**
 * NPC: when the player is near and presses "action", show a line of
 * dialogue in the DialogueText entity. params: line, radius
 */
export default {
  onUpdate(ctx) {
    const player = ctx.scene.find('Player');
    const label = ctx.scene.find('DialogueText');
    if (!player || !label) return;
    const dx = player.transform.position.x - ctx.transform.position.x;
    const dy = player.transform.position.y - ctx.transform.position.y;
    const near = Math.hypot(dx, dy) < (ctx.params.radius ?? 70);
    const text = label.getComponent('Text');
    if (near && ctx.input.justPressed('action')) {
      text.content = ctx.params.line ?? 'Hello, traveler!';
      ctx.vars.spoken = true;
      ctx.log('npc spoke');
    } else if (!near && ctx.vars.spoken) {
      text.content = 'Find the keeper. Press E to talk.';
      ctx.vars.spoken = false;
    }
  },
};
`,
  });

  await run(session, 'createEntity', {
    scene, name: 'Main Camera', position: { x: 400, y: 300 },
    components: { Camera: { backgroundColor: '#101418' } },
  });

  // Room: 25x17 tile ring of walls with a floor, door gap on the right wall.
  const wallRow = 'W'.repeat(25);
  const midRow = 'W' + 'F'.repeat(23) + 'W';
  const doorRow = 'W' + 'F'.repeat(23) + '.'; // gap where the door entity sits
  const grid = [wallRow];
  for (let i = 0; i < 15; i++) grid.push(i === 7 ? doorRow : midRow);
  grid.push(wallRow);
  await run(session, 'createEntity', {
    scene, name: 'Room', tags: ['level'], position: { x: 0, y: 28 },
    components: {
      Tilemap: {
        tileSize: 32,
        tileAssets: { W: wallTile.id, F: floorTile.id },
        grid,
        solid: false, // floor is walkable; walls get explicit colliders below
        layer: -10,
      },
    },
  });
  // Wall colliders (tilemap solid=false so the floor doesn't block; use 4 box walls).
  const walls = [
    { name: 'Wall Top', x: 400, y: 44, w: 800, h: 32 },
    { name: 'Wall Bottom', x: 400, y: 556, w: 800, h: 32 },
    { name: 'Wall Left', x: 16, y: 300, w: 32, h: 544 },
    { name: 'Wall Right', x: 784, y: 300, w: 32, h: 544 },
  ];
  for (const w of walls) {
    await run(session, 'createEntity', {
      scene, name: w.name, tags: ['wall'], position: { x: w.x, y: w.y },
      components: {
        Collider: { shape: 'box', width: w.w, height: w.h },
        PhysicsBody: { bodyType: 'static' },
      },
    });
  }

  await run(session, 'createEntity', {
    scene, name: 'Player', tags: ['player'], position: { x: 200, y: 300 },
    components: {
      SpriteRenderer: { assetId: player.id, width: 30, height: 34 },
      Collider: { shape: 'box', width: 26, height: 30 },
      PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
    },
  });
  await run(session, 'attachScript', {
    scene, entity: 'Player', script: 'scripts/top-down-move.js', params: { speed: 180 },
  });

  await run(session, 'createEntity', {
    scene, name: 'Door', tags: ['door'], position: { x: 768, y: 268 },
    components: {
      SpriteRenderer: { shape: 'rectangle', color: '#c0392b', width: 32, height: 64 },
      Collider: { shape: 'box', width: 40, height: 70, isTrigger: true },
    },
  });
  await run(session, 'attachScript', { scene, entity: 'Door', script: 'scripts/door-trigger.js' });

  await run(session, 'createEntity', {
    scene, name: 'Keeper', tags: ['npc'], position: { x: 560, y: 180 },
    components: {
      SpriteRenderer: { assetId: npc.id, width: 30, height: 34 },
      Collider: { shape: 'box', width: 30, height: 34 },
      PhysicsBody: { bodyType: 'static' },
    },
  });
  await run(session, 'attachScript', {
    scene, entity: 'Keeper', script: 'scripts/npc-dialogue.js',
    params: { line: 'The door on the east wall leads out. It opens at a touch.', radius: 70 },
  });

  await run(session, 'createEntity', {
    scene, name: 'DialogueText', tags: ['ui'], position: { x: 60, y: 570 },
    components: { Text: { content: 'Find the keeper. Press E to talk.', fontSize: 16, color: '#ecf0f1' } },
  });

  await run(session, 'createPlaytest', {
    name: 'walls-block-player',
    scene,
    steps: [
      { type: 'press', action: 'left', frames: 120 },
      { type: 'assertProperty', entity: 'Player', property: 'Transform.position.x', greaterThan: 40 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 400,
  });
  await run(session, 'createPlaytest', {
    name: 'smoke',
    scene,
    steps: [
      { type: 'wait', frames: 60 },
      { type: 'assertEntityExists', entity: 'Keeper', exists: true },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 200,
  });

  const report = await run(session, 'validateProject', {});
  if (report.errors.length > 0) throw new Error('top-down validation failed: ' + JSON.stringify(report.errors));
  console.log('✓ top-down-room generated');
}

// ---------------------------------------------------------------------------
// Example 3: Visual Novel Scene
// ---------------------------------------------------------------------------
async function generateVisualNovel() {
  const session = await freshProject('visual-novel', {
    name: 'Visual Novel Scene',
    description: 'A dialogue scene: advance lines with the action key.',
  });

  const scene = (await run(session, 'createScene', { name: 'Prologue', withCamera: false })).sceneId;

  const chara = (await run(session, 'createSpriteAsset', {
    name: 'aria', shape: 'character', color: '#1abc9c', width: 120, height: 180,
  })).asset;

  await run(session, 'createScript', {
    name: 'dialogue-runner',
    language: 'js',
    source: `/**
 * Dialogue: shows params.lines one at a time; "action" advances.
 * Attached to the entity that has the dialogue Text component.
 */
export default {
  onStart(ctx) {
    ctx.vars.index = 0;
    ctx.vars.lines = Array.isArray(ctx.params.lines) && ctx.params.lines.length > 0
      ? ctx.params.lines
      : ['...'];
    ctx.getComponent('Text').content = ctx.vars.lines[0] + '  [E to continue]';
  },

  onUpdate(ctx) {
    if (!ctx.input.justPressed('action')) return;
    if (ctx.vars.index >= ctx.vars.lines.length - 1) return;
    ctx.vars.index += 1;
    const last = ctx.vars.index === ctx.vars.lines.length - 1;
    ctx.getComponent('Text').content =
      ctx.vars.lines[ctx.vars.index] + (last ? '' : '  [E to continue]');
    ctx.log('advanced to line ' + ctx.vars.index);
  },
};
`,
  });

  await run(session, 'createEntity', {
    scene, name: 'Main Camera', position: { x: 400, y: 300 },
    components: { Camera: { backgroundColor: '#0f0f1a' } },
  });
  await run(session, 'createEntity', {
    scene, name: 'Backdrop', tags: ['background'], position: { x: 400, y: 260 },
    components: {
      SpriteRenderer: { shape: 'rectangle', color: '#2c3e50', width: 760, height: 420, layer: -20 },
    },
  });
  await run(session, 'createEntity', {
    scene, name: 'Aria', tags: ['character'], position: { x: 400, y: 300 },
    components: { SpriteRenderer: { assetId: chara.id, width: 120, height: 180 } },
  });
  await run(session, 'createEntity', {
    scene, name: 'TextBox', tags: ['ui'], position: { x: 400, y: 520 },
    components: {
      SpriteRenderer: { shape: 'rectangle', color: '#16213e', width: 720, height: 120, layer: 5, opacity: 0.9 },
    },
  });
  await run(session, 'createEntity', {
    scene, name: 'Dialogue', tags: ['ui'], position: { x: 70, y: 490 },
    components: { Text: { content: '', fontSize: 18, color: '#ecf0f1', layer: 10 } },
  });
  await run(session, 'attachScript', {
    scene, entity: 'Dialogue', script: 'scripts/dialogue-runner.js',
    params: {
      lines: [
        'Aria: You found the hearth. Not many make it this far.',
        'Aria: The fire you see is a compiler, a canvas, and a door.',
        'Aria: Humans shape it with their hands. Agents shape it with commands.',
        'Aria: Together, then. Let us make something worth playing.',
      ],
    },
  });

  await run(session, 'createPlaytest', {
    name: 'dialogue-advances',
    scene,
    steps: [
      { type: 'wait', frames: 10 },
      { type: 'assertProperty', entity: 'Dialogue', property: 'Text.content', equals: 'Aria: You found the hearth. Not many make it this far.  [E to continue]' },
      { type: 'press', action: 'action', frames: 2 },
      { type: 'wait', frames: 5 },
      { type: 'assertProperty', entity: 'Dialogue', property: 'Text.content', equals: 'Aria: The fire you see is a compiler, a canvas, and a door.  [E to continue]' },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 200,
  });

  const report = await run(session, 'validateProject', {});
  if (report.errors.length > 0) throw new Error('visual-novel validation failed: ' + JSON.stringify(report.errors));
  console.log('✓ visual-novel generated');
}

// ---------------------------------------------------------------------------
// Example 4: Ember Trail (all-Lua, two scenes)
// ---------------------------------------------------------------------------
// Showcases the ctx v2 stdlib from Lua: a user-built start screen (Text +
// interactive UIElement whose onUiEvent calls ctx.scenes.load), and a level
// loop using ctx.timers, ctx.random (seeded), ctx.camera.follow, and
// ctx.save/ctx.load for a persistent best score. All ctx calls use DOT
// syntax (ctx.log("hi"), never ctx:log("hi")).
async function generateEmberTrail() {
  const session = await freshProject('ember-trail', {
    name: 'Ember Trail',
    description: 'Collect drifting embers before they fade. Menu and level are plain scenes; the scripts are all Lua.',
  });

  const menu = (await run(session, 'createScene', { name: 'Menu', withCamera: false })).sceneId;
  const level = (await run(session, 'createScene', { name: 'Level', withCamera: false })).sceneId;

  // --- assets ---
  const wisp = (await run(session, 'createSpriteAsset', {
    name: 'wisp', shape: 'character', color: '#7ac6ff', width: 30, height: 36,
  })).asset;
  const ember = (await run(session, 'createSpriteAsset', {
    name: 'ember', shape: 'star', color: '#ff9f43', width: 18, height: 18,
  })).asset;
  await run(session, 'createSound', { name: 'ember-sound', preset: 'coin' });
  await run(session, 'createSound', { name: 'start-sound', preset: 'blip' });

  // The exported game boots straight into the Menu scene (no engine chrome);
  // the loading visuals below are all a player ever sees before it.
  await run(session, 'updateSettings', {
    initialScene: 'Menu',
    buildSettings: {
      title: 'Ember Trail',
      loading: { backgroundColor: '#141019', spinner: true },
    },
  });

  // --- scripts (all Lua) ---
  await run(session, 'createScript', {
    name: 'start-button',
    language: 'lua',
    source: `-- Start button: a "start screen" in Hearth is just a scene you build.
-- Clicking this interactive UIElement loads the level via ctx.scenes.load.
-- Reminder: ctx calls use DOT syntax (ctx.log("hi"), never ctx:log("hi")).
local script = {}

function script.onUiEvent(ctx, event)
  if event.type ~= "click" then return end
  ctx.audio.play("start-sound")
  ctx.scenes.load("Level")
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'best-label',
    language: 'lua',
    source: `-- Best-score label: reads what the level saved with ctx.save. Save data
-- survives scene switches; in the browser it persists via localStorage.
local script = {}

function script.onStart(ctx)
  local best = ctx.load("best")
  if type(best) ~= "number" then best = 0 end
  ctx.getComponent("Text").content = string.format("Best: %d", best)
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'player-move',
    language: 'lua',
    source: `-- Player: four-direction movement (no gravity), collects embers on
-- contact, and ends the run after params.duration seconds — saving the
-- best score (ctx.save) and returning to the menu (ctx.scenes.load).
local script = {}

local function endRun(ctx)
  local score = ctx.vars.score or 0
  local best = ctx.load("best")
  if type(best) ~= "number" then best = 0 end
  if score > best then best = score end
  ctx.save("best", best)
  ctx.scenes.load("Menu")
end

function script.onStart(ctx)
  ctx.vars.score = 0
  ctx.camera.follow("Player")
  ctx.timers.after(ctx.params.duration or 20, function()
    endRun(ctx)
  end)
end

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")
  local speed = ctx.params.speed or 220
  local vx, vy = 0, 0
  if ctx.input.isDown("left") then vx = vx - speed end
  if ctx.input.isDown("right") then vx = vx + speed end
  if ctx.input.isDown("up") then vy = vy - speed end
  if ctx.input.isDown("down") then vy = vy + speed end
  body.velocity.x = vx
  body.velocity.y = vy
end

function script.onCollision(ctx, other)
  if string.sub(other.name, 1, 6) ~= "Ember " then return end
  ctx.scene.destroy(other)
  ctx.vars.score = (ctx.vars.score or 0) + 1
  ctx.audio.play("ember-sound", { volume = 0.8 })
  local hud = ctx.scene.find("Score")
  if hud then
    hud.getComponent("Text").content = string.format("Embers: %d", ctx.vars.score)
  end
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'ember-spawner',
    language: 'lua',
    source: `-- Spawner: every params.interval seconds, spawns an ember at a
-- seeded-random spot (ctx.random is deterministic — a playtest seed
-- reproduces the exact same run). Each ember despawns after
-- params.lifetime seconds unless the player collects it first.
local script = {}

function script.onStart(ctx)
  local count = 0
  ctx.timers.every(ctx.params.interval or 1.2, function()
    count = count + 1
    local name = string.format("Ember %d", count)
    local x = ctx.random.range(80, 720)
    local y = ctx.random.range(80, 240)
    ctx.log("spawned", name, "at", x, y)
    ctx.scene.spawn({
      name = name,
      position = { x = x, y = y },
      tags = { "ember" },
      components = {
        SpriteRenderer = { assetId = ctx.params.emberAsset, width = 18, height = 18 },
        Collider = { shape = "circle", radius = 12, isTrigger = true },
      },
    })
    ctx.timers.after(ctx.params.lifetime or 4, function()
      local e = ctx.scene.find(name)
      if e then ctx.scene.destroy(e) end
    end)
  end)
end

return script
`,
  });

  // --- Menu scene: a user-built start screen (screen-space UI) ---
  await run(session, 'createEntity', {
    scene: menu, name: 'Main Camera', position: { x: 400, y: 300 },
    components: { Camera: { backgroundColor: '#141019' } },
  });
  await run(session, 'createEntity', {
    scene: menu, name: 'Title', tags: ['ui'],
    components: {
      UIElement: { anchor: 'top', offset: { x: 0, y: 160 } },
      Text: { content: 'Ember Trail', fontSize: 44, color: '#ff9f43', align: 'center' },
    },
  });
  await run(session, 'createEntity', {
    scene: menu, name: 'Subtitle', tags: ['ui'],
    components: {
      UIElement: { anchor: 'top', offset: { x: 0, y: 214 } },
      Text: { content: 'Collect the embers before they fade', fontSize: 15, color: '#b9b4c4', align: 'center' },
    },
  });
  await run(session, 'createEntity', {
    scene: menu, name: 'Start', tags: ['ui'],
    components: {
      // Screen center is (400, 300) in the 800×600 build space, so this
      // button sits at (400, 340) — the coordinate the playtest clicks.
      UIElement: { anchor: 'center', offset: { x: 0, y: 40 }, interactive: true },
      SpriteRenderer: { shape: 'rectangle', color: '#e25822', width: 160, height: 48, layer: 20 },
      Text: { content: 'Start', fontSize: 18, color: '#fff8f0', align: 'center', layer: 21 },
    },
  });
  await run(session, 'attachScript', { scene: menu, entity: 'Start', script: 'scripts/start-button.lua' });
  await run(session, 'createEntity', {
    scene: menu, name: 'Best', tags: ['ui'],
    components: {
      UIElement: { anchor: 'center', offset: { x: 0, y: 110 } },
      Text: { content: 'Best: 0', fontSize: 16, color: '#b9b4c4', align: 'center' },
    },
  });
  await run(session, 'attachScript', { scene: menu, entity: 'Best', script: 'scripts/best-label.lua' });

  // --- Level scene: arena, player, spawner, HUD ---
  await run(session, 'createEntity', {
    scene: level, name: 'Main Camera', position: { x: 400, y: 300 },
    components: { Camera: { backgroundColor: '#1b1130' } },
  });
  await run(session, 'createEntity', {
    scene: level, name: 'Arena', tags: ['level'], position: { x: 400, y: 300 },
    components: {
      SpriteRenderer: { shape: 'rectangle', color: '#241a38', width: 800, height: 600, layer: -20 },
    },
  });
  const walls = [
    { name: 'Wall Top', x: 400, y: 10, w: 800, h: 20 },
    { name: 'Wall Bottom', x: 400, y: 590, w: 800, h: 20 },
    { name: 'Wall Left', x: 10, y: 300, w: 20, h: 600 },
    { name: 'Wall Right', x: 790, y: 300, w: 20, h: 600 },
  ];
  for (const w of walls) {
    await run(session, 'createEntity', {
      scene: level, name: w.name, tags: ['wall'], position: { x: w.x, y: w.y },
      components: {
        Collider: { shape: 'box', width: w.w, height: w.h },
        PhysicsBody: { bodyType: 'static' },
      },
    });
  }
  await run(session, 'createEntity', {
    scene: level, name: 'Player', tags: ['player'], position: { x: 400, y: 300 },
    components: {
      SpriteRenderer: { assetId: wisp.id, width: 30, height: 36 },
      Collider: { shape: 'box', width: 26, height: 32 },
      PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
    },
  });
  await run(session, 'attachScript', {
    scene: level, entity: 'Player', script: 'scripts/player-move.lua',
    params: { speed: 220, duration: 20 },
  });
  await run(session, 'createEntity', {
    scene: level, name: 'Spawner', tags: ['system'], position: { x: 0, y: 0 },
    components: {},
  });
  await run(session, 'attachScript', {
    scene: level, entity: 'Spawner', script: 'scripts/ember-spawner.lua',
    params: { interval: 1.2, lifetime: 4, emberAsset: ember.id },
  });
  await run(session, 'createEntity', {
    scene: level, name: 'Score', tags: ['ui'],
    components: {
      UIElement: { anchor: 'top-left', offset: { x: 24, y: 28 } },
      Text: { content: 'Embers: 0', fontSize: 20, color: '#ffffff' },
    },
  });
  await run(session, 'createEntity', {
    scene: level, name: 'Hint', tags: ['ui'],
    components: {
      UIElement: { anchor: 'bottom', offset: { x: 0, y: -24 } },
      Text: { content: 'Arrows/WASD to move — grab embers before they fade', fontSize: 13, color: '#8f88a0', align: 'center' },
    },
  });

  // --- playtests ---
  // The menu really is just a scene: click the Start button's screen
  // coordinates and assert the Lua onUiEvent switched scenes.
  await run(session, 'createPlaytest', {
    name: 'menu-start',
    scene: menu,
    steps: [
      { type: 'wait', frames: 5 },
      { type: 'click', x: 400, y: 340 },
      { type: 'assertScene', scene: 'Level' },
      { type: 'wait', frames: 10 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 200,
  });
  // Timers + seeded RNG + camera follow, headless. Embers spawn in the top
  // band (y ≤ 240) so the idle player at y=300 never collects by accident;
  // seed 42 makes every spawn position reproducible.
  await run(session, 'createPlaytest', {
    name: 'level-runs',
    scene: level,
    seed: 42,
    steps: [
      { type: 'wait', frames: 200 },
      { type: 'assertEntityExists', entity: 'Ember 1', exists: true },
      { type: 'assertProperty', entity: 'Ember 1', property: 'Transform.position.x', greaterThan: 60 },
      { type: 'assertProperty', entity: 'Ember 1', property: 'Transform.position.x', lessThan: 740 },
      { type: 'press', action: 'right', frames: 60 },
      { type: 'assertProperty', entity: 'Player', property: 'Transform.position.x', greaterThan: 520 },
      { type: 'assertProperty', entity: 'Main Camera', property: 'Transform.position.x', greaterThan: 520 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 400,
  });
  // The 20-second run clock (ctx.timers.after) saves the best score and
  // returns to the menu, where the Lua onStart reads it back with ctx.load.
  await run(session, 'createPlaytest', {
    name: 'run-ends-back-at-menu',
    scene: level,
    steps: [
      { type: 'wait', frames: 1230 },
      { type: 'assertScene', scene: 'Menu' },
      { type: 'assertProperty', entity: 'Best', property: 'Text.content', equals: 'Best: 0' },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 1400,
  });

  const report = await run(session, 'validateProject', {});
  if (report.errors.length > 0) throw new Error('ember-trail validation failed: ' + JSON.stringify(report.errors));

  console.log('✓ ember-trail generated');
}

// ---------------------------------------------------------------------------
// Example 5: Glow Caves (all-Lua, rendering v2 showcase)
// ---------------------------------------------------------------------------
// Showcases the rendering-v2 components end to end: a dark scene
// (Camera.ambientLight) lit only by a player-following Light2D torch
// (parented to Player — children inherit only their parent's translation,
// so a fixed local offset rides along), LineRenderer cave-wall outlines,
// two ParticleEmitters (a torch-sparks recipe and a high-rate/zero-spread
// "drip trail" recipe), and a SpriteAnimator (flickering torch flame) driven
// by an animation asset. All scripts are Lua; the torch's script also
// dogfoods ctx.particles.burst/count. The showcase playtest's expected
// values (animator frame asset id, drip particle count) are read back from
// an actual run of the generated scene below — never hand-computed — per
// particles.ts's fp-real spawn-accumulator timing (see
// packages/playtest/tests/particles.test.ts).
//
// Also the autotile showcase: a "Cave Rocks" Tilemap whose
// 'R' char is bound to a blob47 rule (setTileAutotile) over a generated
// spritesheet (pixelart.mjs's makeBlob47CaveSheetRgba) — every filled cell's
// frame is picked from its 8-neighbour mask at render time, so the rock
// cluster's shape below needed no per-tile art of its own.
async function generateGlowCaves() {
  const session = await freshProject('glow-caves', {
    name: 'Glow Caves',
    description: 'Explore a dark cave by torchlight. A showcase of 2D lighting, particles, and sprite animation.',
  });

  const scene = (await run(session, 'createScene', { name: 'Cave', withCamera: false })).sceneId;

  // --- assets ---
  const explorer = (await run(session, 'createSpriteAsset', {
    name: 'explorer', shape: 'character', color: '#8fa6bf', width: 28, height: 34,
  })).asset;
  const flameA = (await run(session, 'createSpriteAsset', {
    name: 'torch-flame-a', shape: 'circle', color: '#ffb347', width: 14, height: 18,
  })).asset;
  const flameB = (await run(session, 'createSpriteAsset', {
    name: 'torch-flame-b', shape: 'triangle', color: '#ff8c1a', width: 16, height: 20,
  })).asset;
  const flicker = (await run(session, 'createAnimationAsset', {
    name: 'torch-flicker', frames: [flameA.id, flameB.id], frameDuration: 0.15, loop: true,
  })).asset;

  // Cave-rock blob47 sheet: a generated 16x16-tile spritesheet (imported the
  // same way sky-courier's hand-drawn PNG is below) whose frame names —
  // `blob_<shapeKey>` for every canonical blob47 shape — match
  // setTileAutotile's naming contract exactly, so no mapping override is
  // needed.
  const blobSheet = makeBlob47CaveSheetRgba(AUTOTILE_SHAPES);
  const blobSheetPath = path.join(os.tmpdir(), 'cave-rock-blob47.png');
  await writeFile(blobSheetPath, encodePng(blobSheet.width, blobSheet.height, blobSheet.rgba));
  const rockSheet = (
    await run(session, 'importAsset', { sourcePath: blobSheetPath, name: 'cave-rock-blob47', type: 'sprite' })
  ).asset;
  await run(session, 'setAssetMetadata', { asset: rockSheet.id, metadata: { frames: blobSheet.frames } });

  await run(session, 'updateSettings', {
    buildSettings: { title: 'Glow Caves' },
  });

  // --- scripts (all Lua) ---
  await run(session, 'createScript', {
    name: 'player-move',
    language: 'lua',
    source: `-- Player: four-direction movement through the cave (no gravity).
-- The camera follows so the torch's pool of light stays in view.
local script = {}

function script.onStart(ctx)
  ctx.camera.follow("Player")
end

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")
  local speed = ctx.params.speed or 160
  local vx, vy = 0, 0
  if ctx.input.isDown("left") then vx = vx - speed end
  if ctx.input.isDown("right") then vx = vx + speed end
  if ctx.input.isDown("up") then vy = vy - speed end
  if ctx.input.isDown("down") then vy = vy + speed end
  body.velocity.x = vx
  body.velocity.y = vy
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'torch-embers',
    language: 'lua',
    source: `-- Torch: on top of its steady rate, puff a handful of extra embers
-- every couple of seconds and log the live count. Dogfoods
-- ctx.particles.burst/count from a real Lua script.
local script = {}

function script.onStart(ctx)
  ctx.timers.every(2, function()
    ctx.particles.burst(4)
    ctx.log("torch embers:", ctx.particles.count())
  end)
end

return script
`,
  });

  // --- entities ---
  await run(session, 'createEntity', {
    scene, name: 'Main Camera', position: { x: 400, y: 300 },
    components: { Camera: { backgroundColor: '#0a0a0f', ambientLight: 0.15 } },
  });

  await run(session, 'createEntity', {
    scene, name: 'Cave Floor', tags: ['background'], position: { x: 400, y: 300 },
    components: {
      SpriteRenderer: { shape: 'rectangle', color: '#241f1a', width: 800, height: 600, layer: -20 },
    },
  });

  const boundaryWalls = [
    { name: 'Wall Top', x: 400, y: 10, w: 800, h: 20 },
    { name: 'Wall Bottom', x: 400, y: 590, w: 800, h: 20 },
    { name: 'Wall Left', x: 10, y: 300, w: 20, h: 600 },
    { name: 'Wall Right', x: 790, y: 300, w: 20, h: 600 },
  ];
  for (const w of boundaryWalls) {
    await run(session, 'createEntity', {
      scene, name: w.name, tags: ['wall'], position: { x: w.x, y: w.y },
      components: {
        Collider: { shape: 'box', width: w.w, height: w.h },
        PhysicsBody: { bodyType: 'static' },
      },
    });
  }

  // Cave wall silhouettes: LineRenderer polylines in local space (points are
  // relative to the entity's own Transform.position).
  await run(session, 'createEntity', {
    scene, name: 'Cave Wall Left', tags: ['scenery'], position: { x: 90, y: 300 },
    components: {
      LineRenderer: {
        points: [
          { x: 0, y: -260 }, { x: 34, y: -180 }, { x: -6, y: -90 },
          { x: 26, y: 0 }, { x: -6, y: 90 }, { x: 34, y: 180 }, { x: 0, y: 260 },
        ],
        width: 6, color: '#4a4036', layer: 5,
      },
    },
  });
  await run(session, 'createEntity', {
    scene, name: 'Cave Wall Right', tags: ['scenery'], position: { x: 710, y: 300 },
    components: {
      LineRenderer: {
        points: [
          { x: 0, y: -260 }, { x: -34, y: -180 }, { x: 6, y: -90 },
          { x: -26, y: 0 }, { x: 6, y: 90 }, { x: -34, y: 180 }, { x: 0, y: 260 },
        ],
        width: 6, color: '#4a4036', layer: 5,
      },
    },
  });

  // Cave Rocks: a rock cluster autotiled with the blob47 sheet above — every
  // filled 'R' cell picks its frame from its own 8-neighbour mask at render
  // time (setTileAutotile below), so this grid needed no per-cell art
  // choices, just a shape. Includes one deliberately isolated cell (bottom
  // row) so the "lonely tile" shape (blob_0) shows up too. Positioned clear
  // of the player spawn, the stalactite/drip, and the boundary walls.
  const rockRows = [
    '.RRRR.....',
    '.RRRRRR...',
    'RRRRRRRR..',
    '.RRRRRRR..',
    '..RRRRR...',
    '...RR.....',
    '..........',
    '..R.......',
  ];
  await run(session, 'createEntity', {
    scene, name: 'Cave Rocks', tags: ['wall', 'scenery'], position: { x: 440, y: 250 },
    components: { Tilemap: { tileSize: 16, tileAssets: { R: rockSheet.id }, grid: rockRows, solid: true } },
  });
  await run(session, 'setTileAutotile', { scene, entity: 'Cave Rocks', char: 'R', sheet: rockSheet.id });

  await run(session, 'createEntity', {
    scene, name: 'Player', tags: ['player'], position: { x: 200, y: 450 },
    components: {
      SpriteRenderer: { assetId: explorer.id, width: 28, height: 34 },
      Collider: { shape: 'box', width: 24, height: 30 },
      PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
    },
  });
  await run(session, 'attachScript', {
    scene, entity: 'Player', script: 'scripts/player-move.lua', params: { speed: 160 },
  });

  // Torch: parented to Player (a fixed local offset that rides along, since
  // children inherit only their parent's translation), carrying the light,
  // the flickering flame sprite/animator, and the torch-sparks emitter —
  // this is what makes the light "player-following".
  await run(session, 'createEntity', {
    scene, name: 'Torch', tags: ['torch'], parent: 'Player', position: { x: 0, y: -22 },
    components: {
      Light2D: { radius: 200, color: '#ffcf6b', intensity: 1.1 },
      SpriteRenderer: { assetId: flameA.id, width: 14, height: 18 },
      SpriteAnimator: { assetId: flicker.id, fps: 0, playing: true, loop: true },
      // Torch-sparks recipe: a gentle upward cone of warm embers.
      ParticleEmitter: {
        rate: 8, lifetime: 0.8, speed: 30, spread: 25, direction: -90,
        startSize: 4, endSize: 1, startColor: '#ffcf6b', endColor: '#7a3b12',
        gravity: { x: 0, y: -40 }, seed: 1,
      },
    },
  });
  await run(session, 'attachScript', { scene, entity: 'Torch', script: 'scripts/torch-embers.lua' });

  // Drip: a fixed cave-ceiling drip, independent of the player. Trail
  // recipe: high rate, zero spread, endSize 0, short lifetime (see
  // components.md's ParticleEmitter section for the general recipe).
  await run(session, 'createEntity', {
    scene, name: 'Stalactite', tags: ['scenery'], position: { x: 600, y: 130 },
    components: { SpriteRenderer: { shape: 'triangle', color: '#5a5148', width: 24, height: 28 } },
  });
  await run(session, 'createEntity', {
    scene, name: 'Drip', tags: ['drip'], position: { x: 600, y: 150 },
    components: {
      ParticleEmitter: {
        rate: 25, lifetime: 0.35, speed: 50, spread: 0, direction: 90,
        startSize: 4, endSize: 0, startColor: '#bfe6f5', endColor: '#6fa8c9',
        gravity: { x: 0, y: 180 }, seed: 2,
      },
    },
  });

  // --- playtest ---
  // The expected values below are read back from an actual run of this
  // exact scene (same engine path runPlaytest uses: GameSession.stepAsync),
  // not hand-computed — particle spawn timing is fp-real (see
  // packages/playtest/tests/particles.test.ts), so trusting arithmetic here
  // would be a mistake.
  const SHOWCASE_FRAMES = 105;
  const probe = await GameSession.create(session.store, { scene, seed: 0 });
  for (let i = 0; i < SHOWCASE_FRAMES; i++) await probe.stepAsync();
  const expectedTorchFrame = probe.runtime.find('Torch').components.SpriteRenderer.assetId;
  const expectedDripCount = probe.runtime.getParticleCount('Drip');
  probe.destroy();

  await run(session, 'createPlaytest', {
    name: 'glow-caves-showcase',
    scene,
    steps: [
      { type: 'wait', frames: SHOWCASE_FRAMES },
      { type: 'assertParticleCount', entity: 'Drip', equals: expectedDripCount },
      { type: 'assertProperty', entity: 'Torch', property: 'SpriteRenderer.assetId', equals: expectedTorchFrame },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 200,
  });
  await run(session, 'createPlaytest', {
    name: 'smoke',
    scene,
    steps: [
      { type: 'wait', frames: 60 },
      { type: 'assertEntityExists', entity: 'Player', exists: true },
      { type: 'assertEntityExists', entity: 'Torch', exists: true },
      { type: 'assertEntityExists', entity: 'Drip', exists: true },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 200,
  });

  const report = await run(session, 'validateProject', {});
  if (report.errors.length > 0) throw new Error('glow-caves validation failed: ' + JSON.stringify(report.errors));
  console.log('✓ glow-caves generated');
}

// ---------------------------------------------------------------------------
// Example 6: Bounce Patrol (all-Lua, physics v2 + ctx.math/ctx.events/findPath)
// ---------------------------------------------------------------------------
// Showcases wave B end to end: a solid Tilemap arena with an interior wall
// and a gap (findPath routes the Patroller through it), a bouncy Ball
// (circle collider, restitution), two friction-contrasted floor strips,
// a one-way Ledge, a kinematic Patroller chasing the player via
// ctx.scene.findPath + ctx.math steering, three layer-filtered coin
// triggers, and a ScoreUI driven by ctx.events/onEvent. All scripts are
// Lua. Every playtest expectation below is read back from a real probe
// run of this exact scene (GameSession.create → stepAsync → read →
// destroy, same pattern as generateGlowCaves above) — physics v2's
// restitution/friction resolution and findPath's grid A* are fp-real, so
// hand-computing expected positions/velocities would be a mistake.
async function generateBouncePatrol() {
  const session = await freshProject('bounce-patrol', {
    name: 'Bounce Patrol',
    description: 'A bouncy ball, a chasing patroller, and three coins in one physics-v2 arena.',
  });

  const scene = (await run(session, 'createScene', { name: 'Arena', withCamera: false })).sceneId;

  // --- assets ---
  const playerAsset = (await run(session, 'createSpriteAsset', {
    name: 'player', shape: 'character', color: '#3498db', width: 28, height: 32,
  })).asset;
  const ballAsset = (await run(session, 'createSpriteAsset', {
    name: 'ball', shape: 'circle', color: '#e67e22', width: 28, height: 28,
  })).asset;
  const patrollerAsset = (await run(session, 'createSpriteAsset', {
    name: 'patroller', shape: 'enemy', color: '#c0392b', width: 32, height: 32,
  })).asset;
  const coinAsset = (await run(session, 'createSpriteAsset', {
    name: 'coin', shape: 'coin', color: '#f1c40f', width: 20, height: 20,
  })).asset;
  const wallTile = (await run(session, 'createTileAsset', { name: 'wall', color: '#4a4036', size: 32 })).asset;

  await run(session, 'updateSettings', { buildSettings: { title: 'Bounce Patrol' } });

  // --- scripts (all Lua) ---
  await run(session, 'createScript', {
    name: 'player-move',
    language: 'lua',
    source: `-- Player: four-direction movement (no gravity — physics is reserved
-- for the bouncing Ball and the kinematic Patroller). Friction 0.6 lives
-- on this entity's PhysicsBody component, not in the script.
-- Reminder: ctx calls use DOT syntax (ctx.log("hi"), never ctx:log("hi")).
local script = {}

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")
  local speed = ctx.params.speed or 180
  local vx, vy = 0, 0
  if ctx.input.isDown("left") then vx = vx - speed end
  if ctx.input.isDown("right") then vx = vx + speed end
  if ctx.input.isDown("up") then vy = vy - speed end
  if ctx.input.isDown("down") then vy = vy + speed end
  body.velocity.x = vx
  body.velocity.y = vy
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'patroller-chase',
    language: 'lua',
    source: `-- Patroller: a kinematic body with no gravity/pushback of its own. Every
-- REPATH_INTERVAL frames it asks ctx.scene.findPath for a fresh route to
-- the player (grid A* over the arena's solid Tilemap + statics) and
-- steers waypoint-to-waypoint with ctx.math (sub/normalize/scale) rather
-- than hand-rolled trig. Its Collider is a trigger, so it detects the
-- player without physically shoving anything; touching the player emits
-- "caught". It also overlaps the Tilemap arena's own entity as it walks
-- past walls (see docs/architecture.md) — that fires onCollision too, so
-- the name check below ignores anything that isn't the Player.
local script = {}

local SPEED = 60
local WAYPOINT_RADIUS = 6
local REPATH_INTERVAL = 30

local function repath(ctx)
  local player = ctx.scene.find("Player")
  if not player then return end
  ctx.vars.path = ctx.scene.findPath(ctx.transform.position, player.transform.position)
  ctx.vars.waypointIndex = 1
end

function script.onStart(ctx)
  ctx.vars.path = nil
  ctx.vars.waypointIndex = 1
  repath(ctx)
end

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")

  if ctx.time.frame % REPATH_INTERVAL == 0 then
    repath(ctx)
  end

  local path = ctx.vars.path
  local target = path and path[ctx.vars.waypointIndex] or nil
  if not target then
    body.velocity.x = 0
    body.velocity.y = 0
    return
  end

  local toTarget = ctx.math.sub(target, ctx.transform.position)
  if ctx.math.length(toTarget) < WAYPOINT_RADIUS then
    ctx.vars.waypointIndex = ctx.vars.waypointIndex + 1
    target = path[ctx.vars.waypointIndex]
    if not target then
      body.velocity.x = 0
      body.velocity.y = 0
      return
    end
    toTarget = ctx.math.sub(target, ctx.transform.position)
  end

  local steer = ctx.math.scale(ctx.math.normalize(toTarget), SPEED)
  body.velocity.x = steer.x
  body.velocity.y = steer.y
end

function script.onCollision(ctx, other)
  if other.name ~= "Player" then return end
  ctx.events.emit("caught")
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'coin-collect',
    language: 'lua',
    source: `-- Coin: layer "pickup" with collidesWith {"player"} already restricts
-- contact to the Player entity (see the Collider on each Coin below and
-- docs/components.md's layer rules), so onCollision needs no tag check —
-- the Patroller walks straight through these on layer "default".
local script = {}

function script.onCollision(ctx, other)
  ctx.events.emit("coin", { value = 1 })
  ctx.destroySelf()
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'score-ui',
    language: 'lua',
    source: `-- ScoreUI: no ctx.events.on subscription needed — onEvent(ctx, name, data)
-- fires for every emitted event scene-wide, so it just filters by name.
local script = {}

function script.onStart(ctx)
  ctx.vars.score = 0
end

function script.onEvent(ctx, name, data)
  if name ~= "coin" then return end
  -- Event payloads cross the JS/Lua boundary as proxies, not plain Lua
  -- tables: type(data) reports "userdata" here, never "table", so a
  -- type(data) == "table" guard always fails. Field access on the proxy
  -- still works, so check the field directly instead.
  local amount = 1
  if data and type(data.value) == "number" then
    amount = data.value
  end
  ctx.vars.score = ctx.vars.score + amount
  ctx.getComponent("Text").content = string.format("Score: %d", ctx.vars.score)
end

return script
`,
  });

  // --- entities ---
  await run(session, 'createEntity', {
    scene, name: 'Main Camera', position: { x: 400, y: 304 },
    components: { Camera: { backgroundColor: '#12141c' } },
  });
  await run(session, 'createEntity', {
    scene, name: 'Backdrop', tags: ['background'], position: { x: 400, y: 304 },
    components: { SpriteRenderer: { shape: 'rectangle', color: '#20242c', width: 800, height: 608, layer: -20 } },
  });

  // Arena: a single solid Tilemap — the outer border plus an interior
  // wall at col 12 with a one-row gap at row 9 — gives findPath something
  // real to route the Patroller around (25 cols x 19 rows, tileSize 32 =
  // 800x608). Every character but '.' is a solid wall tile.
  const COLS = 25;
  const ROWS = 19;
  const WALL_COL = 12;
  const GAP_ROW = 9;
  const grid = [];
  for (let r = 0; r < ROWS; r++) {
    if (r === 0 || r === ROWS - 1) {
      grid.push('X'.repeat(COLS));
      continue;
    }
    let row = '';
    for (let c = 0; c < COLS; c++) {
      if (c === 0 || c === COLS - 1) row += 'X';
      else if (c === WALL_COL && r !== GAP_ROW) row += 'X';
      else row += '.';
    }
    grid.push(row);
  }
  await run(session, 'createEntity', {
    scene, name: 'Arena', tags: ['wall'], position: { x: 0, y: 0 },
    components: {
      Tilemap: { tileSize: 32, tileAssets: { X: wallTile.id }, grid, solid: true },
    },
  });

  await run(session, 'createEntity', {
    scene, name: 'Player', tags: ['player'], position: { x: 200, y: 500 },
    components: {
      SpriteRenderer: { assetId: playerAsset.id, width: 28, height: 32 },
      Collider: { shape: 'box', width: 26, height: 30, layer: 'player' },
      PhysicsBody: { bodyType: 'dynamic', gravityScale: 0, friction: 0.6 },
    },
  });
  await run(session, 'attachScript', {
    scene, entity: 'Player', script: 'scripts/player-move.lua', params: { speed: 180 },
  });

  // Ball: spawned well above the arena floor, clear of the Ledge's
  // horizontal footprint (x 152-248) so it falls and bounces straight off
  // the floor rather than clipping the Ledge's corner on the way down —
  // restitution 0.85 against the Tilemap's effective (0, 0) contact
  // material still bounces, since the pair uses the max of each side's
  // restitution/friction (see docs/components.md).
  await run(session, 'createEntity', {
    scene, name: 'Ball', tags: ['ball'], position: { x: 80, y: 100 },
    components: {
      SpriteRenderer: { assetId: ballAsset.id, width: 28, height: 28 },
      Collider: { shape: 'circle', radius: 14 },
      PhysicsBody: { bodyType: 'dynamic', restitution: 0.85 },
    },
  });

  // Ice Patch / Grind Strip: two static floor strips with contrasting
  // friction (0 vs 1). A Tilemap's solid tiles have no material fields of
  // their own (always an effective (0, 0) contact partner), so a real
  // friction surface has to be its own entity with a PhysicsBody.
  await run(session, 'createEntity', {
    scene, name: 'Ice Patch', tags: ['floor'], position: { x: 500, y: 560 },
    components: {
      SpriteRenderer: { shape: 'rectangle', color: '#9fd8ff', width: 160, height: 16 },
      Collider: { shape: 'box', width: 160, height: 16 },
      PhysicsBody: { bodyType: 'static', friction: 0 },
    },
  });
  await run(session, 'createEntity', {
    scene, name: 'Grind Strip', tags: ['floor'], position: { x: 680, y: 560 },
    components: {
      SpriteRenderer: { shape: 'rectangle', color: '#8d6e63', width: 160, height: 16 },
      Collider: { shape: 'box', width: 160, height: 16 },
      PhysicsBody: { bodyType: 'static', friction: 1 },
    },
  });

  // Ledge: a one-way platform above the player's spawn. Approaching from
  // below (or the side) always passes through; it only blocks a mover
  // landing on top while moving downward (see docs/architecture.md).
  await run(session, 'createEntity', {
    scene, name: 'Ledge', tags: ['ledge'], position: { x: 200, y: 400 },
    components: {
      SpriteRenderer: { shape: 'rectangle', color: '#7f8c8d', width: 96, height: 16 },
      Collider: { shape: 'box', width: 96, height: 16, oneWay: true },
      PhysicsBody: { bodyType: 'static' },
    },
  });

  await run(session, 'createEntity', {
    scene, name: 'Patroller', tags: ['enemy'], position: { x: 680, y: 500 },
    components: {
      SpriteRenderer: { assetId: patrollerAsset.id, width: 32, height: 32 },
      Collider: { shape: 'box', width: 30, height: 30, isTrigger: true },
      PhysicsBody: { bodyType: 'kinematic' },
    },
  });
  await run(session, 'attachScript', { scene, entity: 'Patroller', script: 'scripts/patroller-chase.lua' });

  // Coins: layer "pickup", collidesWith ["player"] — the Patroller (layer
  // "default") never touches these; only the Player does.
  const coins = [{ x: 280, y: 500 }, { x: 120, y: 200 }, { x: 300, y: 150 }];
  for (let i = 0; i < coins.length; i++) {
    await run(session, 'createEntity', {
      scene, name: `Coin ${i + 1}`, tags: ['coin'], position: coins[i],
      components: {
        SpriteRenderer: { assetId: coinAsset.id, width: 20, height: 20 },
        Collider: { shape: 'circle', radius: 10, isTrigger: true, layer: 'pickup', collidesWith: ['player'] },
      },
    });
    await run(session, 'attachScript', { scene, entity: `Coin ${i + 1}`, script: 'scripts/coin-collect.lua' });
  }

  await run(session, 'createEntity', {
    scene, name: 'Score', tags: ['ui'],
    components: {
      UIElement: { anchor: 'top-left', offset: { x: 24, y: 28 } },
      Text: { content: 'Score: 0', fontSize: 20, color: '#ffffff' },
    },
  });
  await run(session, 'attachScript', { scene, entity: 'Score', script: 'scripts/score-ui.lua' });

  // --- playtests ---
  // Every expected value below is read back from an actual probe run of
  // this exact scene (GameSession.stepAsync — the same engine path
  // runPlaytest uses), never hand-computed.

  // Probe 1: bounce/determinism — let the Ball fall and bounce off the
  // arena floor, then read back its real velocity/position.
  const BOUNCE_FRAMES = 90;
  let probe = await GameSession.create(session.store, { scene, seed: 0 });
  for (let i = 0; i < BOUNCE_FRAMES; i++) await probe.stepAsync();
  const ballProbe = probe.runtime.find('Ball');
  const expectedBallVX = ballProbe.components.PhysicsBody.velocity.x;
  const expectedBallVY = ballProbe.components.PhysicsBody.velocity.y;
  const expectedBallY = ballProbe.transform.position.y;
  probe.destroy();

  // Probe 2: one-way ledge — hold "up" from spawn (under the Ledge) and
  // read back where the player actually ends up after passing through.
  const LEDGE_FRAMES = 40;
  probe = await GameSession.create(session.store, { scene, seed: 0 });
  probe.runtime.input.setActionDown('up');
  for (let i = 0; i < LEDGE_FRAMES; i++) await probe.stepAsync();
  probe.runtime.input.setActionUp('up');
  const playerProbe = probe.runtime.find('Player');
  const expectedPlayerX = playerProbe.transform.position.x;
  const expectedPlayerY = playerProbe.transform.position.y;
  const ledgeTopY = 400 - 16 / 2;
  if (expectedPlayerY >= ledgeTopY) {
    throw new Error(`bounce-patrol: probed player y ${expectedPlayerY} is not above the Ledge top ${ledgeTopY}`);
  }
  probe.destroy();

  // Probe 3: pathfinding — let the Patroller run its findPath-driven
  // chase and read back where it actually ends up (proving it left its
  // (680, 500) spawn).
  const PATROL_FRAMES = 240;
  probe = await GameSession.create(session.store, { scene, seed: 0 });
  for (let i = 0; i < PATROL_FRAMES; i++) await probe.stepAsync();
  const patrollerProbe = probe.runtime.find('Patroller');
  const expectedPatrollerX = patrollerProbe.transform.position.x;
  const expectedPatrollerY = patrollerProbe.transform.position.y;
  if (Math.hypot(expectedPatrollerX - 680, expectedPatrollerY - 500) < 10) {
    throw new Error('bounce-patrol: probed Patroller barely moved from spawn — findPath steering did not run');
  }
  probe.destroy();

  // Probe 4 (sanity-check only, nothing baked): confirm the scripted-input
  // walk in the events playtest actually reaches Coin 1 in COIN_WALK_FRAMES.
  const COIN_WALK_FRAMES = 40;
  probe = await GameSession.create(session.store, { scene, seed: 0 });
  probe.runtime.input.setActionDown('right');
  for (let i = 0; i < COIN_WALK_FRAMES; i++) await probe.stepAsync();
  probe.runtime.input.setActionUp('right');
  if ((probe.runtime.eventCounts.get('coin') ?? 0) < 1) {
    throw new Error('bounce-patrol: probed walk-right never triggered a coin event — adjust COIN_WALK_FRAMES');
  }
  probe.destroy();

  await run(session, 'createPlaytest', {
    name: 'bounce-determinism',
    scene,
    steps: [
      { type: 'wait', frames: BOUNCE_FRAMES },
      { type: 'assertProperty', entity: 'Ball', property: 'Transform.position.y', equals: expectedBallY },
      { type: 'assertProperty', entity: 'Ball', property: 'PhysicsBody.velocity.x', equals: expectedBallVX },
      { type: 'assertProperty', entity: 'Ball', property: 'PhysicsBody.velocity.y', equals: expectedBallVY },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 300,
  });
  await run(session, 'createPlaytest', {
    name: 'coin-collected',
    scene,
    steps: [
      { type: 'press', action: 'right', frames: COIN_WALK_FRAMES },
      { type: 'assertEventCount', event: 'coin', min: 1 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 300,
  });
  await run(session, 'createPlaytest', {
    name: 'one-way-ledge',
    scene,
    steps: [
      { type: 'press', action: 'up', frames: LEDGE_FRAMES },
      { type: 'assertPositionNear', entity: 'Player', x: expectedPlayerX, y: expectedPlayerY, tolerance: 5 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 300,
  });
  await run(session, 'createPlaytest', {
    name: 'patroller-pathfinds',
    scene,
    steps: [
      { type: 'wait', frames: PATROL_FRAMES },
      { type: 'assertPositionNear', entity: 'Patroller', x: expectedPatrollerX, y: expectedPatrollerY, tolerance: 5 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 400,
  });
  await run(session, 'createPlaytest', {
    name: 'smoke',
    scene,
    steps: [
      { type: 'wait', frames: 60 },
      { type: 'assertEntityExists', entity: 'Player', exists: true },
      { type: 'assertEntityExists', entity: 'Ball', exists: true },
      { type: 'assertEntityExists', entity: 'Patroller', exists: true },
      { type: 'assertEntityExists', entity: 'Ledge', exists: true },
      { type: 'assertEntityExists', entity: 'Score', exists: true },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 300,
  });

  const report = await run(session, 'validateProject', {});
  if (report.errors.length > 0) throw new Error('bounce-patrol validation failed: ' + JSON.stringify(report.errors));
  console.log('✓ bounce-patrol generated');
}

// ---------------------------------------------------------------------------
// Example 7: Sky Courier (imported BINARY assets — the wave C proof)
// ---------------------------------------------------------------------------
// Every other example's sprites/tiles are procedural SVGs created through
// createSpriteAsset/createTileAsset. Sky Courier is the odd one out: its
// character sheet and its music are real binary files (a PNG spritesheet, a
// WAV chiptune loop) drawn/synthesized in code by pixelart.mjs, written to a
// temp path, and brought into the project the same way an agent (or a human
// dragging in game-jam art) would — via importAsset, sliceSpritesheet, and
// createAnimationFromSheet. The font is a real imported TTF, too (the
// fixture already committed at fixtures/fonts/press-start-2p.ttf).
//
// A rooftop courier hops across four platforms, picks up three parcels
// (`ctx.events.emit("parcel", { left = 1 })` on contact), and delivers them
// at a chute that tracks the running total via onEvent and emits
// "delivered" once all three are in. All scripts are Lua, matching the
// idiom generateBouncePatrol established (dot-syntax ctx calls, the
// userdata-proxy-safe event guard, params-driven tuning).

/** 16x16 RGBA pixel helper for the hand-authored courier sheet below. */
function makeCourierSheetRgba() {
  const FRAME_W = 16;
  const FRAME_H = 16;
  const FRAME_COUNT = 6;
  const SHEET_W = FRAME_W * FRAME_COUNT; // 96
  const SHEET_H = FRAME_H; // 16
  const buf = new Uint8Array(SHEET_W * SHEET_H * 4); // starts fully transparent

  function px(fx, x, y, color) {
    if (x < 0 || x >= FRAME_W || y < 0 || y >= FRAME_H) return; // clip silently
    const gx = fx * FRAME_W + x;
    const idx = (y * SHEET_W + gx) * 4;
    buf[idx] = color[0];
    buf[idx + 1] = color[1];
    buf[idx + 2] = color[2];
    buf[idx + 3] = color[3];
  }
  function rect(fx, x0, y0, x1, y1, color) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px(fx, x, y, color);
  }

  const SKIN = [230, 180, 140, 255];
  const CAP = [35, 55, 95, 255];
  const UNIFORM = [70, 140, 220, 255];
  const UNIFORM_DK = [50, 112, 190, 255];
  const SATCHEL = [150, 100, 60, 255];
  const SATCHEL_DK = [110, 72, 42, 255];
  const BOOT = [40, 40, 55, 255];
  const EYE = [20, 20, 25, 255];

  // Cap + face + torso + satchel are the same for every frame except a 1px
  // vertical settle (`bodyLift`) used by the idle frames; legs swing via
  // per-leg horizontal offsets so all six frames read as distinct poses.
  function drawFrame(fx, bodyLift, leftDX, rightDX) {
    const dy = bodyLift;
    rect(fx, 4, 0 + dy, 11, 0 + dy, CAP);
    rect(fx, 3, 1 + dy, 12, 1 + dy, CAP);
    rect(fx, 4, 2 + dy, 11, 2 + dy, CAP);
    rect(fx, 5, 3 + dy, 10, 5 + dy, SKIN);
    px(fx, 6, 4 + dy, EYE);
    px(fx, 9, 4 + dy, EYE);
    rect(fx, 4, 6 + dy, 11, 8 + dy, UNIFORM);
    rect(fx, 4, 9 + dy, 11, 9 + dy, UNIFORM_DK);
    rect(fx, 2, 6 + dy, 3, 9 + dy, SATCHEL_DK);
    rect(fx, 1, 9 + dy, 4, 11 + dy, SATCHEL);
    rect(fx, 5 + leftDX, 10 + dy, 6 + leftDX, 13, UNIFORM_DK);
    rect(fx, 5 + leftDX, 14, 6 + leftDX, 15, BOOT);
    rect(fx, 9 + rightDX, 10 + dy, 10 + rightDX, 13, UNIFORM_DK);
    rect(fx, 9 + rightDX, 14, 10 + rightDX, 15, BOOT);
  }

  // Walk cycle (frames 0-3): each leg pair is unique across the cycle.
  drawFrame(0, 0, -2, 1);
  drawFrame(1, 0, -1, 0);
  drawFrame(2, 0, 1, -2);
  drawFrame(3, 0, 0, -1);
  // Idle (frames 4-5): a gentle 1px settle, feet planted.
  drawFrame(4, 0, 0, 0);
  drawFrame(5, 1, 0, 0);

  return { width: SHEET_W, height: SHEET_H, rgba: buf };
}

async function generateSkyCourier() {
  const session = await freshProject('sky-courier', {
    name: 'Sky Courier',
    description: 'Hop across the rooftops, collect three parcels, and deliver them down the chute.',
  });

  const scene = (await run(session, 'createScene', { name: 'Rooftops', withCamera: false })).sceneId;
  await run(session, 'updateSettings', { buildSettings: { title: 'Sky Courier' } });

  // --- imported binary assets -----------------------------------------
  // Character sheet: hand-drawn 96x16 PNG (6 frames), written to a temp
  // file and imported exactly like a human dragging in game-jam art would.
  const sheet = makeCourierSheetRgba();
  const sheetPath = path.join(os.tmpdir(), 'courier-sheet.png');
  await writeFile(sheetPath, encodePng(sheet.width, sheet.height, sheet.rgba));
  const sheetAsset = (
    await run(session, 'importAsset', { sourcePath: sheetPath, name: 'courier-sheet', type: 'sprite' })
  ).asset;
  if (sheetAsset.metadata.width !== 96 || sheetAsset.metadata.height !== 16) {
    throw new Error(
      `sky-courier: probed sheet metadata ${sheetAsset.metadata.width}x${sheetAsset.metadata.height}, expected 96x16`,
    );
  }
  await run(session, 'sliceSpritesheet', {
    asset: sheetAsset.id, frameWidth: 16, frameHeight: 16, namePrefix: 'courier',
  });
  const walkAnim = (
    await run(session, 'createAnimationFromSheet', {
      name: 'courier-walk', sheet: sheetAsset.id,
      frames: ['courier_0', 'courier_1', 'courier_2', 'courier_3'],
      frameDuration: 0.12, loop: true,
    })
  ).asset;
  const idleAnim = (
    await run(session, 'createAnimationFromSheet', {
      name: 'courier-idle', sheet: sheetAsset.id,
      frames: ['courier_4', 'courier_5'],
      frameDuration: 0.4, loop: true,
    })
  ).asset;

  // Idle/walk state machine: courier-move.lua drives the "moving" bool param
  // every frame; the machine (not a hand-toggled SpriteAnimator) owns the
  // Courier's SpriteRenderer from here on — see the AnimationStateMachine
  // component below and packages/runtime/src/stateMachine.ts.
  const courierSm = await run(session, 'createStateMachineAsset', {
    name: 'courier-motion',
    data: {
      params: { moving: { type: 'bool' } },
      states: [
        { name: 'idle', animation: idleAnim.id },
        { name: 'walk', animation: walkAnim.id },
      ],
      initial: 'idle',
      transitions: [
        { from: 'idle', to: 'walk', conditions: [{ param: 'moving', op: 'eq', value: true }] },
        { from: 'walk', to: 'idle', conditions: [{ param: 'moving', op: 'eq', value: false }] },
      ],
    },
  });

  // Music: an 8s two-voice chiptune loop, synthesized and imported the same
  // way — no procedural createSound preset makes a full musical loop.
  const musicPath = path.join(os.tmpdir(), 'rooftop-loop.wav');
  await writeFile(musicPath, renderChiptuneWav());
  const music = (
    await run(session, 'importAsset', { sourcePath: musicPath, name: 'rooftop-loop', type: 'audio' })
  ).asset;

  // Font: the committed press-start-2p fixture, imported by real path.
  const fontPath = fileURLToPath(new URL('./fixtures/fonts/press-start-2p.ttf', import.meta.url));
  await run(session, 'importAsset', { sourcePath: fontPath, name: 'press-start-2p', type: 'font' });

  // Procedural sound effects (deterministic WAVs, same as every other
  // example — only the music needed the custom chiptune renderer).
  await run(session, 'createSound', { name: 'jump-sound', preset: 'jump' });
  await run(session, 'createSound', { name: 'parcel-sound', preset: 'coin' });
  await run(session, 'createSound', { name: 'delivery-sound', preset: 'powerup' });

  const parcelAsset = (await run(session, 'createSpriteAsset', {
    name: 'parcel', shape: 'rectangle', color: '#c0895a', accentColor: '#7a5230', width: 18, height: 16,
  })).asset;
  const chuteAsset = (await run(session, 'createSpriteAsset', {
    name: 'chute', shape: 'rectangle', color: '#2c3e50', accentColor: '#f1c40f', width: 40, height: 32,
  })).asset;

  // --- scripts (all Lua) ---
  await run(session, 'createScript', {
    name: 'courier-move',
    language: 'lua',
    source: `-- Courier: left/right walk + jump (isGrounded-gated). Idle/walk animation
-- is owned by an AnimationStateMachine (assets/statemachines/courier-motion
-- .asm.json) via its "moving" bool param, set every frame below --
-- ctx.animator.setParam is cheap and idempotent, and the machine only
-- restarts a clip when it actually transitions to a different state, so
-- this doesn't reset the gait each frame the way an unconditional
-- ctx.animate() call would have.
-- Reminder: ctx calls use DOT syntax (ctx.log("hi"), never ctx:log("hi")).
local script = {}

function script.onStart(ctx)
  ctx.vars.spawnX = ctx.transform.position.x
  ctx.vars.spawnY = ctx.transform.position.y
end

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")
  local sprite = ctx.getComponent("SpriteRenderer")
  local speed = ctx.params.speed or 170

  local vx = 0
  if ctx.input.isDown("left") then vx = vx - speed end
  if ctx.input.isDown("right") then vx = vx + speed end
  body.velocity.x = vx

  if ctx.input.justPressed("jump") and ctx.isGrounded() then
    body.velocity.y = -(ctx.params.jumpSpeed or 480)
    ctx.audio.play("jump-sound", { volume = 0.7 })
  end

  if vx < 0 then
    sprite.flipX = true
  elseif vx > 0 then
    sprite.flipX = false
  end

  ctx.animator.setParam(ctx.entity.name, "moving", math.abs(vx) > 1)

  -- Missed a jump and fell past the rooftops: back to the start.
  if ctx.transform.position.y > 700 then
    ctx.transform.position.x = ctx.vars.spawnX
    ctx.transform.position.y = ctx.vars.spawnY
    body.velocity.x = 0
    body.velocity.y = 0
  end
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'parcel-pickup',
    language: 'lua',
    source: `-- Parcel: on contact with the Courier, emits "parcel" (this pickup's
-- contribution toward the delivered count -- the HUD and Chute scripts
-- both listen via onEvent and add it up themselves), plays a pickup
-- chime, and removes itself.
local script = {}

function script.onCollision(ctx, other)
  if other.name ~= "Courier" then return end
  ctx.events.emit("parcel", { left = 1 })
  ctx.audio.play("parcel-sound", { volume = 0.8 })
  ctx.destroySelf()
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'delivery-chute',
    language: 'lua',
    source: `-- Chute: tallies "parcel" events (onEvent fires scene-wide for every
-- emit, unfiltered, so every entity sees every pickup). Once all three
-- are in and the Courier touches the chute, it emits "delivered" exactly
-- once. Event payloads cross the JS/Lua boundary as proxies, not plain
-- Lua tables: type(data) reports "userdata" here, never "table", so the
-- guard checks the field directly (see docs/scripting.md's proxy note).
local script = {}

local TOTAL_PARCELS = 3

function script.onStart(ctx)
  ctx.vars.collected = 0
  ctx.vars.delivered = false
end

function script.onEvent(ctx, name, data)
  if name ~= "parcel" then return end
  local amount = 1
  if data and type(data.left) == "number" then
    amount = data.left
  end
  ctx.vars.collected = ctx.vars.collected + amount
end

function script.onCollision(ctx, other)
  if other.name ~= "Courier" then return end
  if ctx.vars.delivered or ctx.vars.collected < TOTAL_PARCELS then return end
  ctx.vars.delivered = true
  ctx.events.emit("delivered")
  ctx.audio.play("delivery-sound", { volume = 0.9 })
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'hud',
    language: 'lua',
    source: `-- HUD: shows parcels collected (via "parcel" events, same proxy-safe
-- guard as the Chute) and switches to a delivered message once the Chute
-- confirms "delivered".
local script = {}

local TOTAL_PARCELS = 3

function script.onStart(ctx)
  ctx.vars.collected = 0
  ctx.getComponent("Text").content = string.format("Parcels: %d/%d", ctx.vars.collected, TOTAL_PARCELS)
end

function script.onEvent(ctx, name, data)
  if name == "parcel" then
    local amount = 1
    if data and type(data.left) == "number" then
      amount = data.left
    end
    ctx.vars.collected = ctx.vars.collected + amount
    ctx.getComponent("Text").content = string.format("Parcels: %d/%d", ctx.vars.collected, TOTAL_PARCELS)
  elseif name == "delivered" then
    ctx.getComponent("Text").content = "All delivered!"
  end
end

return script
`,
  });

  // --- entities ---
  await run(session, 'createEntity', {
    scene, name: 'Main Camera', position: { x: 400, y: 300 },
    components: { Camera: { backgroundColor: '#5b7fa6' } },
  });
  await run(session, 'createEntity', {
    scene, name: 'Backdrop', tags: ['background'], position: { x: 400, y: 300 },
    components: { SpriteRenderer: { shape: 'rectangle', color: '#3f6b91', width: 800, height: 600, layer: -20 } },
  });

  // Four rooftops, one screen, no camera follow: A (start) -> B -> C -> D
  // (the chute), each a modest hop from the last.
  const rooftops = [
    { name: 'Rooftop A', x: 110, y: 520, w: 200, h: 24 },
    { name: 'Rooftop B', x: 350, y: 430, w: 150, h: 24 },
    { name: 'Rooftop C', x: 560, y: 490, w: 150, h: 24 },
    { name: 'Rooftop D', x: 730, y: 380, w: 140, h: 24 },
  ];
  for (const r of rooftops) {
    await run(session, 'createEntity', {
      scene, name: r.name, tags: ['ground'], position: { x: r.x, y: r.y },
      components: {
        SpriteRenderer: { shape: 'rectangle', color: '#7f8c8d', width: r.w, height: r.h },
        Collider: { shape: 'box', width: r.w, height: r.h },
        PhysicsBody: { bodyType: 'static' },
      },
    });
  }

  await run(session, 'createEntity', {
    scene, name: 'Courier', tags: ['player'], position: { x: 90, y: 480 },
    components: {
      SpriteRenderer: { assetId: sheetAsset.id, frame: 'courier_4', width: 48, height: 48 },
      AnimationStateMachine: { assetId: courierSm.assetId, playing: true },
      Collider: { shape: 'box', width: 34, height: 44 },
      PhysicsBody: { bodyType: 'dynamic' },
    },
  });
  await run(session, 'attachScript', {
    scene, entity: 'Courier', script: 'scripts/courier-move.lua', params: { speed: 170, jumpSpeed: 480 },
  });

  const parcels = [
    { name: 'Parcel 1', x: 170, y: 495 },
    { name: 'Parcel 2', x: 350, y: 405 },
    { name: 'Parcel 3', x: 560, y: 465 },
  ];
  for (const p of parcels) {
    await run(session, 'createEntity', {
      scene, name: p.name, tags: ['parcel'], position: { x: p.x, y: p.y },
      components: {
        SpriteRenderer: { assetId: parcelAsset.id, width: 18, height: 16 },
        Collider: { shape: 'box', width: 18, height: 16, isTrigger: true },
      },
    });
    await run(session, 'attachScript', { scene, entity: p.name, script: 'scripts/parcel-pickup.lua' });
  }

  await run(session, 'createEntity', {
    scene, name: 'Chute', tags: ['chute'], position: { x: 730, y: 350 },
    components: {
      SpriteRenderer: { assetId: chuteAsset.id, width: 40, height: 32 },
      Collider: { shape: 'box', width: 40, height: 32, isTrigger: true },
    },
  });
  await run(session, 'attachScript', { scene, entity: 'Chute', script: 'scripts/delivery-chute.lua' });

  await run(session, 'createEntity', {
    scene, name: 'Title', tags: ['ui'],
    components: {
      UIElement: { anchor: 'top', offset: { x: 0, y: 16 } },
      Text: { content: 'SKY COURIER', fontSize: 20, color: '#ffd166', align: 'center', fontFamily: 'press-start-2p' },
    },
  });
  await run(session, 'createEntity', {
    scene, name: 'HUD', tags: ['ui'],
    components: {
      UIElement: { anchor: 'top-left', offset: { x: 20, y: 56 } },
      Text: { content: 'Parcels: 0/3', fontSize: 12, color: '#ffffff', fontFamily: 'press-start-2p' },
    },
  });
  await run(session, 'attachScript', { scene, entity: 'HUD', script: 'scripts/hud.lua' });

  await run(session, 'createEntity', {
    scene, name: 'Music', tags: ['audio'],
    components: { AudioSource: { assetId: music.id, autoplay: true, loop: true, music: true, volume: 0.6 } },
  });

  // --- playtests ---
  // Every expected value below is read back from an actual probe run of
  // this exact scene (GameSession.stepAsync — same engine path runPlaytest
  // uses), never hand-computed, matching generateBouncePatrol's approach.

  // Probe 1: movement — a short press-right, well short of Parcel 1, so
  // this is a pure movement/animation read (no pickup in flight).
  const MOVE_FRAMES = 15;
  let probe = await GameSession.create(session.store, { scene, seed: 0 });
  probe.runtime.input.setActionDown('right');
  for (let i = 0; i < MOVE_FRAMES; i++) await probe.stepAsync();
  probe.runtime.input.setActionUp('right');
  const courierProbe = probe.runtime.find('Courier');
  const expectedMoveX = courierProbe.transform.position.x;
  const expectedMoveY = courierProbe.transform.position.y;
  if (expectedMoveX <= 90) {
    throw new Error('sky-courier: movement probe did not move right of spawn — adjust MOVE_FRAMES/speed');
  }
  probe.destroy();

  // Probe 2: pickup — press-right long enough to reach Parcel 1.
  const PICKUP_FRAMES = 45;
  probe = await GameSession.create(session.store, { scene, seed: 0 });
  probe.runtime.input.setActionDown('right');
  for (let i = 0; i < PICKUP_FRAMES; i++) await probe.stepAsync();
  probe.runtime.input.setActionUp('right');
  const pickupEventCount = probe.runtime.eventCounts.get('parcel') ?? 0;
  if (pickupEventCount < 1) {
    throw new Error('sky-courier: pickup probe never reached Parcel 1 — adjust PICKUP_FRAMES/layout');
  }
  probe.destroy();

  await run(session, 'createPlaytest', {
    name: 'boot',
    scene,
    steps: [
      { type: 'wait', frames: 10 },
      { type: 'assertAudioCount', music: true, action: 'play', equals: 1 },
      { type: 'assertEntityExists', entity: 'Courier', exists: true },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 200,
  });
  await run(session, 'createPlaytest', {
    name: 'movement',
    scene,
    steps: [
      { type: 'press', action: 'right', frames: MOVE_FRAMES },
      { type: 'assertPositionNear', entity: 'Courier', x: expectedMoveX, y: expectedMoveY, tolerance: 3 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 200,
  });
  await run(session, 'createPlaytest', {
    name: 'pickup',
    scene,
    steps: [
      { type: 'press', action: 'right', frames: PICKUP_FRAMES },
      { type: 'assertEventCount', event: 'parcel', min: 1 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 200,
  });
  await run(session, 'createPlaytest', {
    name: 'smoke',
    scene,
    steps: [
      { type: 'wait', frames: 60 },
      { type: 'assertEntityExists', entity: 'Courier', exists: true },
      { type: 'assertEntityExists', entity: 'Chute', exists: true },
      { type: 'assertEntityExists', entity: 'Parcel 1', exists: true },
      { type: 'assertEntityExists', entity: 'Parcel 2', exists: true },
      { type: 'assertEntityExists', entity: 'Parcel 3', exists: true },
      { type: 'assertEntityExists', entity: 'HUD', exists: true },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 200,
  });

  const report = await run(session, 'validateProject', {});
  if (report.errors.length > 0) throw new Error('sky-courier validation failed: ' + JSON.stringify(report.errors));
  console.log('✓ sky-courier generated');
}

// ---------------------------------------------------------------------------
// Example 8: Drift Cellar (all-Lua, wave D: virtual axes/gamepad, widgets +
// focus navigation, camera effects)
// ---------------------------------------------------------------------------
// The wave D proof piece. Movement reads the analog virtual axes moveX/moveY
// (ctx.input.axis — gamepad stick with WASD/arrow keyboard fallback, all
// declared in inputMappings.axes), dashing is one action bound to both Space
// and gamepad "a" (inputMappings.gamepadButtons), wall bumps flash the screen
// and — gated by a live UIToggle setting — shake the camera, and dashing
// kicks ctx.camera.zoomPunch. Esc/start opens a pause menu built from the
// widget set: a UILayout vertical stack holding a Resume button (the
// ember-trail interactive-UIElement pattern), a music-volume UISlider wired
// to ctx.audio.setMusicVolume, and the screen-shake UIToggle — every widget
// focusable, with focus visuals from onUiEvent focus/blur and keyboard/
// gamepad navigation driven through ctx.ui.moveFocus/activate/adjust.
// Collecting all three gems fades to black (ctx.camera.fade), whose
// onComplete switches to the Vault scene; the persistent fade level carries
// across the switch and the Vault fades back in. All scripts are Lua; every
// baked playtest expectation below is read back from a probe run of this
// exact project (GameSession.stepAsync — the same engine path runPlaytest
// uses), never hand-computed, matching generateBouncePatrol's approach.
async function generateDriftCellar() {
  const session = await freshProject('drift-cellar', {
    name: 'Drift Cellar',
    description: 'Drift through a dim cellar on analog axes, gather three gems, and slip into the vault. Pause with Esc or start.',
  });

  const cellar = (await run(session, 'createScene', { name: 'Cellar', withCamera: false })).sceneId;
  const vault = (await run(session, 'createScene', { name: 'Vault', withCamera: false })).sceneId;

  // Input: analog virtual axes (gamepad stick 0/1 with keyboard fallback
  // codes) plus named actions. dash and ui-confirm share gamepad "a" —
  // harmless, since dash is pause-gated and ui-confirm only matters while
  // the menu is open. The default create-project actions (left/right/up/
  // down/jump/action) are removed so everything listed here is actually
  // used by this game; an empty key list deletes an action.
  await run(session, 'updateSettings', {
    initialScene: 'Cellar',
    buildSettings: {
      title: 'Drift Cellar',
      loading: { backgroundColor: '#0d0a14', spinner: true },
    },
    inputMappings: {
      actions: {
        left: [], right: [], up: [], down: [], jump: [], action: [],
        dash: ['Space'],
        pause: ['Escape'],
        'ui-up': ['ArrowUp'],
        'ui-down': ['ArrowDown'],
        'ui-left': ['ArrowLeft'],
        'ui-right': ['ArrowRight'],
        'ui-confirm': ['Enter'],
      },
      gamepadButtons: {
        dash: ['a'],
        pause: ['start'],
        'ui-up': ['dpad-up'],
        'ui-down': ['dpad-down'],
        'ui-left': ['dpad-left'],
        'ui-right': ['dpad-right'],
        'ui-confirm': ['a'],
      },
      axes: {
        moveX: { gamepadAxis: 0, negativeCodes: ['ArrowLeft', 'KeyA'], positiveCodes: ['ArrowRight', 'KeyD'] },
        moveY: { gamepadAxis: 1, negativeCodes: ['ArrowUp', 'KeyW'], positiveCodes: ['ArrowDown', 'KeyS'] },
      },
    },
  });

  // --- assets ---
  const drifter = (await run(session, 'createSpriteAsset', {
    name: 'drifter', shape: 'character', color: '#9ad1ff', width: 30, height: 34,
  })).asset;
  const gem = (await run(session, 'createSpriteAsset', {
    name: 'gem', shape: 'star', color: '#8be9b3', width: 20, height: 20,
  })).asset;
  await run(session, 'createSound', { name: 'gem-sound', preset: 'coin' });
  await run(session, 'createSound', { name: 'bump-sound', preset: 'hit' });
  await run(session, 'createSound', { name: 'dash-sound', preset: 'jump' });
  await run(session, 'createSound', { name: 'ui-sound', preset: 'blip' });

  // Music: the same chiptune-synthesis import path sky-courier established —
  // a real WAV on the single music channel, so the pause menu's volume
  // slider (ctx.audio.setMusicVolume) controls something genuinely playing.
  const musicPath = path.join(os.tmpdir(), 'cellar-loop.wav');
  await writeFile(musicPath, renderChiptuneWav());
  const music = (
    await run(session, 'importAsset', { sourcePath: musicPath, name: 'cellar-loop', type: 'audio' })
  ).asset;

  // --- scripts (all Lua) ---
  await run(session, 'createScript', {
    name: 'player-drift',
    language: 'lua',
    source: `-- Drifter: analog movement on the moveX/moveY virtual axes
-- (ctx.input.axis reads the gamepad stick, or the WASD/arrow fallback
-- codes, or a playtest setAxis override — all in [-1, 1]). Velocity eases
-- toward the axis target each frame, so motion keeps momentum and slides:
-- the "drift". Dash (Space / gamepad "a") kicks velocity along the current
-- axis direction and punches the camera zoom. Wall bumps flash the screen
-- and, only while the pause menu's Screen Shake toggle is on (its live
-- UIToggle.value IS the setting — read directly, no mirror state), shake
-- the camera. The pause/resume events from the menu controller gate
-- everything. Reminder: ctx calls use DOT syntax (ctx.log("hi")).
local script = {}

function script.onStart(ctx)
  ctx.vars.paused = false
  ctx.vars.lastBump = -1
  ctx.vars.speedInto = 0
end

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")
  if ctx.vars.paused then
    body.velocity.x = 0
    body.velocity.y = 0
    return
  end

  local speed = ctx.params.speed or 240
  local drift = ctx.params.drift or 0.12
  local ax = ctx.input.axis("moveX")
  local ay = ctx.input.axis("moveY")
  body.velocity.x = ctx.math.lerp(body.velocity.x, ax * speed, drift)
  body.velocity.y = ctx.math.lerp(body.velocity.y, ay * speed, drift)

  if ctx.input.justPressed("dash") and (ax ~= 0 or ay ~= 0) then
    local dir = ctx.math.normalize({ x = ax, y = ay })
    local boost = ctx.params.dashBoost or 420
    body.velocity.x = body.velocity.x + dir.x * boost
    body.velocity.y = body.velocity.y + dir.y * boost
    ctx.camera.zoomPunch(1.12, 0.25)
    ctx.audio.play("dash-sound", { volume = 0.6 })
  end

  -- Remember this frame's speed: onCollision runs after physics has
  -- already absorbed the impact, so the bump check below needs the
  -- pre-impact speed to tell a slam from a slow graze.
  ctx.vars.speedInto = ctx.math.length({ x = body.velocity.x, y = body.velocity.y })
end

function script.onCollision(ctx, other)
  if string.sub(other.name, 1, 4) ~= "Wall" then return end
  if ctx.vars.speedInto < 80 then return end
  local now = ctx.time.elapsed
  if now - ctx.vars.lastBump < 0.5 then return end
  ctx.vars.lastBump = now
  ctx.camera.flash("#b7f0ff", 0.15)
  local toggle = ctx.scene.find("Screen Shake")
  if toggle and toggle.getComponent("UIToggle").value then
    ctx.camera.shake(7, 0.25)
  end
  ctx.audio.play("bump-sound", { volume = 0.5 })
end

function script.onEvent(ctx, name)
  if name == "pause" then
    ctx.vars.paused = true
  elseif name == "resume" then
    ctx.vars.paused = false
  end
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'gem-pickup',
    language: 'lua',
    source: `-- Gem: on contact with the Player, emits "gem" (the director counts
-- them scene-wide via onEvent), chimes, and removes itself.
local script = {}

function script.onCollision(ctx, other)
  if other.name ~= "Player" then return end
  ctx.events.emit("gem", { value = 1 })
  ctx.audio.play("gem-sound", { volume = 0.8 })
  ctx.destroySelf()
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'cellar-director',
    language: 'lua',
    source: `-- Director: tallies "gem" events (proxy-safe payload guard — see
-- docs/scripting.md), keeps the HUD current, and once all three are in,
-- saves the tally and fades to black. The fade's onComplete fires exactly
-- once (a superseding fade would drop it) and switches to the Vault; the
-- persistent fade level carries across the scene switch, so the Vault
-- starts black and fades itself back in.
local script = {}

local TOTAL = 3

function script.onStart(ctx)
  ctx.vars.count = 0
  ctx.vars.leaving = false
end

function script.onEvent(ctx, name, data)
  if name ~= "gem" then return end
  local amount = 1
  if data and type(data.value) == "number" then
    amount = data.value
  end
  ctx.vars.count = ctx.vars.count + amount
  local hud = ctx.scene.find("Gems HUD")
  if hud then
    hud.getComponent("Text").content = string.format("Gems: %d/%d", ctx.vars.count, TOTAL)
  end
  if ctx.vars.count >= TOTAL and not ctx.vars.leaving then
    ctx.vars.leaving = true
    ctx.save("gems", ctx.vars.count)
    ctx.camera.fade(1, ctx.params.fadeSeconds or 0.8, {
      color = "#000000",
      onComplete = function()
        ctx.scenes.load("Vault")
      end,
    })
  end
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'menu-controller',
    language: 'lua',
    source: `-- Pause menu controller (on the UILayout container): Esc / gamepad
-- start toggles the menu by sliding the container's UIElement offset on/
-- offscreen (children stack relative to the container, so one offset moves
-- the whole menu). Opening emits "pause" (gameplay scripts freeze
-- themselves) and focuses Resume; closing emits "resume" and clears focus
-- with ctx.ui.focus(nil). While open, ui-up/ui-down move focus spatially,
-- ui-confirm activates the focused widget (a synthesized real click), and
-- ui-left/ui-right nudge the focused slider via ctx.ui.adjust.
local script = {}

local function openMenu(ctx)
  ctx.vars.open = true
  ctx.getComponent("UIElement").offset.x = ctx.params.openX or -105
  ctx.events.emit("pause")
  ctx.ui.focus("Resume")
  ctx.audio.play("ui-sound", { volume = 0.6 })
end

local function closeMenu(ctx)
  ctx.vars.open = false
  ctx.getComponent("UIElement").offset.x = ctx.params.closedX or -3000
  ctx.ui.focus(nil)
  ctx.events.emit("resume")
  ctx.audio.play("ui-sound", { volume = 0.6 })
end

function script.onStart(ctx)
  ctx.vars.open = false
end

function script.onUpdate(ctx, dt)
  if ctx.input.justPressed("pause") then
    if ctx.vars.open then closeMenu(ctx) else openMenu(ctx) end
    return
  end
  if not ctx.vars.open then return end
  if ctx.input.justPressed("ui-up") then ctx.ui.moveFocus("up") end
  if ctx.input.justPressed("ui-down") then ctx.ui.moveFocus("down") end
  if ctx.input.justPressed("ui-left") then ctx.ui.adjust(-1) end
  if ctx.input.justPressed("ui-right") then ctx.ui.adjust(1) end
  if ctx.input.justPressed("ui-confirm") then ctx.ui.activate() end
end

function script.onEvent(ctx, name)
  if name == "menu-close" and ctx.vars.open then
    closeMenu(ctx)
  end
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'resume-button',
    language: 'lua',
    source: `-- Resume: an interactive+focusable UIElement (the ember-trail start-
-- button pattern). focus/blur swap the sprite color — the focus visual —
-- and click (real pointer, or ctx.ui.activate from ui-confirm) asks the
-- menu controller to close via the "menu-close" event.
local script = {}

function script.onUiEvent(ctx, event)
  if event.type == "focus" then
    ctx.getComponent("SpriteRenderer").color = "#e25822"
  elseif event.type == "blur" then
    ctx.getComponent("SpriteRenderer").color = "#3a2d52"
  elseif event.type == "click" then
    ctx.events.emit("menu-close")
  end
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'volume-slider',
    language: 'lua',
    source: `-- Music volume: the change event fires from pointer drags, ui-left/
-- ui-right (ctx.ui.adjust), and activate clicks alike; event.value is the
-- slider's new value, piped straight into the live music channel.
local script = {}

function script.onUiEvent(ctx, event)
  if event.type == "focus" then
    ctx.getComponent("UISlider").handleColor = "#ffb454"
  elseif event.type == "blur" then
    ctx.getComponent("UISlider").handleColor = "#ececec"
  elseif event.type == "change" then
    ctx.audio.setMusicVolume(event.value)
  end
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'shake-toggle',
    language: 'lua',
    source: `-- Screen shake setting: the player's wall-bump handler reads this
-- entity's live UIToggle.value directly, so flipping the checkbox IS the
-- setting — no mirror state to keep in sync.
local script = {}

function script.onUiEvent(ctx, event)
  if event.type == "focus" then
    ctx.getComponent("UIToggle").color = "#ffb454"
  elseif event.type == "blur" then
    ctx.getComponent("UIToggle").color = "#3a3a3a"
  elseif event.type == "change" then
    if event.value then
      ctx.log("screen shake: on")
    else
      ctx.log("screen shake: off")
    end
  end
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'vault-greeter',
    language: 'lua',
    source: `-- Vault: the Cellar's fade-out leaves the persistent overlay at alpha 1
-- across the scene switch, so this scene starts black — fading back to 0
-- here is the fade-in. The label reads the tally the director saved.
local script = {}

function script.onStart(ctx)
  ctx.camera.fade(0, ctx.params.fadeSeconds or 0.7)
  local gems = ctx.load("gems")
  if type(gems) ~= "number" then gems = 0 end
  ctx.getComponent("Text").content = string.format("Gems recovered: %d/3", gems)
end

return script
`,
  });

  // --- Cellar entities ---
  await run(session, 'createEntity', {
    scene: cellar, name: 'Main Camera', position: { x: 400, y: 300 },
    components: { Camera: { backgroundColor: '#141021' } },
  });
  await run(session, 'createEntity', {
    scene: cellar, name: 'Backdrop', tags: ['background'], position: { x: 400, y: 300 },
    components: { SpriteRenderer: { shape: 'rectangle', color: '#1d1730', width: 800, height: 600, layer: -20 } },
  });
  const walls = [
    { name: 'Wall Top', x: 400, y: 12, w: 800, h: 24 },
    { name: 'Wall Bottom', x: 400, y: 588, w: 800, h: 24 },
    { name: 'Wall Left', x: 12, y: 300, w: 24, h: 600 },
    { name: 'Wall Right', x: 788, y: 300, w: 24, h: 600 },
  ];
  for (const w of walls) {
    await run(session, 'createEntity', {
      scene: cellar, name: w.name, tags: ['wall'], position: { x: w.x, y: w.y },
      components: {
        SpriteRenderer: { shape: 'rectangle', color: '#2b2140', width: w.w, height: w.h },
        Collider: { shape: 'box', width: w.w, height: w.h },
        PhysicsBody: { bodyType: 'static' },
      },
    });
  }

  await run(session, 'createEntity', {
    scene: cellar, name: 'Player', tags: ['player'], position: { x: 200, y: 300 },
    components: {
      SpriteRenderer: { assetId: drifter.id, width: 30, height: 34 },
      Collider: { shape: 'box', width: 26, height: 30 },
      PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
    },
  });
  await run(session, 'attachScript', {
    scene: cellar, entity: 'Player', script: 'scripts/player-drift.lua',
    params: { speed: 240, drift: 0.12, dashBoost: 420 },
  });

  // Gems: an L-shaped run — two along the mid row, one below the second —
  // so the gem-run playtest exercises both axes.
  const gems = [
    { name: 'Gem 1', x: 430, y: 300 },
    { name: 'Gem 2', x: 600, y: 300 },
    { name: 'Gem 3', x: 600, y: 440 },
  ];
  for (const g of gems) {
    await run(session, 'createEntity', {
      scene: cellar, name: g.name, tags: ['gem'], position: { x: g.x, y: g.y },
      components: {
        SpriteRenderer: { assetId: gem.id, width: 20, height: 20 },
        Collider: { shape: 'circle', radius: 16, isTrigger: true },
      },
    });
    await run(session, 'attachScript', { scene: cellar, entity: g.name, script: 'scripts/gem-pickup.lua' });
  }

  await run(session, 'createEntity', {
    scene: cellar, name: 'Director', tags: ['system'], position: { x: 0, y: 0 },
    components: {},
  });
  await run(session, 'attachScript', {
    scene: cellar, entity: 'Director', script: 'scripts/cellar-director.lua', params: { fadeSeconds: 0.8 },
  });

  await run(session, 'createEntity', {
    scene: cellar, name: 'Gems HUD', tags: ['ui'],
    components: {
      UIElement: { anchor: 'top-left', offset: { x: 24, y: 28 } },
      Text: { content: 'Gems: 0/3', fontSize: 20, color: '#ffffff' },
    },
  });
  await run(session, 'createEntity', {
    scene: cellar, name: 'Hint', tags: ['ui'],
    components: {
      UIElement: { anchor: 'bottom', offset: { x: 0, y: -24 } },
      Text: { content: 'Stick/WASD drifts — Space dashes — Esc pauses', fontSize: 13, color: '#8f88a0', align: 'center' },
    },
  });
  await run(session, 'createEntity', {
    scene: cellar, name: 'Music', tags: ['audio'],
    components: { AudioSource: { assetId: music.id, autoplay: true, loop: true, music: true, volume: 0.8 } },
  });

  // Pause menu: a UILayout container parked offscreen (offset.x -3000);
  // the controller slides it to openX when Esc/start is pressed. The
  // container's resolved position is the top-left of its padding box, so
  // openX/openY roughly center the ~210x250 stack in the 800x600 screen.
  const MENU_CLOSED_X = -3000;
  const MENU_OPEN_X = -105;
  await run(session, 'createEntity', {
    scene: cellar, name: 'Pause Menu', tags: ['ui'],
    components: {
      UIElement: { anchor: 'center', offset: { x: MENU_CLOSED_X, y: -125 } },
      UILayout: { direction: 'vertical', gap: 12, padding: 16, align: 'center' },
    },
  });
  await run(session, 'attachScript', {
    scene: cellar, entity: 'Pause Menu', script: 'scripts/menu-controller.lua',
    params: { openX: MENU_OPEN_X, closedX: MENU_CLOSED_X },
  });
  await run(session, 'createEntity', {
    scene: cellar, name: 'Menu Title', tags: ['ui'], parent: 'Pause Menu',
    components: {
      UIElement: {},
      Text: { content: 'Paused', fontSize: 22, color: '#f4ecff', align: 'center', layer: 31 },
    },
  });
  await run(session, 'createEntity', {
    scene: cellar, name: 'Resume', tags: ['ui'], parent: 'Pause Menu',
    components: {
      UIElement: { interactive: true, focusable: true },
      SpriteRenderer: { shape: 'rectangle', color: '#3a2d52', width: 170, height: 40, layer: 30 },
      Text: { content: 'Resume', fontSize: 16, color: '#f4ecff', align: 'center', layer: 31 },
    },
  });
  await run(session, 'attachScript', { scene: cellar, entity: 'Resume', script: 'scripts/resume-button.lua' });
  await run(session, 'createEntity', {
    scene: cellar, name: 'Music Label', tags: ['ui'], parent: 'Pause Menu',
    components: {
      UIElement: {},
      Text: { content: 'Music volume', fontSize: 13, color: '#b9b0cc', align: 'center', layer: 31 },
    },
  });
  await run(session, 'createEntity', {
    scene: cellar, name: 'Music Volume', tags: ['ui'], parent: 'Pause Menu',
    components: {
      UIElement: { interactive: true, focusable: true },
      UISlider: { min: 0, max: 1, step: 0.1, value: 0.8, width: 170, layer: 30 },
    },
  });
  await run(session, 'attachScript', { scene: cellar, entity: 'Music Volume', script: 'scripts/volume-slider.lua' });
  await run(session, 'createEntity', {
    scene: cellar, name: 'Shake Label', tags: ['ui'], parent: 'Pause Menu',
    components: {
      UIElement: {},
      Text: { content: 'Screen shake', fontSize: 13, color: '#b9b0cc', align: 'center', layer: 31 },
    },
  });
  await run(session, 'createEntity', {
    scene: cellar, name: 'Screen Shake', tags: ['ui'], parent: 'Pause Menu',
    components: {
      UIElement: { interactive: true, focusable: true },
      UIToggle: { value: true, size: 22, layer: 30 },
    },
  });
  await run(session, 'attachScript', { scene: cellar, entity: 'Screen Shake', script: 'scripts/shake-toggle.lua' });

  // --- Vault entities ---
  await run(session, 'createEntity', {
    scene: vault, name: 'Main Camera', position: { x: 400, y: 300 },
    components: { Camera: { backgroundColor: '#241d12' } },
  });
  await run(session, 'createEntity', {
    scene: vault, name: 'Backdrop', tags: ['background'], position: { x: 400, y: 300 },
    components: { SpriteRenderer: { shape: 'rectangle', color: '#2e2517', width: 800, height: 600, layer: -20 } },
  });
  await run(session, 'createEntity', {
    scene: vault, name: 'Vault Title', tags: ['ui'],
    components: {
      UIElement: { anchor: 'center', offset: { x: 0, y: -60 } },
      Text: { content: 'THE VAULT', fontSize: 40, color: '#ffd166', align: 'center' },
    },
  });
  await run(session, 'createEntity', {
    scene: vault, name: 'Vault Label', tags: ['ui'],
    components: {
      UIElement: { anchor: 'center', offset: { x: 0, y: 4 } },
      Text: { content: 'Gems recovered: 0/3', fontSize: 18, color: '#f4ecff', align: 'center' },
    },
  });
  await run(session, 'attachScript', {
    scene: vault, entity: 'Vault Label', script: 'scripts/vault-greeter.lua', params: { fadeSeconds: 0.7 },
  });
  // A celebratory upward sparkle column behind the title.
  await run(session, 'createEntity', {
    scene: vault, name: 'Sparkles', tags: ['fx'], position: { x: 400, y: 420 },
    components: {
      ParticleEmitter: {
        rate: 14, lifetime: 1.4, speed: 60, spread: 40, direction: -90,
        startSize: 4, endSize: 0, startColor: '#ffd166', endColor: '#8a5a1e',
        gravity: { x: 0, y: -20 }, seed: 3,
      },
    },
  });

  // --- probes + playtests ---
  // Every baked expectation below is read back from a probe run of this
  // exact project (GameSession.stepAsync — the same engine path runPlaytest
  // uses), never hand-computed. Axis-eased drift positions, slider drag
  // values, and camera-effect counts are all fp-real.
  const stepAxis = async (probe, axis, value, frames) => {
    probe.runtime.input.setAxis(axis, value);
    for (let i = 0; i < frames; i++) await probe.stepAsync();
  };
  const pressAction = async (probe, action, frames, settle) => {
    probe.runtime.input.setActionDown(action);
    for (let i = 0; i < frames; i++) await probe.stepAsync();
    probe.runtime.input.setActionUp(action);
    for (let i = 0; i < settle; i++) await probe.stepAsync();
  };
  const effectCount = (probe, effect) => probe.cameraEffects.filter((r) => r.effect === effect).length;

  // Probe 1: drift movement — right, coast, up, settle (mirrors the
  // drift-movement playtest's setAxis steps exactly).
  const MOVE_RIGHT = 40;
  const MOVE_COAST = 15;
  const MOVE_UP = 30;
  const MOVE_SETTLE = 15;
  let probe = await GameSession.create(session.store, { scene: cellar, seed: 0 });
  await stepAxis(probe, 'moveX', 1, MOVE_RIGHT);
  await stepAxis(probe, 'moveX', 0, MOVE_COAST);
  await stepAxis(probe, 'moveY', -1, MOVE_UP);
  await stepAxis(probe, 'moveY', 0, MOVE_SETTLE);
  const moved = probe.runtime.find('Player').transform.position;
  const expectedMoveX = moved.x;
  const expectedMoveY = moved.y;
  if (expectedMoveX < 280 || expectedMoveY > 260) {
    throw new Error(`drift-cellar: movement probe barely drifted (${expectedMoveX}, ${expectedMoveY}) — check axis wiring`);
  }
  probe.destroy();

  // Probe 2: dash — a right-drift then dash must record a zoomPunch.
  const DASH_LEAD = 10;
  probe = await GameSession.create(session.store, { scene: cellar, seed: 0 });
  await stepAxis(probe, 'moveX', 1, DASH_LEAD);
  await pressAction(probe, 'dash', 2, 5);
  if (effectCount(probe, 'zoomPunch') < 1) {
    throw new Error('drift-cellar: dash probe recorded no zoomPunch');
  }
  probe.destroy();

  // Probe 3: wall bump — drift hard left into the wall; shake (toggle
  // defaults on) and flash must both record.
  const WALL_FRAMES = 70;
  probe = await GameSession.create(session.store, { scene: cellar, seed: 0 });
  await stepAxis(probe, 'moveX', -1, WALL_FRAMES);
  if (effectCount(probe, 'shake') < 1 || effectCount(probe, 'flash') < 1) {
    throw new Error('drift-cellar: wall-bump probe recorded no shake/flash');
  }
  probe.destroy();

  // Probe 4: pause menu + slider drag. Opening the menu must focus Resume;
  // the slider's resolved stack position feeds the drag coordinates, and
  // the post-drag UISlider.value is baked as the playtest's expectation.
  // The drag replays runPlaytest's own semantics: down at `from` (1 frame),
  // 5 interpolated moves (1 frame each), up at `to` (1 frame). A change
  // event fires setMusicVolume on the live music channel — asserted here
  // via the session's onAudio hook, since run reports exclude music-volume.
  let musicVolumeEvents = 0;
  probe = await GameSession.create(session.store, {
    scene: cellar, seed: 0,
    onAudio: (e) => { if (e.action === 'music-volume') musicVolumeEvents++; },
  });
  await pressAction(probe, 'pause', 2, 2);
  const focusedId = probe.runtime.getUiFocused();
  const resumeEnt = probe.runtime.find('Resume');
  if (!focusedId || focusedId !== resumeEnt.id) {
    throw new Error('drift-cellar: opening the menu did not focus Resume');
  }
  const settings = session.store.project.buildSettings;
  const uiPos = resolveUiPositions(probe.runtime.getEntities(), settings.width, settings.height);
  const sliderEnt = probe.runtime.find('Music Volume');
  const sliderPos = uiPos.get(sliderEnt.id);
  if (!sliderPos) throw new Error('drift-cellar: slider has no resolved UI position');
  const dragFrom = { x: Math.round(sliderPos.x), y: Math.round(sliderPos.y) };
  const dragTo = { x: dragFrom.x - 43, y: dragFrom.y };
  const DRAG_MOVES = 5;
  probe.runtime.sendPointer(dragFrom.x, dragFrom.y, 'down');
  await probe.stepAsync();
  for (let i = 1; i <= DRAG_MOVES; i++) {
    const t = i / DRAG_MOVES;
    probe.runtime.sendPointer(dragFrom.x + (dragTo.x - dragFrom.x) * t, dragFrom.y, 'move');
    await probe.stepAsync();
  }
  probe.runtime.sendPointer(dragTo.x, dragTo.y, 'up');
  await probe.stepAsync();
  const expectedSliderValue = probe.runtime.find('Music Volume').components.UISlider.value;
  if (expectedSliderValue >= 0.8) {
    throw new Error(`drift-cellar: slider drag left value at ${expectedSliderValue} — drag missed the track`);
  }
  if (musicVolumeEvents < 1) {
    throw new Error('drift-cellar: slider change never reached ctx.audio.setMusicVolume');
  }
  probe.destroy();

  // Probe 5: focus navigation + shake gating. Mirrors the menu-focus-nav
  // playtest: open, ui-down to the slider, ui-left nudges it one step,
  // ui-down to the toggle, ui-confirm flips it off, close, slam the left
  // wall — flash still fires but shake must not.
  probe = await GameSession.create(session.store, { scene: cellar, seed: 0 });
  await pressAction(probe, 'pause', 2, 2);
  await pressAction(probe, 'ui-down', 2, 2);
  const focusAfterDown = probe.runtime.getUiFocused();
  if (focusAfterDown !== probe.runtime.find('Music Volume').id) {
    throw new Error('drift-cellar: ui-down from Resume did not focus the slider');
  }
  await pressAction(probe, 'ui-left', 2, 2);
  const expectedAdjustValue = probe.runtime.find('Music Volume').components.UISlider.value;
  if (!(expectedAdjustValue < 0.8)) {
    throw new Error('drift-cellar: ui-left did not lower the slider value');
  }
  await pressAction(probe, 'ui-down', 2, 2);
  if (probe.runtime.getUiFocused() !== probe.runtime.find('Screen Shake').id) {
    throw new Error('drift-cellar: second ui-down did not focus the toggle');
  }
  await pressAction(probe, 'ui-confirm', 2, 2);
  if (probe.runtime.find('Screen Shake').components.UIToggle.value !== false) {
    throw new Error('drift-cellar: ui-confirm did not flip the toggle off');
  }
  await pressAction(probe, 'pause', 2, 2);
  if (probe.runtime.getUiFocused() !== null) {
    throw new Error('drift-cellar: closing the menu did not clear focus');
  }
  await stepAxis(probe, 'moveX', -1, WALL_FRAMES);
  if (effectCount(probe, 'shake') !== 0) {
    throw new Error('drift-cellar: shake fired despite the toggle being off');
  }
  if (effectCount(probe, 'flash') < 1) {
    throw new Error('drift-cellar: gated wall bump lost its flash too');
  }
  probe.destroy();

  // Probe 6: the gem run — right through Gems 1+2, coast, down through
  // Gem 3, then the director's fade-out completes and switches scenes; the
  // Vault's own fade-in makes the second fade record.
  const RUN_RIGHT = 95;
  const RUN_COAST = 25;
  const RUN_DOWN = 55;
  const RUN_SETTLE = 90;
  probe = await GameSession.create(session.store, { scene: cellar, seed: 0 });
  await stepAxis(probe, 'moveX', 1, RUN_RIGHT);
  await stepAxis(probe, 'moveX', 0, RUN_COAST);
  if ((probe.eventCounts.get('gem') ?? 0) < 2) {
    throw new Error('drift-cellar: gem-run probe missed the mid-row gems — adjust RUN_RIGHT/RUN_COAST');
  }
  await stepAxis(probe, 'moveY', 1, RUN_DOWN);
  await stepAxis(probe, 'moveY', 0, RUN_SETTLE);
  if ((probe.eventCounts.get('gem') ?? 0) !== 3) {
    throw new Error('drift-cellar: gem-run probe did not collect all three gems — adjust RUN_DOWN');
  }
  if (probe.currentSceneId !== vault) {
    throw new Error('drift-cellar: gem-run probe never reached the Vault — extend RUN_SETTLE');
  }
  const expectedFadeCount = effectCount(probe, 'fade');
  if (expectedFadeCount < 2) {
    throw new Error(`drift-cellar: expected fade-out + Vault fade-in records, got ${expectedFadeCount}`);
  }
  const vaultLabelText = probe.runtime.find('Vault Label').components.Text.content;
  if (vaultLabelText !== 'Gems recovered: 3/3') {
    throw new Error(`drift-cellar: Vault label reads "${vaultLabelText}" — save/load handoff broke`);
  }
  probe.destroy();

  await run(session, 'createPlaytest', {
    name: 'drift-movement',
    scene: cellar,
    steps: [
      { type: 'setAxis', axis: 'moveX', value: 1, frames: MOVE_RIGHT },
      { type: 'setAxis', axis: 'moveX', value: 0, frames: MOVE_COAST },
      { type: 'setAxis', axis: 'moveY', value: -1, frames: MOVE_UP },
      { type: 'setAxis', axis: 'moveY', value: 0, frames: MOVE_SETTLE },
      { type: 'assertPositionNear', entity: 'Player', x: expectedMoveX, y: expectedMoveY, tolerance: 3 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 300,
  });
  await run(session, 'createPlaytest', {
    name: 'dash-zoom-punch',
    scene: cellar,
    steps: [
      { type: 'setAxis', axis: 'moveX', value: 1, frames: DASH_LEAD },
      { type: 'press', action: 'dash', frames: 2 },
      { type: 'wait', frames: 5 },
      { type: 'assertCameraEffect', effect: 'zoomPunch', min: 1 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 200,
  });
  await run(session, 'createPlaytest', {
    name: 'wall-bump-shake',
    scene: cellar,
    steps: [
      { type: 'setAxis', axis: 'moveX', value: -1, frames: WALL_FRAMES },
      { type: 'assertCameraEffect', effect: 'shake', min: 1 },
      { type: 'assertCameraEffect', effect: 'flash', min: 1 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 300,
  });
  await run(session, 'createPlaytest', {
    name: 'pause-menu-slider',
    scene: cellar,
    steps: [
      { type: 'press', action: 'pause', frames: 2 },
      { type: 'wait', frames: 2 },
      { type: 'assertFocus', entity: 'Resume' },
      { type: 'drag', from: dragFrom, to: dragTo, frames: DRAG_MOVES },
      { type: 'assertProperty', entity: 'Music Volume', property: 'UISlider.value', equals: expectedSliderValue },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 200,
  });
  await run(session, 'createPlaytest', {
    name: 'menu-focus-nav',
    scene: cellar,
    steps: [
      { type: 'press', action: 'pause', frames: 2 },
      { type: 'wait', frames: 2 },
      { type: 'assertFocus', entity: 'Resume' },
      { type: 'press', action: 'ui-down', frames: 2 },
      { type: 'wait', frames: 2 },
      { type: 'assertFocus', entity: 'Music Volume' },
      { type: 'press', action: 'ui-left', frames: 2 },
      { type: 'wait', frames: 2 },
      { type: 'assertProperty', entity: 'Music Volume', property: 'UISlider.value', equals: expectedAdjustValue },
      { type: 'press', action: 'ui-down', frames: 2 },
      { type: 'wait', frames: 2 },
      { type: 'assertFocus', entity: 'Screen Shake' },
      { type: 'press', action: 'ui-confirm', frames: 2 },
      { type: 'wait', frames: 2 },
      { type: 'assertProperty', entity: 'Screen Shake', property: 'UIToggle.value', equals: false },
      { type: 'press', action: 'pause', frames: 2 },
      { type: 'wait', frames: 2 },
      { type: 'assertFocus', entity: null },
      { type: 'setAxis', axis: 'moveX', value: -1, frames: WALL_FRAMES },
      { type: 'assertCameraEffect', effect: 'shake', equals: 0 },
      { type: 'assertCameraEffect', effect: 'flash', min: 1 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 400,
  });
  await run(session, 'createPlaytest', {
    name: 'gem-run-to-vault',
    scene: cellar,
    steps: [
      { type: 'setAxis', axis: 'moveX', value: 1, frames: RUN_RIGHT },
      { type: 'setAxis', axis: 'moveX', value: 0, frames: RUN_COAST },
      { type: 'setAxis', axis: 'moveY', value: 1, frames: RUN_DOWN },
      { type: 'setAxis', axis: 'moveY', value: 0, frames: RUN_SETTLE },
      { type: 'assertScene', scene: 'Vault' },
      { type: 'assertCameraEffect', effect: 'fade', min: 2 },
      { type: 'assertProperty', entity: 'Vault Label', property: 'Text.content', equals: 'Gems recovered: 3/3' },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 600,
  });
  await run(session, 'createPlaytest', {
    name: 'smoke',
    scene: cellar,
    steps: [
      { type: 'wait', frames: 60 },
      { type: 'assertEntityExists', entity: 'Player', exists: true },
      { type: 'assertEntityExists', entity: 'Gem 1', exists: true },
      { type: 'assertEntityExists', entity: 'Gem 2', exists: true },
      { type: 'assertEntityExists', entity: 'Gem 3', exists: true },
      { type: 'assertEntityExists', entity: 'Pause Menu', exists: true },
      { type: 'assertEntityExists', entity: 'Resume', exists: true },
      { type: 'assertEntityExists', entity: 'Music Volume', exists: true },
      { type: 'assertEntityExists', entity: 'Screen Shake', exists: true },
      { type: 'assertEntityExists', entity: 'Gems HUD', exists: true },
      { type: 'assertAudioCount', music: true, action: 'play', equals: 1 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 200,
  });

  const report = await run(session, 'validateProject', {});
  if (report.errors.length > 0) throw new Error('drift-cellar validation failed: ' + JSON.stringify(report.errors));
  console.log('✓ drift-cellar generated');
}

// ---------------------------------------------------------------------------
// Example 9: Ember Horde (the spatial-hash horde-scale proof, and the
// prefab-spawn showcase)
// ---------------------------------------------------------------------------
// A survivors-like: virtual-axis movement + gamepad (matching drift-cellar),
// one tilemap-bordered arena, and a Director that waves-spawns kinematic
// enemies at runtime via ctx.scene.spawnPrefab, capped at 300 concurrent —
// well inside the headroom the spatial-hash broadphase bought (see
// docs/performance.md's "mixed-horde" scenario: 800 movers, ~2.7ms/frame
// after the perf work, down from 14.3ms before). Every script is Lua.
//
// Steering-pattern decision (see docs/scripting.md's EntityHandle section):
// each enemy's onStart calls ctx.scene.find("Player") exactly ONCE and
// caches the returned handle in ctx.vars. EntityHandle.transform is a live
// getter straight onto the real entity (packages/runtime/src/runtime.ts's
// handleFor), so reading player.transform.position every onUpdate after
// that costs a property read, not a lookup. The alternative the brief
// floats — every enemy re-running ctx.scene.find("Player") every frame —
// is the exact O(n) find-per-enemy-per-frame pattern (O(n^2) total across
// the horde) docs/performance.md's "Script dispatch cost" section calls
// out as the next cost center once broadphase stopped dominating; caching
// the handle at spawn removes it entirely for a one-time O(n) spawn cost
// instead. No event-broadcast or save/load channel is needed for this.
//
// Prefab spawning: the "Enemy" entity below is authored once as a
// normal (enabled) scene entity, then promoted to a reusable prefab via
// createPrefab — horde-director.lua's spawnEnemy spawns copies of it at
// runtime through ctx.scene.spawnPrefab("Enemy", ...), so an enemy's
// components live in exactly one place (assets/prefabs/enemy.prefab.json)
// instead of a hand-mirrored component tree duplicated inside the director
// script. The source entity stays live in the scene as a stationed sentry;
// "Elite Enemy" is a second placed instance of the same prefab with a
// tinted/scaled per-field override (setProperties on an instance member —
// see packages/core/src/project/prefabData.ts's recordInstanceOverride),
// showing an instance can diverge from the prefab on specific fields while
// staying linked for everything else.
async function generateEmberHorde() {
  const session = await freshProject('ember-horde', {
    name: 'Ember Horde',
    description: 'Hold the line against a growing horde of embers. Move with the stick/WASD, dodge, survive.',
  });

  const scene = (await run(session, 'createScene', { name: 'Arena', withCamera: false })).sceneId;

  await run(session, 'updateSettings', {
    initialScene: 'Arena',
    buildSettings: {
      title: 'Ember Horde',
      loading: { backgroundColor: '#170a06', spinner: true },
    },
    inputMappings: {
      actions: {
        left: [], right: [], up: [], down: [], jump: [], action: [],
        pause: ['Escape'],
        'ui-up': ['ArrowUp'],
        'ui-down': ['ArrowDown'],
        'ui-confirm': ['Enter'],
      },
      gamepadButtons: {
        pause: ['start'],
        'ui-up': ['dpad-up'],
        'ui-down': ['dpad-down'],
        'ui-confirm': ['a'],
      },
      axes: {
        moveX: { gamepadAxis: 0, negativeCodes: ['ArrowLeft', 'KeyA'], positiveCodes: ['ArrowRight', 'KeyD'] },
        moveY: { gamepadAxis: 1, negativeCodes: ['ArrowUp', 'KeyW'], positiveCodes: ['ArrowDown', 'KeyS'] },
      },
    },
  });

  // --- assets ---
  const playerAsset = (await run(session, 'createSpriteAsset', {
    name: 'ember-knight', shape: 'character', color: '#ffd166', width: 28, height: 32,
  })).asset;
  const enemyAsset = (await run(session, 'createSpriteAsset', {
    name: 'ember-wisp', shape: 'enemy', color: '#e8462f', width: 22, height: 22,
  })).asset;
  const wallTile = (await run(session, 'createTileAsset', { name: 'ember-wall', color: '#5a3620', size: 32 })).asset;

  // --- scripts (all Lua) ---
  await run(session, 'createScript', {
    name: 'player-move',
    language: 'lua',
    source: `-- Player: direct velocity-follows-axis movement (no drift/easing — a
-- horde needs snappy, predictable dodging, not momentum). Contact with an
-- Enemy costs HP on a cooldown (so a stack of enemies all touching at
-- once doesn't drain it in one frame), updates the HP HUD, and — gated by
-- the pause menu's live Screen Shake toggle value, read directly with no
-- mirror state (same idiom as drift-cellar's wall-bump handler) — shakes
-- the camera and bursts this entity's own pooled ParticleEmitter.
-- Reminder: ctx calls use DOT syntax (ctx.log("hi"), never ctx:log("hi")).
local script = {}

function script.onStart(ctx)
  ctx.vars.hp = ctx.params.maxHp or 100
  ctx.vars.lastHit = -1
  ctx.vars.paused = false
  ctx.vars.hpHud = ctx.scene.find("HP HUD")
end

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")
  if ctx.vars.paused then
    body.velocity.x = 0
    body.velocity.y = 0
    return
  end
  local speed = ctx.params.speed or 170
  body.velocity.x = ctx.input.axis("moveX") * speed
  body.velocity.y = ctx.input.axis("moveY") * speed
end

function script.onCollision(ctx, other)
  if ctx.vars.paused then return end
  -- Tag-, not name-, based: "Elite Enemy" (a tinted prefab instance, still
  -- tagged "enemy") must hurt on contact exactly like every other enemy.
  if not other.tags.includes("enemy") then return end
  if ctx.vars.hp <= 0 then return end
  local now = ctx.time.elapsed
  local cooldown = ctx.params.hitCooldown or 0.4
  if now - ctx.vars.lastHit < cooldown then return end
  ctx.vars.lastHit = now
  ctx.vars.hp = math.max(0, ctx.vars.hp - (ctx.params.contactDamage or 8))
  if ctx.vars.hpHud then
    ctx.vars.hpHud.getComponent("Text").content = string.format("HP: %d", ctx.vars.hp)
  end
  ctx.events.emit("player-hit", { hp = ctx.vars.hp })
  local toggle = ctx.scene.find("Screen Shake")
  if toggle and toggle.getComponent("UIToggle").value then
    ctx.camera.shake(6, 0.2)
  end
  ctx.particles.burst(16)
end

function script.onEvent(ctx, name)
  if name == "pause" then
    ctx.vars.paused = true
  elseif name == "resume" then
    ctx.vars.paused = false
  end
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'enemy-chase',
    language: 'lua',
    source: `-- Enemy: the "Enemy" prefab's own script (see generate.mjs's createPrefab
-- call below) — every enemy horde-director.lua spawns via
-- ctx.scene.spawnPrefab carries this same Script component, so there is
-- exactly one enemy-chase implementation, not a live one plus a disabled
-- hand-mirrored copy. Every enemy caches the Player EntityHandle exactly
-- once, in onStart — EntityHandle.transform is a live getter onto the real
-- entity, so re-reading ctx.vars.player.transform.position every onUpdate
-- afterward is a plain property read, not a scene search. Calling
-- ctx.scene.find("Player") in onUpdate instead (once per enemy, per frame)
-- is the O(n)-per-enemy pattern that turns into O(n^2) across a few hundred
-- enemies — the exact cost docs/performance.md flags next once broadphase
-- stopped dominating.
local script = {}

function script.onStart(ctx)
  ctx.vars.player = ctx.scene.find("Player")
  ctx.vars.paused = false
end

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")
  if ctx.vars.paused then
    body.velocity.x = 0
    body.velocity.y = 0
    return
  end
  local player = ctx.vars.player
  if not player then return end
  local toPlayer = ctx.math.sub(player.transform.position, ctx.transform.position)
  local steer = ctx.math.scale(ctx.math.normalize(toPlayer), ctx.params.speed or 90)
  body.velocity.x = steer.x
  body.velocity.y = steer.y
end

function script.onEvent(ctx, name)
  if name == "pause" then
    ctx.vars.paused = true
  elseif name == "resume" then
    ctx.vars.paused = false
  end
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'horde-director',
    language: 'lua',
    source: `-- Director: spawns the horde in fixed-size waves on a frame interval,
-- capped at ENEMY_CAP concurrent (none of these enemies ever die in this
-- example, so "spawned so far" and "live right now" track together once
-- the two hand-placed instances below are added in). Each wave spawns the
-- "Enemy" prefab (see generate.mjs's createPrefab call) via
-- ctx.scene.spawnPrefab — the prefab asset owns every enemy's components,
-- so this script only ever decides WHERE and WHEN, never what an enemy is
-- made of. Keeps the Timer/Horde HUDs current every frame from cached
-- handles (found once in onStart, same live-handle idiom enemy-chase.lua
-- uses, applied here too for consistency even though the director itself
-- only ever does one find per HUD, not one per enemy).
local script = {}

local ENEMY_CAP = 300
local WAVE_SIZE = 10
local WAVE_INTERVAL = 20

function script.onStart(ctx)
  ctx.vars.count = 0
  ctx.vars.paused = false
  ctx.vars.timerHud = ctx.scene.find("Timer HUD")
  ctx.vars.hordeHud = ctx.scene.find("Horde HUD")
end

local function spawnEnemy(ctx, x, y)
  ctx.scene.spawnPrefab("Enemy", { position = { x = x, y = y } })
  ctx.events.emit("enemy-spawned")
end

function script.onUpdate(ctx, dt)
  if not ctx.vars.paused and ctx.vars.count < ENEMY_CAP and ctx.time.frame % WAVE_INTERVAL == 0 then
    local toSpawn = math.min(WAVE_SIZE, ENEMY_CAP - ctx.vars.count)
    local radius = ctx.params.spawnRadius or 250
    for i = 1, toSpawn do
      local angle = ctx.random.range(0, 6.2831853)
      local x = (ctx.params.centerX or 400) + math.cos(angle) * radius
      local y = (ctx.params.centerY or 304) + math.sin(angle) * radius
      spawnEnemy(ctx, x, y)
      ctx.vars.count = ctx.vars.count + 1
    end
  end

  if ctx.vars.timerHud then
    ctx.vars.timerHud.getComponent("Text").content = string.format("Time: %.1f", ctx.time.elapsed)
  end
  if ctx.vars.hordeHud then
    ctx.vars.hordeHud.getComponent("Text").content = string.format("Enemies: %d/%d", ctx.vars.count, ENEMY_CAP)
  end
end

function script.onEvent(ctx, name)
  if name == "pause" then
    ctx.vars.paused = true
  elseif name == "resume" then
    ctx.vars.paused = false
  end
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'menu-controller',
    language: 'lua',
    source: `-- Pause menu controller (on the UILayout container): Esc / gamepad start
-- toggles the menu by sliding the container's UIElement offset on/offscreen
-- (children stack relative to the container). Opening emits "pause"
-- (every entity's onEvent hook sees it scene-wide — the Player, the
-- Director, and every live Enemy all freeze) and focuses Resume; closing
-- emits "resume" and clears focus. ui-up/ui-down move focus between the
-- two widgets; ui-confirm activates the focused one (a synthesized real
-- click, so a focused toggle flips exactly like a pointer click would).
local script = {}

local function openMenu(ctx)
  ctx.vars.open = true
  ctx.getComponent("UIElement").offset.x = ctx.params.openX or -105
  ctx.events.emit("pause")
  ctx.ui.focus("Resume")
end

local function closeMenu(ctx)
  ctx.vars.open = false
  ctx.getComponent("UIElement").offset.x = ctx.params.closedX or -3000
  ctx.ui.focus(nil)
  ctx.events.emit("resume")
end

function script.onStart(ctx)
  ctx.vars.open = false
end

function script.onUpdate(ctx, dt)
  if ctx.input.justPressed("pause") then
    if ctx.vars.open then closeMenu(ctx) else openMenu(ctx) end
    return
  end
  if not ctx.vars.open then return end
  if ctx.input.justPressed("ui-up") then ctx.ui.moveFocus("up") end
  if ctx.input.justPressed("ui-down") then ctx.ui.moveFocus("down") end
  if ctx.input.justPressed("ui-confirm") then ctx.ui.activate() end
end

function script.onEvent(ctx, name)
  if name == "menu-close" and ctx.vars.open then
    closeMenu(ctx)
  end
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'resume-button',
    language: 'lua',
    source: `-- Resume: an interactive+focusable UIElement (the drift-cellar pattern).
-- focus/blur swap the sprite color; click (real pointer, or
-- ctx.ui.activate from ui-confirm) asks the menu controller to close.
local script = {}

function script.onUiEvent(ctx, event)
  if event.type == "focus" then
    ctx.getComponent("SpriteRenderer").color = "#e8462f"
  elseif event.type == "blur" then
    ctx.getComponent("SpriteRenderer").color = "#3a1f14"
  elseif event.type == "click" then
    ctx.events.emit("menu-close")
  end
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'shake-toggle',
    language: 'lua',
    source: `-- Screen shake setting: player-move.lua reads this entity's live
-- UIToggle.value directly on every contact, so flipping the checkbox IS
-- the setting — no mirror state to keep in sync.
local script = {}

function script.onUiEvent(ctx, event)
  if event.type == "focus" then
    ctx.getComponent("UIToggle").color = "#e8462f"
  elseif event.type == "blur" then
    ctx.getComponent("UIToggle").color = "#3a1f14"
  end
end

return script
`,
  });

  // --- entities ---
  const CENTER_X = 400;
  const CENTER_Y = 304;
  await run(session, 'createEntity', {
    scene, name: 'Main Camera', position: { x: CENTER_X, y: CENTER_Y },
    components: { Camera: { backgroundColor: '#170a06' } },
  });
  await run(session, 'createEntity', {
    scene, name: 'Backdrop', tags: ['background'], position: { x: CENTER_X, y: CENTER_Y },
    components: { SpriteRenderer: { shape: 'rectangle', color: '#2a140a', width: 800, height: 608, layer: -20 } },
  });

  // Arena: a single solid Tilemap, border only (content contract calls for
  // solid tilemap border walls, not an interior maze — the horde needs the
  // interior open) — 25 cols x 19 rows, tileSize 32 = 800x608.
  const COLS = 25;
  const ROWS = 19;
  const grid = [];
  for (let r = 0; r < ROWS; r++) {
    if (r === 0 || r === ROWS - 1) {
      grid.push('X'.repeat(COLS));
      continue;
    }
    let row = '';
    for (let c = 0; c < COLS; c++) row += (c === 0 || c === COLS - 1) ? 'X' : '.';
    grid.push(row);
  }
  await run(session, 'createEntity', {
    scene, name: 'Arena', tags: ['wall'], position: { x: 0, y: 0 },
    components: { Tilemap: { tileSize: 32, tileAssets: { X: wallTile.id }, grid, solid: true } },
  });

  await run(session, 'createEntity', {
    scene, name: 'Player', tags: ['player'], position: { x: CENTER_X, y: CENTER_Y },
    components: {
      SpriteRenderer: { assetId: playerAsset.id, width: 28, height: 32 },
      Collider: { shape: 'box', width: 24, height: 28, layer: 'player', collidesWith: ['default', 'enemy'] },
      PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
      ParticleEmitter: {
        emitting: false, rate: 0, burst: 0, lifetime: 0.4, speed: 140, spread: 180, direction: 0,
        startSize: 5, endSize: 0, startColor: '#ffcf5c', endColor: '#8a2a12', maxParticles: 64, seed: 7,
      },
    },
  });
  await run(session, 'attachScript', {
    scene, entity: 'Player', script: 'scripts/player-move.lua',
    params: { speed: 170, maxHp: 100, contactDamage: 8, hitCooldown: 0.4 },
  });

  // Enemy prefab: authored once as a normal (enabled) scene entity, then
  // promoted to a reusable prefab via createPrefab — this IS the entity
  // horde-director.lua's ctx.scene.spawnPrefab("Enemy", ...) spawns copies
  // of at runtime, so there is no hand-mirrored component tree to keep in
  // sync (see the file-header comment above). The source entity stays in
  // the scene as a stationed sentry, same as any spawnPrefab copy.
  await run(session, 'createEntity', {
    scene, name: 'Enemy', tags: ['enemy'], position: { x: 120, y: 120 },
    components: {
      SpriteRenderer: { assetId: enemyAsset.id, width: 22, height: 22 },
      Collider: { shape: 'circle', radius: 11, layer: 'enemy', collidesWith: ['default', 'player'] },
      PhysicsBody: { bodyType: 'kinematic' },
    },
  });
  await run(session, 'attachScript', {
    scene, entity: 'Enemy', script: 'scripts/enemy-chase.lua', params: { speed: 90 },
  });
  const enemyPrefab = (await run(session, 'createPrefab', { scene, entity: 'Enemy', name: 'Enemy' })).asset;
  // createPrefab leaves the source root "legacy-detached" (an empty-ids marker
  // that is NOT a live instance). Sync the prefab once so "Enemy" is LINKED as
  // a real instance (its ids map gains a self-entry) instead of shipping a
  // stale marker that lies to the Inspector's "Instance of…" banner and no-ops
  // the structural-edit detach safety net (SH-1 / L-119).
  await run(session, 'syncPrefabInstances', { prefab: enemyPrefab.id });

  // Elite Enemy: a second placed instance of the same prefab, tinted and
  // scaled up via a per-field override. setProperties on an instance member
  // records the edit on the prefab's live link (recordInstanceOverride)
  // instead of detaching it, so a later updatePrefab on "Enemy" still flows
  // through to this instance everywhere except the two overridden fields.
  await run(session, 'instantiatePrefab', {
    prefab: enemyPrefab.id, scene, name: 'Elite Enemy', position: { x: 680, y: 500 },
  });
  await run(session, 'setProperties', {
    scene, entity: 'Elite Enemy',
    properties: {
      'SpriteRenderer.color': '#c9184a',
      'SpriteRenderer.width': 32,
      'SpriteRenderer.height': 32,
    },
  });

  await run(session, 'createEntity', {
    scene, name: 'Director', tags: ['system'], position: { x: 0, y: 0 },
    components: {},
  });
  await run(session, 'attachScript', {
    scene, entity: 'Director', script: 'scripts/horde-director.lua',
    params: { spawnRadius: 250, centerX: CENTER_X, centerY: CENTER_Y },
  });

  await run(session, 'createEntity', {
    scene, name: 'Timer HUD', tags: ['ui'],
    components: {
      UIElement: { anchor: 'top-left', offset: { x: 24, y: 20 } },
      Text: { content: 'Time: 0.0', fontSize: 18, color: '#ffe8d1' },
    },
  });
  await run(session, 'createEntity', {
    scene, name: 'HP HUD', tags: ['ui'],
    components: {
      UIElement: { anchor: 'top-right', offset: { x: -24, y: 20 } },
      Text: { content: 'HP: 100', fontSize: 18, color: '#ffe8d1', align: 'right' },
    },
  });
  await run(session, 'createEntity', {
    scene, name: 'Horde HUD', tags: ['ui'],
    components: {
      UIElement: { anchor: 'top', offset: { x: 0, y: 20 } },
      Text: { content: 'Enemies: 0/300', fontSize: 18, color: '#ffb385', align: 'center' },
    },
  });
  await run(session, 'createEntity', {
    scene, name: 'Hint', tags: ['ui'],
    components: {
      UIElement: { anchor: 'bottom', offset: { x: 0, y: -24 } },
      Text: { content: 'Stick/WASD dodges — Esc pauses', fontSize: 13, color: '#c9a08f', align: 'center' },
    },
  });

  // Pause menu: a UILayout container parked offscreen; the controller
  // slides it to openX when Esc/start is pressed (drift-cellar pattern,
  // trimmed to the two widgets this game actually needs).
  const MENU_CLOSED_X = -3000;
  const MENU_OPEN_X = -105;
  await run(session, 'createEntity', {
    scene, name: 'Pause Menu', tags: ['ui'],
    components: {
      UIElement: { anchor: 'center', offset: { x: MENU_CLOSED_X, y: -60 } },
      UILayout: { direction: 'vertical', gap: 12, padding: 16, align: 'center' },
    },
  });
  await run(session, 'attachScript', {
    scene, entity: 'Pause Menu', script: 'scripts/menu-controller.lua',
    params: { openX: MENU_OPEN_X, closedX: MENU_CLOSED_X },
  });
  await run(session, 'createEntity', {
    scene, name: 'Menu Title', tags: ['ui'], parent: 'Pause Menu',
    components: {
      UIElement: {},
      Text: { content: 'Paused', fontSize: 22, color: '#ffe8d1', align: 'center', layer: 31 },
    },
  });
  await run(session, 'createEntity', {
    scene, name: 'Resume', tags: ['ui'], parent: 'Pause Menu',
    components: {
      UIElement: { interactive: true, focusable: true },
      SpriteRenderer: { shape: 'rectangle', color: '#3a1f14', width: 170, height: 40, layer: 30 },
      Text: { content: 'Resume', fontSize: 16, color: '#ffe8d1', align: 'center', layer: 31 },
    },
  });
  await run(session, 'attachScript', { scene, entity: 'Resume', script: 'scripts/resume-button.lua' });
  await run(session, 'createEntity', {
    scene, name: 'Shake Label', tags: ['ui'], parent: 'Pause Menu',
    components: {
      UIElement: {},
      Text: { content: 'Screen shake', fontSize: 13, color: '#c9a08f', align: 'center', layer: 31 },
    },
  });
  await run(session, 'createEntity', {
    scene, name: 'Screen Shake', tags: ['ui'], parent: 'Pause Menu',
    components: {
      UIElement: { interactive: true, focusable: true },
      UIToggle: { value: true, size: 22, layer: 30 },
    },
  });
  await run(session, 'attachScript', { scene, entity: 'Screen Shake', script: 'scripts/shake-toggle.lua' });

  // --- probes + playtests ---
  // Every baked expectation below is read back from a probe run of this
  // exact project (GameSession.stepAsync — the same engine path runPlaytest
  // uses), never hand-computed.

  // Probe 1: movement — a straightforward setAxis drive, no easing to work
  // around (unlike drift-cellar's drifter, this player is direct-velocity).
  const MOVE_RIGHT = 30;
  const MOVE_UP = 20;
  let probe = await GameSession.create(session.store, { scene, seed: 0 });
  probe.runtime.input.setAxis('moveX', 1);
  for (let i = 0; i < MOVE_RIGHT; i++) await probe.stepAsync();
  probe.runtime.input.setAxis('moveX', 0);
  probe.runtime.input.setAxis('moveY', -1);
  for (let i = 0; i < MOVE_UP; i++) await probe.stepAsync();
  probe.runtime.input.setAxis('moveY', 0);
  const moved = probe.runtime.find('Player').transform.position;
  const expectedMoveX = moved.x;
  const expectedMoveY = moved.y;
  if (expectedMoveX <= CENTER_X || expectedMoveY >= CENTER_Y) {
    throw new Error(`ember-horde: movement probe barely moved (${expectedMoveX}, ${expectedMoveY}) — check axis wiring`);
  }
  probe.destroy();

  // Probe 2: sustained horde scale — run well past the frame the wave math
  // caps out at, then read back the true live/spawned counts. Live count is
  // the director's spawn cap PLUS the two hand-placed "enemy"-tagged
  // instances (Enemy, Elite Enemy) — both permanent, so they add a fixed
  // offset on top of whatever the wave math caps out at.
  const ENEMY_CAP = 300;
  const PLACED_ENEMY_COUNT = 2; // Enemy (prefab source) + Elite Enemy
  const HORDE_FRAMES = 650;
  probe = await GameSession.create(session.store, { scene, seed: 0 });
  for (let i = 0; i < HORDE_FRAMES; i++) await probe.stepAsync();
  const liveEnemyCount = probe.runtime.getEntities().filter((e) => e.tags.includes('enemy')).length;
  const spawnedCount = probe.eventCounts.get('enemy-spawned') ?? 0;
  const hordeHudText = probe.runtime.find('Horde HUD').components.Text.content;
  const expectedLiveEnemyCount = ENEMY_CAP + PLACED_ENEMY_COUNT;
  if (liveEnemyCount !== expectedLiveEnemyCount || spawnedCount !== ENEMY_CAP) {
    throw new Error(
      `ember-horde: expected the horde to cap at ${ENEMY_CAP} spawns (${expectedLiveEnemyCount} live, incl. placed instances) by frame ${HORDE_FRAMES} (live ${liveEnemyCount}, spawned ${spawnedCount}) — adjust HORDE_FRAMES or the wave constants`,
    );
  }
  probe.destroy();

  // Probe 3: contact — hold still and let the first wave reach the player;
  // read back how long that actually takes.
  const CONTACT_FRAMES = 220;
  probe = await GameSession.create(session.store, { scene, seed: 0 });
  for (let i = 0; i < CONTACT_FRAMES; i++) await probe.stepAsync();
  const hitCount = probe.eventCounts.get('player-hit') ?? 0;
  if (hitCount < 1) {
    throw new Error(`ember-horde: probed ${CONTACT_FRAMES} frames with no player-hit event — enemies never reached the player`);
  }
  const shakeCount = probe.cameraEffects.filter((r) => r.effect === 'shake').length;
  if (shakeCount < 1) {
    throw new Error('ember-horde: contact probe recorded no camera shake');
  }
  probe.destroy();

  await run(session, 'createPlaytest', {
    name: 'smoke',
    scene,
    steps: [
      { type: 'wait', frames: 60 },
      { type: 'assertEntityExists', entity: 'Player', exists: true },
      { type: 'assertEntityExists', entity: 'Director', exists: true },
      { type: 'assertEntityExists', entity: 'Enemy', exists: true },
      { type: 'assertEntityExists', entity: 'Elite Enemy', exists: true },
      { type: 'assertEntityExists', entity: 'Timer HUD', exists: true },
      { type: 'assertEntityExists', entity: 'HP HUD', exists: true },
      { type: 'assertEntityExists', entity: 'Horde HUD', exists: true },
      { type: 'assertEntityExists', entity: 'Resume', exists: true },
      { type: 'assertEntityExists', entity: 'Screen Shake', exists: true },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 300,
  });
  await run(session, 'createPlaytest', {
    name: 'player-moves-on-axes',
    scene,
    steps: [
      { type: 'setAxis', axis: 'moveX', value: 1, frames: MOVE_RIGHT },
      { type: 'setAxis', axis: 'moveX', value: 0, frames: 0 },
      { type: 'setAxis', axis: 'moveY', value: -1, frames: MOVE_UP },
      { type: 'setAxis', axis: 'moveY', value: 0, frames: 0 },
      { type: 'assertPositionNear', entity: 'Player', x: expectedMoveX, y: expectedMoveY, tolerance: 3 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 200,
  });
  await run(session, 'createPlaytest', {
    name: 'sustained-horde-scale',
    scene,
    steps: [
      { type: 'wait', frames: HORDE_FRAMES },
      { type: 'assertProperty', entity: 'Horde HUD', property: 'Text.content', equals: hordeHudText },
      { type: 'assertEventCount', event: 'enemy-spawned', equals: 300 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 1000,
  });
  await run(session, 'createPlaytest', {
    name: 'enemy-contact-hurts-and-shakes',
    scene,
    steps: [
      { type: 'wait', frames: CONTACT_FRAMES },
      { type: 'assertEventCount', event: 'player-hit', min: 1 },
      { type: 'assertCameraEffect', effect: 'shake', min: 1 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 300,
  });
  await run(session, 'createPlaytest', {
    name: 'shake-toggle-gates-shake',
    scene,
    steps: [
      { type: 'press', action: 'pause', frames: 2 },
      { type: 'wait', frames: 2 },
      { type: 'assertFocus', entity: 'Resume' },
      { type: 'press', action: 'ui-down', frames: 2 },
      { type: 'wait', frames: 2 },
      { type: 'assertFocus', entity: 'Screen Shake' },
      { type: 'press', action: 'ui-confirm', frames: 2 },
      { type: 'press', action: 'pause', frames: 2 },
      { type: 'wait', frames: 2 },
      { type: 'assertFocus', entity: null },
      { type: 'wait', frames: CONTACT_FRAMES },
      { type: 'assertEventCount', event: 'player-hit', min: 1 },
      { type: 'assertCameraEffect', effect: 'shake', equals: 0 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 400,
  });
  await run(session, 'createPlaytest', {
    name: 'pause-menu-focus-nav',
    scene,
    steps: [
      { type: 'press', action: 'pause', frames: 2 },
      { type: 'wait', frames: 2 },
      { type: 'assertFocus', entity: 'Resume' },
      { type: 'press', action: 'ui-down', frames: 2 },
      { type: 'wait', frames: 2 },
      { type: 'assertFocus', entity: 'Screen Shake' },
      { type: 'press', action: 'ui-up', frames: 2 },
      { type: 'wait', frames: 2 },
      { type: 'assertFocus', entity: 'Resume' },
      { type: 'press', action: 'ui-confirm', frames: 2 },
      { type: 'wait', frames: 2 },
      { type: 'assertFocus', entity: null },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 300,
  });

  const report = await run(session, 'validateProject', {});
  if (report.errors.length > 0) throw new Error('ember-horde validation failed: ' + JSON.stringify(report.errors));
  console.log('✓ ember-horde generated');
}

// ---------------------------------------------------------------------------
// Example 10: Ember Arcade (the effects-system proof)
// ---------------------------------------------------------------------------
// A compact arcade scene (drift-cellar tier, not bounce-patrol tier) built
// to exercise the screen-space effects end-to-end: Camera.postEffects
// (crt + vignette + bloom, stacked on the main camera at scene start),
// ctx.effects.flash (per-sprite SpriteEffects hit-flash), and a scripted
// dissolve (SpriteEffects.dissolveAmount driven 0->1 by a target's own
// script, then ctx.scene.destroy). Every script is Lua.
//
// The player runs around and touches Targets (trigger colliders — contact
// doesn't block movement, so a straight run can clip through several in
// sequence); each hit target flashes once, dissolves out over half a
// second, and reports itself to the Director via a "target-hit" event. A
// standalone "CRT" UIToggle proves scripts can drive the postEffects stack
// an author set up, not just render it: its change handler reads
// ctx.getComponent('Camera') on the Main Camera and rewrites postEffects —
// see crt-toggle.lua below for why every field of the crt entry it pushes
// back must be spelled out explicitly (a runtime component write, unlike
// the setComponentProperty command, skips zod's schema defaulting).
//
// Every baked playtest expectation below is read back from a probe run of
// this exact project (GameSession.stepAsync — the same engine path
// runPlaytest uses), never hand-computed — matching every other example's
// approach, and especially important here since flash decay and dissolve
// timing are real fixed-frame arithmetic, not round numbers.
async function generateEmberArcade() {
  const session = await freshProject('ember-arcade', {
    name: 'Ember Arcade',
    description: 'Run the embers down before they fade. Touch a target to pop it, and flip CRT to see the stack move.',
  });

  const scene = (await run(session, 'createScene', { name: 'Arcade', withCamera: false })).sceneId;

  await run(session, 'updateSettings', {
    initialScene: 'Arcade',
    buildSettings: {
      title: 'Ember Arcade',
      loading: { backgroundColor: '#170a1f', spinner: true },
    },
    inputMappings: {
      actions: { left: [], right: [], up: [], down: [], jump: [], action: [] },
      axes: {
        moveX: { gamepadAxis: 0, negativeCodes: ['ArrowLeft', 'KeyA'], positiveCodes: ['ArrowRight', 'KeyD'] },
        moveY: { gamepadAxis: 1, negativeCodes: ['ArrowUp', 'KeyW'], positiveCodes: ['ArrowDown', 'KeyS'] },
      },
    },
  });

  // --- assets ---
  const playerAsset = (await run(session, 'createSpriteAsset', {
    name: 'ember-runner', shape: 'character', color: '#ffe08a', width: 30, height: 34,
  })).asset;
  const targetAsset = (await run(session, 'createSpriteAsset', {
    name: 'ember-target', shape: 'circle', color: '#ff5d3a', width: 32, height: 32,
  })).asset;
  await run(session, 'createSound', { name: 'hit-sound', preset: 'laser' });
  await run(session, 'createSound', { name: 'pop-sound', preset: 'explosion' });
  await run(session, 'createSound', { name: 'toggle-sound', preset: 'blip' });

  // --- scripts (all Lua) ---
  await run(session, 'createScript', {
    name: 'player-move',
    language: 'lua',
    source: `-- Player: direct velocity-follows-axis movement — snappy arcade
-- controls, no drift/easing. Targets react to touching the player (see
-- target-hit.lua); this script only handles movement.
local script = {}

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")
  local speed = ctx.params.speed or 200
  body.velocity.x = ctx.input.axis("moveX") * speed
  body.velocity.y = ctx.input.axis("moveY") * speed
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'target-hit',
    language: 'lua',
    source: `-- Target: on first contact with the Player, flashes (ctx.effects.flash —
-- SpriteEffects.flashStrength decays deterministically toward 0 over
-- flashDuration seconds, no RNG involved) and dissolves out over
-- dissolveSeconds by driving SpriteEffects.dissolveAmount from 0 to 1,
-- then removes itself with ctx.scene.destroy. ctx.vars.hit guards against
-- a lingering trigger overlap re-firing the sequence.
local script = {}

function script.onStart(ctx)
  ctx.vars.hit = false
  ctx.vars.dissolveElapsed = 0
end

function script.onCollision(ctx, other)
  if ctx.vars.hit or other.name ~= "Player" then return end
  ctx.vars.hit = true
  ctx.effects.flash(ctx.params.flashColor or "#fff4d6", ctx.params.flashSeconds or 0.2)
  ctx.audio.play("hit-sound", { volume = 0.6 })
  ctx.events.emit("target-hit")
end

function script.onUpdate(ctx, dt)
  if not ctx.vars.hit then return end
  ctx.vars.dissolveElapsed = ctx.vars.dissolveElapsed + dt
  local duration = ctx.params.dissolveSeconds or 0.5
  local fx = ctx.getComponent("SpriteEffects")
  fx.dissolveAmount = math.min(1, ctx.vars.dissolveElapsed / duration)
  if ctx.vars.dissolveElapsed >= duration then
    ctx.audio.play("pop-sound", { volume = 0.5 })
    ctx.scene.destroy(ctx.entity.id)
  end
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'score-director',
    language: 'lua',
    source: `-- Director: tallies "target-hit" events scene-wide and keeps the HUD
-- current. Purely a counter — the targets themselves own their flash/
-- dissolve/destroy sequence.
local script = {}

function script.onStart(ctx)
  ctx.vars.count = 0
end

function script.onEvent(ctx, name)
  if name ~= "target-hit" then return end
  ctx.vars.count = ctx.vars.count + 1
  local hud = ctx.scene.find("Score HUD")
  if hud then
    hud.getComponent("Text").content = string.format("Targets: %d/%d", ctx.vars.count, ctx.params.total or 3)
  end
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'crt-toggle',
    language: 'lua',
    source: `-- CRT toggle: mutates the Main Camera's live Camera.postEffects stack
-- directly through ctx.getComponent — proving a script can drive the
-- post-effects stack an author set up, not just render it. A runtime
-- component write skips schema defaulting (see docs/scripting.md's
-- component-mutation contract), so every field of the crt entry this
-- pushes must be spelled out explicitly — matching the values Ember
-- Arcade's Main Camera was authored with.
local script = {}

local function setCrt(camera, enabled)
  local kept = {}
  for i = 1, #camera.postEffects do
    local effect = camera.postEffects[i]
    if effect.type ~= "crt" then
      table.insert(kept, effect)
    end
  end
  if enabled then
    table.insert(kept, { type = "crt", curvature = 0.18, scanlineIntensity = 0.3, noise = 0.05 })
  end
  camera.postEffects = kept
end

function script.onUiEvent(ctx, event)
  if event.type ~= "change" then return end
  local mainCamera = ctx.scene.find("Main Camera")
  if not mainCamera then return end
  setCrt(mainCamera.getComponent("Camera"), event.value)
  ctx.audio.play("toggle-sound", { volume = 0.5 })
end

return script
`,
  });

  // --- entities ---
  const CENTER_Y = 300;
  await run(session, 'createEntity', {
    scene, name: 'Main Camera', position: { x: 400, y: CENTER_Y },
    components: {
      Camera: {
        backgroundColor: '#170a1f',
        postEffects: [
          { type: 'crt', curvature: 0.18, scanlineIntensity: 0.3, noise: 0.05 },
          { type: 'vignette', intensity: 0.45, color: '#000000' },
          { type: 'bloom', strength: 1.1, threshold: 0.45 },
        ],
      },
    },
  });
  await run(session, 'createEntity', {
    scene, name: 'Backdrop', tags: ['background'], position: { x: 400, y: CENTER_Y },
    components: { SpriteRenderer: { shape: 'rectangle', color: '#241333', width: 800, height: 600, layer: -20 } },
  });

  const walls = [
    { name: 'Wall Top', x: 400, y: 12, w: 800, h: 24 },
    { name: 'Wall Bottom', x: 400, y: 588, w: 800, h: 24 },
    { name: 'Wall Left', x: 12, y: 300, w: 24, h: 600 },
    { name: 'Wall Right', x: 788, y: 300, w: 24, h: 600 },
  ];
  for (const w of walls) {
    await run(session, 'createEntity', {
      scene, name: w.name, tags: ['wall'], position: { x: w.x, y: w.y },
      components: {
        SpriteRenderer: { shape: 'rectangle', color: '#3a2150', width: w.w, height: w.h },
        Collider: { shape: 'box', width: w.w, height: w.h },
        PhysicsBody: { bodyType: 'static' },
      },
    });
  }

  await run(session, 'createEntity', {
    scene, name: 'Player', tags: ['player'], position: { x: 120, y: CENTER_Y },
    components: {
      SpriteRenderer: { assetId: playerAsset.id, width: 30, height: 34 },
      Collider: { shape: 'box', width: 26, height: 30 },
      PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
    },
  });
  await run(session, 'attachScript', {
    scene, entity: 'Player', script: 'scripts/player-move.lua', params: { speed: 200 },
  });

  // Targets: a straight row at the player's starting height, spaced so a
  // steady rightward run clips through all three in sequence (they're
  // trigger colliders — contact never blocks movement).
  const targets = [
    { name: 'Target 1', x: 300 },
    { name: 'Target 2', x: 480 },
    { name: 'Target 3', x: 650 },
  ];
  for (const t of targets) {
    await run(session, 'createEntity', {
      scene, name: t.name, tags: ['target'], position: { x: t.x, y: CENTER_Y },
      components: {
        SpriteRenderer: { assetId: targetAsset.id, width: 32, height: 32 },
        Collider: { shape: 'circle', radius: 16, isTrigger: true },
        SpriteEffects: {},
      },
    });
    await run(session, 'attachScript', {
      scene, entity: t.name, script: 'scripts/target-hit.lua',
      params: { flashColor: '#fff4d6', flashSeconds: 0.2, dissolveSeconds: 0.5 },
    });
  }

  await run(session, 'createEntity', {
    scene, name: 'Director', tags: ['system'], position: { x: 0, y: 0 },
    components: {},
  });
  await run(session, 'attachScript', {
    scene, entity: 'Director', script: 'scripts/score-director.lua', params: { total: targets.length },
  });

  await run(session, 'createEntity', {
    scene, name: 'Score HUD', tags: ['ui'],
    components: {
      UIElement: { anchor: 'top-left', offset: { x: 24, y: 20 } },
      Text: { content: 'Targets: 0/3', fontSize: 18, color: '#ffe8d1' },
    },
  });
  await run(session, 'createEntity', {
    scene, name: 'Hint', tags: ['ui'],
    components: {
      UIElement: { anchor: 'bottom', offset: { x: 0, y: -24 } },
      Text: { content: 'Stick/WASD runs — touch a target to pop it', fontSize: 13, color: '#c9a8db', align: 'center' },
    },
  });
  await run(session, 'createEntity', {
    scene, name: 'CRT Label', tags: ['ui'],
    components: {
      UIElement: { anchor: 'top-right', offset: { x: -64, y: 22 } },
      Text: { content: 'CRT', fontSize: 14, color: '#c9a8db', align: 'right' },
    },
  });
  await run(session, 'createEntity', {
    scene, name: 'CRT Toggle', tags: ['ui'],
    components: {
      UIElement: { anchor: 'top-right', offset: { x: -20, y: 20 }, interactive: true, focusable: true },
      UIToggle: { value: true, size: 22 },
    },
  });
  await run(session, 'attachScript', { scene, entity: 'CRT Toggle', script: 'scripts/crt-toggle.lua' });

  // --- probes + playtests ---
  // Every baked expectation below is read back from a probe run of this
  // exact project (GameSession.stepAsync — the same engine path
  // runPlaytest uses), never hand-computed.

  // Probe 1: run right the whole time and watch the first target's flash
  // decay and dissolve to completion, recording the exact frame counts and
  // values instead of assuming round numbers.
  let probe = await GameSession.create(session.store, { scene, seed: 0 });
  probe.runtime.input.setAxis('moveX', 1);
  let frame = 0;
  let hitFrame = null;
  const HIT_SEARCH_CAP = 400;
  while (frame < HIT_SEARCH_CAP && hitFrame === null) {
    await probe.stepAsync();
    frame++;
    if ((probe.eventCounts.get('target-hit') ?? 0) >= 1) hitFrame = frame;
  }
  if (hitFrame === null) {
    throw new Error(`ember-arcade: player never touched Target 1 within ${HIT_SEARCH_CAP} frames — check speed/spacing`);
  }
  const FLASH_SAMPLE_DELAY = 5;
  for (let i = 0; i < FLASH_SAMPLE_DELAY; i++) {
    await probe.stepAsync();
    frame++;
  }
  const FLASH_SAMPLE_FRAME = frame;
  const target1AtSample = probe.runtime.find('Target 1');
  if (!target1AtSample) throw new Error('ember-arcade: Target 1 already gone at the flash-sample frame');
  const expectedFlashStrength = target1AtSample.components.SpriteEffects.flashStrength;
  if (!(expectedFlashStrength > 0 && expectedFlashStrength < 1)) {
    throw new Error(`ember-arcade: flash-sample strength ${expectedFlashStrength} is not mid-decay — adjust FLASH_SAMPLE_DELAY`);
  }
  const DISSOLVE_SEARCH_CAP = 400;
  while (frame < FLASH_SAMPLE_FRAME + DISSOLVE_SEARCH_CAP && probe.runtime.find('Target 1')) {
    await probe.stepAsync();
    frame++;
  }
  if (probe.runtime.find('Target 1')) {
    throw new Error('ember-arcade: Target 1 never finished dissolving — check dissolveSeconds/DISSOLVE_SEARCH_CAP');
  }
  const DISSOLVE_DONE_FRAME = frame;
  if (!probe.runtime.find('Target 2')) {
    throw new Error('ember-arcade: Target 2 was unexpectedly destroyed too — spacing/timing overlap');
  }
  if ((probe.eventCounts.get('target-hit') ?? 0) !== 1) {
    throw new Error('ember-arcade: expected exactly one target-hit by the time Target 1 finished dissolving');
  }
  probe.destroy();

  // Probe 2: the CRT toggle's resolved screen position, for a `click` step.
  probe = await GameSession.create(session.store, { scene, seed: 0 });
  await probe.stepAsync();
  const settings = session.store.project.buildSettings;
  const uiPos = resolveUiPositions(probe.runtime.getEntities(), settings.width, settings.height);
  const toggleEnt = probe.runtime.find('CRT Toggle');
  const togglePos = uiPos.get(toggleEnt.id);
  if (!togglePos) throw new Error('ember-arcade: CRT Toggle has no resolved UI position');
  const toggleClick = { x: Math.round(togglePos.x), y: Math.round(togglePos.y) };
  probe.destroy();

  await run(session, 'createPlaytest', {
    name: 'crt-toggle-drives-post-effects',
    scene,
    steps: [
      { type: 'wait', frames: 1 },
      { type: 'assertPostEffect', effect: 'crt', active: true },
      { type: 'click', x: toggleClick.x, y: toggleClick.y },
      { type: 'assertPostEffect', effect: 'crt', active: false },
      { type: 'assertProperty', entity: 'CRT Toggle', property: 'UIToggle.value', equals: false },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 100,
  });
  await run(session, 'createPlaytest', {
    name: 'target-hit-flash-and-dissolve',
    scene,
    steps: [
      { type: 'setAxis', axis: 'moveX', value: 1, frames: FLASH_SAMPLE_FRAME },
      { type: 'assertProperty', entity: 'Target 1', property: 'SpriteEffects.flashStrength', equals: expectedFlashStrength },
      { type: 'setAxis', axis: 'moveX', value: 1, frames: DISSOLVE_DONE_FRAME - FLASH_SAMPLE_FRAME },
      { type: 'assertEntityExists', entity: 'Target 1', exists: false },
      { type: 'assertEntityExists', entity: 'Target 2', exists: true },
      { type: 'assertEventCount', event: 'target-hit', equals: 1 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 900,
  });
  await run(session, 'createPlaytest', {
    name: 'smoke',
    scene,
    steps: [
      { type: 'wait', frames: 30 },
      { type: 'assertEntityExists', entity: 'Player', exists: true },
      { type: 'assertEntityExists', entity: 'Target 1', exists: true },
      { type: 'assertEntityExists', entity: 'Target 2', exists: true },
      { type: 'assertEntityExists', entity: 'Target 3', exists: true },
      { type: 'assertEntityExists', entity: 'CRT Toggle', exists: true },
      { type: 'assertEntityExists', entity: 'Score HUD', exists: true },
      { type: 'assertPostEffect', effect: 'crt', active: true },
      { type: 'assertPostEffect', effect: 'vignette', active: true },
      { type: 'assertPostEffect', effect: 'bloom', active: true },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 100,
  });

  const report = await run(session, 'validateProject', {});
  if (report.errors.length > 0) throw new Error('ember-arcade validation failed: ' + JSON.stringify(report.errors));
  console.log('✓ ember-arcade generated');
}

// ---------------------------------------------------------------------------
// Example 11: Crystal Warrens (the script-modules proof)
// ---------------------------------------------------------------------------
// A seeded procgen cave whose generator lives in scripts/lib/noise.lua — a
// hand-rolled value-noise module (ctx.math has no noise primitive, which is
// exactly the argument for script modules) required by TWO behaviors:
// cave-carver.lua carves the Tilemap from the noise field and PROVES the
// result is connected with ctx.scene.findPath (spawn → exit), and
// crystal-grower.lua re-derives the same field from the carver's seed to
// plant glow crystals inside open tunnel cells. The carve replaces the
// authored all-wall grid with ONE whole-array assignment (tilemap.grid =
// rows) — the runtime detects grid changes by reference identity
// (docs/scripting.md's component-mutation contract), so an in-place edit
// would silently keep stale collision boxes and a stale render. Authoring
// the initial grid fully solid makes that failure mode loud: if the carve
// (or the require chain behind it) ever breaks, the map stays a wall slab,
// findPath returns nil, and the playtests below fail. All scripts are Lua;
// every playtest expectation is read back from a probe run, never
// hand-computed.
async function generateCrystalWarrens() {
  const session = await freshProject('crystal-warrens', {
    name: 'Crystal Warrens',
    description: 'A seeded value-noise cave, carved and crystal-lit by two behaviors sharing one scripts/lib module.',
  });

  const scene = (await run(session, 'createScene', { name: 'Warrens', withCamera: false })).sceneId;

  // --- assets ---
  const miner = (await run(session, 'createSpriteAsset', {
    name: 'miner', shape: 'character', color: '#9fd8ff', width: 24, height: 30,
  })).asset;
  const rockTile = (await run(session, 'createTileAsset', { name: 'warren-rock', color: '#3d3a52', size: 32 })).asset;

  await run(session, 'updateSettings', { buildSettings: { title: 'Crystal Warrens' } });

  // Grid geometry shared by the generator below, both Lua behaviors, and the
  // probes: 25x19 cells at 32px = 800x608, same arena footprint as
  // bounce-patrol (the camera at (400, 304) frames the whole map).
  const TILE = 32;
  const COLS = 25;
  const ROWS = 19;
  const SPAWN_CELL = { c: 3, r: 15 };
  const EXIT_CELL = { c: 21, r: 3 };
  const cellCenter = (cell) => ({ x: cell.c * TILE + TILE / 2, y: cell.r * TILE + TILE / 2 });

  // --- scripts (all Lua) ---
  // The shared library. createScript's `dir` param is how a library is
  // authored through the command surface (scripts/lib/noise.lua).
  await run(session, 'createScript', {
    name: 'noise',
    dir: 'lib',
    language: 'lua',
    source: `-- Value noise from scratch. ctx.math has no noise primitive, so the
-- warrens carve their tunnels with this hand-rolled lattice noise — and
-- because it lives in scripts/lib/, BOTH behaviors (cave-carver.lua,
-- crystal-grower.lua) require() the exact same field math instead of
-- copy-pasting it. That reuse is what script modules are for.
--
-- Everything here is a pure function of (x, y, seed): no ctx, no state.
-- Callers derive the lattice seed from the seeded ctx.random stream, so a
-- session seed pins the entire cave layout.
local noise = {}

-- Deterministic lattice hash -> [0, 1). Lua 5.4 integer mixing, identical
-- on every platform the wasm Lua engine runs on.
function noise.hash2(x, y, seed)
  local h = (x * 374761393 + y * 668265263 + seed * 1442695041) % 4294967296
  h = ((h ~ (h >> 13)) * 1274126177) % 4294967296
  return ((h ~ (h >> 16)) % 65536) / 65536.0
end

local function smooth(t)
  return t * t * (3.0 - 2.0 * t)
end

-- Smoothly interpolated value noise over the integer lattice, in [0, 1).
function noise.value2(x, y, seed)
  local x0 = math.floor(x)
  local y0 = math.floor(y)
  local fx = x - x0
  local fy = y - y0
  local a = noise.hash2(x0, y0, seed)
  local b = noise.hash2(x0 + 1, y0, seed)
  local c = noise.hash2(x0, y0 + 1, seed)
  local d = noise.hash2(x0 + 1, y0 + 1, seed)
  local u = smooth(fx)
  local v = smooth(fy)
  local top = a + (b - a) * u
  local bottom = c + (d - c) * u
  return top + (bottom - top) * v
end

-- Two-octave fractal value noise, still in [0, 1).
function noise.fbm2(x, y, seed)
  return (noise.value2(x, y, seed) * 2.0 + noise.value2(x * 2.0, y * 2.0, seed + 101)) / 3.0
end

-- The cave rule both behaviors share: is interior cell (col, row) open
-- tunnel for this seed? Borders are always wall; callers clamp.
function noise.caveOpen(col, row, seed)
  return noise.fbm2(col * 0.35, row * 0.35, seed) < 0.56
end

-- One integer lattice seed drawn from the seeded ctx.random stream.
function noise.seedFrom(random)
  return math.floor(random.next() * 1048576)
end

return noise
`,
  });

  await run(session, 'createScript', {
    name: 'cave-carver',
    language: 'lua',
    source: `-- Carves the warrens at level start. Seeded value noise (the shared
-- lib/noise module) decides which cells are tunnel, 3x3 clearings are kept
-- open around the Player and the Exit Gate, and the grid is REPLACED with
-- one whole-array assignment: the runtime detects grid changes by
-- reference identity (docs/scripting.md), so tilemap.grid = rows is the
-- contract — editing the old rows in place would silently keep stale
-- collision boxes and a stale render.
--
-- Connectivity is then PROVEN, not assumed: ctx.scene.findPath must route
-- from the Player to the Exit Gate through the carved tunnels. If the
-- noise happened to wall them apart, an L-corridor is cut and the proof
-- re-run ON THE NEXT FRAME: the runtime rebuilds its findPath nav grid at
-- most once per frame, so a second findPath in the same frame would still
-- see the pre-corridor walls. Emits "warrens-carved" at start (with the
-- lattice seed, so crystal-grower.lua can sample the same field) and
-- "warrens-connected" once the path is proven.
local noise = require("lib/noise")

local script = {}

local TILE = 32
local COLS = 25
local ROWS = 19

local function cellOf(pos)
  return { c = math.floor(pos.x / TILE), r = math.floor(pos.y / TILE) }
end

-- Build the rows for this seed: noise tunnels, plus 3x3 clearings around
-- each of \`clearings\`, plus every \`corridor\` cell. Returns a FRESH table
-- every call (see the reference-identity contract above).
local function buildRows(seed, clearings, corridor)
  local open = {}
  local function mark(c, r)
    if c > 0 and c < COLS - 1 and r > 0 and r < ROWS - 1 then
      open[r * COLS + c] = true
    end
  end
  for r = 1, ROWS - 2 do
    for c = 1, COLS - 2 do
      if noise.caveOpen(c, r, seed) then mark(c, r) end
    end
  end
  for _, cell in ipairs(clearings) do
    for dr = -1, 1 do
      for dc = -1, 1 do
        mark(cell.c + dc, cell.r + dr)
      end
    end
  end
  for _, cell in ipairs(corridor) do
    mark(cell.c, cell.r)
  end
  local rows = {}
  for r = 0, ROWS - 1 do
    local chars = {}
    for c = 0, COLS - 1 do
      chars[#chars + 1] = open[r * COLS + c] and "." or "#"
    end
    rows[#rows + 1] = table.concat(chars)
  end
  return rows
end

-- L-shaped corridor between two cells (only used when the noise walled
-- spawn and exit apart at this seed).
local function corridorBetween(a, b)
  local cells = {}
  local step = a.c <= b.c and 1 or -1
  for c = a.c, b.c, step do cells[#cells + 1] = { c = c, r = a.r } end
  step = a.r <= b.r and 1 or -1
  for r = a.r, b.r, step do cells[#cells + 1] = { c = b.c, r = r } end
  return cells
end

local function provePath(ctx)
  local player = ctx.scene.find("Player")
  local gate = ctx.scene.find("Exit Gate")
  return ctx.scene.findPath(player.transform.position, gate.transform.position)
end

local function announce(ctx, path)
  local hud = ctx.scene.find("Warrens HUD").getComponent("Text")
  if path then
    ctx.events.emit("warrens-connected", { waypoints = #path })
    hud.content = string.format("Exit path: %d steps", #path)
    ctx.log(string.format("warrens carved (seed %d): exit reachable in %d steps", ctx.vars.seed, #path))
  else
    hud.content = "Exit path: blocked!"
    ctx.log("warrens carved but the exit is unreachable - corridor fallback failed")
  end
end

function script.onStart(ctx)
  local player = ctx.scene.find("Player")
  local gate = ctx.scene.find("Exit Gate")
  local spawn = cellOf(player.transform.position)
  local exitCell = cellOf(gate.transform.position)
  local seed = noise.seedFrom(ctx.random)
  ctx.vars.seed = seed

  local tilemap = ctx.getComponent("Tilemap")
  tilemap.grid = buildRows(seed, { spawn, exitCell }, {})
  ctx.events.emit("warrens-carved", { seed = seed })

  local path = provePath(ctx)
  if path then
    announce(ctx, path)
  else
    -- Walled apart at this seed: cut the corridor now (a fresh array again)
    -- and re-prove on the NEXT frame. findPath's nav grid rebuilds at most
    -- once per frame (and onStart shares a frame with the first onUpdate),
    -- so re-asking on the carve frame would still see pre-corridor walls.
    tilemap.grid = buildRows(seed, { spawn, exitCell }, corridorBetween(spawn, exitCell))
    ctx.vars.carveFrame = ctx.time.frame
    ctx.vars.reprove = true
  end
end

function script.onUpdate(ctx, dt)
  if not ctx.vars.reprove or ctx.time.frame <= ctx.vars.carveFrame then return end
  ctx.vars.reprove = false
  announce(ctx, provePath(ctx))
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'crystal-grower',
    language: 'lua',
    source: `-- Grows glow crystals once the warrens exist. Listens for the carver's
-- "warrens-carved" event, re-derives the SAME cave field from the shared
-- lib/noise module using the seed in the payload (derive-from-seed instead
-- of reading the grid back), and plants a crystal wherever a second noise
-- field peaks inside an open tunnel cell. Same library, second consumer —
-- the code reuse script modules exist for.
local noise = require("lib/noise")

local script = {}

local TILE = 32
local COLS = 25
local ROWS = 19
local MAX_CRYSTALS = 12
local PEAK = 0.72

function script.onEvent(ctx, name, data)
  if name ~= "warrens-carved" or ctx.vars.grown then return end
  ctx.vars.grown = true
  local seed = data.seed
  local count = 0
  for r = 1, ROWS - 2 do
    for c = 1, COLS - 2 do
      if count < MAX_CRYSTALS
        and noise.caveOpen(c, r, seed)
        and noise.value2(c * 0.9, r * 0.9, seed + 777) > PEAK then
        count = count + 1
        ctx.scene.spawn({
          name = "Crystal " .. count,
          position = { x = c * TILE + TILE / 2, y = r * TILE + TILE / 2 },
          tags = { "crystal" },
          components = {
            SpriteRenderer = { shape = "triangle", color = "#7ee8fa", width = 16, height = 20, layer = 5 },
            Light2D = { radius = 70, color = "#7ee8fa", intensity = 0.9 },
          },
        })
      end
    end
  end
  ctx.scene.find("Crystal HUD").getComponent("Text").content = string.format("Crystals: %d", count)
  ctx.events.emit("crystals-grown", { count = count })
  ctx.log(string.format("crystals grown: %d", count))
end

return script
`,
  });

  await run(session, 'createScript', {
    name: 'player-move',
    language: 'lua',
    source: `-- Player: four-direction movement through the warrens (no gravity).
-- The solid Tilemap the carver generates is what stops the miner.
local script = {}

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")
  local speed = ctx.params.speed or 150
  local vx, vy = 0, 0
  if ctx.input.isDown("left") then vx = vx - speed end
  if ctx.input.isDown("right") then vx = vx + speed end
  if ctx.input.isDown("up") then vy = vy - speed end
  if ctx.input.isDown("down") then vy = vy + speed end
  body.velocity.x = vx
  body.velocity.y = vy
end

return script
`,
  });

  // --- entities ---
  await run(session, 'createEntity', {
    scene, name: 'Main Camera', position: { x: 400, y: 304 },
    components: { Camera: { backgroundColor: '#0d0b14', ambientLight: 0.45 } },
  });

  // Caverns: authored FULLY SOLID on purpose — the carver's whole-array
  // grid replacement is the only thing that opens it up, so a broken
  // require/carve renders as an unmissable wall slab and fails findPath.
  const solidRows = Array.from({ length: ROWS }, () => '#'.repeat(COLS));
  await run(session, 'createEntity', {
    scene, name: 'Caverns', tags: ['wall'], position: { x: 0, y: 0 },
    components: {
      Tilemap: { tileSize: TILE, tileAssets: { '#': rockTile.id }, grid: solidRows, solid: true },
    },
  });
  await run(session, 'attachScript', { scene, entity: 'Caverns', script: 'scripts/cave-carver.lua' });

  const spawnPos = cellCenter(SPAWN_CELL);
  await run(session, 'createEntity', {
    scene, name: 'Player', tags: ['player'], position: spawnPos,
    components: {
      SpriteRenderer: { assetId: miner.id, width: 24, height: 30 },
      Collider: { shape: 'box', width: 22, height: 26 },
      PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
      Light2D: { radius: 110, color: '#cfe8ff', intensity: 0.7 },
    },
  });
  await run(session, 'attachScript', {
    scene, entity: 'Player', script: 'scripts/player-move.lua', params: { speed: 150 },
  });

  await run(session, 'createEntity', {
    scene, name: 'Exit Gate', tags: ['exit'], position: cellCenter(EXIT_CELL),
    components: {
      SpriteRenderer: { shape: 'rectangle', color: '#ffb347', width: 22, height: 26, layer: 5 },
      Light2D: { radius: 90, color: '#ffcf6b', intensity: 1.0 },
    },
  });

  // Crystal Mother: the invisible manager the grower behavior runs on.
  await run(session, 'createEntity', { scene, name: 'Crystal Mother', tags: ['manager'], position: { x: 0, y: 0 } });
  await run(session, 'attachScript', { scene, entity: 'Crystal Mother', script: 'scripts/crystal-grower.lua' });

  await run(session, 'createEntity', {
    scene, name: 'Warrens HUD', tags: ['ui'],
    components: {
      UIElement: { anchor: 'top-left', offset: { x: 24, y: 28 } },
      Text: { content: 'Exit path: ?', fontSize: 18, color: '#ffffff' },
    },
  });
  await run(session, 'createEntity', {
    scene, name: 'Crystal HUD', tags: ['ui'],
    components: {
      UIElement: { anchor: 'top-right', offset: { x: -24, y: 28 } },
      Text: { content: 'Crystals: 0', fontSize: 18, color: '#7ee8fa', align: 'right' },
    },
  });

  // --- playtests ---
  // Every expected value below is read back from an actual probe run of
  // this exact scene (GameSession.stepAsync — the same engine path
  // runPlaytest uses), never hand-computed.

  // Probe 1: the carve at seed 0 — connectivity, HUD copy, crystal count.
  const CARVE_FRAMES = 10;
  let probe = await GameSession.create(session.store, { scene, seed: 0 });
  for (let i = 0; i < CARVE_FRAMES; i++) await probe.stepAsync();
  const carvedGrid = probe.runtime.find('Caverns').components.Tilemap.grid;
  const openCells = carvedGrid.join('').split('').filter((ch) => ch === '.').length;
  // Threshold-drift fence: the authored grid has zero open cells, a healthy
  // carve opens a meaningful fraction of the 23x17 interior without turning
  // it into an empty box.
  if (openCells < 80 || openCells > 340) {
    throw new Error(`crystal-warrens: carve opened ${openCells} cells at seed 0 — retune noise.caveOpen's threshold`);
  }
  if ((probe.eventCounts.get('warrens-connected') ?? 0) !== 1) {
    throw new Error('crystal-warrens: the carver never proved spawn→exit connectivity at seed 0');
  }
  const expectedWarrensHud = probe.runtime.find('Warrens HUD').components.Text.content;
  const expectedCrystalHud = probe.runtime.find('Crystal HUD').components.Text.content;
  const crystalCount = probe.runtime.getEntities().filter((e) => e.tags.includes('crystal')).length;
  if (crystalCount < 1 || expectedCrystalHud !== `Crystals: ${crystalCount}`) {
    throw new Error(`crystal-warrens: expected grown crystals with a matching HUD (got ${crystalCount}, "${expectedCrystalHud}")`);
  }
  if (probe.errors.length > 0) {
    throw new Error('crystal-warrens: carve probe recorded errors: ' + JSON.stringify(probe.errors));
  }
  probe.destroy();

  // Probe 2: seed sensitivity — a different session seed must carve a
  // different map (this is what makes the export boot proof in
  // tests/export-web-boot.test.ts causal: a dead require would render the
  // authored wall slab identically at every seed).
  probe = await GameSession.create(session.store, { scene, seed: 7 });
  for (let i = 0; i < CARVE_FRAMES; i++) await probe.stepAsync();
  const gridSeed7 = probe.runtime.find('Caverns').components.Tilemap.grid;
  if (gridSeed7.join('\n') === carvedGrid.join('\n')) {
    throw new Error('crystal-warrens: seeds 0 and 7 carved identical maps — ctx.random is not reaching the carve');
  }
  probe.destroy();

  // Probe 3: movement — walk right out of the spawn clearing and read back
  // where the carved tunnels actually let the miner stop.
  const MOVE_FRAMES = 30;
  probe = await GameSession.create(session.store, { scene, seed: 0 });
  probe.runtime.input.setActionDown('right');
  for (let i = 0; i < MOVE_FRAMES; i++) await probe.stepAsync();
  probe.runtime.input.setActionUp('right');
  const movedPlayer = probe.runtime.find('Player').transform.position;
  const expectedPlayerX = movedPlayer.x;
  const expectedPlayerY = movedPlayer.y;
  if (expectedPlayerX - spawnPos.x < 20) {
    throw new Error(`crystal-warrens: movement probe barely moved (x ${spawnPos.x} → ${expectedPlayerX}) — spawn clearing blocked?`);
  }
  probe.destroy();

  await run(session, 'createPlaytest', {
    name: 'warrens-carved-and-connected',
    scene,
    steps: [
      { type: 'wait', frames: CARVE_FRAMES },
      { type: 'assertEventCount', event: 'warrens-carved', equals: 1 },
      { type: 'assertEventCount', event: 'warrens-connected', equals: 1 },
      { type: 'assertEventCount', event: 'crystals-grown', equals: 1 },
      { type: 'assertProperty', entity: 'Warrens HUD', property: 'Text.content', equals: expectedWarrensHud },
      { type: 'assertProperty', entity: 'Crystal HUD', property: 'Text.content', equals: expectedCrystalHud },
      { type: 'assertEntityExists', entity: 'Crystal 1', exists: true },
      { type: 'assertEntityExists', entity: `Crystal ${crystalCount}`, exists: true },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 100,
  });
  await run(session, 'createPlaytest', {
    name: 'movement',
    scene,
    steps: [
      { type: 'press', action: 'right', frames: MOVE_FRAMES },
      { type: 'assertPositionNear', entity: 'Player', x: expectedPlayerX, y: expectedPlayerY, tolerance: 3 },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 100,
  });
  await run(session, 'createPlaytest', {
    name: 'smoke',
    scene,
    steps: [
      { type: 'wait', frames: 60 },
      { type: 'assertEntityExists', entity: 'Player', exists: true },
      { type: 'assertEntityExists', entity: 'Caverns', exists: true },
      { type: 'assertEntityExists', entity: 'Exit Gate', exists: true },
      { type: 'assertEntityExists', entity: 'Crystal Mother', exists: true },
      { type: 'assertEntityExists', entity: 'Warrens HUD', exists: true },
      { type: 'assertEntityExists', entity: 'Crystal HUD', exists: true },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 200,
  });

  const report = await run(session, 'validateProject', {});
  if (report.errors.length > 0) throw new Error('crystal-warrens validation failed: ' + JSON.stringify(report.errors));
  console.log('✓ crystal-warrens generated');
}

// ---------------------------------------------------------------------------
await generatePlatformer();
await generateTopDown();
await generateVisualNovel();
await generateEmberTrail();
await generateGlowCaves();
await generateBouncePatrol();
await generateSkyCourier();
await generateDriftCellar();
await generateEmberHorde();
await generateEmberArcade();
await generateCrystalWarrens();
console.log('All example projects generated.');
