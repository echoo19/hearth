-- Torch: on top of its steady rate, puff a handful of extra embers
-- every couple of seconds and log the live count. Dogfoods
-- ctx.particles.burst/count from a real Lua script.
local script = {}

function script.onStart(ctx)
  ctx.timers.every(2, function()
    ctx.particles.burst(4)
    ctx.log("torch embers:", ctx.particles.count())
  end)
end

return script
