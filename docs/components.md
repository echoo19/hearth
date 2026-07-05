# Component Reference

Generated from the Zod schemas in `packages/core/src/schema/components.ts`. Run `hearth inspect components --json` for the machine-readable form.

## Transform

Position (pixels), rotation (degrees), and scale of an entity. Almost every entity needs one.

Defaults:

```json
{
  "position": {
    "x": 0,
    "y": 0
  },
  "rotation": 0,
  "scale": {
    "x": 1,
    "y": 1
  }
}
```

## SpriteRenderer

Renders a sprite asset (assetId) or a colored primitive (shape/color/width/height) when no asset is set.

Defaults:

```json
{
  "assetId": null,
  "frame": null,
  "shape": "rectangle",
  "color": "#ffffff",
  "width": 32,
  "height": 32,
  "opacity": 1,
  "flipX": false,
  "flipY": false,
  "layer": 0,
  "visible": true
}
```

`frame` names a frame on `assetId`'s sliced spritesheet (see
[assets.md](./assets.md#slicing-a-spritesheet)) to draw as a
sub-rectangle of the texture instead of the whole image; `null` (the
default) always draws the whole image, sliced or not. `SpriteAnimator`
sets this automatically for sheet-backed clips — see
[SpriteAnimator](#spriteanimator) below. An unresolvable `frame` logs a
warning once and falls back to the whole texture (also flagged by
`hearth validate` as `FRAME_NOT_FOUND`).

`color` doubles as a **tint** on textured sprites (an asset is set), not
just the primitive fallback's fill — edits take effect immediately. The
default `#ffffff` is a no-op tint, so existing projects render
unchanged; set it to anything else to recolor real art (a damage flash,
a grayed-out disabled state) without a second sprite asset.

## Collider

Box, circle, or convex polygon collision shape (polygon uses points, local space, min 3 convex vertices). isTrigger=true reports overlaps without blocking movement.

Defaults:

```json
{
  "shape": "box",
  "width": 32,
  "height": 32,
  "radius": 16,
  "points": [
    { "x": 0, "y": -16 },
    { "x": 16, "y": 16 },
    { "x": -16, "y": 16 }
  ],
  "offset": {
    "x": 0,
    "y": 0
  },
  "isTrigger": false,
  "layer": "default",
  "collidesWith": ["*"],
  "oneWay": false
}
```

Polygon colliders are **convex only**: at least 3 points, no duplicate
consecutive points, convex winding (`validateProject` enforces all three).
Split concave shapes across multiple entities. Points are local space and
respect the entity's scale and rotation.

`layer` names this collider's own layer; `collidesWith` lists the layers
it will contact (`"*"` matches any layer). **Both sides must list the
other**: two colliders only interact when A's `collidesWith` includes B's
`layer` (or `"*"`) *and* B's `collidesWith` includes A's `layer` (or
`"*"`) — a one-sided list is a no-op. A solid `Tilemap`'s auto-generated
colliders are always `layer: "default"`, `collidesWith: ["*"]`. `oneWay:
true` makes a **non-trigger** collider only block movers landing on top
of it while moving downward — approaching from below or the side always
passes through; a `oneWay` **trigger** collider is unaffected by this
(triggers already never block, and report contact from every side).

## PhysicsBody

Simple physics: dynamic bodies fall with gravity and collide; kinematic bodies move by velocity only; static bodies never move.

Defaults:

```json
{
  "bodyType": "dynamic",
  "velocity": {
    "x": 0,
    "y": 0
  },
  "gravityScale": 1,
  "drag": 0,
  "mass": 1,
  "restitution": 0,
  "friction": 0
}
```

`mass` only matters between two `dynamic` bodies pushing on each other —
the overlap resolution splits proportionally, so a heavier body shoves a
lighter one further than it gets shoved back (a `static`/`kinematic`
obstacle is treated as infinitely heavy regardless of `mass`).

`restitution` (0-1, bounciness) and `friction` (0-1, tangential damping on
contact) are **combined per contact pair by taking the max of both
sides**: a bouncy `Ball` (`restitution: 0.85`) still bounces off a plain
`static` floor with `restitution: 0` (`max(0.85, 0) = 0.85`); a floor with
its own `friction: 1` slows anything that touches it regardless of that
body's own `friction`. A `Tilemap`'s solid tiles have no material of their
own — they're always an effective `(restitution: 0, friction: 0)` contact
partner, so give a floor real friction by adding a separate `static`
entity with its own `Collider` + `PhysicsBody{friction}`, not by editing
the tilemap. Restitution is suppressed below a **20 px/s** incoming
contact speed (no micro-bounce jitter as a body comes to rest) — below
that, a bounce settles into a stop instead of jittering forever.

## Script

Attaches a behavior script from scripts/ (scriptPath) — Lua (`.lua`, the default) or JavaScript (`.js`). params are passed to the script as ctx.params.

Defaults:

```json
{
  "scriptPath": "",
  "params": {}
}
```

## Camera

Viewpoint for the scene. One entity should have a Camera with isMain=true.

Defaults:

```json
{
  "zoom": 1,
  "isMain": true,
  "backgroundColor": "#1a1a2e",
  "ambientLight": 1
}
```

`ambientLight` sets scene brightness with no lights present: `1` is fully
lit — lighting is disabled entirely and the renderer skips the lightmap pass,
so existing projects with no `Light2D`s render exactly as before this
feature existed — down to `0`, black except inside a `Light2D`'s radius.
Lower it (e.g. `0.15`) for a dark scene lit by torches/lanterns placed as
`Light2D` entities.

## Text

Renders UI/world text (content, fontSize, color).

Defaults:

```json
{
  "content": "Text",
  "fontSize": 16,
  "color": "#ffffff",
  "align": "left",
  "fontFamily": "monospace",
  "layer": 10,
  "visible": true
}
```

## AudioSource

References an audio asset; autoplay plays on scene start with loop/volume. Scripts can also play any audio asset via `ctx.audio.play(assetRef, { volume, loop })`.

Defaults:

```json
{
  "assetId": null,
  "autoplay": false,
  "loop": false,
  "volume": 1,
  "music": false
}
```

Create sound assets with `hearth create sound <name> --preset coin`
(deterministic procedural WAVs; presets: `coin`, `jump`, `hit`, `laser`,
`powerup`, `explosion`, `blip`). Headless runs record every play/stop as
`audioEvents` in the run report.

`music: true` routes scene-start `autoplay` onto the single shared music
channel (`ctx.audio.playMusic`) instead of a regular one-shot/looping
playback — use it for a soundtrack entity that should start on its own
and survive `ctx.scenes.load` scene switches. See
[assets.md](./assets.md#music) for the full `playMusic`/`stopMusic`/
`setMusicVolume` semantics, including the streaming-vs-single-file-export
caveat.

## UIElement

Makes the entity screen-space UI: positioned by anchor+offset, unaffected by the camera. Visuals come from Text/SpriteRenderer. interactive=true sends pointer events to the Script hook `onUiEvent(ctx, event)`.

Defaults:

```json
{
  "anchor": "top-left",
  "offset": {
    "x": 0,
    "y": 0
  },
  "interactive": false
}
```

Anchors: `top-left`, `top`, `top-right`, `left`, `center`, `right`,
`bottom-left`, `bottom`, `bottom-right` — points in the game's
`buildSettings` width×height space; `offset` is pixels from there.
`Transform.position` is ignored (scale and rotation still apply). UI
renders above all world layers; within UI, `layer` orders elements.
Interactive elements are hit-tested against the SpriteRenderer's rect
and/or the measured Text bounds; events are
`click`, `press`, `release`, `enter`, `exit`.

## Tilemap

Character-grid tilemap: tileAssets maps grid characters to assets; solid=true auto-generates colliders.

Defaults:

```json
{
  "tileSize": 32,
  "tileAssets": {},
  "grid": [],
  "solid": true,
  "layer": -10
}
```

(This `layer` is the rendering z-order — the same numeric layer every
other `SpriteRenderer`/`Text`/etc. uses — not a `Collider.layer` physics
layer name. A solid Tilemap's generated colliders are always physics
`layer: "default"`, `collidesWith: ["*"]`; see [Collider](#collider)
above.)

## Light2D

Emits dynamic 2D light (radius, color, intensity) in the forward rendering pipeline.

Defaults:

```json
{
  "radius": 200,
  "color": "#ffffff",
  "intensity": 1,
  "enabled": true
}
```

`radius` is the light's falloff distance in world pixels (quadratic falloff,
full brightness at the center); `intensity` multiplies brightness at the
center (values above 1 blow out to white faster). `enabled: false` removes
the light from the lightmap without deleting the entity. Every enabled
`Light2D` in the scene is composited into one lightmap alongside `Camera.
ambientLight`, so a dark `ambientLight` (e.g. `0.15`) plus a handful of
lights reads as torches/lanterns punching pools of visibility out of the
dark — see [architecture.md](./architecture.md#rendering) for how the
lightmap is built. Lights ignore the entity's rotation/scale (only position
matters); parent a light to a moving entity (e.g. the player) to make a
"torch" that follows them — children inherit only their parent's
translation, so a fixed local offset stays put relative to the parent.

## LineRenderer

Renders a polyline in local space; use for debug geometry or simple line effects.

Defaults:

```json
{
  "points": [],
  "width": 2,
  "color": "#ffffff",
  "closed": false,
  "opacity": 1,
  "layer": 0,
  "visible": true
}
```

`points` are `Vec2`s in local space — the entity's `Transform`
(position/rotation/scale) applies to the whole line, so you can move or
rotate a line by moving its entity rather than rewriting every point.
`closed: true` connects the last point back to the first, turning a
polyline into a closed outline (a cave wall, a patrol path, a fenced-off
area). Good for level geometry that doesn't need art: cave walls, beams,
borders, debug paths.

## ParticleEmitter

Spawns and simulates particles deterministically; seed controls reproducibility.

Defaults:

```json
{
  "emitting": true,
  "rate": 10,
  "burst": 0,
  "lifetime": 1,
  "speed": 100,
  "spread": 30,
  "direction": 0,
  "gravity": { "x": 0, "y": 0 },
  "startColor": "#ffffff",
  "endColor": "#ffffff",
  "startSize": 8,
  "endSize": 0,
  "maxParticles": 256,
  "layer": 0,
  "seed": 0
}
```

Particles spawn continuously at `rate` per second while `emitting` is true,
plus a one-time `burst` count when the scene starts (scripts can trigger
more at runtime with `ctx.particles.burst(count)` — see
[scripting.md](./scripting.md#particles)). Each particle interpolates from
`startColor`/`startSize` to `endColor`/`endSize` over its `lifetime`
seconds, launched within `spread` degrees of `direction` (`0` = +x, `90` =
+y/down) at `speed` px/s, then accelerated by `gravity` px/s². `maxParticles`
is a hard cap — the oldest particles die first when exceeded, so a runaway
emitter can't grow unbounded. `seed` makes the emitter's RNG stream
independent of every other emitter and of `ctx.random`: the same seed spawns
the exact same particles (position jitter within the cone, per-particle
timing) on every run, which is what makes `assertParticleCount` in playtests
reliable — see [scripting.md](./scripting.md#determinism) for the exact
spawn-timing rule (spawns land on whole fixed frames, not fractional ones).

A **trail** recipe (a short-lived, tightly-focused stream — sparks off a
grinder, water dripping from a ceiling) is a high `rate`, zero `spread`, and
`endSize: 0` so each particle shrinks to nothing right at the end of its
short `lifetime`:

```json
{
  "rate": 30,
  "lifetime": 0.3,
  "speed": 60,
  "spread": 0,
  "direction": 90,
  "startSize": 4,
  "endSize": 0,
  "startColor": "#9fd8ef",
  "endColor": "#9fd8ef",
  "gravity": { "x": 0, "y": 150 }
}
```

## SpriteAnimator

Plays sprite animations; requires a sibling SpriteRenderer and animation asset.

Defaults:

```json
{
  "assetId": "",
  "fps": 0,
  "playing": true,
  "loop": true
}
```

Create the animation asset first: either `hearth create animation <name>
--frames f1 f2 …` (frame args are existing sprite/tile asset ids or
names, in playback order — see [`hearth create
animation`](./cli.md#command-tour)) or, for a sliced spritesheet, `hearth
create asset anim-from-sheet <name> --sheet <asset> --frames a,b,c` (see
[assets.md](./assets.md#animations-from-a-sliced-sheet)). Each fixed
frame, `SpriteAnimator` writes the current frame's asset id into the
sibling `SpriteRenderer.assetId` — and, for a sheet-backed clip, the
frame name into `SpriteRenderer.frame` too (`null` for a plain
sprite-asset clip); `fps: 0` uses the animation asset's own
`frameDuration`, otherwise `fps` overrides it. `loop: false` stops on
the last frame and flips `playing` to false. Scripts switch clips (and
restart at frame 0) with `ctx.animate(assetRef)` — see
[scripting.md](./scripting.md#sprite-animation).

## Notes

- One component of each type per entity (format v1).
- Colors are hex strings (`#rgb`, `#rrggbb`, `#rrggbbaa`).
- Positions/sizes are pixels; rotation is degrees; +y is down.
- `SpriteRenderer` with `assetId: null` draws its primitive `shape`/`color`, so you can build a whole game before any art exists.
