-- Gem: on contact with the Player, emits "gem" (the director counts
-- them scene-wide via onEvent), chimes, and removes itself.
local script = {}

function script.onCollision(ctx, other)
  if other.name ~= "Player" then
    return
  end
  ctx.events.emit("gem", { value = 1 })
  ctx.audio.play("gem-sound", { volume = 0.8 })
  ctx.destroySelf()
end

return script
