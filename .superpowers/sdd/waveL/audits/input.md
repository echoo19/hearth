# Audit: input  (example: drift-cellar, port 5222)

## Findings

### INPUT-1 · defect · high
- Element: Virtual axis name field (`TextField` in `AxisRow`, `apps/editor/src/components/InputSettings.tsx`)
- Observed: With two axes present (e.g. `moveX`, `moveY`), click into `moveX`'s name field, clear it, type an already-used name (`moveY`), then blur. The rename is correctly rejected internally (`renameAxis` guards on `has(cur.axes, newName)`), but the text field keeps showing the rejected text — the row now visibly reads "moveY" while its actual data key, bindings, and sort position are still `moveX`'s. The list now appears to show two rows both named "moveY" (one with `moveX`'s real bindings, one with the genuine `moveY`'s), and the mismatch is durable — it survives further interaction and is only fixed by a rename that actually succeeds (which forces the field to remount via its `key={`axis-name-${name}`}` prop) or by reopening the project. Confirmed via the project's `hearth.json`: the underlying key never changed, only the label. Root cause: `TextField` (`apps/editor/src/components/ui.tsx`) only resyncs its local `draft` state from the `value` prop (`useEffect(() => setDraft(value), [value])`); a rejected rename never changes `value`, so `draft` — already mutated by the user's keystrokes — is never reverted. The same code path also triggers by clearing the field to empty and blurring (rename guarded on falsy name), leaving the field visibly blank while the real name is untouched.
- Expected: A rejected/no-op rename should visually revert the field to the axis's real current name, the same way an out-of-range number field snaps back after a rejected `updateSettings` call (verified working elsewhere in this same panel). Right now the axis name field is the one control in the whole panel that doesn't roll back its displayed value on rejection, and it's also the one most likely to produce a name collision by ordinary typing.

### INPUT-2 · friction · med
- Element: "New action name…" input + "Add action" button
- Observed: Typing an action name that already exists (either a real action or another in-progress draft) and clicking "Add action" is a silent no-op: the input keeps the typed text, the button stays enabled, and nothing on screen indicates the name is taken. This was true both for a name that already has bindings ("dash") and for a freshly-typed draft name added moments earlier ("jump" while its own draft was still empty).
- Expected: Some inline signal that the name is unavailable — an error line under the field, a shake, or a temporarily-disabled/red-bordered input — so the user doesn't wonder why "Add action" appears to do nothing.

### INPUT-3 · friction · med
- Element: Virtual axis rename (see also INPUT-1)
- Observed: Renaming an axis to a name that's already taken is silently rejected with zero feedback, same as INPUT-2's action case. Combined with INPUT-1, this is worse for axes than for actions: instead of "nothing visibly happens," the field can end up showing the very name you were told (by absence of any error) had failed to apply.
- Expected: Same as INPUT-2 — surface the collision instead of failing silently.

### INPUT-4 · friction · low
- Element: Key-capture flow (`CaptureButton` / `recordCapturedCode`) across actions and virtual axes
- Observed: Arming capture and pressing a key that's already bound to that same action/axis field (e.g. pressing `KeyJ` again on an action that already has `KeyJ`) silently disarms with no key added and no message — indistinguishable, from the user's point of view, from the capture simply not registering the keypress.
- Expected: Not necessarily an error, but even a one-frame "already bound" hint (similar in spirit to the existing "Esc cancels — Escape itself can't be bound here" hint) would remove the ambiguity. This is the third instance of the same "reject silently" pattern (duplicate action name, duplicate axis name, duplicate key), suggesting a systemic gap rather than three separate oversights.

### INPUT-5 · polish · low
- Element: `.inspector-row` grid shared between `Inspector.tsx` and `InputSettings.tsx` (`apps/editor/src/styles/panels/inspector.css:50-56`, reused per `apps/editor/src/styles/panels/input.css:1-8`)
- Observed: `.inspector-row` is `align-items: center`, which reads correctly in the Inspector where every row's value is a single-line control. In `InputSettings`, the "Keys"/"Gamepad"/"Negative key"/"Positive key" rows stack a chip list *and* a capture button vertically inside that same value cell, so the label ends up vertically centered against the whole two-line stack rather than aligned with its first line — it visually floats between the chip row and the button row instead of sitting level with either.
- Expected: Either `align-items: start` for rows whose value wraps to multiple lines, or a small top-margin on the label to match the chip row's baseline. Worth flagging since the panel explicitly reuses Inspector's row grid for visual consistency (per the comment in `input.css`) but the shared grid wasn't built for multi-line values.

