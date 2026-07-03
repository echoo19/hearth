/**
 * Polygon colliders: SAT for polygon–polygon, polygon–box, and
 * polygon–circle, MTV resolution for dynamic bodies, trigger overlap
 * reporting, and Transform rotation/scale applied to polygon points.
 */
import { describe, it, expect } from 'vitest';
import { SceneRuntime, colliderShape, computeShapePush } from '@hearth/runtime';
import { createComponent } from '@hearth/core';
import { makeStore, ent } from './helpers.js';

/** A convex quad slab: 200 wide, 20 tall, centered on the origin. */
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

describe('computeShapePush (SAT unit cases)', () => {
  const shape = (overrides: Record<string, unknown>, pos = { x: 0, y: 0 }, transform?: { rotation: number; scale: { x: number; y: number } }) =>
    colliderShape(createComponent('Collider', overrides), pos, transform);

  it('resolves polygon vs polygon along the axis of least overlap', () => {
    const a = shape({ shape: 'polygon', points: SQUARE_16 }, { x: 0, y: 0 });
    const b = shape({ shape: 'polygon', points: SQUARE_16 }, { x: 27, y: 0 });
    const push = computeShapePush(a, b)!;
    expect(push.nx).toBeCloseTo(-1, 6);
    expect(push.ny).toBeCloseTo(0, 6);
    expect(push.amount).toBeCloseTo(5, 6); // 32 - 27
  });

  it('resolves polygon vs box and returns null when separated', () => {
    const poly = shape({ shape: 'polygon', points: SQUARE_16 }, { x: 0, y: 0 });
    const box = shape({ shape: 'box', width: 32, height: 32 }, { x: 0, y: 28 });
    const push = computeShapePush(poly, box)!;
    expect(push.ny).toBeCloseTo(-1, 6);
    expect(push.amount).toBeCloseTo(4, 6); // 32 - 28
    const far = shape({ shape: 'box', width: 32, height: 32 }, { x: 0, y: 40 });
    expect(computeShapePush(poly, far)).toBeNull();
  });

  it('resolves circle vs polygon with the true circle, not its bounding box', () => {
    const poly = shape({ shape: 'polygon', points: SQUARE_16 }, { x: 0, y: 0 });
    // Circle diagonally off the corner: bounding boxes overlap but the
    // circle itself stays clear of the corner vertex.
    const circle = shape({ shape: 'circle', radius: 16 }, { x: 28, y: 28 });
    expect(computeShapePush(circle, poly)).toBeNull();
    const touching = shape({ shape: 'circle', radius: 16 }, { x: 0, y: 28 });
    const push = computeShapePush(touching, poly)!;
    expect(push.ny).toBeCloseTo(1, 6);
    expect(push.amount).toBeCloseTo(4, 6);
  });

  it('applies Transform rotation and scale to polygon points', () => {
    // ±16 square scaled ×2 then rotated 45°: a diamond with 32√2 half-extents.
    const diamond = shape({ shape: 'polygon', points: SQUARE_16 }, { x: 0, y: 0 }, {
      rotation: 45,
      scale: { x: 2, y: 2 },
    });
    expect(diamond.kind).toBe('polygon');
    const ext = 32 * Math.SQRT2;
    expect(diamond.box.hh).toBeCloseTo(ext, 6);
    expect(diamond.box.hw).toBeCloseTo(ext, 6);
  });
});

describe('polygon vs polygon (runtime)', () => {
  it('lands a dynamic polygon on a static polygon slab and settles', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Ground', {
          Transform: { position: { x: 0, y: 100 } },
          Collider: { shape: 'polygon', points: SLAB_POINTS },
          PhysicsBody: { bodyType: 'static' },
        }),
        ent('Faller', {
          Transform: { position: { x: 0, y: 50 } },
          Collider: { shape: 'polygon', points: SQUARE_16 },
          PhysicsBody: { bodyType: 'dynamic' },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(120);
    const faller = runtime.find('Faller')!;
    // Slab top = 90; faller half-height 16 → rests at 74.
    expect(faller.transform.position.y).toBeCloseTo(74, 3);
    expect(faller.transform.position.x).toBeCloseTo(0, 3);
    const contact = faller.collisions.find((c) => !c.trigger);
    expect(contact).toBeDefined();
    expect(contact!.normal.y).toBeLessThan(-0.5);
    expect(runtime.errors).toEqual([]);
  });
});

