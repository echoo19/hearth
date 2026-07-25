/**
 * Respawn + Checkpoint integration: authored spawn-point capture, explicit
 * Respawn.point precedence, velocity reset, and Checkpoint triggers moving a
 * target's respawn point (by name and by tag, with once/enabled honoured).
 *
 * ctx.respawn is reached through a real script (the only public path), fired
 * by runtime.emitEvent so every call lands on a frame the test chose. Movers
 * are repositioned by writing Transform directly between steps so positions
 * are exact integers rather than accumulated float integration.
 */
import { describe, expect, it } from 'vitest';
import { SceneRuntime } from '@hearth/runtime';
import { ent, makeStore } from './helpers.js';

const DRIVER = `export default {
  onStart(ctx) {
    ctx.events.on('cmd', (d) => { if (d.op === 'respawn') ctx.respawn(d.target); });
  },
};`;

/** A dynamic-but-still mover: gravityScale 0 + zero velocity, so it only ever moves where a test puts it. */
const PARKED_BODY = { bodyType: 'dynamic', gravityScale: 0, velocity: { x: 0, y: 0 } };
const BOX = { shape: 'box', width: 32, height: 32 };

async function makeRespawnRuntime(entities: Record<string, unknown>[]): Promise<SceneRuntime> {
  const { store } = await makeStore({
    entities: [...entities, ent('Driver', { Transform: {}, Script: { scriptPath: 'scripts/driver.js' } })],
    scripts: { 'driver.js': DRIVER },
  });
  const runtime = await SceneRuntime.create(store, 'Test');
  runtime.run(1); // phase 0b captures spawn points; Driver.onStart subscribes
  return runtime;
}

const posOf = (rt: SceneRuntime, name: string) => rt.find(name)!.transform.position;
const respawn = (rt: SceneRuntime, target = 'Player') =>
  rt.emitEvent('cmd', { op: 'respawn', target });
/** Teleport a mover, then let one step recompute contacts at the new spot. */
function moveTo(rt: SceneRuntime, name: string, x: number, y: number): void {
  const p = posOf(rt, name);
  p.x = x;
  p.y = y;
}

describe('Respawn.useSpawnPosition', () => {
  it('captures the authored position at start and returns the entity there', async () => {
    const rt = await makeRespawnRuntime([
      ent('Player', { Transform: { position: { x: 10, y: 20 } }, Respawn: {} }),
    ]);
    moveTo(rt, 'Player', 500, -400);
    rt.run(3);
    expect(posOf(rt, 'Player')).toEqual({ x: 500, y: -400 });

    respawn(rt);
    expect(posOf(rt, 'Player')).toEqual({ x: 10, y: 20 });
    expect(rt.errors).toEqual([]);
  });

  it('emits respawned naming the entity', async () => {
    const rt = await makeRespawnRuntime([
      ent('Player', { Transform: { position: { x: 1, y: 2 } }, Respawn: {} }),
    ]);
    respawn(rt);
    expect(rt.events.filter((e) => e.name === 'respawned').map((e) => e.data)).toEqual([
      { entity: 'Player' },
    ]);
  });

  it('captures once, so a later move does not become the new spawn point', async () => {
    const rt = await makeRespawnRuntime([
      ent('Player', { Transform: { position: { x: 10, y: 20 } }, Respawn: {} }),
    ]);
    moveTo(rt, 'Player', 300, 300);
    rt.run(5); // phase 0b must not re-capture an already-known entity
    respawn(rt);
    expect(posOf(rt, 'Player')).toEqual({ x: 10, y: 20 });
  });

  it('throws a named error when useSpawnPosition is off and no point is set', async () => {
    const rt = await makeRespawnRuntime([
      ent('Player', {
        Transform: { position: { x: 10, y: 20 } },
        Respawn: { useSpawnPosition: false, point: null },
      }),
    ]);
    moveTo(rt, 'Player', 99, 99);
    respawn(rt);
    expect(rt.errors.length).toBe(1);
    expect(rt.errors[0].message).toBe(
      'ctx.respawn: "Player" has no respawn point — set Respawn.point or enable useSpawnPosition',
    );
    expect(posOf(rt, 'Player')).toEqual({ x: 99, y: 99 });
  });
});

describe('Respawn.point', () => {
  it('wins over the captured spawn position', async () => {
    const rt = await makeRespawnRuntime([
      ent('Player', {
        Transform: { position: { x: 10, y: 20 } },
        // useSpawnPosition still true, so (10,20) IS captured — point must win.
        Respawn: { point: { x: -50, y: 75 }, useSpawnPosition: true },
      }),
    ]);
    moveTo(rt, 'Player', 500, 500);
    respawn(rt);
    expect(posOf(rt, 'Player')).toEqual({ x: -50, y: 75 });
  });
});

