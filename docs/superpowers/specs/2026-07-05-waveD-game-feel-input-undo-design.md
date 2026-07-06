# Wave D: Game feel, input, UI widgets, editor undo (v0.7.0)

**Backlog items:** §7 UI widgets v2, §11 gamepad input, §12 screen effects tier 1,
§13 editor undo — from `2026-07-02-v0.3-engine-systems-backlog.md`.

**Goal:** By the end of this wave the engine supports controller-native games,
real in-game menus and HUDs (layouts, sliders, toggles, focus/keyboard nav),
juicy game feel (shake/flash/fade/zoom-punch), and production-grade editing
(undo/redo across editor, CLI, and MCP). Every new capability is agent-native:
CLI/MCP parity and headless assertability land with the feature, not after.

**Non-goals:** custom fragment shaders (§12 tier 2, research), scene templating
and perf broadphase (§14), the embedded agent panel (§9), analog rumble.

---

## 1. Editor undo (§13) — registry-level command history

### Architecture

Undo is a **session concern with disk-backed history**, not a UI hack. All
mutating commands flow through the single choke point
`HearthSession.execute` (`packages/core/src/session.ts`), which already
validates params, runs the command against the in-memory `ProjectStore`, and
persists via `store.save()`. Undo hooks that pipeline:

- Before running any command with `mutates: true` (except `undo`, `redo`,
  `revertProject`, `snapshotProject`), the session captures
  `store.toSnapshot()` and writes it as a history entry.
- History lives on disk under `.hearth/history/`: one JSON file per entry
  (`entry-<seq>.json` containing the full `ProjectSnapshot`) plus an
  `index.json` journal (`{ seq, command, summary, timestamp, cursor }`).
  Disk-backed is mandatory: the CLI opens a fresh session per invocation, so
  an in-memory stack would give agents no undo. The stack is bounded
  (default 25 entries; oldest pruned). `.hearth/` is already untracked.
- **Undo semantics:** `undo` restores the snapshot at the cursor (model +
  script files, reusing the `revertProject` restore logic factored into a
  shared helper), after first capturing the *current* state as the redo
  target. `redo` walks the cursor forward. Any new mutating command after an
  undo truncates the redo tail (standard editor semantics).
- **Concurrency guard:** each history entry records the `seq`; if the
  on-disk project changed outside the journal (hash mismatch on
  `index.json` cursor state vs. reality is out of scope — last-writer-wins,
  same as every other Hearth surface today).

### Binary asset files

`toSnapshot()` covers the model and script sources but not binary asset
bytes. To keep asset commands undoable:

- `deleteAsset` moves the underlying file(s) to `.hearth/trash/<assetId>/`
  instead of unlinking. Undo restores from trash; trash is pruned with the
  same bound as history.
- Undoing an asset **import** unlinks the imported file but stashes it in
  trash first, so redo restores it.
- Commands whose file side effects cannot be reversed this way (none known
  today) must declare it and clear the history stack with a warning rather
  than corrupt it.

### New commands (registry)

| Command | Permission | Description |
| --- | --- | --- |
| `undo` | write | Revert the most recent mutating command. Returns what was undone (command name + changed refs). |
| `redo` | write | Re-apply the most recently undone command. |
| `listHistory` | read | The undo/redo journal: per entry, command name, summary, timestamp, and whether it is behind or ahead of the cursor. |

### Surfaces

- **CLI:** `hearth undo`, `hearth redo`, `hearth history` (with `--json`).
- **MCP:** tools `undo`, `redo`, `list_history` with matching input shapes.
- **Editor:** global Cmd+Z / Shift+Cmd+Z listener (skipping when focus is in
  a text input), Edit-menu entries with the pending undo target's command
  name ("Undo createEntity"), and toast feedback via the existing console
  path. The Diff panel's revert copy is updated now that undo exists.

### Testing

- Core: vitest coverage for capture/undo/redo/truncate/prune, script file
  restore, asset trash restore, and the excluded-commands list.
- CLI/MCP: envelope tests for the three new verbs/tools.
- The editor keyboard path is covered by the command tests plus a smoke
  test that the listener dispatches `undo`.

---

## 2. Gamepad input (§11) — second source into the action layer

### Architecture

