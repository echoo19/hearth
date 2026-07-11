/**
 * NPC: when the player is near and presses "action", show a line of
 * dialogue in the DialogueText entity. params: line, radius
 */
export default {
  onUpdate(ctx) {
    const player = ctx.scene.find("Player");
    const label = ctx.scene.find("DialogueText");
    if (!player || !label) return;
    const dx = player.transform.position.x - ctx.transform.position.x;
    const dy = player.transform.position.y - ctx.transform.position.y;
    const near = Math.hypot(dx, dy) < (ctx.params.radius ?? 70);
    const text = label.getComponent("Text");
    if (near && ctx.input.justPressed("action")) {
      text.content = ctx.params.line ?? "Hello, traveler!";
      ctx.vars.spoken = true;
      ctx.log("npc spoke");
    } else if (!near && ctx.vars.spoken) {
      text.content = "Find the keeper. Press E to talk.";
      ctx.vars.spoken = false;
    }
  },
};
