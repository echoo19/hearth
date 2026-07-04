# Working on "Glow Caves" (a Hearth project)

This directory is a **Hearth** game project. Hearth is an open-source,
agent-native 2D game engine: the entire editor/runtime is exposed through a
structured CLI (`hearth`) and an MCP server (`hearth-mcp`) so coding agents
can inspect, modify, test, and build this game through safe engine
operations instead of hand-editing JSON.

## Golden rules

1. **Do not guess the project structure.** Inspect first:
   - `hearth inspect project --json`
   - `hearth inspect scenes --json`
   - `hearth inspect scene <scene> --json`
   - `hearth inspect entity <scene> <entity> --json`
   - `hearth inspect components --json` (all component types + default values)
2. **Prefer structured commands over editing project JSON by hand.**
   The CLI validates every change against schemas. Direct edits to
   `hearth.json`, `scenes/*.scene.json`, or `assets.json` can corrupt the
   project (`hearth set-settings` updates build/loading settings, the
   initial scene, and input mappings safely). Scripts are **Lua by default**
   (`.js` also supported) and are normal code: edit `scripts/*.lua` /
   `scripts/*.js` freely (or via `hearth create script` / `hearth edit-script`).
3. **Snapshot before you change anything:** `hearth snapshot`.
   Then the human can review your work with `hearth diff` (or the editor's
   Diff panel), and `hearth revert --confirm` can undo it.
4. **Validate after changes:** `hearth validate --json`. Fix errors you introduced.
5. **Playtest your work:** `hearth playtest <name>` runs headless scripted
   tests; `hearth run <scene> --frames 120` smoke-runs a scene and reports
   script errors. Run reports include `audioEvents` (every audio play/stop
   with its frame and asset id), so you can verify sound behavior headlessly.
6. **Do not delete assets or scenes unless explicitly asked.**
7. **Summarize your changes** when done: which scenes, entities, components,
   scripts, and assets you touched (`hearth diff --json` gives you the list).

## Typical workflow

```bash
hearth snapshot                        # checkpoint for diff/review
hearth inspect project --json          # learn the project
hearth inspect scene level_1 --json    # learn the scene
hearth create entity level_1 Coin --components '{"SpriteRenderer":{"shape":"circle","color":"#f1c40f"}}'
hearth set level_1 Coin Transform.position.x 200
hearth create sound pickup --preset coin       # deterministic WAV (presets: coin, jump, hit, laser, powerup, explosion, blip)
hearth create script coin-spin                 # Lua by default (--language js for JavaScript)
hearth attach script level_1 Coin scripts/coin-spin.lua
hearth validate --json                 # must pass
hearth run level_1 --frames 120 --json # no script errors
hearth diff                            # review what changed
hearth export web --zip                # playable static build (needs --allow build)
```

## Project layout (do not restructure)

- `hearth.json`: project manifest (scenes list, input mappings, build settings)
- `scenes/*.scene.json`: scene files (entities + components)
- `assets.json`: asset index; `assets/`: asset files
- `scripts/*.lua` (and `*.js`): behavior scripts (Lua by default; `hearth inspect api --json` documents the ctx API)
- `playtests/*.playtest.json`: headless playtest definitions
- `.hearth/`: engine state (baseline snapshots, agent config); don't edit manually

## Scripting quick reference

Scripts are **Lua by default** (`hearth create script <name>`; add
`--language js` for JavaScript). A Lua script returns a table of lifecycle
hooks — `onStart(ctx)`, `onUpdate(ctx, dt)`, `onCollision(ctx, other)`, and
`onUiEvent(ctx, event)` (pointer events on this entity's interactive
`UIElement`; `event.type` is `click|press|release|enter|exit`):

```lua
local script = {}

function script.onStart(ctx)
end

function script.onUpdate(ctx, dt)
  ctx.transform.position.x = ctx.transform.position.x + 100 * dt
end

return script
```

**Call ctx with a dot, not a colon**: `ctx.log("hi")`, `ctx.scenes.load("Level")` —
never `ctx:log("hi")`. JS scripts `export default` an object with the same
hooks and receive the identical `ctx`.

The full ctx API (`hearth inspect api --json` returns this machine-readable,
with Lua and JS examples per entry):

