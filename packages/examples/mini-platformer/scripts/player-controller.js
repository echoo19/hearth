/**
 * Everything specific to THIS player. Movement, jump arc, coyote time and the
 * respawn point are configured on the CharacterController and Respawn
 * components, so this script only holds what the engine cannot know: which
 * sound a jump makes, and that falling past y=900 counts as dying.
 */
export default {
  onEvent(ctx, name, data) {
    if (name === "jumped" && data.entity === ctx.entity.name) {
      ctx.audio.play("jump-sound", { volume: 0.8 });
    }
  },

  onUpdate(ctx) {
    if (ctx.transform.position.y > 900) ctx.respawn(ctx.entity);
  },
};
