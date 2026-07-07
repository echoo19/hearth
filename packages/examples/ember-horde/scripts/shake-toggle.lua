-- Screen shake setting: player-move.lua reads this entity's live
-- UIToggle.value directly on every contact, so flipping the checkbox IS
-- the setting — no mirror state to keep in sync.
local script = {}

function script.onUiEvent(ctx, event)
  if event.type == "focus" then
    ctx.getComponent("UIToggle").color = "#e8462f"
  elseif event.type == "blur" then
    ctx.getComponent("UIToggle").color = "#3a1f14"
  end
end

return script
