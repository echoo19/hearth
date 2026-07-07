# Input Guide

Scripts never read raw keys or gamepad state directly — everything goes
through named **actions** (digital: pressed or not) and named **virtual
axes** (analog, `-1..1`), both defined once in `hearth.json`'s
`inputMappings` and shared by keyboard, gamepad, and playtests alike. This
page covers actions, keyboard bindings, gamepad buttons and axes, virtual
axes, `ctx.input`, the editor's Input panel, CLI/MCP configuration, and
playtest input steps.

## Actions

An action is just a name (`"jump"`, `"moveLeft"`, whatever you pick) bound
to one or more `KeyboardEvent.code` values and, optionally, one or more
named gamepad buttons or a gamepad-axis-crossed-a-threshold binding.
Scripts read actions, never bindings:

```lua
if ctx.input.isDown("moveRight") then
  body.velocity.x = 150
end

if ctx.input.justPressed("jump") and ctx.isGrounded() then
  body.velocity.y = -400
end
```

`isDown` is true every frame the action is held; `justPressed` is true
only on the frame it went down. Rebinding an action's keys or gamepad
buttons never touches scripts — they keep working unchanged.

## Keyboard bindings

`inputMappings.actions` maps an action name to a list of
`KeyboardEvent.code` strings (`"ArrowLeft"`, `"KeyA"`, `"Space"`, …, not
`KeyboardEvent.key` — codes are layout-independent). Any code in the list
satisfies the action:

```bash
hearth set-input jump Space KeyW    # either key presses "jump"
hearth set-input jump                # no keys: removes the action entirely
```

## Gamepad

