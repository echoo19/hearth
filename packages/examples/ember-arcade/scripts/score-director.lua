-- Director: tallies "target-hit" events scene-wide and keeps the HUD
-- current. Purely a counter — the targets themselves own their flash/
-- dissolve/destroy sequence.
local script = {}

function script.onStart(ctx)
  ctx.vars.count = 0
end

function script.onEvent(ctx, name)
  if name ~= "target-hit" then return end
  ctx.vars.count = ctx.vars.count + 1
  local hud = ctx.scene.find("Score HUD")
  if hud then
    hud.getComponent("Text").content = string.format("Targets: %d/%d", ctx.vars.count, ctx.params.total or 3)
  end
end

return script
