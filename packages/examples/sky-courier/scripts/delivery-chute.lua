-- Chute: tallies "parcel" events (onEvent fires scene-wide for every
-- emit, unfiltered, so every entity sees every pickup). Once all three
-- are in and the Courier touches the chute, it emits "delivered" exactly
-- once. Event payloads cross the JS/Lua boundary as proxies, not plain
-- Lua tables: type(data) reports "userdata" here, never "table", so the
-- guard checks the field directly (see docs/scripting.md's proxy note).
local script = {}

local TOTAL_PARCELS = 3

function script.onStart(ctx)
  ctx.vars.collected = 0
  ctx.vars.delivered = false
end

function script.onEvent(ctx, name, data)
  if name ~= "parcel" then
    return
  end
  local amount = 1
  if data and type(data.left) == "number" then
    amount = data.left
  end
  ctx.vars.collected = ctx.vars.collected + amount
end

function script.onCollision(ctx, other)
  if other.name ~= "Courier" then
    return
  end
  if ctx.vars.delivered or ctx.vars.collected < TOTAL_PARCELS then
    return
  end
  ctx.vars.delivered = true
  ctx.events.emit("delivered")
  ctx.audio.play("delivery-sound", { volume = 0.9 })
end

return script
