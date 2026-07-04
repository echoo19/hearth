-- ScoreUI: no ctx.events.on subscription needed — onEvent(ctx, name, data)
-- fires for every emitted event scene-wide, so it just filters by name.
local script = {}

function script.onStart(ctx)
  ctx.vars.score = 0
end

function script.onEvent(ctx, name, data)
  if name ~= "coin" then return end
  -- Event payloads cross the JS/Lua boundary as proxies, not plain Lua
  -- tables: type(data) reports "userdata" here, never "table", so a
  -- type(data) == "table" guard always fails. Field access on the proxy
  -- still works, so check the field directly instead.
  local amount = 1
  if data and type(data.value) == "number" then
    amount = data.value
  end
  ctx.vars.score = ctx.vars.score + amount
  ctx.getComponent("Text").content = string.format("Score: %d", ctx.vars.score)
end

return script