The runtime already speaks actions (`InputState` maps codes → actions;
scripts read `ctx.input.isDown/justPressed`; playtests call
`setActionDown/Up` directly). Gamepad input becomes **synthetic codes**
flowing through the existing `handleKeyDown/handleKeyUp` machinery:

- Buttons produce codes like `gp:a`, `gp:start`, `gp:dpad-up` (standard
  Gamepad API mapping, any connected pad; per-pad addressing is out of
  scope for v1).
- Axis thresholds produce edge-triggered codes like `gp:axis0-` /
  `gp:axis0+` when the axis crosses the threshold (default 0.5) outside the
  deadzone (default 0.15).

Because these are ordinary codes, held-state semantics, multi-binding
(keyboard + pad bound to one action), and release logic all reuse the
existing paths. `ctx.input.isDown('jump')` is unchanged. Playtests are
untouched — they drive actions, not codes.

**Polling placement:** the Gamepad API is poll-based. `InputState` gains
`pollGamepads(pads)` (pure: takes the pad list, emits synthetic code
events). The **pixi host only** calls it at the top of `onTick`, before the
fixed-step loop, passing `navigator.getGamepads()`. `runtime.step()` never
polls, so headless runs stay deterministic.

### Virtual axes (analog)

Named analog axes raise the ceiling from digital platformers to
twin-stick/analog games:

- Schema: `inputMappings.axes` — `record(axisName, { gamepadAxis?: number,
  negativeCodes?: string[], positiveCodes?: string[], deadzone?: number })`.
  Keyboard fallback: negative codes drive −1, positive +1, both 0.
- Script API: `ctx.input.axis(name): number` returning −1..1 (0 when
  unbound). Gamepad value wins over keyboard when both active and the pad
  is outside the deadzone.
- Playtest: new `setAxis` step `{ type: 'setAxis', axis, value, frames? }`
  so analog behavior is headlessly assertable.

### Schema (`packages/core/src/schema/project.ts`)

`InputMappingsSchema` extends to:

```ts
{
  actions: record(action, string[]),          // unchanged: KeyboardEvent.code
  gamepadButtons: record(action, string[]),   // named buttons: 'a','b','x','y',
                                              // 'lb','rb','lt','rt','back','start',
                                              // 'ls','rs','dpad-up/down/left/right'
  gamepadAxes: record(action, { axis: number, direction: 1 | -1, threshold?: number }),
  axes: record(axisName, { gamepadAxis?: number, negativeCodes?: string[],
                           positiveCodes?: string[], deadzone?: number }),
  deadzone: number (default 0.15),
}
```

Named buttons map to standard-mapping indices in one shared table in core.
All fields default empty, so every existing project parses unchanged.

### Surfaces

- **Commands:** `updateSettings` params extend to cover the full
  `inputMappings` shape (agents configure bindings programmatically).
  `inspectProject` output includes the mappings (it already returns project
  settings).
- **Editor:** a typed Input section in project settings: per-action rows
  with key-capture ("press a key") and a named-button dropdown for gamepad;
  axis rows with typed fields. No raw JSON editing.
- **Docs:** `docs/input.md` (new) — actions, bindings, gamepad, virtual
  axes, playtest input; linked from the docs table.

### Testing

- InputState unit tests: deadzone, threshold edges, both-sources-held
  release, axis fallback precedence, `pollGamepads` with fake pad objects.
- Playtest `setAxis` step end-to-end in an example playtest.

---

## 3. Camera effects (§12 tier 1) — deterministic game feel

### Architecture

A new runtime module `packages/runtime/src/cameraEffects.ts` mirroring the
scheduler/tween shape (`stdlib.ts`): a `CameraEffectsState` holding active
effects `{ kind, elapsed, duration, params }`, stepped at fixed dt in
`runtime.step()` adjacent to camera-follow, self-removing on completion.
Output is a resolved view modifier read by the renderer:

```ts
{ offset: Vec2, zoomMul: number, overlay: { color: string, alpha: number } }
```

- **shake(intensity, seconds, opts?)** — per-frame offset from a
  **dedicated seeded RNG stream** (same pattern as particle emitters:
  `createRng(seed)`, seed from opts or derived from the session seed), decaying
  linearly over the duration. Deterministic: identical seeds reproduce
  identical offset sequences headlessly.
