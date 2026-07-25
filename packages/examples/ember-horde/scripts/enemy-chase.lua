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
--
-- Nothing in here knows the game can be paused: ctx.game.pause freezes
-- physics and every script that did not opt into runWhilePaused, so the old
-- per-enemy paused flag and velocity-zeroing block are gone.
local script = {}

function script.onStart(ctx)
  ctx.vars.player = ctx.scene.find("Player")
end

function script.onUpdate(ctx, dt)
  local player = ctx.vars.player
  if not player then
    return
  end
  local body = ctx.getComponent("PhysicsBody")
  local toPlayer = ctx.math.sub(player.transform.position, ctx.transform.position)
  local steer = ctx.math.scale(ctx.math.normalize(toPlayer), ctx.params.speed or 90)
  body.velocity.x = steer.x
  body.velocity.y = steer.y
end

return script
