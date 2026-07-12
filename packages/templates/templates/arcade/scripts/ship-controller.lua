-- Arcade ship controller.
--
-- Moves the ship on all four directions (fixed camera — the ship, not the
-- world, moves). Pressing "jump" fires one bullet straight up: the bullet
-- is spawned at runtime with ctx.scene.spawn and carries its own bullet.lua
-- script, so shooting adds a real, self-contained entity to the scene.
--
-- ctx calls use DOT syntax: ctx.log("hi"), never ctx:log("hi").
local script = {}

function script.onStart(ctx)
  ctx.vars.shots = 0
end

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")
  local speed = ctx.params.speed or 200

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

  -- Fire on the frame the key goes down (not while held): one bullet each.
  if ctx.input.justPressed("jump") then
    ctx.vars.shots = ctx.vars.shots + 1
    ctx.scene.spawn({
      name = string.format("Bullet %d", ctx.vars.shots),
      position = { x = ctx.transform.position.x, y = ctx.transform.position.y - 22 },
      tags = { "bullet" },
      components = {
        SpriteRenderer = { shape = "rectangle", color = "#ffe08a", width = 6, height = 16 },
        Collider = { shape = "box", width = 6, height = 16 },
        PhysicsBody = { bodyType = "dynamic", gravityScale = 0 },
        Script = {
          scriptPath = "scripts/bullet.lua",
          params = { speed = ctx.params.bulletSpeed or 420 },
        },
      },
    })
  end
end

return script
