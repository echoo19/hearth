-- Coin: layer "pickup" with collidesWith {"player"} already restricts
-- contact to the Player entity (see the Collider on each Coin below and
-- docs/components.md's layer rules), so onCollision needs no tag check —
-- the Patroller walks straight through these on layer "default".
local script = {}

function script.onCollision(ctx, other)
  ctx.events.emit("coin", { value = 1 })
  ctx.destroySelf()
end

return script
