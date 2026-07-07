/**
 * Task 10 — spatial-hash broadphase, order-preserving and bit-identical.
 *
 * Two layers of proof:
 *  1. Unit tests for SpatialHash / chooseCellSize / shapeAabb, including a
 *     naive AABB-overlap mirror (`naiveOverlapPairs`) asserting the hash is
 *     a conservative superset that preserves ascending index order.
 *  2. Property tests: 200 seeded random scenes (box/circle/polygon movers
 *     and obstacles, one-way platforms, triggers, tilemaps, deep-overlap
 *     stacks, layer filters) run twice through the full runtime — once with
 *     the broadphase forced off (the naive O(n²) loops, i.e. pre-Task-10
 *     behavior) and once with it on — and the full-run stateHash must be
 *     byte-identical. Trigger-only contacts are made observable through an
 *     onCollision script that bumps eventCounts (hashed), so over-pruning
 *     a trigger pair cannot hide.
 *
 * Seeds are fixed (derived from the scene index); no Math.random anywhere.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  SpatialHash,
  broadphaseTestHooks,
  chooseCellSize,
  shapeAabb,
  type Aabb,
} from '../src/broadphase.js';
import { colliderShape } from '../src/physics.js';
import { ent, makeStore } from './helpers.js';
import { runHash } from './determinism.js';

const box = (minX: number, minY: number, maxX: number, maxY: number): Aabb => ({
  minX,
  minY,
  maxX,
  maxY,
});

/** Deterministic PRNG (mulberry32) so every scene is reproducible from its index. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

afterEach(() => {
  broadphaseTestHooks.forceNaive = false;
});

// ---------------------------------------------------------------------------
// shapeAabb
// ---------------------------------------------------------------------------

describe('shapeAabb', () => {
  it('box: center ± half extents', () => {
    const shape = colliderShape(
      { shape: 'box', width: 20, height: 10, offset: { x: 0, y: 0 } } as never,
      { x: 100, y: 50 },
    );
    expect(shapeAabb(shape)).toEqual({ minX: 90, minY: 45, maxX: 110, maxY: 55 });
  });

  it('circle: center ± radius', () => {
    const shape = colliderShape(
      { shape: 'circle', radius: 8, offset: { x: 0, y: 0 } } as never,
      { x: -4, y: 6 },
    );
    expect(shapeAabb(shape)).toEqual({ minX: -12, minY: -2, maxX: 4, maxY: 14 });
  });

  it('polygon: bounds of world-space points', () => {
    const shape = colliderShape(
      {
        shape: 'polygon',
        offset: { x: 0, y: 0 },
        points: [
          { x: -10, y: -5 },
          { x: 12, y: -5 },
          { x: 0, y: 9 },
        ],
      } as never,
      { x: 100, y: 100 },
    );
    expect(shapeAabb(shape)).toEqual({ minX: 90, minY: 95, maxX: 112, maxY: 109 });
  });
});

// ---------------------------------------------------------------------------
// chooseCellSize
// ---------------------------------------------------------------------------

describe('chooseCellSize', () => {
  it('floors at 32 (empty and small inputs)', () => {
    expect(chooseCellSize([])).toBe(32);
    expect(chooseCellSize([box(0, 0, 10, 10), box(5, 5, 20, 12)])).toBe(32);
  });

  it('tracks the typical (p90) shape extent', () => {
    expect(chooseCellSize([box(0, 0, 100, 10), box(0, 0, 10, 64)])).toBe(100);
    expect(chooseCellSize([box(0, 0, 10, 130)])).toBe(130);
  });

  it('is not dominated by a single giant outlier (arena walls)', () => {
    const aabbs: Aabb[] = [];
    for (let i = 0; i < 20; i++) aabbs.push(box(i * 50, 0, i * 50 + 20, 20));
    aabbs.push(box(-40, -40, 2200, 0)); // 2240px wall
    expect(chooseCellSize(aabbs)).toBe(32);
  });

  it('ignores non-finite extents', () => {
    expect(chooseCellSize([box(Number.NaN, 0, Number.NaN, 10), box(-Infinity, 0, Infinity, 5)])).toBe(
      32,
    );
  });
});

// ---------------------------------------------------------------------------
// SpatialHash
// ---------------------------------------------------------------------------

describe('SpatialHash', () => {
  it('returns candidates ascending and deduped regardless of insert order', () => {
    const hash = new SpatialHash(32);
    hash.insert(5, box(0, 0, 100, 100));
    hash.insert(2, box(10, 10, 90, 90));
    hash.insert(9, box(-20, -20, 50, 50));
    expect([...hash.query(box(0, 0, 40, 40))]).toEqual([2, 5, 9]);
  });

  it('dedupes an AABB spanning many cells to a single candidate', () => {
    const hash = new SpatialHash(32);
    hash.insert(1, box(-1000, -1000, 1000, 1000));
    expect([...hash.query(box(-500, -500, 500, 500))]).toEqual([1]);
    expect([...hash.query(box(3, 3, 4, 4))]).toEqual([1]);
  });

  it('finds AABBs across cell boundaries (edge-touching stays a candidate)', () => {
    const hash = new SpatialHash(32);
    hash.insert(0, box(0, 0, 32, 32)); // max edge lands exactly on the 32/64 boundary
    expect([...hash.query(box(32, 0, 40, 10))]).toEqual([0]);
    expect([...hash.query(box(60, 60, 63, 63))]).toEqual([0]); // same cell as (32,32)
  });

  it('prunes far-apart AABBs', () => {
    const hash = new SpatialHash(32);
    hash.insert(0, box(0, 0, 10, 10));
    hash.insert(1, box(500, 500, 510, 510));
    expect([...hash.query(box(0, 0, 8, 8))]).toEqual([0]);
    expect([...hash.query(box(505, 505, 508, 508))]).toEqual([1]);
    expect([...hash.query(box(200, 200, 210, 210))]).toEqual([]);
  });

  it('treats non-finite AABBs conservatively (always a candidate, both directions)', () => {
    const hash = new SpatialHash(32);
    hash.insert(0, box(0, 0, 10, 10));
    hash.insert(3, box(Number.NaN, Number.NaN, Number.NaN, Number.NaN));
    expect([...hash.query(box(400, 400, 410, 410))]).toEqual([3]);
    expect([...hash.query(box(0, 0, 5, 5))]).toEqual([0, 3]);
    // Non-finite QUERY must return everything (cannot be located → no pruning).
    expect([...hash.query(box(Number.NaN, 0, Number.NaN, 0))]).toEqual([0, 3]);
  });

  it('routes a giant-span insert to the always-candidate list (found everywhere, both directions)', () => {
    const hash = new SpatialHash(32);
    // A 20000x20000 collider at cellSize 32 spans (20000/32)^2 ≈ 390k cells
    // — well past MAX_INSERT_CELL_SPAN — so it must be treated like a
    // non-finite AABB: always a candidate, for queries that overlap it AND
    // for ones far away, never pruned.
    hash.insert(0, box(-10_000, -10_000, 10_000, 10_000));
    hash.insert(1, box(0, 0, 10, 10)); // overlapping the giant
    expect([...hash.query(box(0, 0, 5, 5))]).toEqual([0, 1]);
    // Query far outside the giant's own AABB — still found (always-list).
    expect([...hash.query(box(1_000_000, 1_000_000, 1_000_010, 1_000_010))]).toEqual([0]);
    // And the giant's own query still finds everything inserted so far.
    expect([...hash.query(box(-10_000, -10_000, 10_000, 10_000))]).toEqual([0, 1]);
  });

  it('an insert with a 1e8 extent completes fast instead of enumerating ~1e12 cells', () => {
    const hash = new SpatialHash(32);
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      // Extent is finite (passes isFiniteAabb) but enormous — a script
      // setting position/extent to 1e8 must not enumerate its cell span.
      hash.insert(i, box(-1e8, -1e8, 1e8, 1e8));
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
    // Still findable — routed to the always-candidate list.
    expect([...hash.query(box(0, 0, 1, 1))]).toEqual(
      Array.from({ length: 1000 }, (_, i) => i),
    );
  });

  it('reset clears contents and adopts the new cell size', () => {
    const hash = new SpatialHash(32);
    hash.insert(0, box(0, 0, 10, 10));
    hash.reset(64);
    expect([...hash.query(box(0, 0, 10, 10))]).toEqual([]);
    hash.insert(7, box(100, 100, 120, 120));
    expect([...hash.query(box(90, 90, 101, 101))]).toEqual([7]);
  });

  it('is a conservative, order-preserving superset of naive AABB overlap (100 seeded sets)', () => {
    // Naive mirror of "could these AABBs collide": strict overlap, matching
    // computeShapePush's inclusivity (touching edges do NOT collide).
    const naiveOverlapPairs = (aabbs: Aabb[]): string[] => {
      const pairs: string[] = [];
      for (let i = 0; i < aabbs.length; i++) {
        for (let j = i + 1; j < aabbs.length; j++) {
          const a = aabbs[i];
          const b = aabbs[j];
          if (a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY) {
            pairs.push(`${i}|${j}`);
          }
        }
      }
      return pairs;
    };

    for (let set = 0; set < 100; set++) {
      const rand = mulberry32(90_000 + set);
      const aabbs: Aabb[] = [];
      const n = 5 + Math.floor(rand() * 30);
      for (let i = 0; i < n; i++) {
        const x = rand() * 600 - 100;
        const y = rand() * 400 - 100;
        const w = 4 + rand() * 120;
        const h = 4 + rand() * 120;
        aabbs.push(box(x, y, x + w, y + h));
      }
      const cellSize = chooseCellSize(aabbs);
      const hash = new SpatialHash(cellSize);
      for (let i = 0; i < n; i++) hash.insert(i, aabbs[i]);

      const broadPairs = new Set<string>();
      for (let i = 0; i < n; i++) {
        const candidates = hash.query(aabbs[i]);
        for (let c = 1; c < candidates.length; c++) {
          expect(candidates[c]).toBeGreaterThan(candidates[c - 1]); // ascending
        }
        for (const j of candidates) if (j > i) broadPairs.add(`${i}|${j}`);
      }
      for (const pair of naiveOverlapPairs(aabbs)) {
        expect(broadPairs.has(pair), `set ${set} missing pair ${pair}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Full-run property tests: naive vs broadphase stateHash
// ---------------------------------------------------------------------------

// Frame-stamped so a contact that merely SHIFTS by a frame (not just one
// that disappears) still changes the hashed eventCounts key set.
const HIT_SCRIPT = `export default {
  onCollision(ctx) {
    ctx.events.emit('hit@' + ctx.time.frame);
  },
};
`;

const pick = <T>(rand: () => number, items: T[]): T => items[Math.floor(rand() * items.length)];

/** Convex regular k-gon, randomly sized/rotated (local space). */
function regularPolygon(rand: () => number): { x: number; y: number }[] {
  const k = 3 + Math.floor(rand() * 4);
  const radius = 8 + rand() * 22;
  const rot = rand() * Math.PI * 2;
  const points = [];
  for (let i = 0; i < k; i++) {
    const a = rot + (i * 2 * Math.PI) / k;
    points.push({ x: radius * Math.cos(a), y: radius * Math.sin(a) });
  }
  return points;
}

