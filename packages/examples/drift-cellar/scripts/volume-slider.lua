-- Music volume: the change event fires from pointer drags, ui-left/
-- ui-right (ctx.ui.adjust), and activate clicks alike; event.value is the
-- slider's new value, piped straight into the live music channel.
local script = {}

function script.onUiEvent(ctx, event)
  if event.type == "focus" then
    ctx.getComponent("UISlider").handleColor = "#ffb454"
  elseif event.type == "blur" then
    ctx.getComponent("UISlider").handleColor = "#ececec"
  elseif event.type == "change" then
    ctx.audio.setMusicVolume(event.value)
  end
end

return script
