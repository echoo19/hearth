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
    // 2. Expire.
    for (let i = this.particles.length - 1; i >= 0; i--) {
      if (this.particles[i].age >= this.particles[i].lifetime) this.particles.splice(i, 1);
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
    this.particles.push({
      x: origin.x,
      y: origin.y,
      vx: Math.cos(angle) * emitter.speed,
      vy: Math.sin(angle) * emitter.speed,
      age: 0,
      lifetime: emitter.lifetime,
    });
  }

  private enforceCap(max: number): void {
    while (this.particles.length > max) this.particles.shift(); // oldest first
  }
}
