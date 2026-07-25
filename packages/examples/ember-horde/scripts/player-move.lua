-- Player: only what is specific to THIS game.
--
-- Movement is gone from here. The CharacterController reads the analog
-- moveX/moveY axes directly, so a half-pushed stick still moves at half
-- speed, and it clamps a diagonal to one speed (this script did not, so a
-- keyboard diagonal used to travel at speed x sqrt(2)).
--
-- The HP number, its clamp and the 24-frame post-hit immunity live on the
-- Health component; contact just calls ctx.health.damage. Health owns no
-- visuals, so the shake (gated by the pause menu's live Screen Shake toggle,
-- read directly with no mirror state) and the particle burst hang off the
-- "damaged" event it emits. The HP HUD is bound to game state, so nothing
-- here touches a label.
-- Reminder: ctx calls use DOT syntax (ctx.log("hi"), never ctx:log("hi")).
local script = {}

function script.onCollision(ctx, other)
  -- Tag-, not name-, based: "Elite Enemy" (a tinted prefab instance, still
  -- tagged "enemy") must hurt on contact exactly like every other enemy.
  if not other.tags.includes("enemy") then
    return
  end
  -- At 0 HP this game stops hurting the player rather than killing them
  -- (Health.deathAction is event-only), so stop re-firing the hit visuals.
  if ctx.health.get(ctx.entity.id).current <= 0 then
    return
  end
  ctx.health.damage(ctx.entity.id, ctx.params.contactDamage or 8)
end

function script.onEvent(ctx, name, data)
  if name ~= "damaged" then
    return
  end
  ctx.state.set("hp", data.current)
  local toggle = ctx.scene.find("Screen Shake")
  if toggle and toggle.getComponent("UIToggle").value then
    ctx.camera.shake(6, 0.2)
  end
  ctx.particles.burst(16)
end

return script
