-- Player: four-direction movement through the cave (no gravity).
-- The camera follows so the torch's pool of light stays in view.
local script = {}

function script.onStart(ctx)
  ctx.camera.follow("Player")
end

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")
  local speed = ctx.params.speed or 160
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
