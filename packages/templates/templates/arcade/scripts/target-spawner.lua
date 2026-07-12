-- Spawner: drops one target into the arena at the start of the scene by
-- instancing the "Target" prefab via ctx.scene.spawnPrefab.
local script = {}

function script.onStart(ctx)
  ctx.scene.spawnPrefab(
    "Target",
    { position = { x = ctx.params.x or 560, y = ctx.params.y or 150 } }
  )
end

return script
