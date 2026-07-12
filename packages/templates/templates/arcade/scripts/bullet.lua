-- Bullet: set once on spawn to fly straight up. Pops the first target it
-- touches (targets are named "Target ...") and removes itself; also cleans
-- up once it leaves the top of the screen so bullets never pile up.
local script = {}

function script.onStart(ctx)
  ctx.getComponent("PhysicsBody").velocity.y = -(ctx.params.speed or 420)
end

function script.onUpdate(ctx, dt)
  if ctx.transform.position.y < -20 then
    ctx.scene.destroy(ctx.entity.id)
  end
end

function script.onCollision(ctx, other)
  if string.sub(other.name, 1, 6) ~= "Target" then
    return
  end
  ctx.scene.destroy(other)
  ctx.scene.destroy(ctx.entity.id)
  ctx.events.emit("target-hit")
end

return script
