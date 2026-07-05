-- Courier: left/right walk + jump (isGrounded-gated), switching the
-- SpriteAnimator between the walk and idle clips via ctx.animate based on
-- horizontal speed. ctx.animate restarts the clip at frame 0, so it's only
-- called when the desired clip actually changes -- calling it every frame
-- while walking would restart the gait constantly instead of playing it.
-- Reminder: ctx calls use DOT syntax (ctx.log("hi"), never ctx:log("hi")).
local script = {}

function script.onStart(ctx)
  ctx.vars.clip = "idle"
  ctx.vars.spawnX = ctx.transform.position.x
  ctx.vars.spawnY = ctx.transform.position.y
end

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")
  local sprite = ctx.getComponent("SpriteRenderer")
  local speed = ctx.params.speed or 170

  local vx = 0
  if ctx.input.isDown("left") then vx = vx - speed end
  if ctx.input.isDown("right") then vx = vx + speed end
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

  local moving = math.abs(vx) > 1
  local wantClip = moving and "walk" or "idle"
  if ctx.vars.clip ~= wantClip then
    ctx.vars.clip = wantClip
    ctx.animate(wantClip == "walk" and "courier-walk" or "courier-idle")
  end

  -- Missed a jump and fell past the rooftops: back to the start.
  if ctx.transform.position.y > 700 then
    ctx.transform.position.x = ctx.vars.spawnX
    ctx.transform.position.y = ctx.vars.spawnY
    body.velocity.x = 0
    body.velocity.y = 0
  end
end

return script
