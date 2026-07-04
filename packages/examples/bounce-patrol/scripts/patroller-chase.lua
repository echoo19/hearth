-- Patroller: a kinematic body with no gravity/pushback of its own. Every
-- REPATH_INTERVAL frames it asks ctx.scene.findPath for a fresh route to
-- the player (grid A* over the arena's solid Tilemap + statics) and
-- steers waypoint-to-waypoint with ctx.math (sub/normalize/scale) rather
-- than hand-rolled trig. Its Collider is a trigger, so it detects the
-- player without physically shoving anything; touching the player emits
-- "caught". It also overlaps the Tilemap arena's own entity as it walks
-- past walls (see docs/architecture.md) — that fires onCollision too, so
-- the name check below ignores anything that isn't the Player.
local script = {}

local SPEED = 60
local WAYPOINT_RADIUS = 6
local REPATH_INTERVAL = 30

local function repath(ctx)
  local player = ctx.scene.find("Player")
  if not player then return end
  ctx.vars.path = ctx.scene.findPath(ctx.transform.position, player.transform.position)
  ctx.vars.waypointIndex = 1
end

function script.onStart(ctx)
  ctx.vars.path = nil
  ctx.vars.waypointIndex = 1
  repath(ctx)
end

function script.onUpdate(ctx, dt)
  local body = ctx.getComponent("PhysicsBody")

  if ctx.time.frame % REPATH_INTERVAL == 0 then
    repath(ctx)
  end

  local path = ctx.vars.path
  local target = path and path[ctx.vars.waypointIndex] or nil
  if not target then
    body.velocity.x = 0
    body.velocity.y = 0
    return
  end

  local toTarget = ctx.math.sub(target, ctx.transform.position)
  if ctx.math.length(toTarget) < WAYPOINT_RADIUS then
    ctx.vars.waypointIndex = ctx.vars.waypointIndex + 1
    target = path[ctx.vars.waypointIndex]
    if not target then
      body.velocity.x = 0
      body.velocity.y = 0
      return
    end
    toTarget = ctx.math.sub(target, ctx.transform.position)
  end

  local steer = ctx.math.scale(ctx.math.normalize(toTarget), SPEED)
  body.velocity.x = steer.x
  body.velocity.y = steer.y
end

function script.onCollision(ctx, other)
  if other.name ~= "Player" then return end
  ctx.events.emit("caught")
end

return script
