/**
 * Platformer player: left/right movement, jump when grounded, respawn on fall.
 * params: speed (px/s), jumpSpeed (px/s)
 */
export default {
  onStart(ctx) {
    ctx.vars.spawnX = ctx.transform.position.x;
    ctx.vars.spawnY = ctx.transform.position.y;
  },

  onUpdate(ctx, dt) {
    const body = ctx.getComponent("PhysicsBody");
    const speed = ctx.params.speed ?? 220;
    let vx = 0;
    if (ctx.input.isDown("left")) vx -= speed;
    if (ctx.input.isDown("right")) vx += speed;
    body.velocity.x = vx;

    if (ctx.input.justPressed("jump") && ctx.isGrounded()) {
      body.velocity.y = -(ctx.params.jumpSpeed ?? 460);
      ctx.audio.play("jump-sound", { volume: 0.8 });
    }

    // Fell off the world: respawn at the starting point.
    if (ctx.transform.position.y > 900) {
      ctx.transform.position.x = ctx.vars.spawnX;
      ctx.transform.position.y = ctx.vars.spawnY;
      body.velocity.x = 0;
      body.velocity.y = 0;
      ctx.log("player respawned");
    }
  },
};
