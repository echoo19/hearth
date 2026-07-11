-- Vault: the Cellar's fade-out leaves the persistent overlay at alpha 1
-- across the scene switch, so this scene starts black — fading back to 0
-- here is the fade-in. The label reads the tally the director saved.
local script = {}

function script.onStart(ctx)
  ctx.camera.fade(0, ctx.params.fadeSeconds or 0.7)
  local gems = ctx.load("gems")
  if type(gems) ~= "number" then
    gems = 0
  end
  ctx.getComponent("Text").content = string.format("Gems recovered: %d/3", gems)
end

return script
