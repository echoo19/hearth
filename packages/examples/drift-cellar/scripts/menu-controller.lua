-- Pause menu controller (on the UILayout container): Esc / gamepad
-- start toggles the menu by sliding the container's UIElement offset on/
-- offscreen (children stack relative to the container, so one offset moves
-- the whole menu). Opening emits "pause" (gameplay scripts freeze
-- themselves) and focuses Resume; closing emits "resume" and clears focus
-- with ctx.ui.focus(nil). While open, ui-up/ui-down move focus spatially,
-- ui-confirm activates the focused widget (a synthesized real click), and
-- ui-left/ui-right nudge the focused slider via ctx.ui.adjust.
local script = {}

local function openMenu(ctx)
  ctx.vars.open = true
  ctx.getComponent("UIElement").offset.x = ctx.params.openX or -105
  ctx.events.emit("pause")
  ctx.ui.focus("Resume")
  ctx.audio.play("ui-sound", { volume = 0.6 })
end

local function closeMenu(ctx)
  ctx.vars.open = false
  ctx.getComponent("UIElement").offset.x = ctx.params.closedX or -3000
  ctx.ui.focus(nil)
  ctx.events.emit("resume")
  ctx.audio.play("ui-sound", { volume = 0.6 })
end

function script.onStart(ctx)
  ctx.vars.open = false
end

function script.onUpdate(ctx, dt)
  if ctx.input.justPressed("pause") then
    if ctx.vars.open then
      closeMenu(ctx)
    else
      openMenu(ctx)
    end
    return
  end
  if not ctx.vars.open then
    return
  end
  if ctx.input.justPressed("ui-up") then
    ctx.ui.moveFocus("up")
  end
  if ctx.input.justPressed("ui-down") then
    ctx.ui.moveFocus("down")
  end
  if ctx.input.justPressed("ui-left") then
    ctx.ui.adjust(-1)
  end
  if ctx.input.justPressed("ui-right") then
    ctx.ui.adjust(1)
  end
  if ctx.input.justPressed("ui-confirm") then
    ctx.ui.activate()
  end
end

function script.onEvent(ctx, name)
  if name == "menu-close" and ctx.vars.open then
    closeMenu(ctx)
  end
end

return script
