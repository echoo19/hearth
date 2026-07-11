-- Player: four-direction movement (no gravity), collects embers on
-- contact, and ends the run after params.duration seconds — saving the
-- best score (ctx.save) and returning to the menu (ctx.scenes.load).
local script = {}

local function endRun(ctx)
  local score = ctx.vars.score or 0
  local best = ctx.load("best")
  if type(best) ~= "number" then
    best = 0
  end
  if score > best then
    best = score
  end
  ctx.save("best", best)
  ctx.scenes.load("Menu")
end

function script.onStart(ctx)
  ctx.vars.score = 0
  ctx.camera.follow("Player")
  ctx.timers.after(ctx.params.duration or 20, function()
    endRun(ctx)
  end)
end

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")
  local speed = ctx.params.speed or 220
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

function script.onCollision(ctx, other)
  if string.sub(other.name, 1, 6) ~= "Ember " then
    return
  end
  ctx.scene.destroy(other)
  ctx.vars.score = (ctx.vars.score or 0) + 1
  ctx.audio.play("ember-sound", { volume = 0.8 })
  local hud = ctx.scene.find("Score")
  if hud then
    hud.getComponent("Text").content = string.format("Embers: %d", ctx.vars.score)
  end
end

return script
