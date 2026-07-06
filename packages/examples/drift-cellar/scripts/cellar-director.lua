-- Director: tallies "gem" events (proxy-safe payload guard — see
-- docs/scripting.md), keeps the HUD current, and once all three are in,
-- saves the tally and fades to black. The fade's onComplete fires exactly
-- once (a superseding fade would drop it) and switches to the Vault; the
-- persistent fade level carries across the scene switch, so the Vault
-- starts black and fades itself back in.
local script = {}

local TOTAL = 3

function script.onStart(ctx)
  ctx.vars.count = 0
  ctx.vars.leaving = false
end

function script.onEvent(ctx, name, data)
  if name ~= "gem" then return end
  local amount = 1
  if data and type(data.value) == "number" then
    amount = data.value
  end
  ctx.vars.count = ctx.vars.count + amount
  local hud = ctx.scene.find("Gems HUD")
  if hud then
    hud.getComponent("Text").content = string.format("Gems: %d/%d", ctx.vars.count, TOTAL)
  end
  if ctx.vars.count >= TOTAL and not ctx.vars.leaving then
    ctx.vars.leaving = true
    ctx.save("gems", ctx.vars.count)
    ctx.camera.fade(1, ctx.params.fadeSeconds or 0.8, {
      color = "#000000",
      onComplete = function()
        ctx.scenes.load("Vault")
      end,
    })
  end
end

return script
