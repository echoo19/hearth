-- Resume: an interactive+focusable UIElement (the ember-trail start-
-- button pattern). focus/blur swap the sprite color — the focus visual —
-- and click (real pointer, or ctx.ui.activate from ui-confirm) asks the
-- menu controller to close via the "menu-close" event.
local script = {}

function script.onUiEvent(ctx, event)
  if event.type == "focus" then
    ctx.getComponent("SpriteRenderer").color = "#e25822"
  elseif event.type == "blur" then
    ctx.getComponent("SpriteRenderer").color = "#3a2d52"
  elseif event.type == "click" then
    ctx.events.emit("menu-close")
  end
end

return script
