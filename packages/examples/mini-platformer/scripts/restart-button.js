/**
 * Restart button (screen-space UI): clicking it resets the score and puts the
 * player back at its respawn point. Requires UIElement.interactive = true.
 */
export default {
  onUiEvent(ctx, event) {
    if (event.type !== "click") return;
    const player = ctx.scene.find("Player");
    if (player) ctx.respawn(player);
    ctx.state.reset("score");
    ctx.audio.play("click-sound");
  },
};
