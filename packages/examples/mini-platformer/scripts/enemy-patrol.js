/**
 * Enemy: patrols horizontally around its origin; touching it sends the
 * player back to spawn. params: range (px), speed (px/s)
 */
export default {
  onStart(ctx) {
    ctx.vars.dir = 1;
    ctx.vars.originX = ctx.transform.position.x;
  },

  onUpdate(ctx, dt) {
    const range = ctx.params.range ?? 120;
    const speed = ctx.params.speed ?? 70;
    ctx.transform.position.x += ctx.vars.dir * speed * dt;
    if (Math.abs(ctx.transform.position.x - ctx.vars.originX) > range) {
      ctx.vars.dir *= -1;
    }
  },

  onCollision(ctx, other) {
    if (!other.tags.includes('player')) return;
    other.transform.position.x = 120;
    other.transform.position.y = 380;
    ctx.log('player hit by enemy');
  },
};
