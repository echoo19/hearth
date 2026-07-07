/**
 * Benchmark scenario builders — plain ESM, no build step required beyond
 * `@hearth/core`'s compiled `dist` (already produced by `npm run build:packages`).
 *
 * Every scenario builds a fully in-memory Hearth project (MemoryFileSystem,
 * never touches disk) the same way `packages/runtime/tests/helpers.ts` does
 * for unit tests, then hands back a loaded `ProjectStore` ready for
 * `GameSession.create`. Positions/velocities/tilemap layout are all derived
 * from a seeded PRNG (mulberry32) so two runs of the same scenario produce
 * byte-identical physics every frame — required for stable before/after
 * comparisons across Wave E's perf tasks.
 */
import {
  MemoryFileSystem,
  ProjectStore,
  SceneSchema,
  createComponent,
  createProject,
  generateId,
} from '@hearth/core';

/** Deterministic PRNG (mulberry32) — no dependency on Math.random. */
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build an in-memory project with one scene, save it, and reload through ProjectStore. */
async function buildStore(entities, scripts = {}) {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'Bench', starterScene: false });
  const sceneId = generateId('scn');
  store.project.scenes.push({ id: sceneId, name: 'Bench', path: `scenes/${sceneId}.scene.json` });
  store.project.initialScene = sceneId;
  const scene = SceneSchema.parse({
    formatVersion: 1,
    id: sceneId,
    name: 'Bench',
    entities,
  });
  store.scenes.set(scene.id, scene);
  for (const [name, source] of Object.entries(scripts)) {
    await fs.writeFile(`/proj/scripts/${name}`, source);
  }
  await store.save();
  return ProjectStore.load(fs, '/proj');
}

function baseEntity(name, components) {
  return {
    id: generateId('ent'),
    name,
    parentId: null,
    enabled: true,
    tags: [],
    components,
  };
}

/** Static box collider (arena walls, tilemap border is separate). */
function wall(cx, cy, w, h) {
  return baseEntity('Wall', {
    Transform: createComponent('Transform', { position: { x: cx, y: cy } }),
    Collider: createComponent('Collider', { shape: 'box', width: w, height: h }),
    PhysicsBody: createComponent('PhysicsBody', { bodyType: 'static' }),
  });
}

/**
 * A moving box/circle collider bouncing forever: gravityScale 0 (no
 * settling), restitution 0.9 and friction 0 so it keeps its kinetic energy
 * and stays live for the entire timed window instead of coming to rest.
 */
function mover(x, y, vx, vy, shape, size, opts = {}) {
  const collider =
    shape === 'circle'
      ? { shape: 'circle', radius: size ?? 10 }
      : { shape: 'box', width: size ?? 20, height: size ?? 20 };
  collider.layer = opts.layer ?? 'default';
  collider.collidesWith = opts.collidesWith ?? ['*'];
  const components = {
    Transform: createComponent('Transform', { position: { x, y } }),
    Collider: createComponent('Collider', collider),
    PhysicsBody: createComponent('PhysicsBody', {
      bodyType: 'dynamic',
      velocity: { x: vx, y: vy },
      gravityScale: 0,
      restitution: 0.9,
      friction: 0,
    }),
  };
  if (opts.scriptPath) {
    components.Script = createComponent('Script', { scriptPath: opts.scriptPath });
  }
  return baseEntity('Mover', components);
}

/**
 * N movers in a non-overlapping grid (spacing comfortably larger than any
 * collider) inside a four-wall arena, each given a seeded random direction
 * and speed so every entity actually moves and collides every frame.
 */
function buildArenaEntities(count, seed) {
  const rng = mulberry32(seed);
  const spacing = 48;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const margin = 150;
  const wallT = 40;
  const arenaW = cols * spacing + margin * 2;
  const arenaH = rows * spacing + margin * 2;

  const entities = [
    wall(arenaW / 2, -wallT / 2, arenaW + wallT * 2, wallT),
    wall(arenaW / 2, arenaH + wallT / 2, arenaW + wallT * 2, wallT),
    wall(-wallT / 2, arenaH / 2, wallT, arenaH + wallT * 2),
    wall(arenaW + wallT / 2, arenaH / 2, wallT, arenaH + wallT * 2),
  ];

  let n = 0;
  for (let r = 0; r < rows && n < count; r++) {
    for (let c = 0; c < cols && n < count; c++, n++) {
      const x = margin + c * spacing + spacing / 2;
      const y = margin + r * spacing + spacing / 2;
      const speed = 80 + rng() * 80;
      const angle = rng() * Math.PI * 2;
      const shape = n % 2 === 0 ? 'box' : 'circle';
      entities.push(mover(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, shape));
    }
  }
  return entities;
}

/**
 * A 100x60 solid-bordered tilemap with scattered interior solid cells, plus
 * 200 movers seeded onto free interior cells (skipping any cell the scatter
 * pass marked solid) so they bounce off both the tilemap-derived colliders
 * (physics.ts `tilemapBoxes`) and each other.
 */
