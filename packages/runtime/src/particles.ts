/**
 * Headless particle simulation for ParticleEmitter entities.
 *
 * One EmitterState per emitter entity, seeded from the emitter's own `seed`
 * field (not the session/runtime seed) so particle streams are reproducible
 * regardless of what else in the scene consumes ctx.random. Deterministic:
 * no Math.random, no Date.now — everything derives from the fixed dt and
 * the seeded RNG.
 */
import type { ParticleEmitterComponent, Vec2 } from '@hearth/core';
import { createRng } from './stdlib.js';

const DEG_TO_RAD = Math.PI / 180;

export interface Particle {
  x: number;
  y: number; // world space
  vx: number;
  vy: number;
  age: number; // seconds
  lifetime: number;
}

export class EmitterState {
  readonly particles: Particle[] = [];
  /** Whether the one-time scene-start burst has fired (set by the runtime). */
  autoBurstFired = false;
  private spawnAccumulator = 0;
  private readonly rng: () => number;
  /**
   * Free-list of detached Particle objects from expired/evicted slots,
   * reused by spawnOne instead of allocating fresh objects every spawn.
   * Capped at the emitter's maxParticles (see releaseToPool) so a burst of
   * cap changes can't let this grow unbounded. Liveness/order is entirely
   * owned by `particles` (splice/shift, unchanged) — this pool never
   * participates in iteration order, only object reuse.
   */
  private readonly pool: Particle[] = [];

  constructor(seed: number) {
    this.rng = createRng(seed);
  }

  /** Advance one fixed step: spawn from rate, integrate, expire, cap. */
  step(dt: number, emitter: ParticleEmitterComponent, origin: Vec2): void {
    // 1. Age + integrate existing particles (gravity is acceleration).
    for (const p of this.particles) {
      p.age += dt;
      p.vx += emitter.gravity.x * dt;
      p.vy += emitter.gravity.y * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    // 2. Expire. splice() preserves the relative order of surviving
    // particles exactly (iterating in reverse so earlier indices are
    // unaffected by later removals) — pixi rendering and golden hashes
    // depend on that order staying stable.
    for (let i = this.particles.length - 1; i >= 0; i--) {
      if (this.particles[i].age >= this.particles[i].lifetime) {
        const [expired] = this.particles.splice(i, 1);
        this.releaseToPool(expired, emitter.maxParticles);
      }
    }
    // 3. Spawn from rate.
    if (emitter.emitting && emitter.rate > 0) {
      this.spawnAccumulator += emitter.rate * dt;
      while (this.spawnAccumulator >= 1) {
        this.spawnAccumulator -= 1;
        this.spawnOne(emitter, origin);
      }
    }
    this.enforceCap(emitter.maxParticles);
  }

  /** Spawn `count` particles immediately at origin using emitter params. */
  burst(count: number, emitter: ParticleEmitterComponent, origin: Vec2): void {
    for (let i = 0; i < count; i++) this.spawnOne(emitter, origin);
    this.enforceCap(emitter.maxParticles);
  }

  private spawnOne(emitter: ParticleEmitterComponent, origin: Vec2): void {
    const angle =
      (emitter.direction + (this.rng() * 2 - 1) * emitter.spread) * DEG_TO_RAD;
    const x = origin.x;
    const y = origin.y;
    const vx = Math.cos(angle) * emitter.speed;
    const vy = Math.sin(angle) * emitter.speed;
    const age = 0;
    const lifetime = emitter.lifetime;
    const reused = this.pool.pop();
    if (reused) {
      // Reusing a pooled object: every Particle field must be overwritten
      // here (there are exactly six — x, y, vx, vy, age, lifetime) or a
      // stale value from the object's previous life leaks into this
      // particle, which would be a silent determinism bug.
      reused.x = x;
      reused.y = y;
      reused.vx = vx;
      reused.vy = vy;
      reused.age = age;
      reused.lifetime = lifetime;
      this.particles.push(reused);
    } else {
      this.particles.push({ x, y, vx, vy, age, lifetime });
    }
  }

  private enforceCap(max: number): void {
    while (this.particles.length > max) {
      const evicted = this.particles.shift(); // oldest first
      if (evicted) this.releaseToPool(evicted, max);
    }
  }

  /** Detach a particle object into the free-list, capped at maxParticles. */
  private releaseToPool(p: Particle, maxParticles: number): void {
    if (this.pool.length < maxParticles) this.pool.push(p);
  }
}