- `ctx.entity` — This entity's id, name, and tags.
- `ctx.transform` — Live Transform of this entity (mutable): position, rotation, scale.
- `ctx.getComponent(type: T): ComponentMap[T]` — Live component data for this entity (mutable).
- `ctx.params` — Parameters from the Script component (set via attachScript).
- `ctx.input.isDown(action: string): boolean` — Is an input action currently held?
- `ctx.input.justPressed(action: string): boolean` — Was the input action pressed this frame?
- `ctx.scene.find(idOrName: string): EntityHandle | null` — Find an entity in the current scene by id or name.
- `ctx.scene.findByTag(tag: string): EntityHandle[]` — All entities in the current scene with the given tag.
- `ctx.scene.spawn(def: SpawnDef): EntityHandle` — Create an entity at runtime ({ name, position?, tags?, components? }).
- `ctx.scene.destroy(idOrHandle: string | EntityHandle): void` — Remove an entity from the current scene at runtime.
- `ctx.scenes.current` — Current scene {id, name}.
- `ctx.scenes.list(): { id: string; name: string }[]` — All scenes in the project as {id, name}.
- `ctx.scenes.load(idOrName: string): boolean` — Request a scene switch at end of frame. False if unknown.
- `ctx.timers.after(seconds: number, fn: () => void): string` — Run fn once after `seconds`. Returns a cancel id.
- `ctx.timers.every(seconds: number, fn: () => void): string` — Run fn every `seconds`. Returns a cancel id.
- `ctx.timers.cancel(id: string): void` — Cancel a timer by the id returned from after/every.
- `ctx.tweens.to(path: string, target: number, seconds: number, opts?: { easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'; onComplete?: () => void }): string` — Tween a numeric component property on this entity, e.g. to('Transform.position.x', 400, 0.5, { easing: 'easeOut' }). Returns a cancel id. Unknown/non-numeric path → warn log + '' id.
- `ctx.tweens.cancel(id: string): void` — Cancel a tween by the id returned from tweens.to.
- `ctx.random.next(): number` — Seeded, deterministic [0, 1). Same seed → same sequence.
- `ctx.random.range(min: number, max: number): number` — Seeded float in [min, max).
- `ctx.random.int(min: number, max: number): number` — Seeded integer, min and max inclusive.
- `ctx.particles.burst(count: number): void` — Spawn `count` particles immediately from this entity's ParticleEmitter (in addition to its normal rate/burst). Warns if the entity has no ParticleEmitter.
- `ctx.particles.count(): number` — Live particle count for this entity's ParticleEmitter (0 if none).
- `ctx.animate(assetRef: string): void` — Switch this entity's SpriteAnimator to `assetRef` (animation asset id or name), set playing = true, and restart at frame 0. Warns if the entity has no SpriteAnimator or the asset is unknown.
- `ctx.save(key: string, value: unknown): void` — Persistent save data (JSON values), survives scene switches; in the browser it persists across sessions via localStorage.
- `ctx.load(key: string): unknown` — Read saved data; null when absent.
- `ctx.clearSave(key?: string): void` — Clear one save key, or all save data when no key is given.
- `ctx.camera.getPosition(): Vec2` — The main camera's position {x, y}.
- `ctx.camera.setPosition(x: number, y: number): void` — Move the main camera.
- `ctx.camera.getZoom(): number` — The main camera's zoom factor.
- `ctx.camera.setZoom(zoom: number): void` — Set the main camera's zoom factor.
- `ctx.camera.follow(idOrName: string | null): void` — Follow an entity each frame (null stops). Warn log if not found.
- `ctx.audio.play(assetRef: string, opts?: { volume?: number; loop?: boolean }): string | null` — Play an audio asset (by asset id or name). Returns a handle id for ctx.audio.stop, or null when the asset does not exist.
- `ctx.audio.stop(handleIdOrAssetRef: string): void` — Stop a playback by handle id, or every playback of an asset id/name.
- `ctx.vars` — Persistent per-entity state, survives across frames (not across scene switches — use ctx.save).
- `ctx.time` — Elapsed seconds, delta seconds, and frame count.
- `ctx.log(...args: unknown[]): void` — Log to the Hearth console (shows up in playtest and smoke-run reports).
- `ctx.collisions` — This entity's current collisions (refreshed each frame): { other, normal, trigger }.
- `ctx.isGrounded(): boolean` — Any non-trigger contact pushing this entity up (normal.y < -0.5).
- `ctx.destroySelf(): void` — Remove this entity from the scene.

Scene switching makes user-built menus/start screens (e.g. a Start button —
an interactive `UIElement` — whose script loads the level):

```lua
local script = {}

function script.onUiEvent(ctx, event)
  if event.type == "click" then
    ctx.scenes.load("Level")
  end
end

return script
```

Save data persists across scene switches (and across browser sessions in
exported games):

```lua
local best = ctx.load("bestScore") or 0
if score > best then
  ctx.save("bestScore", score)
end
```

`ctx.random` (and Lua's `math.random`) is seeded and deterministic — the
same seed produces the same sequence, so playtests are reproducible. Never
use wall-clock time or `Math.random` for gameplay.

Input actions are defined in `hearth.json` under `inputMappings.actions`
(`hearth inspect project --json` shows them; `hearth set-input <action> <keys...>` changes them).

Component notes: `UIElement` makes an entity screen-space UI (anchor +
offset, camera-independent; visuals come from Text/SpriteRenderer;
`interactive: true` enables onUiEvent). `Collider` polygons must be convex
with at least 3 points — split concave shapes across multiple entities.
`AudioSource` with `autoplay: true` plays its asset on scene start.

## MCP

If you are connected via MCP instead of the CLI, the same operations are
exposed as tools (`get_project_info`, `inspect_scene`, `create_entity`,
`set_component_property`, `create_sound`, `run_playtest`, `get_diff`,
`export_web`, ...). Call `get_agent_instructions` for this document.

Generated by Hearth 0.3.0.
