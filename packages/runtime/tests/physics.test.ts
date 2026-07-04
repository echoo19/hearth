/**
 * Physics: gravity, ground settling, kinematic movement, drag, triggers,
 * tilemap colliders, and dynamic-vs-dynamic separation.
 */
import { describe, it, expect } from 'vitest';
import { SceneRuntime } from '@hearth/runtime';
import { createComponent } from '@hearth/core';
import { makeStore, ent } from './helpers.js';
import {
  layersInteract,
  resolveContactVelocity,
  RESTITUTION_MIN_SPEED,
  computeShapePush,
  computePush,
  colliderShape,
} from '../src/physics.js';

function scripted(name: string, scriptPath: string, components: Record<string, unknown> = {}) {
  return ent(name, { Transform: {}, Script: { scriptPath }, ...components });
}

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

describe('layersInteract (unit)', () => {
  it('defaults interact with defaults', () => {
    const def = { layer: 'default', collidesWith: ['*'] };
    expect(layersInteract(def, def)).toBe(true);
  });

  it('two named layers interact when each lists the other', () => {
    const a = { layer: 'a', collidesWith: ['b'] };
    const b = { layer: 'b', collidesWith: ['a'] };
    expect(layersInteract(a, b)).toBe(true);
  });

  it('is false when only one side lists the other', () => {
    const a = { layer: 'a', collidesWith: ['b'] };
    const b = { layer: 'b', collidesWith: ['c'] };
    expect(layersInteract(a, b)).toBe(false);
  });

  it("'*' matches any layer", () => {
    const a = { layer: 'a', collidesWith: ['*'] };
    const b = { layer: 'b', collidesWith: ['a'] };
    expect(layersInteract(a, b)).toBe(true);
  });

  it('empty collidesWith excludes everything, including itself', () => {
    const a = { layer: 'a', collidesWith: [] };
    const b = { layer: 'b', collidesWith: ['*'] };
    expect(layersInteract(a, b)).toBe(false);
    expect(layersInteract(a, a)).toBe(false);
  });
});

