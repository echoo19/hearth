-- Pause menu controller (on the UILayout container): Esc / gamepad start
-- toggles the menu by sliding the container's UIElement offset on/offscreen
-- (children stack relative to the container). Opening emits "pause"
-- (every entity's onEvent hook sees it scene-wide — the Player, the
-- Director, and every live Enemy all freeze) and focuses Resume; closing
-- emits "resume" and clears focus. ui-up/ui-down move focus between the
-- two widgets; ui-confirm activates the focused one (a synthesized real
-- click, so a focused toggle flips exactly like a pointer click would).
local script = {}

local function openMenu(ctx)
  ctx.vars.open = true
  ctx.getComponent("UIElement").offset.x = ctx.params.openX or -105
  ctx.events.emit("pause")
  ctx.ui.focus("Resume")
end

local function closeMenu(ctx)
  ctx.vars.open = false
  ctx.getComponent("UIElement").offset.x = ctx.params.closedX or -3000
  ctx.ui.focus(nil)
  ctx.events.emit("resume")
end

function script.onStart(ctx)
  ctx.vars.open = false
end

function script.onUpdate(ctx, dt)
  if ctx.input.justPressed("pause") then
    if ctx.vars.open then closeMenu(ctx) else openMenu(ctx) end
    return
  end
  if not ctx.vars.open then return end
  if ctx.input.justPressed("ui-up") then ctx.ui.moveFocus("up") end
  if ctx.input.justPressed("ui-down") then ctx.ui.moveFocus("down") end
  if ctx.input.justPressed("ui-confirm") then ctx.ui.activate() end
end

function script.onEvent(ctx, name)
  if name == "menu-close" and ctx.vars.open then
    closeMenu(ctx)
  end
end

return script
