#!/usr/bin/env node
/**
 * Regenerates the Hearth genre starter templates using the core command
 * system — the same operations agents and the editor use. Run from repo root
 * after building core:
 *
 *   npm run build -w @hearth/core && node packages/templates/generate.mjs
 *
 * The generated templates are committed to the repo so `hearth init` works out
 * of the box; re-running this script recreates them from scratch. Ids are
 * seeded (setIdRandomSource below), the pixel-art tile sheets are byte-for-byte
 * deterministic (packages/examples/pixelart.mjs), and there are no timestamps,
 * so regeneration is byte-identical run to run — running this twice leaves
 * `git status --porcelain` empty.
 *
 * Templates are deliberately SMALL, playable skeletons that teach one genre's
 * core pattern (a scene, a camera, a player with a comment-annotated Lua
 * movement script, a few obstacles, and a `smoke` playtest) — not demo games.
 * The richer, feature-complete showcases live in packages/examples.
 */
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createProject,
  HearthSession,
  setIdRandomSource,
  createSeededRng,
  AUTOTILE_SHAPES,
} from '../core/dist/index.js';
import { NodeFileSystem } from '../core/dist/node/index.js';
import { encodePng, makeBlob47CaveSheetRgba } from '../examples/pixelart.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fs = new NodeFileSystem();

// Descriptions here MUST match packages/templates/src/index.ts's TEMPLATES,
// so the picker and the scaffolded project's hearth.json always agree.
const DESCRIPTIONS = {
  platformer: 'A side-scrolling platformer skeleton: gravity, jump, and an autotiled ground strip.',
  topdown: 'A top-down movement skeleton: four-direction walking, camera follow, and an autotiled room.',
  arcade: 'A fixed-camera arcade skeleton: a ship, shoot-on-key bullets, and a spawned target prefab.',
};

// Seed id generation so regenerating produces byte-identical output every time
// (see packages/core/src/ids.ts). Generator/test-only — does not touch the
// runtime's seeded ctx.random stream.
setIdRandomSource(createSeededRng(9));

/** Execute a command and fail loudly if it doesn't succeed. */
async function run(session, name, params) {
  const result = await session.execute(name, params);
  if (!result.success) {
    throw new Error(`${name} failed: ${result.errors.map((e) => e.message).join('; ')}`);
  }
  return result.data;
}

async function freshProject(dirName, options) {
  const root = path.join(here, 'templates', dirName);
  await rm(root, { recursive: true, force: true });
  const { store } = await createProject(fs, root, { ...options, starterScene: false });
  return HearthSession.fromStore(store, {
    granted: ['read-only', 'safe-edit', 'code-edit', 'asset-edit', 'build'],
  });
}

/**
 * Import a generated blob47 autotile sheet (pixelart.mjs) as a sprite asset.
 * The sheet has one frame per canonical blob47 shape, named `blob_<shapeKey>`,
 * which is exactly what setTileAutotile expects — so binding a tilemap char to
 * this sheet lets every filled cell pick its frame from its 8-neighbour mask at
 * render time, with no per-tile art. Deterministic: identical bytes every run.
 */
async function importAutotileSheet(session, assetName, tmpFileName) {
  const sheet = makeBlob47CaveSheetRgba(AUTOTILE_SHAPES);
  const tmpPath = path.join(os.tmpdir(), tmpFileName);
  await writeFile(tmpPath, encodePng(sheet.width, sheet.height, sheet.rgba));
  const asset = (await run(session, 'importAsset', { sourcePath: tmpPath, name: assetName, type: 'sprite' })).asset;
  await run(session, 'setAssetMetadata', { asset: asset.id, metadata: { frames: sheet.frames } });
  return asset;
}

