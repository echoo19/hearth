-- Carves the warrens at level start. Seeded value noise (the shared
-- lib/noise module) decides which cells are tunnel, 3x3 clearings are kept
-- open around the Player and the Exit Gate, and the grid is REPLACED with
-- one whole-array assignment: the runtime detects grid changes by
-- reference identity (docs/scripting.md), so tilemap.grid = rows is the
-- contract — editing the old rows in place would silently keep stale
-- collision boxes and a stale render.
--
-- Connectivity is then PROVEN, not assumed: ctx.scene.findPath must route
-- from the Player to the Exit Gate through the carved tunnels. If the
-- noise happened to wall them apart, an L-corridor is cut and the proof
-- re-run ON THE NEXT FRAME: the runtime rebuilds its findPath nav grid at
-- most once per frame, so a second findPath in the same frame would still
-- see the pre-corridor walls. Emits "warrens-carved" at start (with the
-- lattice seed, so crystal-grower.lua can sample the same field) and
-- "warrens-connected" once the path is proven.
local noise = require("lib/noise")

local script = {}

local TILE = 32
local COLS = 25
local ROWS = 19

local function cellOf(pos)
  return { c = math.floor(pos.x / TILE), r = math.floor(pos.y / TILE) }
end

-- Build the rows for this seed: noise tunnels, plus 3x3 clearings around
-- each of `clearings`, plus every `corridor` cell. Returns a FRESH table
-- every call (see the reference-identity contract above).
local function buildRows(seed, clearings, corridor)
  local open = {}
  local function mark(c, r)
    if c > 0 and c < COLS - 1 and r > 0 and r < ROWS - 1 then
      open[r * COLS + c] = true
    end
  end
  for r = 1, ROWS - 2 do
    for c = 1, COLS - 2 do
      if noise.caveOpen(c, r, seed) then
        mark(c, r)
      end
    end
  end
  for _, cell in ipairs(clearings) do
    for dr = -1, 1 do
      for dc = -1, 1 do
        mark(cell.c + dc, cell.r + dr)
      end
    end
  end
  for _, cell in ipairs(corridor) do
    mark(cell.c, cell.r)
  end
  local rows = {}
  for r = 0, ROWS - 1 do
    local chars = {}
    for c = 0, COLS - 1 do
      chars[#chars + 1] = open[r * COLS + c] and "." or "#"
    end
    rows[#rows + 1] = table.concat(chars)
  end
  return rows
end

-- L-shaped corridor between two cells (only used when the noise walled
-- spawn and exit apart at this seed).
local function corridorBetween(a, b)
  local cells = {}
  local step = a.c <= b.c and 1 or -1
  for c = a.c, b.c, step do
    cells[#cells + 1] = { c = c, r = a.r }
  end
  step = a.r <= b.r and 1 or -1
  for r = a.r, b.r, step do
    cells[#cells + 1] = { c = b.c, r = r }
  end
  return cells
end

local function provePath(ctx)
  local player = ctx.scene.find("Player")
  local gate = ctx.scene.find("Exit Gate")
  return ctx.scene.findPath(player.transform.position, gate.transform.position)
end

local function announce(ctx, path)
  local hud = ctx.scene.find("Warrens HUD").getComponent("Text")
  if path then
    ctx.events.emit("warrens-connected", { waypoints = #path })
    hud.content = string.format("Exit path: %d steps", #path)
    ctx.log(
      string.format("warrens carved (seed %d): exit reachable in %d steps", ctx.vars.seed, #path)
    )
  else
    hud.content = "Exit path: blocked!"
    ctx.log("warrens carved but the exit is unreachable - corridor fallback failed")
  end
end

function script.onStart(ctx)
  local player = ctx.scene.find("Player")
  local gate = ctx.scene.find("Exit Gate")
  local spawn = cellOf(player.transform.position)
  local exitCell = cellOf(gate.transform.position)
  local seed = noise.seedFrom(ctx.random)
  ctx.vars.seed = seed

  local tilemap = ctx.getComponent("Tilemap")
  tilemap.grid = buildRows(seed, { spawn, exitCell }, {})
  ctx.events.emit("warrens-carved", { seed = seed })

  local path = provePath(ctx)
  if path then
    announce(ctx, path)
  else
    -- Walled apart at this seed: cut the corridor now (a fresh array again)
    -- and re-prove on the NEXT frame. findPath's nav grid rebuilds at most
    -- once per frame (and onStart shares a frame with the first onUpdate),
    -- so re-asking on the carve frame would still see pre-corridor walls.
    tilemap.grid = buildRows(seed, { spawn, exitCell }, corridorBetween(spawn, exitCell))
    ctx.vars.carveFrame = ctx.time.frame
    ctx.vars.reprove = true
  end
end

function script.onUpdate(ctx, dt)
  if not ctx.vars.reprove or ctx.time.frame <= ctx.vars.carveFrame then
    return
  end
  ctx.vars.reprove = false
  announce(ctx, provePath(ctx))
end

return script
