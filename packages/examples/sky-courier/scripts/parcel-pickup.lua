-- Parcel: on contact with the Courier, emits "parcel" (this pickup's
-- contribution toward the delivered count -- the HUD and Chute scripts
-- both listen via onEvent and add it up themselves), plays a pickup
-- chime, and removes itself.
local script = {}

function script.onCollision(ctx, other)
  if other.name ~= "Courier" then return end
  ctx.events.emit("parcel", { left = 1 })
  ctx.audio.play("parcel-sound", { volume = 0.8 })
  ctx.destroySelf()
end

return script
