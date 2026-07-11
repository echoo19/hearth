-- HUD: shows parcels collected (via "parcel" events, same proxy-safe
-- guard as the Chute) and switches to a delivered message once the Chute
-- confirms "delivered".
local script = {}

local TOTAL_PARCELS = 3

function script.onStart(ctx)
  ctx.vars.collected = 0
  ctx.getComponent("Text").content =
    string.format("Parcels: %d/%d", ctx.vars.collected, TOTAL_PARCELS)
end

function script.onEvent(ctx, name, data)
  if name == "parcel" then
    local amount = 1
    if data and type(data.left) == "number" then
      amount = data.left
    end
    ctx.vars.collected = ctx.vars.collected + amount
    ctx.getComponent("Text").content =
      string.format("Parcels: %d/%d", ctx.vars.collected, TOTAL_PARCELS)
  elseif name == "delivered" then
    ctx.getComponent("Text").content = "All delivered!"
  end
end

return script
