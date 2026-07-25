/**
 * Coin: when the player touches it, add to the score, play the pickup sound,
 * and disappear. The score lives in declared game state and the HUD Text is
 * bound to it, so nothing here has to find or format a label.
 */
export default {
  onCollision(ctx, other) {
    if (!other.tags.includes("player")) return;
    ctx.state.add("score", 1);
    ctx.audio.play("coin-sound");
    ctx.destroySelf();
  },
};
