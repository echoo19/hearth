#!/usr/bin/env node
/**
 * Regenerates the Hearth example projects using the core command system —
 * the same operations agents use. Run from repo root after building core:
 *
 *   npm run build -w @hearth/core && node packages/examples/generate.mjs
 *
 * The generated projects are committed to the repo so they work out of the
 * box; re-running this script recreates them from scratch (ids change).
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject, HearthSession } from '../core/dist/index.js';
import { NodeFileSystem } from '../core/dist/node/index.js';
import { GameSession } from '../runtime/dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fs = new NodeFileSystem();

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
  const SHOWCASE_FRAMES = 90;
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
await generatePlatformer();
await generateTopDown();
await generateVisualNovel();
await generateEmberTrail();
await generateGlowCaves();
console.log('All example projects generated.');
