/**
 * GOLDEN DETERMINISM — the safety net for Wave E's perf work (Tasks 9-11).
 *
 * These hashes were recorded against unmodified (pre-Task-9) runtime.ts by
 * running this file once and copying stateHash's output into EXPECTED
 * below. From here on they must stay byte-identical: Task 9's
 * getEntities()/tilemap caches, and Tasks 10-11's broadphase/pooling work,
 * are only allowed to change *how fast* these scenes run, never *what they
 * compute*. If one of these hashes changes, the fix is to the perf change,
 * not to this file — never update EXPECTED to make a diverging run pass
 * unless the task deliberately changes observable behavior (and says so).
 *
 * Three scenes, chosen to cover the surfaces the caches touch:
 *  - 'tilemap-arena' (reused from packages/runtime/bench/scenarios.mjs):
 *    200 box/circle movers over a 100x60 solid tilemap — mover-vs-tilemap,
 *    mover-vs-mover, box+circle colliders.
 *  - 'mixed-horde' (reused from bench scenarios.mjs): 800 scripted movers
 *    across 3 collision layers — mover-vs-mover at scale, onCollision
 *    scripts, ctx.events.emit.
 *  - 'FeatureMix' (built below): a one-way platform, a trigger zone, a
 *    polygon-vs-polygon landing, a particle emitter, and a script that
 *    spawns an entity in onStart and destroys it a few frames later —
 *    every remaining feature the bench scenarios don't already cover.
 */
import { describe, expect, it } from 'vitest';
import {
  MemoryFileSystem,
  ProjectStore,
  SceneSchema,
  createComponent,
  createProject,
  generateId,
  type ProjectStore as ProjectStoreType,
} from '@hearth/core';
import { SCENARIOS } from '../bench/scenarios.mjs';
import { runHash } from './determinism.js';

/** Fixed across every golden run — changing it would change every hash. */
const SEED = 424242;
const FRAMES = 40;

function baseEntity(name: string, components: Record<string, unknown>) {
  return {
    id: generateId('ent'),
    name,
    parentId: null,
    enabled: true,
    tags: [],
    components,
  };
}

const SLAB_POINTS = [
  { x: -100, y: -10 },
  { x: 100, y: -10 },
  { x: 100, y: 10 },
  { x: -100, y: 10 },
];
const SQUARE_16 = [
  { x: -16, y: -16 },
  { x: 16, y: -16 },
  { x: 16, y: 16 },
  { x: -16, y: 16 },
];

const SPAWNER_SCRIPT = `export default {
  onStart(ctx) {
    ctx.scene.spawn({
      name: 'Spawned',
      position: { x: 2000, y: 0 },
      tags: ['spawned'],
    });
    ctx.events.emit('spawned');
  },
  onUpdate(ctx) {
    if (ctx.time.frame === 10) {
      const target = ctx.scene.find('Spawned');
      if (target) {
        ctx.scene.destroy(target);
        ctx.events.emit('despawned');
      }
    }
  },
};
`;

const HIT_SCRIPT = `export default {
  onCollision(ctx) {
    ctx.vars.hits = (ctx.vars.hits || 0) + 1;
    ctx.events.emit('hit');
  },
};
`;

/**
 * A single-scene, hand-authored scenario exercising every feature the two
 * reused bench scenarios don't: a one-way platform, a trigger zone, a
 * polygon-vs-polygon landing, a particle emitter, and mid-run spawn/destroy.
 * Every sub-scenario sits far apart on the x-axis (>= 300px clearance
 * against the largest collider involved) so they never spuriously interact
 * — layer filtering is intentionally NOT relied on here.
 */
