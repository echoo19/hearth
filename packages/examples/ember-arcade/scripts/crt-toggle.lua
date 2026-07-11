-- CRT toggle: mutates the Main Camera's live Camera.postEffects stack
-- directly through ctx.getComponent — proving a script can drive the
-- post-effects stack an author set up, not just render it. A runtime
-- component write skips schema defaulting (see docs/scripting.md's
-- component-mutation contract), so every field of the crt entry this
-- pushes must be spelled out explicitly — matching the values Ember
-- Arcade's Main Camera was authored with.
local script = {}

local function setCrt(camera, enabled)
  local kept = {}
  for i = 1, #camera.postEffects do
    local effect = camera.postEffects[i]
    if effect.type ~= "crt" then
      table.insert(kept, effect)
    end
  end
  if enabled then
    table.insert(kept, { type = "crt", curvature = 0.18, scanlineIntensity = 0.3, noise = 0.05 })
  end
  camera.postEffects = kept
end

function script.onUiEvent(ctx, event)
  if event.type ~= "change" then
    return
  end
  local mainCamera = ctx.scene.find("Main Camera")
  if not mainCamera then
    return
  end
  setCrt(mainCamera.getComponent("Camera"), event.value)
  ctx.audio.play("toggle-sound", { volume = 0.5 })
end

return script
