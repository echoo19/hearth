# Wave D Implementation Plan — Game feel, input, UI widgets, editor undo (v0.7.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship editor undo/redo (registry-level, CLI/MCP included), gamepad + virtual-axis input, deterministic camera effects (shake/flash/fade/zoomPunch), and UI widgets v2 (layout/slider/toggle/focus), proven by a new generated example and released as v0.7.0.

**Architecture:** Undo is a disk-backed history of before-snapshots captured in `HearthSession.execute` (the single choke point all surfaces share). Gamepad feeds synthetic codes into the existing action layer; polling stays browser-side so headless runs stay deterministic. Camera effects are a scheduler-shaped runtime module with a seeded RNG stream, applied in `syncCamera` and recorded like audio events for playtest assertions. Widgets are new schema-registered components composing with `UIElement`; layout/hit-testing stay in shared `ui.ts`.

**Tech Stack:** TypeScript monorepo (`packages/{core,runtime,playtest,cli,mcp-server}`, `apps/editor`), zod schemas, PixiJS renderer, wasmoon Lua (shared ctx proxy — JS ctx additions reach Lua automatically), vitest, commander CLI, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-07-05-waveD-game-feel-input-undo-design.md` — read it before your task.

## Global Constraints

- `npm run typecheck` AND the relevant vitest suites must pass before every commit; the full suite (`npm test`) gates the release task.
- Commit messages: plain human voice, short imperative subject. **Never** add AI attribution (no Co-Authored-By, no "Generated with Claude Code").
- Example projects are GENERATED: edit `packages/examples/generate.mjs`, never hand-edit generated output. Regenerate + run example playtests after changes.
- Editor UI: typed controls only — no raw JSON text fields in the Inspector or settings.
- Agent-native parity: every new capability lands with CLI/MCP exposure and headless playtest assertability in the same wave.
- `ctx` surface changes must be mirrored in THREE places: `packages/runtime/src/scripts.ts` (interface), `packages/core/src/ctxApi.ts` (docs; header says "mirrors scripts.ts exactly"), and regenerated example `AGENTS.md` files (via `packages/examples/generate.mjs`, which renders from `CTX_API` through `packages/core/src/agentFiles.ts`).
- Playtest step schemas live in `packages/core/src/schema/project.ts` (`PlaytestStepUnionSchema` discriminated union + `superRefine` for count asserts); evaluator is the switch in `packages/playtest/src/index.ts`.
- Never poll gamepads inside `runtime.step()` — browser host only.
- Build order for packages: `npm run build:packages` (core → runtime → playtest → cli → mcp-server). Run it when a downstream package's tests need upstream changes.
- History/trash live under `.hearth/` (already untracked). History bound: 25 entries.
- New-command surfacing is manual on each surface: registry (`packages/core/src/commands/registry.ts` `ALL_DEFINITIONS`), CLI (`packages/cli/src/program.ts` commander subcommand), MCP (`packages/mcp-server/src/tools.ts` `TOOL_SPECS`).

---

### Task 1: History store + undo/redo/listHistory commands (core)

**Files:**
- Create: `packages/core/src/project/history.ts`
- Create: `packages/core/src/project/restore.ts` (factored from `revertProject`)
- Create: `packages/core/src/commands/historyCommands.ts`
- Modify: `packages/core/src/session.ts` (capture hook in `execute`, ~lines 78–121)
- Modify: `packages/core/src/commands/diffCommands.ts` (`revertProject` uses `applySnapshot`)
- Modify: `packages/core/src/commands/registry.ts` (register 3 commands)
- Modify: `packages/core/src/schema/project.ts` (add `HISTORY_DIR` constant next to `BASELINE_FILE`)
- Test: `packages/core/test/history.test.ts`

**Interfaces:**
- Consumes: `ProjectStore.toSnapshot(): ProjectSnapshot` (`packages/core/src/project/store.ts:190-202`), `HearthSession.execute` pipeline (`session.ts:78-121`), `revertProject` restore logic (`diffCommands.ts:58-96`).
- Produces (later tasks rely on these exact names):
  - `HistoryStore` class (`project/history.ts`):
    ```ts
    export interface HistoryEntryMeta { seq: number; command: string; summary: string; timestamp: string }
    export interface HistoryIndex { nextSeq: number; cursor: number; entries: HistoryEntryMeta[] }
    export class HistoryStore {
      constructor(fs: FsLike, root: string, limit = 25);
      async record(command: string, summary: string, before: ProjectSnapshot): Promise<void>;
      async undo(current: ProjectSnapshot): Promise<{ entry: HistoryEntryMeta; snapshot: ProjectSnapshot }>;
      async redo(): Promise<{ entry: HistoryEntryMeta; snapshot: ProjectSnapshot }>;
      async list(): Promise<{ entries: (HistoryEntryMeta & { undone: boolean })[]; cursor: number }>;
    }
    ```
  - `applySnapshot(ctx: { store: ProjectStore; fs: FsLike; root: string; changed: (ref: ChangedRef) => void }, snapshot: ProjectSnapshot): Promise<void>` (`project/restore.ts`) — restores model + script files exactly as `revertProject` does today (including deleting scripts not in the snapshot).
  - Registry commands: `undo` (write, mutates), `redo` (write, mutates), `listHistory` (read).
  - `HISTORY_EXEMPT: Set<string>` = `{'undo','redo','revertProject','snapshotProject'}` exported from `historyCommands.ts`.

**History mechanics (implement exactly):**
- Layout: `.hearth/history/index.json` (a `HistoryIndex`), `.hearth/history/state-<seq>.json` (the before-snapshot for entry `<seq>`), `.hearth/history/redo-<seq>.json` (written on undo; the state to restore on redo).
- `record`: truncate entries at `cursor` (delete `state-`/`redo-` files of dropped entries), append `{seq: nextSeq++, command, summary, timestamp: new Date().toISOString()}`, write `state-<seq>.json`, set `cursor = entries.length`, prune oldest beyond `limit` (delete files), write `index.json`.
- `undo`: if `cursor === 0` throw a plain `Error('Nothing to undo')` (the command catches and returns a friendly error). Entry `E = entries[cursor-1]`; write `redo-<E.seq>.json` = `current`; return `state-<E.seq>.json` contents; `cursor--`; save index.
- `redo`: if `cursor === entries.length` throw `Error('Nothing to redo')`. Entry `E = entries[cursor]`; return `redo-<E.seq>.json`; `cursor++`; save index.
- `list`: entries with `undone: index >= cursor`.
- Session hook (in `execute`, after `paramsSchema.parse`, before `def.run`): if `def.mutates && !HISTORY_EXEMPT.has(name)`, capture `const before = this.store.toSnapshot()`. After a **successful** `run`, `await history.record(name, summarize(name, params2), before)` where `summarize` returns `name` plus the most identifying string param if present (`params.name ?? params.id ?? params.scene ?? ''`, trimmed). On failure, record nothing.
- `undo`/`redo` command bodies: build the current snapshot, call the store, `applySnapshot`, return `{ undone|redone: entry.command, seq: entry.seq }` in `data`; `mutates: true` so `store.save()` persists.

**Steps:**

- [ ] **Step 1:** Read `session.ts`, `diffCommands.ts:17-96`, `store.ts:110-205`, and an existing core test file to match test conventions (find one with `ls packages/core/test/`).
- [ ] **Step 2:** Write failing tests in `packages/core/test/history.test.ts` using the in-memory/session harness the existing core tests use. Cover, at minimum:
  - `undo reverts createEntity` — create entity via session, `undo`, entity gone from store and from the scene file on disk.
  - `redo re-applies it` — after undo, `redo`, entity back.
  - `new mutation truncates redo tail` — mutate, undo, mutate differently, `redo` returns error result.
  - `script files restored` — `attachScript`/script-writing command, undo removes the created script file; redo restores its content.
  - `history bounded at 25` — 27 mutations, `listHistory` shows 25, oldest state files removed.
  - `exempt commands not recorded` — `snapshotProject` and `undo` itself don't add entries.
  - `listHistory marks undone entries` — after one undo, last entry has `undone: true`.
  - `undo with empty history returns friendly error` (a failed `CommandResult`, not a throw).
- [ ] **Step 3:** Run them; expect failures ("unknown command undo" etc.).
- [ ] **Step 4:** Implement `restore.ts` (move the restore block out of `revertProject`; `revertProject` now calls `applySnapshot`), `history.ts`, `historyCommands.ts`, session hook, registry entries, `HISTORY_DIR`.
- [ ] **Step 5:** Run `packages/core` tests + `npm run typecheck` → green (including all pre-existing core tests: revert behavior must be unchanged).
- [ ] **Step 6:** Commit: `feat: registry-level undo/redo with disk-backed history`

---

### Task 2: Binary asset trash (undoable asset delete/import)

**Files:**
- Modify: `packages/core/src/commands/assetCommands.ts` (deleteAsset → trash)
- Modify: `packages/core/src/project/restore.ts` (asset-file reconciliation)
- Modify: `packages/core/src/schema/project.ts` (add `TRASH_DIR` constant)
- Test: `packages/core/test/history-assets.test.ts`

**Interfaces:**
- Consumes: Task 1's `applySnapshot`; the existing asset index shape on `store.assets` and `deleteAsset`/import command implementations (read `assetCommands.ts` first — file layout of imported assets under the project).
- Produces: `applySnapshot` gains a final reconciliation pass: diff the asset index before vs. after restore; for each asset **reappearing** in the restored index whose file is missing on disk, move it back from `.hearth/trash/<assetId>/<basename>`; for each asset **disappearing**, move its file(s) into `.hearth/trash/<assetId>/` (so redo can bring them back). Record `ctx.changed({kind:'asset', ...})` for each move. If a needed trash file is missing, emit `ctx.warn(...)` and continue (model restores; file is gone).

**Steps:**

- [ ] **Step 1:** Read `assetCommands.ts` fully; identify where `deleteAsset` unlinks files and what paths imported assets use.
- [ ] **Step 2:** Failing tests in `history-assets.test.ts`:
  - `deleteAsset moves file to trash` — import (or fixture-copy) a small file as an asset, delete it, file exists under `.hearth/trash/<id>/`, not at original path.
  - `undo of deleteAsset restores the binary` — file back at original path, asset in index.
  - `redo of deleteAsset trashes it again`.
  - `undo of an import removes the file but stashes it; redo restores it`.
  - `trash pruned with history` — when the history entry that references an asset falls off the 25-entry bound, its orphaned trash dir is removed (prune trash dirs whose assetId is in no live index/snapshot — implement as: on `HistoryStore` prune, delete `.hearth/trash/<id>` for ids not present in any retained `state-`/`redo-` snapshot's asset index nor the current store).
- [ ] **Step 3:** Run → fail.
- [ ] **Step 4:** Implement: `deleteAsset` moves to trash (never unlink); reconciliation in `applySnapshot`; prune hook.
- [ ] **Step 5:** Core tests + typecheck green (existing asset tests must still pass — deleting still removes from the project's asset dirs).
- [ ] **Step 6:** Commit: `feat: trash-backed asset files so undo covers imports and deletes`

---

### Task 3: Undo surfaces — CLI, MCP, editor keys + History panel

**Files:**
- Modify: `packages/cli/src/program.ts` (three subcommands)
- Modify: `packages/mcp-server/src/tools.ts` (three ToolSpecs)
- Modify: `apps/editor/src/components/DiffPanel.tsx` (History section + revised revert copy)
- Modify: the editor root component that owns global listeners (`apps/editor/src/App.tsx` or `Workspace.tsx` — find where top-level effects live) for Cmd+Z / Shift+Cmd+Z
- Test: `packages/cli/test/` + `packages/mcp-server/test/` following each package's existing command-coverage test pattern (read one first)

**Interfaces:**
- Consumes: Task 1 commands (`undo`, `redo`, `listHistory`), editor `exec(name, params)` from the zustand store (`apps/editor/src/store.ts`), `apiCommand` pipeline.
- Produces: CLI verbs `hearth undo`, `hearth redo`, `hearth history [--json]`; MCP tools `undo`, `redo`, `list_history` (empty input shapes for undo/redo; none needed for list). Editor: Cmd+Z→`exec('undo')`, Shift+Cmd+Z / Cmd+Y→`exec('redo')`, **skipped when `event.target` is an input/textarea/contenteditable**; DiffPanel shows the history list (command + summary + undone dimming) with Undo/Redo buttons whose labels name the target ("Undo createEntity"); the existing "This cannot be undone" revert copy updated to mention `undo`.
- CLI `history` human output: one line per entry `  [3] createEntity Gem` with undone entries prefixed `~`; `--json` emits the command envelope like every other verb (`runAndEmit`).

**Steps:**

- [ ] **Step 1:** Read `program.ts` (pattern: `runAndEmit`), `tools.ts` (ToolSpec shape), `DiffPanel.tsx`, and locate the top-level editor component for global key handling.
- [ ] **Step 2:** Failing tests: CLI test invoking `undo` with nothing to undo returns the friendly error envelope; `history --json` lists a recorded mutation. MCP test asserting the three tools exist in `TOOL_SPECS` and dispatch to the right command names.
- [ ] **Step 3:** Run → fail.
- [ ] **Step 4:** Implement all three surfaces. Editor listener: `useEffect` keydown on `window`; guard `if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;` and `metaKey||ctrlKey`.
- [ ] **Step 5:** `npm run build:packages`; cli+mcp tests + typecheck green. Manually smoke the editor build compiles (`npm run typecheck` covers it).
- [ ] **Step 6:** Commit: `feat: undo across CLI, MCP, and editor with history panel`

---

### Task 4: Input schema — gamepad bindings + virtual axes + settings command

**Files:**
- Modify: `packages/core/src/schema/project.ts:17-21` (`InputMappingsSchema`)
- Create: `packages/core/src/input/gamepad.ts` (named-button table)
- Modify: `packages/core/src/commands/settingsCommands.ts:50-56` (accept full inputMappings)
- Test: `packages/core/test/input-schema.test.ts`

**Interfaces:**
- Produces (verbatim — Tasks 5/6/13 depend on these names):
  ```ts
  export const GamepadAxisBindingSchema = z.object({
    axis: z.number().int().min(0),
    direction: z.union([z.literal(1), z.literal(-1)]),
    threshold: z.number().min(0).max(1).default(0.5),
  });
  export const VirtualAxisSchema = z.object({
    gamepadAxis: z.number().int().min(0).optional(),
    negativeCodes: z.array(z.string()).default([]),
    positiveCodes: z.array(z.string()).default([]),
    deadzone: z.number().min(0).max(1).optional(),
  });
  export const InputMappingsSchema = z.object({
    actions: z.record(z.string(), z.array(z.string())).default({}),
    gamepadButtons: z.record(z.string(), z.array(z.string())).default({}),
    gamepadAxes: z.record(z.string(), GamepadAxisBindingSchema).default({}),
    axes: z.record(z.string(), VirtualAxisSchema).default({}),
    deadzone: z.number().min(0).max(1).default(0.15),
  });
  ```
  ```ts
  // packages/core/src/input/gamepad.ts
  export const GAMEPAD_BUTTONS: Record<string, number> = {
    a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7,
    back: 8, start: 9, ls: 10, rs: 11,
    'dpad-up': 12, 'dpad-down': 13, 'dpad-left': 14, 'dpad-right': 15,
  };
  export const GAMEPAD_BUTTON_NAMES = Object.keys(GAMEPAD_BUTTONS);
  ```
  `updateSettings` accepts an optional `inputMappings` param validated by `InputMappingsSchema` (deep-merge onto the project's existing mappings; replacing per top-level key is fine and simpler — replace any provided key wholesale).

**Steps:**

- [ ] **Step 1:** Failing tests: old-shape `hearth.json` (`actions` only) parses with defaults for new fields; `gamepadButtons` rejects non-array values; `updateSettings` writes a `gamepadButtons` binding and `inspectProject` (or reading `store.project`) reflects it; unknown button names are ALLOWED by schema (validated at runtime with a warning, keeps schema permissive) — assert schema accepts `['zz']`.
- [ ] **Step 2:** Run → fail. Implement. Core tests + typecheck green.
- [ ] **Step 3:** Commit: `feat: gamepad and virtual-axis input schema`

---

### Task 5: Runtime gamepad + virtual axes + playtest setAxis

**Files:**
- Modify: `packages/runtime/src/input.ts` (whole class)
- Modify: `packages/runtime/src/runtime.ts:255` (pass full mappings), `:936-939` (ctx.input.axis)
- Modify: `packages/runtime/src/pixi/index.ts:441` (poll in onTick)
- Modify: `packages/runtime/src/scripts.ts:66-69` (interface + `axis`)
- Modify: `packages/core/src/ctxApi.ts:63-74` (doc entry for `ctx.input.axis`)
- Modify: `packages/core/src/schema/project.ts` (`setAxis` playtest step in the union)
- Modify: `packages/playtest/src/index.ts` (evaluator case)
- Test: `packages/runtime/test/input.test.ts` (extend/create), `packages/playtest` test for setAxis

**Interfaces:**
- Consumes: Task 4 schema + `GAMEPAD_BUTTONS`.
- Produces:
  - `InputState` constructor becomes `constructor(mappings: InputMappings | Record<string,string[]>)` (back-compat: a plain record is treated as `{actions: record}` — playtest/unit callers pass records today).
  - Synthetic codes: buttons → `gp:<name>` (e.g. `gp:a`); axis-to-action → `gp:axis<i>+` / `gp:axis<i>-`. These merge into the existing `codeToActions` index, so `handleKeyDown/Up`, held-state, and multi-binding are reused untouched.
  - `pollGamepads(pads: ReadonlyArray<GamepadLike | null>): void` where `GamepadLike = { buttons: ReadonlyArray<{ pressed: boolean; value: number }>, axes: ReadonlyArray<number> }`. Pure state-machine: compute the active synthetic-code set across all pads (button pressed; axis beyond threshold outside deadzone), diff vs. the previous poll's set, feed `handleKeyDown`/`handleKeyUp`. Store `lastAxes: number[]` (max over pads by |value|, respecting sign) for virtual axes.
  - `axisValue(name: string): number` — if a playtest override exists (`setAxis`), return it; else gamepad axis from `lastAxes` if |v| > deadzone (per-axis override or global default); else keyboard fallback: negativeCodes any-down → −1, positiveCodes → +1, both/none → 0. Clamp −1..1.
  - `setAxis(name: string, value: number): void` — sticky override used by playtests (also clears on `setAxis(name, 0)`? No: sticky at 0 too; `clearAxis(name)` removes the override).
  - ctx: `input.axis(name: string): number` added to `ScriptContext.input` and wired in `makeContext`.
  - Playtest step: `{ type: 'setAxis', axis: z.string(), value: z.number().min(-1).max(1), frames: z.number().int().min(0).optional() }` — evaluator calls `session.runtime.input.setAxis(...)` then runs `frames ?? 1` frames.
  - Pixi host: top of `onTick`, before the accumulator loop: `if (typeof navigator !== 'undefined' && navigator.getGamepads) this.runtime.input.pollGamepads(navigator.getGamepads());` (via the session's runtime reference used elsewhere in the file).

**Steps:**

- [ ] **Step 1:** Failing unit tests (fake `GamepadLike` objects, no browser):
  - button press → action down; release → up; `justPressed` one frame.
  - keyboard AND gamepad both holding one action: releasing one keeps it down.
  - axis 0.6 with threshold 0.5 → `gp:axis0+` fires; 0.4 → released; −0.6 → `gp:axis0-`.
  - deadzone: axis 0.1 with deadzone 0.15 → no code, `axisValue` 0.
  - `axisValue` precedence: setAxis override > gamepad > keyboard fallback; keyboard −1/+1/both→0.
  - unknown button name in bindings → ignored with no throw.
- [ ] **Step 2:** Run → fail. Implement `input.ts` + runtime/ctx wiring + pixi polling.
- [ ] **Step 3:** Playtest: failing test driving a script that moves an entity by `ctx.input.axis('moveX') * speed`, via a `setAxis` step; assert position moved. Implement schema + evaluator case.
- [ ] **Step 4:** `npm run build:packages`; runtime + playtest + core tests + typecheck green.
- [ ] **Step 5:** Update `ctxApi.ts` (input.axis entry) — AGENTS.md regen happens in Task 13 with the example.
- [ ] **Step 6:** Commit: `feat: gamepad input and virtual axes through the action layer`

---

### Task 6: Editor Input settings panel

**Files:**
- Create: `apps/editor/src/components/InputSettings.tsx`
- Modify: wherever project settings render today (find the existing settings surface — search `updateSettings` / `settings` in `apps/editor/src`; if none exists, add an "Input" panel to the workspace's panel registry the way Console/Diff panels register)
- Test: typecheck + any existing editor test conventions (editor has no unit-test suite; the gate is typecheck + the command round-trip already covered in core)

**Interfaces:**
- Consumes: Task 4's `updateSettings` inputMappings param and `GAMEPAD_BUTTON_NAMES` (exported from core; editor imports core types the way Inspector does).
- Produces: a typed panel listing actions (rows: action name, bound key codes as removable chips + "Press a key…" capture button that records the next `KeyboardEvent.code`, gamepad named-button dropdown multi-add from `GAMEPAD_BUTTON_NAMES`), axis rows (name, gamepad axis number field, negative/positive key capture, deadzone number field), global deadzone field, an "Add action" / "Add axis" affordance. Every edit calls `exec('updateSettings', { inputMappings })` with the full updated mappings (top-level-key replacement per Task 4). No JSON textareas.

**Steps:**

- [ ] **Step 1:** Explore the editor's panel/settings layout and existing typed-control components (NumberField etc. in Inspector) — reuse them.
- [ ] **Step 2:** Implement the panel; wire into the workspace.
- [ ] **Step 3:** `npm run typecheck` green; run the editor briefly if cheap (`npm run dev` not required for the gate).
- [ ] **Step 4:** Commit: `feat: input settings panel with key capture and gamepad bindings`

---

### Task 7: Camera effects runtime module + ctx + renderer

**Files:**
- Create: `packages/runtime/src/cameraEffects.ts`
- Modify: `packages/runtime/src/runtime.ts` (instantiate; step near camera-follow stage `:465-469`; ctx.camera additions `:1089-1122`)
- Modify: `packages/runtime/src/session.ts` (persist fade level across scene switches; accumulate effect records `~:88-94, 227-246`)
- Modify: `packages/runtime/src/pixi/index.ts` (`syncCamera` `:546-564` + full-screen overlay above `ui`)
- Modify: `packages/runtime/src/scripts.ts:166-173` (interface)
- Modify: `packages/core/src/ctxApi.ts:372-407` (docs)
- Test: `packages/runtime/test/cameraEffects.test.ts`

**Interfaces:**
- Consumes: `EASINGS`/`createRng` from `packages/runtime/src/stdlib.ts`, the fixed-step loop, session RNG plumbing (`session.ts:112`).
- Produces (verbatim):
  ```ts
  // cameraEffects.ts
  export type CameraEffectKind = 'shake' | 'flash' | 'fade' | 'zoomPunch';
  export interface CameraEffectRecord { effect: CameraEffectKind; frame: number; params: Record<string, number | string> }
  export class CameraEffectsState {
    constructor(opts: { seed: number; initialOverlay?: { color: string; alpha: number };
                        onRecord?: (rec: CameraEffectRecord) => void });
    shake(intensity: number, seconds: number, opts?: { seed?: number }): void;
    flash(color: string, seconds: number): void;
    fade(alpha: number, seconds: number, opts?: { color?: string; onComplete?: () => void }): void;
    zoomPunch(scale: number, seconds: number): void;
    step(dt: number, frame: number, onError: (err: unknown) => void): void;
    readonly offset: { x: number; y: number };   // shake result, world units
    readonly zoomMul: number;                    // zoomPunch result, 1 when idle
    readonly overlay: { color: string; alpha: number }; // flash pulse + persistent fade level (max of the two alphas; flash color wins while flashing)
    readonly activeCount: number;
  }
  ```
  - shake: each `step`, `offset = { x: (rng()*2-1) * intensity * decay, y: ... }` with `decay = 1 - t`; rng is `createRng(opts.seed ?? floor(sessionRng()*2**31))` per effect. Two runs with equal seeds are frame-identical.
  - flash: `alpha = 1 - t`, self-removes at t≥1.
  - fade: eases the persistent `fadeLevel` from current to target over the duration (easeInOut), then holds; `onComplete` fired once via `onError`-guarded call.
  - zoomPunch: `zoomMul = 1 + (scale - 1) * (1 - t)`, self-removes.
  - Runtime: `readonly cameraEffects: CameraEffectsState` on `SceneRuntime`; stepped right after `applyCameraFollow()`. ctx: `camera.shake/flash/fade/zoomPunch` delegating to it (Lua gets them free via the shared proxy).
  - Session: on scene switch, construct the new runtime's effects state with `initialOverlay` = old persistent fade level (transient flash/shake/zoomPunch do NOT carry). Session accumulates `cameraEffects: CameraEffectRecord[]` from `onRecord` exactly like `audioEvents`.
  - Pixi: `syncCamera` adds `fx.offset` to the world position math and multiplies zoom by `fx.zoomMul`; a `Graphics` rect (label `'fx-overlay'`) sized to the screen, added to the stage **above** `ui`, tinted `fx.overlay.color` with `alpha = fx.overlay.alpha`, redrawn on resize.

**Steps:**

- [ ] **Step 1:** Failing runtime tests: seeded shake determinism (two states, same seed, identical `offset` per frame across 30 steps); flash completes and `activeCount` drops; fade holds after completion (alpha stays at target for further steps) and fires `onComplete` exactly once; zoomPunch returns to exactly 1; records emitted with correct `frame`; fade level carries across a scene switch driven through `GameSession` while a mid-flight shake does not.
- [ ] **Step 2:** Run → fail. Implement module + runtime + session + pixi + interface/docs sync.
- [ ] **Step 3:** Runtime tests + typecheck green.
- [ ] **Step 4:** Commit: `feat: deterministic camera effects (shake, flash, fade, zoom punch)`

---

### Task 8: Camera effects assertability (playtest)

**Files:**
- Modify: `packages/core/src/schema/project.ts` (`assertCameraEffect` in the union + superRefine one-of equals/min/max, mirroring the count asserts at `:169-203`)
- Modify: `packages/playtest/src/index.ts` (evaluator case; `PlaytestResult` gains `cameraEffects: CameraEffectRecord[]` and `cameraOverlayAlpha: number`)
- Test: `packages/playtest/test/` following its existing test pattern

**Interfaces:**
- Consumes: Task 7 session accumulation + `runtime.cameraEffects.overlay.alpha`.
- Produces: step `{ type: 'assertCameraEffect', effect: z.enum(['shake','flash','fade','zoomPunch']), equals?: number, min?: number, max?: number }` counting accumulated records of that effect; results expose `cameraEffects` and final `cameraOverlayAlpha`.

**Steps:**

- [ ] **Step 1:** Failing test: a script calling `ctx.camera.shake(4, 0.2)` on a collision/timer; playtest asserts `assertCameraEffect {effect:'shake', min:1}` passes and `{equals:5}` fails with a clear message; a fade script leaves `cameraOverlayAlpha` = 1 in results.
- [ ] **Step 2:** Run → fail. Implement schema + evaluator + result fields.
- [ ] **Step 3:** `npm run build:packages`; playtest + core tests + typecheck green.
- [ ] **Step 4:** Commit: `feat: assert camera effects in headless playtests`

---

### Task 9: Widget schemas + shared UI layout resolution

**Files:**
- Modify: `packages/core/src/schema/components.ts` (three new schemas + `focusable` on `UIElementSchema` + `ComponentMap` + `COMPONENT_DOCS` entries; count 14 → 17)
- Modify: `packages/runtime/src/ui.ts` (layout resolution + widget rects)
- Test: `packages/runtime/test/uiLayout.test.ts`

**Interfaces:**
- Produces (verbatim schemas):
  ```ts
  export const UILayoutSchema = z.object({
    direction: z.enum(['vertical', 'horizontal']).default('vertical'),
    gap: z.number().default(8),
    padding: z.number().default(0),
    align: z.enum(['start', 'center', 'end']).default('start'),
  });
  export const UISliderSchema = z.object({
    min: z.number().default(0), max: z.number().default(1),
    value: z.number().default(0.5), step: z.number().min(0).default(0),
    width: z.number().default(160),
    trackColor: z.string().default('#3a3a3a'),
    fillColor: z.string().default('#f76b15'),
    handleColor: z.string().default('#ececec'),
  });
  export const UIToggleSchema = z.object({
    value: z.boolean().default(false), size: z.number().default(20),
    color: z.string().default('#3a3a3a'),
    checkColor: z.string().default('#f76b15'),
  });
  // UIElementSchema gains: focusable: z.boolean().default(false)
  ```
  - `ui.ts`: `resolveUiPositions(entities: Entity[], screenW: number, screenH: number): Map<string, { x: number; y: number }>` — screen position for every `UIElement` entity. Non-layout entities: `uiScreenPosition` as today. Entities whose PARENT has `UILayout` + `UIElement`: stacked in child order along `direction`, spaced by measured rect extents + `gap`, inset by `padding`, cross-axis per `align`; the child's own `UIElement.offset` is a relative nudge; the child's `anchor` is ignored (layout owns position). Nested layouts resolve parent-first (topological by parent chain). Container's own rect for hit/measure = union of laid-out children + padding.
  - `uiElementRect` gains: `UISlider` → rect `width × 24` centered on the resolved position; `UIToggle` → `size × size`. Both count as visuals even with no Sprite/Text.
  - COMPONENT_DOCS one-liners: UILayout ("Stacks child entities' UI elements vertically or horizontally; children's offsets become relative nudges"), UISlider ("Draggable value widget rendered by the runtime; fires onUiEvent {type:'change', value}"), UIToggle ("Boolean checkbox widget; click flips value and fires onUiEvent {type:'change', value}").

**Steps:**

- [ ] **Step 1:** Failing `ui.ts` tests: vertical stack of three text children positions them at cumulative heights + gap; horizontal with `align:'center'`; padding offsets first child; child offset nudges; nested layout (layout inside layout) resolves; slider/toggle rects.
- [ ] **Step 2:** Run → fail. Implement schemas + resolution. Existing UI tests (anchor math, hit rects) must stay green.
- [ ] **Step 3:** Core + runtime tests + typecheck green.
- [ ] **Step 4:** Commit: `feat: UILayout, UISlider, UIToggle components with shared layout resolution`

---

### Task 10: Widget rendering + pointer drag interaction

**Files:**
- Modify: `packages/runtime/src/pixi/index.ts` (`buildNode` `:749-787`, `updateNode` `:898-959`, zIndex calc `:917`)
- Modify: `packages/runtime/src/runtime.ts` (`sendPointer` `:640-664`: drag dispatch + slider/toggle behavior; use `resolveUiPositions` for hit testing so layout children hit correctly)
- Test: `packages/runtime/test/uiWidgets.test.ts` (headless: drive `sendPointer`, assert component state + hook payloads)

**Interfaces:**
- Consumes: Task 9 schemas/rects/resolution.
- Produces:
  - Pixi: Graphics children labeled `'slider'` (track rect height 6, fill portion, circular handle r 8 at value position) and `'toggle'` (rounded box `size×size`, inner check fill when `value`), rebuilt on snapshot change like line/sprite children.
  - Runtime interaction (headless-true, lives in `sendPointer`/helpers, NOT pixi):
    - While `uiPressedId` is set and kind === `'move'`: dispatch `onUiEvent { type: 'drag', x, y }` to the pressed entity.
    - Pressed entity with `UISlider`: press AND drag both map pointer x → `value = clamp(min + (x - rectLeft)/width * (max-min))`, snapped to `step` when step > 0; when the value actually changes, write it and dispatch `onUiEvent { type: 'change', value, x, y }`.
    - Entity with `UIToggle`: on `click`, flip `value`, dispatch `{ type: 'change', value: <new>, x, y }` (in addition to the normal click event).
  - `UiEvent.type` union in `scripts.ts:26-31` gains `'drag' | 'change' | 'focus' | 'blur'` and an optional `value?: number | boolean` field (focus/blur used in Task 11; add to the type now so it changes once).
- Note: hit testing must use resolved layout positions — refactor `hitTestUi`/`uiElementRect` call sites to take positions from `resolveUiPositions` (compute once per `sendPointer`).

**Steps:**

- [ ] **Step 1:** Failing headless tests: slider drag from left edge to middle sets value ≈ mid and fires change with the new value; step=0.1 snaps; toggle click flips and fires change; drag events reach a plain interactive element's script; slider inside a UILayout hits at its laid-out position.
- [ ] **Step 2:** Run → fail. Implement runtime interaction, then pixi rendering branches.
- [ ] **Step 3:** Runtime tests + typecheck green.
- [ ] **Step 4:** Commit: `feat: slider and toggle widgets with pointer drag`

---

### Task 11: Focus system + ctx.ui + playtest drag/assertFocus

**Files:**
- Modify: `packages/runtime/src/runtime.ts` (`uiFocusId` alongside `uiHoverId`; focus API; spatial nav)
- Modify: `packages/runtime/src/scripts.ts` (`ctx.ui` namespace on `ScriptContext`)
- Modify: `packages/core/src/ctxApi.ts` (ctx.ui docs + camera-effect docs check)
- Modify: `packages/core/src/schema/project.ts` (`drag` + `assertFocus` steps)
- Modify: `packages/playtest/src/index.ts` (evaluator cases; results gain `focusedEntity: string | null`)
- Test: `packages/runtime/test/uiFocus.test.ts`, playtest test

**Interfaces:**
- Consumes: Tasks 9–10 (focusable flag, resolved positions, drag dispatch, UiEvent focus/blur types).
- Produces:
  ```ts
  ctx.ui = {
    focus(idOrName: string | null): void;      // null blurs; warn log if not found/not focusable
    getFocused(): string | null;               // entity id
    moveFocus(direction: 'up' | 'down' | 'left' | 'right'): void;
    activate(): void;                          // synthesizes press+release ('click') at the focused element's center
    adjust(delta: number): void;               // focused UISlider: value += delta * (step || (max-min)/10), clamped, fires change
  };
  ```
  - Focus set/cleared fires `onUiEvent {type:'focus'}` / `{type:'blur'}` on the affected entities. Destroying the focused entity blurs.
  - `moveFocus`: candidates = focusable UIElement entities with resolved positions; from the current position (or top-left-most candidate when nothing focused), pick the nearest candidate strictly in the direction half-plane (dot product with direction > 0), distance = euclidean; tie-break by scene entity order. No wrap.
  - Playtest steps: `{ type: 'drag', from: Vec2Schema, to: Vec2Schema, frames: z.number().int().min(1).optional() }` → pointer down at `from`, `frames ?? 5` interpolated moves, up at `to`, one frame each; `{ type: 'assertFocus', entity: z.string().nullable() }` → passes when focused entity's name (or id) matches, or nothing focused for null.
  - Results: `focusedEntity` (entity name if resolvable, else id, else null).

**Steps:**

- [ ] **Step 1:** Failing runtime tests: focus/blur events fire; moveFocus picks the geometrically nearest in-direction candidate in a 2×2 menu grid (all four directions); activate clicks a toggle (value flips); adjust moves a slider by step; destroyed focused entity → getFocused null.
- [ ] **Step 2:** Run → fail. Implement runtime + ctx (+ mirror docs).
- [ ] **Step 3:** Failing playtest test: drag a slider via the `drag` step and assert its `UISlider.value` via `assertProperty`; `assertFocus` after a script calls `ctx.ui.focus('Resume')`. Implement steps.
- [ ] **Step 4:** `npm run build:packages`; all package tests + typecheck green.
- [ ] **Step 5:** Commit: `feat: UI focus, spatial navigation, and ctx.ui`

---

### Task 12: Inspector enum dropdowns (generic, metadata-driven)

**Files:**
- Modify: `packages/core/src/schema/components.ts` (or a sibling `componentMeta.ts`): export `COMPONENT_ENUMS: Record<string, Record<string, string[]>>` built at module load by walking each component schema's shape (unwrap `ZodDefault`/`ZodOptional`, collect `ZodEnum` options)
- Modify: wherever the editor receives `componentDocs` (find the server payload — `apps/editor/server/projectServer.ts` and `store.ts`): include enums
- Modify: `apps/editor/src/components/Inspector.tsx` (~497–670 field loop): render a `<select>` (styled like existing controls) for any string field with enum options; keep the `UIElement.anchor` AnchorGrid special case
- Test: `packages/core/test/componentMeta.test.ts`

**Interfaces:**
- Consumes: existing zod component schemas (including Task 9's).
- Produces: `COMPONENT_ENUMS` with (at least) `SpriteRenderer.shape`, `Text.align`, `UIElement.anchor`, `UILayout.direction`, `UILayout.align`; Inspector enum fields become dropdowns everywhere (raw-text fallback gone for enums).

**Steps:**

- [ ] **Step 1:** Failing core test: `COMPONENT_ENUMS.SpriteRenderer.shape` deep-equals `['rectangle','circle','triangle','none']`; `COMPONENT_ENUMS.UILayout.direction` = `['vertical','horizontal']`.
- [ ] **Step 2:** Run → fail. Implement metadata + plumb to editor + Inspector select rendering.
- [ ] **Step 3:** Core tests + typecheck green.
- [ ] **Step 4:** Commit: `feat: enum dropdowns in the inspector from schema metadata`

---

### Task 13: Drift Cellar example (generated) + wave playtests + AGENTS regen

**Files:**
- Modify: `packages/examples/generate.mjs` (new example: `drift-cellar`)
- Create (generated): `packages/examples/drift-cellar/**` (never hand-edit)
- Modify: CI example-playtest coverage follows the existing pattern automatically if it globs examples — verify; else add drift-cellar where the other seven are listed
- Test: the example's own playtests via `hearth test`

**Interfaces:**
- Consumes: everything from Tasks 1–11 (not undo).
- Produces: an eighth example demonstrating the full wave:
  - Two scenes ("Cellar", "Vault") with `fade`-out → `switchScene` → `fade`-in transitions.
  - Player moves with virtual axes `moveX`/`moveY` (gamepad stick + WASD/arrow fallback codes in `inputMappings.axes`); gamepad `a` bound alongside Space for a "dash" action via `gamepadButtons`.
  - Wall collisions trigger `ctx.camera.shake` (gated by a settings flag) + `flash`.
  - Pause menu (Esc key action + `start` button): a `UILayout` vertical stack containing a Resume "button" (interactive UIElement + Text, the ember-trail pattern), a music-volume `UISlider` wired to `ctx.audio.setMusicVolume`, and a screen-shake `UIToggle`; all `focusable`, focus visuals via focus/blur hooks (color swap), `ui-up`/`ui-down`/`ui-confirm` actions driving `ctx.ui.moveFocus`/`activate`, slider adjusted with `ui-left`/`ui-right` via `ctx.ui.adjust`.
  - Playtests: `setAxis` movement assert; open menu → `drag` the slider → `assertProperty` UISlider.value; toggle via `ctx.ui`-driven keys → assert; `assertFocus`; force a wall hit → `assertCameraEffect {effect:'shake', min:1}`; scene switch → `assertScene` + fade → results-level overlay (via `assertCameraEffect {effect:'fade', min:1}`).
  - All-Lua scripts, seed-deterministic. Regenerate ALL examples so every `AGENTS.md` picks up `ctx.input.axis`, `ctx.camera` effects, and `ctx.ui` docs.

**Steps:**

- [ ] **Step 1:** Read `generate.mjs` end-to-end (how sky-courier composes commands) before writing anything.
- [ ] **Step 2:** Add the drift-cellar generator + scripts + playtests; regenerate all examples.
- [ ] **Step 3:** Run drift-cellar playtests headlessly (`hearth test` in the example dir) → green; run the full example test suite that CI uses.
- [ ] **Step 4:** `git status` — confirm only generated output + generate.mjs changed; commit: `feat: Drift Cellar example exercising gamepad, widgets, and camera effects`

---

### Task 14: Docs, counts, version bump, release gate

**Files:**
- Create: `docs/input.md`, `docs/ui.md`
- Modify: `docs/scripting.md` (ctx.camera effects, ctx.ui, ctx.input.axis), `docs/cli.md` (undo/redo/history), `docs/mcp.md` (3 tools + new count), `docs/components.md` (3 widgets + focusable; count 17), `docs/playtests.md`-equivalent (wherever steps are documented — find it; likely inside cli.md or a playtest doc) for setAxis/drag/assertFocus/assertCameraEffect, `docs/roadmap.md` (mark §7/§11/§12-tier1/§13 done), `README.md` (command/tool/component counts, Status paragraph mentions 0.7.0, keep voice — no em-dashes), `CHANGELOG.md` if present (check root)
- Modify: version fields to `0.7.0`: root `package.json` + every `packages/*/package.json` + `apps/editor/package.json` (match how 0.6.0 was bumped — `git show 0bc5d2d --stat` for the file list)
- Test: `npm run typecheck && npm test` (FULL suite) as the gate

**Steps:**

- [ ] **Step 1:** Get real counts: `node packages/cli/dist/main.js commands | wc -l`-style verification for command count (expect 51), `TOOL_SPECS` length for MCP, component count 17. Never write a count you didn't verify.
- [ ] **Step 2:** Write/update all docs. Voice: plain, human, no em-dashes in README.
- [ ] **Step 3:** Bump versions; `npm run build:packages && npm run typecheck && npm test` → all green.
- [ ] **Step 4:** Commit: `docs: input, UI, effects, undo guides; bump to 0.7.0`

---

## Final integration (controller, after all tasks)

- Whole-branch review (superpowers:requesting-code-review) on the most capable model.
- Push via `direnv exec . git push` (echoo19 GH_TOKEN lives in gitignored `.envrc`).
- Tag `v0.7.0` and cut the release the same way v0.6.0 was cut (check `git tag -l` + `.github/workflows/` for the release pipeline; follow it, don't invent a new one).
