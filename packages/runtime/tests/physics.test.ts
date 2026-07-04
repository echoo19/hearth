/**
 * Physics: gravity, ground settling, kinematic movement, drag, triggers,
 * tilemap colliders, and dynamic-vs-dynamic separation.
 */
import { describe, it, expect } from 'vitest';
import { SceneRuntime } from '@hearth/runtime';
import { makeStore, ent } from './helpers.js';
import { resolveContactVelocity, RESTITUTION_MIN_SPEED } from '../src/physics.js';

describe('gravity and ground collision', () => {
  it('lands a dynamic body on a static ground and settles', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Ground', {
          Transform: { position: { x: 400, y: 550 } },
          Collider: { shape: 'box', width: 800, height: 64 },
          PhysicsBody: { bodyType: 'static' },
        }),
        ent('Player', {
          Transform: { position: { x: 400, y: 480 } },
          Collider: { shape: 'box', width: 32, height: 48 },
          PhysicsBody: { bodyType: 'dynamic' },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(120);

    const player = runtime.find('Player')!;
    // Ground top = 550 - 32 = 518; player half height = 24 → rests at 494.
    expect(player.transform.position.y).toBeCloseTo(494, 3);
    expect(player.components.PhysicsBody!.velocity.y).toBe(0);
    // Standing on ground: contact with normal pointing up (+y is down).
    const contact = player.collisions.find((c) => !c.trigger && c.normal.y < -0.5);
    expect(contact).toBeDefined();
    expect(contact!.other.name).toBe('Ground');
    expect(runtime.errors).toEqual([]);
  });

  it('applies gravity scaled by gravityScale', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Floater', {
          Transform: { position: { x: 0, y: 0 } },
          PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
        }),
        ent('Faller', {
          Transform: { position: { x: 100, y: 0 } },
          PhysicsBody: { bodyType: 'dynamic', gravityScale: 1 },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(60);
    expect(runtime.find('Floater')!.transform.position.y).toBe(0);
    expect(runtime.find('Faller')!.transform.position.y).toBeGreaterThan(100);
  });

  it('damps horizontal velocity with drag', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Slider', {
          Transform: { position: { x: 0, y: 0 } },
          PhysicsBody: { bodyType: 'dynamic', gravityScale: 0, velocity: { x: 100, y: 0 }, drag: 2 },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(60);
    const body = runtime.find('Slider')!.components.PhysicsBody!;
    expect(body.velocity.x).toBeLessThan(100);
    expect(body.velocity.x).toBeGreaterThan(0);
  });
});

describe('kinematic bodies', () => {
  it('moves by velocity without gravity and is not pushed', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Platform', {
          Transform: { position: { x: 0, y: 100 } },
          Collider: { shape: 'box', width: 64, height: 16 },
          PhysicsBody: { bodyType: 'kinematic', velocity: { x: 60, y: 0 } },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(60);
    const platform = runtime.find('Platform')!;
    expect(platform.transform.position.x).toBeCloseTo(60, 3);
    expect(platform.transform.position.y).toBe(100); // no gravity
  });
});