- **flash(color, seconds)** — transient overlay pulse (alpha 1 → 0).
- **fade(alpha, seconds, opts?)** — tweens the persistent overlay level to
  the target and **holds it** (fade-to-black stays black until faded back);
  optional color, optional `onComplete`.
- **zoomPunch(scale, seconds)** — multiplicative zoom spike decaying to 1.

Effects live on the scene runtime and are cleared on scene switch, except
the persistent fade level, which carries across switches so
fade-out → switch → fade-in works.

### Renderer

`syncCamera()` in the pixi host applies `offset` and `zoomMul` on top of the
camera transform. Flash/fade render as one full-screen Graphics overlay
above the `ui` container (fades cover HUD).

### ctx surface (both languages)

Added to the `ctx.camera` object literal in `makeContext` (Lua gets it via
the shared wasmoon proxy — no second binding):

```ts
camera: {
  // existing: getPosition/setPosition/getZoom/setZoom/follow
  shake(intensity: number, seconds: number, opts?: { seed?: number }): void;
  flash(color: string, seconds: number): void;
  fade(alpha: number, seconds: number, opts?: { color?: string; onComplete?: () => void }): void;
  zoomPunch(scale: number, seconds: number): void;
}
```

Kept hand-synced in the three mirror sites: `scripts.ts` interface,
`ctxApi.ts` docs, regenerated example `AGENTS.md` files.

### Assertability

Mirror the audio-event path: the runtime records each effect activation
`{ effect, frame, params }` through a session hook; `GameSession`
accumulates them; playtest results gain `cameraEffects`; the step union
gains `assertCameraEffect` `{ effect: 'shake'|'flash'|'fade'|'zoomPunch',
equals?/min?/max? }`. Live overlay alpha is additionally queryable for
fade-state assertions via `assertProperty`-style access on a well-known
path exposed by the playtest collector (`cameraOverlayAlpha` in results).

### Testing

- Deterministic shake: two headless runs with the same seed produce
  identical camera offsets frame-by-frame.
- Fade persistence across scene switch; flash self-completion;
  `assertCameraEffect` counting in an example playtest.

---

## 4. UI widgets v2 (§7) — components, layout, focus

### Principles

No parallel widget tree. Widgets are ordinary schema-registered components
on entities carrying `UIElement`; visuals keep composing with
`Text`/`SpriteRenderer`. Layout and hit-testing stay in the shared
`packages/runtime/src/ui.ts` so headless playtests and the browser agree.

### New components (`COMPONENT_SCHEMAS` + `COMPONENT_DOCS`)

**`UILayout`** — turns the entity into a container that positions its
*child entities* (entity parenting already exists; UI currently ignores it):

```ts
{ direction: 'vertical' | 'horizontal', gap: number (default 8),
  padding: number (default 0),
  align: 'start' | 'center' | 'end' (cross-axis, default 'start') }
```

Layout resolves each frame in `ui.ts`: the container's own anchor+offset
positions the group; children are stacked in child-order using their
measured rects (`uiElementRect`); a child's own `UIElement.offset` becomes a
relative nudge. Nested layouts resolve parent-first. Hit testing uses the
resolved positions.

**`UISlider`** — value widget with built-in rendering (track + fill +
handle drawn by the runtime, so it works with zero art):

```ts
{ min: 0, max: 1, value: 0.5, step: 0 (0 = continuous),
  width: 160, trackColor, fillColor, handleColor }
```

Pointer press/drag on the slider maps x-position → value (clamped,
stepped). Value changes fire `onUiEvent { type: 'change', value }` on the
entity's script. Scripts read/write `UISlider.value` via `getComponent` as
with any component.

**`UIToggle`** — boolean widget with built-in rendering (box + checkmark
fill):

```ts
{ value: false, size: 20, color, checkColor, label: '' (optional Text
  composes instead when richer labels are needed) }
```

Click flips `value` and fires `onUiEvent { type: 'change', value }`.

Widget rendering gets its own build/update branches in the pixi host (like
Line/Tilemap) and rect contributions in `uiElementRect` for hit testing.

### Pointer drag