describe('collision layer filtering', () => {
  it('passes overlapping dynamic bodies through on mutually-excluded layers', async () => {
    const { store } = await makeStore({
      entities: [
        scripted('A', 'scripts/hit.js', {
          Transform: { position: { x: -5, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 32, layer: 'a', collidesWith: ['a'] },
          PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
        }),
        scripted('B', 'scripts/hit.js', {
          Transform: { position: { x: 5, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 32, layer: 'b', collidesWith: ['b'] },
          PhysicsBody: { bodyType: 'dynamic', gravityScale: 0 },
        }),
      ],
      scripts: {
        'hit.js': `
          export default {
            onCollision(ctx, other) { ctx.log(ctx.entity.name + ' hit ' + other.name); },
          };
        `,
      },
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.step();
    const a = runtime.find('A')!;
    const b = runtime.find('B')!;
    // Filtered pair: no push, positions unchanged.
    expect(a.transform.position.x).toBe(-5);
    expect(b.transform.position.x).toBe(5);
    expect(a.collisions.length).toBe(0);
    expect(b.collisions.length).toBe(0);
    expect(runtime.logs.length).toBe(0);
  });

  it('filters trigger pairs too — no trigger contact across excluded layers', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Mover', {
          Transform: { position: { x: 0, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 32, layer: 'a', collidesWith: ['a'] },
          PhysicsBody: { bodyType: 'dynamic', gravityScale: 0, velocity: { x: 0, y: 100 } },
        }),
        ent('Zone', {
          Transform: { position: { x: 0, y: 50 } },
          Collider: {
            shape: 'box',
            width: 32,
            height: 32,
            isTrigger: true,
            layer: 'b',
            collidesWith: ['b'],
          },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(30); // mover center at y≈50 — would be inside the zone if not filtered
    expect(runtime.find('Mover')!.collisions.length).toBe(0);
  });
});

describe('one-way platforms', () => {
  it('lands on a one-way platform when falling from above', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Platform', {
          Transform: { position: { x: 0, y: 100 } },
          Collider: { shape: 'box', width: 64, height: 16, oneWay: true },
          PhysicsBody: { bodyType: 'static' },
        }),
        ent('Faller', {
          Transform: { position: { x: 0, y: 0 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic' },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(120);
    const faller = runtime.find('Faller')!;
    // Platform top = 100 - 8 = 92; faller half height 16 → rests at 76.
    expect(faller.transform.position.y).toBeCloseTo(76, 3);
    expect(faller.components.PhysicsBody!.velocity.y).toBe(0);
    const contact = faller.collisions.find((c) => !c.trigger && c.normal.y < -0.5);
    expect(contact).toBeDefined();
  });

  it('passes through when jumping up from below', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Platform', {
          Transform: { position: { x: 0, y: 100 } },
          Collider: { shape: 'box', width: 64, height: 16, oneWay: true },
          PhysicsBody: { bodyType: 'static' },
        }),
        ent('Jumper', {
          Transform: { position: { x: 0, y: 150 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: {
            bodyType: 'dynamic',
            gravityScale: 0,
            velocity: { x: 0, y: -200 },
          },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    // Run through the full pass — gate must never block it, and velocity
    // must stay uncancelled (gravityScale 0, no drag).
    for (let i = 0; i < 30; i++) {
      runtime.step();
      expect(runtime.find('Jumper')!.collisions.length).toBe(0);
    }
    const jumper = runtime.find('Jumper')!;
    expect(jumper.components.PhysicsBody!.velocity.y).toBe(-200);
    // Started at 150, moved by -200*30/60 = -100 → should now be above the platform.
    expect(jumper.transform.position.y).toBeLessThan(92 - 16);
  });

  it('passes through a sideways approach (push axis fails the ny gate)', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Platform', {
          Transform: { position: { x: 0, y: 100 } },
          Collider: { shape: 'box', width: 64, height: 16, oneWay: true },
          PhysicsBody: { bodyType: 'static' },
        }),
        ent('Slider', {
          Transform: { position: { x: -100, y: 100 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic', gravityScale: 0, velocity: { x: 200, y: 0 } },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.run(60); // 1s at 200px/s → x: -100 -> 100, straight through
    const slider = runtime.find('Slider')!;
    expect(slider.transform.position.x).toBeCloseTo(100, 3);
    expect(slider.collisions.length).toBe(0);
  });

  it('supports a body already resting on top with velocity.y = 0', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Platform', {
          Transform: { position: { x: 0, y: 100 } },
          Collider: { shape: 'box', width: 64, height: 16, oneWay: true },
          PhysicsBody: { bodyType: 'static' },
        }),
        ent('Standee', {
          // Slight overlap (rests at 76 exactly, penetrate by 2px) with no gravity.
          Transform: { position: { x: 0, y: 78 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic', gravityScale: 0, velocity: { x: 0, y: 0 } },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    runtime.step();
    const standee = runtime.find('Standee')!;
    expect(standee.transform.position.y).toBeCloseTo(76, 3);
    const contact = standee.collisions.find((c) => !c.trigger && c.normal.y < -0.5);
    expect(contact).toBeDefined();
  });

  it('mover-vs-mover: one-way gate checks both directions', async () => {
    const { store } = await makeStore({
      entities: [
        ent('OneWayMover', {
          Transform: { position: { x: 0, y: 100 } },
          Collider: { shape: 'box', width: 64, height: 16, oneWay: true },
          PhysicsBody: { bodyType: 'kinematic', velocity: { x: 0, y: 0 } },
        }),
        ent('Jumper', {
          Transform: { position: { x: 0, y: 150 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: { bodyType: 'dynamic', gravityScale: 0, velocity: { x: 0, y: -200 } },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    for (let i = 0; i < 30; i++) {
      runtime.step();
      expect(runtime.find('Jumper')!.collisions.length).toBe(0);
    }
    expect(runtime.find('Jumper')!.transform.position.y).toBeLessThan(92 - 16);
  });

  it('trigger + oneWay: trigger events still fire regardless of approach', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Zone', {
          Transform: { position: { x: 0, y: 100 } },
          Collider: { shape: 'box', width: 64, height: 16, oneWay: true, isTrigger: true },
          PhysicsBody: { bodyType: 'static' },
        }),
        ent('Jumper', {
          Transform: { position: { x: 0, y: 150 } },
          Collider: { shape: 'box', width: 32, height: 32 },
          PhysicsBody: {
            bodyType: 'dynamic',
            gravityScale: 0,
            velocity: { x: 0, y: -200 },
          },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    let sawTrigger = false;
    for (let i = 0; i < 30; i++) {
      runtime.step();
      const jumper = runtime.find('Jumper')!;
      if (jumper.collisions.some((c) => c.trigger && c.other.name === 'Zone')) sawTrigger = true;
    }
    expect(sawTrigger).toBe(true);
  });
});

describe('computeShapePush (true circle resolution)', () => {
  const shape = (overrides: Record<string, unknown>, pos = { x: 0, y: 0 }) =>
    colliderShape(createComponent('Collider', overrides), pos);

  it('resolves circle vs circle along the true center-to-center normal', () => {
    const a = shape({ shape: 'circle', radius: 16 }, { x: 0, y: 0 });
    const b = shape({ shape: 'circle', radius: 16 }, { x: 20, y: 0 });
    const push = computeShapePush(a, b)!;
    // a out of b: same y, so the true normal happens to match the AABB axis split here.
    expect(push.nx).toBeCloseTo(-1, 6);
    expect(push.ny).toBeCloseTo(0, 6);
    expect(push.amount).toBeCloseTo(12, 6); // 32 - 20
  });

  it('resolves a diagonal circle-circle overlap along the true diagonal normal, not an axis split', () => {
    const a = shape({ shape: 'circle', radius: 16 }, { x: 0, y: 0 });
    const b = shape({ shape: 'circle', radius: 16 }, { x: 20, y: 20 });
    const push = computeShapePush(a, b)!;
    // True center distance is Math.hypot(20, 20) ≈ 28.28, not the old
    // AABB-style axis split (which would have picked a pure ±x or ±y push).
    expect(push.nx).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(push.ny).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(push.amount).toBeCloseTo(32 - Math.hypot(20, 20), 6);
  });

  it('pushes concentric circles toward +x deterministically (zero-distance edge case)', () => {
    const a = shape({ shape: 'circle', radius: 16 }, { x: 0, y: 0 });
    const b = shape({ shape: 'circle', radius: 16 }, { x: 0, y: 0 });
    const push = computeShapePush(a, b)!;
    expect(push.nx).toBe(1);
    expect(push.ny).toBe(0);
    expect(push.amount).toBe(32);
  });

  it('returns null for circles that do not overlap', () => {
    const a = shape({ shape: 'circle', radius: 16 }, { x: 0, y: 0 });
    const b = shape({ shape: 'circle', radius: 16 }, { x: 40, y: 0 });
    expect(computeShapePush(a, b)).toBeNull();
  });

  it('resolves a circle overlapping a box corner along the true closest-point normal', () => {
    // Circle center (40,40), box 64x64 centered at origin (half extents 32):
    // closest box point is the corner (32,32).
    const circle = shape({ shape: 'circle', radius: 16 }, { x: 40, y: 40 });
    const box = shape({ shape: 'box', width: 64, height: 64 }, { x: 0, y: 0 });
    const push = computeShapePush(circle, box)!;
    const dist = Math.hypot(8, 8); // ≈ 11.31
    expect(push.nx).toBeCloseTo(8 / dist, 6);
    expect(push.ny).toBeCloseTo(8 / dist, 6);
    expect(push.amount).toBeCloseTo(16 - dist, 6);
  });

  it('mirrors the box-vs-circle push as the negation of circle-vs-box', () => {
    const circle = shape({ shape: 'circle', radius: 16 }, { x: 40, y: 40 });
    const box = shape({ shape: 'box', width: 64, height: 64 }, { x: 0, y: 0 });
    const circleOut = computeShapePush(circle, box)!;
    const boxOut = computeShapePush(box, circle)!;
    expect(boxOut.nx).toBeCloseTo(-circleOut.nx, 6);
    expect(boxOut.ny).toBeCloseTo(-circleOut.ny, 6);
    expect(boxOut.amount).toBeCloseTo(circleOut.amount, 6);
  });

  it('falls back to the AABB axis push when the circle center is inside the box', () => {
    const circle = shape({ shape: 'circle', radius: 16 }, { x: 0, y: 0 });
    const box = shape({ shape: 'box', width: 64, height: 64 }, { x: 0, y: 0 });
    const push = computeShapePush(circle, box)!;
    const expected = computePush(circle.box, box.box)!;
    expect(push).toEqual(expected);
  });
});

describe('circle vs box (runtime): rolling off a corner', () => {
  it('a circle offset from a box edge slides past the corner instead of snagging on top', async () => {
    const { store } = await makeStore({
      entities: [
        ent('Box', {
          Transform: { position: { x: 0, y: 100 } },
          Collider: { shape: 'box', width: 64, height: 64 },
          PhysicsBody: { bodyType: 'static' },
        }),
        ent('Ball', {
          // Box spans x -32..32, y 68..132. Ball center starts at x=40 — 8px
          // right of the box's edge — falling straight down from above.
          Transform: { position: { x: 40, y: 0 } },
          Collider: { shape: 'circle', radius: 16 },
          PhysicsBody: { bodyType: 'dynamic' },
        }),
      ],
    });
    const runtime = await SceneRuntime.create(store, 'Test');
    const ball = runtime.find('Ball')!;
    runtime.run(30);
    // Old AABB-era circle-box resolution would have caught the ball's
    // bounding box on the corner and rested it at x=40, y = 68 - 16 = 52
    // forever. The true circle geometry only grazes the corner there, so
    // gravity keeps pulling it past: it ends up beside the box (cleared the
    // right edge by more than its own radius) and below the box's top edge.
    expect(ball.transform.position.x).toBeGreaterThan(48);
    expect(ball.transform.position.y).toBeGreaterThan(68);
    // Still falling — not snagged at rest on top of the box.
    expect(ball.components.PhysicsBody!.velocity.y).toBeGreaterThan(0);
  });
});
