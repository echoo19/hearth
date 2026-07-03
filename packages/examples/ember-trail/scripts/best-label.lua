-- Best-score label: reads what the level saved with ctx.save. Save data
-- survives scene switches; in the browser it persists via localStorage.
local script = {}

function script.onStart(ctx)
  local best = ctx.load("best")
  if type(best) ~= "number" then best = 0 end
  ctx.getComponent("Text").content = string.format("Best: %d", best)
end

return script