describe('polygon vs box (runtime)', () => {
  it('lands a dynamic box on a static polygon slab', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Ground', {
          Transform: { position: { x: 0, y: 100 } },
          Collider: { shape: 'polygon', points: SLAB_POINTS },
          PhysicsBody: { bodyType: 'static' },
        }),
        ent('Faller', {
          Transform: { position: { x: 0, y: 50 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic' },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(120);
    const faller = runtime.find('Faller')!;
    expect(faller.transform.position.y).toBeCloseTo(74, 3);
    expect(faller.collisions.some((c) => c.other.name === 'Ground' && c.normal.y < -0.5)).toBe(true);
  });
});

describe('polygon vs circle (runtime)', () => {
  it('lands a dynamic circle on a static polygon slab', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Ground', {
          Transform: { position: { x: 0, y: 100 } },
          Collider: { shape: 'polygon', points: SLAB_POINTS },
          PhysicsBody: { bodyType: 'static' },
        }),
        ent('Ball', {
          Transform: { position: { x: 0, y: 50 } },
          Collider: { shape: 'circle', radius: 16 },
          PhysicsBody: { bodyType: 'dynamic' },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(120);
    const ball = runtime.find('Ball')!;
    expect(ball.transform.position.y).toBeCloseTo(74, 3);
    expect(ball.collisions.some((c) => c.normal.y < -0.5)).toBe(true);
  });
});

describe('polygon triggers', () => {
  it('reports trigger overlap without blocking movement', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Mover', {
          Transform: { position: { x: 0, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic', gravityScale: 0, velocity: { x: 0, y: 100 } },
        }),
        ent('Zone', {
          Transform: { position: { x: 0, y: 50 } },
          Collider: { shape: 'polygon', points: SQUARE_16, isTrigger: true },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(30); // mover center at y≈50 — inside the zone
    const mover = runtime.find('Mover')!;
    expect(mover.collisions.length).toBe(1);
    expect(mover.collisions[0].trigger).toBe(true);
    expect(mover.collisions[0].other.name).toBe('Zone');
    runtime.run(60);
    expect(mover.transform.position.y).toBeGreaterThan(100); // fell straight through
    expect(mover.collisions.length).toBe(0);
  });
});

describe('rotated and scaled polygons (runtime)', () => {
  it('collides against a rotated polygon (square rotated 45° = diamond)', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Diamond', {
          Transform: { position: { x: 0, y: 100 }, rotation: 45 },
          Collider: { shape: 'polygon', points: SQUARE_16 },
          PhysicsBody: { bodyType: 'static' },
        }),
        ent('Faller', {
          Transform: { position: { x: 0, y: 30 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic' },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(120);
    const faller = runtime.find('Faller')!;
    // Diamond apex = 100 - 16√2; box rests with its bottom on the apex.
    expect(faller.transform.position.y).toBeCloseTo(100 - 16 * Math.SQRT2 - 16, 2);
  });

  it('applies Transform scale to polygon overlap', async () => {
    const smallSquare = [
      { x: -8, y: -8 },
      { x: 8, y: -8 },
      { x: 8, y: 8 },
      { x: -8, y: 8 },
    ];
    const { store } = await makeStore({
      entities: [
        ent('Scaled', {
          Transform: { position: { x: 0, y: 0 }, scale: { x: 2, y: 2 } },
          Collider: { shape: 'polygon', points: smallSquare },
          PhysicsBody: { bodyType: 'kinematic' },
        }),
        ent('ZoneA', {
          Transform: { position: { x: 30, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 32, isTrigger: true },
        }),
        ent('Unscaled', {
          Transform: { position: { x: 0, y: 300 } },
          Collider: { shape: 'polygon', points: smallSquare },
          PhysicsBody: { bodyType: 'kinematic' },
        }),
        ent('ZoneB', {
          Transform: { position: { x: 30, y: 300 } },
          Collider: { shape: 'box', width: 32, height: 32, isTrigger: true },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.step();
    // Scaled: ±16 world extent overlaps the zone at x 14..46; unscaled ±8 does not.
    expect(runtime.find('Scaled')!.collisions.length).toBe(1);
    expect(runtime.find('Unscaled')!.collisions.length).toBe(0);
  });
});