function randomCollider(rand: () => number, layered: boolean): Record<string, unknown> {
  const kind = pick(rand, ['box', 'box', 'circle', 'polygon']);
  const collider: Record<string, unknown> =
    kind === 'box'
      ? { shape: 'box', width: 12 + rand() * 48, height: 12 + rand() * 48 }
      : kind === 'circle'
        ? { shape: 'circle', radius: 6 + rand() * 24 }
        : { shape: 'polygon', points: regularPolygon(rand) };
  if (rand() < 0.15) collider.isTrigger = true;
  if (layered) {
    collider.layer = pick(rand, ['default', 'a', 'b']);
    collider.collidesWith = pick(rand, [['*'], ['default', 'a'], ['a', 'b'], ['b'], ['*']]);
  }
  return collider;
}

function randomBody(rand: () => number, bodyType: string): Record<string, unknown> {
  const body: Record<string, unknown> = { bodyType };
  if (bodyType !== 'static') {
    body.velocity = { x: rand() * 240 - 120, y: rand() * 240 - 120 };
    body.mass = 0.5 + rand() * 3.5;
    if (rand() < 0.4) body.gravityScale = rand() < 0.5 ? 0 : rand() * 2;
  }
  if (rand() < 0.3) body.restitution = rand() * 0.6;
  if (rand() < 0.3) body.friction = rand() * 0.5;
  return body;
}

