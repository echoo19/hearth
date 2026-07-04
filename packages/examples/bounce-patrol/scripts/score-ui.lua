-- ScoreUI: no ctx.events.on subscription needed — onEvent(ctx, name, data)
-- fires for every emitted event scene-wide, so it just filters by name.
local script = {}

function script.onStart(ctx)
  ctx.vars.score = 0
end

function script.onEvent(ctx, name, data)
  if name ~= "coin" then return end
  local amount = 1
  if type(data) == "table" and type(data.value) == "number" then
    amount = data.value
  end
  ctx.vars.score = ctx.vars.score + amount
  ctx.getComponent("Text").content = string.format("Score: %d", ctx.vars.score)
end

return script
