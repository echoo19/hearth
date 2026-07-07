-- Resume: an interactive+focusable UIElement (the drift-cellar pattern).
-- focus/blur swap the sprite color; click (real pointer, or
-- ctx.ui.activate from ui-confirm) asks the menu controller to close.
local script = {}

function script.onUiEvent(ctx, event)
  if event.type == "focus" then
    ctx.getComponent("SpriteRenderer").color = "#e8462f"
  elseif event.type == "blur" then
    ctx.getComponent("SpriteRenderer").color = "#3a1f14"
  elseif event.type == "click" then
    ctx.events.emit("menu-close")
  end
end

return script
