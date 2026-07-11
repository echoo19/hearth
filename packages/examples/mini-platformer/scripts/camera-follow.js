/**
 * Camera: follow the player horizontally, clamped so the level start stays visible.
 */
export default {
  onUpdate(ctx) {
    const player = ctx.scene.find("Player");
    if (!player) return;
    ctx.transform.position.x = Math.max(400, player.transform.position.x);
  },
};
