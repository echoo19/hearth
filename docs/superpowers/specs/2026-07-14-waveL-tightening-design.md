# Wave L — Tightening (v0.14.0)

Date: 2026-07-14
Status: Approved (Jake, 2026-07-14)
Predecessors: Wave J v0.13.0 (ship-your-game), Wave K (website overhaul, hearth-website repo)
Successor: Wave M — final hardening/verification (format stability + migrations, docs completeness, perf fences, release-readiness). The roadmap's former "Wave L hardening" is renumbered to Wave M; this wave absorbs the editor-facing bug tail.

## Goal

Every interactive element in the editor works and works properly; common
workflows are front-and-center instead of buried; the UI reads as one
deliberately designed product. **No new engine features** — anti-bloat stays
binding.

Priority order: (1) full functionality, (2) UX, (3) design language.

## Scope

In: `apps/editor` end to end — Launcher + template picker, Toolbar + scene/view
menus + shortcut sheet, all 13 dockview panels (Hierarchy, Scene, Game, Code,
Inspector, Assets, Console, Changes, Agent, Input, Game Settings, Live,
Animator), dialogs (Export web+desktop, Slice, confirms), and the packaged
Electron app. Core/CLI bugs surfaced by the audit get fixed too.

Out: website (Wave K just shipped), new engine systems/commands, format
migrations, perf work, docs-completeness (all Wave M).

## Phase 0 — Full-surface audit (evidence before opinions)

- One auditor subagent per surface (~16 surfaces, enumerated above; SceneView
  includes gizmos/tilemap paint/polygon editing; Inspector includes all 18
  component editors + prefab override/revert UI + PostEffects; Assets includes
  SliceDialog + bulk import; Code includes tabs/search/lint/hover docs; Game
  preview includes play-mode debug, pause/step, hot-reload, live patching).
- Each auditor drives the REAL editor in a browser (vite dev + playwright,
  established technique), enumerates every button/menu item/field/drag
  surface/keybind, exercises it, and files each finding as:
  - **defect** — broken or behaves incorrectly (must fix)
  - **friction** — works but fights the user (UX)
  - **polish** — visual/design-language inconsistency
- Output: one severity-ranked `LEDGER.md`, merged with the existing
  Wave-K editor-facing tail from `.superpowers/sdd/progress.md`
  (Script.params raw-JSON fallback, Code panel carries prior project file
  across project switch, toolbar no collapse <1323px, same-value instance
  edits record overrides, no-op reparent detaches, setParamType stale-op
  gate, sprite-mode forgets prior asset, aria-labels, GAME header, tile-in-
  pickers, SVG icon fallback, …).
- A separate probe checks the packaged Electron app for divergences from the
  dev editor.

## Phase 1 — Functionality burn-down

Fix every **defect**. TDD where testable; browser re-verification for each;
per-fix review per house convention. Every ledger item gets an explicit
disposition: **fixed / by-design (documented) / deferred-to-M (justified)** —
nothing silently dropped.

## Phase 2 — UX tightening

- **Toolbar**: logical grouping (not just hairline dividers), responsive
  collapse below ~1323px, restart badge redesigned (icon + short label, not a
  sentence).
- **Discoverability**: hover-only-visible actions (tree-row actions, field
  revert buttons, tab closes) get keyboard/focus parity and persistent
  affordances where they're primary; nothing important is invisible until
  hover.
- **Front-loading**: audit-informed — the most-used actions in each workflow
  become one click/keystroke away; consistent context menus; every panel gets
  a real empty state that says what to do next.
- **Menus**: SceneMenu/ViewMenu duplicated popover logic replaced by one
  shared `Menu` primitive (uniform open/close/click-outside/Escape/focus-
  return behavior).
- **Scene chrome minimalism (Jake steer, 2026-07-14)**: interactions must be
  intuitive — no instructional prose overlays. The SceneView persistent hint
  bar ("scroll to zoom · space+drag…") is REMOVED (the `?` sheet keeps the
  reference; deeper how-to content goes to the Wave M docs pass). The
  floating "Particles" scene toggle is REMOVED: particle preview is
  object-owned — selecting an emitter previews it (Unity/Godot mental
  model); any necessary control lives on the Inspector's ParticleEmitter
  card. Standing principle: behaviors belong to objects, never to floating
  scene-level chrome; tooltips are one line (label + shortcut), never
  instructional prose.

## Phase 3 — Design language

- **Type**: tokenized scale (`--text-*`) replacing all ad-hoc font-size
  literals; **Bricolage Grotesque for brand moments only** (wordmark,
  launcher headings, dialog titles, empty-state headings); Archivo Variable +
  IBM Plex Mono stay as the workhorse chrome fonts.
- **Tooltip primitive**: styled, fast, keyboard-accessible (shows on
  focus-visible), replaces native `title` on all interactive chrome; every
  icon-only control gets one, with shortcut hints where bound.
- **Icons**: keep and extend the hand-authored 12×12 stroke set (unique,
  on-brand — no external icon library) to cover primary actions (Undo/Redo,
  Export, Checkpoint, Review, Debug, Close…). Toolbar becomes icon+tooltip,
  label retained where clarity demands.
- **Primitives**: real `Button`/`IconButton`/`Menu` components replacing
  bare class-name conventions; one shared row-grid system so
  Animator/Input/PostEffects/autotile editors align column-for-column.
- **Structural**: split the ~3,900-line `styles.css` into layered files
  (tokens / primitives / per-panel) to reduce cross-task contention and make
  the token system enforceable.
- Executed under the `impeccable` + `design-motion-principles` skills; motion
  purposeful and minimal. Editor remains single-theme dark.

## Phase 4 — Gate + release

Full suite + typecheck; closing **re-audit pass** confirming every ledger
disposition; fable whole-branch review with live visual probes (including the
carried Wave I/J visual checklists); release **v0.14.0** (3 version constants,
same-commit examples+templates regen, verified release build order); website
sync (version bump only — no new commands expected).

## Success criteria

- Zero known broken controls; 100% of ledger items dispositioned.
- No raw-JSON Inspector fields remain (Script.params was the last).
- No native `title` tooltips on interactive chrome.
- No raw font-size literals outside the token layer.
- Fable gate verdict: READY.

## Risks

- Staging races in the shared tree (history: 3 incidents) — mitigated by the
  CSS split, disjoint task file-sets, and the standing "stage only hunks you
  authored" dispatch rule.
- Hidden-tab browser verification false negatives (rAF freezes) — auditors
  must keep the driven tab visible/active for reveal- and motion-dependent
  checks.
- Global CSS/token changes conflict with panel work — token/primitives tasks
  land serialized BEFORE panel migrations fan out.
