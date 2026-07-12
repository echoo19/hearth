-- Top-down player controller (no gravity).
--
-- Four-direction walking: velocity follows the arrow keys on both axes,
-- so diagonal input moves diagonally. The camera follows the player so the
-- room scrolls into view. Tune `speed` from the attachScript params.
--
-- ctx calls use DOT syntax: ctx.log("hi"), never ctx:log("hi").
local script = {}

function script.onStart(ctx)
  ctx.camera.follow("Player")
end

function script.onUpdate(ctx, dt)
  -- dt is the fixed timestep in seconds; unused here because we set
  -- velocity directly and let the physics step integrate position.
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
