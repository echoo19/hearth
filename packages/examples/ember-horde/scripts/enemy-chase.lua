-- Enemy: the "Enemy" prefab's own script (see generate.mjs's createPrefab
-- call below) — every enemy horde-director.lua spawns via
-- ctx.scene.spawnPrefab carries this same Script component, so there is
-- exactly one enemy-chase implementation, not a live one plus a disabled
-- hand-mirrored copy. Every enemy caches the Player EntityHandle exactly
-- once, in onStart — EntityHandle.transform is a live getter onto the real
-- entity, so re-reading ctx.vars.player.transform.position every onUpdate
-- afterward is a plain property read, not a scene search. Calling
-- ctx.scene.find("Player") in onUpdate instead (once per enemy, per frame)
-- is the O(n)-per-enemy pattern that turns into O(n^2) across a few hundred
-- enemies — the exact cost docs/performance.md flags next once broadphase
-- stopped dominating.
local script = {}

function script.onStart(ctx)
  ctx.vars.player = ctx.scene.find("Player")
  ctx.vars.paused = false
end

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")
  if ctx.vars.paused then
    body.velocity.x = 0
    body.velocity.y = 0
    return
  end
  local player = ctx.vars.player
  if not player then
    return
  end
  local toPlayer = ctx.math.sub(player.transform.position, ctx.transform.position)
  local steer = ctx.math.scale(ctx.math.normalize(toPlayer), ctx.params.speed or 90)
  body.velocity.x = steer.x
  body.velocity.y = steer.y
end

function script.onEvent(ctx, name)
  if name == "pause" then
    ctx.vars.paused = true
  elseif name == "resume" then
    ctx.vars.paused = false
  end
end

return script
