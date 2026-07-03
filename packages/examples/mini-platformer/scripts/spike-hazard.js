/**
 * Spikes: touching them plays the hit sound and sends the player back to
 * the start. The collider is a convex polygon (a triangle).
 */
export default {
  onCollision(ctx, other) {
    if (!other.tags.includes('player')) return;
    other.transform.position.x = 120;
    other.transform.position.y = 380;
    const body = other.getComponent('PhysicsBody');
    body.velocity.x = 0;
    body.velocity.y = 0;
    ctx.audio.play('hit-sound');
    ctx.log('player hit spikes');
  },
};