`sendPointer` currently dispatches enter/exit/press/release/click. It
extends with drag dispatch: while an interactive element is pressed,
`move` events route to it as `{ type: 'drag', x, y }` (this is what sliders
consume; scripts can use it too). Playtests gain a `drag` step
`{ type: 'drag', from: Vec2, to: Vec2, frames? }` that synthesizes
down → interpolated moves → up.

### Focus + keyboard navigation

Runtime-level focus, script-driven policy:

- `UIElement` gains `focusable: boolean (default false)`.
- Runtime tracks `uiFocusId`. New ctx namespace:

```ts
ctx.ui = {
  focus(idOrName: string | null): void;
  getFocused(): string | null;              // entity id
  moveFocus(direction: 'up' | 'down' | 'left' | 'right'): void;  // spatial nearest-neighbor, deterministic tie-break by entity order
  activate(): void;                          // click the focused element
  adjust(delta: number): void;               // slider step/nudge on the focused element
}
```

- Focus changes fire `onUiEvent { type: 'focus' } / { type: 'blur' }` so
  scripts drive focus visuals. Games wire navigation by binding actions
  (e.g. `ui-up`) and calling `ctx.ui.moveFocus('up')` in `onUpdate` — no
  hidden built-in bindings, everything visible in project config and
  scripts.
- Playtest: `assertFocus` step `{ type: 'assertFocus', entity }` (entity
  name or id; null asserts nothing focused). Focused id is included in
  playtest results.

### Editor

- New components appear automatically in the Inspector's Add menu (registry
  driven). Numeric/bool fields render with existing typed controls.
- **Generic enum dropdown:** core exports enum options metadata per
  component field (derived from the zod schemas at registry build time);
  the Inspector renders a dropdown for any enum field. This replaces
  today's raw-text fallback for existing enums (`SpriteRenderer.shape`,
  `Text.align`, playtest-adjacent fields) — a targeted fix that the
  UI-uniformity rule requires anyway.

### Testing

- `ui.ts` layout unit tests: stacking, gap/padding/align, nesting, offsets.
- Runtime tests: slider drag math, toggle click, focus spatial navigation
  and tie-breaks, drag dispatch.
- Playtest end-to-end: drive a settings menu headlessly (drag the slider,
  assert value; toggle; move focus; assert focus).

---

## 5. Example, docs, release

- **New generated example** (via `packages/examples/generate.mjs`, never
  hand-edit output): a small arcade game — working title **Drift Cellar** —
  demonstrating the whole wave: gamepad + keyboard play (virtual axis
  movement), a pause/settings menu built from `UILayout` + `UISlider`
  (music volume, wired to `ctx.audio.setMusicVolume`) + `UIToggle`
  (screen-shake on/off), focus navigation with visible focus styling,
  `shake`/`flash` on collisions, `fade` scene transitions. Ships with
  playtests covering the menu (drag/toggle/focus), an `assertCameraEffect`,
  and a `setAxis` movement test; runs in CI like the other seven.
- **Docs:** new `docs/input.md` and `docs/ui.md`; `docs/scripting.md` gains
  `ctx.camera` effects and `ctx.ui`; `docs/cli.md` + `docs/mcp.md` gain
  undo/redo/history; `docs/components.md` gains the three widgets (count
  14 → 17); `docs/roadmap.md` updated. README component/tool counts
  refreshed. Website docs re-sync via the existing generator on the next
  website refresh (never hand-edit `src/content/docs/`).
- **Release:** version bump to **0.7.0** across packages; changelog entry;
  `npm run typecheck` + full vitest suite green as the gate (standing
  rule).

## Execution constraints (standing)

- Agent-native first: CLI/MCP + headless asserts land with each feature.
- Free OSS core: nothing in this wave is gated.
- No engine chrome in exported games (overlay effects are game content,
  not branding).
- Editor UI: typed controls only, no raw JSON fields.
- No AI attribution in commits; plain human-voice messages.

## File-overlap sequencing note (for the plan)

`packages/core/src/schema/project.ts` is touched by gamepad (input
mappings), camera effects (playtest step), and widgets (playtest steps) —
sequence those tasks. `packages/runtime/src/runtime.ts` and
`pixi/index.ts` are touched by both camera effects and widgets — sequence
those too. Undo (core/session/CLI/MCP/editor-keys) is independent and can
lead.
