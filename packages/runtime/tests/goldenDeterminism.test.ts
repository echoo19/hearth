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
 * PLATFORM SCOPE: the tilemap-arena / mixed-horde / colliders-1500 bench
 * scenarios seed their movers with Math.cos/Math.sin (scenarios.mjs), and
 * trig is NOT bit-identical across V8/libm builds — an arm64-macOS run and
 * an x64-Linux run differ by a floating-point ULP at spawn, which cascades
 * into a different final hash. Hearth's determinism contract is same-seed
 * SAME-PLATFORM reproducibility (docs/scripting.md → Determinism); it never
 * claimed cross-platform bit-equality. So the guard is expressed in two
 * platform-independent asserts that hold on every OS/arch — (a) the scenario
 * hashes identically when run twice in the same process (catches any
 * nondeterminism the caches/pooling could introduce), and (b) the broadphase
 * run hashes identically to a forced-naive run in the same process (the exact
 * broadphase-vs-naive equivalence Task 10 guaranteed) — plus the original
 * absolute EXPECTED pin, asserted only on the recording platform (arm64
 * macOS) where it was captured. FeatureMix keeps its unconditional absolute
 * pin: its hashed surface is trig-free (integer mover velocities; particle
 * COUNT, not positions, is hashed), so that digest is genuinely portable.
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
import { afterEach, describe, expect, it } from 'vitest';
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
import { broadphaseTestHooks } from '../src/broadphase.js';
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

/**
 * Recorded once against unmodified (pre-Task-9) code — see file header.
 * 'colliders-1500' was added by Task 10 and recorded against post-Task-9 /
 * pre-Task-10 code (Task 9 preserved the pre-Task-9 hashes, so this is the
 * same behavior baseline): it pins the broadphase's highest-density
 * mover-vs-mover scenario.
 */
const EXPECTED: Record<string, string> = {
  'tilemap-arena': 'f4ebf2c7f8495c17c464989df6a7abb46f2839d90e806233d76806eb36039abd',
  'mixed-horde': '3cc4f792945b6d559fac4da3bdd1dc198b76b598a7cff17380be710be98a5c3b',
  FeatureMix: '3748b50fb9f68a3e5d2536cbc6e86ffa040216418d9d12088ea92c6ec52354c2',
  'colliders-1500': '2775e1a7d8d59d55e0e53628800a0ef3b59da2c1b49d58607d696f28bd6baa39',
};

/**
 * The platform on which EXPECTED was recorded (see file header). The absolute
 * hash pin is only meaningful here; everywhere else the two in-process asserts
 * below carry the guard. Trig (Math.cos/sin, used to seed the bench movers)
 * differs by an ULP across V8/libm builds, so a Linux/Windows CI runner would
 * legitimately produce a different — but internally still deterministic —
 * digest.
 */
const IS_RECORDING_PLATFORM = process.platform === 'darwin' && process.arch === 'arm64';

/**
 * Asserts a bench scenario is deterministic in a fully platform-independent
 * way, then (only on the recording platform) that it still matches the
 * captured absolute hash:
 *   1. same-process, run twice → identical (catches nondeterminism).
 *   2. forced-naive path === broadphase path (Task 10's equivalence property).
 *   3. recording platform only: broadphase hash === EXPECTED[name].
 */
async function assertGoldenScenario(name: string): Promise<void> {
  const scenario = SCENARIOS.find((s) => s.name === name)!;
  const store = await scenario.build();

  broadphaseTestHooks.forceNaive = false;
  const broad1 = await runHash(store, 'Bench', FRAMES, SEED);
  const broad2 = await runHash(store, 'Bench', FRAMES, SEED);
  expect(broad2, `${name}: not reproducible across two same-process runs`).toBe(broad1);

  broadphaseTestHooks.forceNaive = true;
  const naive = await runHash(store, 'Bench', FRAMES, SEED);
  broadphaseTestHooks.forceNaive = false;
  expect(naive, `${name}: broadphase diverged from the naive O(n²) sweep`).toBe(broad1);

  if (IS_RECORDING_PLATFORM) {
    expect(broad1, `${name}: hash changed on the recording platform`).toBe(EXPECTED[name]);
  }
}

describe('golden determinism', () => {
  afterEach(() => {
    broadphaseTestHooks.forceNaive = false;
  });

  it('tilemap-arena scenario is deterministic (and matches the golden hash on the recording platform)', async () => {
    await assertGoldenScenario('tilemap-arena');
  });

  it('mixed-horde scenario is deterministic (and matches the golden hash on the recording platform)', async () => {
    await assertGoldenScenario('mixed-horde');
  });

  it('colliders-1500 scenario is deterministic (and matches the golden hash on the recording platform)', { timeout: 120_000 }, async () => {
    await assertGoldenScenario('colliders-1500');
  });

  it('FeatureMix scenario hash is unchanged', async () => {
    const store = await buildFeatureMixStore();
    const hash = await runHash(store, 'FeatureMix', FRAMES, SEED);
    expect(hash).toBe(EXPECTED.FeatureMix);
  });
});
