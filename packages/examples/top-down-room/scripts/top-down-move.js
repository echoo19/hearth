/**
 * Four-direction movement (no gravity). params: speed (px/s)
 */
export default {
  onUpdate(ctx) {
    const body = ctx.getComponent("PhysicsBody");
    const speed = ctx.params.speed ?? 180;
    let vx = 0;
    let vy = 0;
    if (ctx.input.isDown("left")) vx -= speed;
    if (ctx.input.isDown("right")) vx += speed;
    if (ctx.input.isDown("up")) vy -= speed;
    if (ctx.input.isDown("down")) vy += speed;
    body.velocity.x = vx;
    body.velocity.y = vy;
  },
};
