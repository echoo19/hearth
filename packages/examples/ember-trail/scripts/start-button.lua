-- Start button: a "start screen" in Hearth is just a scene you build.
-- Clicking this interactive UIElement loads the level via ctx.scenes.load.
-- Reminder: ctx calls use DOT syntax (ctx.log("hi"), never ctx:log("hi")).
local script = {}

function script.onUiEvent(ctx, event)
  if event.type ~= "click" then
    return
  end
  ctx.audio.play("start-sound")
  ctx.scenes.load("Level")
end

return script
