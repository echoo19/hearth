# Hearth Editor — DESIGN.md

Source of truth for tokens: `apps/editor/src/styles.css` (this file
describes it; the CSS defines it).

## Theme

Dark by intent. Game editors are lived-in tools; the scene canvas is the
brightest thing on screen, and colored game content must pop against calm,
**neutral charcoal** surfaces. Ember is reserved for the accent — it carries
commands and selection, not the panels themselves. (Earlier drafts of this
doc described the surfaces as "ember-tinted"; the tokens below are what
`styles.css` actually ships, current as of the 2026-07-10 palette pass.)

## Color (OKLCH throughout)

- Surfaces: `--bg-0` L0.115 (window chrome, deepest) → `--bg-1` L0.15
  (panels) → `--bg-2` L0.19 (inputs/cards/tabs) → `--bg-3` L0.245 (hover);
  all **neutral hue 285, chroma 0.006–0.012** — not fire-tinted.
- Borders: `--border` L0.32, `--border-strong` L0.42, `--guide` L0.27 (same
  neutral hue 285 family).
- Ink: `--ink` L0.95, `--ink-mute` L0.74, `--ink-faint` L0.58 (warm, hue 85).
- Accent (ember, actions + selection ONLY — the one place ember hue
  appears): `--accent` `oklch(0.684 0.192 42)`, with `--accent-hover`
  (warms toward hue 55 on hover — deliberate), `--accent-down`, `--accent-ink`,
  `--accent-soft` (0.14 alpha), `--accent-faint` (0.055 alpha).
- Status: `--ok` (green 150), `--warn` (yellow 85), `--err` (red 25),
  `--info` (blue 230), each with -soft/-faint alphas where defined.
- Canvas: `--canvas-bg` L0.095, grid lines L0.22/L0.34 (neutral hue 285).
- Overlays: `--overlay-bg` (translucent neutral scrim over the canvas — scene
  HUD, tilemap palette, game-preview badges) and `--scrim` (heavier, for
  modal backdrops) — both hue 285, never ember. `--flame-brand` (`#f76b15`)
  is the one deliberate exception: the wordmark flame is a brand mark, not a
  UI action color, and is allowed to run hotter than `--accent`.

## Typography

- UI chrome: Archivo Variable (`--font-ui`), body 13px / 1.45.
- Values, scripts, console, ids: IBM Plex Mono (`--font-mono`), 12px.
- Headings 600 weight, `text-wrap: balance`. No additional families.

## Metrics & Motion

- Control heights: `--ctl-h` 26px, `--ctl-h-sm` 22px — one height per
  control size, everywhere. `.btn`/`.select`/`.input`/`.textarea` sit at
  `--ctl-h`; `.btn-sm` at `--ctl-h-sm`. `.select-sm` (compact `<select>`
  variant, `--ctl-h-sm`/`--radius-sm`/12px font) exists for selects that sit
  next to `btn-sm` controls (e.g. the toolbar) — apply `className="select
  select-sm"` the same way `.btn-sm` layers onto `.btn`.
- Radii: `--radius` 6px (controls), `--radius-sm` 4px (compact
  controls/icon buttons), `--radius-lg` 10px (larger surfaces: modals, the
  shortcut cheat sheet, launcher cards). Round icon buttons (e.g.
  `.audio-preview-btn`) are `50%` by design and exempt from the scale.
- Motion: `--t-fast` 100ms, `--t` 150ms, `--ease-out`
  cubic-bezier(0.25, 1, 0.4, 1); state-conveying only, no decorative
  animation; respect prefers-reduced-motion.
- z-scale (semantic only): dropdown 100 → sticky 200 → modal-backdrop 300 →
  modal 400 → toast 500 → tooltip 600.

## Components (established patterns)

- **Panels**: dockview workspace; panel headers small caps-free labels in
  `--ink-mute`.
- **Inspector fields**: label left, control right; typed controls
  (NumberField, TextField, Vec2Field, Vec2ListField, StringListField,
  color swatch, checkbox toggle, select). Never a raw JSON textarea.
- **Modals**: `--z-modal` over `--z-modal-backdrop` scrim (`--scrim`);
  `--bg-1` body, `--border-strong` outline, `--radius-lg`; confirm button
  uses accent, cancel is quiet.
- **Asset cards**: `--bg-2` tiles in a responsive grid
  (`repeat(auto-fit, minmax(...))`), thumbnail over name+type; selection
  ring in accent.
- **Buttons**: primary = accent fill with `--accent-ink` text; secondary =
  `--bg-2` with border; destructive = `--err` styling; all at `--ctl-h`.
- **Console/log rows**: mono font, status color per level.
