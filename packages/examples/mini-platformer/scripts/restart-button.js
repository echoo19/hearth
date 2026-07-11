/**
 * Restart button (screen-space UI): clicking it resets the score and puts
 * the player back at the start. Requires UIElement.interactive = true.
 */
export default {
  onUiEvent(ctx, event) {
    if (event.type !== "click") return;
    const player = ctx.scene.find("Player");
    if (player) {
      player.transform.position.x = 120;
      player.transform.position.y = 380;
      const body = player.getComponent("PhysicsBody");
      body.velocity.x = 0;
      body.velocity.y = 0;
    }
    const score = ctx.scene.find("Score");
    if (score) score.getComponent("Text").content = "Score: 0";
    ctx.audio.play("click-sound");
    ctx.log("game restarted");
  },
};
