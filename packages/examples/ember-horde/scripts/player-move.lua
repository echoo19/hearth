-- Player: direct velocity-follows-axis movement (no drift/easing — a
-- horde needs snappy, predictable dodging, not momentum). Contact with an
-- Enemy costs HP on a cooldown (so a stack of enemies all touching at
-- once doesn't drain it in one frame), updates the HP HUD, and — gated by
-- the pause menu's live Screen Shake toggle value, read directly with no
-- mirror state (same idiom as drift-cellar's wall-bump handler) — shakes
-- the camera and bursts this entity's own pooled ParticleEmitter.
-- Reminder: ctx calls use DOT syntax (ctx.log("hi"), never ctx:log("hi")).
local script = {}

function script.onStart(ctx)
  ctx.vars.hp = ctx.params.maxHp or 100
  ctx.vars.lastHit = -1
  ctx.vars.paused = false
  ctx.vars.hpHud = ctx.scene.find("HP HUD")
end

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")
  if ctx.vars.paused then
    body.velocity.x = 0
    body.velocity.y = 0
    return
  end
  local speed = ctx.params.speed or 170
  body.velocity.x = ctx.input.axis("moveX") * speed
  body.velocity.y = ctx.input.axis("moveY") * speed
end

function script.onCollision(ctx, other)
  if ctx.vars.paused then return end
  if other.name ~= "Enemy" then return end
  if ctx.vars.hp <= 0 then return end
  local now = ctx.time.elapsed
  local cooldown = ctx.params.hitCooldown or 0.4
  if now - ctx.vars.lastHit < cooldown then return end
  ctx.vars.lastHit = now
  ctx.vars.hp = math.max(0, ctx.vars.hp - (ctx.params.contactDamage or 8))
  if ctx.vars.hpHud then
    ctx.vars.hpHud.getComponent("Text").content = string.format("HP: %d", ctx.vars.hp)
  end
  ctx.events.emit("player-hit", { hp = ctx.vars.hp })
  local toggle = ctx.scene.find("Screen Shake")
  if toggle and toggle.getComponent("UIToggle").value then
    ctx.camera.shake(6, 0.2)
  end
  ctx.particles.burst(16)
end

function script.onEvent(ctx, name)
  if name == "pause" then
    ctx.vars.paused = true
  elseif name == "resume" then
    ctx.vars.paused = false
  end
end

return script