async function buildFeatureMixStore(): Promise<ProjectStoreType> {
  const fs = new MemoryFileSystem();
  const { store } = await createProject(fs, '/proj', { name: 'FeatureMix', starterScene: false });
  const sceneId = generateId('scn');
  store.project.scenes.push({ id: sceneId, name: 'FeatureMix', path: `scenes/${sceneId}.scene.json` });
  store.project.initialScene = sceneId;

  const entities = [
    // One-way platform: Faller lands on top, falling straight down.
    baseEntity('Platform', {
      Transform: createComponent('Transform', { position: { x: 0, y: 100 } }),
      Collider: createComponent('Collider', { shape: 'box', width: 64, height: 16, oneWay: true }),
      PhysicsBody: createComponent('PhysicsBody', { bodyType: 'static' }),
    }),
    baseEntity('Faller', {
      Transform: createComponent('Transform', { position: { x: 0, y: 0 } }),
      Collider: createComponent('Collider', { shape: 'box', width: 32, height: 32 }),
      PhysicsBody: createComponent('PhysicsBody', { bodyType: 'dynamic' }),
    }),

    // Trigger zone: Wanderer sweeps through it horizontally (gravityScale 0
    // keeps the pass purely horizontal and easy to reason about).
    baseEntity('TriggerZone', {
      Transform: createComponent('Transform', { position: { x: 500, y: 0 } }),
      Collider: createComponent('Collider', { shape: 'box', width: 40, height: 200, isTrigger: true }),
      PhysicsBody: createComponent('PhysicsBody', { bodyType: 'static' }),
    }),
    baseEntity('Wanderer', {
      Transform: createComponent('Transform', { position: { x: 440, y: 0 } }),
      Collider: createComponent('Collider', { shape: 'circle', radius: 10 }),
      PhysicsBody: createComponent('PhysicsBody', {
        bodyType: 'kinematic',
        velocity: { x: 30, y: 0 },
      }),
    }),

    // Polygon vs polygon: a dynamic square lands on a static slab.
    baseEntity('PolySlab', {
      Transform: createComponent('Transform', { position: { x: 1000, y: 100 } }),
      Collider: createComponent('Collider', { shape: 'polygon', points: SLAB_POINTS }),
      PhysicsBody: createComponent('PhysicsBody', { bodyType: 'static' }),
    }),
    baseEntity('PolyBox', {
      Transform: createComponent('Transform', { position: { x: 1000, y: 0 } }),
      Collider: createComponent('Collider', { shape: 'polygon', points: SQUARE_16 }),
      PhysicsBody: createComponent('PhysicsBody', { bodyType: 'dynamic' }),
    }),

    // Mover vs mover: box and circle approach and collide head-on, no
    // gravity, so the whole run stays a clean horizontal collision.
    baseEntity('MoverBox', {
      Transform: createComponent('Transform', { position: { x: 1500, y: 0 } }),
      Collider: createComponent('Collider', { shape: 'box', width: 20, height: 20 }),
      PhysicsBody: createComponent('PhysicsBody', {
        bodyType: 'dynamic',
        gravityScale: 0,
        velocity: { x: 60, y: 0 },
        restitution: 0.5,
      }),
      Script: createComponent('Script', { scriptPath: 'scripts/hit.js' }),
    }),
    baseEntity('MoverCircle', {
      Transform: createComponent('Transform', { position: { x: 1600, y: 0 } }),
      Collider: createComponent('Collider', { shape: 'circle', radius: 10 }),
      PhysicsBody: createComponent('PhysicsBody', {
        bodyType: 'dynamic',
        gravityScale: 0,
        velocity: { x: -60, y: 0 },
        restitution: 0.5,
      }),
    }),

    // A solid tilemap floor a mover settles onto.
    baseEntity('Floor', {
      Transform: createComponent('Transform', { position: { x: 2000, y: 400 } }),
      Tilemap: createComponent('Tilemap', {
        tileSize: 32,
        tileAssets: {},
        grid: ['##########', '#........#', '#........#', '#..##....#', '#........#', '##########'],
        solid: true,
      }),
    }),
    baseEntity('TilemapFaller', {
      Transform: createComponent('Transform', { position: { x: 2144, y: 300 } }),
      Collider: createComponent('Collider', { shape: 'box', width: 20, height: 20 }),
      PhysicsBody: createComponent('PhysicsBody', { bodyType: 'dynamic' }),
    }),

    // A steadily-emitting particle source.
    baseEntity('Emitter', {
      Transform: createComponent('Transform', { position: { x: 2500, y: 0 } }),
      ParticleEmitter: createComponent('ParticleEmitter', {
        emitting: true,
        rate: 30,
        burst: 5,
        lifetime: 0.5,
        seed: 7,
      }),
    }),

    // Spawns an entity in onStart, destroys it on frame 10 — pins current
    // spawn/destroy mid-run semantics into the golden hash.
    baseEntity('Spawner', {
      Transform: createComponent('Transform', { position: { x: 3000, y: 0 } }),
      Script: createComponent('Script', { scriptPath: 'scripts/spawner.js' }),
    }),
  ];

  const scene = SceneSchema.parse({
    formatVersion: 1,
    id: sceneId,
    name: 'FeatureMix',
    entities,
  });
  store.scenes.set(scene.id, scene);
  await fs.writeFile('/proj/scripts/spawner.js', SPAWNER_SCRIPT);
  await fs.writeFile('/proj/scripts/hit.js', HIT_SCRIPT);
  await store.save();
  return ProjectStore.load(fs, '/proj');
}

/** Recorded once against unmodified (pre-Task-9) code — see file header. */
const EXPECTED: Record<string, string> = {
  'tilemap-arena': 'f4ebf2c7f8495c17c464989df6a7abb46f2839d90e806233d76806eb36039abd',
  'mixed-horde': '3cc4f792945b6d559fac4da3bdd1dc198b76b598a7cff17380be710be98a5c3b',
  FeatureMix: '3748b50fb9f68a3e5d2536cbc6e86ffa040216418d9d12088ea92c6ec52354c2',
};

describe('golden determinism', () => {
  it('tilemap-arena scenario hash is unchanged', async () => {
    const scenario = SCENARIOS.find((s) => s.name === 'tilemap-arena')!;
    const store = await scenario.build();
    const hash = await runHash(store, 'Bench', FRAMES, SEED);
    expect(hash).toBe(EXPECTED['tilemap-arena']);
  });

  it('mixed-horde scenario hash is unchanged', async () => {
    const scenario = SCENARIOS.find((s) => s.name === 'mixed-horde')!;
    const store = await scenario.build();
    const hash = await runHash(store, 'Bench', FRAMES, SEED);
    expect(hash).toBe(EXPECTED['mixed-horde']);
  });

  it('FeatureMix scenario hash is unchanged', async () => {
    const store = await buildFeatureMixStore();
    const hash = await runHash(store, 'FeatureMix', FRAMES, SEED);
    expect(hash).toBe(EXPECTED.FeatureMix);
  });
});