describe('triggers', () => {
  it('reports trigger overlaps without blocking movement', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Mover', {
          Transform: { position: { x: 0, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic', gravityScale: 0, velocity: { x: 0, y: 100 } },
        }),
        ent('Zone', {
          Transform: { position: { x: 0, y: 50 } },
          Collider: { shape: 'box', width: 32, height: 32, isTrigger: true },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(30); // mover center at y≈50 — inside the zone
    const mover = runtime.find('Mover')!;
    expect(mover.collisions.length).toBe(1);
    expect(mover.collisions[0].trigger).toBe(true);
    expect(mover.collisions[0].other.name).toBe('Zone');
    // Not blocked: keeps falling straight through.
    runtime.run(60);
    expect(mover.transform.position.y).toBeGreaterThan(100);
    expect(mover.collisions.length).toBe(0);
  });
});

describe('tilemap colliders', () => {
  it('generates static AABBs per solid cell and supports landing on them', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Map', {
          Transform: { position: { x: 0, y: 0 } },
          Tilemap: { tileSize: 32, grid: ['....', 'GGGG'], solid: true },
        }),
        ent('Faller', {
          Transform: { position: { x: 48, y: -20 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic' },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(120);
    const faller = runtime.find('Faller')!;
    // Solid row spans y 32..64; faller (half height 16) rests centered at 16.
    expect(faller.transform.position.y).toBeCloseTo(16, 3);
    expect(faller.collisions.some((c) => c.other.name === 'Map' && c.normal.y < -0.5)).toBe(true);
  });

  it('ignores non-solid tilemaps and empty cells', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Map', {
          Transform: { position: { x: 0, y: 0 } },
          Tilemap: { tileSize: 32, grid: ['....', 'GGGG'], solid: false },
        }),
        ent('Faller', {
          Transform: { position: { x: 48, y: -20 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic' },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(60);
    expect(runtime.find('Faller')!.transform.position.y).toBeGreaterThan(64);
  });
});

describe('dynamic vs dynamic', () => {
  it('pushes overlapping dynamic bodies apart half and half', async () => {
    const { store } = await makeStore({
      entities: [
        ent('A', {
          Transform: { position: { x: -10, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
        }),
        ent('B', {
          Transform: { position: { x: 10, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.step();
    const a = runtime.find('A')!;
    const b = runtime.find('B')!;
    // 12px overlap resolved 6px each way.
    expect(a.transform.position.x).toBeCloseTo(-16, 3);
    expect(b.transform.position.x).toBeCloseTo(16, 3);
    expect(a.collisions[0].normal.x).toBe(-1);
    expect(b.collisions[0].normal.x).toBe(1);
  });
});

describe('resolveContactVelocity (unit)', () => {
  it('reflects incoming normal velocity scaled by restitution', () => {
    const v = { x: 0, y: 100 };
    resolveContactVelocity(v, 0, -1, 0.5, 0, 1 / 60);
    expect(v.x).toBeCloseTo(0, 10);
    expect(v.y).toBeCloseTo(-50, 10);
  });

  it('fully cancels normal velocity with restitution 0 (v1 path)', () => {
    const v = { x: 0, y: 100 };
    resolveContactVelocity(v, 0, -1, 0, 0, 1 / 60);
    expect(v.x).toBe(0);
    expect(v.y).toBe(0);
  });

  it('suppresses bounce below RESTITUTION_MIN_SPEED', () => {
    const incomingSpeed = 10;
    expect(incomingSpeed).toBeLessThan(RESTITUTION_MIN_SPEED);
    const v = { x: 0, y: incomingSpeed };
    resolveContactVelocity(v, 0, -1, 0.9, 0, 1 / 60);
    // Too slow to bounce: normal component zeroed instead of reflected.
    expect(v.y).toBe(0);
  });

  it('applies friction damping to the tangential component', () => {
    const v = { x: 100, y: 50 };
    const dt = 1 / 60;
    resolveContactVelocity(v, 0, -1, 0, 1, dt);
    // tangent = (1, 0) for normal (0, -1); vt = 100 damped by (1 - friction*FRICTION_DAMPING*dt).
    expect(v.x).toBeCloseTo(100 * (1 - 1 * 10 * dt), 10);
    expect(v.y).toBe(0);
  });

  it('is bit-identical to the v1 default path for a separating velocity', () => {
    const v = { x: 3, y: -50 };
    // Already separating (v·n = 50 >= 0): defaults must leave it untouched.
    resolveContactVelocity(v, 0, -1, 0, 0, 1 / 60);
    expect(v.x).toBe(3);
    expect(v.y).toBe(-50);
  });
});

describe('contact response (restitution, friction, mass split)', () => {
  it('bounces a restitutive dynamic body off a static floor', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Ground', {
          Transform: { position: { x: 400, y: 550 } },
          Collider: { shape: 'box', width: 800, height: 64 },
          PhysicsBody: { bodyType: 'static' },
        }),
        ent('Ball', {
          Transform: { position: { x: 400, y: 480 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic', restitution: 0.8 },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    const ball = runtime.find('Ball')!;
    let bounced = false;
    for (let i = 0; i < 120; i++) {
      const before = ball.components.PhysicsBody!.velocity.y;
      runtime.step();
      const after = ball.components.PhysicsBody!.velocity.y;
      if (before > 0 && after < 0) {
        bounced = true;
        break;
      }
    }
    expect(bounced).toBe(true);
    expect(runtime.errors).toEqual([]);
  });

  it('settles identically to v1 with default restitution and friction', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Ground', {
          Transform: { position: { x: 400, y: 550 } },
          Collider: { shape: 'box', width: 800, height: 64 },
          PhysicsBody: { bodyType: 'static' },
        }),
        ent('Player', {
          Transform: { position: { x: 400, y: 480 } },
          Collider: { shape: 'box', width: 32, height: 48 },
          PhysicsBody: { bodyType: 'dynamic' },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(120);
    const player = runtime.find('Player')!;
    expect(player.transform.position.y).toBeCloseTo(494, 3);
    expect(player.components.PhysicsBody!.velocity.y).toBe(0);
  });

  it('pushes only the dynamic side, full amount, when the kinematic mover is first', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Wall', {
          Transform: { position: { x: -10, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'kinematic', restitution: 0.8, friction: 1 },
        }),
        ent('Ball', {
          Transform: { position: { x: 10, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic', gravityScale: 0, velocity: { x: -100, y: 60 } },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.step();
    const wall = runtime.find('Wall')!;
    const ball = runtime.find('Ball')!;
    // Kinematic side is never pushed.
    expect(wall.transform.position.x).toBe(-10);
    // Ball integrates to 10 - 100/60 = 25/3, then absorbs the full 41/3 push → 22.
    expect(ball.transform.position.x).toBeCloseTo(22, 6);
    const v = ball.components.PhysicsBody!.velocity;
    // Kinematic partner's restitution 0.8 reflects the -100 normal velocity.
    expect(v.x).toBeCloseTo(80, 6);
    // Kinematic partner's friction 1 damps tangential 60 by (1 - 10/60).
    expect(v.y).toBeCloseTo(60 * (1 - 10 / 60), 6);
  });

  it('pushes only the dynamic side, full amount, when the kinematic mover is second', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Ball', {
          Transform: { position: { x: -10, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic', gravityScale: 0, velocity: { x: 100, y: 60 } },
        }),
        ent('Wall', {
          Transform: { position: { x: 10, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'kinematic', restitution: 0.8, friction: 1 },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.step();
    const wall = runtime.find('Wall')!;
    const ball = runtime.find('Ball')!;
    expect(wall.transform.position.x).toBe(10);
    // Mirror of the test above: -25/3 minus the full 41/3 push → -22.
    expect(ball.transform.position.x).toBeCloseTo(-22, 6);
    const v = ball.components.PhysicsBody!.velocity;
    expect(v.x).toBeCloseTo(-80, 6);
    expect(v.y).toBeCloseTo(60 * (1 - 10 / 60), 6);
  });

  it('falls back to a half split when scripts write non-positive masses', async () => {
    const { store } = await makeStore({
      entities: [
        ent('A', {
          Transform: { position: { x: -10, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
        }),
        ent('B', {
          Transform: { position: { x: 10, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    // Schema forbids mass <= 0, but scripts can write component fields
    // directly at runtime — must not produce NaN positions (0 + 0 total).
    runtime.find('A')!.components.PhysicsBody!.mass = 0;
    runtime.find('B')!.components.PhysicsBody!.mass = 0;
    runtime.step();
    const ax = runtime.find('A')!.transform.position.x;
    const bx = runtime.find('B')!.transform.position.x;
    expect(Number.isFinite(ax)).toBe(true);
    expect(Number.isFinite(bx)).toBe(true);
    // Both invalid → both treated as mass 1 → 12px overlap split 6px each.
    expect(ax).toBeCloseTo(-16, 3);
    expect(bx).toBeCloseTo(16, 3);
  });

  it('splits mover-vs-mover push by inverse mass', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Light', {
          Transform: { position: { x: -10, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic', gravityScale: 0, mass: 1 },
        }),
        ent('Heavy', {
          Transform: { position: { x: 10, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic', gravityScale: 0, mass: 3 },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.step();
    const light = runtime.find('Light')!;
    const heavy = runtime.find('Heavy')!;
    const lightMove = Math.abs(light.transform.position.x - -10);
    const heavyMove = Math.abs(heavy.transform.position.x - 10);
    expect(lightMove / heavyMove).toBeCloseTo(3, 5);
  });
});
