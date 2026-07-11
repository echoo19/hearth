/**
 * Door: opens (turns green, logs) the first time the player touches it.
 */
export default {
  onCollision(ctx, other) {
    if (!other.tags.includes("player") || ctx.vars.open) return;
    ctx.vars.open = true;
    const sprite = ctx.getComponent("SpriteRenderer");
    if (sprite) sprite.color = "#2ecc71";
    ctx.log("door opened");
  },
};
