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
    description: 'Jump between platforms, collect coins, avoid the patrolling enemy.',
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

  // --- scripts ---
  await run(session, 'createScript', {
    name: 'player-controller',
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
    source: `/**
 * Coin: when the player touches it, bump the Score text and disappear.
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
    ctx.log('coin collected');
    ctx.destroySelf();
  },
};
`,
  });

  await run(session, 'createScript', {
    name: 'enemy-patrol',
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
    ctx.log('player hit by enemy');
  },
};
`,
  });

  await run(session, 'createScript', {
    name: 'camera-follow',
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

  await run(session, 'createEntity', {
    scene, name: 'Score', tags: ['ui'], position: { x: 24, y: 24 },
    components: { Text: { content: 'Score: 0', fontSize: 20, color: '#ffffff' } },
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
  await run(session, 'createPlaytest', {
    name: 'smoke',
    scene,
    steps: [
      { type: 'wait', frames: 120 },
      { type: 'assertEntityExists', entity: 'Player', exists: true },
      { type: 'assertEntityExists', entity: 'Score', exists: true },
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
await generatePlatformer();
await generateTopDown();
await generateVisualNovel();
console.log('All example projects generated.');
