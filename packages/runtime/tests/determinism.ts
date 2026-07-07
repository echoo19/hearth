/**
 * Golden determinism harness — shared by goldenDeterminism.test.ts (Task 9)
 * and extended by Task 10/11's broadphase/pooling goldens.
 *
 * Hashes a GameSession's full observable state (entities, camera, particle
 * counts, event totals) into one short digest, so a byte-for-byte behavior
 * change anywhere in the simulation shows up as a changed hash. The perf
 * caches this task adds (and the broadphase/pooling work after it) must
 * reproduce these digests exactly — that's the whole safety story for
 * "behavior must be bit-identical" perf work.
 *
 * Entity ids are Math.random-generated (packages/core/src/ids.ts), so they
 * are NOT part of the hash and must never be: two runs of the same seeded
 * scenario get different ids for the same logical entity. Entities are
 * identified by name and by their position in getEntities()'s stable
 * creation order instead.
 */
import { createHash } from 'node:crypto';
import type { ProjectStore } from '@hearth/core';
import { GameSession } from '../src/session.js';

/**
 * Deterministic stringify: object keys are sorted, so key insertion order
 * never affects the digest (only value order/content does). Arrays keep
 * their order (order is significant there — entity creation order, etc).
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Full observable-state snapshot of a live session, in a form that is
 * stable across re-runs of the SAME scenario/seed (no random ids): every
 * live entity's name/enabled/position/velocity/particle-count (by
 * getEntities() creation-order index, not id), the frame counter, camera
 * state (position/zoom/background/ambient), the persistent camera fade
 * overlay alpha, and exact per-event-name emit totals (session.eventCounts
 * is never truncated, unlike the capped `events`/`logs` lists).
 */
export function stateHash(session: GameSession): string {
  const runtime = session.runtime;
  const entities = runtime.getEntities();
  const rows = entities.map((e, index) => ({
    index,
    name: e.name,
    enabled: e.enabled,
    position: e.transform.position,
    velocity: e.components.PhysicsBody?.velocity ?? null,
    particles: e.components.ParticleEmitter ? runtime.getParticleCount(e.id) : null,
  }));
  const cam = runtime.camera;
  const eventCounts: Record<string, number> = {};
  for (const [name, count] of [...session.eventCounts.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    eventCounts[name] = count;
  }
  const payload = {
    frame: session.frame,
    entities: rows,
    camera: {
      position: cam.position,
      zoom: cam.zoom,
      backgroundColor: cam.backgroundColor,
      ambientLight: cam.ambientLight,
    },
    cameraOverlayAlpha: runtime.cameraEffects.overlay.alpha,
    eventCounts,
  };
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/**
 * Runs `frames` fixed steps of `sceneName` from `store` under `seed` and
 * returns the final stateHash. `store` is never mutated (GameSession /
 * SceneRuntime instantiate a deep copy of the authored scene), so the same
 * store can drive several runHash calls without cross-contamination.
 */
export async function runHash(
  store: ProjectStore,
  sceneName: string,
  frames: number,
  seed: number,
): Promise<string> {
  const session = await GameSession.create(store, { scene: sceneName, seed });
  try {
    for (let i = 0; i < frames; i++) session.step();
    return stateHash(session);
  } finally {
    session.destroy();
  }
}