### INPUT-6 · friction · med
- Element: Whole panel, interplay with a running game
- Observed (via code, not live gameplay — see "Not covered"): editing any input mapping while the in-editor game preview is in Play mode does not affect the running instance. `SceneRuntime` constructs its `InputState` once from a snapshot (`packages/runtime/src/runtime.ts:372`), `GamePreview`'s mount effect only depends on `[projectPath, sceneId, runNonce]` (bumped solely by pressing Play), and the running preview reads its own freshly-fetched `ProjectStore` (`apps/editor/src/runtimeBridge.ts:205-206`) rather than the `useEditor` store `InputSettings.tsx` writes through. So a binding edit only takes effect on the *next* Play run.
- Expected: This is a reasonable technical limitation (consistent with how scripts/components hot-reload but scene structure doesn't), but the panel gives no hint that a change made mid-playtest needs a Play restart to be felt — worth at least a note in the panel or in Play's UI when settings changed since the run started.

### INPUT-7 · polish · low
- Element: Error banner text after a rejected numeric edit (deadzone/threshold out of `[0,1]`)
- Observed: The banner surfaces the raw Zod validation string verbatim, e.g. "That change didn't save: Invalid parameters for updateSettings: inputMappings.gamepadAxes.jump.threshold: Number must be less than or equal to 1."
- Expected: Functionally this is great (see "Verified working" — rollback + explanation both work), but the message reads as an internal/leaky error rather than user-facing copy. A friendlier framing ("Threshold must be between 0 and 1") would fit the rest of the panel's copy quality (e.g. the capture hint, the empty states).

### INPUT-8 · friction · low
- Element: Gamepad button section (`GamepadButtonAdd`)
- Observed: The only way to bind a gamepad button is a static dropdown of standard button names (`a`, `b`, `x`, `y`, `lb`, `rb`, …, from `GAMEPAD_BUTTONS` in `packages/core/src/input/gamepad.ts`) — there is no "press a button on your controller" capture flow analogous to the keyboard one, and nothing in the UI explains why (e.g. that it's a deliberate named-mapping design, not missing hardware support).
- Expected: Likely intentional (gamepad detection needs a live device, and this is an edit-time config surface), so this is low severity, but a first-time user who just used "Press a key…" may reasonably expect a "Press a gamepad button…" counterpart and wonder if it's missing.

## Verified working
- Add action with a valid, non-conflicting name; new action appears as a "draft" row with no bindings, and disappears from the draft list once it gets a real key or gamepad-button binding (jump went from draft → real row on first `KeyJ` capture).
- Key capture: arming via "Press a key…" turns it into an orange "Press any key…" state with the hint "Esc cancels — Escape itself can't be bound here."; the next keydown is captured and shown as a chip.
- Escape while armed cancels cleanly with no key recorded.
- Modifier-only keys (e.g. `ShiftLeft`) can be captured and bound like any other key.
- The same physical key can be bound across two different actions (`Space` bound to both `dash` and `jump`) without conflict — correct, expected behavior for a game input system.
- Removing an individual key or gamepad-button chip via its × button works and updates the row immediately.
- Gamepad-button add dropdown excludes buttons already bound to that action and shows "All buttons bound" once exhausted (verified by reading `GamepadButtonAdd`; the live list correctly shrank after adding "b" to an action).
- "Add gamepad axis binding" creates the documented default (`axis: 0, direction: +1, threshold: 0.5`); axis/direction/threshold are independently editable; "Remove gamepad axis binding" removes it.
- Server-side validation + rollback: setting threshold or deadzone outside `[0, 1]` is rejected by the `updateSettings` Zod schema, the field visibly snaps back to the last valid value, and a red banner explains why with the specific field path.
- Adding a virtual axis with a valid name creates it with empty negative/positive key arrays and shows "No keys bound" placeholders for both.
- Toggling an axis's gamepad-axis "Bound" checkbox on/off adds/removes the numeric axis-index field, defaulting to 0 when first enabled.
- Toggling an axis's deadzone "Override" checkbox on/off adds/removes the per-axis deadzone field, defaulting to the current global deadzone value when first enabled, and correctly labeled "Override (global: 0.15)".
- Delete confirmation: deleting an action or an axis opens a shared `ConfirmDialog` with correctly-filled-in copy (`Delete "jump"?` / `Delete "aim"?`, body text naming what's removed and mentioning Ctrl/Cmd+Z); Cancel truly cancels with no state change; the destructive button is styled danger/red.
- Undo/redo: deleting an action, then Cmd+Z, fully restores it with every key/gamepad binding intact; Cmd+Shift+Z redoes the deletion. Full round trip confirmed.
- Persistence: every edit exercised (key/gamepad-button add+remove, axis add/rename/delete, gamepad-axis binding fields, deadzone fields, global deadzone) is correctly written to the project's `hearth.json` on disk, matching "Every change saves automatically" in the toolbar.
- Empty state: a project with zero actions and zero virtual axes shows distinct, well-worded empty-state copy for each section independently ("No actions yet — add one below and bind a key or gamepad button to it." / "No virtual axes yet — add one below for analog movement, like a joystick or WASD pair.") rather than a single generic blank message.
- Row-grid consistency: `InputSettings.tsx` deliberately reuses Inspector's `.inspector-row` / `.component-card` / `.component-header` / `.component-body` classes (confirmed by the comment header in `apps/editor/src/styles/panels/input.css`) rather than inventing its own — the panel reads as the same visual language as the Inspector, modulo the multi-line-value centering issue noted in INPUT-5.
- Global deadzone field lives in its own "Global" section, separate from per-axis overrides, and correctly shows the current value (0.15 default).

## Not covered
- Real gamepad hardware: this headless environment has no physical controller attached, so only the named-button/axis-index *mapping* UI was exercised, not actual live button-press/axis-motion capture at runtime.
- Whether a mid-Play input-mapping edit truly has no live effect was established by reading `packages/runtime/src/runtime.ts`, `apps/editor/src/components/GamePreview.tsx`, and `apps/editor/src/runtimeBridge.ts` (see INPUT-6) rather than by pressing Play, editing a binding, and directly observing sprite behavior in the live canvas — driving and visually verifying gameplay reaction in headless Playwright was out of scope for the time available, though the code evidence is unambiguous.
- Non-US keyboard layouts, dead keys, and IME composition during key capture — capture reads `e.code` (physical key position, layout-independent), which sidesteps most of this concern by design, but wasn't separately tested.
- Screen-reader / assistive-technology pass. Chip-remove buttons carry `aria-label`s in source; this wasn't verified with an actual AT.
- Keyboard-only navigation of the whole panel (tab order through cards, capture buttons, and the confirm dialog) — interactions were driven via direct locator clicks rather than pure keyboard traversal.
