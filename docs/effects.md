# Effects Guide

Hearth has two visual-effects systems, both schema data (headless-safe,
render-agnostic) that the Pixi renderer turns into hand-written GLSL
filters — nothing here requires a GPU to define or test, only to see:

- **`Camera.postEffects`** — a stack of screen-space post-processing
  filters (bloom, CRT, vignette, chromatic aberration, pixelate, color
  grade) applied to the whole game view.
- **`SpriteEffects`** — per-sprite outline, hit flash, and dissolve,
  attached to one entity at a time.

Both are ordinary component data: inspect and edit them with the same
`setComponentProperty`/`setProperties` commands (CLI `set`/`set-many`, MCP
`set_component_property`/`set_properties`) as any other component, and they
round-trip through scenes, snapshots, undo, and diffs like everything else.
See [components.md](./components.md) for the full schema reference; this
page covers the catalog, the runtime/scripting surface, and determinism.

## Camera.postEffects

`Camera.postEffects` is an array of up to **8** effect entries, each a
`{ type, ...params }` object, rendered in **stack order** — index 0's
output feeds into index 1, and so on, the same way Pixi's own filter stack
composites. The array defaults to `[]`, which is what keeps a fresh
`Camera` a no-op; an entry's own field defaults are visually reasonable
starting points, not zero/off values, so adding a bare `{"type":"bloom"}`
already applies visible bloom at `strength: 1` — you don't need to specify
every param to see an effect.

| Type | Params (default) | Range |
| --- | --- | --- |
| `bloom` | `strength` (`1`), `threshold` (`0.5`) | `strength` `0`-`3`; `threshold` `0`-`1` |
| `crt` | `curvature` (`0.15`), `scanlineIntensity` (`0.25`), `noise` (`0`) | all `0`-`1` |
| `vignette` | `intensity` (`0.4`), `color` (`#000000`) | `intensity` `0`-`1` |
| `chromaticAberration` | `offset` (`2`) | `0`-`20` |
| `pixelate` | `size` (`4`, integer) | `1`-`64` |
| `colorGrade` | `brightness` (`1`), `contrast` (`1`), `saturation` (`1`), `tint` (`#ffffff`) | `brightness`/`contrast`/`saturation` `0`-`2` |

```jsonc
{
  "postEffects": [
    { "type": "vignette", "intensity": 0.5, "color": "#000000" },
    { "type": "chromaticAberration", "offset": 3 },
    { "type": "crt", "curvature": 0.2, "scanlineIntensity": 0.3, "noise": 0.05 }
  ]
}
```

```bash
hearth set-many Level1 "Main Camera" \
  --properties '{"Camera.postEffects":[{"type":"bloom","strength":1.5,"threshold":0.6}]}'
```

