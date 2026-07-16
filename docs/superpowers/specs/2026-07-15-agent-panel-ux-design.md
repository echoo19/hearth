# Agent panel UX — right dock + zero-friction launch (design)

Status: **APPROVED DESIGN** (Jake, 2026-07-15). Supersedes the open questions in
`2026-07-16-agent-panel-ux-notes.md`; the binding constraints in that file's
"Binding constraints" section still apply verbatim (subscription safety, house
UI rules, launcher-plumbing reuse, anti-bloat).

Decisions were made interactively with Jake, informed by a walkthrough of the
jakeos deploy flow (single "Deploy agent" entry point, segmented agent picker,
sane defaults, wrapper does all prep invisibly). One deliberate departure:
jakeos hard-codes full-autonomy flags; Hearth keeps its permission-mode ladder
with `safe-edit` as the default, moved behind progressive disclosure.

Baseline: branch `v1.1.1-editor-fixes`, which already contains the contained
bug fixes the notes file split out (login-shell PATH detection `070b9a1`,
copy/centering `9f12007`). This design assumes honest agent detection.

## Decisions (locked)

1. **Own full-height right dock** beside the Inspector — not a tab in the
   Inspector group, not the bottom dock. Both Inspector and Agent visible at
   once.
2. **Timeline stacks below the terminal** inside the panel as a collapsible
   Activity section; Checkpoint / Review changes / Restore stay with it.
3. **First run is an in-panel launcher hero** ("Launch your agent" + one tile
   per agent), not a modal. Permission mode and manual setup move behind a
   gear.
4. **Clean move**: nothing agent/terminal-related remains in the bottom dock.
   The plain-shell "Terminal" option survives as a low-key launcher row inside
   the Agent panel.

## 1. Layout

- `buildDefaultLayout()` (`apps/editor/src/workspace/Workspace.tsx`) places
  `agent` in its own group `direction: 'right'` of the inspector group,
  `initialWidth` ~380px (new `AGENT_WIDTH` constant). It is removed from the
  bottom-group loop.
- `BOTTOM_HEIGHT` reverts 340 → 260; the bump existed only to give the
  terminal height (AGENT-9) and the terminal no longer lives there.
- `showPanel('agent')` re-opens the panel at the right edge: right of the
  inspector group when present, else far right of the grid. Remove `agent`
  from `BOTTOM_PANELS`.
- **Saved-layout migration** (`apps/editor/src/workspace/layout.ts`): bump
  `LAYOUT_VERSION` 1 → 2. Restoring a version-1 envelope keeps the user's
  layout but relocates the agent panel: after `fromJSON`, remove the `agent`
  panel and re-add it right of the inspector (fallback: far right), then run
  the existing `ensureGroupsActive` self-healing, and persist as v2. No
  layout reset; no other panel moves. A v2 envelope restores as-is.

## 2. Panel states

The panel is a three-state machine replacing today's
everything-at-once toolbar + blurb + empty terminal + empty timeline.

### Launcher (no session)

- Heading: **"Launch your agent"**.
- One **tile per agent** — Claude Code, Codex, OpenCode, Hermes — from the
  existing detect result. Installed tiles lead and are enabled; uninstalled
  tiles are dimmed with a quiet inline **Install** action. Install reuses the
  existing in-panel mechanics (shell PTY runs the install command, panel
  auto-re-detects on exit) generalized beyond Claude to any launcher with a
  known install command; launchers without one get a docs link instead.
- Clicking an installed tile: `apiPrepareAgent` runs invisibly (tile shows a
  brief "Preparing…" state), then the PTY starts and the terminal takes over
  the panel. No project-prepare step is surfaced.
- A low-key **Terminal** row (plain shell) sits under the agent tiles.
- Footer: a `Safe edit · ⚙` chip. The gear is a shared Menu primitive
  holding: permission-mode picker (ladder unchanged, default `safe-edit`),
  Re-detect, and a **Manual setup** disclosure containing the current
  CLI/MCP blocks and mode table. Nothing else is upfront — the permission
  blurb paragraph is deleted in favor of the chip + gear.
- Detection runs once on mount, as today. Detection failure renders a single
  retry row ("Couldn't check installed agents — Retry") instead of tiles.

### Session running

- Slim header: agent name, status dot, Stop, gear (mode locked while
  running — `modePickerDisabledReason` behavior unchanged).
- Terminal fills the majority of the height (~65%).
- **Activity** section below: collapsible; timeline list plus Checkpoint /
  Review changes / Restore. Behavior unchanged from today's Timeline;
  restyled for a ~380px column. Collapsing Activity gives the terminal the
  full height.

### Session exited

- Scrollback stays visible (existing xterm lifetime semantics) with a
  "Launch again" affordance and a way back to the launcher to pick a
  different agent.

## 3. Code shape

- `AgentPanel.tsx` (~525 lines) splits:
  - slim `AgentPanel.tsx` — the state machine (launcher | running | exited)
    and session wiring;
  - new `agent/Launcher.tsx` — hero, tiles, install flow, gear menu,
    manual-setup disclosure;
  - `agent/Terminal.tsx` unchanged; `agent/Timeline.tsx` kept, restyled.
- `styles/panels/agent.css` reworked for the vertical stack.
- Shared Button/Tooltip/Menu primitives, `--text-*` tokens, Reveal idiom;
  tiles are real `<button>`s (keyboard reachable, visible focus).
- **No server, command, CLI, or MCP surface changes.** `detectAgents`,
  `prepareAgent`, the PTY route, and `useAgentSocket` are reused untouched.
  Anti-bloat: identical capability set, fewer upfront controls.

## 4. Error handling

- Prepare/launch failure: inline on the clicked tile (message + retry), not a
  global strip.
- Detection failure: single retry row (see above), distinct from
  "detected, nothing installed" (`detectionFailed` helper stays).
- Install failure: the shell terminal output remains visible so the cause is
  readable; tile returns to its Install state after exit + re-detect.
- The pure-helper pattern (`startDisabledReason`,
  `shouldRedetectAfterInstall`, …) is kept/adapted so all of these states
  stay unit-testable without a DOM.

## 5. Testing & verification

- Unit: layout migration (v1 envelope with agent docked in the bottom group →
  restored with agent in its own right group, all other panels preserved,
  persisted as v2; v2 envelope untouched); launcher state helpers (tile
  enablement, install visibility, prepare-error mapping); existing
  AgentPanel/Timeline tests updated for the new structure.
- Gate: `npx vitest run` + `npm run typecheck` + examples regen-clean +
  `HEARTH_SMOKE=1`, plus the Wave-N binary-diff/NUL scan
  (`git diff --numstat | awk '$1=="-"&&$2=="-"'` + NUL/ZWSP/BOM check).
- **Manual drive from a packaged app** (not `npm run dev`): first-run
  launcher, one-click Claude Code launch, install flow for a missing agent,
  layout migration from a real pre-v2 saved layout, Activity
  collapse/expand, Stop/relaunch. This is the lesson from the notes file's
  "why this was missed" section — automated checks confirm rendering, not
  usability.
- Docs: update `docs/agent-panel.md` (layout location, first-run flow,
  screenshots if any are embedded).

## Version

Branch `v1.1.1-editor-fixes` already carries the v1.1.1 bug fixes; this work
is feature-shaped. Recommendation: release the combined branch as **v1.2.0**
(v1.1.0 is already tagged). Jake decides at release time.
