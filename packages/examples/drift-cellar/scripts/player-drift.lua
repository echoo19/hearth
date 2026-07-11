-- Drifter: analog movement on the moveX/moveY virtual axes
-- (ctx.input.axis reads the gamepad stick, or the WASD/arrow fallback
-- codes, or a playtest setAxis override — all in [-1, 1]). Velocity eases
-- toward the axis target each frame, so motion keeps momentum and slides:
-- the "drift". Dash (Space / gamepad "a") kicks velocity along the current
-- axis direction and punches the camera zoom. Wall bumps flash the screen
-- and, only while the pause menu's Screen Shake toggle is on (its live
-- UIToggle.value IS the setting — read directly, no mirror state), shake
-- the camera. The pause/resume events from the menu controller gate
-- everything. Reminder: ctx calls use DOT syntax (ctx.log("hi")).
local script = {}

function script.onStart(ctx)
  ctx.vars.paused = false
  ctx.vars.lastBump = -1
  ctx.vars.speedInto = 0
end

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")
  if ctx.vars.paused then
    body.velocity.x = 0
    body.velocity.y = 0
    return
  end

  local speed = ctx.params.speed or 240
  local drift = ctx.params.drift or 0.12
  local ax = ctx.input.axis("moveX")
  local ay = ctx.input.axis("moveY")
  body.velocity.x = ctx.math.lerp(body.velocity.x, ax * speed, drift)
  body.velocity.y = ctx.math.lerp(body.velocity.y, ay * speed, drift)

  if ctx.input.justPressed("dash") and (ax ~= 0 or ay ~= 0) then
    local dir = ctx.math.normalize({ x = ax, y = ay })
    local boost = ctx.params.dashBoost or 420
    body.velocity.x = body.velocity.x + dir.x * boost
    body.velocity.y = body.velocity.y + dir.y * boost
    ctx.camera.zoomPunch(1.12, 0.25)
    ctx.audio.play("dash-sound", { volume = 0.6 })
  end

  -- Remember this frame's speed: onCollision runs after physics has
  -- already absorbed the impact, so the bump check below needs the
  -- pre-impact speed to tell a slam from a slow graze.
  ctx.vars.speedInto = ctx.math.length({ x = body.velocity.x, y = body.velocity.y })
end

function script.onCollision(ctx, other)
  if string.sub(other.name, 1, 4) ~= "Wall" then
    return
  end
  if ctx.vars.speedInto < 80 then
    return
  end
  local now = ctx.time.elapsed
  if now - ctx.vars.lastBump < 0.5 then
    return
  end
  ctx.vars.lastBump = now
  ctx.camera.flash("#b7f0ff", 0.15)
  local toggle = ctx.scene.find("Screen Shake")
  if toggle and toggle.getComponent("UIToggle").value then
    ctx.camera.shake(7, 0.25)
  end
  ctx.audio.play("bump-sound", { volume = 0.5 })
end

function script.onEvent(ctx, name)
  if name == "pause" then
    ctx.vars.paused = true
  elseif name == "resume" then
    ctx.vars.paused = false
  end
end

return script