Add/remove/reorder the whole array with one `setComponentProperty`/
`setProperties` call — there's no per-entry add/remove command, since the
array itself is the unit of change (the editor's Inspector control follows
the same rule, see [Editor](#editor) below).

### Order semantics

Filters stack in array order, not effect-type priority: `[bloom, crt]`
looks different from `[crt, bloom]` because CRT's scanlines/curvature warp
whatever bloom already brightened, while the reverse blooms the
already-curved CRT image. There's no implicit reordering by type — what you
write is what renders.

### No-op defaults, in full

- **Empty array** (`postEffects: []`, the schema default): the renderer
  sets the game view's `filters` to `null` — byte-identical output to a
  `Camera` from before `postEffects` existed. This is what a
  screenshot-diff test locks in (`packages/playtest/tests/screenshot.test.ts`,
  `'an empty postEffects stack is byte-identical to no post effects'`).
- **A non-empty array** always changes pixels — every effect's default
  params are chosen to be visible, not neutral. If you want "off," remove
  the entry; there's no `enabled: false` toggle per effect.

### Performance / bundle cost

Filters are cached per view and only rebuilt (a real GPU-program build)
when the stack's **shape** changes — length or per-index effect type;
changing a param value (dragging `strength` in the Inspector) just updates
uniforms on the existing filter, no rebuild. See
[performance.md](./performance.md#bundle-sizes) for the `hearth-player.js`
bundle delta these filters added (+16,827 B).

## SpriteEffects

A component, not an array — attach it to one entity to get outline, hit
flash, and dissolve on that entity's sprite. All fields default to a no-op
(outline off, `flashStrength: 0`, `dissolveAmount: 0`), so adding
`SpriteEffects` with no overrides changes nothing on screen — unlike
`Camera.postEffects`, where a bare entry is already visible.

| Field | Default | What it does |
| --- | --- | --- |
| `outlineEnabled` | `false` | Draws a solid-color outline around the sprite's opaque pixels |
| `outlineColor` | `#ffffff` | Outline color |
| `outlineWidth` | `2` (`0`-`16`) | Outline thickness in pixels |
| `flashColor` | `#ffffff` | Hit-flash tint color |
| `flashStrength` | `0` (`0`-`1`) | Current flash intensity; `1` = fully tinted, decays to `0` |
| `flashDuration` | `0.15` (`0.01`-`10`) | Seconds `flashStrength` takes to decay from `1` to `0` |
| `dissolveAmount` | `0` (`0`-`1`) | Fraction of the sprite dissolved away (noise-masked) |
| `dissolveSeed` | `0` | Seeds the per-texel dissolve pattern |

```jsonc
{ "outlineEnabled": true, "outlineColor": "#ffcc00", "outlineWidth": 3 }
```

### Hit flash

Two ways to trigger a flash:

- **`ctx.effects.flash(color?, seconds?)`** (script-facing, the common
  path): sets this entity's `SpriteEffects.flashColor`/`flashStrength: 1`/
  `flashDuration`, adding the component if the entity doesn't have one yet
  (authored scene data is left untouched — the component is created purely
  at runtime). `seconds` defaults to `0.15`, clamped to `[0.01, 10]`.

  ```lua
  ctx.effects.flash("#ff0000", 0.2)   -- red hit flash, decays over 0.2s
  ```

  ```js
  ctx.effects.flash('#ff0000', 0.2);
  ```

- **Direct component write** (`setComponentProperty` /
  `ctx.getComponent('SpriteEffects')`): set `flashStrength: 1` yourself for
  full control, e.g. driving it from a custom curve instead of the linear
  decay below.

Every fixed frame, the runtime counts every entity's `flashStrength` down
by `dt / flashDuration` (floored at `0`) — pure arithmetic, no RNG, no
lerp toward a target. A default (all-zero) `SpriteEffects` is skipped
entirely by this decay step, so attaching the component with no overrides
truly costs nothing per frame beyond the skip check.

For a camera-wide look instead of a per-sprite flash (a whole-screen white
flash on a big hit, say), use `ctx.camera.flash` (see
[scripting.md](./scripting.md#camera)) or a data-driven `Camera.postEffects`
entry (`vignette`/`colorGrade`) instead — `ctx.effects.flash` is
specifically the one-entity hit-flash.

### Dissolve

`dissolveAmount` masks out sprite texels by a per-texel hash of pixel
position + `dissolveSeed` — **no RNG, no time input**: the same seed
dissolves the exact same texels on every run, at every `dissolveAmount`.
Animate it with `ctx.tweens.to('SpriteEffects.dissolveAmount', 1, 0.6)` for
a death/spawn dissolve that's still frame-reproducible in playtests and
screenshots.

## Editor

The Inspector's **Camera** card renders `postEffects` with a dedicated
`PostEffectsField` control — one card per stack entry (type label, a typed
`NumberField`/`ColorField` per param, ↑/↓ reorder, remove) plus an "Add
effect" dropdown of the 6 types, disabled at the 8-entry cap. Every
add/remove/reorder/field-edit commits the **whole next array** in one
`setComponentProperty` call — one undo step per action, never a raw JSON
textarea (see [DESIGN.md](../DESIGN.md) — every fixed-choice or typed field
gets a real control). `SpriteEffects` gets the same typed-field treatment
as any other component in the generic Inspector (no special control
needed — its fields are all plain numbers/colors/booleans).

## Playtests: `assertPostEffect`

```jsonc
{ "type": "assertPostEffect", "effect": "bloom", "active": true }
```

Asserts whether a given effect **type** is present anywhere in the main
camera's `postEffects` stack — `active: true` requires it present,
`active: false` requires it absent. `effect` is one of the 6
`POST_EFFECT_TYPES`; `active` is required (there's no default). This checks
presence, not param values — assert `Camera.postEffects` itself with
`assertProperty`/a direct scene read if you need to check a specific
effect's params. See [cli.md](./cli.md#command-tour) for the full playtest
step catalog.

## Determinism

Every visual effect here is fixed-frame-deterministic — same seed/inputs,
same pixels, every run, which is what makes screenshot- and playtest-based
regression testing possible at all:

- **Flash decay is linear arithmetic, applied the same fixed frame it's
  triggered.** `ctx.effects.flash` runs during the script-hook phase;
  the flash-decay step runs later in that same frame, so by the time the
  frame finishes, `flashStrength` has already ticked down once. At the
  default `fixedTimestep: 60` (`dt = 1/60`) and a `0.2`s duration, the
  first read after triggering is `1 - (1/60)/0.2 ≈ 0.9167`, not exactly
  `1`. `ctx.camera.shake`/`flash`/`fade`/`zoomPunch` have the identical
  same-frame-decay behavior.
- **Dissolve is seed-hashed, not randomized.** `dissolveSeed` selects a
  fixed per-texel pattern; there's no RNG draw and no dependency on when
  in a run `dissolveAmount` changes — the same seed and amount always mask
  the same texels.
- **CRT noise is frame-derived, not wall-clock.** `crt.noise`'s only
  per-frame input is `uFrame`, fed from `runtime.frame` (the fixed-frame
  counter) — never `Date.now()`/`Math.random()`. Two runs that reach the
  same frame number render identical CRT noise.
- **Filter shape vs. value changes never cross-contaminate determinism.**
  Rebuilding a filter (on a stack-shape change) vs. refreshing its uniforms
  (on a value change) is a pure performance optimization — see
  [Performance / bundle cost](#performance--bundle-cost) — neither path
  introduces any non-deterministic state.

## Works everywhere the runtime does

Both systems are rendered by the same Pixi code path in the editor
preview, `hearth screenshot`'s headless Chromium capture, and exported web
games (`hearth export web`) — there's no editor-only preview effect and no
effect that silently drops out of an export. `hearth-player.js` (the
standalone player every export ships) bundles the same hand-written filter
shaders; see [performance.md](./performance.md#bundle-sizes) for its
measured size impact.

To actually *see* an effect rather than read its schema data, use
`hearth screenshot <scene> --frame n [--seed n]` (or the MCP `screenshot`
tool) — a deterministic PNG, so the same scene/frame/seed always renders
byte-identical pixels. `packages/playtest/tests/screenshot.test.ts` is the
canonical pixel-test reference: it builds real disk-backed fixture
projects (a spread of colored blocks for `postEffects`, a single centered
sprite for `SpriteEffects`), captures before/after each effect, and asserts
the captured bytes actually changed (or, for the empty-stack case, didn't)
— the pattern to follow for a new effect's own regression test.