Gamepad support is **browser-only** — it polls the
[Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API),
so it works in the editor preview and exported web games, not in headless
Node (playtests drive actions and axes directly instead — see
[Playtest input](#playtest-input) below).

### Named buttons

`inputMappings.gamepadButtons` maps an action name to a list of named
buttons (any one satisfies the action, same OR semantics as keyboard
codes), using the W3C standard gamepad mapping:

`a`, `b`, `x`, `y`, `lb`, `rb`, `lt`, `rt`, `back`, `start`, `ls`, `rs`,
`dpad-up`, `dpad-down`, `dpad-left`, `dpad-right`

```bash
hearth set-settings --input-gamepad-buttons '{"jump":["a"],"attack":["x","rt"]}'
```

Keyboard and gamepad bindings for the same action combine — either
satisfies `isDown`/`justPressed`.

### Digital axis bindings

A stick or trigger can also drive a digital action directly:
`inputMappings.gamepadAxes` maps an action name to one
`{ axis, direction, threshold }` binding — `axis` is the raw gamepad axis
index, `direction` is `1` or `-1` (which side of center counts), and
`threshold` (default `0.5`) is how far past center it must cross. This is
for actions that only care about "pressed or not" (e.g. a trigger mapped
to "fire"); for analog movement, use a virtual axis instead.

```bash
hearth set-settings --input-gamepad-axes '{"right":{"axis":0,"direction":1,"threshold":0.5}}'
```

Crossing is a latch with a little hysteresis, not a raw comparison: a
binding engages once the axis clears the effective threshold (`threshold`,
floored by the deadzone), but only releases once the axis drops at least
`0.05` back below that same threshold. This keeps stick noise sitting
right on the line from flapping the action on and off and re-firing
`justPressed` every frame. Each connected pad tracks its own latch per
binding, so the per-pad-OR behavior above still holds — one pad releasing
doesn't affect another pad's hold on the same action.

### Virtual axes (analog)

For continuous analog input (movement, aiming), define a **virtual axis**
in `inputMappings.axes` and read it with `ctx.input.axis(name)`, returning
a float in `[-1, 1]`:

| Field | Default | Meaning |
| --- | --- | --- |
| `gamepadAxis` | — | Raw gamepad axis index this virtual axis reads from |
| `negativeCodes` | `[]` | Keyboard codes that push the axis to `-1` |
| `positiveCodes` | `[]` | Keyboard codes that push the axis to `+1` |
| `deadzone` | — (falls back to the mapping-wide default) | Per-axis deadzone override, `0`-`1` |

```bash
hearth set-settings --input-axes '{"horizontal":{"gamepadAxis":0,"negativeCodes":["ArrowLeft","KeyA"],"positiveCodes":["ArrowRight","KeyD"]}}'
```

```lua
body.velocity.x = ctx.input.axis("horizontal") * speed
```

Reading order, every frame: a gamepad reading on the bound `gamepadAxis`
wins once its magnitude clears the deadzone (clamped to `[-1, 1]`);
otherwise the keyboard codes decide (`-1` if only a negative code is held,
`+1` if only a positive one, `0` if both or neither); an axis name with no
entry in `inputMappings.axes` always reads `0`. `inputMappings.deadzone`
(default `0.15`) is the project-wide stick deadzone, applied to every
virtual axis and gamepad-axis-crossing binding unless a virtual axis sets
its own:

```bash
hearth set-settings --input-deadzone 0.2
```

## Reading input in scripts

| Member | What it is |
| --- | --- |
| `ctx.input.isDown(action)` | Is the action held this frame? |
| `ctx.input.justPressed(action)` | Did the action go down this frame? |
| `ctx.input.axis(name)` | Analog value in `[-1, 1]` for a virtual axis |

See [scripting.md](./scripting.md#input) for these in context alongside
the rest of the `ctx` API.

## Editor Input panel

The editor's Input settings panel (Settings → Input) has three sections:

- **Actions** — one row per action: a key-capture control (click, then
  press a key; Escape cancels) adds/removes bound codes as chips, plus a
  gamepad-button dropdown (populated from the named-button list above,
  already-bound buttons excluded) and an optional digital gamepad-axis
  binding (axis index, direction, threshold).
- **Virtual axes** — one row per axis: a renamable name, an optional
  gamepad axis index (checkbox + number field), key-capture rows for
  `negativeCodes`/`positiveCodes`, and a per-axis deadzone override
  (checkbox + number field, defaulting to the global value when first
  enabled).
- **Global** — the project-wide default deadzone.

Every edit round-trips through `updateSettings`, same as the CLI/MCP path
below — the panel is a UI over the identical command, not a separate code
path.

## CLI / MCP configuration

| What | CLI | MCP |
| --- | --- | --- |
| Action keys | `hearth set-input <action> [keys...]` | `set_input_mapping({ action, keys })` |
| Everything else (gamepad buttons/axes, virtual axes, deadzone, build settings, initial scene) | `hearth set-settings [--input-gamepad-buttons ...] [--input-gamepad-axes ...] [--input-axes ...] [--input-deadzone n]` | `update_settings({ inputMappings: { gamepadButtons?, gamepadAxes?, axes?, deadzone? } })` |

`actions` merges **per action**, on every surface: `set-input`/
`set_input_mapping` touch exactly one action (empty keys removes it), and
`set-settings --input-actions`/`update_settings`'s `actions` field does
the same for each action you list — a listed action's key list is
replaced (or, with `[]`, the action is deleted), and every unlisted
action is left untouched. The other four `inputMappings` fields —
`gamepadButtons`, `gamepadAxes`, `axes`, `deadzone` — are each **replaced
wholesale** when provided: passing `gamepadButtons` replaces the entire
map, so include every action you want bound, not just the one you're
changing. See [cli.md](./cli.md#command-tour) and [mcp.md](./mcp.md) for
the full command/tool references.

## Playtest input

Playtests are headless (no real keyboard, no real Gamepad API), so they
drive actions and axes directly:

| Step | What it does |
| --- | --- |
| `{ "type": "press", "action": "jump", "frames": 1 }` | Hold an action down for `frames` fixed frames (default `1`) |
| `{ "type": "release", "action": "jump" }` | Release a held action |
| `{ "type": "setAxis", "axis": "horizontal", "value": 1, "frames": 10 }` | Stick a virtual axis at `value` (a **sticky** override — stays until a later `setAxis` overwrites it; there's no separate "clear" step), then run `frames` frames (default `1`) |

```jsonc
{
  "steps": [
    { "type": "setAxis", "axis": "horizontal", "value": 1, "frames": 30 },
    { "type": "assertPositionNear", "entity": "Player", "x": 350, "y": 300, "tolerance": 5 }
  ]
}
```

`setAxis` bypasses gamepad/keyboard reads entirely for that axis for the
rest of the playtest (or until overwritten) — `ctx.input.axis(name)`
returns exactly the value you set. See [cli.md](./cli.md#command-tour) for
`press`/`release`/`click`/`drag` and the full assertion-step list, and
[ui.md](./ui.md#playtests) for `drag`/`assertFocus` — the widget-focused
counterparts of `press`/`setAxis`.
