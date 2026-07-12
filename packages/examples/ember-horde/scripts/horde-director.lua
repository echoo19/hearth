-- Director: spawns the horde in fixed-size waves on a frame interval,
-- capped at ENEMY_CAP concurrent (none of these enemies ever die in this
-- example, so "spawned so far" and "live right now" track together once
-- the two hand-placed instances below are added in). Each wave spawns the
-- "Enemy" prefab (see generate.mjs's createPrefab call) via
-- ctx.scene.spawnPrefab — the prefab asset owns every enemy's components,
-- so this script only ever decides WHERE and WHEN, never what an enemy is
-- made of. Keeps the Timer/Horde HUDs current every frame from cached
-- handles (found once in onStart, same live-handle idiom enemy-chase.lua
-- uses, applied here too for consistency even though the director itself
-- only ever does one find per HUD, not one per enemy).
local script = {}

local ENEMY_CAP = 300
local WAVE_SIZE = 10
local WAVE_INTERVAL = 20

function script.onStart(ctx)
  ctx.vars.count = 0
  ctx.vars.paused = false
  ctx.vars.timerHud = ctx.scene.find("Timer HUD")
  ctx.vars.hordeHud = ctx.scene.find("Horde HUD")
end

local function spawnEnemy(ctx, x, y)
  ctx.scene.spawnPrefab("Enemy", { position = { x = x, y = y } })
  ctx.events.emit("enemy-spawned")
end

function script.onUpdate(ctx, dt)
  if not ctx.vars.paused and ctx.vars.count < ENEMY_CAP and ctx.time.frame % WAVE_INTERVAL == 0 then
    local toSpawn = math.min(WAVE_SIZE, ENEMY_CAP - ctx.vars.count)
    local radius = ctx.params.spawnRadius or 250
    for i = 1, toSpawn do
      local angle = ctx.random.range(0, 6.2831853)
      local x = (ctx.params.centerX or 400) + math.cos(angle) * radius
      local y = (ctx.params.centerY or 304) + math.sin(angle) * radius
      spawnEnemy(ctx, x, y)
      ctx.vars.count = ctx.vars.count + 1
    end
  end

  if ctx.vars.timerHud then
    ctx.vars.timerHud.getComponent("Text").content = string.format("Time: %.1f", ctx.time.elapsed)
  end
  if ctx.vars.hordeHud then
    ctx.vars.hordeHud.getComponent("Text").content =
      string.format("Enemies: %d/%d", ctx.vars.count, ENEMY_CAP)
  end
end

function script.onEvent(ctx, name)
  if name == "pause" then
    ctx.vars.paused = true
  elseif name == "resume" then
    ctx.vars.paused = false
  end
end

return script
