-- Courier: left/right walk + jump (isGrounded-gated). Idle/walk animation
-- is owned by an AnimationStateMachine (assets/statemachines/courier-motion
-- .asm.json) via its "moving" bool param, set every frame below --
-- ctx.animator.setParam is cheap and idempotent, and the machine only
-- restarts a clip when it actually transitions to a different state, so
-- this doesn't reset the gait each frame the way an unconditional
-- ctx.animate() call would have.
-- Reminder: ctx calls use DOT syntax (ctx.log("hi"), never ctx:log("hi")).
local script = {}

function script.onStart(ctx)
  ctx.vars.spawnX = ctx.transform.position.x
  ctx.vars.spawnY = ctx.transform.position.y
end

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")
  local sprite = ctx.getComponent("SpriteRenderer")
  local speed = ctx.params.speed or 170

  local vx = 0
  if ctx.input.isDown("left") then
    vx = vx - speed
  end
  if ctx.input.isDown("right") then
    vx = vx + speed
  end
  body.velocity.x = vx

  if ctx.input.justPressed("jump") and ctx.isGrounded() then
    body.velocity.y = -(ctx.params.jumpSpeed or 480)
    ctx.audio.play("jump-sound", { volume = 0.7 })
  end

  if vx < 0 then
    sprite.flipX = true
  elseif vx > 0 then
    sprite.flipX = false
  end

  ctx.animator.setParam(ctx.entity.name, "moving", math.abs(vx) > 1)

  -- Missed a jump and fell past the rooftops: back to the start.
  if ctx.transform.position.y > 700 then
    ctx.transform.position.x = ctx.vars.spawnX
    ctx.transform.position.y = ctx.vars.spawnY
    body.velocity.x = 0
    body.velocity.y = 0
  end
end

return script