function buildTilemapArenaEntities(seed) {
  const rng = mulberry32(seed);
  const cols = 100;
  const rows = 60;
  const tileSize = 32;
  const grid = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const border = r === 0 || r === rows - 1 || c === 0 || c === cols - 1;
      line += border ? '#' : rng() < 0.04 ? '#' : '.';
    }
    grid.push(line);
  }

  const tilemapEntity = baseEntity('Tilemap', {
    Transform: createComponent('Transform', { position: { x: 0, y: 0 } }),
    Tilemap: createComponent('Tilemap', { tileSize, tileAssets: {}, grid, solid: true }),
  });
  const entities = [tilemapEntity];

  const freeCells = [];
  for (let r = 2; r < rows - 2; r++) {
    for (let c = 2; c < cols - 2; c++) {
      if (grid[r][c] === '.') freeCells.push({ r, c });
    }
  }
  const wanted = 200;
  const stride = Math.max(1, Math.floor(freeCells.length / wanted));
  let n = 0;
  for (let i = 0; i < freeCells.length && n < wanted; i += stride, n++) {
    const { r, c } = freeCells[i];
    const x = c * tileSize + tileSize / 2;
    const y = r * tileSize + tileSize / 2;
    const speed = 80 + rng() * 80;
    const angle = rng() * Math.PI * 2;
    const shape = n % 2 === 0 ? 'box' : 'circle';
    entities.push(
      mover(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, shape, 16),
    );
  }
  return entities;
}

/** 50 emitters at rate/lifetime tuned to saturate maxParticles quickly, then churn steadily. */
function buildParticleEntities(seed) {
  const rng = mulberry32(seed);
  const entities = [];
  for (let i = 0; i < 50; i++) {
    entities.push(
      baseEntity(`Emitter${i}`, {
        Transform: createComponent('Transform', { position: { x: 100 + (i % 10) * 40, y: 100 + Math.floor(i / 10) * 40 } }),
        ParticleEmitter: createComponent('ParticleEmitter', {
          emitting: true,
          rate: 300,
          lifetime: 1,
          speed: 60 + rng() * 40,
          spread: 45,
          maxParticles: 256,
          seed: (seed * 1000 + i) >>> 0,
        }),
      }),
    );
  }
  return entities;
}

const MOVER_SCRIPT = `export default {
  onCollision(ctx, other) {
    ctx.vars.hits = (ctx.vars.hits || 0) + 1;
    ctx.events.emit('hit');
  },
};
`;

/**
 * 800 movers split across 3 collision layers (a/b/c) with an asymmetric
 * collidesWith filter (a<->b, b<->c, but not a<->c) — a survivors-like
 * "horde" proxy: every mover carries a Script with onCollision so contact
 * events actually fire and get counted, not just resolved silently.
 */
function buildMixedHordeEntities(seed) {
  const rng = mulberry32(seed);
  const count = 800;
  const spacing = 40;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const margin = 150;
  const wallT = 40;
  const arenaW = cols * spacing + margin * 2;
  const arenaH = rows * spacing + margin * 2;

  const entities = [
    wall(arenaW / 2, -wallT / 2, arenaW + wallT * 2, wallT),
    wall(arenaW / 2, arenaH + wallT / 2, arenaW + wallT * 2, wallT),
    wall(-wallT / 2, arenaH / 2, wallT, arenaH + wallT * 2),
    wall(arenaW + wallT / 2, arenaH / 2, wallT, arenaH + wallT * 2),
  ];

  const layers = ['a', 'b', 'c'];
  const collidesWithByLayer = { a: ['a', 'b'], b: ['a', 'b', 'c'], c: ['b', 'c'] };

  let n = 0;
  for (let r = 0; r < rows && n < count; r++) {
    for (let c = 0; c < cols && n < count; c++, n++) {
      const x = margin + c * spacing + spacing / 2;
      const y = margin + r * spacing + spacing / 2;
      const speed = 60 + rng() * 100;
      const angle = rng() * Math.PI * 2;
      const layer = layers[n % 3];
      const shape = n % 2 === 0 ? 'box' : 'circle';
      entities.push(
        mover(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, shape, undefined, {
          layer,
          collidesWith: collidesWithByLayer[layer],
          scriptPath: 'scripts/mover.js',
        }),
      );
    }
  }
  return { entities, scripts: { 'mover.js': MOVER_SCRIPT } };
}

export const SCENARIOS = [
  {
    name: 'colliders-100',
    build: () => buildStore(buildArenaEntities(100, 100)),
  },
  {
    name: 'colliders-500',
    build: () => buildStore(buildArenaEntities(500, 500)),
  },
  {
    name: 'colliders-1500',
    build: () => buildStore(buildArenaEntities(1500, 1500)),
  },
  {
    name: 'tilemap-arena',
    build: () => buildStore(buildTilemapArenaEntities(4200)),
  },
  {
    name: 'particles',
    build: () => buildStore(buildParticleEntities(50)),
  },
  {
    name: 'mixed-horde',
    build: () => {
      const { entities, scripts } = buildMixedHordeEntities(800);
      return buildStore(entities, scripts);
    },
  },
];