/**
 * Random scene mixing every physics feature: box/circle/polygon movers and
 * static obstacles, one-way platforms, triggers, solid tilemaps, deep
 * overlap stacks, layer filters. Everything clusters in a ~500×400 arena so
 * pairs actually collide. First two movers and every trigger carry an
 * onCollision script so trigger-only contacts reach the hashed eventCounts.
 */
function buildRandomScene(sceneIndex: number): Record<string, unknown>[] {
  const rand = mulberry32(1_000_000 + sceneIndex * 7919);
  const layered = rand() < 0.25;
  const entities: Record<string, unknown>[] = [];
  let scriptBudget = 2;

  const nObstacles = 2 + Math.floor(rand() * 6);
  for (let i = 0; i < nObstacles; i++) {
    const collider = randomCollider(rand, layered);
    if (collider.shape === 'box' && rand() < 0.3) collider.oneWay = true;
    const components: Record<string, unknown> = {
      Transform: { position: { x: rand() * 500, y: rand() * 400 } },
      Collider: collider,
    };
    if (rand() < 0.5) components.PhysicsBody = randomBody(rand, 'static');
    if (collider.isTrigger) components.Script = { scriptPath: 'scripts/hit.js' };
    entities.push(ent(`Obstacle${i}`, components));
  }

  if (rand() < 0.4) {
    const cols = 8 + Math.floor(rand() * 6);
    const rows = 2 + Math.floor(rand() * 3);
    const grid: string[] = [];
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let c = 0; c < cols; c++) line += rand() < 0.7 ? '#' : '.';
      grid.push(line);
    }
    entities.push(
      ent('Tiles', {
        Transform: { position: { x: rand() * 200, y: 250 + rand() * 100 } },
        Tilemap: {
          tileSize: pick(rand, [24, 32]),
          tileAssets: {},
          grid,
          solid: true,
        },
      }),
    );
  }

  const nMovers = 4 + Math.floor(rand() * 8);
  for (let i = 0; i < nMovers; i++) {
    const collider = randomCollider(rand, layered);
    const bodyType = rand() < 0.2 ? 'kinematic' : 'dynamic';
    const components: Record<string, unknown> = {
      Transform: { position: { x: rand() * 500, y: rand() * 400 } },
      Collider: collider,
      PhysicsBody: randomBody(rand, bodyType),
    };
    if (scriptBudget > 0 || collider.isTrigger) {
      components.Script = { scriptPath: 'scripts/hit.js' };
      scriptBudget--;
    }
    entities.push(ent(`Mover${i}`, components));
  }

  if (rand() < 0.35) {
    // Deep-overlap stack: several movers on the same point over a platform,
    // stressing mid-loop applyPush displacement vs the query inflation.
    const sx = 100 + rand() * 300;
    const sy = 100 + rand() * 100;
    entities.push(
      ent('StackFloor', {
        Transform: { position: { x: sx, y: sy + 40 } },
        Collider: { shape: 'box', width: 200, height: 16, oneWay: rand() < 0.5 },
      }),
    );
    const nStack = 4 + Math.floor(rand() * 4);
    for (let i = 0; i < nStack; i++) {
      entities.push(
        ent(`Stack${i}`, {
          Transform: { position: { x: sx, y: sy } },
          Collider: { shape: 'box', width: 20 + rand() * 12, height: 20 + rand() * 12 },
          PhysicsBody: { bodyType: 'dynamic', mass: 0.5 + rand() * 2 },
        }),
      );
    }
  }

  return entities;
}

