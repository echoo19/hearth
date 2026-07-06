-- Screen shake setting: the player's wall-bump handler reads this
-- entity's live UIToggle.value directly, so flipping the checkbox IS the
-- setting — no mirror state to keep in sync.
local script = {}

function script.onUiEvent(ctx, event)
  if event.type == "focus" then
    ctx.getComponent("UIToggle").color = "#ffb454"
  elseif event.type == "blur" then
    ctx.getComponent("UIToggle").color = "#3a3a3a"
  elseif event.type == "change" then
    if event.value then
      ctx.log("screen shake: on")
    else
      ctx.log("screen shake: off")
    end
  end
end

return script
