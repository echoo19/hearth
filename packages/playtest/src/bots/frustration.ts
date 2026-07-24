/**
 * Frustration signals — the shared primitives behind fade-softlock and wall-bump.
 *
 * These read state the runtime already computes every frame (camera overlay,
 * entity collisions); the detectors that use them live in run.ts, where the loop
 * has the avatar and camera in hand.
 */
import type { RuntimeCollision } from '@hearth/runtime';

/** Fraction of a stall window that must be wall contact before it reads as a bump. */
const WALL_BUMP_FRACTION = 0.6;
/** Overlay alpha at/above which the screen is effectively black — a fade that never lifted. */
export const FADE_OPAQUE_ALPHA = 0.95;

/**
 * Whether an entity is pressed against a wall or ceiling — a solid contact whose
 * normal is NOT ground support. Ground contacts (normal.y < -0.5, the same test
 * ctx.isGrounded uses) and trigger overlaps (pickups, sensors) are excluded, so a
 * platformer avatar simply standing on the floor never counts.
 */
export function nonSupportingContact(entity: { collisions: RuntimeCollision[] }): boolean {
  return entity.collisions.some((c) => !c.trigger && c.normal.y >= -0.5);
}

/** Whether wall contact dominated the stall window enough to call it a wall-bump. */
export function isWallBump(wallFramesInStall: number, stuckAfter: number): boolean {
  if (stuckAfter <= 0) return false;
  return wallFramesInStall / stuckAfter >= WALL_BUMP_FRACTION;
}
