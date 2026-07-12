-- Platformer player controller.
--
-- Reads the "left"/"right"/"jump" input actions each frame and drives a
-- dynamic PhysicsBody: horizontal velocity follows the arrow keys, and a
-- jump impulse fires only while grounded. Falling off the bottom of the
-- world respawns the player at its start position. Tune the numbers from
-- the attachScript params (speed, jumpSpeed) — no code change needed.
--
-- ctx calls use DOT syntax: ctx.log("hi"), never ctx:log("hi").
local script = {}

function script.onStart(ctx)
  -- Remember the spawn point so a fall can send us back to it.
  ctx.vars.spawnX = ctx.transform.position.x
  ctx.vars.spawnY = ctx.transform.position.y
  ctx.camera.follow("Player")
end

function script.onUpdate(ctx, dt)
  -- dt is the fixed timestep in seconds; unused here because we set
  -- velocity directly and let the physics step integrate position.
  local body = ctx.getComponent("PhysicsBody")
  local speed = ctx.params.speed or 220

  -- Horizontal movement: set velocity.x directly; gravity handles y.
  local vx = 0
  if ctx.input.isDown("left") then
    vx = vx - speed
  end
  if ctx.input.isDown("right") then
    vx = vx + speed
  end
  body.velocity.x = vx

  -- Jump: only when standing on solid ground (ctx.isGrounded).
  if ctx.input.justPressed("jump") and ctx.isGrounded() then
    body.velocity.y = -(ctx.params.jumpSpeed or 460)
  end

  -- Fell off the world: respawn at the start.
  if ctx.transform.position.y > 900 then
    ctx.transform.position.x = ctx.vars.spawnX
    ctx.transform.position.y = ctx.vars.spawnY
    body.velocity.x = 0
    body.velocity.y = 0
  end
end

return script