describe('Respawn.resetVelocity', () => {
  it('true zeroes PhysicsBody velocity', async () => {
    const rt = await makeRespawnRuntime([
      ent('Player', {
        Transform: { position: { x: 0, y: 0 } },
        PhysicsBody: { bodyType: 'kinematic', velocity: { x: 50, y: -30 } },
        Respawn: { resetVelocity: true },
      }),
    ]);
    respawn(rt);
    expect(rt.find('Player')!.components.PhysicsBody!.velocity).toEqual({ x: 0, y: 0 });
  });

  it('false preserves PhysicsBody velocity', async () => {
    const rt = await makeRespawnRuntime([
      ent('Player', {
        Transform: { position: { x: 0, y: 0 } },
        PhysicsBody: { bodyType: 'kinematic', velocity: { x: 50, y: -30 } },
        Respawn: { resetVelocity: false },
      }),
    ]);
    respawn(rt);
    // Kinematic: no gravity, no drag, so the exact authored velocity survives.
    expect(rt.find('Player')!.components.PhysicsBody!.velocity).toEqual({ x: 50, y: -30 });
  });
});

describe('ctx.respawn errors', () => {
  it('throws a named error when the entity has no Respawn', async () => {
    const rt = await makeRespawnRuntime([ent('Rock', { Transform: {} })]);
    respawn(rt, 'Rock');
    expect(rt.errors.map((e) => e.message)).toEqual(['ctx.respawn: no Respawn on "Rock"']);
  });

  it('throws a named error for an unknown entity', async () => {
    const rt = await makeRespawnRuntime([ent('Player', { Transform: {}, Respawn: {} })]);
    respawn(rt, 'Ghost');
    expect(rt.errors.map((e) => e.message)).toEqual(['ctx.respawn: entity not found "Ghost"']);
  });
});

/**
 * Checkpoint scene: a parked Player (mover, so trigger pairs are generated)
 * and one static trigger 'Flag' at x=100 carrying Checkpoint(overrides).
 */
async function makeCheckpointRuntime(
  checkpoint: Record<string, unknown>,
  opts: { tags?: string[]; respawn?: Record<string, unknown> } = {},
): Promise<SceneRuntime> {
  return makeRespawnRuntime([
    ent(
      'Player',
      {
        Transform: { position: { x: 0, y: 0 } },
        Collider: BOX,
        PhysicsBody: PARKED_BODY,
        Respawn: opts.respawn ?? {},
      },
      { tags: opts.tags ?? ['player'] },
    ),
    ent('Flag', {
      Transform: { position: { x: 100, y: 0 } },
      Collider: { ...BOX, isTrigger: true },
      Checkpoint: checkpoint,
    }),
  ]);
}