const FRAMES = 30;
const SCENES = 200;
const BATCH = 25;

async function hashBothPaths(sceneIndex: number): Promise<{ naive: string; broad: string }> {
  const { store } = await makeStore({
    entities: buildRandomScene(sceneIndex),
    scripts: { 'hit.js': HIT_SCRIPT },
  });
  const seed = 5000 + sceneIndex;
  broadphaseTestHooks.forceNaive = true;
  const naive = await runHash(store, 'Test', FRAMES, seed);
  broadphaseTestHooks.forceNaive = false;
  const broad = await runHash(store, 'Test', FRAMES, seed);
  return { naive, broad };
}

describe('broadphase vs naive full-run equivalence (200 seeded scenes)', () => {
  for (let batch = 0; batch < SCENES / BATCH; batch++) {
    it(
      `scenes ${batch * BATCH}..${(batch + 1) * BATCH - 1} hash identically`,
      { timeout: 120_000 },
      async () => {
        for (let i = batch * BATCH; i < (batch + 1) * BATCH; i++) {
          const { naive, broad } = await hashBothPaths(i);
          expect(broad, `scene ${i} diverged`).toBe(naive);
        }
      },
    );
  }
});

// Decoy shapes far from the action: 30 small colliders keep chooseCellSize's
// p90 at the small-object scale (32) so the giant shapes below are genuine
// outliers and mid-loop displacement really exceeds the query inflation.
function decoys(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < 30; i++) {
    out.push(
      ent(`Decoy${i}`, {
        Transform: { position: { x: i * 100, y: 10_000 } },
        Collider: { shape: 'box', width: 10 + (i % 10), height: 10 + (i % 10) },
      }),
    );
  }
  return out;
}

