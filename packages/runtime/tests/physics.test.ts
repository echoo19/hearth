/**
 * Physics: gravity, ground settling, kinematic movement, drag, triggers,
 * tilemap colliders, and dynamic-vs-dynamic separation.
 */
import { describe, it, expect } from 'vitest';
import { SceneRuntime } from '@hearth/runtime';
import { makeStore, ent } from './helpers.js';

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
