-- Player: direct velocity-follows-axis movement — snappy arcade
-- controls, no drift/easing. Targets react to touching the player (see
-- target-hit.lua); this script only handles movement.
local script = {}

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")
  local speed = ctx.params.speed or 200
  body.velocity.x = ctx.input.axis("moveX") * speed
  body.velocity.y = ctx.input.axis("moveY") * speed
end

return script
