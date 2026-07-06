# UI Guide

Hearth's game UI (HUDs, menus, settings screens) is built from ordinary
entities and components — `UIElement`, `UILayout`, `UISlider`, `UIToggle`
— not a parallel widget tree. Visuals still come from `Text` and
`SpriteRenderer`; `UIElement` just repositions an entity into screen space
and, optionally, wires it into pointer and focus input. Everything here
works identically in the editor preview, headless playtests, and exported
games.

## UIElement: the screen-space basics

Give any entity a `UIElement` and its position becomes screen-space,
unaffected by camera position or zoom:

| Field | Default | Meaning |
| --- | --- | --- |
| `anchor` | `top-left` | One of the nine screen positions: `top-left`, `top`, `top-right`, `left`, `center`, `right`, `bottom-left`, `bottom`, `bottom-right` |
| `offset` | `{x:0, y:0}` | Pixels from the anchor point, in the game's `buildSettings` width×height space |
| `interactive` | `false` | Receives pointer events; the entity's `Script` gets `onUiEvent` |
| `focusable` | `false` | Joins keyboard/gamepad focus navigation via `ctx.ui` |

`Transform.position` is ignored once an entity has a `UIElement` (scale
and rotation still apply). `interactive` and `focusable` are independent:
a button is usually both, a display-only HUD label is neither, and a
focusable-but-not-interactive element can receive focus but never fires
click-family events (see [Focus and `ctx.ui`](#focus-and-ctxui) below).

Z-order (both for rendering and for which element wins a pointer hit when
two overlap) comes from `layer` on whichever visual/widget component the
entity has — `SpriteRenderer.layer`, `Text.layer`, `UISlider.layer`, or
`UIToggle.layer` — not from `UIElement` itself, which has no `layer`
field. Full schema defaults for every component: [components.md](./components.md).

## UILayout: stacking containers

A `UILayout` entity has no visuals of its own — give it a `UIElement` for
its own anchor/offset, then parent the widgets you want stacked to it.
The runtime reflows its `UIElement` children on demand — pointer events,
focus navigation, and (in the pixi host) every render tick — along
`direction` (`vertical`/`horizontal`), spaced by `gap`, inset by
`padding`, cross-aligned by `align` (`start`/`center`/`end`). A stacked
child's own `anchor`/`offset` are ignored — its position comes entirely
from the layout:

```jsonc
// A vertical menu: title, then three buttons, 12px apart.
{
  "name": "MenuStack",
  "components": {
    "UIElement": { "anchor": "center", "offset": { "x": 0, "y": 0 } },
    "UILayout": { "direction": "vertical", "gap": 12, "align": "center" }
  }
}
```

Hit-testing and focus navigation both use each child's *reflowed*
position, so drag/click/`moveFocus` all behave exactly as they would if
you'd hand-placed the same coordinates.

## UISlider

A draggable value widget the runtime renders and hit-tests itself (track
+ fill + handle) — no `SpriteRenderer` needed. Put it on an entity with
`UIElement{interactive: true}` (and usually `focusable: true`):

| Field | Default | Meaning |
| --- | --- | --- |
| `min` / `max` | `0` / `1` | Value range |
| `value` | `0.5` | Current value |
| `step` | `0` | Snap increment; `0` = no snapping (any value in range) |
| `width` | `160` | Track width, pixels (scales with `Transform.scale.x`) |
| `trackColor` / `fillColor` / `handleColor` | `#3a3a3a` / `#f76b15` / `#ececec` | Colors |
| `layer` | `0` | Higher renders/hit-tests on top |

Dragging the handle (pointer down, then move) maps the pointer position
onto the track and writes `value`, firing `onUiEvent {type: 'change',
value}` whenever it actually changes. `value` is in the slider's own
`min`-`max` range, not normalized to `0..1`.

```lua
function script.onUiEvent(ctx, event)
  if event.type == "change" then
    ctx.audio.setMusicVolume(event.value)
  end
end
```

## UIToggle

A boolean checkbox widget, same self-rendering deal as `UISlider`:

| Field | Default | Meaning |
| --- | --- | --- |
| `value` | `false` | Current state |
| `size` | `20` | Box size, pixels |
| `color` / `checkColor` | `#3a3a3a` / `#f76b15` | Box and check-mark colors |
| `layer` | `0` | Higher renders/hit-tests on top |

A click flips `value` and fires `onUiEvent {type: 'change', value}` with
the new boolean:

```lua
function script.onUiEvent(ctx, event)
  if event.type == "change" then
    ctx.vars.muted = event.value
  end
end
```

## Focus and `ctx.ui`

`focusable: true` on a `UIElement` lets it participate in keyboard/gamepad
navigation, driven entirely from scripts — Hearth has no built-in
controller-to-menu wiring, you write it with `ctx.ui` and your own input
actions:

| Member | What it is |
| --- | --- |
| `ctx.ui.focus(idOrName)` | Focus a focusable element by id/name; `nil`/`null` clears focus |
| `ctx.ui.getFocused()` | Currently focused entity's id, or `nil`/`null` |
| `ctx.ui.moveFocus(direction)` | Move to the nearest focusable candidate in `"up"\|"down"\|"left"\|"right"` |
| `ctx.ui.activate()` | Click the focused element |
| `ctx.ui.adjust(delta)` | Nudge a focused `UISlider`'s value |

`moveFocus` picks the nearest candidate strictly in that direction (by
screen position) from the current focus — or the top-left-most candidate
if nothing is focused yet — with no wraparound: moving off an edge with
nothing further that way is a no-op. `activate` replays a full
press/release/click at the focused element (so it fires the same
`onUiEvent`s a real click would — a focused `UIToggle` flips, a focused
button's script runs its click handler); it warns and does nothing if the
focused element isn't `interactive`. `adjust(delta)` only affects a
focused `UISlider` (moves `value` by `delta` steps, or a tenth of its
range if `step` is `0`) — it's a no-op on anything else, including a
focused `UIToggle` (use `activate` to flip one).

```lua
-- Pause menu navigation driven from input actions.
local script = {}

function script.onUpdate(ctx, dt)
  if ctx.input.justPressed("menuDown") then ctx.ui.moveFocus("down") end
  if ctx.input.justPressed("menuUp") then ctx.ui.moveFocus("up") end
  if ctx.input.justPressed("menuLeft") then ctx.ui.adjust(-1) end
  if ctx.input.justPressed("menuRight") then ctx.ui.adjust(1) end
  if ctx.input.justPressed("confirm") then ctx.ui.activate() end
end

return script
```

A menu that opens should focus its first control explicitly
(`ctx.ui.focus("Resume")`) and a menu that closes should clear it
(`ctx.ui.focus(nil)`) — focus doesn't move or clear itself.

## `onUiEvent` reference

`Script.onUiEvent(ctx, event)` fires on an entity with `interactive`
and/or `focusable` `UIElement`. `event` is `{ type, x, y, value? }`:

| `type` | Fires when | `value` |
| --- | --- | --- |
| `enter` / `exit` | The hovered element under the pointer changes | — |
| `press` / `release` | Pointer down / up on this element | — |
| `click` | Pointer up lands on the same element it went down on | — |
| `drag` | Pointer moves while pressed on this element (whether or not still hovering it) | — |
| `change` | A `UISlider`/`UIToggle`'s value actually changed (drag, click, or `ctx.ui.adjust`) | New value: number (slider) or boolean (toggle) |
| `focus` / `blur` | This element gained / lost keyboard-gamepad focus, via `ctx.ui` | — |

`x`/`y` are always screen coordinates in the `buildSettings` width×height
space; for `focus`/`blur` (which have no real pointer position behind
them) they're the element's own resolved screen position. `value` is only
present on the event object when it applies — check `event.value ~= nil`
(Lua) / `event.value !== undefined` (JS) rather than assuming a type.

## Playtests

Beyond `press`/`release`/`click` (see [cli.md](./cli.md#command-tour)),
two steps exercise widgets and focus directly:

| Step | What it does |
| --- | --- |
| `{ "type": "drag", "from": {x,y}, "to": {x,y}, "frames": 5 }` | A real pointer gesture: down at `from`, `frames` interpolated moves toward `to` (default `5`, one frame each), then up at `to` — exercises slider dragging exactly like a mouse would |
| `{ "type": "assertFocus", "entity": "Resume" }` | Asserts the focused entity's id or name matches (`entity: null` asserts nothing is focused) |

```jsonc
{
  "steps": [
    { "type": "assertFocus", "entity": "VolumeSlider" },
    { "type": "drag", "from": { "x": 400, "y": 300 }, "to": { "x": 460, "y": 300 }, "frames": 6 },
    { "type": "assertProperty", "entity": "VolumeSlider", "property": "UISlider.value", "greaterThan": 0.5 }
  ]
}
```

## HUD vs. menu patterns

A **HUD** element (score label, health bar) is typically `UIElement` with
`interactive: false` and no `focusable` — it's positioned in screen space
and updated from scripts (`ctx.getComponent("Text").content = tostring(score)`),
never clicked. A **menu** control is `interactive: true` (and usually
`focusable: true`) so it responds to both a mouse/touch click and
controller/keyboard focus navigation — build one `UILayout` per menu
screen, parent its buttons/sliders/toggles to it, and drive focus from a
single script the way [Focus and `ctx.ui`](#focus-and-ctxui) shows above.
See `packages/examples/drift-cellar` for a complete pause menu (a
`UILayout` stack, a `UISlider` for music volume, a `UIToggle`, and focus
navigation wired from input actions) exercised by real playtests.
