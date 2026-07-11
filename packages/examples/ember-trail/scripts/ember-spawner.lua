-- Spawner: every params.interval seconds, spawns an ember at a
-- seeded-random spot (ctx.random is deterministic — a playtest seed
-- reproduces the exact same run). Each ember despawns after
-- params.lifetime seconds unless the player collects it first.
local script = {}

function script.onStart(ctx)
  local count = 0
  ctx.timers.every(ctx.params.interval or 1.2, function()
    count = count + 1
    local name = string.format("Ember %d", count)
    local x = ctx.random.range(80, 720)
    local y = ctx.random.range(80, 240)
    ctx.log("spawned", name, "at", x, y)
    ctx.scene.spawn({
      name = name,
      position = { x = x, y = y },
      tags = { "ember" },
      components = {
        SpriteRenderer = { assetId = ctx.params.emberAsset, width = 18, height = 18 },
        Collider = { shape = "circle", radius = 12, isTrigger = true },
      },
    })
    ctx.timers.after(ctx.params.lifetime or 4, function()
      local e = ctx.scene.find(name)
      if e then
        ctx.scene.destroy(e)
      end
    end)
  end)
end

return script
