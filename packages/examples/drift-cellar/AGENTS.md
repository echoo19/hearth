# Working on "Drift Cellar" (a Hearth project)

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
hearth export web --zip                # playable static build, itch.io-ready (needs --allow build)
hearth export desktop --allow build    # native macOS/Windows/Linux app, zipped per platform
```

Ship: `export web` for a browser build (add `--zip` for itch.io); `export
desktop` wraps the same build in an Electron shell and zips one app per
platform (macOS is ad-hoc signed by default; `HEARTH_MAC_IDENTITY`/
`HEARTH_APPLE_ID`/`HEARTH_APPLE_PASSWORD`/`HEARTH_TEAM_ID` env vars sign
and notarize a real release). `buildSettings.icon` (a sprite asset id, set
via `hearth set-settings --build-settings '{"icon":"ast_x"}'`) becomes the
desktop app icon; leave it `null` for the bundled default.

## Project layout (do not restructure)

- `hearth.json`: project manifest (scenes list, input mappings, build settings)
- `scenes/*.scene.json`: scene files (entities + components)
- `assets.json`: asset index; `assets/`: asset files, including `assets/prefabs/*.prefab.json` (reusable entity-subtree templates)
- `scripts/*.lua` (and `*.js`): behavior scripts (Lua by default; `hearth inspect api --json` documents the ctx API)
- `playtests/*.playtest.json`: headless playtest definitions
- `.hearth/`: engine state (baseline snapshots, agent config); don't edit manually

## Prefabs

Reusable entity templates: `hearth prefab create <scene> <entity> <name>`
serializes an entity's full subtree into a prefab asset; `hearth prefab
place <prefab> <scene>` instantiates it as a fresh entity subtree;
`hearth prefab update <prefab> <scene> <entity>` pushes edits on a tracked
instance back onto the asset; `hearth prefab sync <prefab>` rebuilds every
tracked instance from the current payload, keeping each instance's id,
name, position, and enabled state, but **replacing its whole descendant
subtree** (any child you added by hand to one instance is lost on sync).
Scripts spawn prefabs at runtime with `ctx.scene.spawnPrefab(name, opts?)`
(returns `nil`/`null` if the name is unknown; destroying the returned
root does not cascade to its children).

## Scripting quick reference

Scripts are **Lua by default** (`hearth create script <name>`; add
`--language js` for JavaScript). A Lua script returns a table of lifecycle
hooks — `onStart(ctx)`, `onUpdate(ctx, dt)`, `onCollision(ctx, other)`, and
`onUiEvent(ctx, event)` (pointer/focus events on this entity's interactive
`UIElement`; `event.type` is
`click|press|release|enter|exit|drag|change|focus|blur`, with a
`value` field on `change` — the slider/toggle's new value):

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
- `ctx.input.axis(name: string): number` — Analog value in [-1, 1] for a virtual axis (inputMappings.axes). Precedence: a playtest setAxis override, else the bound gamepad axis once it clears the deadzone, else the keyboard fallback (negativeCodes held → -1, positiveCodes held → +1, both/neither → 0).
- `ctx.scene.find(idOrName: string): EntityHandle | null` — Find an entity in the current scene by id or name.
- `ctx.scene.findByTag(tag: string): EntityHandle[]` — All entities in the current scene with the given tag.
- `ctx.scene.spawn(def: SpawnDef): EntityHandle` — Create an entity at runtime ({ name, position?, tags?, components? }).
- `ctx.scene.spawnPrefab(name: string, opts?: { position?: Vec2; name?: string }): EntityHandle | null` — Spawn a prefab asset (by name or id) as a fresh entity subtree at runtime: every entity gets a new id, parent/child links are preserved among the spawned set, opts.position overrides the root's position and opts.name its name. Spawned children are registered for scripts just like the root. Returns the root's EntityHandle, or null (with a warn log) when no prefab by that name exists. Note: destroying the returned root does NOT cascade to its children — destroy is per-entity, so destroy each child yourself if you want the whole subtree gone.
- `ctx.scene.destroy(idOrHandle: string | EntityHandle): void` — Remove an entity from the current scene at runtime.
- `ctx.scene.findPath(from: Vec2, to: Vec2, opts?: { diagonals?: boolean }): Vec2[] | null` — Grid A* path from `from` to `to` over solid tilemaps and static, non-trigger colliders currently in the scene. Waypoints are cell centers; null when unreachable or the grid is too large; set diagonals to allow 8-directional movement.
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
- `ctx.animator.setParam(entityRef: string, name: string, value: boolean | number): void` — Set a bool or number param on entityRef's AnimationStateMachine (id or unique name — not always this entity). Persists until changed again. Throws a script error if entityRef has no AnimationStateMachine, name isn't a param on its asset, name is a trigger param (use ctx.animator.fire instead), or value's type doesn't match the param's declared type.
- `ctx.animator.getParam(entityRef: string, name: string): boolean | number` — Read a param's current value: the stored bool/number for a bool or number param, or whether a trigger param is currently latched (true) or already consumed/never fired (false). Throws if entityRef has no AnimationStateMachine or name isn't a param on its asset.
- `ctx.animator.fire(entityRef: string, name: string): void` — Latch a trigger param on entityRef's AnimationStateMachine. Stays latched — surviving as many fixed frames as it takes — until a transition whose conditions name it is actually taken, at which point only that trigger is consumed; other latched triggers are untouched. A paused machine (component.playing = false) never consumes it. Throws if entityRef has no AnimationStateMachine, name isn't a param on its asset, or name isn't a trigger param.
- `ctx.animator.state(entityRef: string): string` — The current state name of entityRef's AnimationStateMachine. Throws if entityRef has no AnimationStateMachine or its asset is unknown.
- `ctx.math.vec2(x?: number, y?: number): Vec2` — Create a vector {x, y}. Missing args default to 0.
- `ctx.math.add(a: Vec2, b: Vec2): Vec2` — Vector addition. Pure — returns a new value without mutating inputs.
- `ctx.math.sub(a: Vec2, b: Vec2): Vec2` — Vector subtraction. Pure — returns a new value without mutating inputs.
- `ctx.math.scale(v: Vec2, s: number): Vec2` — Scale a vector by a scalar. Pure — returns a new value.
- `ctx.math.dot(a: Vec2, b: Vec2): number` — Dot product of two vectors.
- `ctx.math.length(v: Vec2): number` — Length (magnitude) of a vector.
- `ctx.math.distance(a: Vec2, b: Vec2): number` — Distance between two points.
- `ctx.math.normalize(v: Vec2): Vec2` — Unit vector in the direction of v ({x:0,y:0} for the zero vector). Pure — returns a new value.
- `ctx.math.angle(v: Vec2): number` — Angle of a vector in degrees (0 = +x, 90 = +y/down).
- `ctx.math.fromAngle(degrees: number, length?: number): Vec2` — Unit vector from an angle in degrees (default length 1). 0 = +x, 90 = +y/down.
- `ctx.math.lerp(a: number, b: number, t: number): number` — Linear interpolation between two scalars. Does not clamp t.
- `ctx.math.lerpVec(a: Vec2, b: Vec2, t: number): Vec2` — Linear interpolation between two vectors. Does not clamp t. Pure — returns a new value.
- `ctx.math.clamp(x: number, min: number, max: number): number` — Clamp a value to [min, max].
- `ctx.math.hexToRgb(hex: string): { r: number; g: number; b: number }` — Parse a hex color string (#rgb, #rrggbb, or #rrggbbaa) to {r, g, b}. Returns white on invalid input (warns once per instance).
- `ctx.math.rgbToHex(r: number, g: number, b: number): string` — Convert RGB channels (0–255) to a hex color string. Clamps and rounds channel values.
- `ctx.math.colorLerp(hexA: string, hexB: string, t: number): string` — Interpolate between two hex colors. Clamps t to [0, 1].
- `ctx.save(key: string, value: unknown): void` — Persistent save data (JSON values), survives scene switches; in the browser it persists across sessions via localStorage.
- `ctx.load(key: string): unknown` — Read saved data; null when absent.
- `ctx.clearSave(key?: string): void` — Clear one save key, or all save data when no key is given.
- `ctx.camera.getPosition(): Vec2` — The main camera's position {x, y}.
- `ctx.camera.setPosition(x: number, y: number): void` — Move the main camera.
- `ctx.camera.getZoom(): number` — The main camera's zoom factor.
- `ctx.camera.setZoom(zoom: number): void` — Set the main camera's zoom factor.
- `ctx.camera.follow(idOrName: string | null): void` — Follow an entity each frame (null stops). Warn log if not found.
- `ctx.camera.shake(intensity: number, seconds: number, opts?: { seed?: number }): void` — Screen shake: offset decays linearly from `intensity` (world units) to 0 over `seconds`. Deterministic — same seed (explicit or scene-derived) reproduces the same offsets.
- `ctx.camera.flash(color: string, seconds: number): void` — A color pulse over the screen that fades from full alpha to 0 over `seconds`.
- `ctx.camera.fade(alpha: number, seconds: number, opts?: { color?: string; onComplete?: () => void }): void` — Ease the persistent screen overlay toward `alpha` over `seconds`, then hold at that level. Survives scene switches (ctx.scenes.load). Last call wins: a new fade replaces an in-flight one (starting from the current level), and the superseded fade's onComplete is dropped, never fired — only the winning fade's onComplete runs, once.
- `ctx.camera.zoomPunch(scale: number, seconds: number): void` — A zoom kick that eases back to 1x over `seconds`.
- `ctx.effects.flash(color?: string, seconds?: number): void` — Trigger this entity's own hit-flash: sets its SpriteEffects flashColor/flashStrength=1/flashDuration (adding the component if the entity doesn't have one; authored scene data is untouched). flashStrength then decays linearly back to 0 over `seconds` (default 0.15, clamped to [0.01, 10]), deterministically, no RNG. For a camera-wide look instead of a per-sprite flash, use data-driven Camera.postEffects (e.g. a 'vignette' or 'colorGrade' entry) rather than this.
- `ctx.audio.play(assetRef: string, opts?: { volume?: number; loop?: boolean }): string | null` — Play an audio asset (by asset id or name). Returns a handle id for ctx.audio.stop, or null when the asset does not exist.
- `ctx.audio.stop(handleIdOrAssetRef: string): void` — Stop a playback by handle id, or every playback of an asset id/name.
- `ctx.audio.playMusic(assetRef: string, opts?: { volume?: number; loop?: boolean; fadeIn?: number }): string | null` — Play a track on the single shared music channel (by asset id or name); replaces any current track. Survives scene switches. Returns a handle id, or null when the asset does not exist.
- `ctx.audio.stopMusic(opts?: { fadeOut?: number }): void` — Stop the current music track. No-op when nothing is playing.
- `ctx.audio.setMusicVolume(volume: number, opts?: { fade?: number }): void` — Change the current music track's volume. No-op when nothing is playing.
- `ctx.vars` — Persistent per-entity state, survives across frames (not across scene switches — use ctx.save).
- `ctx.time` — Elapsed seconds, delta seconds, and frame count.
- `ctx.log(...args: unknown[]): void` — Log to the Hearth console (shows up in playtest and smoke-run reports).
- `ctx.collisions` — This entity's current collisions (refreshed each frame): { other, normal, trigger }.
- `ctx.isGrounded(): boolean` — Any non-trigger contact pushing this entity up (normal.y < -0.5).
- `ctx.destroySelf(): void` — Remove this entity from the scene.
- `ctx.events.emit(name: string, data?: unknown): void` — Broadcast an event to the whole scene, synchronously and deterministically: every ctx.events.on subscriber for `name` fires in subscription order, including this entity's own. Also triggers every script's onEvent(ctx, name, data) hook, in entity order. Nested emits (an onEvent handler emitting again) are allowed up to 8 levels deep; deeper emits are dropped with a warning.
- `ctx.events.on(name: string, fn: (data: unknown) => void): string` — Subscribe to an event by name. Returns a subscription id for ctx.events.off. The subscription is automatically removed when this entity is destroyed.
- `ctx.events.off(id: string): void` — Unsubscribe by id (as returned by ctx.events.on). Unknown ids are a no-op.
- `ctx.ui.focus(idOrName: string | null): void` — Set focus to an entity by id/name, or clear it with null. Fires onUiEvent {type:'blur'} on the previously focused entity and {type:'focus'} on the new one. Warns (no-op) when the target is unknown, disabled, or its UIElement.focusable is not true. Focusing the already-focused entity is a no-op.
- `ctx.ui.getFocused(): string | null` — The currently focused entity id, or null.
- `ctx.ui.moveFocus(direction: 'up' | 'down' | 'left' | 'right'): void` — Move focus among focusable UIElement entities: picks the nearest candidate strictly in `direction` from the current focus position (or the top-left-most candidate when nothing is focused). No wrap — a no-op when nothing lies further that way.
- `ctx.ui.activate(): void` — Synthesizes a press+release (a click) at the focused element’s center, through the normal pointer path — so slider/toggle behavior fires exactly as a real click would. Warns (no-op) when the focused entity is not interactive; no-op when nothing is focused.
- `ctx.ui.adjust(delta: number): void` — For a focused UISlider: value += delta * (step || (max-min)/10), clamped to [min, max], firing onUiEvent {type:'change', value}. No-op when nothing is focused or it has no UISlider.

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
`set_component_property`, `set_properties`, `check_script`,
`create_sound`, `run_playtest`, `get_diff`, `export_web`,
`export_desktop`, ...). Call `get_agent_instructions` for this document.
(`hearth init --template` is pre-project, so it has no MCP tool — it's a
CLI-only step before a session exists.)

Generated by Hearth 0.13.0.