// ---------------------------------------------------------------------------
// Template 1: Platformer — gravity, jump, autotiled ground strip
// ---------------------------------------------------------------------------
async function generatePlatformer() {
  const session = await freshProject('platformer', {
    name: 'Platformer Starter',
    description: DESCRIPTIONS.platformer,
  });

  const scene = (await run(session, 'createScene', { name: 'Level', withCamera: false })).sceneId;

  const playerAsset = (await run(session, 'createSpriteAsset', {
    name: 'player', shape: 'character', color: '#4aa3ff', width: 24, height: 32,
  })).asset;
  const groundSheet = await importAutotileSheet(session, 'ground-tiles', 'ground-tiles.png');

  // The one script a newcomer edits first: ~30 annotated lines of movement.
  await run(session, 'createScript', {
    name: 'player-controller',
    language: 'lua',
    source: `-- Platformer player controller.
--
-- Reads the "left"/"right"/"jump" input actions each frame and drives a
-- dynamic PhysicsBody: horizontal velocity follows the arrow keys, and a
-- jump impulse fires only while grounded. Falling off the bottom of the
-- world respawns the player at its start position. Tune the numbers from
-- the attachScript params (speed, jumpSpeed) — no code change needed.
--
-- ctx calls use DOT syntax: ctx.log("hi"), never ctx:log("hi").
local script = {}

function script.onStart(ctx)
  -- Remember the spawn point so a fall can send us back to it.
  ctx.vars.spawnX = ctx.transform.position.x
  ctx.vars.spawnY = ctx.transform.position.y
  ctx.camera.follow("Player")
end

function script.onUpdate(ctx, dt)
  -- dt is the fixed timestep in seconds; unused here because we set
  -- velocity directly and let the physics step integrate position.
  local body = ctx.getComponent("PhysicsBody")
  local speed = ctx.params.speed or 220

  -- Horizontal movement: set velocity.x directly; gravity handles y.
  local vx = 0
  if ctx.input.isDown("left") then vx = vx - speed end
  if ctx.input.isDown("right") then vx = vx + speed end
  body.velocity.x = vx

  -- Jump: only when standing on solid ground (ctx.isGrounded).
  if ctx.input.justPressed("jump") and ctx.isGrounded() then
    body.velocity.y = -(ctx.params.jumpSpeed or 460)
  end

  -- Fell off the world: respawn at the start.
  if ctx.transform.position.y > 900 then
    ctx.transform.position.x = ctx.vars.spawnX
    ctx.transform.position.y = ctx.vars.spawnY
    body.velocity.x = 0
    body.velocity.y = 0
  end
end

return script
`,
  });

  await run(session, 'createEntity', {
    scene, name: 'Main Camera', position: { x: 400, y: 300 },
    components: { Camera: { backgroundColor: '#12141c' } },
  });

  // Ground: a solid, autotiled strip along the bottom. Two rows of 16px tiles,
  // full build-width, so the player always has floor under it.
  const groundRows = ['G'.repeat(50), 'G'.repeat(50)];
  await run(session, 'createEntity', {
    scene, name: 'Ground', tags: ['ground'], position: { x: 0, y: 560 },
    components: {
      Tilemap: { tileSize: 16, tileAssets: { G: groundSheet.id }, grid: groundRows, solid: true },
    },
  });
  await run(session, 'setTileAutotile', { scene, entity: 'Ground', char: 'G', sheet: groundSheet.id });

  await run(session, 'createEntity', {
    scene, name: 'Player', tags: ['player'], position: { x: 120, y: 400 },
    components: {
      SpriteRenderer: { assetId: playerAsset.id, width: 24, height: 32 },
      Collider: { shape: 'box', width: 22, height: 30 },
      PhysicsBody: { bodyType: 'dynamic' },
    },
  });
  await run(session, 'attachScript', {
    scene, entity: 'Player', script: 'scripts/player-controller.lua', params: { speed: 220, jumpSpeed: 460 },
  });

  // A couple of static platforms to jump between.
  const platforms = [
    { name: 'Platform A', x: 360, y: 450, w: 120 },
    { name: 'Platform B', x: 560, y: 350, w: 120 },
  ];
  for (const p of platforms) {
    await run(session, 'createEntity', {
      scene, name: p.name, tags: ['ground'], position: { x: p.x, y: p.y },
      components: {
        SpriteRenderer: { shape: 'rectangle', color: '#6b5b4a', width: p.w, height: 18 },
        Collider: { shape: 'box', width: p.w, height: 18 },
        PhysicsBody: { bodyType: 'static' },
      },
    });
  }

  // The one required playtest: the player moves right under injected input.
  await run(session, 'createPlaytest', {
    name: 'smoke',
    scene,
    steps: [
      { type: 'wait', frames: 30 },
      { type: 'press', action: 'right', frames: 45 },
      { type: 'assertProperty', entity: 'Player', property: 'Transform.position.x', greaterThan: 200 },
      { type: 'assertEntityExists', entity: 'Player', exists: true },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 200,
  });

  const report = await run(session, 'validateProject', {});
  if (report.errors.length > 0) throw new Error('platformer validation failed: ' + JSON.stringify(report.errors));
  console.log('✓ platformer generated');
}

// ---------------------------------------------------------------------------
// Template 2: Top-Down — 4-dir movement, camera follow, autotiled room
// ---------------------------------------------------------------------------
async function generateTopDown() {
  const session = await freshProject('topdown', {
    name: 'Top-Down Starter',
    description: DESCRIPTIONS.topdown,
  });

  const scene = (await run(session, 'createScene', { name: 'Room', withCamera: false })).sceneId;

  const playerAsset = (await run(session, 'createSpriteAsset', {
    name: 'hero', shape: 'character', color: '#b06bff', width: 26, height: 30,
  })).asset;
  const wallSheet = await importAutotileSheet(session, 'wall-tiles', 'wall-tiles.png');

  await run(session, 'createScript', {
    name: 'player-controller',
    language: 'lua',
    source: `-- Top-down player controller (no gravity).
--
-- Four-direction walking: velocity follows the arrow keys on both axes,
-- so diagonal input moves diagonally. The camera follows the player so the
-- room scrolls into view. Tune \`speed\` from the attachScript params.
--
-- ctx calls use DOT syntax: ctx.log("hi"), never ctx:log("hi").
local script = {}

function script.onStart(ctx)
  ctx.camera.follow("Player")
end

function script.onUpdate(ctx, dt)
  -- dt is the fixed timestep in seconds; unused here because we set
  -- velocity directly and let the physics step integrate position.
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

  await run(session, 'createEntity', {
    scene, name: 'Main Camera', position: { x: 400, y: 300 },
    components: { Camera: { backgroundColor: '#14100f' } },
  });

  // Room: a solid, autotiled ring of walls with a walkable interior. Every
  // filled 'W' cell picks its frame from its 8-neighbour mask at render time.
  const W = 30;
  const H = 20;
  const wallRow = 'W'.repeat(W);
  const midRow = 'W' + '.'.repeat(W - 2) + 'W';
  const grid = [wallRow];
  for (let i = 0; i < H - 2; i++) grid.push(midRow);
  grid.push(wallRow);
  await run(session, 'createEntity', {
    scene, name: 'Room', tags: ['level'], position: { x: 160, y: 120 },
    components: {
      Tilemap: { tileSize: 16, tileAssets: { W: wallSheet.id }, grid, solid: true },
    },
  });
  await run(session, 'setTileAutotile', { scene, entity: 'Room', char: 'W', sheet: wallSheet.id });

  await run(session, 'createEntity', {
    scene, name: 'Player', tags: ['player'], position: { x: 240, y: 280 },
    components: {
      SpriteRenderer: { assetId: playerAsset.id, width: 26, height: 30 },
      Collider: { shape: 'box', width: 24, height: 28 },
      PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
    },
  });
  await run(session, 'attachScript', {
    scene, entity: 'Player', script: 'scripts/player-controller.lua', params: { speed: 180 },
  });

  // A crate obstacle in the middle of the room to bump into.
  await run(session, 'createEntity', {
    scene, name: 'Crate', tags: ['obstacle'], position: { x: 470, y: 340 },
    components: {
      SpriteRenderer: { shape: 'rectangle', color: '#8a6d4f', width: 40, height: 40 },
      Collider: { shape: 'box', width: 40, height: 40 },
      PhysicsBody: { bodyType: 'static' },
    },
  });

  await run(session, 'createPlaytest', {
    name: 'smoke',
    scene,
    steps: [
      { type: 'wait', frames: 15 },
      { type: 'press', action: 'right', frames: 45 },
      { type: 'assertProperty', entity: 'Player', property: 'Transform.position.x', greaterThan: 300 },
      { type: 'assertEntityExists', entity: 'Player', exists: true },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 200,
  });

  const report = await run(session, 'validateProject', {});
  if (report.errors.length > 0) throw new Error('topdown validation failed: ' + JSON.stringify(report.errors));
  console.log('✓ topdown generated');
}

// ---------------------------------------------------------------------------
// Template 3: Arcade — fixed camera, ship, shoot-on-key, spawned target prefab
// ---------------------------------------------------------------------------
async function generateArcade() {
  const session = await freshProject('arcade', {
    name: 'Arcade Starter',
    description: DESCRIPTIONS.arcade,
  });

  const scene = (await run(session, 'createScene', { name: 'Arcade', withCamera: false })).sceneId;

  const shipAsset = (await run(session, 'createSpriteAsset', {
    name: 'ship', shape: 'triangle', color: '#5ce1e6', width: 34, height: 30,
  })).asset;
  const targetAsset = (await run(session, 'createSpriteAsset', {
    name: 'target', shape: 'circle', color: '#ff6b6b', width: 32, height: 32,
  })).asset;

  // Ship controller: move on all four directions, fire a bullet on key press.
  await run(session, 'createScript', {
    name: 'ship-controller',
    language: 'lua',
    source: `-- Arcade ship controller.
--
-- Moves the ship on all four directions (fixed camera — the ship, not the
-- world, moves). Pressing "jump" fires one bullet straight up: the bullet
-- is spawned at runtime with ctx.scene.spawn and carries its own bullet.lua
-- script, so shooting adds a real, self-contained entity to the scene.
--
-- ctx calls use DOT syntax: ctx.log("hi"), never ctx:log("hi").
local script = {}

function script.onStart(ctx)
  ctx.vars.shots = 0
end

function script.onUpdate(ctx, dt)
  -- dt is the fixed timestep in seconds; unused here because we set
  -- velocity directly and let the physics step integrate position.
  local body = ctx.getComponent("PhysicsBody")
  local speed = ctx.params.speed or 200

  local vx, vy = 0, 0
  if ctx.input.isDown("left") then vx = vx - speed end
  if ctx.input.isDown("right") then vx = vx + speed end
  if ctx.input.isDown("up") then vy = vy - speed end
  if ctx.input.isDown("down") then vy = vy + speed end
  body.velocity.x = vx
  body.velocity.y = vy

  -- Fire on the frame the key goes down (not while held): one bullet each.
  if ctx.input.justPressed("jump") then
    ctx.vars.shots = ctx.vars.shots + 1
    ctx.scene.spawn({
      name = string.format("Bullet %d", ctx.vars.shots),
      position = { x = ctx.transform.position.x, y = ctx.transform.position.y - 22 },
      tags = { "bullet" },
      components = {
        SpriteRenderer = { shape = "rectangle", color = "#ffe08a", width = 6, height = 16 },
        Collider = { shape = "box", width = 6, height = 16 },
        PhysicsBody = { bodyType = "dynamic", gravityScale = 0 },
        Script = { scriptPath = "scripts/bullet.lua", params = { speed = ctx.params.bulletSpeed or 420 } },
      },
    })
  end
end

return script
`,
  });

  // Bullet: flies up, pops a target on contact, and cleans itself up off-screen.
  await run(session, 'createScript', {
    name: 'bullet',
    language: 'lua',
    source: `-- Bullet: set once on spawn to fly straight up. Pops the first target it
-- touches (targets are named "Target ...") and removes itself; also cleans
-- up once it leaves the top of the screen so bullets never pile up.
local script = {}

function script.onStart(ctx)
  ctx.getComponent("PhysicsBody").velocity.y = -(ctx.params.speed or 420)
end

function script.onUpdate(ctx, dt)
  if ctx.transform.position.y < -20 then
    ctx.scene.destroy(ctx.entity.id)
  end
end

function script.onCollision(ctx, other)
  if string.sub(other.name, 1, 6) ~= "Target" then return end
  ctx.scene.destroy(other)
  ctx.scene.destroy(ctx.entity.id)
  ctx.events.emit("target-hit")
end

return script
`,
  });

  // Spawner: instances the "Target" prefab once at scene start. Spawning from a
  // prefab (instead of hand-building the entity here) keeps the target's look
  // and collider defined in one place — edit the prefab, every spawn updates.
  await run(session, 'createScript', {
    name: 'target-spawner',
    language: 'lua',
    source: `-- Spawner: drops one target into the arena at the start of the scene by
-- instancing the "Target" prefab via ctx.scene.spawnPrefab.
local script = {}

function script.onStart(ctx)
  ctx.scene.spawnPrefab("Target", { position = { x = ctx.params.x or 560, y = ctx.params.y or 150 } })
end

return script
`,
  });

  await run(session, 'createEntity', {
    scene, name: 'Main Camera', position: { x: 400, y: 300 },
    components: { Camera: { backgroundColor: '#0c0f1a' } },
  });
  await run(session, 'createEntity', {
    scene, name: 'Backdrop', tags: ['background'], position: { x: 400, y: 300 },
    components: {
      SpriteRenderer: { shape: 'rectangle', color: '#141b2e', width: 800, height: 600, layer: -20 },
    },
  });

  await run(session, 'createEntity', {
    scene, name: 'Ship', tags: ['player'], position: { x: 400, y: 460 },
    components: {
      SpriteRenderer: { assetId: shipAsset.id, width: 34, height: 30 },
      Collider: { shape: 'box', width: 30, height: 26 },
      PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
    },
  });
  await run(session, 'attachScript', {
    scene, entity: 'Ship', script: 'scripts/ship-controller.lua', params: { speed: 200, bulletSpeed: 420 },
  });

  // Target: authored once, then promoted to a reusable prefab. This authored
  // instance is the prefab's source AND the first target in the scene; the
  // Spawner adds a second instance of the same prefab at runtime.
  await run(session, 'createEntity', {
    scene, name: 'Target', tags: ['target'], position: { x: 240, y: 150 },
    components: {
      SpriteRenderer: { assetId: targetAsset.id, width: 32, height: 32 },
      Collider: { shape: 'circle', radius: 16, isTrigger: true },
    },
  });
  // The Target carries no script of its own — bullet.lua (on each Bullet)
  // owns the pop-on-contact logic. Promote it to a reusable prefab.
  await run(session, 'createPrefab', { scene, entity: 'Target', name: 'Target' });

  await run(session, 'createEntity', {
    scene, name: 'Spawner', tags: ['system'], position: { x: 0, y: 0 },
    components: {},
  });
  await run(session, 'attachScript', {
    scene, entity: 'Spawner', script: 'scripts/target-spawner.lua', params: { x: 560, y: 150 },
  });

  await run(session, 'createEntity', {
    scene, name: 'Score HUD', tags: ['ui'],
    components: {
      UIElement: { anchor: 'top-left', offset: { x: 24, y: 20 } },
      Text: { content: 'Arrows to move, Space to shoot', fontSize: 15, color: '#cfe8ff' },
    },
  });

  await run(session, 'createPlaytest', {
    name: 'smoke',
    scene,
    steps: [
      { type: 'wait', frames: 10 },
      { type: 'press', action: 'right', frames: 45 },
      { type: 'assertProperty', entity: 'Ship', property: 'Transform.position.x', greaterThan: 480 },
      { type: 'assertEntityExists', entity: 'Ship', exists: true },
      { type: 'assertNoErrors' },
    ],
    maxFrames: 200,
  });

  const report = await run(session, 'validateProject', {});
  if (report.errors.length > 0) throw new Error('arcade validation failed: ' + JSON.stringify(report.errors));
  console.log('✓ arcade generated');
}

// ---------------------------------------------------------------------------
await generatePlatformer();
await generateTopDown();
await generateArcade();
console.log('All templates generated.');
