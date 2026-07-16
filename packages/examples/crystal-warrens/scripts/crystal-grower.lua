-- Grows glow crystals once the warrens exist. Listens for the carver's
-- "warrens-carved" event, re-derives the SAME cave field from the shared
-- lib/noise module using the seed in the payload (derive-from-seed instead
-- of reading the grid back), and plants a crystal wherever a second noise
-- field peaks inside an open tunnel cell. Same library, second consumer —
-- the code reuse script modules exist for.
local noise = require("lib/noise")

local script = {}

local TILE = 32
local COLS = 25
local ROWS = 19
local MAX_CRYSTALS = 12
local PEAK = 0.72

function script.onEvent(ctx, name, data)
  if name ~= "warrens-carved" or ctx.vars.grown then
    return
  end
  ctx.vars.grown = true
  local seed = data.seed
  local count = 0
  for r = 1, ROWS - 2 do
    for c = 1, COLS - 2 do
      if
        count < MAX_CRYSTALS
        and noise.caveOpen(c, r, seed)
        and noise.value2(c * 0.9, r * 0.9, seed + 777) > PEAK
      then
        count = count + 1
        ctx.scene.spawn({
          name = "Crystal " .. count,
          position = { x = c * TILE + TILE / 2, y = r * TILE + TILE / 2 },
          tags = { "crystal" },
          components = {
            SpriteRenderer = {
              shape = "triangle",
              color = "#7ee8fa",
              width = 16,
              height = 20,
              layer = 5,
            },
            Light2D = { radius = 70, color = "#7ee8fa", intensity = 0.9 },
          },
        })
      end
    end
  end
  ctx.scene.find("Crystal HUD").getComponent("Text").content = string.format("Crystals: %d", count)
  ctx.events.emit("crystals-grown", { count = count })
  ctx.log(string.format("crystals grown: %d", count))
end

return script