describe('Checkpoint', () => {
  it('overlapping the target replaces the captured spawn point', async () => {
    const rt = await makeCheckpointRuntime({ target: 'Player' });
    // Confirm the pre-checkpoint baseline first, so the assertion below can
    // only pass because the checkpoint actually moved the point.
    respawn(rt);
    expect(posOf(rt, 'Player')).toEqual({ x: 0, y: 0 });

    moveTo(rt, 'Player', 110, 0); // inside the Flag trigger (|dx| = 10 < 32)
    rt.step(); // contacts + applyCheckpoints
    expect(rt.find('Flag')!.collisions.map((c) => c.other.name)).toEqual(['Player']);

    moveTo(rt, 'Player', 900, 900);
    rt.step();
    respawn(rt);
    // The CHECKPOINT's own position (100, 0), not the player's position at the
    // moment of contact (110, 0). Recording the toucher's position would
    // respawn a player who grabbed the checkpoint mid-jump back in mid-air.
    expect(posOf(rt, 'Player')).toEqual({ x: 100, y: 0 });
  });

  it('resolves target by exact entity name', async () => {
    const rt = await makeCheckpointRuntime({ target: 'Player' });
    moveTo(rt, 'Player', 100, 0);
    rt.step();
    moveTo(rt, 'Player', 400, 0);
    respawn(rt);
    expect(posOf(rt, 'Player')).toEqual({ x: 100, y: 0 });
  });

  it('resolves target by "tag:<tag>"', async () => {
    const rt = await makeCheckpointRuntime({ target: 'tag:hero' }, { tags: ['hero'] });
    moveTo(rt, 'Player', 100, 0);
    rt.step();
    moveTo(rt, 'Player', 400, 0);
    respawn(rt);
    expect(posOf(rt, 'Player')).toEqual({ x: 100, y: 0 });
  });

  it('does not fire when the target name/tag does not match', async () => {
    const rt = await makeCheckpointRuntime({ target: 'tag:enemy' }, { tags: ['player'] });
    moveTo(rt, 'Player', 100, 0);
    rt.step();
    moveTo(rt, 'Player', 400, 0);
    respawn(rt);
    expect(posOf(rt, 'Player')).toEqual({ x: 0, y: 0 });
  });

  it('once: false re-records on every overlapping frame, always its own position', async () => {
    const rt = await makeCheckpointRuntime({ target: 'Player', once: false });
    moveTo(rt, 'Player', 90, 0);
    rt.step();
    moveTo(rt, 'Player', 120, 0); // still overlapping (|dx| = 20 < 32)
    rt.step();
    moveTo(rt, 'Player', 900, 0);
    rt.step();
    respawn(rt);
    // Re-recording is idempotent now that the point is the checkpoint's own
    // position: repeated overlaps cannot drift it around with the player.
    expect(posOf(rt, 'Player')).toEqual({ x: 100, y: 0 });
  });

  it('once: true records only the first overlap and ignores later ones', async () => {
    const rt = await makeCheckpointRuntime({ target: 'Player', once: true });
    moveTo(rt, 'Player', 90, 0);
    rt.step();
    moveTo(rt, 'Player', 900, 0);
    rt.step();
    respawn(rt);
    expect(posOf(rt, 'Player')).toEqual({ x: 100, y: 0 });
    // Returning later must not re-arm it. Proven by moving the flag itself and
    // confirming the recorded point does not follow.
    moveTo(rt, 'Flag', 500, 0);
    moveTo(rt, 'Player', 500, 0);
    rt.step();
    moveTo(rt, 'Player', 900, 0);
    respawn(rt);
    expect(posOf(rt, 'Player')).toEqual({ x: 100, y: 0 });
  });

  it('enabled: false is inert', async () => {
    const rt = await makeCheckpointRuntime({ target: 'Player', enabled: false });
    moveTo(rt, 'Player', 100, 0);
    rt.run(3);
    moveTo(rt, 'Player', 400, 0);
    respawn(rt);
    expect(posOf(rt, 'Player')).toEqual({ x: 0, y: 0 });
  });

  it('is inert while the game is paused (no contacts are computed)', async () => {
    const rt = await makeCheckpointRuntime({ target: 'Player' });
    rt.paused = true;
    moveTo(rt, 'Player', 100, 0);
    rt.run(5);
    rt.paused = false;
    moveTo(rt, 'Player', 400, 0);
    respawn(rt);
    expect(posOf(rt, 'Player')).toEqual({ x: 0, y: 0 });
  });

  it('skips a target with no Respawn component', async () => {
    const rt = await makeRespawnRuntime([
      ent('Player', {
        Transform: { position: { x: 0, y: 0 } },
        Collider: BOX,
        PhysicsBody: PARKED_BODY,
      }),
      ent('Flag', {
        Transform: { position: { x: 100, y: 0 } },
        Collider: { ...BOX, isTrigger: true },
        Checkpoint: { target: 'Player' },
      }),
    ]);
    moveTo(rt, 'Player', 100, 0);
    rt.step();
    respawn(rt);
    // No Respawn: the checkpoint recorded nothing and ctx.respawn still refuses.
    expect(rt.errors.map((e) => e.message)).toEqual(['ctx.respawn: no Respawn on "Player"']);
  });

  it('a reached checkpoint overrides an explicit Respawn.point', async () => {
    const rt = await makeCheckpointRuntime(
      { target: 'Player' },
      { respawn: { point: { x: -7, y: -7 } } },
    );
    // Before touching anything, the authored point is where respawn goes.
    respawn(rt);
    expect(posOf(rt, 'Player')).toEqual({ x: -7, y: -7 });

    moveTo(rt, 'Player', 100, 0);
    rt.step();
    moveTo(rt, 'Player', 400, 0);
    respawn(rt);
    // Precedence is checkpoint > authored point > captured spawn, so the two
    // features compose. If the authored point won, declaring a level's starting
    // point would silently switch every checkpoint in that level off.
    expect(posOf(rt, 'Player')).toEqual({ x: 100, y: 0 });
  });

  it('records a spawn point even when useSpawnPosition is off', async () => {
    const rt = await makeCheckpointRuntime(
      { target: 'Player' },
      { respawn: { useSpawnPosition: false } },
    );
    moveTo(rt, 'Player', 100, 0);
    rt.step();
    moveTo(rt, 'Player', 400, 0);
    respawn(rt);
    // Nothing was captured at start, so the checkpoint is the only source —
    // "checkpoints only" is a valid authoring setup.
    expect(posOf(rt, 'Player')).toEqual({ x: 100, y: 0 });
    expect(rt.errors).toEqual([]);
  });
});
