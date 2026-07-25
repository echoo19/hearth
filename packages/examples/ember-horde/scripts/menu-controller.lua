-- Pause menu controller (on the UILayout container, and the ONE script in
-- this game with Script.runWhilePaused = true): Esc / gamepad start toggles
-- the menu by sliding the container's UIElement offset on/offscreen
-- (children stack relative to the container). Opening calls ctx.game.pause()
-- — the engine freezes physics, particles and every script that did not opt
-- in, so the Player, the Director and all 300 Enemies stop without any of
-- them knowing a pause exists — and focuses Resume; closing resumes and
-- clears focus. The engine's pause flag IS the menu's open state, so there
-- is no second copy of it to drift. ui-up/ui-down move focus between the two
-- widgets; ui-confirm activates the focused one (a synthesized real click,
-- so a focused toggle flips exactly like a pointer click would — UI pointer
-- and focus events keep working while paused).
local script = {}

local function openMenu(ctx)
  ctx.getComponent("UIElement").offset.x = ctx.params.openX or -105
  ctx.game.pause()
  ctx.ui.focus("Resume")
end

local function closeMenu(ctx)
  ctx.getComponent("UIElement").offset.x = ctx.params.closedX or -3000
  ctx.ui.focus(nil)
  ctx.game.resume()
end

function script.onUpdate(ctx, dt)
  if ctx.input.justPressed("pause") then
    if ctx.game.isPaused() then
      closeMenu(ctx)
    else
      openMenu(ctx)
    end
    return
  end
  if not ctx.game.isPaused() then
    return
  end
  if ctx.input.justPressed("ui-up") then
    ctx.ui.moveFocus("up")
  end
  if ctx.input.justPressed("ui-down") then
    ctx.ui.moveFocus("down")
  end
  if ctx.input.justPressed("ui-confirm") then
    ctx.ui.activate()
  end
end

function script.onEvent(ctx, name)
  if name == "menu-close" and ctx.game.isPaused() then
    closeMenu(ctx)
  end
end

return script