describe('violent mid-loop ejection (requery/rebuild exactness)', () => {
  it('a mover ejected across the arena by a giant wall still hits a distant obstacle', { timeout: 60_000 }, async () => {
    // Mover starts deep inside a 2000px wall; the wall push ejects it ~110px
    // in one pair resolution — far past the 32px query inflation — into a
    // pebble it must still contact, exactly as the naive loops would.
    const entities: Record<string, unknown>[] = [
      ent('Wall', {
        Transform: { position: { x: 0, y: 0 } },
        Collider: { shape: 'box', width: 2000, height: 2000 },
      }),
      ent('Pebble', {
        Transform: { position: { x: 1025, y: 0 } },
        Collider: { shape: 'box', width: 20, height: 20 },
        Script: { scriptPath: 'scripts/hit.js' },
      }),
      ...decoys(),
      ent('Mover', {
        Transform: { position: { x: 900, y: 0 } },
        Collider: { shape: 'box', width: 20, height: 20 },
        PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
        Script: { scriptPath: 'scripts/hit.js' },
      }),
    ];
    const { store } = await makeStore({ entities, scripts: { 'hit.js': HIT_SCRIPT } });
    broadphaseTestHooks.forceNaive = true;
    const naive = await runHash(store, 'Test', 30, 777);
    broadphaseTestHooks.forceNaive = false;
    const broad = await runHash(store, 'Test', 30, 777);
    expect(broad).toBe(naive);
  });

  it('a mover ejected by its FINAL candidate still meets movers past the list', { timeout: 60_000 }, async () => {
    // A sits deep inside giant mover B; resolving (A, B) — A's last
    // candidate — shoves A ~55px right, into small mover M that was beyond
    // A's original query. Without a post-push staleness re-check at loop
    // exit, the (A, M) pair the naive loops produce is silently dropped.
    const entities: Record<string, unknown>[] = [
      ent('A', {
        Transform: { position: { x: 900, y: 0 } },
        Collider: { shape: 'box', width: 20, height: 20 },
        PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
        Script: { scriptPath: 'scripts/hit.js' },
      }),
      ent('BigB', {
        Transform: { position: { x: 0, y: 0 } },
        Collider: { shape: 'box', width: 2000, height: 2000 },
        PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
      }),
      ent('M', {
        Transform: { position: { x: 970, y: 0 } },
        Collider: { shape: 'box', width: 20, height: 20 },
        PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
        Script: { scriptPath: 'scripts/hit.js' },
      }),
      ...decoys(),
    ];
    const { store } = await makeStore({ entities, scripts: { 'hit.js': HIT_SCRIPT } });
    broadphaseTestHooks.forceNaive = true;
    const naive = await runHash(store, 'Test', 30, 999);
    broadphaseTestHooks.forceNaive = false;
    const broad = await runHash(store, 'Test', 30, 999);
    expect(broad).toBe(naive);
  });

  it('a mover pushed into a later mover’s neighborhood is still paired with it', { timeout: 60_000 }, async () => {
    // A (giant) and C (giant) overlap deeply; resolving (A, C) shoves C
    // ~95px toward B. B's sweep then runs with C's hash position stale —
    // only a mover-hash rebuild can restore the (B, C) pair the naive
    // loops produce.
    const entities: Record<string, unknown>[] = [
      ent('A', {
        Transform: { position: { x: 0, y: 0 } },
        Collider: { shape: 'box', width: 200, height: 200 },
        PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
      }),
      ent('B', {
        Transform: { position: { x: 200, y: 0 } },
        Collider: { shape: 'box', width: 10, height: 10 },
        PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
        Script: { scriptPath: 'scripts/hit.js' },
      }),
      ent('C', {
        Transform: { position: { x: 10, y: 0 } },
        Collider: { shape: 'box', width: 200, height: 200 },
        PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
        Script: { scriptPath: 'scripts/hit.js' },
      }),
      ...decoys(),
    ];
    const { store } = await makeStore({ entities, scripts: { 'hit.js': HIT_SCRIPT } });
    broadphaseTestHooks.forceNaive = true;
    const naive = await runHash(store, 'Test', 30, 888);
    broadphaseTestHooks.forceNaive = false;
    const broad = await runHash(store, 'Test', 30, 888);
    expect(broad).toBe(naive);
  });
});

describe('deep-overlap stack (brief-mandated)', () => {
  it('10 movers stacked on one point on a platform hash identically', { timeout: 60_000 }, async () => {
    const entities: Record<string, unknown>[] = [
      ent('Platform', {
        Transform: { position: { x: 200, y: 300 } },
        Collider: { shape: 'box', width: 240, height: 16 },
        PhysicsBody: { bodyType: 'static' },
      }),
    ];
    for (let i = 0; i < 10; i++) {
      entities.push(
        ent(`Stacked${i}`, {
          Transform: { position: { x: 200, y: 260 } },
          Collider: { shape: 'box', width: 24, height: 24 },
          PhysicsBody: { bodyType: 'dynamic', mass: 1 + i * 0.25 },
        }),
      );
    }
    const { store } = await makeStore({ entities });
    broadphaseTestHooks.forceNaive = true;
    const naive = await runHash(store, 'Test', 60, 1234);
    broadphaseTestHooks.forceNaive = false;
    const broad = await runHash(store, 'Test', 60, 1234);
    expect(broad).toBe(naive);
  });
});
