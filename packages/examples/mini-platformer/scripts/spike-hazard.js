/**
 * Spikes: touching them plays the hit sound and sends the player back to its
 * respawn point. The collider is a convex polygon (a triangle).
 *
 * ctx.respawn reads the point off the player's own Respawn component, so the
 * spawn coordinates live in exactly one place instead of being copied into
 * every hazard.
 */
export default {
  onCollision(ctx, other) {
    if (!other.tags.includes("player")) return;
    ctx.respawn(other);
    ctx.audio.play("hit-sound");
  },
};
