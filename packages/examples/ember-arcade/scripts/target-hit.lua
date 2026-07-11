-- Target: on first contact with the Player, flashes (ctx.effects.flash —
-- SpriteEffects.flashStrength decays deterministically toward 0 over
-- flashDuration seconds, no RNG involved) and dissolves out over
-- dissolveSeconds by driving SpriteEffects.dissolveAmount from 0 to 1,
-- then removes itself with ctx.scene.destroy. ctx.vars.hit guards against
-- a lingering trigger overlap re-firing the sequence.
local script = {}

function script.onStart(ctx)
  ctx.vars.hit = false
  ctx.vars.dissolveElapsed = 0
end

function script.onCollision(ctx, other)
  if ctx.vars.hit or other.name ~= "Player" then return end
  ctx.vars.hit = true
  ctx.effects.flash(ctx.params.flashColor or "#fff4d6", ctx.params.flashSeconds or 0.2)
  ctx.audio.play("hit-sound", { volume = 0.6 })
  ctx.events.emit("target-hit")
end

function script.onUpdate(ctx, dt)
  if not ctx.vars.hit then return end
  ctx.vars.dissolveElapsed = ctx.vars.dissolveElapsed + dt
  local duration = ctx.params.dissolveSeconds or 0.5
  local fx = ctx.getComponent("SpriteEffects")
  fx.dissolveAmount = math.min(1, ctx.vars.dissolveElapsed / duration)
  if ctx.vars.dissolveElapsed >= duration then
    ctx.audio.play("pop-sound", { volume = 0.5 })
    ctx.scene.destroy(ctx.entity.id)
  end
end

return script
