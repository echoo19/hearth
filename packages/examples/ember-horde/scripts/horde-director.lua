-- Director: spawns the horde in fixed-size waves on a frame interval,
-- capped at ENEMY_CAP concurrent (none of these enemies ever die in this
-- example, so "spawned so far" and "live right now" track together once
-- the two hand-placed instances below are added in). Each wave spawns the
-- "Enemy" prefab (see generate.mjs's createPrefab call) via
-- ctx.scene.spawnPrefab — the prefab asset owns every enemy's components,
-- so this script only ever decides WHERE and WHEN, never what an enemy is
-- made of. The live count and the clock are declared game state that the
-- Timer/Horde HUD labels are bound to, so this script never looks a HUD up
-- and never formats one; and it needs no paused flag, because
-- ctx.game.pause already stops onUpdate from running at all.
local script = {}

local ENEMY_CAP = 300
local WAVE_SIZE = 10
local WAVE_INTERVAL = 20

function script.onUpdate(ctx, dt)
  ctx.state.set("time", ctx.time.elapsed)
  local count = ctx.state.get("enemies")
  if count >= ENEMY_CAP or ctx.time.frame % WAVE_INTERVAL ~= 0 then
    return
  end
  local toSpawn = math.min(WAVE_SIZE, ENEMY_CAP - count)
  local radius = ctx.params.spawnRadius or 250
  for i = 1, toSpawn do
    local angle = ctx.random.range(0, 6.2831853)
    local x = (ctx.params.centerX or 400) + math.cos(angle) * radius
    local y = (ctx.params.centerY or 304) + math.sin(angle) * radius
    ctx.scene.spawnPrefab("Enemy", { position = { x = x, y = y } })
    ctx.events.emit("enemy-spawned")
    ctx.state.add("enemies", 1)
  end
end

return script
