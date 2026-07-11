-- Player: four-direction movement (no gravity — physics is reserved
-- for the bouncing Ball and the kinematic Patroller). Friction 0.6 lives
-- on this entity's PhysicsBody component, not in the script.
-- Reminder: ctx calls use DOT syntax (ctx.log("hi"), never ctx:log("hi")).
local script = {}

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")
  local speed = ctx.params.speed or 180
  local vx, vy = 0, 0
  if ctx.input.isDown("left") then
    vx = vx - speed
  end
  if ctx.input.isDown("right") then
    vx = vx + speed
  end
  if ctx.input.isDown("up") then
    vy = vy - speed
  end
  if ctx.input.isDown("down") then
    vy = vy + speed
  end
  body.velocity.x = vx
  body.velocity.y = vy
end

return script
